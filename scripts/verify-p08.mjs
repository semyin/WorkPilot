import { readFile, writeFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import assert from "node:assert/strict";
import { root } from "./cargo.mjs";
const folder = join(root, "artifacts/workpilot-p08-2026-10-03");
await writeFile(
  join(folder, "evidence/delivery-verification.json"),
  JSON.stringify({ at: new Date().toISOString(), result: "in_progress" }, null, 2) + "\n",
);
const manifest = JSON.parse(
  await readFile(join(folder, "source-and-binary-manifest.json"), "utf8"),
);
const digest = (b) => createHash("sha256").update(b).digest("hex");
for (const f of manifest.sourceFiles)
  assert.equal(digest(await readFile(join(root, f.path))), f.sha256, "Source changed: " + f.path);
for (const f of manifest.binaries)
  assert.equal(
    digest(await readFile(join(folder, f.path))),
    f.sha256,
    "Delivery changed: " + f.path,
  );
const previous = join(root, "artifacts/workpilot-p07-2026-10-03");
const old = JSON.parse(await readFile(join(previous, "source-and-binary-manifest.json"), "utf8"));
for (const f of old.binaries)
  assert.equal(digest(await readFile(join(previous, f.path))), f.sha256, "P07 changed: " + f.path);
const documents = execFileSync("rg", ["--files", "docs", "-g", "*.md"], {
  cwd: root,
  encoding: "utf8",
})
  .trim()
  .split(/\r?\n/)
  .map((p) => join(root, p));
documents.push(
  join(root, "README.md"),
  join(folder, "README.md"),
  join(root, "extensions/companion/README.md"),
);
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
const names = [
  "browser-engine-report.json",
  "browser-safety-report.json",
  "browser-model-report.json",
  "browser-lifecycle-report.json",
  "browser-companion-report.json",
  "browser-desktop-report.json",
  "browser-packaged-report.json",
  "p03-engine-regression.json",
  "p04-engine-regression.json",
  "p05-engine-regression.json",
  "p07-engine-regression.json",
];
const checks = {};
for (const name of names) {
  const r = JSON.parse(await readFile(join(folder, "evidence", name), "utf8"));
  assert(r.result === "passed" || r.status === "passed", name);
  checks[name] = r.checks.length;
  if (name === "browser-packaged-report.json") {
    assert.equal(resolve(r.binary.path), join(folder, "preview/WorkPilot.exe"));
    assert.equal(
      r.binary.sha256,
      manifest.binaries.find((b) => b.path === "preview/WorkPilot.exe").sha256,
    );
  }
}
const result = {
  at: new Date().toISOString(),
  result: "passed",
  schema: manifest.versions.schema,
  sourceFiles: manifest.sourceFiles.length,
  deliveryFiles: manifest.binaries.length,
  localLinks: links,
  passedReports: names.length,
  checks,
  p07BinariesUnchanged: true,
  dailyChromeUserExperience: "pending",
  dailyEdgeUserExperience: "pending",
  macOS: "not tested",
  linux: "not tested",
};
await writeFile(
  join(folder, "evidence/delivery-verification.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result, null, 2));
