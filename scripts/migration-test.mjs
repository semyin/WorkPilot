import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rename, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  launch,
  create,
  snapshot,
  start,
  terminal,
  until,
  setFixture,
} from "./tool-test-support.mjs";
import { project, wb, history, done, saveFile, refused } from "./task-history-support.mjs";
import { startExecutionFixture } from "../services/execution-fixtures/server.mjs";
import { installExtension, extensionAdmin } from "./extension-transfer-fixtures.mjs";
const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/migration");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "session-"));
const binary = process.env.WORKPILOT_ENGINE_BINARY || resolve("target/debug/workpilot-engine.exe");
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  binarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  service: "Real engines, isolated data roots and localhost synthetic model",
  checks: [],
};
const requests = [];
const fixture = await startExecutionFixture((body, results) => {
  requests.push(body.model);
  if (body.model === "migration-pending" && !results.length)
    return {
      text: "",
      calls: [
        {
          name: "write_file",
          args: {
            path: "unknown-effect.txt",
            text: "must require new approval",
            expected_sha256: null,
          },
        },
      ],
    };
  return { text: "Migration fixture completed 42", calls: [] };
});
setFixture(fixture);
const password = "Unified migration fixture " + crypto.randomUUID();
const call = async (e, action) => {
  const r = await e.request({ kind: "migration", action });
  assert.equal(r.kind, "workbench", JSON.stringify(r));
  return r.data;
};
const exists = (p) =>
  access(p).then(
    () => true,
    () => false,
  );
