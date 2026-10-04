import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { distribution } from "./p13-benchmark-metrics.mjs";

// Retain numbers rather than millions of full process objects. Raw identities stay in JSONL.
export async function summarizeResources(path, logicalProcessors) {
  const groups = new Map(),
    previous = new Map(),
    identities = new Set(),
    pids = new Map();
  let tick = null,
    cycle = new Map(),
    records = 0,
    firstAt = null,
    lastAt = null;
  const flush = () => {
    for (const [role, point] of cycle) {
      if (!groups.has(role))
        groups.set(role, { working: [], private: [], cpu: [], counts: [], buckets: new Map() });
      const g = groups.get(role);
      g.working.push(point.working);
      g.private.push(point.private);
      g.counts.push(point.count);
      if (point.cpuValid) g.cpu.push(point.cpu);
      const bucket = Math.floor((point.at - firstAt) / (5 * 60 * 1000));
      if (!g.buckets.has(bucket)) g.buckets.set(bucket, { working: [], private: [], cpu: [] });
      const b = g.buckets.get(bucket);
      b.working.push(point.working);
      b.private.push(point.private);
      if (point.cpuValid) b.cpu.push(point.cpu);
    }
    cycle = new Map();
  };
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    records++;
    if (records > 2000000)
      throw new Error("Resource summary exceeds this benchmark's bounded input size");
    firstAt ??= row.atMs;
    lastAt = row.atMs;
    if (tick !== null && row.tick !== tick) flush();
    tick = row.tick;
    const key = `${row.pid}:${row.startedAtMs}`;
    identities.add(key);
    if (!pids.has(row.pid)) pids.set(row.pid, new Set());
    pids.get(row.pid).add(row.startedAtMs);
    if (!cycle.has(row.role))
      cycle.set(row.role, {
        at: row.atMs,
        working: 0,
        private: 0,
        cpu: 0,
        cpuValid: true,
        count: 0,
      });
    const point = cycle.get(row.role);
    point.working += row.workingSetBytes;
    point.private += row.privateBytes;
    point.count++;
    const before = previous.get(key);
    if (before && row.atMs > before.atMs && row.cpuMs >= before.cpuMs)
      point.cpu +=
        ((row.cpuMs - before.cpuMs) / (row.atMs - before.atMs) / logicalProcessors) * 100;
    else point.cpuValid = false;
    previous.set(key, row);
  }
  flush();
  return {
    records,
    observedProcessIdentities: identities.size,
    firstAtMs: firstAt,
    lastAtMs: lastAt,
    reusedPids: [...pids]
      .filter(([, starts]) => starts.size > 1)
      .map(([pid, starts]) => ({ pid, startedAtMs: [...starts] })),
    scope:
      "Per-cycle sums of identity-verified observed processes; discovery/sampling may miss very short-lived processes and transition cycles can be partial. Dedicated-browser stop cases separately require complete snapshots. Working-set sums include shared pages; private bytes are committed private memory. Five-minute buckets describe this run, not a leak diagnosis.",
    groups: [...groups].map(([role, g]) => ({
      role,
      cycles: g.working.length,
      workingSetBytes: distribution(g.working),
      privateBytes: distribution(g.private),
      cpuPercentOfWholeMachine: distribution(g.cpu),
      processCounts: distribution(g.counts),
      fiveMinuteBuckets: [...g.buckets].map(([index, b]) => ({
        index,
        workingSetBytes: distribution(b.working),
        privateBytes: distribution(b.private),
        cpuPercentOfWholeMachine: distribution(b.cpu),
      })),
    })),
  };
}
