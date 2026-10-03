import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { cargo, cargoBin, root, run, rustEnv } from "./cargo.mjs";

const mode = process.argv[2] || "dev";
if (!["dev", "build"].includes(mode)) throw new Error("Use dev or build");
const release = mode === "build";
const appVersion = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
await run(cargo, [
  "build",
  "-p",
  "workpilot-engine",
  "--bin",
  "workpilot-engine",
  "--locked",
  ...(release ? ["--release"] : []),
]);
const rustc = join(cargoBin, process.platform === "win32" ? "rustc.exe" : "rustc");
const target = execFileSync(rustc, ["-vV"], { env: rustEnv(), encoding: "utf8" })
  .match(/^host: (.+)$/m)?.[1]
  .trim();
if (!target) throw new Error("Cannot identify the Rust host target");
const extension = process.platform === "win32" ? ".exe" : "";
const buildRoot = process.env.CARGO_TARGET_DIR
  ? resolve(root, process.env.CARGO_TARGET_DIR)
  : join(root, "target");
if (process.platform === "win32")
  await run(process.execPath, [
    join(root, "scripts/prepare-office.mjs"),
    join(buildRoot, release ? "release" : "debug", "office-runtime"),
    ...(release ? ["--release"] : []),
  ]);
await run(process.execPath, [
  join(root, "scripts/prepare-documents.mjs"),
  join(buildRoot, release ? "release" : "debug", "document-runtime"),
]);
const binaryDir = join(root, "apps/desktop/src-tauri/binaries");
await mkdir(binaryDir, { recursive: true });
await copyFile(
  join(buildRoot, release ? "release" : "debug", "workpilot-engine" + extension),
  join(binaryDir, "workpilot-sidecar-" + target + extension),
);
const cli = join(root, "node_modules/@tauri-apps/cli/tauri.js");
await run(process.execPath, [cli, mode, ...(release ? ["--no-bundle"] : [])], {
  cwd: join(root, "apps/desktop"),
});
if (release) {
  const hash = async (path) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  await mkdir(join(root, ".local"), { recursive: true });
  await writeFile(
    join(root, ".local/desktop-release-receipt.json"),
    JSON.stringify(
      {
        command: "npm run build (Tauri build --no-bundle)",
        appVersion,
        at: new Date().toISOString(),
        platform: process.platform,
        desktop: await hash(join(buildRoot, "release/workpilot-desktop" + extension)),
        engine: await hash(join(buildRoot, "release/workpilot-engine" + extension)),
      },
      null,
      2,
    ) + "\n",
  );
}
