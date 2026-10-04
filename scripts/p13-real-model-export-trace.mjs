// Offline export from an already cleaned, plaintext-scanned isolated test run.
// Does not start an engine, read a credential, make a request or modify source evidence.
import assert from "node:assert/strict";
import { readFile, readdir, realpath, lstat, writeFile } from "node:fs/promises";
import { resolve, join, relative, isAbsolute, basename } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { serviceOrigin } from "./p13-real-model-support.mjs";

assert.equal(process.argv.length, 3, "Provide exactly one completed isolated run directory");
const base = await realpath(resolve(".test-results"));
const directory = await realpath(resolve(process.argv[2]));
const inside = (root, target) => {
  const path = relative(root, target);
  return !!path && !path.startsWith("..") && !isAbsolute(path);
};
assert(inside(base, directory), "Only known local test outputs may be exported");
const report = JSON.parse(await readFile(join(directory, "report.json"), "utf8"));
assert(report.finishedAt && report.cleanup?.credentialsRemoved);
assert.equal(report.credentialScan?.plaintextCredentialFound, false);
const objects = await realpath(join(directory, "data", "test", "objects"));
assert(inside(directory, objects));
const paths = new Map();
for (const path of await readdir(objects, { recursive: true })) {
  const name = basename(path);
  if (/^[a-f0-9]{64}$/.test(name)) {
    assert(!paths.has(name), "A content hash must identify a unique file");
    paths.set(name, join(objects, path));
  }
}
const readContent = async (reference) => {
  if (!reference) return null;
  assert(/^[a-f0-9]{64}$/.test(reference.object_id));
  assert(reference.bytes <= 64 * 1024 * 1024, "Unexpected large test content");
  const path = paths.get(reference.object_id);
  assert(path, "Preserve missing-reference failures instead of producing partial evidence");
  assert(!(await lstat(path)).isSymbolicLink());
  assert(inside(objects, await realpath(path)));
  const bytes = await readFile(path);
  assert.equal(bytes.length, reference.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), reference.object_id);
  return JSON.parse(bytes.toString("utf8"));
};
const events = JSON.parse(await readFile(join(directory, "events.json"), "utf8"));
const steps = new Map();
for (const event of events) {
  if (event.kind !== "execution_step_changed") continue;
  let step = steps.get(event.step_id);
  if (!step) {
    step = {
      stepId: event.step_id,
      taskId: event.task_id,
      runId: event.run_id,
      name: event.name,
      events: [],
      inputRef: null,
      outputRef: null,
    };
    steps.set(event.step_id, step);
  }
  step.events.push({ sequence: event.sequence, atMs: event.at_ms, state: event.state });
  step.state = event.state;
  if (event.input) step.inputRef = event.input;
  if (event.output) step.outputRef = event.output;
}
for (const step of steps.values()) {
  step.input = await readContent(step.inputRef);
  step.output = await readContent(step.outputRef);
}
const result = {
  format: "workpilot.test-evidence.all-execution-steps.v1",
  at: new Date().toISOString(),
  sourceReportSha256: createHash("sha256")
    .update(await readFile(join(directory, "report.json")))
    .digest("hex"),
  binarySha256: report.binarySha256,
  scope:
    "Every observed execution step and its content, including steps older than the snapshot's last-64 window. Probe responses are in the original report. No database or credential copied.",
  stepCount: steps.size,
  modelStepCount: [...steps.values()].filter((s) => s.name === "model").length,
  steps: [...steps.values()],
};
const excluded = new Set([
  "credential",
  "credential_ref",
  "credential_id",
  "secret",
  "authorization",
]);
const text = JSON.stringify(
  result,
  (key, value) => (excluded.has(key) ? "[excluded]" : value),
  2,
).replaceAll(serviceOrigin, "https://<workspace>.cn-beijing.maas.aliyuncs.com");
await writeFile(join(directory, "all-steps.json.gz"), gzipSync(Buffer.from(text + "\n")), {
  flag: "wx",
});
console.log(
  JSON.stringify({
    directory,
    steps: result.stepCount,
    modelSteps: result.modelStepCount,
    file: "all-steps.json.gz",
  }),
);
