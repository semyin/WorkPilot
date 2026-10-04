import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { root } from "./cargo.mjs";
import { distribution } from "./p13-benchmark-metrics.mjs";

const runFile = promisify(execFile);
const powershell = join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
const helper = join(root, "scripts/p13-desktop-processes.ps1");
export const identity = (row) => `${row.pid}:${row.startedAtMs}:${row.path.toLowerCase()}`;
async function inspect(args) {
  const { stdout } = await runFile(
    powershell,
    ["-NoProfile", "-NonInteractive", "-File", helper, ...args],
    {
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 10000,
    },
  );
  return JSON.parse(stdout);
}
export async function discover(session, binary, directory) {
  assert(
    session.child.exitCode === null && session.child.signalCode === null,
    "The owned desktop child handle must still be alive during attribution",
  );
  const rows = await inspect([
    "-Operation",
    "discover",
    "-DesktopPid",
    String(session.child.pid),
    "-DesktopPath",
    binary,
    "-ProfilePath",
    join(directory, "webview"),
  ]);
  assert(
    rows.every((row) => row.path),
    "Every owned process must expose its executable path",
  );
  assert(rows.some((row) => row.role === "desktop"));
  const desktopIdentity = identity(rows.find((row) => row.role === "desktop"));
  session.resourceDesktopIdentity ||= desktopIdentity;
  assert.equal(desktopIdentity, session.resourceDesktopIdentity, "Desktop PID identity changed");
  assert(rows.some((row) => row.role === "engine"));
  assert(
    rows.some((row) => row.role === "ui-webview"),
    "An isolated UI WebView must be attributed",
  );
  assert(
    !rows.some((row) => row.role === "unverified-webview"),
    "UI WebView profile could not be attributed",
  );
  return rows;
}
export async function verifyExited(known, output) {
  const path = join(output, "owned-process-identities.json");
  await writeFile(path, JSON.stringify([...known.values()], null, 2));
  let rows = [];
  const deadline = performance.now() + 10000;
  do {
    rows = await inspect(["-Operation", "verify", "-ExpectedFile", path]);
    if (rows.every((row) => ["exited", "pid_reused"].includes(row.status))) return rows;
    await delay(250);
  } while (performance.now() < deadline);
  throw new Error("Owned desktop processes did not exit: " + JSON.stringify(rows));
}
export function aggregate(samples, phase, logicalProcessors, discoveries) {
  const previous = new Map(),
    cycles = new Map(),
    captured = new Map();
  for (const row of samples.filter((row) => row.phase === phase)) {
    const key = `${row.pid}:${row.startedAtMs}`;
    if (!captured.has(row.tick))
      captured.set(row.tick, { identities: new Set(), targetVersion: row.targetVersion });
    captured.get(row.tick).identities.add(key);
    const before = previous.get(key);
    const cpu =
      before && row.atMs > before.atMs && row.cpuMs >= before.cpuMs
        ? ((row.cpuMs - before.cpuMs) / (row.atMs - before.atMs) / logicalProcessors) * 100
        : null;
    previous.set(key, row);
    const group = `${row.role}:${row.tick}`;
    if (!cycles.has(group))
      cycles.set(group, {
        role: row.role,
        tick: row.tick,
        atMs: row.atMs,
        processIdentities: [],
        workingSetBytes: 0,
        privateBytes: 0,
        cpuPercent: 0,
        completeCpu: true,
      });
    const cycle = cycles.get(group);
    cycle.processIdentities.push(key);
    cycle.workingSetBytes += row.workingSetBytes;
    cycle.privateBytes += row.privateBytes;
    cycle.completeCpu &&= cpu !== null;
    cycle.cpuPercent += cpu || 0;
  }
  const rows = [...cycles.values()];
  const snapshotIds = (entry) => entry.identities.map((id) => id.split(":").slice(0, 2).join(":"));
  const legacySets = new Set(discoveries.map((entry) => snapshotIds(entry).sort().join("|")));
  const coverage = [...captured].map(([tick, capture]) => {
    let expected = discoveries.find((entry) => entry.targetVersion === capture.targetVersion);
    if (capture.targetVersion === undefined || capture.targetVersion === null) {
      assert.equal(
        legacySets.size,
        1,
        "Older raw samples require one stable, fully discovered identity set",
      );
      expected = discoveries[0];
    }
    assert(expected, "Every sample cycle must refer to an observed target snapshot");
    const ids = snapshotIds(expected);
    return {
      tick,
      targetVersion: capture.targetVersion ?? null,
      complete:
        ids.length === capture.identities.size && ids.every((id) => capture.identities.has(id)),
      expectedProcesses: ids.length,
      sampledProcesses: capture.identities.size,
    };
  });
  const completeTicks = new Set(coverage.filter((row) => row.complete).map((row) => row.tick));
  const roles = [...new Set(rows.map((row) => row.role))];
  return {
    phase,
    rawCycles: rows,
    cycleCoverage: coverage,
    excludedIncompleteCycles: coverage.filter((row) => !row.complete),
    groups: roles.map((role) => {
      const points = rows.filter((row) => row.role === role && completeTicks.has(row.tick));
      return {
        role,
        samples: points.length,
        observedProcesses: new Set(points.flatMap((row) => row.processIdentities)).size,
        workingSetBytes: distribution(points.map((row) => row.workingSetBytes)),
        privateBytes: distribution(points.map((row) => row.privateBytes)),
        cpuPercentOfWholeMachine: distribution(
          points.filter((row) => row.completeCpu).map((row) => row.cpuPercent),
        ),
        processCounts: distribution(points.map((row) => row.processIdentities.length)),
      };
    }),
  };
}
export async function samplePhase(context, phase) {
  const { session, binary, directory, collector, known, machine, sampleMs, minimumSamples } =
    context;
  const began = performance.now();
  const beganAtMs = Date.now();
  const discoveries = [];
  const activate = async (rows) => {
    const targetVersion = `${phase}-${discoveries.length}`;
    discoveries.push({ atMs: Date.now(), targetVersion, identities: rows.map(identity) });
    await collector.targets(rows.map((row) => ({ ...row, phase, targetVersion })));
  };
  if (context.currentRows) await activate(context.currentRows);
  do {
    const discovered = await discover(session, binary, directory);
    discovered.forEach((row) => known.set(identity(row), row));
    context.currentRows = discovered;
    await activate(discovered);
    await delay(1500);
  } while (performance.now() - began < sampleMs);
  const endedAtMs = Date.now();
  await collector.targets([]);
  const result = aggregate(
    collector.samples.filter((row) => row.atMs >= beganAtMs && row.atMs <= endedAtMs),
    phase,
    machine.logicalProcessors,
    discoveries,
  );
  for (const role of ["desktop", "engine", "ui-webview"]) {
    const group = result.groups.find((row) => row.role === role);
    assert(group && group.samples >= minimumSamples, `Too few ${phase}/${role} resource samples`);
  }
  return {
    ...result,
    beganAtMs,
    endedAtMs,
    elapsedMs: Math.round(performance.now() - began),
    discoveries,
  };
}
