// Runs only in a private, network-disabled managed process. Input/output paths are fixed by the host.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";
import { imageSize } from "image-size";
async function graphics() {
  const canvas = await import("@napi-rs/canvas");
  Object.assign(globalThis, {
    DOMMatrix: canvas.DOMMatrix,
    ImageData: canvas.ImageData,
    Path2D: canvas.Path2D,
  });
  return canvas;
}
const MAX = 32 * 1024 * 1024;
const directory = path.dirname(fileURLToPath(import.meta.url));
const mime = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  csv: "text/csv",
  md: "text/markdown",
};
export function formatOf(name) {
  return path.extname(name).slice(1).toLowerCase();
}
function fail(message) {
  throw new Error(message);
}
function xml(data) {
  if (!data) fail("文件缺少必要内容 / Missing document part");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  if (/<!DOCTYPE|<!ENTITY/i.test(text))
    fail("不支持自定义 XML 实体 / Custom XML entities are unsupported");
  return new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: false,
  }).parse(text);
}
function named(tree, name, out = []) {
  if (Array.isArray(tree))
    for (const node of tree) {
      if (node[name]) out.push(node[name]);
      for (const [key, value] of Object.entries(node)) if (key !== ":@") named(value, name, out);
    }
  return out;
}
function texts(tree, name) {
  return named(tree, name)
    .map((n) => n.map((v) => v["#text"] || "").join(""))
    .join("");
}
function archive(bytes) {
  let total = 0,
    count = 0;
  const seen = new Set();
  return unzipSync(bytes, {
    filter(file) {
      total += file.originalSize;
      count++;
      if (
        count > 4096 ||
        total > 64 * 1024 * 1024 ||
        file.originalSize > 16 * 1024 * 1024 ||
        seen.has(file.name) ||
        file.name.includes("\\") ||
        file.name.split("/").includes("..")
      )
        fail("压缩文件内容超限或结构不安全 / Invalid or oversized document archive");
      seen.add(file.name);
      return true;
    },
  });
}
function cellText(cell) {
  if (cell.formula) return `=${cell.formula} [缓存值 / cached: ${cell.result ?? "未知 / unknown"}]`;
  if (cell.value?.richText) return cell.value.richText.map((r) => r.text).join("");
  if (cell.value?.hyperlink) return `${cell.value.text || ""} [链接未打开 / link not opened]`;
  return cell.text || "";
}
async function pdfDocument(bytes) {
  await graphics();
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    stopAtErrors: true,
    standardFontDataUrl:
      path.join(directory, "node_modules/pdfjs-dist/standard_fonts").replaceAll("\\", "/") + "/",
  }).promise;
}
export async function parse(bytes, name) {
  if (!bytes.length || bytes.length > MAX)
    fail("文件为空或超过 32 MiB / Empty file or file exceeds 32 MiB");
  const format = formatOf(name),
    units = [],
    warnings = [];
  let chars = 0,
    image = null,
    model_image = null;
  const add = (locator, text) => {
    text = String(text);
    if (text.includes("\0")) fail("文件包含无效文本 / Invalid text in file");
    if (text.length > 4000) {
      for (let n = 0; n < text.length; n += 4000)
        add(
          `${locator} · 字符 / chars ${n + 1}–${Math.min(n + 4000, text.length)}`,
          text.slice(n, n + 4000),
        );
      return;
    }
    chars += text.length;
    if (chars > 4 * 1024 * 1024 || units.length >= 20000)
      fail(
        "可解析内容超过上限（4 MiB / 20000 段）；请拆分文件 / Extracted content exceeds limits; split the file",
      );
    units.push({ locator, text });
  };
  if (["docx", "xlsx", "pptx"].includes(format)) {
    if (bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])))
      fail(
        "文件可能已加密，或属于旧 Office 格式。请另存为未加密的新格式 / Encrypted or legacy Office file",
      );
    const zip = archive(bytes);
    if (!zip["[Content_Types].xml"]) fail("不是有效的 Office 文件 / Invalid Office file");
    const names = Object.keys(zip);
    if (names.some((n) => /vbaProject|embeddings\//i.test(n)))
      warnings.push(
        "宏和嵌入对象不会执行或解析 / Macros and embedded objects are not executed or extracted",
      );
    if (names.some((n) => /externalLinks|comments|notesSlides/.test(n)))
      warnings.push(
        "外部链接、批注、演讲备注不包含在正文提取中 / External links, comments and speaker notes are not included",
      );
    if (format === "docx") {
      const tree = xml(zip["word/document.xml"]);
      let n = 0;
      for (const paragraph of named(tree, "w:p"))
        add(`段落 / Paragraph ${++n}`, texts(paragraph, "w:t"));
      warnings.push(
        "内容预览保留正文和表格段落顺序；页眉、图片、修订和原始分页需用办公软件核对 / Content preview; check original layout, headers, images and revisions in an office app",
      );
    } else if (format === "xlsx") {
      const { default: ExcelJS } = await import("exceljs");
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(bytes);
      if (workbook.worksheets.length > 100) fail("工作表超过 100 张 / Too many worksheets");
      for (const sheet of workbook.worksheets) {
        if (sheet.rowCount > 20000 || sheet.columnCount > 256)
          fail("工作表范围超过 20000 行 / 256 列 / Worksheet range exceeds limits");
        sheet.eachRow({ includeEmpty: false }, (row) => {
          const cells = [];
          row.eachCell({ includeEmpty: false }, (cell) =>
            cells.push(`${cell.address}: ${cellText(cell)}`),
          );
          add(
            `${sheet.name}!A${row.number}:${sheet.getColumn(Math.max(1, sheet.columnCount)).letter}${row.number}`,
            cells.join("\t"),
          );
        });
      }
      warnings.push(
        "公式显示文件中保存的缓存值，不自动执行外部链接或重算；图表请用办公软件核对 / Formulas show saved cached values; no external links or recalculation",
      );
    } else {
      const presentation = xml(zip["ppt/presentation.xml"]),
        rels = xml(zip["ppt/_rels/presentation.xml.rels"]);
      const relationships = new Map();
      function walk(tree) {
        if (Array.isArray(tree))
          for (const node of tree) {
            if (node.Relationship) {
              const a = node[":@"];
              if (a?.["@_TargetMode"] !== "External")
                relationships.set(a?.["@_Id"], a?.["@_Target"]);
            }
            for (const value of Object.values(node)) walk(value);
          }
      }
      walk(rels);
      const slideIds = [];
      function slides(tree) {
        if (Array.isArray(tree))
          for (const node of tree) {
            if (node["p:sldId"]) slideIds.push(node[":@"]?.["@_r:id"]);
            for (const value of Object.values(node)) slides(value);
          }
      }
      slides(presentation);
      if (slideIds.length > 500) fail("演示超过 500 页 / Too many slides");
      for (const [i, id] of slideIds.entries()) {
        const target = relationships.get(id);
        if (!target || target.includes("..") || target.startsWith("/"))
          fail("幻灯片引用无效 / Invalid slide reference");
        const tree = xml(zip[`ppt/${target}`]);
        add(
          `幻灯片 / Slide ${i + 1}`,
          named(tree, "a:p")
            .map((p) => texts(p, "a:t"))
            .join("\n"),
        );
      }
      warnings.push(
        "内容预览不重现动画、图表和原始布局 / Content preview does not reproduce animations, charts or original layout",
      );
    }
  } else if (format === "pdf") {
    if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-")))
      fail("不是有效的 PDF / Invalid PDF");
    const doc = await pdfDocument(bytes);
    try {
      if (doc.numPages > 500) fail("PDF 超过 500 页 / PDF exceeds 500 pages");
      for (let page = 1; page <= doc.numPages; page++) {
        const p = await doc.getPage(page),
          content = await p.getTextContent();
        add(
          `页 / Page ${page}`,
          content.items.map((i) => i.str + (i.hasEOL ? "\n" : " ")).join(""),
        );
        p.cleanup();
      }
    } finally {
      await doc.loadingTask.destroy();
    }
    if (!units.some((u) => u.text.trim()))
      warnings.push(
        "PDF 没有可提取的文字，可能是扫描件；未执行文字识别 / No extractable text; OCR was not performed",
      );
  } else if (["png", "jpg", "jpeg", "webp", "gif"].includes(format)) {
    const actual = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? "png"
      : bytes[0] === 255 && bytes[1] === 216
        ? "jpeg"
        : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP"
          ? "webp"
          : /^GIF8[79]a/.test(bytes.subarray(0, 6).toString())
            ? "gif"
            : "unknown";
    if (actual !== (format === "jpg" ? "jpeg" : format))
      fail("图片扩展名与实际格式不符 / Image extension does not match content");
    const header = imageSize(bytes);
    if (
      !header.width ||
      !header.height ||
      header.width * header.height > 32 * 1024 * 1024 ||
      header.width > 16384 ||
      header.height > 16384
    )
      fail("图片尺寸超过上限 / Image dimensions exceed limits");
    const { loadImage, createCanvas } = await graphics();
    const decoded = await loadImage(bytes);
    image = { width: decoded.width, height: decoded.height };
    for (const edge of [1024, 768, 512]) {
      const scale = Math.min(1, edge / Math.max(decoded.width, decoded.height));
      const canvas = createCanvas(
        Math.max(1, Math.round(decoded.width * scale)),
        Math.max(1, Math.round(decoded.height * scale)),
      );
      canvas.getContext("2d").drawImage(decoded, 0, 0, canvas.width, canvas.height);
      const bytes = canvas.toBuffer("image/png");
      if (bytes.length <= 1400 * 1024) {
        model_image = bytes.toString("base64");
        break;
      }
    }
    if (!model_image) fail("图片缩略图超限 / Image thumbnail exceeds limit");
    if (format === "gif") warnings.push("动画仅预览首帧 / Animated images preview the first frame");
  } else if (
    [
      "txt",
      "md",
      "csv",
      "json",
      "log",
      "ts",
      "js",
      "rs",
      "py",
      "html",
      "htm",
      "css",
      "xml",
      "yaml",
      "yml",
      "svg",
    ].includes(format)
  ) {
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail("文件不是 UTF-8 文本，请转换编码 / Expected UTF-8 text");
    }
    text.split(/\r?\n/).forEach((s, n) => add(`行 / Line ${n + 1}`, s));
    if (["html", "htm", "svg"].includes(format))
      warnings.push(
        "仅显示源文字，不执行脚本或加载外部资源 / Source text only; scripts and external resources are disabled",
      );
  } else
    fail("不支持此格式，请转换为 DOCX/XLSX/PPTX/PDF、文本或常用图片 / Unsupported file format");
  return { format, media_type: mime[format] || "text/plain", units, warnings, image, model_image };
}
async function preview(bytes, name, page) {
  const { loadImage, createCanvas } = await graphics();
  if (formatOf(name) === "pdf") {
    const doc = await pdfDocument(bytes);
    try {
      if (page < 1 || page > doc.numPages) fail("页码超出范围 / Page is out of range");
      const p = await doc.getPage(page),
        initial = p.getViewport({ scale: 1 });
      const viewport = p.getViewport({
        scale: Math.min(1.5, 1400 / Math.max(initial.width, initial.height)),
      });
      if (!Number.isFinite(viewport.width) || viewport.width < 1 || viewport.height < 1)
        fail("PDF 页面尺寸无效 / Invalid page dimensions");
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await p.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      return canvas.toBuffer("image/png");
    } finally {
      await doc.loadingTask.destroy();
    }
  }
  const report = await parse(bytes, name);
  if (!report.image) fail("此格式使用内容预览 / Use content preview for this format");
  const img = await loadImage(bytes),
    scale = Math.min(1, 1400 / Math.max(img.width, img.height));
  const canvas = createCanvas(
    Math.max(1, Math.round(img.width * scale)),
    Math.max(1, Math.round(img.height * scale)),
  );
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toBuffer("image/png");
}
export async function execute(job) {
  if (job.kind === "generate") {
    const { generateDocument } = await import("./write.mjs");
    const bytes = await generateDocument(job.format, job.recipe, directory);
    if (bytes.length > MAX) fail("生成文件超过 32 MiB / Generated file exceeds 32 MiB");
    const report = await parse(Buffer.from(bytes), `output.${job.format}`);
    fs.writeFileSync("output.bin", bytes, { flag: "wx" });
    return report;
  }
  const bytes = fs.readFileSync("input.bin");
  if (job.kind === "preview") {
    const png = await preview(bytes, job.name, job.page);
    if (png.length > 4 * 1024 * 1024) fail("预览图片过大 / Preview exceeds limit");
    fs.writeFileSync("preview.png", png, { flag: "wx" });
    return { preview: true };
  }
  if (job.kind !== "parse") fail("Unknown worker operation");
  return parse(bytes, job.name);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const raw = fs.readFileSync("job.json", "utf8");
    if (raw.length > 512 * 1024) fail("任务参数过大 / Job too large");
    const report = await execute(JSON.parse(raw));
    fs.writeFileSync("report.json", JSON.stringify({ ok: true, ...report }), { flag: "wx" });
  } catch (error) {
    let message =
      error?.name === "PasswordException"
        ? "PDF 需要密码，请先另存为未加密文件 / Password-protected PDF"
        : String(error?.message || error);
    if (message.length > 2000) message = message.slice(0, 2000);
    fs.writeFileSync("report.json", JSON.stringify({ ok: false, error: message }), { flag: "wx" });
    process.exitCode = 1;
  }
}
