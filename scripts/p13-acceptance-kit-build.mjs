import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve, dirname, relative, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { root } from "./cargo.mjs";
const release = resolve(
  process.env.WORKPILOT_KIT_RELEASE ||
    join(root, "artifacts/workpilot-p13-candidate-2026-10-04-r3"),
);
const bundle = join(release, "preview"),
  destination = join(release, "tools/acceptance-kit");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
await mkdir(destination, { recursive: true });
const manifest = {
  format: "workpilot.acceptance-kit",
  version: 1,
  builtAt: new Date().toISOString(),
  scope:
    "Portable Windows acceptance helper. No credentials/database distributed. Local kit self-test does not verify clean OS or physical migration.",
  installationFiles: [],
  files: [],
};
for (const path of [
  "workpilot-desktop.exe",
  "workpilot-sidecar.exe",
  "browser-runtime/node.exe",
  "runtime-catalog.json",
]) {
  const bytes = await readFile(join(bundle, path));
  manifest.installationFiles.push({ path, bytes: bytes.length, sha256: sha(bytes) });
}
const copied = new Set();
async function portableCopy(path) {
  const name = relative(root, path).replaceAll("\\", "/");
  assert(
    !name.startsWith("../") && !isAbsolute(name),
    "Only repository test support can enter the kit",
  );
  if (copied.has(name)) return;
  copied.add(name);
  const data = await readFile(path),
    text = data.toString("utf8");
  assert(
    text.split(/\r?\n/).length <= 1000,
    "Portable source exceeds 1000 physical lines: " + name,
  );
  const target = join(destination, name);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
  manifest.files.push({ path: name, bytes: data.length, sha256: sha(data) });
  if (path.endsWith(".mjs")) {
    execFileSync(process.execPath, ["--check", target], { windowsHide: true });
    const imports = [...text.matchAll(/(?:from\s*|import\s*\()(["'])(\.[^"']+)\1/g)].map(
      (match) => match[2],
    );
    for (const source of imports) await portableCopy(resolve(dirname(path), source));
  }
}
await portableCopy(join(root, "scripts/p13-acceptance-kit-runner.mjs"));
await portableCopy(join(root, "scripts/p13-process-identities.ps1"));
const writeAsset = async (path, bytes) => {
  bytes = Buffer.from(bytes);
  await writeFile(join(destination, path), bytes);
  manifest.files.push({ path, bytes: bytes.length, sha256: sha(bytes) });
};
await writeAsset(
  "Start-Acceptance.ps1",
  Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    await readFile(join(root, "scripts/p13-acceptance-kit.ps1")),
  ]),
);
await writeAsset(
  "运行验收.cmd",
  '@echo off\r\nsetlocal\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Acceptance.ps1"\r\nif errorlevel 1 pause\r\nendlocal\r\n',
);
await writeAsset(
  "使用说明.md",
  `# WorkPilot Windows 便携验收工具包

先正常安装与本工具包配套的 WorkPilot，再双击 **运行验收.cmd**，选择包含 workpilot-desktop.exe 的安装目录。工具包会先核对版本校验值。

- 无需安装 Node.js、Python、Git、Rust 或运行 npm，也无需模型密钥。
- 只用软件自带的组件，在新建的测试资料目录中运行。不会导入你的原有任务、密钥或数据库。
- 检查完整组件、受限 Python/Node/Git、三种不可达模型地址、专用浏览器、Word/Excel/PPT 生成和原版式预览。
- 结束后打开中文结果说明，同一目录保留原始报告、校验值、截图和日志。没有自动上传步骤。
- 不改系统 PATH、网络、电源或浏览器注册；仅测试进程的 PATH 被限制为 Windows 系统目录。

这份自动结果不能单独证明“干净系统”“物理换机”“整机断网”或“桌面体验”已验收。这些条件需要操作人在真实环境里另外确认。

结果默认位于当前用户的 LocalAppData/WorkPilotAcceptance 新文件夹；可以从最后显示的路径打开。
项目开发机运行必须带 -SelfTest，报告会明确写作“工具包自检”。本工具包不含既有数据库、密钥或模型调用凭据。
`,
);
await writeFile(join(destination, "kit-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(
  JSON.stringify(
    {
      destination,
      files: manifest.files.length,
      installationFiles: manifest.installationFiles,
      status: "built_not_run",
    },
    null,
    2,
  ),
);
