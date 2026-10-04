import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  launch,
  profile,
  create,
  snapshot,
  start,
  terminal,
  setFixture,
} from "./tool-test-support.mjs";
import { startExecutionFixture } from "../services/execution-fixtures/server.mjs";

const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/task-restore");
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
    "Local synthetic three-protocol model; real engines, separate data roots and approved file writes",
  checks: [],
};
const cases = new Map(),
  requests = [];
const fixture = await startExecutionFixture((body, results) => {
  const test = cases.get(body.model);
  if (!test) return undefined;
  const call = (name, args) => ({ text: "", calls: [{ name, args }] });
  requests.push({ model: body.model, phase: test.phase, body, results });
  if (test.phase === "source")
    return results.length === 0
      ? call("write_file", { path: "source.txt", text: "Original write 42", expected_sha256: null })
      : { text: "原任务完成 42", calls: [] };
  if (test.phase === "restore") {
    if (results.length === 1) return call("inspect_history", { step_id: test.step });
    if (results.length === 2)
      return call("write_file", {
        path: "continued.txt",
        text: "Restored continuation 007",
        expected_sha256: null,
      });
    return { text: "迁入后继续完成 007", calls: [] };
  }
  return { text: "Second migration continued", calls: [] };
});
setFixture(fixture);
const passphrase = "restoration fixture " + crypto.randomUUID();
let source, target;
const action = async (engine, data) => {
  const result = await engine.request({ kind: "task_archive", action: data });
  assert.equal(result.kind, "workbench", JSON.stringify(result));
  return result.data;
};
const refused = (r) => assert(["error", "model_error"].includes(r.kind), JSON.stringify(r));
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );
async function project(engine, name, path, permission) {
  await mkdir(path, { recursive: true });
  const response = await engine.request({
    kind: "workspace",
    action: {
      kind: "save_project",
      project_id: null,
      settings: {
        name,
        root_path: path,
        permission,
        default_profile_id: null,
        rules: name + " rule",
        revision: 0,
      },
    },
  });
  assert.equal(response.kind, "workspace", JSON.stringify(response));
  return response.data.project.id;
}
async function tools(engine, task) {
  const r = await engine.request({ kind: "read", query: { kind: "task_tools", task_id: task } });
  assert.equal(r.kind, "task_tools");
  return r.state;
}
async function approve(engine, task) {
  const approval = (await tools(engine, task)).approvals.find((a) => a.state === "pending");
  assert(approval);
  const r = await engine.request({
    kind: "decide_tool_approval",
    task_id: task,
    approval_id: approval.id,
    fingerprint: approval.fingerprint,
    approve: true,
  });
  assert.equal(r.kind, "receipt", JSON.stringify(r));
  await start(engine, task);
  return approval;
}
async function importArchive(engine, path) {
  const preview = await action(engine, { kind: "inspect", path, password: passphrase });
  return (
    await action(engine, {
      kind: "import",
      path,
      password: passphrase,
      fingerprint: preview.fingerprint,
    })
  ).archive_id;
}
try {
  source = await launch(join(directory, "source"));
  target = await launch(join(directory, "target"));
  const keep = await create(target, "responses", "unrelated-task");
  const keepBefore = await snapshot(target, keep);
  for (const protocol of ["chat_completions", "responses", "messages"]) {
    const model = "restore-" + protocol,
      test = { phase: "source" };
    cases.set(model, test);
    const fromFolder = join(directory, protocol, "原项目"),
      toFolder = join(directory, protocol, "目标项目");
    const fromProject = await project(source, "Original", fromFolder, "request_approval");
    const toProject = await project(target, "Destination", toFolder, "full_access");
    const root = await create(source, protocol, model, {
      title: "恢复验收 " + protocol,
      controlled_tools: false,
      project_id: fromProject,
    });
    await source.request({
      kind: "enqueue",
      task_id: root,
      text: "已发送的原始要求 KEEP_ORIGINAL_42",
    });
    await start(source, root);
    assert.equal((await terminal(source, root)).task.state, "awaiting_approval");
    const unresolved = join(directory, protocol + "-pending.wptask");
    await action(source, { kind: "export", task_id: root, path: unresolved, password: passphrase });
    const pendingArchive = await importArchive(target, unresolved);
    const local = profile(protocol, model);
    assert.equal(
      (
        await target.request({
          kind: "save_provider",
          profile: local,
          secret: null,
          clear_credential: false,
        })
      ).kind,
      "provider_saved",
    );
    const pendingOptions = {
      archive_id: pendingArchive,
      project_id: toProject,
      profile_id: local.id,
    };
    const pendingCalls = fixture.records.length;
    const pendingPreview = await action(target, {
      kind: "restore_preview",
      ...pendingOptions,
    });
    assert(pendingPreview.recovery.some((item) => item.kind === "inactive_approval"));
    assert(pendingPreview.recovery.some((item) => item.kind === "sealed_tool_batch"));
    const pendingRestored = await action(target, {
      kind: "restore",
      ...pendingOptions,
      fingerprint: pendingPreview.fingerprint,
    });
    const pendingTask = pendingRestored.task_id;
    const pendingSnapshot = await snapshot(target, pendingTask);
    assert.equal(pendingSnapshot.task.state, "interrupted");
    assert.equal(pendingSnapshot.latest_run, null);
    assert.equal(pendingSnapshot.context.pending, null);
    assert.equal((await tools(target, pendingTask)).approvals.length, 0);
    const recovery = await action(target, { kind: "recovery_status", task_id: pendingTask });
    assert.equal(recovery.required, true);
    assert.equal(recovery.items.length, pendingPreview.recovery.length);
    refused(await target.request({ kind: "start_execution", task_id: pendingTask }));
    assert.equal(fixture.records.length, pendingCalls, "unreviewed restoration contacted a model");
    assert.equal(await exists(join(toFolder, "source.txt")), false, "old write was replayed");
    report.checks.push({
      name: protocol + "_pending_archive_restores_as_inactive_history_with_mandatory_human_review",
      passed: true,
    });
    const oldApproval = await approve(source, root);
    assert.equal((await terminal(source, root)).task.state, "completed");
    assert.equal(await readFile(join(fromFolder, "source.txt"), "utf8"), "Original write 42");
    for (const text of ["排队要求 QUEUED_ALPHA", "下一条 QUEUED_BETA"])
      await source.request({ kind: "enqueue", task_id: root, text });
    await source.request({
      kind: "workspace",
      action: { kind: "rename_task", task_id: root, title: "已重命名的任务 " + protocol },
    });
    const before = await snapshot(source, root);
    test.step = before.steps.find((s) => s.name === "write_file").id;
    const archive = join(directory, protocol + ".wptask");
    await action(source, { kind: "export", task_id: root, path: archive, password: passphrase });
    const id = await importArchive(target, archive);
    const options = { archive_id: id, project_id: toProject, profile_id: local.id };
    refused(
      await target.request({
        kind: "task_archive",
        action: { kind: "restore_preview", ...options, project_id: null },
      }),
    );
    const wrong = profile(protocol, "wrong-model");
    await target.request({
      kind: "save_provider",
      profile: wrong,
      secret: null,
      clear_credential: false,
    });
    refused(
      await target.request({
        kind: "task_archive",
        action: { kind: "restore_preview", ...options, profile_id: wrong.id },
      }),
    );
    let preview = await action(target, { kind: "restore_preview", ...options });
    assert.equal(preview.queued, 2);
    assert.equal(preview.title, before.task.title + " · 恢复");
    assert.equal(preview.project.settings.root_path, toFolder);
    const callsBefore = fixture.records.length;
    const response = await target.request({
      kind: "save_provider",
      profile: { ...local, label: "Local renamed" },
      secret: null,
      clear_credential: false,
    });
    assert.equal(response.kind, "provider_saved");
    refused(
      await target.request({
        kind: "task_archive",
        action: { kind: "restore", ...options, fingerprint: preview.fingerprint },
      }),
    );
    preview = await action(target, { kind: "restore_preview", ...options });
    const changedProject = await target.request({
      kind: "workspace",
      action: {
        kind: "save_project",
        project_id: toProject,
        settings: { ...preview.project.settings, rules: "Changed destination rule" },
      },
    });
    assert.equal(changedProject.kind, "workspace", JSON.stringify(changedProject));
    refused(
      await target.request({
        kind: "task_archive",
        action: { kind: "restore", ...options, fingerprint: preview.fingerprint },
      }),
    );
    preview = await action(target, { kind: "restore_preview", ...options });
    const restored = await action(target, {
      kind: "restore",
      ...options,
      fingerprint: preview.fingerprint,
    });
    assert.equal(fixture.records.length, callsBefore, "restoration contacted a model");
    const task = restored.task_id;
    const after = await snapshot(target, task);
    const history = await target.request({
      kind: "workbench",
      task_id: task,
      action: { kind: "history", path: null, before: null, limit: 100 },
    });
    assert.equal(history.kind, "workbench", JSON.stringify(history));
    const legacy = history.data.items.find((r) => r.path === "source.txt");
    assert(legacy, "Legacy model file write was not included in task restoration");
    assert.equal(legacy.task_id, task);
    assert.equal(legacy.origin.task_id, root);
    const versions = await target.request({
      kind: "workbench",
      task_id: task,
      action: { kind: "revision", revision_id: legacy.id },
    });
    assert.equal(versions.kind, "workbench", JSON.stringify(versions));
    assert.equal(versions.data.after.text, "Original write 42");
    assert.equal(await exists(join(toFolder, "source.txt")), false);
    assert.equal(after.latest_run, null);
    assert.equal(after.task.state, "completed");
    assert.notEqual(after.session_id, before.session_id);
    assert.notEqual(after.agent_id, before.agent_id);
    assert.deepEqual(after.context.history, before.context.history);
    assert.deepEqual(after.context.plan, before.context.plan);
    assert.equal(after.context.directions[0].text, before.context.directions[0].text);
    assert.notEqual(
      after.context.directions[0].message_id,
      before.context.directions[0].message_id,
    );
    assert.equal((await tools(target, task)).approvals.length, 0);
    const detail = await target.request({
      kind: "read",
      query: { kind: "workspace", query: { kind: "detail", task_id: task } },
    });
    assert.equal(detail.data.effective_permission, "request_approval");
    refused(
      await target.request({
        kind: "decide_tool_approval",
        task_id: task,
        approval_id: oldApproval.id,
        fingerprint: oldApproval.fingerprint,
        approve: true,
      }),
    );
    const conversation = await target.request({
      kind: "read",
      query: {
        kind: "workspace",
        query: { kind: "conversation", task_id: task, before: null, limit: 24 },
      },
    });
    assert.equal(conversation.kind, "workspace", JSON.stringify(conversation));
    assert(conversation.data.entries.some((e) => e.text.includes("原任务完成 42")));
    assert(conversation.data.entries.some((e) => e.text.includes("KEEP_ORIGINAL_42")));
    test.phase = "restore";
    await start(target, task);
    assert.equal((await terminal(target, task)).task.state, "awaiting_approval");
    assert.equal(await exists(join(toFolder, "continued.txt")), false);
    const sent = requests.find((r) => r.model === model && r.phase === "restore");
    for (const text of ["KEEP_ORIGINAL_42", "QUEUED_ALPHA", "QUEUED_BETA"])
      assert(JSON.stringify(sent.body).includes(text));
    const lookup = requests.find(
      (r) => r.model === model && r.phase === "restore" && r.results.length === 2,
    );
    const priorResult = JSON.parse(lookup.results[1]);
    assert.equal(priorResult.is_error, false, JSON.stringify(priorResult));
    assert.equal(JSON.parse(priorResult.output).path, "source.txt");
    await approve(target, task);
    assert.equal((await terminal(target, task)).task.state, "completed");
    assert.equal(
      await readFile(join(toFolder, "continued.txt"), "utf8"),
      "Restored continuation 007",
    );
    assert.equal(await exists(join(toFolder, "source.txt")), false, "old effect replayed");
    assert.deepEqual(await snapshot(source, root), before);
    assert.deepEqual(await snapshot(target, keep), keepBefore);
    report.checks.push({
      name:
        protocol +
        "_full_context_messages_and_results_restored_project_mapped_old_approval_rejected_new_write_approved_once",
      passed: true,
    });
    await target.close();
    target = await launch(join(directory, "target"));
    const duplicate = await action(target, {
      kind: "restore",
      ...options,
      fingerprint: preview.fingerprint,
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.task_id, task);
    assert.equal((await snapshot(target, task)).task.state, "completed");
    // A restored task remains portable, including its scoped history lookup.
    const second = join(directory, protocol + "-again.wptask");
    await action(target, { kind: "export", task_id: task, path: second, password: passphrase });
    const secondId = await importArchive(target, second);
    const secondOptions = { ...options, archive_id: secondId };
    const secondPreview = await action(target, { kind: "restore_preview", ...secondOptions });
    await action(target, {
      kind: "restore",
      ...secondOptions,
      fingerprint: secondPreview.fingerprint,
    });
    report.checks.push({
      name: protocol + "_restart_idempotence_and_second_migration_preserve_history_without_restart",
      passed: true,
    });
  }
  assert(fixture.records.every((r) => r.correlationValid));
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
