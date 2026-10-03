import { copyFile, mkdir, readFile, writeFile, readdir, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, dirname, relative, resolve, isAbsolute } from "node:path";
import { root } from "./cargo.mjs";

export const destination = join(root, "artifacts/workpilot-p12-settings-2026-10-04");
const preview = join(destination, "preview");
const previous = join(root, "artifacts/workpilot-p12-history-2026-10-04");
const hash = (b) => createHash("sha256").update(b).digest("hex");
const build = JSON.parse(await readFile(join(root, ".local/desktop-release-receipt.json"), "utf8"));
const sources = JSON.parse(
  await readFile(join(root, "resources/runtimes/windows-x64.json"), "utf8"),
);
const prepared = JSON.parse(
  await readFile(join(root, ".local/p12-runtime-downloads/prepared.json"), "utf8"),
);
const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
if (build.appVersion !== version)
  throw new Error("Run npm run build for the current app version before packaging");
function checked(base, path) {
  const p = resolve(base, path),
    rel = relative(base, p);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unsafe package path");
  return p;
}
const files = new Map();
if (!build.browserSetup || !build.companion || !build.runtimeCheck)
  throw new Error("Build the current companion/setup tools before packaging");
async function copy(source, path, expected) {
  const bytes = await readFile(source),
    sha256 = hash(bytes);
  if (expected && expected !== sha256)
    throw new Error("Package input differs from receipt: " + path);
  const target = checked(preview, path);
  await mkdir(dirname(target), { recursive: true });
  let same = false;
  try {
    same = hash(await readFile(target)) === sha256;
  } catch {}
  if (!same) await copyFile(source, target);
  files.set(path, { path, bytes: bytes.length, sha256 });
}
async function text(path, content) {
  const p = checked(preview, path);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, content);
  files.set(path, { path, bytes: Buffer.byteLength(content), sha256: hash(Buffer.from(content)) });
}
await copy(
  join(root, "target/release/workpilot-desktop.exe"),
  "workpilot-desktop.exe",
  build.desktop,
);
await copy(
  join(root, "target/release/workpilot-engine.exe"),
  "workpilot-sidecar.exe",
  build.engine,
);
await copy(
  join(root, "target/release/workpilot-browser-setup.exe"),
  "workpilot-browser-setup.exe",
  build.browserSetup,
);
await copy(
  join(root, "target/release/workpilot-runtime-check.exe"),
  "workpilot-runtime-check.exe",
  build.runtimeCheck,
);
// Build from current prepared outputs, never require an ignored historical binary package.
for (const runtime of ["office-runtime", "document-runtime"]) {
  const base = join(root, "target/release", runtime);
  const manifest = JSON.parse(await readFile(join(base, "runtime-manifest.json"), "utf8"));
  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < manifest.files.length) {
        const f = manifest.files[next++];
        await copy(checked(base, f.path), runtime + "/" + f.path, f.sha256);
      }
    }),
  );
  await copy(join(base, "runtime-manifest.json"), runtime + "/runtime-manifest.json");
}
for (const id of ["node", "python", "git"]) {
  const asset = sources.assets.find((a) => a.id === id),
    receipt = prepared.find((a) => a.id === id);
  if (!asset || asset.distribution || receipt?.sha256 !== asset.sha256)
    throw new Error("Unapproved runtime " + id);
  const cache = join(root, ".local/p12-runtime-downloads");
  checked(cache, relative(cache, receipt.directory));
  const archive = await readFile(join(cache, asset.file));
  if (archive.length !== asset.bytes || hash(archive) !== asset.sha256)
    throw new Error("Runtime archive changed");
  for (const f of receipt.files) {
    if (id === "node" && ![asset.entry, "node-v22.23.2-win-x64/LICENSE"].includes(f.path)) continue;
    const path =
      id === "node"
        ? "browser-runtime/" + (f.path.endsWith("/LICENSE") ? "NODE_LICENSE.txt" : "node.exe")
        : id + "-runtime/" + f.path;
    await copy(checked(receipt.directory, f.path), path, f.sha256);
  }
}
// Refresh app-owned helpers, scripts and inventories from the current release build.
await copy(
  join(root, "target/release/companion.exe"),
  "browser-companion/companion.exe",
  build.companion,
);
await copy(
  join(root, "services/browser/driver.mjs"),
  "browser-runtime/services/browser/driver.mjs",
);
await copy(
  join(root, "extensions/companion/cdp-actions.js"),
  "browser-runtime/extensions/companion/cdp-actions.js",
);
await text(
  "browser-runtime/package.json",
  JSON.stringify({ private: true, type: "module" }, null, 2) + "\n",
);
await copy(
  join(root, "scripts/install-packaged-browser-companion.ps1"),
  "browser-companion/register.ps1",
);
for (const name of await readdir(join(root, "extensions/companion"))) {
  const path = join(root, "extensions/companion", name);
  if (!(await lstat(path)).isFile()) throw new Error("Unexpected companion source entry");
  await copy(path, "browser-companion/extension/" + name);
}
for (const browser of ["chrome", "edge"])
  await text(
    "browser-companion/register-" + browser + ".cmd",
    '@echo off\r\npowershell -NoProfile -File "%~dp0register.ps1" -Browser ' +
      browser +
      "\r\npause\r\n",
  );
