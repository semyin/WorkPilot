import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { root } from "./cargo.mjs";
import { startTeamFixture } from "../services/execution-fixtures/teams.mjs";
import { launchEngine, eventObserver, team } from "./p13-engine-client.mjs";
import { resourceCollector, machine, databaseSizes } from "./p13-benchmark-metrics.mjs";
import { loadScenario, saveProfile, createTask } from "./p13-engine-load.mjs";
import { stopSamples, crashAndRestart } from "./p13-engine-lifecycle.mjs";

function numberOption(name, fallback, min, max) {
  const index = process.argv.indexOf("--" + name);
  const value = index < 0 ? fallback : Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error("Invalid --" + name);
  return value;
}
if (process.platform !== "win32") throw new Error("This P13 baseline requires Windows");
const options = {
  windowMs: numberOption("window-ms", 10000, 1000, 3600000),
  samples: numberOption("samples", 20, 2, 10000),
  stopSamples: numberOption("stop-samples", 20, 1, 1000),
  modelDelayMs: numberOption("model-delay-ms", 250, 10, 10000),
};
const base = resolve(process.env.WORKPILOT_TEST_OUTPUT || join(root, ".test-results/p13-engine"));
await mkdir(base, { recursive: true });
const output = await mkdtemp(join(base, "run-"));
const directory = join(output, "engine-data"),
  project = join(output, "load-project");
await mkdir(directory);
await mkdir(project);
const binary = resolve(
  process.env.WORKPILOT_ENGINE_BINARY ||
    join(root, "artifacts/workpilot-p13-candidate-2026-10-04-r3/preview/workpilot-sidecar.exe"),
);
const nodeBinary = join(dirname(binary), "browser-runtime/node.exe");
const hash = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const report = {
  at: new Date().toISOString(),
  binary,
  binarySha256: await hash(binary),
  nodeBinarySha256: await hash(nodeBinary),
  machine: machine(),
  options,
  output,
  runConditions:
    process.env.WORKPILOT_BENCHMARK_CONDITIONS ||
    "Live workstation; no isolation from other background activity asserted.",
  scenarios: [],
  checks: [],
  scope: {
    kind: "short synthetic benchmark",
    model: "Local deterministic HTTP Responses fixture; no paid model",
    browserEnabled: false,
    officeToolsEnabled: false,
    desktopEnabled: false,
    data: "Fresh isolated directory; generated tasks accumulate during this run. Not a 100,000-event historical-data scenario.",
    exclusions:
      "No four-hour soak, UI latency, cold-cache OS startup, real-provider performance, macOS/Linux or clean-Windows claim.",
    percentiles: "Nearest-rank p50/p95; all samples retained, no best-run selection.",
    resources:
      "250ms external process sampling; collector and Node fixture are excluded from engine measurements. CPU normalized over all logical processors.",
  },
};
const observer = eventObserver(),
  fixture = await startTeamFixture();
const collector = await resourceCollector(output);
const harnessCpu = process.cpuUsage(),
  began = performance.now();
