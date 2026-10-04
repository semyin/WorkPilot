import { copyFile, mkdir, readFile, writeFile, readdir, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, dirname, relative, resolve, isAbsolute } from "node:path";
import { root } from "./cargo.mjs";

export const destination = join(root, "artifacts/workpilot-p12-complete-2026-10-04");
const preview = join(destination, "preview");
const previous = join(root, "artifacts/workpilot-p12-history-restore-2026-10-04");
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
if (!build.browserSetup || !build.companion || !build.runtimeCheck || !build.updateHelper)
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
await copy(
  join(root, "target/release/workpilot-update.exe"),
  "workpilot-update.exe",
  build.updateHelper,
);
await copy(join(root, "resources/update/trust.json"), "workpilot-update-trust.json");
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
for (const id of ["node", "python", "git", "chromium"]) {
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
        : id === "chromium"
          ? "chromium-runtime/" + relative(dirname(asset.entry), f.path).replaceAll("\\", "/")
          : id + "-runtime/" + f.path;
    await copy(checked(receipt.directory, f.path), path, f.sha256);
  }
}
const browserNotices = JSON.parse(
  await readFile(join(root, ".local/p12-runtime-downloads/chromium-notices.json"), "utf8"),
);
if (
  browserNotices.status !== "passed" ||
  browserNotices.sample ||
  browserNotices.archiveSha256 !==
    sources.assets.find((asset) => asset.id === "chromium")?.sha256 ||
  !browserNotices.files.some((file) => file.path === "CREDITS.html" && file.bytes > 100000)
)
  throw new Error("Bundled Chromium needs a verified complete component license receipt");
checked(
  join(root, ".local/p12-runtime-downloads"),
  relative(join(root, ".local/p12-runtime-downloads"), browserNotices.directory),
);
for (const file of browserNotices.files)
  await copy(
    checked(browserNotices.directory, file.path),
    "chromium-runtime/" + file.path,
    file.sha256,
  );
const gitCompatible = JSON.parse(
  await readFile(join(root, ".local/p12-runtime-downloads/git-sandbox-prepared.json"), "utf8"),
);
const gitSources = JSON.parse(
  await readFile(join(root, "resources/git-sandbox/sources.json"), "utf8"),
);
const gitInputHash = hash(
  Buffer.concat(
    await Promise.all(gitSources.buildInputs.map((path) => readFile(checked(root, path)))),
  ),
);
if (
  gitCompatible.inputHash !== gitInputHash ||
  gitCompatible.version !== gitSources.version ||
  !gitCompatible.files.some((file) => file.path === "bin/git.exe") ||
  !gitSources.assets.every((asset) =>
    gitCompatible.files.some(
      (file) =>
        file.path === "source/" + asset.file &&
        file.sha256 === asset.sha256 &&
        file.bytes === asset.bytes,
    ),
  )
)
  throw new Error(
    "Build the current sandboxed Git and preserve its corresponding source before packaging",
  );
