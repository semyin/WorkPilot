import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { resourceCollector, databaseSizes, machine } from "./p13-benchmark-metrics.mjs";
import { discover, identity, aggregate, verifyExited } from "./p13-desktop-resource-support.mjs";
import { launchDesktop, quitDesktop, until } from "./p13-desktop-support.mjs";
import { longHistoryFixture } from "./p13-long-history-fixture.mjs";
import { digest, seedClosedHistory } from "./p13-long-history-data.mjs";
import {
  prepareTasks,
  showHistory,
  startFour,
  exerciseHistory,
  stopOne,
  taskStates,
} from "./p13-long-history-scenario.mjs";

const selfTest = process.argv.includes("--self-test");
assert(
  selfTest !== process.argv.includes("--measure"),
  "Choose --self-test or --measure explicitly",
);
assert.equal(
  process.platform,
  "win32",
  "This grouped native resource measurement requires Windows",
);
const binary = resolve(
  process.env.WORKPILOT_DESKTOP_BINARY ||
    "artifacts/workpilot-p13-candidate-2026-10-04-r3/preview/workpilot-desktop.exe",
);
const base = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/p13-long-history");
await mkdir(base, { recursive: true });
const output = await mkdtemp(join(base, selfTest ? "self-check-" : "measurement-"));
const directory = join(output, "desktop-data");
await mkdir(directory);
const ownerToken = randomUUID();
await writeFile(join(directory, ".long-history-owner"), ownerToken, { flag: "wx" });
const report = {
  at: new Date().toISOString(),
  beganAtMs: Date.now(),
  output,
  binary,
  binarySha256: digest(await readFile(binary)),
  engineSha256: digest(await readFile(join(dirname(binary), "workpilot-sidecar.exe"))),
  machine: machine(),
  selfTest,
  formalPerformanceEligible: !selfTest,
  conditions:
    process.env.WORKPILOT_BENCHMARK_CONDITIONS ||
    "Live workstation; no isolation from unrelated background work asserted",
  scope: {
    data: "100000 historical progress events plus one 2.1 MB UTF-8 body seeded only into a closed test-owned database; history task is one of four independent concurrent tasks",
    workload:
      "Four real native-engine HTTP streams from a local deterministic fixture; no paid service or local tools. One is cancelled, three continue and complete",
    ui: selfTest
      ? "Four inputs and four sidebar clicks only to validate the harness; no formal p95"
      : "Twenty inputs and twenty sidebar clicks; DOM-change timestamps, not physical display refresh",
    resources:
      "250 ms process sampling. Desktop, engine and profile-attributed UI WebView are summed per complete process-identity snapshot. CPU is a percentage of the whole machine; summed working sets may double-count shared pages. Test fixtures, automation and discovery processes are excluded",
    exclusions:
      "No four-hour soak, true cold startup, real model latency, browser/Office load, clean-Windows or macOS/Linux claim",
  },
  checks: [],
  phases: [],
  screenshots: [],
};
const fixture = await longHistoryFixture();
const collector = await resourceCollector(output);
const known = new Map();
let session;
const phase = async (name, action = async () => null) => {
  const beganAtMs = Date.now(),
    started = performance.now(),
    discoveries = [];
  let done = false,
    value,
    actionError,
    sampleError;
  const activate = async () => {
    const rows = await discover(session, binary, directory);
    rows.forEach((row) => known.set(identity(row), row));
    const targetVersion = `${name}-${discoveries.length}`;
    discoveries.push({ atMs: Date.now(), targetVersion, identities: rows.map(identity) });
    await collector.targets(rows.map((row) => ({ ...row, phase: name, targetVersion })));
  };
  await activate();
  await until(async () => collector.samples.some((row) => row.phase === name));
  const actionBeganAtMs = Date.now();
  const work = (async () => {
    try {
      value = await action();
    } catch (error) {
      actionError = error;
    } finally {
      done = true;
    }
  })();
  try {
    do {
      collector.check();
      await activate();
      await delay(1000);
      if (actionError) break;
      if (performance.now() - started > 150000)
        throw new Error("Long-history phase exceeded its bounded test window");
    } while (!done || performance.now() - started < (selfTest ? 2500 : 7500));
  } catch (error) {
    sampleError = error;
  }
  await work;
  const endedAtMs = Date.now();
  await collector.targets([]);
  const resources = aggregate(
    collector.samples.filter((row) => row.atMs >= beganAtMs && row.atMs <= endedAtMs),
    name,
    report.machine.logicalProcessors,
    discoveries,
  );
  report.phases.push({
    ...resources,
    beganAtMs,
    actionBeganAtMs,
    endedAtMs,
    elapsedMs: Math.round(performance.now() - started),
    discoveries,
  });
  if (actionError || sampleError) throw actionError || sampleError;
  for (const role of ["desktop", "engine", "ui-webview"])
    assert(
      resources.groups.find((row) => row.role === role)?.samples >= (selfTest ? 4 : 20),
      `Insufficient complete ${name}/${role} samples`,
    );
  return value;
};
try {
  session = await launchDesktop(binary, directory);
  const tasks = await prepareTasks(session.page, fixture);
  report.tasks = tasks;
  (await discover(session, binary, directory)).forEach((row) => known.set(identity(row), row));
  report.databaseBeforeSeed = await databaseSizes(directory);
  const closedProcess = session.child;
  assert.deepEqual(session.errors, []);
  await quitDesktop(session);
  session = null;
  report.preSeedExitVerification = await verifyExited(known, output);
  report.seed = await seedClosedHistory({
    directory,
    taskId: tasks[0].id,
    ownerToken,
    closedProcess,
  });
  report.databaseAfterSeed = await databaseSizes(directory);
  report.checks.push(
    "closed_owned_database_seeded_100000_progress_events_and_exact_2_1_mb_content",
  );

  session = await launchDesktop(binary, directory);
  const { page } = session;
  report.reopenObservedMs = session.startupObservedMs;
  const openAt = performance.now();
  await showHistory(page, tasks[0]);
  report.historySelectionObservedMs = performance.now() - openAt;
  await phase("history-idle");
  report.fourStarted = await startFour(page, tasks, fixture);
  report.historyOperations = await phase("history-four-streams", () =>
    exerciseHistory({ page, output, directory, seed: report.seed, tasks, fixture, selfTest }),
  );
  report.screenshots.push("history-four-streams.png", "history-long-body-page.png");
  report.checks.push(
    "four_independent_streams_remain_running_through_input_buttons_record_pages_full_body_search_copy_and_export",
  );
  report.checks.push(
    "full_export_contains_all_100000_unique_progress_records_and_exact_complete_body_hash",
  );

  report.stop = await stopOne(page, tasks, fixture);
  const remaining = fixture.records.filter((row) => row.model !== tasks[0].model);
  const before = remaining.map((row) => ({ model: row.model, chunks: row.chunks }));
  await phase("history-three-after-stop", async () => {
    await until(async () =>
      before.every(
        (row) =>
          fixture.records.find((current) => current.model === row.model).chunks >= row.chunks + 4,
      ),
    );
    assert(remaining.every((row) => !row.ended));
    const states = await taskStates(page, tasks);
    assert.equal(states[0].state, "interrupted");
    assert(states.slice(1).every((row) => row.state === "running"));
    report.afterStopStates = states;
  });
  await page.screenshot({ path: join(output, "history-three-after-stop.png") });
  report.screenshots.push("history-three-after-stop.png");
  tasks.slice(1).forEach((task) => fixture.finish(task.model));
  await until(async () =>
    (await taskStates(page, tasks)).slice(1).every((row) => row.state === "completed"),
  );
  assert.equal(fixture.records.length, 4);
  assert.equal(fixture.records.filter((row) => row.completed).length, 3);
  await until(async () => fixture.records.every((row) => row.ended));
  await phase("history-completed");
  report.checks.push(
    "four_resource_phases_separately_attribute_desktop_engine_and_ui_webview_with_complete_identity_snapshots",
  );
  report.checks.push(
    "stopping_history_task_closes_only_its_stream_while_three_peers_continue_emit_and_complete_without_retry",
  );
  report.databaseAfterWork = await databaseSizes(directory);
  assert.deepEqual(session.errors, []);
  await quitDesktop(session);
  session = null;
  report.exitVerification = await verifyExited(known, output);
  report.checks.push(
    "desktop_engine_and_profile_owned_webviews_exit_verified_by_pid_start_time_and_path",
  );
  report.databaseAfterExit = await databaseSizes(directory);
  report.targetMisses = selfTest
    ? []
    : Object.entries(report.historyOperations.measurements)
        .filter(([, row]) => row.withinTarget === false)
        .map(([name]) => name);
  report.status = selfTest
    ? "self_test_passed"
    : report.targetMisses.length
      ? "passed_with_performance_gaps"
      : "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
  if (session) await session.page.screenshot({ path: join(output, "failure.png") }).catch(() => {});
} finally {
  await quitDesktop(session).catch((error) => {
    report.shutdownError = String(error);
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
        report.exitError = String(error);
        report.status = "failed";
        process.exitCode = 1;
      });
  await fixture.close();
  report.modelRequests = fixture.records;
  report.endedAtMs = Date.now();
  report.elapsedMs = report.endedAtMs - report.beganAtMs;
  report.command = `node scripts/p13-long-history-benchmark.mjs ${selfTest ? "--self-test" : "--measure"}`;
  const text =
    JSON.stringify(
      report,
      (key, value) => (selfTest && ["p50", "p95"].includes(key) ? undefined : value),
      2,
    ) + "\n";
  await writeFile(join(output, "report.json"), text);
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