let engine;
const reopen = async () => {
  engine = await launchEngine(binary, directory, observer.observe);
  [engine.identity] = await collector.identify([
    { pid: engine.child.pid, path: binary, notBeforeMs: engine.launchedAtMs },
  ]);
  await collector.targets([{ ...engine.identity, role: "engine", phase: "startup-or-restart" }]);
  return engine;
};
try {
  engine = await reopen();
  report.startupToEngineReadyMs = engine.startupMs;
  report.databaseBefore = await databaseSizes(directory);
  await collector.targets([{ ...engine.identity, role: "engine", phase: "idle" }]);
  await delay(2000);
  const profile = await saveProfile(engine, fixture, "p13-seed", { kind: "leaf" });
  const seed = await createTask(engine, profile, "scheduler baseline", project);
  const scheduler = (await team(engine, seed)).scheduler;
  report.originalScheduler = scheduler;
  assert.equal(
    (
      await engine.request({
        kind: "configure_scheduler",
        settings: { max_running: 8, revision: scheduler.revision },
      })
    ).kind,
    "receipt",
  );
  const context = {
    engine,
    fixture,
    project,
    directory,
    output,
    options,
    observer,
    collector,
    binary,
    nodeBinary,
  };
  for (const [kind, count] of [
    ["tasks", 1],
    ["tasks", 4],
    ["tasks", 8],
    ["assistants", 1],
    ["assistants", 3],
    ["assistants", 8],
  ]) {
    const result = await loadScenario(context, kind, count);
    report.scenarios.push(result);
    await writeFile(join(output, "progress.json"), JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify({
        scenario: result.name,
        waves: result.waves,
        elapsedMs: result.elapsedMs,
        controlP95Ms: result.metricsMs.ping.p95,
        peak: result.observedPeakRunning,
      }),
    );
  }
  report.checks.push("six_synthetic_load_levels_complete_and_respect_configured_limits");
  report.stopping = await stopSamples(context);
  report.checks.push("actual_owned_parent_child_process_trees_stop_and_heartbeat_writes_cease");
  report.restart = await crashAndRestart(context, reopen);
  engine = context.engine;
  report.checks.push(
    "forced_owned_engine_exit_reaps_tools_restart_preserves_interruption_without_model_replay",
  );
  report.databaseBeforeShutdown = await databaseSizes(directory);
  report.dataScale = {
    preexistingUserTasks: 0,
    createdRootTasks:
      1 + report.scenarios.reduce((n, row) => n + row.completedRoots, 0) + options.stopSamples + 1,
    createdAssistantTasks: report.scenarios.reduce((n, row) => n + row.completedMembers, 0),
    fixedLeafResponseCharacters: "P13 fixed local response. ".repeat(16).length,
  };
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  await engine?.close().catch((error) => {
    report.shutdownError = String(error);
    process.exitCode = 1;
  });
  await collector.close().catch((error) => {
    report.resourceError = String(error);
    process.exitCode = 1;
  });
  await fixture.close();
  report.elapsedMs = Math.round(performance.now() - began);
  report.eventCounts = observer.counts;
  report.resources = collector.summarize(report.machine.logicalProcessors);
  if (report.status === "passed") {
    const identity = (value) => `${value.pid}:${value.startedAtMs}`;
    const sampled = new Set(collector.samples.map(identity));
    const toolIdentities = [
      ...report.stopping.raw.flatMap((sample) => sample.processIdentities),
      ...report.restart.processIdentities,
    ];
    const toolPids = toolIdentities.map((value) => value.pid);
    const identities = toolIdentities.map(identity);
    report.resourceCoverage = {
      identityBoundary:
        "PID + actual process start time; executable paths are verified before sampling",
      expectedOwnedToolProcesses: toolIdentities.length,
      reusedToolPids: [
        ...new Set(toolPids.filter((pid, index) => toolPids.indexOf(pid) !== index)),
      ],
      duplicateToolIdentities: identities.filter((id, index) => identities.indexOf(id) !== index),
      sampledOwnedToolProcesses: toolIdentities.filter((value) => sampled.has(identity(value)))
        .length,
      missingToolProcesses: toolIdentities.filter((value) => !sampled.has(identity(value))),
      missingLoadPhases: report.scenarios
        .filter((scenario) => !report.resources.some((r) => r.label === "engine:" + scenario.name))
        .map((scenario) => scenario.name),
    };
    if (
      report.resourceCoverage.missingToolProcesses.length ||
      report.resourceCoverage.missingLoadPhases.length ||
      report.resourceCoverage.duplicateToolIdentities.length
    ) {
      report.resourceError = "Resource sampling missed a required process or load phase";
      process.exitCode = 1;
    }
  }
  report.harness = {
    cpuMicroseconds: process.cpuUsage(harnessCpu),
    memoryAfter: process.memoryUsage(),
  };
  report.databaseAfterShutdown = await databaseSizes(directory);
  if (report.shutdownError || report.resourceError) report.status = "failed";
  report.command = `node scripts/p13-engine-benchmark.mjs --window-ms ${options.windowMs} --samples ${options.samples} --stop-samples ${options.stopSamples} --model-delay-ms ${options.modelDelayMs}`;
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
