import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { root } from "./cargo.mjs";
import { launch } from "./tool-test-support.mjs";

const output = resolve(
  process.env.WORKPILOT_TEST_OUTPUT || join(root, ".test-results/installation-stress"),
);
const binary = resolve(
  process.env.WORKPILOT_ENGINE_BINARY ||
    join(root, "artifacts/workpilot-p12-complete-2026-10-04/preview/workpilot-sidecar.exe"),
);
process.env.WORKPILOT_ENGINE_BINARY = binary;
await mkdir(output, { recursive: true });
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  binarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  environment:
    "Windows developer machine; repeated complete packaged-file reads with concurrent ordinary engine requests; not a clean OS.",
  rounds: [],
  checks: [],
};
let engine;
try {
  engine = await launch(await mkdtemp(join(output, "data-")));
  for (let round = 0; round < 10; round++) {
    const verify = round % 2 === 1,
      start = performance.now(),
      latencies = [];
    let done = false;
    const checking = engine
      .request({ kind: "inspect_installation", verify_hashes: verify })
      .catch((error) => ({ kind: "exception", message: String(error) }))
      .finally(() => {
        done = true;
      });
    while (!done) {
      const before = performance.now();
      const reply = await engine.request({
        kind: "read",
        query: { kind: "tasks", before: null, limit: 10 },
      });
      assert.equal(reply.kind, "tasks");
      latencies.push(performance.now() - before);
      if (!done) await delay(100);
    }
    const result = await checking;
    assert.equal(result.kind, "installation", JSON.stringify(result));
    assert.equal(result.report.components.length, 9);
    assert(
      result.report.components.every(
        (component) =>
          component.state === (verify ? "verified" : "present") &&
          component.files === component.checked_files,
      ),
      JSON.stringify(result.report),
    );
    const maxResponseMs = Math.max(...latencies);
    assert(maxResponseMs < 3000, "Environment inspection blocked ordinary engine requests");
    report.rounds.push({
      verify,
      elapsedMs: Math.round(performance.now() - start),
      ordinaryRequests: latencies.length,
      maxResponseMs: Math.round(maxResponseMs),
      files: result.report.components.reduce((n, c) => n + c.checked_files, 0),
    });
  }
  report.checks.push(
    "five_quick_and_five_complete_checks_verify_every_packaged_file",
    "ordinary_requests_remain_responsive_during_environment_scanning",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  await engine?.close().catch(() => {});
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
