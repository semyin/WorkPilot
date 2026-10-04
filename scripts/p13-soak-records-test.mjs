import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { root } from "./cargo.mjs";
import { journal, ContinuousClock } from "./p13-soak-journal.mjs";
import { summarizeResources } from "./p13-resource-summary.mjs";

const base = join(root, ".test-results/p13-soak-records");
await mkdir(base, { recursive: true });
const output = await mkdtemp(join(base, "run-"));
const identity = { desktopSha256: "test-only", engineSha256: "test-only" };
const first = await journal(output, identity);
const clock = new ContinuousClock(0, 1000);
clock.pulse(5000, 6000);
await first.heartbeat(clock, { cycle: 0 });
await assert.rejects(journal(output, identity, true), /running\/orphaned/);
await first.finish("paused_not_passed", { fourHourGate: false });
await assert.rejects(
  journal(output, { ...identity, engineSha256: "different" }, true),
  /identical product/,
);
const second = await journal(output, identity, true);
assert.equal(second.segment.activeMs, 0, "Previous spans must not extend a new continuous run");
assert.equal(second.state.segments.length, 2);
assert.equal(second.state.segments[0].activeMs, 5000);
await second.finish("paused_not_passed", { fourHourGate: false });
const saved = JSON.parse(await readFile(join(output, "checkpoint.json"), "utf8"));
assert.equal(saved.status, "paused_not_passed");

const raw = join(output, "resources.jsonl");
const row = (tick, atMs, pid, startedAtMs, memory, cpuMs) => ({
  tick,
  atMs,
  pid,
  startedAtMs,
  role: "test-only",
  workingSetBytes: memory,
  privateBytes: memory / 2,
  cpuMs,
});
await writeFile(
  raw,
  [
    row(1, 1000, 100, 900, 10, 0),
    row(1, 1000, 101, 900, 20, 0),
    row(2, 2000, 100, 900, 15, 100),
    row(2, 2000, 101, 1900, 25, 0),
  ]
    .map(JSON.stringify)
    .join("\n") + "\n",
);
const summary = await summarizeResources(raw, 2);
assert.equal(summary.records, 4);
assert.equal(summary.observedProcessIdentities, 3);
assert.deepEqual(summary.reusedPids, [{ pid: 101, startedAtMs: [900, 1900] }]);
assert.equal(summary.groups[0].workingSetBytes.max, 40);
assert.equal(
  summary.groups[0].cpuPercentOfWholeMachine.count,
  0,
  "A recycled process cannot inherit the old process's CPU sample",
);
console.log(
  "Journal resume and resource summary checks passed; synthetic data only, no product soak claimed.",
);
