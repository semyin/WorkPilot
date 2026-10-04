import { copyFile, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { root, run } from "./cargo.mjs";
import { deliveryFor } from "./delivery-phase.mjs";
const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
const args = process.argv.slice(2);
const delivery = deliveryFor(root, args, version);
const { destination } = delivery;
const manifest = JSON.parse(
  await readFile(join(destination, "source-and-binary-manifest.json"), "utf8"),
);
const build = JSON.parse(await readFile(join(root, ".local/desktop-release-receipt.json"), "utf8"));
if (
  manifest.versions.app !== version ||
  build.appVersion !== version ||
  manifest.build.desktop !== build.desktop ||
  manifest.build.engine !== build.engine
)
  throw new Error("Build and package this exact version before bundling its installer");
const started = Date.now();
await run(
  process.execPath,
  [
    join(root, "node_modules/@tauri-apps/cli/tauri.js"),
    "bundle",
    "--bundles",
    "nsis",
    "--config",
    delivery.config,
    "--ci",
    "--no-sign",
    "--no-binary-patching",
  ],
  { cwd: join(root, "apps/desktop") },
);
const folder = join(root, "target/release/bundle/nsis");
const names = (await readdir(folder)).filter(
  (f) => f.startsWith("WorkPilot_" + version + "_") && f.endsWith("-setup.exe"),
);
if (names.length !== 1) throw new Error("Expected one current NSIS installer");
const path = join(folder, names[0]),
  bytes = await readFile(path);
const nsis = await readFile(join(root, "target/release/nsis/x64/installer.nsi"), "utf8");
const webviewPath = nsis.match(/^!define WEBVIEW2INSTALLERPATH "(.+)"/m)?.[1];
if (!webviewPath) throw new Error("Offline WebView2 asset was not included in the installer");
const webviewBytes = await readFile(webviewPath);
const webviewVersion = execFileSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "[Diagnostics.FileVersionInfo]::GetVersionInfo($env:WORKPILOT_WEBVIEW_ASSET).FileVersion",
  ],
  {
    windowsHide: true,
    encoding: "utf8",
    env: { ...process.env, WORKPILOT_WEBVIEW_ASSET: webviewPath },
  },
).trim();
await copyFile(path, join(destination, names[0]));
await writeFile(
  join(destination, "installer-manifest.json"),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      version,
      packagedBuild: {
        desktopSha256: build.desktop,
        engineSha256: build.engine,
        updaterSha256: build.updateHelper,
      },
      platform: "windows-x86_64",
      file: names[0],
      bytes: (await stat(path)).size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      command: "node scripts/installer-p12.mjs" + (args.length ? " " + args[0] : ""),
      signed: false,
      elapsedSeconds: (Date.now() - started) / 1000,
      compression: nsis.match(/^SetCompressor "(\w+)"/m)?.[1] || "unknown",
      dataBlockOptimization: !nsis.includes("SetDatablockOptimize off"),
      webview2: {
        source: "https://go.microsoft.com/fwlink/?linkid=2124701",
        installerFileVersion: webviewVersion,
        bytes: webviewBytes.length,
        sha256: createHash("sha256").update(webviewBytes).digest("hex"),
        license:
          "Microsoft WebView2 Runtime redistribution terms; unmodified upstream offline installer",
        installation:
          "Offline asset embedded; existing system WebView2 is reused. This does not prove installation on a WebView2-free OS.",
      },
      uninstall:
        "Only enumerated application files are removed. Project folders and WorkPilot local data are retained by default.",
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify({ installer: names[0], bytes: bytes.length }));
