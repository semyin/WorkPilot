import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, access, statfs, rename } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { freemem } from "node:os";
import { root } from "./cargo.mjs";
import { startTeamFixture } from "../services/execution-fixtures/teams.mjs";
import { startFixtureServer } from "../services/fixtures/server.mjs";
import { launchDesktop, quitDesktop } from "./p13-desktop-support.mjs";
import { nativeEngine, observeNativeLifecycle } from "./p13-soak-native.mjs";
import { machine, databaseSizes } from "./p13-benchmark-metrics.mjs";
import { journal, ContinuousClock, FOUR_HOURS_MS } from "./p13-soak-journal.mjs";
import { soakTelemetry } from "./p13-soak-telemetry.mjs";
import {
  prepareModels,
  taskCycle,
  cancellationCycle,
  nodeCycle,
  scheduledCycle,
} from "./p13-soak-workloads.mjs";
import { browserCycle, officeCycle, digest } from "./p13-soak-workbench.mjs";
import { summarizeResources } from "./p13-resource-summary.mjs";

const option = (name) => {
  const i = process.argv.indexOf("--" + name);
  return i < 0 ? null : process.argv[i + 1];
};
const selfCheck = process.argv.includes("--self-check");
const resume = option("resume");
const binary = resolve(
  process.env.WORKPILOT_DESKTOP_BINARY ||
    join(root, "artifacts/workpilot-p13-candidate-2026-10-04-r3/preview/workpilot-desktop.exe"),
);
const base = resolve(process.env.WORKPILOT_TEST_OUTPUT || join(root, ".test-results/p13-soak"));
await mkdir(base, { recursive: true });
const output = resume ? resolve(resume) : await mkdtemp(join(base, "run-"));
const directory = join(output, "desktop-data"),
  project = join(output, "owned-project");
await mkdir(project, { recursive: true });
const identity = {
  desktopSha256: digest(await readFile(binary)),
  engineSha256: digest(await readFile(join(dirname(binary), "workpilot-sidecar.exe"))),
};
const report = {
  at: new Date().toISOString(),
  binary,
  identity,
  output,
  machine: machine(),
  kind: selfCheck ? "short_script_self_check" : "four_hour_continuous_combination_soak",
  requiredContinuousMs: FOUR_HOURS_MS,
  scope:
    "Actual native Windows desktop, fixed local model, owned Node tools, dedicated Chromium and Office preview; no paid model, user projects, personal browser profile or OS sleep claim.",
  conditions:
    process.env.WORKPILOT_BENCHMARK_CONDITIONS ||
    "Live workstation; ordinary OS/user activity may continue. Other functional regressions must be recorded separately; no additional formal performance run is assumed isolated.",
  checks: [],
  cycles: 0,
};
const state = await journal(output, identity, Boolean(resume));
const segmentOutput = join(output, state.segment.id);
await mkdir(segmentOutput);
const segmentProject = join(project, state.segment.id);
await mkdir(segmentProject);
const fixture = await startTeamFixture(),
  browserFixture = await startFixtureServer();
let session,
  lifecycle,
  telemetry,
  heartbeat,
  heartbeatsRunning = true,
  backgroundError,
  clock;
