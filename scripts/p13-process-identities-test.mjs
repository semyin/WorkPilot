import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { root } from "./cargo.mjs";

const base = join(root, ".test-results/p13-process-identities");
await mkdir(base, { recursive: true });
const output = await mkdtemp(join(base, "run-"));
const targets = join(output, "targets.json");
const inspect = (operation) =>
  JSON.parse(
    execFileSync(
      join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        join(root, "scripts/p13-process-identities.ps1"),
        "-Operation",
        operation,
        "-Targets",
        targets,
      ],
      { encoding: "utf8", windowsHide: true },
    ),
  );
await writeFile(targets, JSON.stringify([{ pid: process.pid, path: process.execPath }]));
const [owned] = inspect("identify");
assert.equal(owned.pid, process.pid);
assert.equal(owned.path.toLowerCase(), process.execPath.toLowerCase());
assert(Number.isInteger(owned.startedAtMs) && owned.startedAtMs > 0);
await writeFile(
  targets,
  JSON.stringify([
    owned,
    { ...owned, startedAtMs: owned.startedAtMs - 1 },
    { ...owned, path: join(output, "different.exe") },
    { ...owned, pid: 2147483647 },
  ]),
);
const verified = inspect("verify");
assert.deepEqual(
  verified.map((row) => row.status),
  ["alive", "pid_reused", "pid_reused", "exited"],
);
const report = {
  at: new Date().toISOString(),
  status: "passed",
  platform: process.platform,
  command: "node scripts/p13-process-identities-test.mjs",
  scope:
    "Uses this test's own actual Node process. Wrong start time/path simulate identity mismatches; this is not a claim that Windows was forced to recycle a PID.",
  checks: [
    "read_owned_process_actual_identity",
    "reject_same_pid_with_wrong_start_time",
    "reject_same_pid_with_wrong_executable",
    "missing_pid_is_exited",
  ],
  owned,
  verified,
};
await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify({
    status: report.status,
    checks: report.checks.length,
    report: join(output, "report.json"),
  }),
);
