import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { root } from "./cargo.mjs";
import { resourceCollector, databaseSizes } from "./p13-benchmark-metrics.mjs";
import { identity, verifyExited } from "./p13-desktop-resource-support.mjs";
const run = promisify(execFile);
export async function soakTelemetry({ session, binary, directory, output, intervalMs = 2000 }) {
  await mkdir(output, { recursive: true });
  const collector = await resourceCollector(output, { intervalMs, retainSamples: 2000 });
  const known = new Map();
  let current = [],
    extras = [],
    phase = "soak",
    tail = Promise.resolve();
  const serialize = (work) => {
    const pending = tail.then(work);
    tail = pending.catch(() => {});
    return pending;
  };
  const saveTargets = async () => {
    const merged = new Map(
      [...current, ...extras].map((row) => [identity(row), { ...row, phase }]),
    );
    await collector.targets([...merged.values()]);
  };
  const refresh = () =>
    serialize(async () => {
      assert(
        session.child.exitCode === null && session.child.signalCode === null,
        "Owned desktop exited during soak",
      );
      const { stdout } = await run(
        join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          join(root, "scripts/p13-desktop-processes.ps1"),
          "-DesktopPid",
          String(session.child.pid),
          "-DesktopPath",
          binary,
          "-ProfilePath",
          join(directory, "webview"),
          "-IncludeTools",
        ],
        { windowsHide: true, encoding: "utf8", timeout: 10000 },
      );
      current = JSON.parse(stdout);
      assert(current.every((row) => row.path && row.role !== "unverified-webview"));
      current.forEach((row) => known.set(identity(row), row));
      await saveTargets();
      await appendFile(
        join(output, "process-discovery.jsonl"),
        JSON.stringify({ atMs: Date.now(), phase, processes: current }) + "\n",
      );
      return current;
    });
  try {
    await refresh();
  } catch (error) {
    await collector.close().catch(() => {});
    throw error;
  }
  return {
    collector,
    known,
    refresh,
    get current() {
      return current;
    },
    get currentPhase() {
      return phase;
    },
    async phase(value) {
      phase = value;
      await serialize(saveTargets);
    },
    check() {
      collector.check();
    },
    adapter: {
      identify: (entries) => collector.identify(entries),
      verify: (entries) => collector.verify(entries),
      targets: (entries) =>
        serialize(async () => {
          extras = entries.filter((row) => row.role?.startsWith("tool-"));
          extras.forEach((row) => known.set(identity(row), row));
          await saveTargets();
        }),
    },
    async monitor(promise, pollMs = 250) {
      let done = false,
        error;
      const observed = promise.finally(() => {
        done = true;
      });
      observed.catch(() => {});
      while (!done) {
        try {
          await refresh();
        } catch (e) {
          error = e;
          break;
        }
        if (!done && pollMs) await delay(pollMs);
      }
      const value = await observed;
      if (error) throw error;
      return value;
    },
    async recordDatabase(cycle) {
      const data = await databaseSizes(directory);
      await appendFile(
        join(output, "database-growth.jsonl"),
        JSON.stringify({ atMs: Date.now(), cycle, files: data }) + "\n",
      );
      return data;
    },
    async close() {
      await tail;
      await collector.close();
    },
    async verifyExit() {
      return verifyExited(known, output);
    },
  };
}
