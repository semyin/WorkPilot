import { copyFile, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { root } from "./cargo.mjs";

const destination = join(root, "artifacts/workpilot-p05-2026-10-02");
await mkdir(join(destination, "preview"), { recursive: true });
await mkdir(join(destination, "tools"), { recursive: true });
const binaries = [
  ["target/release/workpilot-desktop.exe", "preview/WorkPilot.exe"],
  ["target/release/workpilot-engine.exe", "preview/workpilot-sidecar.exe"],
  ["target/release/workpilot-data.exe", "tools/workpilot-data.exe"],
];
const fingerprints = [];
for (const [source, target] of binaries) {
  await copyFile(join(root, source), join(destination, target));
  const data = await readFile(join(destination, target));
  fingerprints.push({
    path: target,
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  });
}
await writeFile(
  join(destination, "preview/使用说明.txt"),
  "WorkPilot P05 开发预览\r\n\r\n双击 WorkPilot.exe。保留旁边的 workpilot-sidecar.exe。\r\n在任务执行中选择直接执行，可让主助手按需分工，也可先创建并设置分工。协作面板可以查看成员的模型、职责、依赖、交付、错误及接替，打开成员过程与具体审批。\r\n先在模型服务中配置自己的模型；测试凭据不随包提供。建议选择专门的测试文件夹。此为开发预览，正式工作台和安装包仍在后续阶段。\r\n关闭窗口隐藏到托盘，任务继续；彻底退出后停止，重开需手动继续。\r\n\r\n完整说明见交付目录 README.md。\r\n",
  "utf8",
);
const files = execFileSync("rg", ["--files", "--hidden", "-g", "!.git", "-g", "!artifacts"], {
  cwd: root,
  encoding: "utf8",
})
  .trim()
  .split(/\r?\n/)
  .map((path) => path.replaceAll("\\", "/"))
  .sort();
const sources = [];
for (const path of files) {
  const data = await readFile(join(root, path));
  sources.push({
    path,
    bytes: (await stat(join(root, path))).size,
    sha256: createHash("sha256").update(data).digest("hex"),
  });
}
const manifest = {
  phase: "P05",
  createdAt: new Date().toISOString(),
  platform: process.platform,
  baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  workingTree: "Uncommitted implementation. Existing user changes are preserved.",
  versions: { protocol: "workpilot.v1", schema: 5, eventExport: 1 },
  binaries: fingerprints,
  sourceFiles: sources,
};
await writeFile(
  join(destination, "source-and-binary-manifest.json"),
  JSON.stringify(manifest, null, 2),
);
console.log(
  JSON.stringify(
    { phase: "P05", binaries: fingerprints, sourceFileCount: sources.length },
    null,
    2,
  ),
);
