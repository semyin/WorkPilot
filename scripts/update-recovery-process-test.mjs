import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { copyFile, mkdir, mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { launch, create, snapshot, until } from "./tool-test-support.mjs";
import { packageUpdate } from "./update-package.mjs";

const exec = promisify(execFile);
const output = resolve(
  process.env.WORKPILOT_TEST_OUTPUT || ".test-results/update-recovery-process",
);
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "独立恢复-"));
const helper = resolve(
  process.env.WORKPILOT_UPDATE_BINARY || "target/p12-update/debug/workpilot-update.exe",
);
const engine = resolve(
  process.env.WORKPILOT_ENGINE_BINARY || "target/release/workpilot-sidecar.exe",
);
const desktop = resolve(
  process.env.WORKPILOT_DESKTOP_BINARY || "target/release/workpilot-desktop.exe",
);
const childBinary = resolve(process.env.WORKPILOT_UPDATE_TEST_CHILD_BINARY || "");
assert(
  process.env.WORKPILOT_UPDATE_TEST_CHILD_BINARY,
  "Provide the compiled test-only Rust process binary",
);
process.env.WORKPILOT_ENGINE_BINARY = engine;
const hash = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  checks: [],
  scope:
    "A cfg(test)-only child executes the production directory switch, then is forcibly terminated at application_saved. The real copied updater is launched without arguments and its native dialogs are controlled only by its created PID. This is not a hardware power-loss test.",
  binarySha256: {
    helper: await hash(helper),
    engine: await hash(engine),
    testOnlyChild: await hash(childBinary),
  },
};
const version = JSON.parse(await readFile("package.json", "utf8")).version;
const source = join(directory, "candidate");
await mkdir(source);
for (const [path, name] of [
  [helper, "workpilot-update.exe"],
  [engine, "workpilot-sidecar.exe"],
  [desktop, "workpilot-desktop.exe"],
])
  await copyFile(path, join(source, name));
const archive = join(directory, "candidate.wpupdate");
await packageUpdate({
  source,
  output: archive,
  privateKey: resolve(".local/update-signing/development-private.pem"),
  version,
  notes: "Actual isolated process recovery drill",
});
const run = (args) =>
  exec(helper, args, { windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 ** 2 });
