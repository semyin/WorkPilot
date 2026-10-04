import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { root } from "./cargo.mjs";
import { createTask, saveProfile, timedRequest } from "./p13-engine-load.mjs";
import { eventually, start, snapshot, finished } from "./p13-engine-client.mjs";
import { distribution } from "./p13-benchmark-metrics.mjs";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function startTree(context, index) {
  const { engine, fixture, output, collector, nodeBinary } = context;
  await collector.targets([{ ...engine.identity, role: "engine", phase: "process-lifecycle" }]);
  const project = join(output, "owned-process-" + index);
  await mkdir(project);
  const marker = join(project, "owned");
  const profile = await saveProfile(engine, fixture, "p13-process-" + index, {
    kind: "leaf",
    actions: [
      {
        name: "run_command",
        args: {
          program: nodeBinary,
          args: [join(root, "scripts/p13-process-fixture.mjs"), "parent", marker],
          timeout_ms: 30000,
        },
      },
    ],
  });
  const task = await createTask(engine, profile, "Owned background tree " + index, project);
  const launchedAtMs = Date.now();
  await start(engine, task);
  const processIds = await eventually(async () => {
    try {
      const parent = JSON.parse(await readFile(marker + ".parent.json", "utf8"));
      const child = JSON.parse(await readFile(marker + ".child.json", "utf8"));
      assert.equal(parent.child, child.pid);
      return [parent.pid, child.pid];
    } catch {
      return null;
    }
  });
  assert(processIds.every(alive), "Both owned processes must actually be running");
  const processIdentities = await collector.identify(
    processIds.map((pid) => ({
      pid,
      path: nodeBinary,
      notBeforeMs: launchedAtMs,
    })),
  );
  await collector.targets([
    { ...engine.identity, role: "engine", phase: "process-lifecycle" },
    ...processIdentities.map((identity, i) => ({
      ...identity,
      role: i ? "tool-child" : "tool-parent",
      phase: "process-lifecycle",
    })),
  ]);
  await delay(context.options?.toolSampleHoldMs ?? 550);
  return { task, marker, processIds, processIdentities };
}
async function stoppedTree(tree) {
  await eventually(() => tree.processIds.every((pid) => !alive(pid)), 5000, 5);
  const before = await Promise.all(
    ["parent", "child"].map((role) => stat(tree.marker + "." + role + ".beat")),
  );
  await delay(110);
  const after = await Promise.all(
    ["parent", "child"].map((role) => stat(tree.marker + "." + role + ".beat")),
  );
  assert(
    before.every((value, i) => value.mtimeMs === after[i].mtimeMs),
    "Stopped processes must not keep writing heartbeat files",
  );
}
export async function stopSamples(context) {
  const acknowledgement = [],
    processExit = [],
    terminalState = [],
    raw = [];
  for (let index = 0; index < context.options.stopSamples; index++) {
    const tree = await startTree(context, index);
    const began = performance.now();
    await timedRequest(
      context.engine,
      { kind: "cancel", task_id: tree.task },
      "receipt",
      acknowledgement,
    );
    await eventually(() => tree.processIds.every((pid) => !alive(pid)), 5000, 5);
    processExit.push(performance.now() - began);
    await finished(context.engine, tree.task, "interrupted");
    terminalState.push(performance.now() - began);
    await stoppedTree(tree);
    const exitVerification = await context.collector.verify(tree.processIdentities);
    assert(exitVerification.every((row) => ["exited", "pid_reused"].includes(row.status)));
    raw.push({
      task: tree.task,
      processIds: tree.processIds,
      processIdentities: tree.processIdentities,
      exitVerification,
      acknowledgementMs: acknowledgement.at(-1),
      processExitMs: processExit.at(-1),
      terminalStateMs: terminalState.at(-1),
    });
  }
  return {
    count: raw.length,
    raw,
    metricsMs: {
      cancelAcknowledgement: distribution(acknowledgement),
      processTreeExit: distribution(processExit),
      interruptedState: distribution(terminalState),
    },
    toolStopInitialTargetMs: 2000,
    toolStopInitialTargetMet: processExit.every((value) => value <= 2000),
    allOwnedTreesExited: true,
    heartbeatWritesStopped: true,
    boundary:
      "Cancellation IPC acknowledgement is separate from a UI click-to-feedback measurement. Actual PID/start-time/path identity is captured before timing. Fast PID absence checks define the exit timing endpoint; identity and heartbeat checks occur afterward and are excluded. No external PowerShell startup is counted as tool-stop latency.",
  };
}
export async function crashAndRestart(context, reopen) {
  const tree = await startTree(context, "restart");
  const modelRequestsBefore = context.fixture.records.length;
  const exit = once(context.engine.child, "exit");
  const started = performance.now();
  context.engine.child.kill(); // Only this harness's owned engine handle.
  await exit;
  await eventually(() => tree.processIds.every((pid) => !alive(pid)), 5000, 5);
  const treeExitMs = performance.now() - started;
  await context.engine.close();
  context.engine = await reopen();
  const recovered = await snapshot(context.engine, tree.task);
  assert.equal(recovered.task.state, "interrupted");
  const samples = [];
  for (let index = 0; index < 20; index++) {
    await timedRequest(context.engine, { kind: "ping" }, "receipt", samples);
    await delay(50);
  }
  assert.equal(
    context.fixture.records.length,
    modelRequestsBefore,
    "Restart must not start model work automatically",
  );
  assert.equal((await snapshot(context.engine, tree.task)).task.state, "interrupted");
  await stoppedTree(tree);
  const exitVerification = await context.collector.verify(tree.processIdentities);
  assert(exitVerification.every((row) => ["exited", "pid_reused"].includes(row.status)));
  return {
    engineKilledByOwnedHandle: true,
    processIds: tree.processIds,
    processIdentities: tree.processIdentities,
    exitVerification,
    treeExitMs,
    recoveredTaskState: recovered.task.state,
    modelRequestsAddedAfterRestart: context.fixture.records.length - modelRequestsBefore,
    observationMs: 1000,
    controlAfterRestartMs: distribution(samples),
    manualResumeRequired: true,
  };
}
