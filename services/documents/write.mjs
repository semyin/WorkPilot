import fs from "node:fs";
import path from "node:path";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
} from "docx";
import ExcelJS from "exceljs";
import pptxgen from "pptxgenjs";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";

const error = (s) => {
  throw new Error(s);
};
function text(s, limit = 10000) {
  if (typeof s !== "string" || s.length > limit || s.includes("\0"))
    error("文字无效或超限 / Invalid or oversized text");
  return s;
}
function list(v, max = 100) {
  if (!Array.isArray(v) || v.length > max) error("列表无效或超限 / Invalid or oversized list");
  return v;
}
function scalar(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "boolean" || v == null) return v;
  return text(v, 4000);
}
function rows(v, max = 1000) {
  return list(v, max).map((r) => list(r, 64).map(scalar));
}
function sections(recipe) {
  return list(recipe.sections || [], 200).map((s) => ({
    heading: text(s.heading || "", 300),
    paragraphs: list(s.paragraphs || [], 200).map((p) => text(p)),
    table: s.table
      ? {
          columns: list(s.table.columns, 12).map((v) => text(v, 160)),
          rows: rows(s.table.rows, 300),
        }
      : null,
  }));
}
function chartData(chart) {
  if (!chart) return null;
  const labels = list(chart.labels, 20).map((v) => text(v, 40)),
    values = list(chart.values, 20);
  if (
    !labels.length ||
    labels.length !== values.length ||
    values.some((v) => typeof v !== "number" || !Number.isFinite(v))
  )
    error("图表标签和数值不匹配 / Invalid chart data");
  return { title: text(chart.title || "", 160), labels, values };
}
function chartPng(chart) {
  const canvas = createCanvas(960, 400),
    ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 960, 400);
  ctx.fillStyle = "#173349";
  ctx.font = 'bold 24px "WorkPilot Sans"';
  ctx.fillText(chart.title, 30, 38);
  const low = Math.min(0, ...chart.values),
    high = Math.max(0, ...chart.values),
    span = high - low || 1;
  const y = (v) => 330 - ((v - low) / span) * 250,
    zero = y(0),
    width = 840 / chart.values.length;
  ctx.strokeStyle = "#aabac7";
  ctx.beginPath();
  ctx.moveTo(60, zero);
  ctx.lineTo(920, zero);
  ctx.stroke();
  chart.values.forEach((value, i) => {
    const x = 65 + i * width;
    ctx.fillStyle = "#218580";
    ctx.fillRect(
      x,
      Math.min(y(value), zero),
      Math.max(2, width - 14),
      Math.max(1, Math.abs(y(value) - zero)),
    );
    ctx.fillStyle = "#173349";
    ctx.font = '16px "WorkPilot Sans"';
    ctx.fillText(String(value), x, y(value) + (value < 0 ? 20 : -8));
    ctx.save();
    ctx.translate(x, 365);
    ctx.font = '14px "WorkPilot Sans"';
    ctx.fillText(chart.labels[i], 0, 0, Math.max(10, width - 8));
    ctx.restore();
  });
  return canvas.toBuffer("image/png");
}
// Deliberately bounded arithmetic. Never evaluate arbitrary formula strings as JavaScript.
function evaluateFormula(formula, sheet) {
  formula = text(formula, 256).replace(/^=/, "").toUpperCase();
  const range = /^(SUM|AVERAGE|MIN|MAX)\(([A-Z]{1,3})([1-9]\d*):([A-Z]{1,3})([1-9]\d*)\)$/.exec(
    formula,
  );
  const number = (address) => {
    const c = sheet.getCell(address),
      v = c.value;
    const n = typeof v === "object" && v ? v.result : v;
    if (typeof n !== "number" || !Number.isFinite(n))
      error(`公式引用的 ${address} 没有已计算数值 / Formula reference has no numeric value`);
    return n;
  };
  if (range) {
    const [, fn, c1, r1, c2, r2] = range,
      a = sheet.getColumn(c1).number,
      b = sheet.getColumn(c2).number;
    if (b < a || +r2 < +r1 || (+r2 - +r1 + 1) * (b - a + 1) > 20000)
      error("公式范围无效 / Invalid formula range");
    const values = [];
    for (let r = +r1; r <= +r2; r++)
      for (let c = a; c <= b; c++) values.push(number(sheet.getCell(r, c).address));
    if (fn === "MIN") return Math.min(...values);
    if (fn === "MAX") return Math.max(...values);
    const total = values.reduce((a, b) => a + b, 0);
    return fn === "AVERAGE" ? total / values.length : total;
  }
  const tokens = formula.match(/[A-Z]+[1-9]\d*|\d+(?:\.\d+)?|[()+*/-]/g) || [];
  if (tokens.join("") !== formula.replaceAll(" ", "") || tokens.length > 128)
    error(
      "公式仅支持四则运算和 SUM/AVERAGE/MIN/MAX 范围 / Unsupported formula; use arithmetic or a supported range function",
    );
  let index = 0;
  const atom = () => {
    let t = tokens[index++];
    if (t === "-") return -atom();
    if (t === "+") return atom();
    if (t === "(") {
      const n = expression();
      if (tokens[index++] !== ")") error("公式括号不匹配 / Invalid formula");
      return n;
    }
    if (/^[A-Z]/.test(t || "")) return number(t);
    if (!/^\d/.test(t || "")) error("公式无效 / Invalid formula");
    return +t;
  };
  const product = () => {
    let n = atom();
    while (tokens[index] === "*" || tokens[index] === "/") {
      const op = tokens[index++],
        v = atom();
      n = op === "*" ? n * v : n / v;
    }
    return n;
  };
  const expression = () => {
    let n = product();
    while (tokens[index] === "+" || tokens[index] === "-") {
      const op = tokens[index++],
        v = product();
      n = op === "+" ? n + v : n - v;
    }
    return n;
  };
  const value = expression();
  if (index !== tokens.length || !Number.isFinite(value))
    error("公式结果无效或除零 / Invalid formula result");
  return value;
}
export async function generateDocument(format, recipe, directory) {
  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe))
    error("内容结构无效 / Invalid document recipe");
  const title = text(recipe.title || "WorkPilot", 300),
    fontPath = path.join(directory, "fonts/NotoSansCJKsc-Regular.otf");
  if (fs.existsSync(fontPath)) GlobalFonts.registerFromPath(fontPath, "WorkPilot Sans");
  if (format === "docx") {
    const content = [
      new Paragraph({ text: title, heading: HeadingLevel.TITLE, spacing: { after: 280 } }),
    ];
    for (const section of sections(recipe)) {
      if (section.heading)
        content.push(
          new Paragraph({
            text: section.heading,
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 220, after: 120 },
          }),
        );
      for (const p of section.paragraphs)
        content.push(
          new Paragraph({ children: [new TextRun(p)], spacing: { after: 140, line: 280 } }),
        );
      if (section.table)
        content.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [section.table.columns, ...section.table.rows].map(
              (r, i) =>
                new TableRow({
                  tableHeader: i === 0,
                  children: r.map(
                    (v) =>
                      new TableCell({
                        shading: i === 0 ? { fill: "E5F0F2" } : undefined,
                        children: [
                          new Paragraph({
                            children: [new TextRun({ text: String(v ?? ""), bold: i === 0 })],
                          }),
                        ],
                      }),
                  ),
                }),
            ),
          }),
        );
    }
    return Packer.toBuffer(
      new Document({
        creator: "WorkPilot",
        title,
        styles: { default: { document: { run: { font: "Microsoft YaHei", size: 21 } } } },
        sections: [
          {
            properties: { page: { margin: { top: 1000, bottom: 1000, left: 1100, right: 1100 } } },
            children: content,
          },
        ],
      }),
    );
  }
  if (format === "xlsx") {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "WorkPilot";
    workbook.calcProperties.fullCalcOnLoad = true;
    const sheets = list(recipe.sheets, 30);
    if (!sheets.length) error("至少需要一张工作表 / At least one worksheet is required");
    for (const s of sheets) {
      const sheet = workbook.addWorksheet(text(s.name, 31));
      const values = rows(s.rows, 5000);
      if (!values.length) error("工作表没有数据 / Worksheet has no data");
      sheet.addRows(values);
      sheet.views = [{ state: "frozen", ySplit: 1 }];
      sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
      sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF173349" } };
      sheet.getRow(1).height = 26;
      sheet.columns.forEach((c) => {
        c.width = 24;
        c.alignment = { vertical: "top", wrapText: true };
      });
      for (const f of list(s.formulas || [], 500)) {
        const address = text(f.cell, 8);
        if (!/^[A-Z]{1,2}[1-9]\d{0,3}$/.test(address))
          error("公式单元格无效 / Invalid formula cell");
        const cell = sheet.getCell(address);
        if (cell.value !== null) error("公式不能覆盖已有数据 / Formula would overwrite data");
        const formula = text(f.formula, 256).replace(/^=/, "");
        cell.value = { formula, result: evaluateFormula(formula, sheet) };
      }
      const chart = chartData(s.chart);
      if (chart) {
        const id = workbook.addImage({ buffer: chartPng(chart), extension: "png" });
        sheet.addImage(id, {
          tl: { col: 0, row: sheet.rowCount + 2 },
          ext: { width: 720, height: 300 },
        });
      }
      sheet.pageSetup = {
        paperSize: 9,
        orientation: "landscape",
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
      };
    }
    return workbook.xlsx.writeBuffer();
  }
  if (format === "pptx") {
    const pres = new pptxgen();
    pres.layout = "LAYOUT_WIDE";
    pres.author = "WorkPilot";
    pres.subject = title;
    pres.title = title;
    pres.lang = "zh-CN";
    pres.theme = {
      headFontFace: "Microsoft YaHei",
      bodyFontFace: "Microsoft YaHei",
      lang: "zh-CN",
    };
    const slides = list(recipe.slides, 100);
    if (!slides.length) error("至少需要一页幻灯片 / At least one slide is required");
    for (const [index, s] of slides.entries()) {
      const slide = pres.addSlide();
      slide.background = { color: "F7FAFC" };
      slide.addShape(pres.ShapeType.rect, {
        x: 0,
        y: 0,
        w: 0.14,
        h: 7.5,
        fill: { color: "218580" },
        line: { color: "218580" },
      });
      slide.addText(text(s.title || title, 160), {
        x: 0.6,
        y: 0.4,
        w: 12.1,
        h: 0.9,
        fontSize: 28,
        bold: true,
        color: "173349",
        margin: 0,
        fit: "shrink",
        breakLine: false,
      });
      const body = list(s.body || [], 10).map((v) => text(v, 500));
      if (body.length)
        slide.addText(body.join("\n\n"), {
          x: 0.65,
          y: 1.6,
          w: s.chart || s.table ? 5.3 : 11.9,
          h: 4.9,
          fontSize: 20,
          color: "30495A",
          margin: 0,
          fit: "shrink",
          valign: "top",
        });
      if (s.table) {
        const table = [
          list(s.table.columns, 8).map((v) => text(v, 100)),
          ...rows(s.table.rows, 12),
        ];
        slide.addTable(table, {
          x: body.length ? 6.3 : 0.65,
          y: 1.6,
          w: body.length ? 6.2 : 11.9,
          h: 4.6,
          fontSize: 14,
          color: "173349",
          border: { pt: 0.5, color: "BACCD5" },
          margin: 0.1,
          autoPage: false,
        });
      }
      const chart = chartData(s.chart);
      if (chart)
        slide.addChart(
          pres.ChartType.bar,
          [{ name: chart.title || "Data", labels: chart.labels, values: chart.values }],
          {
            x: body.length ? 6.3 : 0.65,
            y: 1.7,
            w: body.length ? 6.2 : 11.9,
            h: 4.8,
            catAxisLabelFontFace: "Microsoft YaHei",
            chartColors: ["218580"],
            showValue: true,
            showLegend: false,
            showTitle: !!chart.title,
            title: chart.title,
          },
        );
      slide.addText(`${index + 1} / ${slides.length}`, {
        x: 11.6,
        y: 7,
        w: 1,
        h: 0.22,
        fontSize: 10,
        color: "657B8B",
        align: "right",
        margin: 0,
      });
    }
    return pres.write({ outputType: "nodebuffer" });
  }
  if (format === "pdf") {
    if (!fs.existsSync(fontPath)) error("PDF 字体资源缺失 / Bundled PDF font is missing");
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    pdf.setTitle(title);
    pdf.setCreator("WorkPilot");
    // Keep the pinned Simplified Chinese font intact. Its `locl` digit variants
    // have no Unicode/width entries in pdf-lib's full-font cmap; they otherwise
    // render with fallback spacing and extract as private-use characters.
    const font = await pdf.embedFont(fs.readFileSync(fontPath), {
      subset: false,
      features: { locl: false },
    });
    const glyphs = new Set(font.getCharacterSet());
    let page, y;
    const newPage = () => {
      page = pdf.addPage([595.28, 841.89]);
      y = 786;
    };
    newPage();
    const write = (value, size = 11, color = rgb(0.16, 0.23, 0.28)) => {
      let line = "";
      const flush = () => {
        if (y < 60) newPage();
        page.drawText(line, { x: 48, y, size, font, color });
        y -= size * 1.55;
        line = "";
      };
      for (const char of value.replaceAll("\t", "    ")) {
        if (char !== "\n" && !glyphs.has(char.codePointAt(0)))
          error(
            "PDF 字体不支持此字符 / PDF font does not support U+" +
              char.codePointAt(0).toString(16).toUpperCase(),
          );
        if (char === "\n") {
          flush();
          continue;
        }
        if (font.widthOfTextAtSize(line + char, size) > 499 && line) flush();
        line += char;
      }
      if (line) flush();
      y -= 8;
    };
    write(title, 22, rgb(0.08, 0.2, 0.29));
    for (const section of sections(recipe)) {
      if (section.heading) write(section.heading, 16);
      for (const p of section.paragraphs) write(p);
      if (section.table)
        for (const row of [section.table.columns, ...section.table.rows])
          write(row.map((v) => String(v ?? "")).join("  |  "), 10);
    }
    pdf
      .getPages()
      .forEach((p, i) =>
        p.drawText(`${i + 1} / ${pdf.getPageCount()}`, { x: 505, y: 30, size: 9, font }),
      );
    return pdf.save();
  }
  if (format === "csv") {
    const escape = (v) => {
      let s = String(v ?? "");
      if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return '"' + s.replaceAll('"', '""') + '"';
    };
    return Buffer.from(
      "\uFEFF" +
        rows(recipe.rows, 5000)
          .map((r) => r.map(escape).join(","))
          .join("\r\n") +
        "\r\n",
    );
  }
  if (format === "txt" || format === "md") return Buffer.from(text(recipe.text, 256 * 1024));
  error("不支持的生成格式 / Unsupported output format");
}