let interrupted;
async function fixture(name) {
  const base = join(directory, name),
    install = join(base, "application"),
    root = join(base, "data");
  await mkdir(install, { recursive: true });
  await copyFile(helper, join(install, "workpilot-update.exe"));
  await writeFile(join(install, "original.txt"), "original program");
  const session = await launch(root);
  const task = await create(session, "chat_completions", "retained interrupted update task");
  const beforeState = (await snapshot(session, task)).task.state;
  await session.close();
  const data = join(root, "test"),
    before = await hash(join(data, "workpilot.sqlite3"));
  const request = join(base, "prepare.json");
  const input = { install, data, source: archive, current_version: "0.1.0-alpha.12.14" };
  await writeFile(request, JSON.stringify(input));
  input.fingerprint = JSON.parse((await run(["--inspect", request])).stdout).fingerprint;
  await writeFile(request, JSON.stringify(input));
  const prepared = JSON.parse((await run(["--prepare", request])).stdout);
  const record = join(prepared.job, "prepared.json");
  const entry = JSON.parse((await run(["--create-recovery", record])).stdout);
  assert.equal(await hash(entry.executable), await hash(helper));
  assert((await readFile(entry.instructions, "utf8")).includes("双击"));
  return { base, install, root, data, before, beforeState, task, prepared, record, entry };
}
async function dialog(f, expected) {
  await exec(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve("scripts/update-recovery-dialog-test.ps1"),
      "-Executable",
      f.entry.executable,
      "-Expected",
      expected,
      "-OutputDirectory",
      join(output, expected),
    ],
    { windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 ** 2 },
  );
  const result = JSON.parse(await readFile(join(output, expected, expected + ".json"), "utf8"));
  assert.equal(result.state, "passed");
  return result;
}
try {
  const f = await fixture("interrupted");
  await dialog(f, "unstarted");
  assert.equal(await readFile(join(f.install, "original.txt"), "utf8"), "original program");
  assert.equal(await hash(join(f.data, "workpilot.sqlite3")), f.before);
  assert.equal(JSON.parse(await readFile(f.record, "utf8")).phase, "prepared");
  report.checks.push(
    "unstarted_recovery_entry_displays_status_without_changing_program_data_or_update_state",
  );
  interrupted = spawn(
    childBinary,
    [
      "--exact",
      "update::recovery_process_test::interrupt_after_original_program_was_saved",
      "--ignored",
      "--nocapture",
    ],
    {
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, WORKPILOT_RECOVERY_TEST_RECORD: f.record },
    },
  );
  const boundary = join(f.prepared.job, "test-child-at-boundary.json");
  await until(async () => {
    try {
      return JSON.parse(await readFile(boundary, "utf8"));
    } catch {
      return false;
    }
  }, 180000);
  const reached = JSON.parse(await readFile(boundary, "utf8"));
  assert.equal(reached.pid, interrupted.pid);
  assert.equal(reached.phase, "application_saved");
  await assert.rejects(stat(f.install));
  assert.equal(
    await readFile(join(f.prepared.job, "previous/original.txt"), "utf8"),
    "original program",
  );
  const ended = once(interrupted, "exit");
  interrupted.kill("SIGKILL");
  await ended;
  report.interruption = {
    mechanism: "forced termination of independent cfg(test) child",
    phase: reached.phase,
    pid: reached.pid,
    originalShortcutTargetMissing: true,
  };
  await dialog(f, "cancel");
  await assert.rejects(stat(f.install));
  assert.equal(await hash(join(f.data, "workpilot.sqlite3")), f.before);
  report.checks.push(
    "real_process_interruption_and_recovery_cancel_preserve_the_known_previous_program_and_data",
  );
  await dialog(f, "restore");
  assert.equal(await readFile(join(f.install, "original.txt"), "utf8"), "original program");
  assert.equal(await hash(join(f.data, "workpilot.sqlite3")), f.before);
  const restored = await launch(f.root);
  assert.equal((await snapshot(restored, f.task)).task.state, f.beforeState);
  await restored.close();
  assert.equal(JSON.parse(await readFile(f.record, "utf8")).phase, "rolled_back");
  report.checks.push(
    "actual_double_click_entry_restores_the_missing_install_and_original_database_with_visible_success",
  );

  const complete = await fixture("completed");
  await exec(
    complete.entry.executable,
    ["--apply", complete.record, "--wait", String(interrupted.pid)],
    { windowsHide: true, timeout: 180000 },
  );
  assert.equal(JSON.parse(await readFile(complete.record, "utf8")).phase, "committed");
  await writeFile(join(complete.data, "new-work.txt"), "work added after the successful update");
  const installedHash = await hash(join(complete.install, "workpilot-desktop.exe"));
  await dialog(complete, "completed");
  assert.equal(
    await readFile(join(complete.data, "new-work.txt"), "utf8"),
    "work added after the successful update",
  );
  assert.equal(await hash(join(complete.install, "workpilot-desktop.exe")), installedHash);
  report.checks.push("completed_update_entry_displays_status_and_never_rolls_back_new_work");

  const altered = JSON.parse(await readFile(complete.record, "utf8"));
  altered.preview.fingerprint = "unexpected-change";
  await writeFile(complete.record, JSON.stringify(altered));
  const beforeFailure = await hash(join(complete.data, "workpilot.sqlite3"));
  await dialog(complete, "failed");
  assert.equal(await hash(join(complete.data, "workpilot.sqlite3")), beforeFailure);
  assert.equal(await hash(join(complete.install, "workpilot-desktop.exe")), installedHash);
  report.checks.push(
    "altered_recovery_record_produces_a_visible_error_without_changing_program_or_data",
  );
  report.state = "passed";
} catch (error) {
  report.state = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  if (interrupted?.exitCode === null && interrupted.signalCode === null) interrupted.kill();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
