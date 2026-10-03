import { copyFile, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { root, run } from "./cargo.mjs";
const destination = join(root, "artifacts/workpilot-p12-extensions-2026-10-04");
const started = Date.now();
await run(
  process.execPath,
  [
    join(root, "node_modules/@tauri-apps/cli/tauri.js"),
    "bundle",
    "--bundles",
    "nsis",
    "--config",
    join(root, ".local/p12-bundle.json"),
    "--ci",
    "--no-sign",
    "--no-binary-patching",
  ],
  { cwd: join(root, "apps/desktop") },
);
const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
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
      platform: "windows-x86_64",
      file: names[0],
      bytes: (await stat(path)).size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      command: "npm run bundle:installer",
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
