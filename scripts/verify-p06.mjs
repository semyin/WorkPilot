import { readFile, writeFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import assert from "node:assert/strict";
import { root } from "./cargo.mjs";
const folder = join(root, "artifacts/workpilot-p06-2026-10-02");
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
const previous = JSON.parse(
  await readFile(
    join(root, "artifacts/workpilot-p05-2026-10-02/source-and-binary-manifest.json"),
    "utf8",
  ),
);
for (const file of previous.binaries)
  assert.equal(
    digest(await readFile(join(root, "artifacts/workpilot-p05-2026-10-02", file.path))),
    file.sha256,
    "P05 changed: " + file.path,
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
  "workspace-desktop-report.json",
  "workspace-desktop-packaged-report.json",
  "p02-desktop-regression.json",
  "p03-desktop-regression.json",
  "p04-desktop-regression.json",
  "p05-desktop-regression.json",
  "foundation-desktop-regression.json",
  "p03-engine-regression.json",
  "p04-engine-regression.json",
  "p05-engine-regression.json",
];
for (const name of reports) {
  const r = JSON.parse(await readFile(join(folder, "evidence", name), "utf8"));
  assert(r.result === "passed" || r.passed === true, `Report not passed: ${name}`);
}
const result = {
  at: new Date().toISOString(),
  result: "passed",
  schema: manifest.versions.schema,
  sourceFiles: manifest.sourceFiles.length,
  binaries: manifest.binaries.length,
  localLinks: links,
  passedReports: reports.length,
  p05BinariesUnchanged: true,
};
await writeFile(
  join(folder, "evidence/delivery-verification.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result, null, 2));