checked(
  join(root, ".local/p12-runtime-downloads"),
  relative(join(root, ".local/p12-runtime-downloads"), gitCompatible.directory),
);
for (const file of gitCompatible.files)
  await copy(
    checked(gitCompatible.directory, file.path),
    "git-runtime/sandbox/" + file.path,
    file.sha256,
  );
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
  join(root, "services/browser/executable.mjs"),
  "browser-runtime/services/browser/executable.mjs",
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
  "WorkPilot P12 整合开发预览\r\n运行 workpilot-desktop.exe，请保留整个 preview 文件夹。\r\n设置 → 完整资料迁移：选择项目、任务与助手、模型配置、记忆、扩展和当前文件，保存为一份口令加密包；目标逐项映射位置，先预览冲突，再确认导入。模型密钥重新填写，扩展保持停用，当前文件独立审批。未决操作需要用户逐项核对，不能用旧审批重放；恢复后手动继续。\r\n设置 → 数据清理与恢复初始状态：可回收未引用内容、按保留数量和天数备份清理文件版本、删除归档任务组/只读档案，或清空当前数据目录和已登记凭据。所有操作先预览范围并输入确认文字；版本清理先生成并解密核验备份。项目原文件保留，处理完成后重新启动软件。\r\n技能与插件 → 技能与插件迁移：可包含当前与旧版本、已卸载扩展和未安装草稿；导入保持停用并重新核对权限和依赖。原各类独立备份/导入入口继续保留。\r\n设置 → 软件更新：输入受控 HTTPS 更新源或选择签名更新包，检查版本与影响，准备后由用户确认安装。更新先停止任务、备份数据并在副本验证迁移，失败恢复原应用与数据；不自动升级第三方插件。发布签名与 Windows 安装器代码签名是两件事，本预览安装器仍未进行 Windows 代码签名。\r\n随包包含 Node、Python 标准库、专用 Chromium、MinGit、受限 Git 兼容程序、文档工具与 Office 预览环境，不修改全局 PATH。Python 不含 pip 和任意第三方依赖，MinGit 不含 Git Bash；第三方插件依其说明准备额外依赖。\r\n浏览器面板可启动随包专用浏览器；连接日常 Chrome/Edge 需要现有浏览器和用户主动授权。设置 → 环境检查与诊断可核验文件并主动导出本机报告，不自动上传。\r\n关闭窗口保留后台任务，托盘“退出”彻底停止。卸载默认保留资料；只有用户明确勾选才清理本机 WorkPilot 历史和凭据，静默卸载和更新卸载不清理数据。\r\n数据版本仍为 11。加密迁移包的口令请单独保管，系统密钥不随包迁移。\r\n这是 Windows 私有开发预览，尚未完成干净 Windows、物理换机和 macOS/Linux 实机验收；实际检查与待体验项见上一级 README 和 evidence。\r\n",
);
await text(
  "RUNTIME-SOURCES.json",
  JSON.stringify(
    {
      version,
      platform: sources.target,
      assets: sources.assets.filter((a) => !a.distribution),
      excluded: sources.assets.filter((a) => a.distribution),
      gitCompatibilityBuild: {
        version: gitSources.version,
        inputHash: gitInputHash,
        sourceAssets: gitSources.assets,
      },
      updatePolicy:
        "Application-local versions are pinned. Updating requires a rebuilt verified package; no runtime silently self-updates.",
      licenseLocations: [
        "chromium-runtime/CREDITS.html",
        "chromium-runtime/CHROMIUM_LICENSE.txt",
        "chromium-runtime/UNGOOGLED_LICENSE.txt",
        "browser-runtime/NODE_LICENSE.txt",
        "python-runtime/LICENSE.txt",
        "git-runtime/LICENSE.txt",
        "git-runtime/ucrt64/share/licenses",
        "git-runtime/sandbox/GIT_COPYING.txt",
        "git-runtime/sandbox/ZLIB_LICENSE.txt",
        "git-runtime/sandbox/source",
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
  git_compat: {
    version: gitSources.version,
    source:
      "Git for Windows 2.56.0.windows.1 + WorkPilot resources/git-sandbox; complete corresponding source is bundled",
    license: "GPL-2.0-only and Zlib; bundled GIT_COPYING.txt, ZLIB_LICENSE.txt and source archives",
  },
  chromium: sources.assets.find((a) => a.id === "chromium"),
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
  path.startsWith("chromium-runtime/")
    ? "chromium"
    : path.startsWith("browser-runtime/")
      ? "node"
      : path.startsWith("python-runtime/")
        ? "python"
        : path.startsWith("git-runtime/sandbox/")
          ? "git_compat"
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
    "专用浏览器随包提供，使用独立资料；连接日常 Chrome/Edge 仍由用户主动授权 / The bundled browser uses a dedicated profile. Connecting daily Chrome/Edge still requires user authorization.",
    "Python 仅含标准库，MinGit 不含 Git Bash；其他插件依赖需单独核对 / Python includes its standard library; MinGit does not include Git Bash. Additional plugin dependencies are separate.",
    "受限命令使用同版本源码构建的 Git 路径兼容版，保持项目边界与禁网；完全访问继续使用 MinGit / Restricted commands use source-built Git path compatibility inside the existing AppContainer. Full access keeps MinGit.",
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
      phase: "P12-complete",
      at: new Date().toISOString(),
      build,
      baseCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      versions: { app: version, schema: 11, protocol: "workpilot.v1" },
      limitations: [
        "No clean-machine or macOS/Linux verification",
        "Physical cross-machine and user experience acceptance pending; Windows installer has no Authenticode signature",
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
