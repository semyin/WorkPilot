import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { root } from "./cargo.mjs";
import {
  launch,
  profile,
  setFixture,
  terminal,
  snapshot,
  start,
  until,
  processes,
} from "./tool-test-support.mjs";
import { startToolFixture } from "../services/execution-fixtures/tools.mjs";
import { startTeamFixture } from "../services/execution-fixtures/teams.mjs";

const output = process.env.WORKPILOT_TEST_OUTPUT || ".test-results/schedules-engine";
await mkdir(output, { recursive: true });
const fixture = await startToolFixture(),
  teams = await startTeamFixture();
setFixture(fixture);
const binary =
  process.env.WORKPILOT_ENGINE_BINARY ||
  join(root, "target/debug/workpilot-engine" + (process.platform === "win32" ? ".exe" : ""));
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  binary: {
    path: binary,
    sha256: createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
  },
  service:
    "Actual Rust engine, SQLite, local files and deterministic HTTP model fixtures. No real model or OS sleep.",
  checks: [],
};
let engine;
const localUtc = (ms) => new Date(ms).toISOString().slice(0, 19);
const onceSoon = (ms = 4000) => ({ kind: "once", local: localUtc(Date.now() + ms) });
async function admin(action, rid) {
  const r = await engine.request({ kind: "schedules", action }, rid);
  assert.equal(r.kind, "schedules", JSON.stringify(r));
  return r.data;
}
const history = async (id) =>
  (await admin({ kind: "history", schedule_id: id, before: null, limit: 64 })).items;
const run = async (id, revision = 1, rid) =>
  (await admin({ kind: "run_now", schedule_id: id, revision }, rid)).occurrence;
