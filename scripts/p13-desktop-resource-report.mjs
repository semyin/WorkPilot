// Recompute summaries from existing raw samples; this never launches a product process.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { aggregate } from "./p13-desktop-resource-support.mjs";

assert(process.argv[2], "Pass the directory containing report.json and resources.jsonl");
const directory = resolve(process.argv[2]);
const original = await readFile(join(directory, "report.json"));
const raw = await readFile(join(directory, "resources.jsonl"));
const report = JSON.parse(original.toString());
assert.equal(report.status, "passed", "Summary recalculation cannot override a failed product run");
const samples = raw.toString().trim().split("\n").map(JSON.parse);
report.phases = report.phases.map((phase) => {
  const measured = samples.filter(
    (row) => row.atMs >= phase.beganAtMs && row.atMs <= phase.endedAtMs,
  );
  const summary = aggregate(
    measured,
    phase.phase,
    report.machine.logicalProcessors,
    phase.discoveries,
  );
  for (const role of ["desktop", "engine", "ui-webview"]) {
    assert(
      summary.groups.find((row) => row.role === role)?.samples >= 20,
      `At least 20 complete ${phase.phase}/${role} cycles are required`,
    );
  }
  return { ...phase, ...summary };
});
report.recalculation = {
  at: new Date().toISOString(),
  command: `node scripts/p13-desktop-resource-report.mjs "${directory}"`,
  originalReportSha256: createHash("sha256").update(original).digest("hex"),
  rawSamplesSha256: createHash("sha256").update(raw).digest("hex"),
  scope:
    "Existing raw sample analysis only; no new product run. Summaries retain only cycles containing the full identity-verified target snapshot. Boundary partial cycles remain in raw data and excludedIncompleteCycles. Legacy raw samples are accepted only when every discovery found the identical target identity set.",
};
report.scope.resources +=
  " Summary correction: only complete target-snapshot cycles are summarized; excluded boundary cycles remain explicitly listed.";
const output = join(directory, "report-complete-cycles.json");
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify({
    status: report.status,
    report: output,
    phases: report.phases.map((phase) => ({
      phase: phase.phase,
      excluded: phase.excludedIncompleteCycles,
      samples: phase.groups.map((group) => ({ role: group.role, count: group.samples })),
    })),
  }),
);
