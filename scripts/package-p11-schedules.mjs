import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { root } from "./cargo.mjs";

const destination = join(root, "artifacts/workpilot-p11-schedules-2026-10-03");
const previous = join(root, "artifacts/workpilot-p11-memory-2026-10-03");
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
  "WorkPilot P11 记忆与定时任务开发预览\r\n\r\n先从旧版托盘彻底退出，再双击 WorkPilot.exe。请保留整个 preview 文件夹。\r\n顶部‘定时任务’支持新建、编辑、启停、立即运行与查看历史。可选择一次、按分钟间隔、每天或每周，以及项目、目标、模型、三档权限和时区。\r\n每次运行生成独立任务；需要审批会等待你。同一计划不重叠，错过只记入历史、不自动补跑。\r\n隐藏窗口后仍执行。彻底退出后停止；重新打开不会自动恢复中断任务。模型或项目配置改动后需要重新保存计划。\r\n顶部‘记忆’保留候选确认、范围管理、历史撤销和导出；旧版办公预览、浏览器与文档运行环境随包保留。\r\n本版自动备份后将旧数据升级到版本 11。旧程序不能打开升级后的数据；旧交付文件仍保留。\r\n这是 Windows 开发机预览，不是已验收的正式 V1。实际电脑睡眠唤醒、真实模型的记忆质量、跨平台和用户体验仍待检查。\r\n";
await writeFile(join(destination, "preview/使用说明.txt"), instructions);
files.push({
  path: "preview/使用说明.txt",
  bytes: Buffer.byteLength(instructions),
  sha256: digest(Buffer.from(instructions)),
});
if (process.argv.includes("--preview-only")) {
  console.log("P11 schedules preview staged; previous runtime manifests verified.");
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
      phase: "P11-schedules",
      build,
      createdAt: new Date().toISOString(),
      platform: process.platform,
      baseCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      workingTree:
        "P11 local schedules with confirmed memories. Real OS sleep and user experience remain pending. No new commit or push.",
      versions: {
        protocol: "workpilot.v1",
        schema: 11,
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
    { phase: "P11-schedules", deliveryFiles: files.length, sourceFiles: sourceFiles.length },
    null,
    2,
  ),
);