const rejected = (v) => assert(["error", "model_error"].includes(v.kind), JSON.stringify(v));
async function provider(name, protocol = "responses", url = fixture.url) {
  const p = profile(protocol, name);
  p.base_url = url;
  assert.equal(
    (
      await engine.request({
        kind: "save_provider",
        profile: p,
        secret: null,
        clear_credential: false,
      })
    ).kind,
    "provider_saved",
  );
  return p;
}
async function save(p, extra = {}) {
  const spec = {
    title: p.label,
    goal: "Scheduled fixture validation",
    project_id: null,
    profile_id: p.id,
    mode: "chat",
    permission: "request_approval",
    review_profile_id: null,
    commands_enabled: false,
    timezone: "UTC",
    rule: { kind: "interval", minutes: 10080 },
    enabled: false,
    ...extra,
  };
  const r = await admin({ kind: "save", schedule_id: null, revision: 0, spec });
  return r.schedule_id;
}
async function project() {
  const path = join(engine.directory, "project-" + crypto.randomUUID());
  await mkdir(path);
  const settings = {
    name: "Scheduled files",
    root_path: path,
    default_profile_id: null,
    permission: "request_approval",
    rules: "",
    revision: 0,
  };
  const r = await engine.request({
    kind: "workspace",
    action: { kind: "save_project", project_id: null, settings },
  });
  assert.equal(r.kind, "workspace", JSON.stringify(r));
  return { id: r.data.project.id, path, settings };
}
async function tools(task) {
  const r = await engine.request({ kind: "read", query: { kind: "task_tools", task_id: task } });
  assert.equal(r.kind, "task_tools");
  return r.state;
}
try {
  engine = await launch();
  assert((await admin({ kind: "timezones" })).zones.includes("America/New_York"));
  for (const protocol of ["responses", "chat_completions", "messages"]) {
    const name = "schedule-" + protocol;
    fixture.recipes.set(name, []);
    const p = await provider(name, protocol),
      id = await save(p),
      rid = crypto.randomUUID();
    const first = await run(id, 1, rid);
    assert.equal((await terminal(engine, first.task_id)).task.state, "completed");
    const retry = await run(id, 1, rid);
    assert.equal(retry.id, first.id);
    assert.equal(retry.task_id, first.task_id);
    const second = await run(id);
    assert.notEqual(first.task_id, second.task_id);
    assert.equal((await terminal(engine, second.task_id)).task.state, "completed");
    assert.equal((await history(id)).length, 2);
  }
  report.checks.push(
    "three_protocols_create_independent_tasks_and_manual_request_retry_is_idempotent",
  );

  const p = await provider("schedule-timer");
  fixture.recipes.set(p.model, []);
  const timed = await save(p, { enabled: true, rule: onceSoon() });
  const timer = await until(async () => (await history(timed)).find((o) => o.task_id));
  assert.equal(timer.trigger, "timer");
  assert.equal((await terminal(engine, timer.task_id)).task.state, "completed");
  await delay(800);
  assert.equal((await history(timed)).length, 1);
  const directory = engine.directory;
  await engine.close();
  engine = await launch(directory);
  assert.equal((await history(timed)).length, 1);
  report.checks.push("real_wall_clock_once_trigger_persists_and_never_repeats_after_restart");

  const proj = await project(),
    writer = await provider("schedule-writer");
  fixture.recipes.set(writer.model, [
    {
      name: "write_file",
      args: { path: "scheduled.txt", text: "one approved schedule", expected_sha256: null },
    },
  ]);
  const approvePlan = await save(writer, {
    project_id: proj.id,
    mode: "execute",
    enabled: true,
    rule: onceSoon(),
  });
  const manual = await run(approvePlan);
  assert.equal((await terminal(engine, manual.task_id)).task.state, "awaiting_approval");
  assert.equal(await readFile(join(proj.path, "scheduled.txt"), "utf8").catch(() => null), null);
  rejected(
    await engine.request({
      kind: "schedules",
      action: { kind: "run_now", schedule_id: approvePlan, revision: 1 },
    }),
  );
  await until(async () => (await history(approvePlan)).some((o) => o.state === "overlap"));
  const a = (await tools(manual.task_id)).approvals.find((v) => v.state === "pending");
  assert.equal(
    (
      await engine.request({
        kind: "decide_tool_approval",
        task_id: manual.task_id,
        approval_id: a.id,
        fingerprint: a.fingerprint,
        approve: true,
      })
    ).kind,
    "receipt",
  );
  await start(engine, manual.task_id);
  assert.equal((await terminal(engine, manual.task_id)).task.state, "completed");
  assert.equal(await readFile(join(proj.path, "scheduled.txt"), "utf8"), "one approved schedule");
  assert.equal((await tools(manual.task_id)).changes.length, 1);
  report.checks.push(
    "scheduled_write_waits_for_human_approval_timer_skips_overlap_and_approved_change_runs_once",
  );

  for (const permission of ["request_approval", "auto_review", "full_access"]) {
    const folder = await project(),
      reviewer = await provider("review-approve");
    const plan = await save(writer, {
      project_id: folder.id,
      mode: "execute",
      permission,
      review_profile_id: permission === "auto_review" ? reviewer.id : null,
    });
    const occurrence = await run(plan);
    const state = await terminal(engine, occurrence.task_id);
    if (permission === "request_approval") {
      assert.equal(state.task.state, "awaiting_approval");
      const a = (await tools(occurrence.task_id)).approvals.find((a) => a.state === "pending");
      assert.equal(
        (
          await engine.request({
            kind: "decide_tool_approval",
            task_id: occurrence.task_id,
            approval_id: a.id,
            fingerprint: a.fingerprint,
            approve: false,
          })
        ).kind,
        "receipt",
      );
      await start(engine, occurrence.task_id);
      assert.equal(
        (await terminal(engine, occurrence.task_id)).latest_run.reason,
        "approval_rejected",
      );
      assert.equal(
        await readFile(join(folder.path, "scheduled.txt"), "utf8").catch(() => null),
        null,
      );
    } else {
      assert.equal(state.task.state, "completed", JSON.stringify(state.latest_run));
      assert.equal(
        await readFile(join(folder.path, "scheduled.txt"), "utf8"),
        "one approved schedule",
      );
      assert.equal(
        (await tools(occurrence.task_id)).approvals[0].decided_by,
        permission === "auto_review"
          ? "independent_model_review"
          : "rule:user_selected_full_access",
      );
    }
  }
  report.checks.push(
    "all_three_permissions_preserved_rejection_has_no_file_effect_review_evidence_is_saved",
  );

  const waiting = await provider("schedule-question");
  fixture.recipes.set(waiting.model, [
    { name: "ask_user", args: { question: "Choose next action", choices: ["Continue"] } },
  ]);
  const waitPlan = await save(waiting),
    waitRun = await run(waitPlan);
  assert.equal((await terminal(engine, waitRun.task_id)).task.state, "awaiting_input");
  await admin({ kind: "delete", schedule_id: waitPlan, revision: 1 });
  assert.equal((await snapshot(engine, waitRun.task_id)).task.state, "awaiting_input");
  assert.equal(
    (await engine.request({ kind: "enqueue", task_id: waitRun.task_id, text: "Continue" })).kind,
    "receipt",
  );
  await start(engine, waitRun.task_id);
  assert.equal((await terminal(engine, waitRun.task_id)).task.state, "completed");
  report.checks.push("deleting_plan_keeps_active_task_and_history_user_can_continue_it");

  const bad = await provider("runtime-error"),
    badPlan = await save(bad);
  const failed = await run(badPlan);
  assert.equal((await terminal(engine, failed.task_id)).task.state, "failed");
  await delay(400);
  assert.equal(fixture.records.filter((v) => v.model === bad.model).length, 1);
  assert.equal((await history(badPlan))[0].task_state, "failed");
  report.checks.push("model_quota_error_is_visible_and_has_no_automatic_retry_or_fallback");

  const changed = await provider("schedule-changed"),
    changedPlan = await save(changed, { enabled: true, rule: onceSoon() });
  changed.label = "Edited provider";
  assert.equal(
    (
      await engine.request({
        kind: "save_provider",
        profile: changed,
        secret: null,
        clear_credential: false,
      })
    ).kind,
    "provider_saved",
  );
  const blocked = await until(async () => (await history(changedPlan))[0]);
  assert.equal(blocked.state, "failed");
  assert.equal(blocked.task_id, null);
  assert.match(blocked.reason, /Model changed/);
  const replaced = await project(),
    replacedPlan = await save(p, { project_id: replaced.id });
  const preserved = replaced.path + "-preserved";
  for (const path of [replaced.path, preserved])
    assert(resolve(path).startsWith(resolve(engine.directory) + sep));
  await rename(replaced.path, preserved);
  await mkdir(replaced.path);
  const rootChanged = await run(replacedPlan);
  assert.equal(rootChanged.state, "failed");
  assert.equal(rootChanged.task_state, "failed");
  assert.match(rootChanged.reason, /Project directory changed/);
  report.checks.push(
    "provider_revision_and_replaced_project_directory_cannot_silently_change_unattended_execution",
  );

  const member = await provider("scheduled-member", "responses", teams.url);
  teams.definitions.set(member.model, { kind: "leaf" });
  const parent = await provider("scheduled-team", "responses", teams.url);
  teams.definitions.set(parent.model, {
    kind: "main",
    members: [
      {
        key: "research",
        role: "Research",
        goal: "Complete assigned research",
        profile_id: member.id,
        depends_on: [],
      },
    ],
  });
  const teamPlan = await save(parent, { mode: "execute" }),
    teamRun = await run(teamPlan);
  const finishedTeam = await until(async () => {
    const value = await snapshot(engine, teamRun.task_id);
    return ["completed", "failed", "interrupted"].includes(value.task.state) && value;
  }, 30000);
  assert.equal(finishedTeam.task.state, "completed", JSON.stringify(finishedTeam.latest_run));
  const team = await engine.request({
    kind: "read",
    query: { kind: "team", task_id: teamRun.task_id },
  });
  assert.equal(team.kind, "team");
  assert.equal(team.view.members.length, 1);
  assert.equal(team.view.members[0].review, "accepted");
  report.checks.push(
    "scheduled_root_uses_real_multi_assistant_delegation_and_reviews_member_result",
  );

  const failedMember = await provider("scheduled-failed-member", "responses", teams.url);
  teams.definitions.set(failedMember.model, { kind: "error" });
  const replacementParent = await provider("scheduled-replacement", "responses", teams.url);
  teams.definitions.set(replacementParent.model, {
    kind: "main",
    members: [
      {
        key: "branch",
        role: "Branch",
        goal: "Finish assigned branch",
        profile_id: failedMember.id,
        depends_on: [],
      },
    ],
    replacement: member.id,
  });
  const replacementPlan = await save(replacementParent, { mode: "execute" }),
    replacementRun = await run(replacementPlan);
  const replacedTeam = await until(async () => {
    const value = await snapshot(engine, replacementRun.task_id);
    return ["completed", "failed", "interrupted"].includes(value.task.state) && value;
  }, 30000);
  assert.equal(replacedTeam.task.state, "completed", JSON.stringify(replacedTeam.latest_run));
  const replacementView = await engine.request({
    kind: "read",
    query: { kind: "team", task_id: replacementRun.task_id },
  });
  assert.equal(replacementView.view.members.length, 2);
  assert(replacementView.view.members.some((m) => m.state === "failed" && m.superseded_by));
  assert(
    replacementView.view.members.some((m) => m.state === "completed" && m.review === "accepted"),
  );
  report.checks.push(
    "scheduled_member_error_only_stops_branch_parent_explicitly_delegates_replacement",
  );

  // Suspend this test-owned engine only; do not put the user's computer to sleep.
  const pausePlans = [];
  const pauseRule = onceSoon(5000);
  for (let i = 0; i < 17; i++) pausePlans.push(await save(p, { enabled: true, rule: pauseRule }));
  if (process.platform === "win32") {
    assert(Number.isSafeInteger(engine.child.pid) && engine.child.pid > 0);
    const script = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WorkPilotScheduleTestPause {
 [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint id);
 [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr handle);
 [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr handle);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
$testHandle=[WorkPilotScheduleTestPause]::OpenProcess(0x800,$false,${engine.child.pid})
if ($testHandle -eq [IntPtr]::Zero) { throw 'Unable to open owned test process' }
try {
 if ([WorkPilotScheduleTestPause]::NtSuspendProcess($testHandle) -ne 0) { throw 'Suspend failed' }
 Start-Sleep -Milliseconds 6500
} finally {
 [void][WorkPilotScheduleTestPause]::NtResumeProcess($testHandle)
 [void][WorkPilotScheduleTestPause]::CloseHandle($testHandle)
}`;
    const helper = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    let errors = "";
    helper.stderr.on("data", (b) => (errors += b));
    const [code] = await once(helper, "exit");
    assert.equal(code, 0, errors);
  } else {
    engine.child.kill("SIGSTOP");
    await delay(6500);
    engine.child.kill("SIGCONT");
  }
  for (const plan of pausePlans) {
    const o = await until(async () => (await history(plan))[0]);
    assert.equal(o.state, "missed");
    assert.equal(o.reason, "clock_jump_or_resume");
    assert.equal(o.task_id, null);
  }
  report.checks.push(
    "owned_engine_process_suspend_resume_drains_all_17_due_plans_without_dispatch_not_an_OS_sleep_test",
  );

  const missed = await save(p, { enabled: true, rule: onceSoon(2500) });
  await engine.close();
  await delay(3000);
  engine = await launch(directory);
  const old = (await history(missed))[0];
  assert.equal(old.state, "missed");
  assert.equal(old.reason, "application_was_closed");
  assert.equal(old.task_id, null);
  report.checks.push("closed_application_records_missed_time_on_restart_without_catch_up");
  await engine.close();

  for (const point of ["schedule_after_claim", "schedule_after_create", "schedule_after_start"]) {
    engine = await launch(undefined, point);
    const crashProvider = await provider("runtime-hold"),
      plan = await save(crashProvider, { enabled: true, rule: onceSoon() });
    const crashDir = engine.directory;
    const [code] = await once(engine.child, "exit");
    assert.equal(code, 86);
    engine = await launch(crashDir);
    const h = await history(plan);
    assert.equal(h.length, 1);
    assert.equal(h[0].state, "interrupted");
    if (point === "schedule_after_claim") assert.equal(h[0].task_id, null);
    else {
      assert(h[0].task_id);
      assert.equal(h[0].task_state, "interrupted");
    }
    await delay(500);
    assert.equal((await history(plan)).length, 1);
    if (point === "schedule_after_create") {
      await start(engine, h[0].task_id);
      assert.equal((await terminal(engine, h[0].task_id)).task.state, "completed");
    }
    report.checks.push(point + "_recovery_preserves_single_occurrence_without_automatic_resubmit");
    await engine.close();
  }
  report.result = "passed";
} catch (e) {
  report.result = "failed";
  report.error = String(e.stack || e);
  throw e;
} finally {
  for (const child of processes) if (child.exitCode === null) child.kill();
  await fixture.close();
  await teams.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
