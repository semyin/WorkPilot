import { spawn, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { cpus, totalmem, freemem, release } from "node:os";
import { createWriteStream } from "node:fs";
import { writeFile, rename, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { finished as streamFinished } from "node:stream/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { root } from "./cargo.mjs";

const powershell = join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
const runFile = promisify(execFile);
export function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (n) => sorted[Math.max(0, Math.ceil((n / 100) * sorted.length) - 1)] ?? null;
  const round = (n) => (n === null ? null : Number(n.toFixed(3)));
  return {
    count: sorted.length,
    min: round(sorted[0] ?? null),
    p50: round(percentile(50)),
    p95: round(percentile(95)),
    max: round(sorted.at(-1) ?? null),
    mean: sorted.length ? round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : null,
  };
}
export function machine() {
  const system = JSON.parse(
    execFileSync(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", windowsHide: true },
    ),
  );
  return {
    os: system,
    architecture: process.arch,
    kernel: release(),
    cpuModel: cpus()[0].model,
    logicalProcessors: cpus().length,
    memoryBytes: totalmem(),
    availableMemoryBeforeBytes: freemem(),
    node: process.version,
  };
}
export async function databaseSizes(directory) {
  return Object.fromEntries(
    await Promise.all(
      ["workpilot.sqlite3", "workpilot.sqlite3-wal", "workpilot.sqlite3-shm"].map(async (name) => {
        const bytes = await stat(join(directory, "test", name))
          .then((s) => s.size)
          .catch(() => 0);
        return [name, bytes];
      }),
    ),
  );
}
export async function resourceCollector(output, options = {}) {
  const targetsPath = join(output, "resource-targets.json");
  const stopPath = join(output, "sampler-stop");
  const rawPath = join(output, "resources.jsonl");
  await writeFile(targetsPath, "[]");
  const outputStream = createWriteStream(rawPath);
  const samples = [];
  let sampleCount = 0;
  const retainSamples = options.retainSamples ?? Infinity;
  const inspect = async (entries, operation) => {
    const targets = join(output, `identity-${operation}-${crypto.randomUUID()}.json`);
    await writeFile(targets, JSON.stringify(entries));
    const { stdout } = await runFile(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        join(root, "scripts/p13-process-identities.ps1"),
        "-Targets",
        targets,
        "-Operation",
        operation,
      ],
      { windowsHide: true, encoding: "utf8", timeout: 10000 },
    );
    return JSON.parse(stdout);
  };
  const child = spawn(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      join(root, "scripts/p13-process-sampler.ps1"),
      "-Targets",
      targetsPath,
      "-StopFile",
      stopPath,
      "-IntervalMs",
      String(options.intervalMs ?? 250),
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  let samplingError;
  outputStream.on("error", (error) => {
    samplingError = error;
  });
  child.on("error", (error) => {
    samplingError = error;
  });
  child.stderr.on("data", (value) => {
    stderr = (stderr + value.toString()).slice(-4096);
  });
  lines.on("line", (line) => {
    try {
      const sample = JSON.parse(line);
      sampleCount++;
      samples.push(sample);
      if (samples.length > retainSamples)
        samples.splice(0, Math.max(1, Math.ceil(retainSamples / 4)));
      options.onSample?.(sample);
      outputStream.write(line + "\n");
      if (outputStream.writableLength > 16 * 1024 * 1024)
        throw new Error("Resource evidence writer cannot keep up with samples");
    } catch (error) {
      samplingError = error;
    }
  });
  return {
    pid: child.pid,
    samples,
    get sampleCount() {
      return sampleCount;
    },
    check() {
      if (samplingError) throw samplingError;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error("Resource sampler exited before collection ended");
    },
    identify(entries) {
      return inspect(entries, "identify");
    },
    verify(entries) {
      return inspect(entries, "verify");
    },
    async targets(entries) {
      await writeFile(targetsPath + ".pending", JSON.stringify(entries));
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(targetsPath + ".pending", targetsPath);
          break;
        } catch (error) {
          if (attempt >= 20 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
          await delay(10);
        }
      }
    },
    async close() {
      await writeFile(stopPath, "stop");
      if (child.exitCode === null && child.signalCode === null) {
        const timeout = setTimeout(() => child.kill(), 5000);
        try {
          await once(child, "exit");
        } finally {
          clearTimeout(timeout);
        }
      }
      lines.close();
      const completion = streamFinished(outputStream);
      outputStream.end();
      await completion;
      if (child.exitCode !== 0) throw new Error("Resource sampler failed: " + stderr);
      if (samplingError) throw samplingError;
      if (!sampleCount) throw new Error("Resource sampler produced no measurements");
    },
    summarize(logicalProcessors) {
      const groups = new Map();
      for (const sample of samples) {
        const key = sample.role + ":" + sample.phase;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(sample);
      }
      return [...groups].map(([label, rows]) => {
        const last = new Map();
        const cpu = [];
        for (const row of rows) {
          const identity = `${row.pid}:${row.startedAtMs ?? "legacy"}`;
          const before = last.get(identity);
          if (before && row.atMs > before.atMs && row.cpuMs >= before.cpuMs)
            cpu.push(
              ((row.cpuMs - before.cpuMs) / (row.atMs - before.atMs) / logicalProcessors) * 100,
            );
          last.set(identity, row);
        }
        return {
          label,
          samples: rows.length,
          processes: last.size,
          workingSetBytes: distribution(rows.map((r) => r.workingSetBytes)),
          privateBytes: distribution(rows.map((r) => r.privateBytes)),
          cpuPercentOfWholeMachine: distribution(cpu),
          handles: distribution(rows.map((r) => r.handles)),
          threads: distribution(rows.map((r) => r.threads)),
        };
      });
    },
  };
}