let stopRequested = false;
process.on("SIGINT", () => {
  stopRequested = true;
});
process.on("SIGTERM", () => {
  stopRequested = true;
});
const roundMs = selfCheck ? 1000 : 60000;
const progress = (stage, data = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), stage, ...data }));
try {
  if (resume) {
    try {
      await rename(join(output, "pause.request"), join(segmentOutput, "previous-pause.request"));
      await state.record("prior_pause_acknowledged_by_explicit_resume", {});
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  progress("launching-owned-desktop", { selfCheck, output });
  const disk = await statfs(output);
  assert(
    Number(disk.bavail) * Number(disk.bsize) > 2 * 1024 ** 3,
    "Reserve at least 2 GiB for evidence and test data",
  );
  process.env.WORKPILOT_BROWSER_HEADLESS = "1";
  session = await launchDesktop(binary, directory);
  lifecycle = observeNativeLifecycle(session, state.record, progress);
  report.nativeLifecycle = lifecycle.events;
  const engine = nativeEngine(session);
  telemetry = await soakTelemetry({
    session,
    binary,
    directory,
    output: segmentOutput,
    intervalMs: selfCheck ? 250 : 2000,
  });
  engine.identity = telemetry.current.find((row) => row.role === "engine");
  assert(engine.identity);
  const context = {
    engine,
    fixture,
    browserFixture,
    session,
    telemetry,
    project: segmentProject,
    output: segmentOutput,
    directory,
    binary: join(dirname(binary), "workpilot-sidecar.exe"),
    nodeBinary: join(dirname(binary), "browser-runtime/node.exe"),
  };
  context.profiles = await prepareModels(context);
  report.databaseAtStart = await databaseSizes(directory);
  progress("models-and-sampler-ready");
  state.segment.desktop = telemetry.current.find((row) => row.role === "desktop");
  state.segment.engine = engine.identity;
  await state.persist();
  clock = new ContinuousClock(performance.now(), Date.now());
  heartbeat = (async () => {
    let tick = 0;
    while (heartbeatsRunning) {
      await delay(5000);
      if (!heartbeatsRunning) break;
      telemetry.check();
      assert.equal((await engine.request({ kind: "ping" })).kind, "receipt");
      assert.deepEqual(session.errors, [], "The native page reported an error during soak");
      clock.pulse(performance.now(), Date.now());
      if (++tick % 2 === 0) await telemetry.refresh();
      await state.heartbeat(clock, {
        cycle: report.cycles,
        runningCycle: report.runningCycle,
        phase: telemetry.currentPhase,
        samples: telemetry.collector.sampleCount,
        freeMemoryBytes: freemem(),
        harness: process.memoryUsage(),
      });
      if (tick % 6 === 0)
        progress("heartbeat", {
          phase: telemetry.currentPhase,
          continuousSeconds: Math.floor(clock.activeMs / 1000),
          cycles: report.cycles,
        });
      assert(freemem() > 768 * 1024 ** 2, "Free system memory fell below the test safety budget");
    }
  })().catch((error) => {
    backgroundError = error;
  });
  for (let index = state.state.cycles.length; !clock.passedFourHours; index++) {
    if (stopRequested) break;
    if (backgroundError) throw backgroundError;
    if (
      await access(join(output, "pause.request")).then(
        () => true,
        () => false,
      )
    ) {
      stopRequested = true;
      break;
    }
    const began = performance.now();
    report.runningCycle = index;
    progress("cycle-start", { index });
    await state.record("cycle_started", { index });
    await telemetry.phase("task-team-node");
    const concurrent = await Promise.allSettled([
      taskCycle(context, index),
      nodeCycle(context, index),
    ]);
    const rejected = concurrent.find((result) => result.status === "rejected");
    if (rejected) throw rejected.reason;
    const [tasks, node] = concurrent.map((result) => result.value);
    const recovery = await cancellationCycle(context, index);
    progress("tasks-team-node-and-explicit-resume-completed", { index });
    let browser = null,
      office = null,
      timer = null;
    if (selfCheck || index % 5 === 0) {
      progress("browser-start", { index });
      await telemetry.phase("browser");
      browser = await telemetry.monitor(browserCycle(context, index, 2500));
      await telemetry.phase("office");
      progress("office-start", { index });
      office = await telemetry.monitor(
        officeCycle(context, index, ["docx", "xlsx", "pptx"][Math.floor(index / 5) % 3]),
      );
    }
    if (selfCheck || index % 15 === 0) {
      progress("real-clock-schedule-start", { index });
      timer = await scheduledCycle(context, index);
    }
    const database = await telemetry.recordDatabase(index);
    const row = {
      index,
      tasks,
      node,
      recovery,
      browser,
      office,
      timer,
      database,
      elapsedMs: Math.round(performance.now() - began),
      modelCalls: fixture.records.length,
    };
    assert(fixture.records.every((record) => record.correlationValid));
    state.state.cycles.push(row);
    report.cycles++;
    progress("cycle-completed", { index, elapsedMs: row.elapsedMs });
    await state.record("cycle_completed", row);
    await state.persist();
    fixture.records.length = 0;
    fixture.starts.length = 0;
    await telemetry.phase("between-cycles");
    if (selfCheck) break;
    while (performance.now() - began < roundMs) {
      if (backgroundError) throw backgroundError;
      if (stopRequested || clock.passedFourHours) break;
      await delay(1000);
    }
  }
  if (backgroundError) throw backgroundError;
  if (!stopRequested) clock.pulse(performance.now(), Date.now());
  report.continuousMs = Math.floor(clock.activeMs);
  report.fourHourGate = clock.passedFourHours && !selfCheck && !stopRequested;
  report.status = report.fourHourGate
    ? "passed"
    : selfCheck
      ? "self_check_passed_not_four_hours"
      : "paused_not_passed";
  report.checks.push(
    "root_team_queue_node_cancel_resume_browser_office_real_timer_cycles_verified",
  );
  if (!selfCheck && !stopRequested)
    assert(report.fourHourGate, "Four actual continuous hours are required");
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  heartbeatsRunning = false;
  await heartbeat;
  lifecycle?.beginShutdown();
  await quitDesktop(session).catch((error) => {
    report.shutdownError = String(error);
    report.status = "failed";
    process.exitCode = 1;
  });
  await telemetry?.close().catch((error) => {
    report.resourceError = String(error);
    report.status = "failed";
    process.exitCode = 1;
  });
  if (telemetry)
    report.exitVerification = await telemetry.verifyExit().catch((error) => {
      report.exitError = String(error);
      report.status = "failed";
      process.exitCode = 1;
      return null;
    });
  await fixture.close();
  await browserFixture.close();
  await lifecycle?.flush().catch((error) => {
    report.lifecycleRecordError = String(error);
    report.status = "failed";
    process.exitCode = 1;
  });
  report.continuousMs = Math.floor(clock?.activeMs || 0);
  report.processes = telemetry ? [...telemetry.known.values()] : [];
  report.sampleCount = telemetry?.collector.sampleCount || 0;
  report.databaseAfterExit = await databaseSizes(directory);
  try {
    report.finalBinaryIdentity = {
      desktopSha256: digest(await readFile(binary)),
      engineSha256: digest(await readFile(join(dirname(binary), "workpilot-sidecar.exe"))),
    };
    assert.deepEqual(report.finalBinaryIdentity, identity, "Product binaries changed during soak");
  } catch (error) {
    report.binaryVerificationError = String(error.stack || error);
    report.status = "failed";
    process.exitCode = 1;
  }
  if (telemetry)
    report.resources = await summarizeResources(
      join(segmentOutput, "resources.jsonl"),
      report.machine.logicalProcessors,
    ).catch((error) => {
      report.resourceSummaryError = String(error.stack || error);
      report.status = "failed";
      process.exitCode = 1;
      return null;
    });
  await state
    .finish(report.status, {
      continuousMs: report.continuousMs,
      fourHourGate: report.fourHourGate || false,
      error: report.error,
    })
    .catch((error) => {
      report.journalError = String(error.stack || error);
      report.status = "failed";
      process.exitCode = 1;
    });
  await writeFile(join(segmentOutput, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(
    join(output, "latest-report.json"),
    JSON.stringify({ report: join(segmentOutput, "report.json"), status: report.status }, null, 2) +
      "\n",
  );
  console.log(
    JSON.stringify({
      status: report.status,
      continuousMs: report.continuousMs,
      report: join(segmentOutput, "report.json"),
      error: report.error,
    }),
  );
}
