import { readFile, writeFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import assert from "node:assert/strict";
import { root } from "./cargo.mjs";
const folder = join(root, "artifacts/workpilot-p07-2026-10-03");
// Reserve this report before validating documents which link to the report itself.
// A failed check leaves an explicit incomplete report, never a previous success.
await writeFile(
  join(folder, "evidence/delivery-verification.json"),
  JSON.stringify({ at: new Date().toISOString(), result: "in_progress" }, null, 2) + "\n",
);
const manifest = JSON.parse(
  await readFile(join(folder, "source-and-binary-manifest.json"), "utf8"),
);
const digest = (b) => createHash("sha256").update(b).digest("hex");
for (const file of manifest.sourceFiles)
  assert.equal(
    digest(await readFile(join(root, file.path))),
    file.sha256,
    "Source changed: " + file.path,
  );
for (const file of manifest.binaries)
  assert.equal(
    digest(await readFile(join(folder, file.path))),
    file.sha256,
    "Binary changed: " + file.path,
  );
const previous = join(root, "artifacts/workpilot-p06-2026-10-02");
const old = JSON.parse(await readFile(join(previous, "source-and-binary-manifest.json"), "utf8"));
for (const file of old.binaries)
  assert.equal(
    digest(await readFile(join(previous, file.path))),
    file.sha256,
    "P06 changed: " + file.path,
  );
const documents = execFileSync("rg", ["--files", "docs", "-g", "*.md"], {
  cwd: root,
  encoding: "utf8",
})
  .trim()
  .split(/\r?\n/)
  .map((p) => join(root, p));
documents.push(join(root, "README.md"), join(folder, "README.md"));
let links = 0;
const broken = [];
for (const file of documents) {
  const text = await readFile(file, "utf8");
  for (const m of text.matchAll(/\[[^\]\n]+\]\(([^)\n]+)\)/g)) {
    let target = m[1].trim().replace(/^<|>$/g, "");
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    target = decodeURIComponent(target.split("#")[0]);
    if (!target) continue;
    links++;
    try {
      await stat(resolve(dirname(file), target));
    } catch {
      broken.push({ file, target });
    }
  }
}
assert.deepEqual(broken, []);
const reports = [
  "workbench-engine-report.json",
  "workbench-desktop-report.json",
  "workbench-packaged-report.json",
  "p03-engine-regression.json",
  "p04-engine-regression.json",
  "p05-engine-regression.json",
];
const checks = {};
for (const name of reports) {
  const r = JSON.parse(await readFile(join(folder, "evidence", name), "utf8"));
  assert(r.result === "passed" || r.status === "passed", "Report not passed: " + name);
  if (name === "workbench-packaged-report.json") {
    assert.equal(resolve(r.binary.path), join(folder, "preview/WorkPilot.exe"));
    assert.equal(
      r.binary.sha256,
      manifest.binaries.find((b) => b.path === "preview/WorkPilot.exe").sha256,
    );
  }
  checks[name] = r.checks.length;
}
const result = {
  at: new Date().toISOString(),
  result: "passed",
  schema: manifest.versions.schema,
  sourceFiles: manifest.sourceFiles.length,
  binaries: manifest.binaries.length,
  localLinks: links,
  passedReports: reports.length,
  checks,
  p06BinariesUnchanged: true,
};
await writeFile(
  join(folder, "evidence/delivery-verification.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result, null, 2));
