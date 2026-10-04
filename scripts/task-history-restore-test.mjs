import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  launch,
  create,
  profile,
  snapshot,
  start,
  until,
  setFixture,
} from "./tool-test-support.mjs";
import { startTeamFixture } from "../services/execution-fixtures/teams.mjs";
import {
  project,
  wb,
  history,
  done,
  saveFile,
  archive,
  importArchive,
  refused,
} from "./task-history-support.mjs";

const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/task-history-restore");
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
    "Real engines and encrypted archives; separate data roots and a local synthetic team model",
  checks: [],
};
const fixture = await startTeamFixture();
setFixture(fixture);
const password = "history fixture " + crypto.randomUUID();
const sourceData = join(directory, "source"),
  targetData = join(directory, "target");
const from = join(directory, "原项目"),
  to = join(directory, "目标项目");
const name = "同一个文件.txt",
  binaryName = "助手保存.bin";
const bytes = Buffer.from([0, 255, 12, 13, 10, 194, 99, 0, 42]);
let source, target;
const pass = (name) => report.checks.push(name);
async function team(e, task) {
  const r = await e.request({ kind: "read", query: { kind: "team", task_id: task } });
  assert.equal(r.kind, "team", JSON.stringify(r));
  return r.view;
}
async function saveProfile(e, p) {
  const r = await e.request({
    kind: "save_provider",
    profile: p,
    secret: null,
    clear_credential: false,
  });
  assert.equal(r.kind, "provider_saved", JSON.stringify(r));
  return r.profile.profile;
}
try {
  source = await launch(sourceData);
  target = await launch(targetData);
  const fromProject = await project(source, "Original", from);
  const toProject = await project(target, "Destination", to);
  const leaf = await saveProfile(source, profile("chat_completions", "history-leaf"));
  fixture.definitions.set(leaf.model, { kind: "leaf", text: "Child saved delivery 42" });
  fixture.definitions.set("history-main", {
    kind: "main",
    members: [
      {
        key: "editor",
        role: "文件助手",
        goal: "保存修改记录",
        profile_id: leaf.id,
        depends_on: [],
      },
    ],
  });
  const root = await create(source, "responses", "history-main", {
    title: "带文件历史的团队",
    controlled_tools: false,
    project_id: fromProject,
  });
  await source.request({ kind: "enqueue", task_id: root, text: "Keep saved project history" });
  await start(source, root);
  const completed = await until(async () => {
    const s = await snapshot(source, root);
    return ["completed", "failed"].includes(s.task.state) && s;
  }, 60000);
  assert.equal(completed.task.state, "completed");
  const child = (await team(source, root)).members[0].task_id;
  await saveFile(source, root, name, "第一版 42");
  await saveFile(source, root, name, "第二版 007");
  await writeFile(join(from, binaryName), bytes);
  const binaryView = await wb(source, child, { kind: "read_file", path: binaryName });
  const deletion = await wb(source, child, {
    kind: "edit",
    edit: {
      kind: "delete",
      path: binaryName,
      expected: binaryView.version,
    },
  });
  // The child inherits the project's policy. Handle an explicit child approval if required.
  if (deletion.operation.state === "awaiting_approval")
    await wb(source, child, {
      kind: "approve",
      operation_id: deletion.operation.id,
      fingerprint: deletion.operation.fingerprint,
    });
  await done(source, child, deletion.operation);
  const originals = await history(source, root);
  assert.equal(originals.length, 3);
  const beforeSource = await snapshot(source, root);
  await rename(from, from + "-offline");
  const path = join(directory, "团队与历史.wptask");
  await archive(source, { kind: "export", task_id: root, path, password });
  assert.deepEqual(await snapshot(source, root), beforeSource);
  const encrypted = await readFile(path);
  assert(!encrypted.includes(bytes));
  assert(!encrypted.includes(Buffer.from("第二版 007")));
  assert(!encrypted.includes(Buffer.from(password)));
  await source.close();
  source = null;
  await rename(sourceData, sourceData + "-offline");
  pass("multiple_versions_and_child_binary_export_with_original_project_and_data_offline");

  await writeFile(join(to, name), "用户当前文件");
  await writeFile(join(to, binaryName), "用户当前二进制位置");
  const keep = await create(target, "responses", "unrelated", { project_id: toProject });
  const beforeKeep = await snapshot(target, keep);
  refused(
    await target.request({
      kind: "task_archive",
      action: { kind: "inspect", path, password: "wrong-password" },
    }),
  );
  const corrupt = join(directory, "damaged.wptask"),
    changed = Buffer.from(encrypted);
  changed[changed.length - 1] ^= 1;
  await writeFile(corrupt, changed);
  refused(
    await target.request({
      kind: "task_archive",
      action: { kind: "inspect", path: corrupt, password },
    }),
  );
  const id = await importArchive(target, path, password);
  assert.equal((await history(target, keep)).length, 0);
  const options = await archive(target, { kind: "team_restore_options", archive_id: id });
  const profiles = [];
  for (const item of options.tasks) {
    const p = await saveProfile(target, profile(item.model.protocol, item.model.model));
    profiles.push({ task_id: item.task_id, profile_id: p.id });
  }
  const mapping = { archive_id: id, project_id: toProject, profiles };
  refused(
    await target.request({
      kind: "task_archive",
      action: {
        kind: "team_restore_preview",
        ...mapping,
        project_id: null,
      },
    }),
  );
  const preview = await archive(target, { kind: "team_restore_preview", ...mapping });
  assert.equal(preview.file_history_included, true);
  assert.equal(preview.file_history.length, 3);
  assert.equal(preview.file_history.filter((r) => r.task_id === child).length, 1);
  assert.notEqual(
    await readFile(join(sourceData + "-offline", "test/versions/key-id"), "utf8"),
    await readFile(join(targetData, "test/versions/key-id"), "utf8"),
  );
  // Confirm the second integrity check refuses a lost encrypted history object.
  const vaultDir = join(targetData, "test/versions");
  const find = async (dir) => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, item.name);
      if (item.isDirectory()) {
        const result = await find(file);
        if (result) return result;
      } else if (item.name !== "key-id") return file;
    }
  };
  const missing = await find(vaultDir);
  assert(missing);
  await rename(missing, missing + ".hidden");
  refused(
    await target.request({
      kind: "task_archive",
      action: {
        kind: "team_restore",
        ...mapping,
        fingerprint: preview.fingerprint,
      },
    }),
  );
  assert.equal((await history(target, keep)).length, 0);
  await rename(missing + ".hidden", missing);
  const calls = fixture.records.length;
  const restored = await archive(target, {
    kind: "team_restore",
    ...mapping,
    fingerprint: preview.fingerprint,
  });
  assert.equal(fixture.records.length, calls);
  const ids = new Map(restored.tasks.map((r) => [r.source_task_id, r.task_id]));
  const rows = await history(target, restored.task_id);
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((r) => r.operation_id)).size, 3);
  for (const r of rows) {
    const original = originals.find((o) => o.id === r.origin.revision_id);
    assert(original);
    assert.equal(r.origin.task_id, original.task_id);
    assert.equal(r.task_id, ids.get(original.task_id));
    assert.notEqual(r.root_identity, original.root_identity);
    assert.equal(r.before.version.identity, null);
    assert.equal(r.after.version.identity, null);
  }
  assert.equal(await readFile(join(to, name), "utf8"), "用户当前文件");
  assert.equal(await readFile(join(to, binaryName), "utf8"), "用户当前二进制位置");
  assert.deepEqual(await snapshot(target, keep), beforeKeep);
  pass(
    "integrity_required_project_and_atomic_group_restore_preserve_owners_sources_files_and_independent_encryption",
  );

  const binaryRow = rows.find((r) => r.path === binaryName),
    task = ids.get(child);
  const view = await wb(target, task, { kind: "revision", revision_id: binaryRow.id });
  assert.equal(view.before.version.sha256, createHash("sha256").update(bytes).digest("hex"));
  const requestRestore = (version) =>
    wb(target, task, {
      kind: "edit",
      edit: {
        kind: "restore",
        revision_id: binaryRow.id,
        before: true,
        expected: version,
      },
    });
  const pending = await requestRestore(view.current_version);
  assert.equal(pending.operation.state, "awaiting_approval");
  await writeFile(join(to, binaryName), "审批期间的新修改");
  const decision = await target.request({
    kind: "workbench",
    task_id: task,
    action: {
      kind: "approve",
      operation_id: pending.operation.id,
      fingerprint: pending.operation.fingerprint,
    },
  });
  if (decision.kind === "workbench") await done(target, task, pending.operation, "failed");
  else {
    refused(decision);
    await wb(target, task, { kind: "stop", operation_id: pending.operation.id });
  }
  assert.equal(await readFile(join(to, binaryName), "utf8"), "审批期间的新修改");
  const fresh = await wb(target, task, { kind: "revision", revision_id: binaryRow.id });
  const approved = await requestRestore(fresh.current_version);
  await wb(target, task, {
    kind: "approve",
    operation_id: approved.operation.id,
    fingerprint: approved.operation.fingerprint,
  });
  await done(target, task, approved.operation);
  assert.deepEqual(await readFile(join(to, binaryName)), bytes);
  const updated = await history(target, task);
  assert.equal(updated.length, 4);
  const last = await wb(target, task, { kind: "revision", revision_id: updated[0].id });
  assert.equal(last.before.text, "审批期间的新修改");
  const otherFolder = join(directory, "无关项目");
  const otherProject = await project(target, "Other", otherFolder);
  const other = await create(target, "responses", "other", { project_id: otherProject });
  refused(
    await target.request({
      kind: "workbench",
      task_id: other,
      action: { kind: "revision", revision_id: binaryRow.id },
    }),
  );
  pass(
    "imported_binary_restore_requires_fresh_approval_blocks_changed_file_and_saves_replaced_content_with_project_scope",
  );

  // The independent history archive uses the same portable codec. Two versions
  // of the same path must have distinct import operations as well.
  const historyPath = join(directory, "两次修改.wphistory");
  const textRows = rows.filter((r) => r.path === name);
  const transfer = async (task_id, action) => {
    const r = await target.request({ kind: "history_transfer", task_id, action });
    assert.equal(r.kind, "workbench", JSON.stringify(r));
    return r.data;
  };
  await transfer(restored.task_id, {
    kind: "export",
    revision_ids: textRows.map((r) => r.id),
    path: historyPath,
    password,
  });
  const hp = await transfer(other, { kind: "inspect", path: historyPath, password });
  const hi = await transfer(other, {
    kind: "import",
    path: historyPath,
    password,
    fingerprint: hp.fingerprint,
  });
  assert.equal(hi.duplicate, false);
  const importedRows = await history(target, other);
  assert.equal(importedRows.length, 2);
  assert.equal(new Set(importedRows.map((r) => r.operation_id)).size, 2);
  assert.equal(
    (
      await transfer(other, {
        kind: "import",
        path: historyPath,
        password,
        fingerprint: hp.fingerprint,
      })
    ).duplicate,
    true,
  );
  for (const r of importedRows) {
    assert(textRows.some((t) => t.origin.revision_id === r.origin.revision_id));
  }
  pass(
    "standalone_history_archive_accepts_two_versions_of_same_path_preserves_first_origin_and_deduplicates",
  );

  const secondPath = join(directory, "再次备份.wptask");
  await archive(target, { kind: "export", task_id: restored.task_id, path: secondPath, password });
  const secondId = await importArchive(target, secondPath, password);
  const secondOptions = await archive(target, {
    kind: "team_restore_options",
    archive_id: secondId,
  });
  const sourceToProfile = new Map(profiles.map((r) => [ids.get(r.task_id), r.profile_id]));
  const secondMapping = {
    archive_id: secondId,
    project_id: otherProject,
    profiles: secondOptions.tasks.map((r) => ({
      task_id: r.task_id,
      profile_id: sourceToProfile.get(r.task_id),
    })),
  };
  const secondPreview = await archive(target, { kind: "team_restore_preview", ...secondMapping });
  assert.equal(secondPreview.file_history.length, 4);
  const second = await archive(target, {
    kind: "team_restore",
    ...secondMapping,
    fingerprint: secondPreview.fingerprint,
  });
  const secondRows = (await history(target, second.task_id)).filter((r) =>
    second.tasks.some((t) => t.task_id === r.task_id),
  );
  assert.equal(secondRows.length, 4);
  assert(secondRows.some((r) => r.origin.revision_id === binaryRow.origin.revision_id));
  await target.close();
  target = await launch(targetData);
  const duplicate = await archive(target, {
    kind: "team_restore",
    ...mapping,
    fingerprint: preview.fingerprint,
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.task_id, restored.task_id);
  assert.equal((await history(target, restored.task_id)).length, 4);
  assert.equal(fixture.records.length, calls);
  pass(
    "reexport_and_second_project_restore_preserve_first_origins_restart_deduplicates_and_never_runs_old_tools",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  await source?.close();
  await target?.close();
  await fixture.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
