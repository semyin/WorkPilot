import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { expect } from "@playwright/test";
import { root } from "./cargo.mjs";
import { startTeamFixture } from "../services/execution-fixtures/teams.mjs";
import { resourceCollector, machine } from "./p13-benchmark-metrics.mjs";
import { saveProfile, createTask } from "./p13-engine-load.mjs";
import { launchDesktop, quitDesktop, request, until } from "./p13-desktop-support.mjs";
import { discover, identity, samplePhase, verifyExited } from "./p13-desktop-resource-support.mjs";

if (process.platform !== "win32") throw new Error("This native resource baseline requires Windows");
const binary = resolve(
  process.env.WORKPILOT_DESKTOP_BINARY ||
    join(root, "artifacts/workpilot-p13-candidate-2026-10-04-r3/preview/workpilot-desktop.exe"),
);
const base = resolve(
  process.env.WORKPILOT_TEST_OUTPUT || join(root, ".test-results/p13-desktop-resources"),
);
await mkdir(base, { recursive: true });
const output = await mkdtemp(join(base, "run-"));
const directory = join(output, "desktop-data");
const hash = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const report = {
  at: new Date().toISOString(),
  binary,
  binarySha256: await hash(binary),
  engineSha256: await hash(join(dirname(binary), "workpilot-sidecar.exe")),
  machine: machine(),
  output,
  phases: [],
  checks: [],
  conditions:
    process.env.WORKPILOT_BENCHMARK_CONDITIONS ||
    "Live Windows workstation; no background-work isolation asserted.",
  scope: {
    model: "Local deterministic Responses model; one waiting request and no paid service",
    data: "One new isolated task and provider, fresh app and WebView profiles, no user files",
    attribution:
      "Spawned desktop PID, descendant creation times, exact executable paths, and isolated UI WebView profile. PID plus start time is checked during sampling and exit verification.",
    resources:
      "250ms process samples; each category is summed only for cycles that captured the complete identity-verified target snapshot. Partial cycles are retained and reported separately. Summed working sets include shared pages and are not unique physical RAM. Private bytes are private committed memory. CPU normalized across all logical processors. Discovery/fixture/automation processes are excluded.",
    exclusions:
      "No dedicated webpage browser, Office tool, real service speed, true cold startup, long-running leak claim, macOS/Linux, or clean-Windows claim.",
  },
};
const fixture = await startTeamFixture();
const collector = await resourceCollector(output);
const known = new Map();
let session;
const began = performance.now();
try {
  session = await launchDesktop(binary, directory);
  const { page } = session;
  const engine = { request: (command) => request(page, command) };
  const profile = await saveProfile(engine, fixture, "p13-resource-hold", {
    kind: "hold",
    ms: 20000,
  });
  const task = await createTask(engine, profile, "P13 desktop resource baseline");
  report.taskId = task;
  await page.evaluate((id) => localStorage.setItem("workpilot.execution", id), task);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "P13 desktop resource baseline", exact: true }),
  ).toBeVisible();
  const context = {
    session,
    binary,
    directory,
    collector,
    known,
    machine: report.machine,
    sampleMs: 7000,
    minimumSamples: 20,
  };
  report.phases.push(await samplePhase(context, "idle"));
  assert.equal(fixture.records.length, 0);
  await page.screenshot({ path: join(output, "idle.png") });
  assert.equal((await request(page, { kind: "start_execution", task_id: task })).kind, "receipt");
  await expect(page.getByTestId("execution-status")).toHaveAttribute("data-state", "running");
  await until(async () => fixture.records.length === 1);
  report.phases.push(await samplePhase(context, "model-wait"));
  await expect(page.getByTestId("execution-status")).toHaveAttribute("data-state", "running");
  assert.equal(fixture.records.length, 1);
  await page.screenshot({ path: join(output, "model-wait.png") });
  assert.equal((await request(page, { kind: "cancel", task_id: task })).kind, "receipt");
  await expect(page.getByTestId("execution-status")).toHaveAttribute("data-state", "interrupted");
  await until(async () => fixture.records.every((row) => row.ended));
  assert.deepEqual(session.errors, []);
  (await discover(session, binary, directory)).forEach((row) => known.set(identity(row), row));
  report.checks.push(
    "idle_and_local_model_wait_each_have_20_or_more_samples_for_desktop_engine_ui_webview",
  );
  report.checks.push("one_actual_model_request_cancelled_without_retry_or_tool_launch");
  await quitDesktop(session);
  session = null;
  report.exitVerification = await verifyExited(known, output);
  report.checks.push(
    "owned_desktop_engine_and_profile_attributed_webview_processes_exit_without_confusing_pid_reuse",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  await quitDesktop(session).catch((error) => {
    report.cleanupError = String(error);
    report.status = "failed";
    process.exitCode = 1;
  });
  await collector.close().catch((error) => {
    report.resourceError = String(error);
    report.status = "failed";
    process.exitCode = 1;
  });
  if (known.size && !report.exitVerification)
    await verifyExited(known, output)
      .then((rows) => {
        report.exitVerification = rows;
      })
      .catch((error) => {
        report.exitVerificationError = String(error);
        report.status = "failed";
        process.exitCode = 1;
      });
  await fixture.close();
  report.elapsedMs = Math.round(performance.now() - began);
  report.processes = [...known.values()];
  report.httpCalls = fixture.records.length;
  report.command = "node scripts/p13-desktop-resources.mjs";
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(
    join(base, "latest.json"),
    JSON.stringify({ output, report: join(output, "report.json") }, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      status: report.status,
      elapsedMs: report.elapsedMs,
      report: join(output, "report.json"),
      error: report.error,
    }),
  );
}
