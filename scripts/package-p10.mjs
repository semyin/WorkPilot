import { copyFile, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { root } from "./cargo.mjs";
const destination = join(root, "artifacts/workpilot-p10-layout-2026-10-03");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const build = JSON.parse(await readFile(join(root, ".local/desktop-release-receipt.json"), "utf8"));
for (const [key, file] of [
  ["desktop", "workpilot-desktop.exe"],
  ["engine", "workpilot-engine.exe"],
]) {
  if (digest(await readFile(join(root, "target/release", file))) !== build[key])
    throw new Error(
      "Run npm run build before packaging; binary differs from the Tauri build receipt: " + key,
    );
}
const previous = join(root, "artifacts/workpilot-p10-2026-10-03");
const old = JSON.parse(await readFile(join(previous, "source-and-binary-manifest.json"), "utf8"));
for (const file of old.binaries)
  if (digest(await readFile(join(previous, file.path))) !== file.sha256)
    throw new Error("Previous P10 delivery changed: " + file.path);
const binaries = [];
async function copy(source, path) {
  await mkdir(dirname(join(destination, path)), { recursive: true });
  const bytes = await readFile(source);
  let same = false;
  try {
    same = digest(await readFile(join(destination, path))) === digest(bytes);
  } catch {}
  if (!same) await copyFile(source, join(destination, path));
  binaries.push({ path, bytes: bytes.length, sha256: digest(bytes) });
}
async function generated(path, text) {
  const file = join(destination, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  const bytes = await readFile(file);
  binaries.push({ path, bytes: bytes.length, sha256: digest(bytes) });
}
for (const [source, path] of [
  ["target/release/workpilot-desktop.exe", "preview/WorkPilot.exe"],
  ["target/release/workpilot-engine.exe", "preview/workpilot-sidecar.exe"],
  ["target/release/workpilot-data.exe", "tools/workpilot-data.exe"],
  ["target/release/companion.exe", "preview/browser-companion/companion.exe"],
  ["services/browser/driver.mjs", "preview/browser-runtime/services/browser/driver.mjs"],
  [
    "extensions/companion/cdp-actions.js",
    "preview/browser-runtime/extensions/companion/cdp-actions.js",
  ],
  ["scripts/install-packaged-browser-companion.ps1", "preview/browser-companion/register.ps1"],
])
  await copy(join(root, source), path);
await copy(process.execPath, "preview/browser-runtime/node.exe");
await copy(join(dirname(process.execPath), "LICENSE"), "preview/browser-runtime/NODE_LICENSE.txt");
await generated(
  "preview/browser-runtime/package.json",
  JSON.stringify({ private: true, type: "module" }, null, 2) + "\n",
);
for (const name of await readdir(join(root, "extensions/companion")))
  await copy(
    join(root, "extensions/companion", name),
    "preview/browser-companion/extension/" + name,
  );
for (const browser of ["chrome", "edge"])
  await generated(
    "preview/browser-companion/register-" + browser + ".cmd",
    '@echo off\r\npowershell -NoProfile -File "%~dp0register.ps1" -Browser ' +
      browser +
      "\r\npause\r\n",
  );
for (const path of ["SKILL.md", "references/checklist.md", "scripts/checklist.mjs"])
  await copy(
    join(root, "examples/extensions/report-checklist", path),
    "examples/report-checklist/" + path,
  );
const runtime = join(root, "target/release/document-runtime");
const treeCopies = [];
async function copyTree(source, relativePath) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const child = join(source, entry.name),
      target = relativePath + "/" + entry.name;
    if (entry.isDirectory()) await copyTree(child, target);
    else if (entry.isFile()) treeCopies.push([child, target]);
  }
}
await copyTree(runtime, "preview/document-runtime");
await copyTree(join(root, "target/release/office-runtime"), "preview/office-runtime");
let next = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (next < treeCopies.length) {
      const [source, path] = treeCopies[next++];
      await copy(source, path);
    }
  }),
);
if (process.argv.includes("--preview-only")) {
  console.log("P10 preview staged for distribution checks.");
  process.exit(0);
}
const openedSamples = JSON.parse(
  await readFile(join(root, ".test-results/office-distribution/report.json"), "utf8"),
);
if (openedSamples.status !== "passed") throw new Error("Office sample verification did not pass");
if (openedSamples.binary.sha256 !== build.engine)
  throw new Error("Office check used another engine");
