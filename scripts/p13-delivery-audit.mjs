// Read-only binary verification. --finalize only refreshes the documented source snapshot.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const delivery = join(root, "artifacts/workpilot-p13-candidate-2026-10-04-r3");
const manifestPath = join(delivery, "source-and-binary-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const finalize = process.argv.includes("--finalize");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = {
  at: new Date().toISOString(),
  version: manifest.versions.app,
  build: manifest.build,
  checks: [],
  sourceSnapshotRefreshed: false,
};
function inside(parent, name) {
  const target = resolve(parent, name),
    path = relative(parent, target);
  assert(
    path &&
      path !== ".." &&
      !path.startsWith("..\\") &&
      !path.startsWith("../") &&
      !isAbsolute(path),
  );
  return target;
}
async function digest(path) {
  const sha = createHash("sha256");
  const stream = createReadStream(path);
  let timer;
  try {
    return await Promise.race([
      (async () => {
        for await (const part of stream) sha.update(part);
        return sha.digest("hex");
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("File audit timed out: " + relative(root, path));
          stream.destroy(error);
          reject(error);
        }, 30000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    stream.destroy();
  }
}
async function walk(path, base = path) {
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), "Unexpected delivery link: " + entry.name);
    const file = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(file, base)));
    else if (entry.isFile()) files.push(relative(base, file).replaceAll("\\", "/"));
  }
  return files;
}
let secret = "";
for await (const part of process.stdin) secret += part;
secret = secret.trim();
try {
  assert.equal(manifest.versions.app, "0.1.0-alpha.13.4");
  const actual = (await walk(join(delivery, "preview"))).map((p) => "preview/" + p).sort();
  assert.deepEqual(
    actual,
    manifest.binaries.map((f) => f.path).sort(),
    "Delivery inventory changed",
  );
  let bytes = 0;
  for (const [index, file] of manifest.binaries.entries()) {
    if (index % 1000 === 0)
      console.log(JSON.stringify({ stage: "binary-audit", index, file: file.path }));
    const path = inside(delivery, file.path);
    assert.equal((await stat(path)).size, file.bytes, file.path + " size changed");
    assert.equal(await digest(path), file.sha256, file.path + " checksum changed");
    bytes += file.bytes;
  }
  report.binaryInventory = { files: actual.length, bytes, unexpectedFiles: 0 };
  report.checks.push("every_preview_file_matches_manifest_and_no_unlisted_file_exists");
  const installer = JSON.parse(await readFile(join(delivery, "installer-manifest.json"), "utf8"));
  assert.equal(installer.version, manifest.versions.app);
  assert.equal(installer.packagedBuild.desktopSha256, manifest.build.desktop);
  assert.equal(installer.packagedBuild.engineSha256, manifest.build.engine);
  assert.equal(await digest(inside(delivery, installer.file)), installer.sha256);
  assert.equal((await stat(inside(delivery, installer.file))).size, installer.bytes);
  report.installer = { file: installer.file, sha256: installer.sha256, bytes: installer.bytes };
  report.checks.push("installer_version_bytes_and_packaged_binary_identities_match");

  report.sealedPredecessors = [];
  let previous = manifest.previousManifest;
  for (let i = 0; i < 4; i++) {
    assert(previous, "Missing sealed predecessor");
    const path = inside(root, previous.path);
    assert.equal(await digest(path), previous.sha256, "A sealed predecessor manifest changed");
    const old = JSON.parse(await readFile(path, "utf8"));
    const directory = resolve(path, "..");
    for (const name of ["workpilot-desktop.exe", "workpilot-sidecar.exe"]) {
      const entry = old.binaries.find((b) => b.path === "preview/" + name);
      assert(entry, "Missing old binary identity");
      assert.equal(await digest(inside(directory, entry.path)), entry.sha256);
    }
    report.sealedPredecessors.push({
      path: previous.path,
      sha256: previous.sha256,
      version: old.versions.app,
    });
    previous = old.previousManifest;
  }
  report.checks.push("four_predecessor_manifests_and_desktop_engine_pairs_are_unchanged");

  const files = execFileSync("rg", ["--files", "--hidden", "-g", "!.git"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
    .trim()
    .split(/\r?\n/)
    .map((p) => p.replaceAll("\\", "/"))
    .sort();
  const oldSources = new Map(manifest.sourceFiles.map((f) => [f.path, f]));
  const sources = [];
  const changed = [];
  const allowedAfterBuild = (p) =>
    p.startsWith("docs/") ||
    p === "README.md" ||
    p === ".gitignore" ||
    /^scripts\/(p13-|notifications-)/.test(p);
  for (const path of files.filter((p) => !p.startsWith("artifacts/"))) {
    const content = await readFile(inside(root, path));
    const entry = { path, bytes: content.length, sha256: hash(content) };
    if (oldSources.get(path)?.sha256 !== entry.sha256) {
      assert(allowedAfterBuild(path), "Product source changed after build: " + path);
      if (path === ".gitignore") {
        const original = content.toString("utf8").replace(/^\*\.wptask\r?\n/m, "");
        assert.equal(
          hash(Buffer.from(original, "utf8")),
          oldSources.get(path)?.sha256,
          "Only the task-archive ignore rule may be added after this build",
        );
      }
      changed.push(path);
    }
    oldSources.delete(path);
    sources.push(entry);
  }
  for (const path of oldSources.keys()) {
    assert.notEqual(path, ".gitignore", "The task-archive ignore file must remain present");
    assert(allowedAfterBuild(path), "Product source disappeared: " + path);
  }
  report.postBuildDocumentationAndTestChanges = changed;
  report.checks.push("compiled_product_sources_unchanged_after_frozen_build");
  report.credentialScan = { performed: secret.length > 20, files: 0, matches: 0 };
  if (secret.length > 20) {
    const needle = Buffer.from(secret, "utf8");
    for (const path of files) {
      let content = await readFile(inside(root, path));
      if (path.endsWith(".gz"))
        content = gunzipSync(content, { maxOutputLength: 256 * 1024 * 1024 });
      report.credentialScan.files++;
      if (content.includes(needle)) report.credentialScan.matches++;
    }
    needle.fill(0);
    assert.equal(report.credentialScan.matches, 0, "Credential found; no contents are printed");
    report.checks.push(
      "exact_test_credential_absent_from_unignored_sources_and_evidence_including_gzip",
    );
  }
  if (finalize) {
    assert(
      report.credentialScan.performed,
      "Finalization requires an exact credential scan through stdin",
    );
    manifest.sourceSnapshotAt = new Date().toISOString();
    manifest.sourceSnapshotNote =
      "Documentation and acceptance scripts finalized after build; compiled product source hashes were verified unchanged.";
    manifest.sourceFiles = sources;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    report.sourceSnapshotRefreshed = true;
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  secret = "";
  const directory = join(delivery, "evidence");
  await mkdir(directory, { recursive: true });
  const path = join(
    directory,
    finalize ? "delivery-audit.json" : "delivery-audit-preliminary.json",
  );
  await writeFile(path, JSON.stringify(report, null, 2) + "\n");
}
console.log(
  JSON.stringify({
    status: report.status,
    checks: report.checks,
    sourceSnapshotRefreshed: report.sourceSnapshotRefreshed,
    error: report.error,
  }),
);
