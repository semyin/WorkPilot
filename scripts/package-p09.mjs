import { copyFile, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { root } from "./cargo.mjs";
const destination = join(root, "artifacts/workpilot-p09-2026-10-03");
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
const previous = join(root, "artifacts/workpilot-p08-2026-10-03");
const old = JSON.parse(await readFile(join(previous, "source-and-binary-manifest.json"), "utf8"));
for (const file of old.binaries)
  if (digest(await readFile(join(previous, file.path))) !== file.sha256)
    throw new Error("P08 delivery changed: " + file.path);
const binaries = [];
async function copy(source, path) {
  await mkdir(dirname(join(destination, path)), { recursive: true });
  await copyFile(source, join(destination, path));
  const bytes = await readFile(join(destination, path));
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
await generated(
  "preview/使用说明.txt",
  "WorkPilot P09 开发预览\r\n\r\n先从旧版托盘彻底退出，再双击 WorkPilot.exe，保留整个 preview 文件夹。\r\n顶部“技能与插件”提供安装预览、说明阅读、确认启用、凭据登录、工具测试和历史版本。内置 skill-creator 用来指导 AI 创建技能。\r\n“让 AI 创建技能”会准备一个规划任务；选择自己的模型再启动。草稿需要用户确认后才能用于新任务。\r\n试用附带示例：导入相邻 examples/report-checklist 目录；选择绑定项目文件夹的执行任务、开启本地程序，在技能的资源区测试脚本。审批后生成 report-checklist.md，不覆盖同名文件。\r\n扩展和浏览器共用随包 Node.js 22.23.2；其它第三方依赖不会偷偷安装。普通审批中的本地扩展禁止网络，需要联网请用远程 HTTP 服务或明确选择完全访问。\r\n数据版本升级至 8，旧版不应打开升级后的数据。历史交付文件仍保留；完整迁移与干净系统安装在 P12 验证。\r\nWindows 自动验证通过；真实模型生成质量、实际商业服务登录和 macOS/Linux 仍需体验或补测。\r\n",
);
if (process.platform === "win32")
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath @((Join-Path $env:WORKPILOT_PACKAGE_FOLDER 'preview'), (Join-Path $env:WORKPILOT_PACKAGE_FOLDER 'examples')) -DestinationPath (Join-Path $env:WORKPILOT_PACKAGE_FOLDER 'WorkPilot-P09-Windows-x64-preview.zip') -Force",
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
      phase: "P09",
      build,
      createdAt: new Date().toISOString(),
      platform: process.platform,
      baseCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      workingTree:
        "P09 working-tree snapshot based on the existing P08 commit. No new commit or push was requested for this phase.",
      versions: {
        protocol: "workpilot.v1",
        schema: 8,
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
      phase: "P09",
      sourceFileCount: sourceFiles.length,
      deliveryFiles: binaries.length,
      node: process.versions.node,
    },
    null,
    2,
  ),
);
