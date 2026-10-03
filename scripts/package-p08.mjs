import { copyFile, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { root } from "./cargo.mjs";
const destination = join(root, "artifacts/workpilot-p08-2026-10-03");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const previous = join(root, "artifacts/workpilot-p07-2026-10-03");
const old = JSON.parse(await readFile(join(previous, "source-and-binary-manifest.json"), "utf8"));
for (const file of old.binaries)
  if (digest(await readFile(join(previous, file.path))) !== file.sha256)
    throw new Error("P07 delivery changed: " + file.path);
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
await generated(
  "preview/使用说明.txt",
  "WorkPilot P08 开发预览\r\n\r\n先从旧版托盘彻底退出，再双击 WorkPilot.exe。请保留整个 preview 文件夹。\r\n选择绑定项目文件夹的执行任务，点击顶部“浏览器”：可启动专用 Chrome/Edge，或连接日常浏览器。\r\n手工读取、点击、填写、截图不调用收费模型。需要审批时，在浏览器操作记录确认；由 AI 发起的操作确认后点击继续 AI 任务。\r\n日常浏览器需用户安装 browser-companion/extension 扩展并明确连接标签页；本机源码目录的 Companion 已注册，可直接加载项目 extensions/companion。\r\n新机器先运行 browser-companion/register-chrome.cmd 或 register-edge.cmd，然后在浏览器扩展页面加载相邻 extension 目录。注册脚本不会覆盖其它位置已有登记。\r\n上传最多 512 KiB；下载最多 8 MiB，保存项目内并保留文件历史。登录和验证码使用手动接管。\r\n关闭窗口保留后台；彻底退出关闭专用浏览器、断开日常浏览器。不会关闭用户原来的浏览器。\r\n随包 Node.js 22.23.2，Chrome/Edge 使用电脑已安装版本；干净系统完整安装在 P12 验证。数据版本保持 7。\r\nWindows 已自动测试，日常 Chrome/Edge 的本轮用户授权体验及 macOS/Linux 尚待补测。\r\n",
);
if (process.platform === "win32")
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath (Join-Path $env:WORKPILOT_PACKAGE_FOLDER 'preview') -DestinationPath (Join-Path $env:WORKPILOT_PACKAGE_FOLDER 'WorkPilot-P08-Windows-x64-preview.zip') -Force",
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
      phase: "P08",
      createdAt: new Date().toISOString(),
      platform: process.platform,
      baseCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      workingTree:
        "P08 source snapshot before the authorized commit and normal push; includes earlier P07 commit.",
      versions: {
        protocol: "workpilot.v1",
        schema: 7,
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
      phase: "P08",
      sourceFileCount: sourceFiles.length,
      deliveryFiles: binaries.length,
      node: process.versions.node,
    },
    null,
    2,
  ),
);
