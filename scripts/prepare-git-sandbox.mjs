import { readFile, writeFile, mkdir, copyFile, readdir, lstat, cp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, dirname, relative } from "node:path";
import { root, run } from "./cargo.mjs";

if (process.platform !== "win32") throw new Error("Sandboxed Git currently targets Windows x64.");
const metadata = JSON.parse(
  await readFile(join(root, "resources/git-sandbox/sources.json"), "utf8"),
);
const cache = join(root, ".local/p12-runtime-downloads");
const record = join(cache, "git-sandbox-prepared.json");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceFiles = metadata.buildInputs;
const inputHash = hash(
  Buffer.concat(await Promise.all(sourceFiles.map((file) => readFile(join(root, file))))),
);
const work = join(cache, "git-build-" + inputHash.slice(0, 16));
const sourceRoot = join(work, "source");
const output = join(work, "runtime");
async function inventory(folder) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name),
        info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error("Linked sandboxed Git build output");
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) {
        const bytes = await readFile(path);
        files.push({
          path: relative(folder, path).replaceAll("\\", "/"),
          bytes: bytes.length,
          sha256: hash(bytes),
        });
      } else throw new Error("Unexpected sandboxed Git build output");
    }
  }
  await visit(folder);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
if (!process.argv.includes("--worker")) {
  try {
    const receipt = JSON.parse(await readFile(record, "utf8"));
    if (
      receipt.inputHash === inputHash &&
      receipt.directory === output &&
      JSON.stringify(await inventory(output)) === JSON.stringify(receipt.files)
    ) {
      console.log(JSON.stringify({ id: "git-sandbox", cached: true, version: metadata.version }));
      process.exit(0);
    }
  } catch {}
  const vswhere = join(
    process.env["ProgramFiles(x86)"],
    "Microsoft Visual Studio/Installer/vswhere.exe",
  );
  const vs = execFileSync(
    vswhere,
    [
      "-latest",
      "-products",
      "*",
      "-requires",
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-property",
      "installationPath",
    ],
    { encoding: "utf8", windowsHide: true },
  ).trim();
  if (!vs)
    throw new Error("Visual Studio C++ Build Tools are needed to build the compatibility runtime.");
  await run("cmd.exe", ["/d", "/c", join(root, "scripts/prepare-git-sandbox.cmd")], {
    env: {
      ...process.env,
      WORKPILOT_VSDEVCMD: join(vs, "Common7/Tools/VsDevCmd.bat"),
      WORKPILOT_BUILD_NODE: process.execPath,
      WORKPILOT_BUILD_SCRIPT: join(root, "scripts/prepare-git-sandbox.mjs"),
    },
  });
  process.exit(0);
}
await mkdir(cache, { recursive: true });
await mkdir(work, { recursive: true });
for (const asset of metadata.assets) {
  const path = join(cache, asset.file);
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {}
  if (!bytes) {
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error("Git source download failed: " + response.status);
    bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== asset.bytes || hash(bytes) !== asset.sha256)
      throw new Error("Git source archive differs from fixed asset");
    await writeFile(path, bytes, { flag: "wx" });
  }
  if (bytes.length !== asset.bytes || hash(bytes) !== asset.sha256)
    throw new Error("Git source archive differs from fixed asset");
}
const git = join(sourceRoot, metadata.assets[0].folder),
  zlib = join(sourceRoot, metadata.assets[1].folder);
if (!(await lstat(git).catch(() => null))) {
  await run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-File",
    join(root, "scripts/extract-git-source.ps1"),
    "-Archive",
    join(cache, metadata.assets[0].file),
    "-Destination",
    sourceRoot,
  ]);
  const archive = join(cache, metadata.assets[1].file);
  const entries = execFileSync("tar.exe", ["-tf", archive], { encoding: "utf8", windowsHide: true })
    .trim()
    .split(/\r?\n/);
  if (
    entries.some(
      (entry) =>
        !entry.startsWith(metadata.assets[1].folder + "/") ||
        /(^\/|:|(^|\/)\.\.?(\/|$))/.test(entry),
    )
  )
    throw new Error("Unsafe zlib source archive");
  const verbose = execFileSync("tar.exe", ["-tvf", archive], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (verbose.split(/\r?\n/).some((line) => /^[lh]/.test(line)))
    throw new Error("Source archive links are unsupported");
  await run("tar.exe", ["-xf", archive, "-C", sourceRoot]);
  await run("git.exe", ["init", "--quiet", git]);
  await run("git.exe", ["apply", join(root, "resources/git-sandbox/git-appcontainer.patch")], {
    cwd: git,
  });
  await copyFile(
    join(root, "resources/git-sandbox/path-compat.c"),
    join(git, "compat/workpilot-path.c"),
  );
  await writeFile(join(git, "version"), metadata.version + "\n");
}
const gitExe = execFileSync("where.exe", ["git.exe"], { encoding: "utf8", windowsHide: true })
  .trim()
  .split(/\r?\n/)[0];
