import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { startTeamFixture } from "../services/execution-fixtures/teams.mjs";
import {
  launch,
  profile,
  create,
  snapshot,
  start,
  terminal,
  until,
  processes,
  setFixture,
  output,
} from "./tool-test-support.mjs";
const fixture = await startTeamFixture();
setFixture(fixture);
const report = {
  at: new Date().toISOString(),
  service: "synthetic HTTP model; independent sessions and actual files",
  checks: [],
};
let engine;
const settings = {
  enabled: true,
  max_parallel: 3,
  max_members: 16,
  max_depth: 2,
  max_replacements: 2,
  revision: 0,
};
async function add(model, kind, protocol = "responses") {
  const p = profile(protocol, model);
  fixture.definitions.set(model, kind);
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
  return p.id;
}
const member = (key, profile_id, depends_on = []) => ({
  key,
  role: "Role " + key,
  goal: "Complete branch " + key,
  profile_id,
  depends_on,
});
async function view(task) {
  const r = await engine.request({ kind: "read", query: { kind: "team", task_id: task } });
  assert.equal(r.kind, "team", JSON.stringify(r));
  return r.view;
}
async function root(members, options = {}) {
  const name = "team-" + crypto.randomUUID();
  fixture.definitions.set(name, { kind: "main", members, ...options });
  const task = await create(engine, "responses", name, {
    controlled_tools: false,
    limits: {
      max_steps: 64,
      max_duration_ms: 90000,
      context_bytes: 262144,
      max_result_bytes: 65536,
    },
  });
  assert.equal(
    (
      await engine.request({
        kind: "configure_team",
        task_id: task,
        settings: { ...settings, ...options.teamSettings },
      })
    ).kind,
    "receipt",
  );
  const folder = join(engine.directory, "team-project-" + task);
  await mkdir(folder);
  assert.equal(
    (
      await engine.request({
        kind: "configure_task_tools",
        task_id: task,
        settings: {
          root_path: folder,
          permission: options.permission || "full_access",
          review_profile_id: null,
          commands_enabled: false,
          revision: 0,
        },
      })
    ).kind,
    "receipt",
  );
  return { task, folder };
}
async function finished(task) {
  return until(async () => {
    const s = await snapshot(engine, task);
    return ["completed", "failed", "interrupted"].includes(s.task.state) && s;
  }, 45000);
}
const write = (path) => ({
  name: "write_file",
  args: { path, text: "verified " + path, expected_sha256: null },
});
try {
  engine = await launch();
  const invalid = await create(engine, "responses", "validation-only");
  assert.equal(
    (
      await engine.request({
        kind: "configure_team",
        task_id: invalid,
        settings: { ...settings, max_parallel: 0 },
      })
    ).kind,
    "error",
  );
  const a = await add(
    "member-a",
    {
      kind: "leaf",
      actions: [write("a.txt"), { name: "register_artifact", args: { path: "a.txt" } }],
    },
    "chat_completions",
  );
  const b = await add(
    "member-b",
    {
      kind: "leaf",
      actions: [write("b.txt"), { name: "register_artifact", args: { path: "b.txt" } }],
    },
    "messages",
  );
  const c = await add("member-join", {
    kind: "leaf",
    actions: [
      { name: "read_file", args: { path: "a.txt", offset: 0, limit: 1000 } },
      { name: "read_file", args: { path: "b.txt", offset: 0, limit: 1000 } },
      write("joined.txt"),
      { name: "register_artifact", args: { path: "joined.txt" } },
    ],
  });
  const x = await root([member("a", a), member("b", b), member("join", c, ["a", "b"])]);
  await start(engine, x.task);
  const s = await finished(x.task);
  assert.equal(s.task.state, "completed", JSON.stringify(s.latest_run));
  const team = await view(x.task);
  assert.equal(team.members.length, 3);
  assert(team.members.every((m) => m.review === "accepted" && m.state === "completed"));
  assert.equal(new Set(team.members.map((m) => m.profile_id)).size, 3);
  assert.equal(await readFile(join(x.folder, "joined.txt"), "utf8"), "verified joined.txt");
  const runs = await Promise.all(team.members.map((m) => snapshot(engine, m.task_id)));
  const joiner = runs.find((s) => s.config.profile_id === c);
  assert(
    runs
      .filter((s) => s.config.profile_id !== c)
      .every((s) => s.latest_run.run.ended_at_ms <= joiner.latest_run.run.started_at_ms),
  );
  report.checks.push(
    "three_independent_model_profiles_parallel_branches_dependency_join_and_reviewed_real_artifacts",
  );
  const bad = await add("member-error", { kind: "error" });
  const recovery = await root([member("fault", bad), member("independent", b)], { replacement: a });
  await start(engine, recovery.task);
  assert.equal((await finished(recovery.task)).task.state, "completed");
  const recoveryTeam = await view(recovery.task);
  assert.equal(recoveryTeam.members.length, 3);
  assert.equal(recoveryTeam.members.find((m) => m.key === "fault").state, "failed");
  assert(recoveryTeam.members.some((m) => m.replaces_id && m.review === "accepted"));
  assert.equal(fixture.starts.filter((r) => r.model === "member-error").length, 1);
  report.checks.push(
    "failure_isolation_explicit_new_assistant_keeps_original_error_no_request_retry",
  );
  const bounded = await root([member("fails", bad)], {
    replacement: bad,
    attempts: 10,
    stopOnLimit: true,
    teamSettings: { max_replacements: 1 },
  });
  await start(engine, bounded.task);
  await until(async () => {
    const s = await snapshot(engine, bounded.task);
    return s.context.question;
  });
  const limited = await view(bounded.task);
  assert.equal(limited.members.length, 2);
  assert(limited.members.every((m) => m.state === "failed"));
  assert.equal(
    (
      await engine.request({
        kind: "replace_team_member",
        task_id: bounded.task,
        member_id: limited.members.at(-1).task_id,
        profile_id: a,
        reason: "user cannot exceed configured limit",
      })
    ).kind,
    "model_error",
  );
  report.checks.push("repeated_failure_replacement_limit_stops_new_members_and_requests_input");

  const collideA = await add("collide-a", {
    kind: "leaf",
    actions: [{ ...write("same.txt"), args: { ...write("same.txt").args, text: "first" } }],
  });
  const collideB = await add("collide-b", {
    kind: "leaf",
    actions: [{ ...write("same.txt"), args: { ...write("same.txt").args, text: "second" } }],
  });
  const conflict = await root([member("a", collideA), member("b", collideB)]);
  await start(engine, conflict.task);
  assert.equal((await finished(conflict.task)).task.state, "completed");
  const conflictMembers = (await view(conflict.task)).members;
  const conflictSteps = (await Promise.all(conflictMembers.map((m) => snapshot(engine, m.task_id))))
    .flatMap((s) => s.steps)
    .filter((s) => s.name === "write_file");
  assert.equal(conflictSteps.filter((s) => s.state === "completed").length, 1);
  assert.equal(conflictSteps.filter((s) => s.state === "failed").length, 1);
  assert(["first", "second"].includes(await readFile(join(conflict.folder, "same.txt"), "utf8")));
  report.checks.push("concurrent_same_file_create_has_one_version_and_one_visible_conflict");

  const scoped = await root([member("writer", collideA)], {
    permission: "request_approval",
    pauseOnApproval: true,
  });
  await start(engine, scoped.task);
  const waiting = await until(async () => {
    const v = await view(scoped.task);
    return v.members.find((m) => m.state === "awaiting_approval");
  });
  const readTools = await engine.request({
    kind: "read",
    query: { kind: "task_tools", task_id: waiting.task_id },
  });
  assert.equal(readTools.kind, "task_tools");
  const approval = readTools.state.approvals.find((a) => a.state === "pending");
  assert.equal(readTools.state.policy.effective_permission, "request_approval");
  assert.equal(
    (
      await engine.request({
        kind: "decide_tool_approval",
        task_id: conflict.task,
        approval_id: approval.id,
        fingerprint: approval.fingerprint,
        approve: true,
      })
    ).kind,
    "model_error",
  );
  await writeFile(join(scoped.folder, "same.txt"), "human edit during approval");
  assert.equal(
    (
      await engine.request({
        kind: "decide_tool_approval",
        task_id: waiting.task_id,
        approval_id: approval.id,
        fingerprint: approval.fingerprint,
        approve: true,
      })
    ).kind,
    "model_error",
  );
  assert.equal(
    await readFile(join(scoped.folder, "same.txt"), "utf8"),
    "human edit during approval",
  );
  await engine.request({ kind: "cancel", task_id: scoped.task });
  report.checks.push("inherited_human_approval_cross_task_rejected_and_external_edit_preserved");

  const slow = await add("slow-resume", {
    kind: "leaf",
    delay: 3000,
    actions: [write("slow.txt")],
  });
  const resumed = await root([
    member("done", a),
    member("slow", slow),
    member("queued", b, ["slow"]),
  ]);
  await start(engine, resumed.task);
  await until(async () => {
    const v = await view(resumed.task);
    return (
      v.members.find((m) => m.key === "done")?.state === "completed" &&
      fixture.starts.some((s) => s.model === "slow-resume")
    );
  });
  assert.equal((await engine.request({ kind: "cancel", task_id: resumed.task })).kind, "receipt");
  await until(
    async () =>
      !(await view(resumed.task)).members.some((m) => ["running", "stopping"].includes(m.state)),
  );
  const completedId = (await view(resumed.task)).members.find((m) => m.key === "done").task_id;
  const previousRun = (await snapshot(engine, completedId)).latest_run.run.id;
  const directory = engine.directory;
  await engine.close();
  engine = await launch(directory);
  const callsBefore = fixture.starts.length;
  await delay(350);
  assert.equal(fixture.starts.length, callsBefore);
  fixture.definitions.set("slow-resume", { kind: "leaf", actions: [write("slow.txt")] });
  await start(engine, resumed.task);
  assert.equal((await finished(resumed.task)).task.state, "completed");
  assert.equal((await snapshot(engine, completedId)).latest_run.run.id, previousRun);
  assert.equal(await readFile(join(resumed.folder, "slow.txt"), "utf8"), "verified slow.txt");
  report.checks.push(
    "parent_stop_reopen_manual_continue_preserves_completed_branch_and_blocks_new_tools",
  );

  const twoProjects = await Promise.all([root([member("a", a)]), root([member("b", b)])]);
  await Promise.all(twoProjects.map((x) => start(engine, x.task)));
  assert(
    (await Promise.all(twoProjects.map((x) => finished(x.task)))).every(
      (s) => s.task.state === "completed",
    ),
  );
  for (const x of twoProjects) {
    const v = await view(x.task);
    assert(v.members.every((m) => m.root_task_id === x.task));
    for (const m of v.members) {
      const ev = await engine.request({
        kind: "read",
        query: { kind: "events", task_id: m.task_id, after: 0, limit: 128 },
      });
      assert(ev.page.events.every((e) => e.task_id === m.task_id));
    }
  }
  report.checks.push("parallel_projects_keep_members_events_and_files_separate");

  const manual = await root([]);
  const requestId = crypto.randomUUID();
  const addCommand = {
    kind: "add_team_members",
    task_id: manual.task,
    members: [member("manual", a)],
  };
  assert.equal((await engine.request(addCommand, requestId)).kind, "receipt");
  assert((await engine.request(addCommand, requestId)).receipt.duplicate);
  const manualId = (await view(manual.task)).members[0].task_id;
  assert.equal(
    (
      await engine.request({
        kind: "override_team_member",
        task_id: manual.task,
        member_id: manualId,
        spec: { ...member("manual", b), role: "user assigned", goal: "updated goal" },
      })
    ).kind,
    "receipt",
  );
  await start(engine, manual.task);
  assert.equal((await finished(manual.task)).task.state, "completed");
  assert.equal((await snapshot(engine, manualId)).config.profile_id, b);
  report.checks.push("manual_assignment_override_and_repeated_command_do_not_duplicate_members");

  await delay(150);
  const loadSettings = (await view(manual.task)).scheduler;
  assert.equal(
    (
      await engine.request({
        kind: "configure_scheduler",
        settings: { max_running: 2, revision: loadSettings.revision },
      })
    ).kind,
    "receipt",
  );
  const loadProfile = await add("bounded-load", { kind: "hold", ms: 150 });
  const loadTasks = await Promise.all([
    root(
      Array.from({ length: 8 }, (_, i) => member("member-" + i, loadProfile)),
      { teamSettings: { max_parallel: 2 } },
    ),
    root(
      Array.from({ length: 8 }, (_, i) => member("member-" + i, loadProfile)),
      { teamSettings: { max_parallel: 2 } },
    ),
  ]);
  const loadFrom = engine.events.length;
  const loadTime = performance.now();
  await Promise.all(loadTasks.map((x) => start(engine, x.task)));
  assert(
    (await Promise.all(loadTasks.map((x) => finished(x.task)))).every(
      (s) => s.task.state === "completed",
    ),
  );
  let peak = 0;
  const running = new Set();
  for (const event of engine.events.slice(loadFrom)) {
    if (event.kind === "execution_started") running.add(event.run_id);
    if (event.kind === "execution_ended") running.delete(event.run_id);
    peak = Math.max(peak, running.size);
  }
  assert.equal(peak, 2);
  report.load_sample = {
    roots: 2,
    members: 16,
    configured_global: 2,
    configured_per_root: 2,
    observed_peak: peak,
    elapsed_ms: Math.round(performance.now() - loadTime),
  };
  report.checks.push("sixteen_members_across_two_projects_respect_global_and_root_running_limits");

  await delay(150);
  let global = (await view(manual.task)).scheduler;
  assert.equal(
    (
      await engine.request({
        kind: "configure_scheduler",
        settings: { max_running: 1, revision: global.revision },
      })
    ).kind,
    "receipt",
  );
  const middle = await add("nested-lead", { kind: "main", members: [member("leaf", a)] });
  const nested = await root([member("middle", middle)], { teamSettings: { max_parallel: 1 } });
  await start(engine, nested.task);
  assert.equal((await finished(nested.task)).task.state, "completed");
  assert.equal((await view(nested.task)).members.length, 2);
  report.checks.push("nested_teams_with_one_global_slot_release_waiting_parents_without_deadlock");

  await engine.close();
  engine = await launch(undefined, "after_effect");
  const crashLeaf = await add("crash-leaf", { kind: "leaf" });
  const crash = await root([member("only-once", crashLeaf)]);
  const exited = once(engine.child, "exit");
  await start(engine, crash.task);
  assert.equal((await exited)[0], 86);
  const crashDir = engine.directory;
  engine = await launch(crashDir);
  assert.equal((await view(crash.task)).members.length, 1);
  await start(engine, crash.task);
  assert.equal((await finished(crash.task)).task.state, "completed");
  assert.equal((await view(crash.task)).members.length, 1);
  report.checks.push(
    "crash_after_durable_delegation_receipt_recovers_without_duplicate_assistants",
  );
  report.result = "passed";
} catch (e) {
  report.result = "failed";
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  if (engine) await engine.close().catch(() => {});
  for (const p of processes) if (p.exitCode === null) p.kill();
  await fixture.close();
  report.requests = fixture.starts;
  await writeFile(join(output, "team-report.json"), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({ result: report.result, checks: report.checks, error: report.error }, null, 2),
  );
}