for (const sample of openedSamples.renders)
  if (
    digest(await readFile(join(root, ".test-results/media-engine/sample." + sample.format))) !==
    sample.sourceSha256
  )
    throw new Error("Office sample changed after verification: " + sample.format);
for (const ext of ["docx", "xlsx", "pptx", "pdf", "csv", "md"])
  await copy(join(root, ".test-results/media-engine/sample." + ext), "samples/sample." + ext);
for (const [format, count] of [
  ["docx", 1],
  ["xlsx", 1],
  ["pptx", 2],
])
  for (let page = 1; page <= count; page++)
    await copy(
      join(root, `.test-results/office-distribution/${format}-page-${page}.png`),
      `samples/${format}-page-${page}.png`,
    );
await copy(join(root, ".test-results/media-engine/pdf-preview.png"), "samples/pdf-page-1.png");
await generated(
  "preview/使用说明.txt",
  "WorkPilot P10 原版式预览补充版\r\n\r\n先从旧版托盘彻底退出，再双击 WorkPilot.exe。保留整个 preview 文件夹。\r\n任务顶部‘文件成果与图片’→读取项目文件→查看内容→查看原版式预览。DOCX/XLSX/PPTX 从原文件转换成 PDF 页面，支持翻页和停止，原文件不改写。字体与复杂排版可能和 Microsoft Office 有差异。\r\n输入框可添加文件、拖入文件或粘贴图片。外部修改后可刷新成新快照，原快照保留。\r\n转换环境随包提供，体积较大。首次查看需要几秒到几十秒；重复翻页复用转换结果。宏和外部更新关闭，转换进程不能联网。\r\n图片服务单独配置，未配置时不会显示生成成功。参考图来自当前任务附件；生成需要相应任务模式和审批。真实图片服务验收仍待配置，P10 尚未整体验收。\r\n相邻 samples 文件夹含固定样本和实际转换页面，数值为 25+17=42。\r\n数据版本仍为 9。Windows 开发机检查通过不代表正式 V1、干净机器或其它平台已经验收。\r\n",
);
if (process.platform === "win32")
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath @((Join-Path $env:WORKPILOT_PACKAGE_FOLDER 'preview'), (Join-Path $env:WORKPILOT_PACKAGE_FOLDER 'examples'), (Join-Path $env:WORKPILOT_PACKAGE_FOLDER 'samples')) -DestinationPath (Join-Path $env:WORKPILOT_PACKAGE_FOLDER 'WorkPilot-P10-Windows-x64-preview.zip') -Force",
    ],
    {
      windowsHide: true,
      env: { ...process.env, WORKPILOT_PACKAGE_FOLDER: destination, PSModulePath: "" },
    },
  );
const files = execFileSync("rg", ["--files", "--hidden", "-g", "!.git", "-g", "!artifacts"], {
  cwd: root,
  encoding: "utf8",
})
  .trim()
  .split(/\r?\n/)
  .map((p) => p.replaceAll("\\", "/"))
  .sort();
const sourceFiles = [];
for (const path of files) {
  const b = await readFile(join(root, path));
  sourceFiles.push({ path, bytes: b.length, sha256: digest(b) });
}
await writeFile(
  join(destination, "source-and-binary-manifest.json"),
  JSON.stringify(
    {
      phase: "P10",
      build,
      createdAt: new Date().toISOString(),
      platform: process.platform,
      baseCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      workingTree:
        "P10 Office layout preview continuation after the P09/P10 baseline was committed and pushed as 1825a54. The prior P10 delivery remains unchanged.",
      versions: {
        protocol: "workpilot.v1",
        schema: 9,
        eventExport: 1,
        completeRecordExport: 1,
        node: process.versions.node,
      },
      binaries,
      sourceFiles,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify(
    {
      phase: "P10",
      sourceFileCount: sourceFiles.length,
      deliveryFiles: binaries.length,
      node: process.versions.node,
    },
    null,
    2,
  ),
);
