import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, cp, readdir, lstat } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { root, run } from "./cargo.mjs";
const folder = join(root, "services/documents");
const font = {
  file: "fonts/NotoSansCJKsc-Regular.otf",
  url: "https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf",
  sha256: "2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b",
};
const digest = (b) => createHash("sha256").update(b).digest("hex");
if (!existsSync(join(folder, "node_modules/docx/package.json")))
  await run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["ci", "--ignore-scripts", "--no-fund", "--no-audit"],
    { cwd: folder, shell: process.platform === "win32" },
  );
await mkdir(join(folder, "fonts"), { recursive: true });
if (!existsSync(join(folder, font.file))) {
  const response = await fetch(font.url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error("Font download failed: " + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (digest(bytes) !== font.sha256) throw new Error("Font download verification failed");
  await writeFile(join(folder, font.file), bytes);
}
if (digest(await readFile(join(folder, font.file))) !== font.sha256)
  throw new Error("Document font verification failed");
if (process.argv[2]) {
  const destination = resolve(root, process.argv[2]);
  const within = relative(root, destination);
  if (!within || within.startsWith("..") || !/[\\/]/.test(within))
    throw new Error("Runtime destination must be a child folder inside the workspace");
  await mkdir(destination, { recursive: true });
  for (const name of [
    "worker.mjs",
    "write.mjs",
    "package.json",
    "package-lock.json",
    "fonts",
    "node_modules",
  ]) {
    await cp(join(folder, name), join(destination, name), {
      recursive: true,
      force: true,
      filter: async (source, target) => {
        const info = await lstat(source);
        if (!info.isFile()) return true;
        try {
          const existing = await lstat(target);
          if (existing.isFile() && existing.size === info.size) {
            return digest(await readFile(source)) !== digest(await readFile(target));
          }
        } catch {}
        return true;
      },
    });
  }
  const files = [];
  async function inventory(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) await inventory(file);
      else if (entry.isFile()) {
        const bytes = await readFile(file);
        files.push({
          path: relative(destination, file).replaceAll("\\", "/"),
          bytes: bytes.length,
          sha256: digest(bytes),
        });
      }
    }
  }
  await inventory(destination);
  await writeFile(
    join(destination, "runtime-manifest.json"),
    JSON.stringify(
      {
        source: "WorkPilot document worker; npm package-lock; Noto Sans CJK SC 2.004",
        font,
        files: files
          .filter((f) => f.path !== "runtime-manifest.json")
          .sort((a, b) => a.path.localeCompare(b.path)),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ runtime: within, files: files.length, fontVerified: true }));
} else console.log("Document dependencies and font are ready.");
