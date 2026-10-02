import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { root } from "./cargo.mjs";
const destination = join(root, "artifacts/workpilot-p06-2026-10-02");
await mkdir(join(destination, "preview"), { recursive: true });
await mkdir(join(destination, "tools"), { recursive: true });
const old = JSON.parse(
  await readFile(
    join(root, "artifacts/workpilot-p05-2026-10-02/source-and-binary-manifest.json"),
    "utf8",
  ),
);
for (const file of old.binaries) {
  const bytes = await readFile(join(root, "artifacts/workpilot-p05-2026-10-02", file.path));
  if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
    throw new Error("P05 delivery changed: " + file.path);
}
const binaries = [];
for (const [source, path] of [
  ["target/release/workpilot-desktop.exe", "preview/WorkPilot.exe"],
  ["target/release/workpilot-engine.exe", "preview/workpilot-sidecar.exe"],
  ["target/release/workpilot-data.exe", "tools/workpilot-data.exe"],
]) {
  await copyFile(join(root, source), join(destination, path));
  const data = await readFile(join(destination, path));
  binaries.push({
    path,
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  });
}
await writeFile(
  join(destination, "preview/使用说明.txt"),
  "WorkPilot P06 开发预览\r\n\r\n双击 WorkPilot.exe，保留旁边的 workpilot-sidecar.exe。\r\n先配置模型服务；测试凭据不会随包提供。\r\n左侧绑定项目和管理任务，中间对话，右侧查看权限、协作、成果及完整记录。可编辑/取消排队消息、搜索/归档任务，保存界面语言和外观。\r\n关闭窗口隐藏到托盘，任务继续；彻底退出后停止，重开后中断任务需手动继续。\r\n当前附件支持小型文本；文件编辑、浏览器、插件及办公文件随后实现。\r\n数据版本 6，不要用旧版本打开新版数据库。完整说明和证据见交付目录 README.md。\r\n",
  "utf8",
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
  const data = await readFile(join(root, path));
  sourceFiles.push({
    path,
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  });
}
const manifest = {
  phase: "P06",
  createdAt: new Date().toISOString(),
  platform: process.platform,
  baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  workingTree: "Uncommitted implementation. Existing user changes are preserved.",
  versions: { protocol: "workpilot.v1", schema: 6, eventExport: 1, completeRecordExport: 1 },
  binaries,
  sourceFiles,
};
await writeFile(
  join(destination, "source-and-binary-manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(
  JSON.stringify({ phase: "P06", sourceFileCount: sourceFiles.length, binaries }, null, 2),
);