await text(
  "使用说明.txt",
  "WorkPilot P12 项目设置迁移开发预览\r\n\r\n运行 workpilot-desktop.exe，请保留整个 preview 文件夹。\r\n设置 → 项目设置与记忆迁移：选择项目、模型和记忆导出；在目标文件夹预览后导入为新项目，模型密钥需重填。\r\n文件与终端 → 修改历史 → 备份与导入文件历史：选择版本、设置口令并导出；在目标项目先预览，再确认导入。导入不会修改当前项目文件，恢复继续遵守原审批流程。请单独保管口令。\r\n本批提供可直接运行的预览程序，上一级说明列出历史交付入口。\r\n设置 → 环境检查与诊断：快速检查、完整核验、导出本机报告。\r\n随包包含 Node、Python 标准库、MinGit、文档工具与 Office 预览环境；不会修改全局 PATH。Python 不含 pip 和任意第三方依赖，MinGit 不含 Git Bash。\r\n浏览器仍需已有 Chrome 或 Edge；Chromium 候选版本因缺少完整第三方许可暂未随包分发。\r\n本版数据仍为版本 11；旧 P11 数据不需要迁移。\r\n关闭窗口保留后台任务，托盘‘退出’才彻底停止。\r\n这是未签名的 Windows 私有开发预览，不是正式 V1。升级、完整数据迁移、干净系统和跨平台验收仍未完成。\r\n",
);
await text(
  "RUNTIME-SOURCES.json",
  JSON.stringify(
    {
      version,
      platform: sources.target,
      assets: sources.assets.filter((a) => !a.distribution),
      excluded: sources.assets.filter((a) => a.distribution),
      updatePolicy:
        "Application-local versions are pinned. Updating requires a rebuilt verified package; no runtime silently self-updates.",
      licenseLocations: [
        "browser-runtime/NODE_LICENSE.txt",
        "python-runtime/LICENSE.txt",
        "git-runtime/LICENSE.txt",
        "git-runtime/ucrt64/share/licenses",
        "office-runtime/office/LICENSE.html",
        "document-runtime/node_modules",
        "document-runtime/fonts/OFL.txt",
      ],
      releaseBoundary:
        "Private development preview. Public redistribution and signing are not approved by this asset receipt.",
    },
    null,
    2,
  ) + "\n",
);
const metadata = {
  application: {
    version,
    source: "WorkPilot source workspace",
    license: "Private WorkPilot development preview",
  },
  node: sources.assets.find((a) => a.id === "node"),
  python: sources.assets.find((a) => a.id === "python"),
  git: sources.assets.find((a) => a.id === "git"),
  documents: {
    version: "P10-locked",
    source: "services/documents/package-lock.json; Noto Sans CJK SC 2.004",
    license: "Bundled npm package licenses; font OFL-1.1",
  },
  office: {
    version: "26.8.0",
    source: "https://github.com/LibreOffice/core/tree/bce0998afefdbc355585ca324285661a2170ba77",
    license: "MPL-2.0 and bundled LICENSE.html, NOTICE and component licenses",
  },
  companion: {
    version,
    source: "WorkPilot extensions/companion and browser-bridge",
    license: "Private WorkPilot development preview",
  },
};
const group = (path) =>
  path.startsWith("browser-runtime/")
    ? "node"
    : path.startsWith("python-runtime/")
      ? "python"
      : path.startsWith("git-runtime/")
        ? "git"
        : path.startsWith("document-runtime/")
          ? "documents"
          : path.startsWith("office-runtime/")
            ? "office"
            : path.startsWith("browser-companion/")
              ? "companion"
              : "application";
