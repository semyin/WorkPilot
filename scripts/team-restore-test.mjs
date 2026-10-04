import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  launch,
  profile,
  create,
  snapshot,
  start,
  until,
  setFixture,
} from "./tool-test-support.mjs";
import { startTeamFixture } from "../services/execution-fixtures/teams.mjs";
import { media, uploadMedia } from "./media-transfer-support.mjs";

const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/team-restore");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "session-"));
const binary = process.env.WORKPILOT_ENGINE_BINARY || resolve("target/debug/workpilot-engine.exe");
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  binarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  service:
    "Local synthetic three-protocol models; real engines, encrypted archives and separate data roots",
  checks: [],
};
const fixture = await startTeamFixture();
setFixture(fixture);
const password = "team restoration fixture " + crypto.randomUUID();
let source, target;
const action = async (engine, data) => {
  const r = await engine.request({ kind: "task_archive", action: data });
  assert.equal(r.kind, "workbench", JSON.stringify(r));
  return r.data;
};
const refused = (r) => assert(["error", "model_error"].includes(r.kind), JSON.stringify(r));
const save = async (engine, p) => {
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
};
const member = (key, profile_id, depends_on = []) => ({
  key,
  role: "助手 " + key,
  goal: "Assignment " + key,
  profile_id,
  depends_on,
});
async function team(engine, task) {
  const r = await engine.request({ kind: "read", query: { kind: "team", task_id: task } });
  assert.equal(r.kind, "team");
  return r.view;
}
async function finished(engine, task) {
  return until(async () => {
    const s = await snapshot(engine, task);
    return ["completed", "failed"].includes(s.task.state) && s;
  }, 90000);
}
async function importArchive(engine, path) {
  const p = await action(engine, { kind: "inspect", path, password });
  return (await action(engine, { kind: "import", path, password, fingerprint: p.fingerprint }))
    .archive_id;
}
async function migrate(root, path) {
  await action(source, { kind: "export", task_id: root, path, password });
  const archive_id = await importArchive(target, path);
  const options = await action(target, { kind: "team_restore_options", archive_id });
  const sourceTeam = await team(source, root);
  const sources = new Map();
  const profiles = [];
  for (const node of options.tasks) {
    const old = await snapshot(source, node.task_id);
    const p = node.model || { protocol: "responses", model: "unstarted-fallback" };
    const catalog = await source.request({ kind: "read", query: { kind: "profiles" } });
    const oldProfile = catalog.catalog.profiles.find(
      (p) => p.profile.id === old.config.profile_id,
    ).profile;
    const next = await save(
      target,
      profile(oldProfile.protocol, p.model === "unstarted-fallback" ? oldProfile.model : p.model),
    );
    profiles.push({ task_id: node.task_id, profile_id: next.id });
    sources.set(node.task_id, old);
  }
  const mapping = { archive_id, project_id: null, profiles };
  refused(
    await target.request({
      kind: "task_archive",
      action: { kind: "team_restore_preview", ...mapping, profiles: profiles.slice(1) },
    }),
  );
  const preview = await action(target, { kind: "team_restore_preview", ...mapping });
  assert.equal(preview.tasks.length, sourceTeam.members.length + 1);
  const calls = fixture.records.length;
  const restored = await action(target, {
    kind: "team_restore",
    ...mapping,
    fingerprint: preview.fingerprint,
  });
  assert.equal(fixture.records.length, calls);
  const ids = new Map(restored.tasks.map((n) => [n.source_task_id, n.task_id]));
  assert.equal(new Set(ids.values()).size, options.tasks.length);
  for (const [old, id] of ids) {
    assert.notEqual(old, id);
    const restoredSnapshot = await snapshot(target, id),
      original = sources.get(old);
    assert.equal(restoredSnapshot.latest_run, null);
    assert.deepEqual(restoredSnapshot.context.history, original.context.history);
    assert.equal(restoredSnapshot.context.goal, original.context.goal);
    assert.equal(restoredSnapshot.messages.length, original.messages.length);
    assert.equal(restoredSnapshot.task.permission, "request_approval");
    const tools = await target.request({
      kind: "read",
      query: { kind: "task_tools", task_id: id },
    });
    assert.equal(tools.state.policy.settings.commands_enabled, false);
    assert.equal(tools.state.approvals.length, 0);
  }
  const current = await team(target, restored.task_id);
  assert.equal(current.scheduling_enabled, false);
  for (const old of sourceTeam.members) {
    const m = current.members.find((m) => m.task_id === ids.get(old.task_id));
    assert.equal(m.parent_task_id, ids.get(old.parent_task_id));
    assert.equal(m.root_task_id, restored.task_id);
    assert.equal(m.pending_start, false);
    assert.equal(m.review, old.review);
    assert.equal(m.attempt, old.attempt);
    assert.deepEqual(m.depends_on.slice().sort(), old.depends_on.map((id) => ids.get(id)).sort());
    assert.equal(m.replaces_id, old.replaces_id ? ids.get(old.replaces_id) : null);
    assert.equal(m.superseded_by, old.superseded_by ? ids.get(old.superseded_by) : null);
    if (["failed", "completed"].includes(old.state)) assert.equal(m.state, old.state);
    if (old.report) {
      assert(m.report);
      assert.notEqual(m.report.object_id, old.report.object_id);
      const r = await target.request({
        kind: "read",
        query: { kind: "content", object_id: m.report.object_id, offset: 0, limit: 65536 },
      });
      const saved = JSON.parse(r.page.text);
      assert.equal(saved.task_id, m.task_id);
      assert.equal(saved.agent_id, m.agent_id);
      assert.equal(saved.run_id, null);
    }
  }
  assert.deepEqual(await team(source, root), sourceTeam);
  report.checks.push(
    "fresh_tree_models_history_dependencies_replacements_reviews_and_no_automatic_execution_" +
      sourceTeam.members.length +
      "_members",
  );
  return { restored, ids, mapping, preview, sourceTeam };
}
try {
  source = await launch(join(directory, "source"));
  target = await launch(join(directory, "target"));
  const unrelated = await create(target, "responses", "unrelated-unchanged");
  const before = await snapshot(target, unrelated);
  const leaf = await save(source, profile("chat_completions", "restore-leaf"));
  const failure = await save(source, profile("messages", "restore-failure"));
  const backup = await save(source, profile("messages", "restore-backup"));
  const nested = await save(source, profile("responses", "restore-nested"));
  fixture.definitions.set(leaf.model, { kind: "leaf", text: "已保存的助手交付 42" });
  fixture.definitions.set(failure.model, { kind: "error" });
  fixture.definitions.set(backup.model, { kind: "leaf", text: "接替助手完成 007" });
  fixture.definitions.set(nested.model, {
    kind: "main",
    members: [member("nested-leaf", leaf.id)],
  });
  const members = [
    member("research", leaf.id),
    member("review", backup.id, ["research"]),
    member("failed-branch", failure.id),
    member("nested", nested.id),
  ];
  fixture.definitions.set("restoration-main", { kind: "main", members, replacement: backup.id });
  const root = await create(source, "responses", "restoration-main", {
    title: "完整团队迁移",
    controlled_tools: false,
    limits: {
      max_steps: 96,
      max_duration_ms: 90000,
      context_bytes: 524288,
      max_result_bytes: 65536,
    },
  });
  await source.request({ kind: "enqueue", task_id: root, text: "Inherited direction KEEP_42" });
  await start(source, root);
  assert.equal((await finished(source, root)).task.state, "completed");
  const originalMembers = (await team(source, root)).members;
  const childTask = originalMembers.find((m) => m.state === "completed").task_id;
  const rootAttachment = await uploadMedia(
    source.request,
    root,
    "主任务资料.txt",
    Buffer.from("Parent attachment 42"),
  );
  const childAttachment = await uploadMedia(
    source.request,
    childTask,
    "助手资料.txt",
    Buffer.from("Child attachment 007"),
  );
  const first = await migrate(root, join(directory, "completed-team.wptask"));
  for (const [oldTask, original, expected] of [
    [root, rootAttachment, "Parent attachment 42"],
    [childTask, childAttachment, "Child attachment 007"],
  ]) {
    const next = first.ids.get(oldTask);
    const assets = (await media(target.request, next, { kind: "list" })).assets;
    assert.equal(assets.length, 1);
    assert.equal(assets[0].origin.asset_id, original.id);
    assert.equal(assets[0].task_id, next);
    assert(
      JSON.stringify(
        await media(target.request, next, {
          kind: "read",
          asset_id: assets[0].id,
          start: 0,
          limit: 2,
        }),
      ).includes(expected),
    );
    const other = first.ids.get(oldTask === root ? childTask : root);
    refused(
      await target.request({
        kind: "media",
        task_id: other,
        action: { kind: "read", asset_id: assets[0].id, start: 0, limit: 2 },
      }),
    );
  }
  report.checks.push("root_and_assistant_attachment_originals_remapped_without_cross_task_access");
  assert(first.sourceTeam.members.some((m) => m.state === "failed" && m.superseded_by));
  assert(first.sourceTeam.members.some((m) => m.depth === 2));
  const leafCalls = fixture.starts.filter((r) => r.model !== "restoration-main").length;
  refused(await target.request({ kind: "start_execution", task_id: first.restored.task_id }));
  await target.request({
    kind: "enqueue",
    task_id: first.restored.task_id,
    text: "Continue based on saved deliveries",
  });
  await start(target, first.restored.task_id);
  assert.equal((await finished(target, first.restored.task_id)).task.state, "completed");
  assert.equal(fixture.starts.filter((r) => r.model !== "restoration-main").length, leafCalls);
  assert.equal(
    (await team(target, first.restored.task_id)).members.length,
    first.sourceTeam.members.length,
  );
  report.checks.push(
    "completed_failed_and_superseded_assistants_are_not_retried_when_main_task_continues",
  );
  await target.close();
  target = await launch(join(directory, "target"));
  const repeat = await action(target, {
    kind: "team_restore",
    ...first.mapping,
    fingerprint: first.preview.fingerprint,
  });
  assert(repeat.duplicate);
  assert.equal(repeat.task_id, first.restored.task_id);
  const secondPath = join(directory, "team-restored-again.wptask");
  await action(target, {
    kind: "export",
    task_id: first.restored.task_id,
    path: secondPath,
    password,
  });
  const secondArchive = await importArchive(target, secondPath);
  const secondMap = {
    archive_id: secondArchive,
    project_id: null,
    profiles: await Promise.all(
      repeat.tasks.map(async (t) => ({
        task_id: t.task_id,
        profile_id: (await snapshot(target, t.task_id)).config.profile_id,
      })),
    ),
  };
  const secondPreview = await action(target, { kind: "team_restore_preview", ...secondMap });
  const second = await action(target, {
    kind: "team_restore",
    ...secondMap,
    fingerprint: secondPreview.fingerprint,
  });
  await target.request({
    kind: "enqueue",
    task_id: second.task_id,
    text: "Second migration synthesis",
  });
  await start(target, second.task_id);
  assert.equal((await finished(target, second.task_id)).task.state, "completed");
  assert.equal(fixture.starts.filter((r) => r.model !== "restoration-main").length, leafCalls);
  report.checks.push(
    "restart_duplicate_and_second_migration_keep_tree_and_history_without_rerunning_members",
  );
  // A never-started group remains idle until the user's manual continuation.
  const unstartedMembers = [
    member("fresh-research", leaf.id),
    member("fresh-review", backup.id, ["fresh-research"]),
    member("fresh-nested", nested.id),
  ];
  fixture.definitions.set("unstarted-main", { kind: "main", members: unstartedMembers });
  const idle = await create(source, "responses", "unstarted-main", {
    controlled_tools: false,
    limits: {
      max_steps: 96,
      max_duration_ms: 90000,
      context_bytes: 524288,
      max_result_bytes: 65536,
    },
  });
  assert.equal(
    (await source.request({ kind: "add_team_members", task_id: idle, members: unstartedMembers }))
      .kind,
    "receipt",
  );
  // Create the nested child before export so restoring never needs old model IDs.
  const idleNested = (await team(source, idle)).members.find((m) => m.key === "fresh-nested");
  assert.equal(
    (
      await source.request({
        kind: "add_team_members",
        task_id: idleNested.task_id,
        members: [member("nested-leaf", leaf.id)],
      })
    ).kind,
    "receipt",
  );
  const pending = await migrate(idle, join(directory, "unstarted-team.wptask"));
  const begin = fixture.starts.length;
  await start(target, pending.restored.task_id);
  assert.equal((await finished(target, pending.restored.task_id)).task.state, "completed");
  const done = await team(target, pending.restored.task_id);
  assert(done.members.every((m) => m.state === "completed" && m.review === "accepted"));
  const requested = fixture.starts
    .slice(begin)
    .filter((r) => r.model === "restore-leaf" || r.model === "restore-backup");
  assert.equal(requested.filter((r) => r.model === "restore-leaf").length, 2);
  assert.equal(requested.filter((r) => r.model === "restore-backup").length, 1);
  const dependency = done.members.find((m) => m.key === "fresh-review");
  assert((await snapshot(target, dependency.task_id)).context.goal.includes("已保存的助手交付 42"));
  report.checks.push(
    "manual_continuation_schedules_unstarted_nested_members_once_in_dependency_order",
  );
  assert.deepEqual(await snapshot(target, unrelated), before);
  assert(fixture.records.every((r) => r.correlationValid));
  report.checks.push(
    "all_three_protocols_preserve_tool_call_pairing_and_unrelated_task_remains_unchanged",
  );
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  await source?.close();
  await target?.close();
  await fixture.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