const sh = join(dirname(dirname(gitExe)), "bin/sh.exe");
const zBuild = join(work, "zlib-build"),
  gBuild = join(work, "git-build");
const common = [
  "-G",
  "Ninja",
  "-DCMAKE_BUILD_TYPE=Release",
  "-DCMAKE_C_FLAGS_RELEASE=/MT /O2 /DNDEBUG",
  "-DCMAKE_POLICY_DEFAULT_CMP0091=NEW",
  "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded",
];
await run("cmake.exe", ["-S", zlib, "-B", zBuild, ...common, "-DZLIB_BUILD_EXAMPLES=OFF"]);
await run("cmake.exe", ["--build", zBuild, "--target", "zlibstatic", "--parallel", "2"]);
await run("cmake.exe", [
  "-S",
  join(git, "contrib/buildsystems"),
  "-B",
  gBuild,
  ...common,
  "-DUSE_VCPKG=OFF",
  "-DSH_EXE=" + sh.replaceAll("\\", "/"),
  "-DZLIB_INCLUDE_DIR=" + zlib.replaceAll("\\", "/"),
  "-DZLIB_LIBRARY=" + join(zBuild, "zs.lib").replaceAll("\\", "/"),
  "-DCMAKE_DISABLE_FIND_PACKAGE_CURL=ON",
  "-DCMAKE_DISABLE_FIND_PACKAGE_Iconv=ON",
  "-DCMAKE_DISABLE_FIND_PACKAGE_EXPAT=ON",
  "-DCMAKE_DISABLE_FIND_PACKAGE_PkgConfig=ON",
]);
await run("cmake.exe", ["--build", gBuild, "--target", "git", "--parallel", "2"]);
const dependencies = execFileSync("dumpbin.exe", ["/dependents", join(gBuild, "git.exe")], {
  encoding: "utf8",
  windowsHide: true,
});
if (/VCRUNTIME|MSVCP|api-ms-win-crt/i.test(dependencies))
  throw new Error("Sandboxed Git unexpectedly needs an external C runtime");
await mkdir(join(output, "bin"), { recursive: true });
await mkdir(join(output, "source"), { recursive: true });
await copyFile(join(gBuild, "git.exe"), join(output, "bin/git.exe"));
await copyFile(join(git, "COPYING"), join(output, "GIT_COPYING.txt"));
await copyFile(join(zlib, "LICENSE"), join(output, "ZLIB_LICENSE.txt"));
for (const asset of metadata.assets)
  await copyFile(join(cache, asset.file), join(output, "source", asset.file));
for (const file of sourceFiles) {
  const target = join(output, "source", file);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(join(root, file), target);
}
await copyFile(join(root, "scripts/cargo.mjs"), join(output, "source/scripts/cargo.mjs"));
await copyFile(
  join(root, "scripts/extract-runtime.ps1"),
  join(output, "source/scripts/extract-runtime.ps1"),
);
for (const name of ["description", "hooks", "info"]) {
  await mkdir(join(output, "share/git-core/templates"), { recursive: true });
  await cp(join(git, "templates", name), join(output, "share/git-core/templates", name), {
    recursive: true,
  });
}
await writeFile(
  join(output, "BUILD.json"),
  JSON.stringify(
    {
      ...metadata,
      inputHash,
      patch: "source/resources/git-sandbox/git-appcontainer.patch",
      compatibility:
        "Path translation only; original AppContainer ACL and no-network boundary remain in force.",
      build:
        "Visual Studio 2022 x64, static CRT and zlib, Git local built-ins; no curl, gettext, PCRE2 or Git Bash. Full access keeps the official MinGit runtime.",
    },
    null,
    2,
  ) + "\n",
);
const files = await inventory(output);
await writeFile(
  record,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      version: metadata.version,
      inputHash,
      directory: output,
      dependencies,
      files,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify({ id: "git-sandbox", version: metadata.version, files: files.length }));