const catalog = {
  schema_version: 1,
  target: sources.target,
  notices: [
    "此预览未包含专用浏览器，浏览器操作仍需要本机 Chrome 或 Edge / This preview requires an installed Chrome or Edge browser.",
    "Python 仅含标准库，MinGit 不含 Git Bash；其他插件依赖需单独核对 / Python includes its standard library; MinGit does not include Git Bash. Additional plugin dependencies are separate.",
    "Git 的通用命令在 Windows 受限模式下存在目录兼容问题；不会自动提高权限。文件工作区的 Git 操作保留原审批流程 / Generic Git commands have a directory compatibility limitation in Windows restricted mode. Permissions are never automatically broadened; workbench Git keeps its existing approval route.",
  ],
  components: Object.entries(metadata).map(([id, m]) => ({
    id,
    version: m.version,
    source: m.source,
    license: m.license,
    files: [...files.values()]
      .filter((f) => group(f.path) === id)
      .sort((a, b) => a.path.localeCompare(b.path)),
  })),
};
await text("runtime-catalog.json", JSON.stringify(catalog, null, 2) + "\n");
// Fail if an old test file or unknown resource would accidentally enter an installer.
async function audit(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, e.name),
      info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("Linked package entry");
    if (info.isDirectory()) await audit(path);
    else if (!info.isFile() || !files.has(relative(preview, path).replaceAll("\\", "/")))
      throw new Error("Unlisted package entry: " + e.name);
  }
}
await audit(preview);
const resources = {};
for (const f of [...files.values()].sort((a, b) => a.path.localeCompare(b.path)))
  if (!["workpilot-desktop.exe", "workpilot-sidecar.exe"].includes(f.path))
    resources[join(preview, f.path).replaceAll("\\", "/")] = f.path;
await mkdir(join(root, ".local"), { recursive: true });
await writeFile(
  join(root, ".local/p12-bundle.json"),
  JSON.stringify(
    {
      bundle: {
        resources,
        windows: {
          nsis: {
            compression: "zlib",
            template: join(root, "resources/windows/installer.nsi").replaceAll("\\", "/"),
            installerHooks: join(root, "resources/windows/browser-companion-hooks.nsh").replaceAll(
              "\\",
              "/",
            ),
          },
        },
      },
    },
    null,
    2,
  ) + "\n",
);
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
  const b = await readFile(join(root, path));
  sourceFiles.push({ path, bytes: b.length, sha256: hash(b) });
}
await writeFile(
  join(destination, "source-and-binary-manifest.json"),
  JSON.stringify(
    {
      phase: "P12-settings-slice",
      at: new Date().toISOString(),
      build,
      baseCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      versions: { app: version, schema: 11, protocol: "workpilot.v1" },
      limitations: [
        "No bundled Chromium: component licenses missing",
        "No clean-machine or macOS/Linux verification",
        "Signed updates and full data migration not implemented",
      ],
      previousManifest: {
        path: relative(root, join(previous, "source-and-binary-manifest.json")).replaceAll(
          "\\",
          "/",
        ),
        sha256: hash(await readFile(join(previous, "source-and-binary-manifest.json"))),
      },
      binaries: [...files.values()]
        .map((f) => ({ ...f, path: "preview/" + f.path }))
        .sort((a, b) => a.path.localeCompare(b.path)),
      sourceFiles,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    phase: "P12",
    files: files.size,
    bytes: [...files.values()].reduce((n, f) => n + f.bytes, 0),
    components: catalog.components.length,
  }),
);
