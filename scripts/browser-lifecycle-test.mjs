import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, until } from "./tool-test-support.mjs";
import { browserTask } from "./browser-test-support.mjs";
const output = ".test-results/browser-lifecycle";
await mkdir(output, { recursive: true });
process.env.WORKPILOT_BROWSER_HEADLESS = "1";
const report = { at: new Date().toISOString(), platform: process.platform, checks: [] };
let engine;
try {
  engine = await launch();
  const folder = await mkdtemp(join(engine.directory, "lifecycle-"));
  const b = await browserTask(engine, folder);
  const s = await b.control({ kind: "start", channel: "chrome" });
  const defaults = await engine.request({ kind: "read", query: { kind: "tool_defaults" } });
  assert.notEqual(
    (await engine.request({ kind: "configure_tool_defaults", settings: defaults.settings })).kind,
    "error",
  );
  await until(async () => {
    try {
      process.kill(s.owned_pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(
    (await b.control({ kind: "sessions" })).sessions.find((v) => v.id === s.id).state,
    "disconnected",
  );
  report.checks.push("saving_global_permission_revokes_even_idle_browser_sessions");
  const start = b.raw({ kind: "browser_control", control: { kind: "start", channel: "chrome" } });
  await engine.request({ kind: "cancel", task_id: b.task });
  const starting = await start;
  assert(starting.kind === "error" || starting.kind === "workbench");
  await until(
    async () =>
      !(await b.control({ kind: "sessions" })).sessions.some((s) => s.state === "connected"),
  );
  report.checks.push("cancel_during_start_cannot_leave_a_late_connected_browser");
  const next = await b.control({ kind: "start", channel: "chrome" });
  assert(next.owned_pid);
  assert.equal(next.state, "connected");
  await b.control({ kind: "disconnect", session_id: next.id });
  for (let i = 0; i < 16; i++) await b.control({ kind: "pair", channel: "chrome" });
  assert.equal(
    (await b.raw({ kind: "browser_control", control: { kind: "pair", channel: "msedge" } })).kind,
    "error",
  );
  report.checks.push("connection_count_is_bounded_and_explicit_restart_works");
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = String(e);
  process.exitCode = 1;
} finally {
  await engine?.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
