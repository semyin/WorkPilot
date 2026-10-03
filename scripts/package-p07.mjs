import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { root } from "./cargo.mjs";
const destination = join(root, "artifacts/workpilot-p07-2026-10-03");
await mkdir(join(destination, "preview"), { recursive: true });
await mkdir(join(destination, "tools"), { recursive: true });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const previous = join(root, "artifacts/workpilot-p06-2026-10-02");
const old = JSON.parse(await readFile(join(previous, "source-and-binary-manifest.json"), "utf8"));
for (const file of old.binaries) {
  if (digest(await readFile(join(previous, file.path))) !== file.sha256)
    throw new Error("P06 delivery changed: " + file.path);
}
const binaries = [];
for (const [source, path] of [
  ["target/release/workpilot-desktop.exe", "preview/WorkPilot.exe"],
  ["target/release/workpilot-engine.exe", "preview/workpilot-sidecar.exe"],
  ["target/release/workpilot-data.exe", "tools/workpilot-data.exe"],
]) {
  await copyFile(join(root, source), join(destination, path));
  const data = await readFile(join(destination, path));
  binaries.push({ path, bytes: data.length, sha256: digest(data) });
}
await writeFile(
  join(destination, "preview/使用说明.txt"),
  "WorkPilot P07 开发预览\r\n\r\n先在旧版托盘选择“彻底退出”，再双击 WorkPilot.exe，保留旁边的 workpilot-sidecar.exe。\r\n选择绑定文件夹的任务，点击“文件与终端”：编辑文件、查看修改历史并恢复、运行 PowerShell 命令、查看 Git 差异并提交选中文件。\r\n修改需要执行模式；需要确认时，在操作记录中展开具体内容后确认。\r\n手工文件和终端操作不调用模型。让 AI 执行任务仍需自己的模型配置，测试密钥不随包提供。\r\n文本编辑 256 KiB，版本单文件 64 MiB；办公内容预览后续实现。终端暂不支持持续交互输入，长命令运行时同项目写入排队。\r\n关闭窗口隐藏到托盘继续执行；彻底退出会停止后台进程，重开不自动重复中断命令。\r\n数据版本 7，不要用旧版本打开新版数据库。完整边界和证据见交付目录 README.md。\r\n",
  "utf8",
);
if (process.platform === "win32") {
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath @((Join-Path $env:WORKPILOT_PACKAGE_FOLDER 'preview/WorkPilot.exe'),(Join-Path $env:WORKPILOT_PACKAGE_FOLDER 'preview/workpilot-sidecar.exe'),(Join-Path $env:WORKPILOT_PACKAGE_FOLDER 'preview/使用说明.txt')) -DestinationPath (Join-Path $env:WORKPILOT_PACKAGE_FOLDER 'WorkPilot-P07-Windows-x64-preview.zip') -Force",
    ],
    {
      windowsHide: true,
      env: { ...process.env, WORKPILOT_PACKAGE_FOLDER: destination, PSModulePath: "" },
    },
  );
}
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
  const data = await readFile(join(root, path));
  sourceFiles.push({ path, bytes: data.length, sha256: digest(data) });
}
await writeFile(
  join(destination, "source-and-binary-manifest.json"),
  JSON.stringify(
    {
      phase: "P07",
      createdAt: new Date().toISOString(),
      platform: process.platform,
      baseCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      workingTree: "P07 source snapshot captured before the authorized local commit; no push.",
      versions: { protocol: "workpilot.v1", schema: 7, eventExport: 1, completeRecordExport: 1 },
      binaries,
      sourceFiles,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({ phase: "P07", sourceFileCount: sourceFiles.length, binaries }, null, 2),
);