const data = join(directory, "target-data");
let source, target;
try {
  source = await launch(join(directory, "source-data"));
  target = await launch(data);
  const p1 = await project(source, "资料一", join(directory, "原目录 一"));
  const p2 = await project(source, "资料二", join(directory, "原目录 二"));
  const first = await create(source, "chat_completions", "migration-one", {
    project_id: p1,
    controlled_tools: false,
  });
  const second = await create(source, "messages", "migration-two", {
    project_id: p2,
    controlled_tools: false,
  });
  await start(source, first);
  await terminal(source, first, ["completed"]);
  await start(source, second);
  await terminal(source, second, ["completed"]);
  await saveFile(source, first, "同名.txt", "first before");
  await saveFile(source, first, "同名.txt", "first after 42");
  await saveFile(source, second, "同名.txt", "second independent");
  const skill = join(directory, "技能包"),
    draft = join(directory, "技能草稿");
  await mkdir(skill);
  await mkdir(draft);
  const skillFile = join(skill, "SKILL.md");
  await writeFile(
    skillFile,
    "---\nname: unified-migration-skill\ndescription: Full migration fixture\n---\nFirst saved instructions.\n",
  );
  await installExtension(source.request, first, skill, true);
  await writeFile(
    skillFile,
    "---\nname: unified-migration-skill\ndescription: Full migration fixture\n---\nSecond saved instructions.\n",
  );
  const installedSkill = await installExtension(source.request, first, skill, true);
  await writeFile(
    join(draft, "SKILL.md"),
    "---\nname: unified-migration-draft\ndescription: Uninstalled draft\n---\nReview before use.\n",
  );
  const draftPreview = await extensionAdmin(source.request, first, {
    kind: "preview",
    source: draft,
    project: true,
  });
  const pending = await create(source, "responses", "migration-pending", {
    project_id: p1,
    controlled_tools: false,
  });
  const configured = await source.request({
    kind: "configure_task_tools",
    task_id: pending,
    settings: {
      permission: "request_approval",
      root_path: join(directory, "原目录 一"),
      commands_enabled: false,
      revision: 0,
    },
  });
  assert.equal(configured.kind, "receipt", JSON.stringify(configured));
  await start(source, pending);
  await terminal(source, pending, ["awaiting_approval"]);
  const memory = await source.request({
    kind: "memory",
    action: { kind: "save", memory_id: null, revision: 0, project_id: p1, text: "中文迁移记忆 42" },
  });
  assert.equal(memory.kind, "memory", JSON.stringify(memory));
  const sourceDb = new DatabaseSync(join(directory, "source-data", "test", "workpilot.sqlite3"));
  sourceDb
    .prepare("UPDATE memories SET source_task_id=? WHERE id=?")
    .run(first, memory.data.memory_id);
  sourceDb
    .prepare(
      "UPDATE memory_meta SET data_json=json_set(data_json,'$.memory.source_task_id',?) WHERE memory_id=?",
    )
    .run(first, memory.data.memory_id);
  sourceDb
    .prepare(
      "UPDATE memory_versions SET data_json=json_set(data_json,'$.memory.source_task_id',?) WHERE memory_id=?",
    )
    .run(first, memory.data.memory_id);
  sourceDb.close();
  const cat = await call(source, { kind: "catalog" });
  const profileFor = async (task) => (await snapshot(source, task)).config.profile_id;
  const selections = [
    {
      project_id: p1,
      profile_ids: [await profileFor(first), await profileFor(pending)],
      memory_ids: [memory.data.memory_id],
      task_ids: [first, pending],
      files: ["同名.txt"],
      extensions: [{ installation_id: installedSkill.id, revision: installedSkill.revision }],
      draft_ids: [draftPreview.id],
    },
    {
      project_id: p2,
      profile_ids: [await profileFor(second)],
      memory_ids: [],
      task_ids: [second],
      files: ["同名.txt"],
      extensions: [],
      draft_ids: [],
    },
  ];
  assert.equal(cat.projects.length, 2);
  const path = join(directory, "统一备份.wpmigrate");
  await call(source, { kind: "export", selections, path, password });
  await source.close();
  source = null;
  await rename(join(directory, "原目录 一"), join(directory, "原目录 已离线一"));
  await rename(join(directory, "原目录 二"), join(directory, "原目录 已离线二"));
  refused(
    await target.request({
      kind: "migration",
      action: { kind: "inspect", path, password: "wrong passphrase" },
    }),
  );
  const corrupted = Buffer.from(await readFile(path));
  corrupted[corrupted.length - 4] ^= 1;
  const bad = join(directory, "损坏.wpmigrate");
  await writeFile(bad, corrupted);
  refused(
    await target.request({ kind: "migration", action: { kind: "inspect", path: bad, password } }),
  );
  assert.equal((await call(target, { kind: "catalog" })).projects.length, 0);
  const summary = await call(target, { kind: "inspect", path, password });
  assert.equal(summary.projects.length, 2);
  assert.equal(summary.tasks.length, 3);
  report.checks.push(
    "Single encrypted selection includes two projects, three conversations, all task history and selected files; wrong password/tampering create no projects",
  );
  const destinations = summary.projects.map((p, n) => ({
    source_project_id: p.id,
    name: "新项目 " + n,
    root_path: join(directory, "新目录 " + n),
  }));
  for (const d of destinations) await mkdir(d.root_path, { recursive: true });
  const history_roots = summary.history_roots.map((root) => ({
    source_root: root,
    source_project_id: summary.projects.find((p) => p.source_root === root).id,
  }));
  const args = { path, password, destinations, history_roots };
  await writeFile(join(destinations[0].root_path, "同名.txt"), "existing target");
  const conflicted = await call(target, { kind: "preview", ...args });
  assert(conflicted.conflicts.length);
  refused(
    await target.request({
      kind: "migration",
      action: { kind: "import", ...args, fingerprint: conflicted.fingerprint },
    }),
  );
  assert.equal((await call(target, { kind: "catalog" })).projects.length, 0);
  await rename(
    join(destinations[0].root_path, "同名.txt"),
    join(destinations[0].root_path, "keep-existing.txt"),
  );
  const preview = await call(target, { kind: "preview", ...args });
  assert.equal(preview.conflicts.length, 0);
  const beforeRequests = requests.length;
  const faultDb = new DatabaseSync(join(data, "test", "workpilot.sqlite3"));
  faultDb.exec(
    "CREATE TRIGGER reject_migrated_task BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT,'synthetic storage fault'); END",
  );
  const partial = await call(target, { kind: "import", ...args, fingerprint: preview.fingerprint });
  assert.equal(partial.status, "partial", JSON.stringify(partial));
  assert.equal(Object.keys(partial.projects).length, 2);
  assert.equal(Object.keys(partial.tasks).length, 0);
  faultDb.exec("DROP TRIGGER reject_migrated_task");
  faultDb.close();
  await target.close();
  target = await launch(data);
  const resumedPreview = await call(target, { kind: "preview", ...args });
  const receipt = await call(target, {
    kind: "import",
    ...args,
    fingerprint: resumedPreview.fingerprint,
  });
  assert.equal(receipt.status, "awaiting_file_approval", JSON.stringify(receipt));
  assert.equal(requests.length, beforeRequests);
  assert.equal((await call(target, { kind: "catalog" })).projects.length, 2);
  for (const d of destinations) assert.equal(await exists(join(d.root_path, "同名.txt")), false);
  const imported = Object.values(receipt.tasks).flatMap((t) => t.tasks);
  const next = (id) => imported.find((t) => t.source_task_id === id).task_id;
  assert.equal(
    (await snapshot(target, next(first))).task.project_id,
    receipt.projects[p1].project_id,
  );
  assert.equal(
    (await snapshot(target, next(second))).task.project_id,
    receipt.projects[p2].project_id,
  );
  assert.equal((await history(target, next(first))).length, 2);
  assert.equal((await history(target, next(second))).length, 1);
  const targetCatalog = await call(target, { kind: "catalog" });
  assert(targetCatalog.profiles.every((p) => p.credential === null));
  assert.equal(
    targetCatalog.memories.find((m) => m.text === "中文迁移记忆 42").source_task_id,
    next(first),
  );
  const extensionCatalog = targetCatalog.extensions.find(
    (e) => e.project_id === receipt.projects[p1].project_id,
  ).catalog;
  const importedSkill = extensionCatalog.items.find(
    (e) => e.installation.slug === "unified-migration-skill",
  );
  assert(importedSkill);
  assert.equal(importedSkill.installation.enabled, false);
  assert(extensionCatalog.drafts.some((e) => e.version.manifest.id === "unified-migration-draft"));
  const versions = await extensionAdmin(target.request, next(first), {
    kind: "versions",
    installation_id: importedSkill.installation.id,
  });
  assert.equal(
    new Set(versions.history.map((v) => v.data.active_digest)).size,
    2,
    JSON.stringify(versions),
  );
  report.checks.push(
    "The unified archive includes installed skill history and an uninstalled draft; target skills stay disabled and project scope changes to the mapped folder",
  );
  report.checks.push(
    "Injected database failure retains project receipts but exposes no half task; restart resumes the same migration without duplicate projects and maps memory provenance to the new task",
  );
  report.checks.push(
    "Explicit destination mapping preserves distinct projects, model credentials stay absent, history and memory restore without model calls or project-file writes",
  );
  const review = await target.request({
    kind: "task_archive",
    action: { kind: "recovery_status", task_id: next(pending) },
  });
  assert.equal(review.data.required, true);
  refused(await target.request({ kind: "start_execution", task_id: next(pending) }));
  await target.request({
    kind: "enqueue",
    task_id: next(pending),
    text: "old queued messages do not authorize replay",
  });
  refused(await target.request({ kind: "start_execution", task_id: next(pending) }));
  assert.equal(requests.length, beforeRequests);
  await target.close();
  target = await launch(data);
  const restoredStatus = await target.request({
    kind: "task_archive",
    action: { kind: "recovery_status", task_id: next(pending) },
  });
  assert.equal(restoredStatus.data.required, true);
  const resolved = await target.request({
    kind: "task_archive",
    action: {
      kind: "resolve_recovery",
      task_id: next(pending),
      notes: restoredStatus.data.items.map(
        () =>
          "I checked the source and destination. The old action was not executed. Read the destination before any fresh request.",
      ),
    },
  });
  assert.equal(resolved.kind, "workbench", JSON.stringify(resolved));
  assert.equal((await snapshot(target, next(pending))).latest_run, null);
  assert.equal(await exists(join(destinations[0].root_path, "unknown-effect.txt")), false);
  report.checks.push(
    "Unresolved original actions require explicit per-item human review; old queued messages and restart cannot bypass review; saving review runs no model or tool",
  );
  for (const [source_project_id, files] of Object.entries(receipt.files)) {
    const proposed = await call(target, {
      kind: "prepare_files",
      archive_id: receipt.archive_id,
      source_project_id,
    });
    assert.equal(proposed.operation.state, "awaiting_approval", JSON.stringify(proposed));
    const approved = await wb(target, files.task_id, {
      kind: "approve",
      operation_id: proposed.operation.id,
      fingerprint: proposed.operation.fingerprint,
    });
    await done(target, files.task_id, approved.operation);
  }
  assert.equal(
    await readFile(join(destinations[0].root_path, "同名.txt"), "utf8"),
    "first after 42",
  );
  assert.equal(
    await readFile(join(destinations[1].root_path, "同名.txt"), "utf8"),
    "second independent",
  );
  assert.equal(
    await readFile(join(destinations[0].root_path, "keep-existing.txt"), "utf8"),
    "existing target",
  );
  assert.equal(
    (await call(target, { kind: "status", archive_id: receipt.archive_id })).status,
    "complete",
  );
  report.checks.push(
    "Selected current files require fresh approval, then write exact bytes in their mapped project; unrelated existing files remain intact",
  );
  const repeatedPreview = await call(target, { kind: "preview", ...args });
  const repeated = await call(target, {
    kind: "import",
    ...args,
    fingerprint: repeatedPreview.fingerprint,
  });
  assert.equal(Object.values(repeated.tasks)[0].task_id, Object.values(receipt.tasks)[0].task_id);
  assert.equal((await call(target, { kind: "catalog" })).projects.length, 2);
  refused(
    await target.request({
      kind: "migration",
      action: {
        kind: "preview",
        ...args,
        destinations: destinations.map((d) => ({ ...d, name: d.name + " changed" })),
      },
    }),
  );
  report.checks.push(
    "Repeated import after restart uses durable component receipts and never re-creates tasks/projects; changing bound destination mapping is rejected",
  );
  report.status = "passed";
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  await source?.close();
  await target?.close();
  await fixture.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
