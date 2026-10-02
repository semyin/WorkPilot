import { copyFile, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { root } from "./cargo.mjs";

const destination = join(root, "artifacts/workpilot-p03-2026-10-02");
await mkdir(join(destination, "preview"), { recursive: true });
await mkdir(join(destination, "tools"), { recursive: true });
const binaries = [
  ["target/release/workpilot-desktop.exe", "preview/WorkPilot.exe"],
  ["target/release/workpilot-engine.exe", "preview/workpilot-engine.exe"],
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
  "WorkPilot P03 开发预览\r\n\r\n双击 WorkPilot.exe。请保留旁边的 workpilot-engine.exe。\r\n点击左下方“任务执行”，可新建任务、查看执行过程、排队、引导、停止与手动继续。真实模型需先在“模型服务”配置。\r\n本阶段工具只处理内置样本和任务内测试记录，真实文件与终端操作将在后续接入。真实服务验收待完成。此为开发预览，不是正式安装版。\r\n点击关闭只隐藏到托盘；选择“彻底退出”才会结束程序。\r\n\r\n更多说明见交付目录 README.md 与 docs/development/P03-验证记录.md。\r\n",
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
  phase: "P03",
  createdAt: new Date().toISOString(),
  platform: process.platform,
  baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  workingTree: "Uncommitted implementation. Existing user changes are preserved.",
  versions: { protocol: "workpilot.v1", schema: 3, eventExport: 1 },
  binaries: fingerprints,
  sourceFiles: sources,
};
await writeFile(
  join(destination, "source-and-binary-manifest.json"),
  JSON.stringify(manifest, null, 2),
);
console.log(
  JSON.stringify(
    { phase: "P03", binaries: fingerprints, sourceFileCount: sources.length },
    null,
    2,
  ),
);
