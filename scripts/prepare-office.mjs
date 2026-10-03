import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { readFile, writeFile, mkdir, readdir, copyFile, rename } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { join, resolve, relative, dirname } from "node:path";
import { root, run, cargo } from "./cargo.mjs";
if (process.platform !== "win32") {
  console.log("Office renderer is currently verified on Windows only.");
  process.exit(0);
}
const release = process.argv.includes("--release");
const destination = resolve(
  root,
  process.argv.find((a, i) => i > 1 && !a.startsWith("--")) || "target/debug/office-runtime",
);
const within = relative(root, destination);
if (!within || within.startsWith("..") || !/[\\/]/.test(within))
  throw new Error("Office runtime must stay inside workspace");
const cache = join(root, ".local/p10-office-check");
const source = join(cache, "extracted");
const name = "LibreOffice_26.8.0_Win_x86-64.msi";
const installer = join(cache, name);
const url =
  "https://download.documentfoundation.org/libreoffice/stable/26.8.0/win/x86_64/" +
  name +
  "?download=1";
const sha256 = "4aa6c6e1895f4055104effcb556bd3362d20c6ad707c149543304f395ef9db95";
const buildId = "bce0998afefdbc355585ca324285661a2170ba77";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
await mkdir(cache, { recursive: true });
if (!existsSync(installer)) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok || !response.body) throw new Error("Office download failed: " + response.status);
  const part = installer + ".partial";
  await pipeline(response.body, createWriteStream(part));
  if (hash(await readFile(part)) !== sha256) throw new Error("Office installer hash mismatch");
  await rename(part, installer);
}
if (hash(await readFile(installer)) !== sha256) throw new Error("Office installer hash mismatch");
if (!existsSync(join(source, "program/version.ini"))) {
  await mkdir(source, { recursive: true });
  await run("msiexec.exe", ["/a", installer, "/qn", "TARGETDIR=" + source]);
}
if (!(await readFile(join(source, "program/version.ini"), "utf8")).includes("buildid=" + buildId))
  throw new Error("Unexpected Office runtime build");
await run(cargo, [
  "build",
  "-p",
  "workpilot-office",
  "--locked",
  ...(release ? ["--release"] : []),
]);
const files = [];
const copies = [];
async function copy(from, to) {
  const bytes = await readFile(from);
  const digest = hash(bytes);
  let same = false;
  try {
    same = hash(await readFile(to)) === digest;
  } catch {}
  if (!same) {
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  }
  files.push({
    path: relative(destination, to).replaceAll("\\", "/"),
    bytes: bytes.length,
    sha256: digest,
  });
}
async function tree(from, to) {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isDirectory()) await tree(join(from, entry.name), join(to, entry.name));
    else if (entry.isFile()) copies.push([join(from, entry.name), join(to, entry.name)]);
    else throw new Error("Unexpected link in Office runtime");
  }
}
await mkdir(destination, { recursive: true });
// The extra wrapper is necessary: LibreOffice checks its installation folder by
// listing its immediate parent. Only this app-owned wrapper receives read access.
for (const directory of ["program", "share", "presets", "Fonts", "readmes", "help"])
  await tree(join(source, directory), join(destination, "office", directory));
// The MSI's application-local C++ runtime is included for machines without
// Visual Studio. A clean-machine installation remains a separate P12 check.
for (const name of await readdir(join(source, "System64")))
  copies.push([join(source, "System64", name), join(destination, "office/program", name)]);
let next = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (next < copies.length) {
      const [from, to] = copies[next++];
      await copy(from, to);
      if (files.length % 2000 === 0)
        console.log(`Office runtime verified ${files.length}/${copies.length} files`);
    }
  }),
);
for (const file of ["LICENSE.html", "license.txt", "NOTICE", "CREDITS.fodt"])
  await copy(join(source, file), join(destination, "office", file));
await copy(
  join(root, `target/${release ? "release" : "debug"}/workpilot-office.exe`),
  join(destination, "office/program/workpilot-office.exe"),
);
await writeFile(
  join(destination, "runtime-manifest.json"),
  JSON.stringify(
    {
      version: "26.8.0",
      buildId,
      installer: { url, sha256 },
      source: "https://github.com/LibreOffice/core/tree/" + buildId,
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    officeRuntime: within,
    version: "26.8.0",
    files: files.length,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
  }),
);
