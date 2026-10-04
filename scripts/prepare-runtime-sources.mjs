import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, writeFile, mkdir, rename, stat, lstat, readdir } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { join, relative, resolve } from "node:path";
import { root, run } from "./cargo.mjs";

if (process.platform !== "win32")
  throw new Error("This asset selection is for Windows x64; other platforms are not packaged yet.");
const cache = join(root, ".local/p12-runtime-downloads"),
  sources = JSON.parse(await readFile(join(root, "resources/runtimes/windows-x64.json"), "utf8"));
const digest = (b) => createHash("sha256").update(b).digest("hex");
await mkdir(cache, { recursive: true });
export async function inventory(folder) {
  const files = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const p = join(path, entry.name),
        s = await lstat(p);
      if (s.isSymbolicLink()) throw new Error("Runtime contains a link: " + p);
      if (s.isDirectory()) await visit(p);
      else if (s.isFile()) {
        const bytes = await readFile(p);
        files.push({
          path: relative(folder, p).replaceAll("\\", "/"),
          bytes: bytes.length,
          sha256: digest(bytes),
        });
      } else throw new Error("Unsupported runtime entry");
    }
  }
  await visit(folder);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
const receipts = [];
for (const asset of sources.assets) {
  if (asset.distribution?.startsWith("blocked-") && !process.argv.includes("--research-browser")) {
    console.log(JSON.stringify({ id: asset.id, skipped: asset.distribution }));
    continue;
  }
  const archive = join(cache, asset.file),
    record = join(cache, asset.id + "-extracted.json");
  try {
    await stat(archive);
  } catch {
    const r = await fetch(asset.url, { signal: AbortSignal.timeout(300000) });
    if (!r.ok || !r.body) throw new Error(asset.id + " download failed: " + r.status);
    const part = archive + "." + randomUUID() + ".partial";
    await pipeline(r.body, createWriteStream(part, { flags: "wx" }));
    const bytes = await readFile(part);
    if (bytes.length !== asset.bytes || digest(bytes) !== asset.sha256)
      throw new Error(asset.id + " archive verification failed");
    await rename(part, archive);
  }
  const bytes = await readFile(archive);
  if (bytes.length !== asset.bytes || digest(bytes) !== asset.sha256)
    throw new Error(asset.id + " archive verification failed");
  let saved;
  try {
    saved = JSON.parse(await readFile(record, "utf8"));
    if (saved.sha256 !== asset.sha256 || !resolve(saved.directory).startsWith(cache + "\\"))
      throw new Error("Stale runtime cache");
    const files = await inventory(saved.directory);
    if (JSON.stringify(files) !== JSON.stringify(saved.files))
      throw new Error("Runtime cache changed");
  } catch {
    saved = null;
  }
  if (!saved) {
    const directory = join(cache, asset.id + "-" + randomUUID());
    await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-File",
      join(root, "scripts/extract-runtime.ps1"),
      "-Archive",
      archive,
      "-Destination",
      directory,
    ]);
    saved = { ...asset, directory, files: await inventory(directory) };
    await writeFile(record, JSON.stringify(saved, null, 2) + "\n");
  }
  receipts.push(saved);
  console.log(
    JSON.stringify({
      id: asset.id,
      version: asset.version,
      files: saved.files.length,
      bytes: saved.files.reduce((n, f) => n + f.bytes, 0),
    }),
  );
}
await writeFile(join(cache, "prepared.json"), JSON.stringify(receipts, null, 2) + "\n");
if (receipts.some((asset) => asset.id === "chromium" && !asset.distribution))
  await run(process.execPath, [join(root, "scripts/capture-runtime-credits.mjs")]);
await run(process.execPath, [join(root, "scripts/prepare-git-sandbox.mjs")]);
