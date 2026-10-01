import { copyFile, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { root } from "./cargo.mjs";

const destination = join(root, "artifacts/workpilot-p02-2026-10-02");
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
  "WorkPilot P02 开发预览\r\n\r\n双击 WorkPilot.exe。请保留旁边的 workpilot-engine.exe。\r\n点击左下方“模型服务”，可配置三类接口、保存密钥并进行连接测试。\r\n需自行明确配置真实服务；当前协议样本验证通过，真实服务验收待完成。此为开发预览，不是正式安装版。\r\n点击关闭只隐藏到托盘；选择“彻底退出”才会结束程序。\r\n\r\n更多说明见交付目录 README.md 与 docs/development/P02-验证记录.md。\r\n",
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
  phase: "P02",
  createdAt: new Date().toISOString(),
  platform: process.platform,
  baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  workingTree: "Uncommitted implementation. Existing user changes are preserved.",
  versions: { protocol: "workpilot.v1", schema: 2, eventExport: 1 },
  binaries: fingerprints,
  sourceFiles: sources,
};
await writeFile(
  join(destination, "source-and-binary-manifest.json"),
  JSON.stringify(manifest, null, 2),
);
console.log(
  JSON.stringify(
    { phase: "P02", binaries: fingerprints, sourceFileCount: sources.length },
    null,
    2,
  ),
);
