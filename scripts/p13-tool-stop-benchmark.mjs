import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, appendFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { root } from "./cargo.mjs";
import { startTeamFixture } from "../services/execution-fixtures/teams.mjs";
import { startFixtureServer } from "../services/fixtures/server.mjs";
import { launchDesktop, quitDesktop } from "./p13-desktop-support.mjs";
import { nativeEngine, observeNativeLifecycle } from "./p13-soak-native.mjs";
import { soakTelemetry } from "./p13-soak-telemetry.mjs";
import { saveProfile } from "./p13-engine-load.mjs";
import { browserCycle, officeCycle, digest } from "./p13-soak-workbench.mjs";
import { stopScenarios } from "./p13-tool-stop-scenarios.mjs";
import { distribution, machine } from "./p13-benchmark-metrics.mjs";
import { summarizeResources } from "./p13-resource-summary.mjs";
const option = (name, def) => {
  const index = process.argv.indexOf("--" + name);
  return index < 0 ? def : process.argv[index + 1];
};
const count = Number(option("samples", "20")),
  only = option("only", "both");
assert(Number.isInteger(count) && count >= 1 && count <= 40);
assert(["browser", "office", "both"].includes(only));
const binary = resolve(
  process.env.WORKPILOT_DESKTOP_BINARY ||
    join(root, "artifacts/workpilot-p13-candidate-2026-10-04-r3/preview/workpilot-desktop.exe"),
);
const base = resolve(
  process.env.WORKPILOT_TEST_OUTPUT || join(root, ".test-results/p13-tool-stop"),
);
await mkdir(base, { recursive: true });
const output = await mkdtemp(join(base, "run-")),
  directory = join(output, "desktop-data"),
  project = join(output, "owned-project");
await mkdir(project);
const report = {
  at: new Date().toISOString(),
  binary,
  binarySha256: digest(await readFile(binary)),
  engineSha256: digest(await readFile(join(dirname(binary), "workpilot-sidecar.exe"))),
  machine: machine(),
  count,
  only,
  checks: [],
  browser: [],
  office: [],
  deliveries: [],
  conditions:
    process.env.WORKPILOT_BENCHMARK_CONDITIONS ||
    "Live workstation; no claim that other background activity was isolated",
  scope:
    "Real bundled dedicated Chromium and AppContainer Office renderer, fixed local fixtures; actual process exit separate from request/ACL/staging cleanup. Short probes with fewer than20 samples are not formal percentile acceptance.",
};
const fixture = await startTeamFixture(),
  browserFixture = await startFixtureServer();
let session, telemetry, lifecycle;
try {
  process.env.WORKPILOT_BROWSER_HEADLESS = "1";
  session = await launchDesktop(binary, directory);
  lifecycle = observeNativeLifecycle(
    session,
    (kind, event) =>
      appendFile(join(output, "native-lifecycle.jsonl"), JSON.stringify({ kind, ...event }) + "\n"),
    (stage, event) => console.log(JSON.stringify({ stage, ...event })),
  );
  report.nativeLifecycle = lifecycle.events;
  const engine = nativeEngine(session);
  telemetry = await soakTelemetry({ session, binary, directory, output, intervalMs: 100 });
  const context = {
    engine,
    fixture,
    browserFixture,
    session,
    telemetry,
    project,
    output,
    directory,
  };
  context.profiles = {
    leaf: await saveProfile(engine, fixture, "p13-tool-stop-local", { kind: "leaf", text: "42" }),
  };
  Object.assign(context, stopScenarios(context, report));
  for (let index = 0; index < count; index++) {
    if (only !== "office") {
      await telemetry.phase(`browser-${index}`);
      console.log(JSON.stringify({ stage: "browser", index, count }));
      report.deliveries.push(await browserCycle(context, index));
    }
    if (only !== "browser") {
      await telemetry.phase(`office-${index}`);
      console.log(JSON.stringify({ stage: "office", index, count }));
      report.deliveries.push(
        await officeCycle(context, index, ["docx", "xlsx", "pptx"][index % 3]),
      );
    }
    await writeFile(join(output, "progress.json"), JSON.stringify(report, null, 2));
  }
  assert.deepEqual(session.errors, []);
  report.checks.push(
    "real_outputs_verified_and_all_requested_cancellations_observe_live_owned_processes",
  );
  report.status = count >= 20 ? "passed" : "probe_passed_not_twenty_samples";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  lifecycle?.beginShutdown();
  await quitDesktop(session).catch((error) => {
    report.cleanupError = String(error);
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
  report.metrics = {
    browser: Object.fromEntries(
      ["acknowledgementMs", "processExitMs"].map((key) => [
        key,
        distribution(report.browser.map((row) => row[key])),
      ]),
    ),
    office: Object.fromEntries(
      ["acknowledgementMs", "processExitMs", "cleanupMs", "workspaceCleanupMs", "replyMs"].map(
        (key) => [key, distribution(report.office.map((row) => row[key]))],
      ),
    ),
  };
  report.processStopTarget = {
    milliseconds: 2000,
    scope:
      "Actual identity-verified owned process exit; request/permission/staging cleanup is reported separately",
    browserP95Met: report.browser.length ? report.metrics.browser.processExitMs.p95 <= 2000 : null,
    officeP95Met: report.office.length ? report.metrics.office.processExitMs.p95 <= 2000 : null,
    allSamplesMet:
      report.browser.length + report.office.length
        ? [...report.browser, ...report.office].every((row) => row.processExitMs <= 2000)
        : null,
    formalSampleCountSatisfied: count >= 20,
  };
  if (
    count >= 20 &&
    report.status === "passed" &&
    [report.processStopTarget.browserP95Met, report.processStopTarget.officeP95Met].includes(false)
  ) {
    report.status = "failed";
    report.targetError = "Owned process exit p95 exceeded the initial 2-second target";
    process.exitCode = 1;
  }
  if (telemetry)
    report.resources = await summarizeResources(
      join(output, "resources.jsonl"),
      report.machine.logicalProcessors,
    ).catch((error) => {
      report.resourceSummaryError = String(error.stack || error);
      report.status = "failed";
      process.exitCode = 1;
      return null;
    });
  if (
    count >= 20 &&
    only !== "browser" &&
    report.status === "passed" &&
    !(report.resources.groups.find((group) => group.role === "office-converter")?.cycles >= 20)
  ) {
    report.status = "failed";
    report.resourceError = "Office converter needs at least 20 actual resource samples";
    process.exitCode = 1;
  }
  report.processes = telemetry ? [...telemetry.known.values()] : [];
  report.command = `node scripts/p13-tool-stop-benchmark.mjs --samples ${count} --only ${only}`;
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(
    join(base, "latest.json"),
    JSON.stringify({ output, report: join(output, "report.json") }, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      status: report.status,
      report: join(output, "report.json"),
      error: report.error,
    }),
  );
}
