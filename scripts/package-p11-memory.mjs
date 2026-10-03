import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { root } from "./cargo.mjs";

const destination = join(root, "artifacts/workpilot-p11-memory-2026-10-03");
const previous = join(root, "artifacts/workpilot-p10-layout-2026-10-03");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const build = JSON.parse(await readFile(join(root, ".local/desktop-release-receipt.json"), "utf8"));
const old = JSON.parse(await readFile(join(previous, "source-and-binary-manifest.json"), "utf8"));
const files = [];
function checked(base, path) {
  const result = resolve(base, path),
    rel = relative(base, result);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error("Package path escapes: " + path);
  return result;
}
async function copy(source, path, expected) {
  const bytes = await readFile(source),
    sha256 = digest(bytes);
  if (expected && sha256 !== expected)
    throw new Error("Source or previous delivery changed: " + path);
  const target = checked(destination, path);
  await mkdir(dirname(target), { recursive: true });
  let same = false;
  try {
    same = digest(await readFile(target)) === sha256;
  } catch {}
  if (!same) await copyFile(source, target);
  files.push({ path, bytes: bytes.length, sha256 });
}
await copy(
  join(root, "target/release/workpilot-desktop.exe"),
  "preview/WorkPilot.exe",
  build.desktop,
);
await copy(
  join(root, "target/release/workpilot-engine.exe"),
  "preview/workpilot-sidecar.exe",
  build.engine,
);
// Runtime components and licenses are unchanged in this slice. Verify their old
// manifest before copying; never mutate or relabel a previous delivery.
const resources = old.binaries.filter(
  (f) =>
    !f.path.startsWith("tools/") &&
    !["preview/WorkPilot.exe", "preview/workpilot-sidecar.exe", "preview/使用说明.txt"].includes(
      f.path,
    ),
);
let next = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (next < resources.length) {
      const f = resources[next++];
      await copy(checked(previous, f.path), f.path, f.sha256);
    }
  }),
);
const instructions =
  "WorkPilot P11 记忆开发预览\r\n\r\n先从旧版托盘彻底退出，再双击 WorkPilot.exe。请保留整个 preview 文件夹。\r\n顶部‘记忆’可以添加、确认、搜索、修改、删除、查看来源、撤销和导出。AI 只能提出候选，确认后下次模型调用才开始使用。\r\n选择项目时会包含通用记忆，其他项目的记忆不会交给当前任务。勾选‘显示已删除’可从历史恢复。删除不会擦除历史对话、旧记录和备份。\r\n旧版办公预览、浏览器与文档运行环境原样随包保留。本轮新增的是记忆，定时任务还在 P11 后续工作中，尚未实现。\r\n本版自动备份后将数据从版本 9 升到 10。旧程序不能打开升级后的数据；旧交付文件仍保留。\r\n这是 Windows 开发机预览，不是已验收的正式 V1。真实模型的记忆质量、跨平台和用户体验仍待检查。\r\n";
await writeFile(join(destination, "preview/使用说明.txt"), instructions);
files.push({
  path: "preview/使用说明.txt",
  bytes: Buffer.byteLength(instructions),
  sha256: digest(Buffer.from(instructions)),
});
if (process.argv.includes("--preview-only")) {
  console.log("P11 memory preview staged; previous runtime manifests verified.");
  process.exit(0);
}
const sourcePaths = execFileSync("rg", ["--files", "--hidden", "-g", "!.git", "-g", "!artifacts"], {
  cwd: root,
  encoding: "utf8",
})
  .trim()
  .split(/\r?\n/)
  .map((p) => p.replaceAll("\\", "/"))
  .sort();
const sourceFiles = [];
for (const path of sourcePaths) {
  const bytes = await readFile(join(root, path));
  sourceFiles.push({ path, bytes: bytes.length, sha256: digest(bytes) });
}
await writeFile(
  join(destination, "source-and-binary-manifest.json"),
  JSON.stringify(
    {
      phase: "P11-memory",
      build,
      createdAt: new Date().toISOString(),
      platform: process.platform,
      baseCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      workingTree:
        "P11 first implementation slice: confirmed memories. Local schedules remain pending. No new commit or push.",
      versions: {
        protocol: "workpilot.v1",
        schema: 10,
        memoryExport: 1,
        node: process.versions.node,
      },
      previousManifest: {
        path: relative(root, join(previous, "source-and-binary-manifest.json")),
        sha256: digest(await readFile(join(previous, "source-and-binary-manifest.json"))),
      },
      binaries: files.sort((a, b) => a.path.localeCompare(b.path)),
      sourceFiles,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify(
    { phase: "P11-memory", deliveryFiles: files.length, sourceFiles: sourceFiles.length },
    null,
    2,
  ),
);
