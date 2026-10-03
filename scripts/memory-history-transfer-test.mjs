import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { launch } from "./tool-test-support.mjs";

const output = resolve(
  process.env.WORKPILOT_TEST_OUTPUT || ".test-results/memory-history-transfer",
);
await mkdir(output, { recursive: true });
const base = await mkdtemp(join(output, "历史迁移-"));
const binary = process.env.WORKPILOT_ENGINE_BINARY || resolve("target/debug/workpilot-engine.exe");
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  binarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  checks: [],
};
let source, target;
const request = async (engine, command) => {
  const r = await engine.request(command);
  assert.notEqual(r.kind, "error", JSON.stringify(r));
  return r;
};
const memory = async (engine, action) => (await request(engine, { kind: "memory", action })).data;
const transfer = async (engine, action) =>
  (await request(engine, { kind: "project_transfer", action })).data;
const password = "fixture memory history passphrase";
try {
  const sourceDir = join(base, "source"),
    targetDir = join(base, "target"),
    folder = join(base, "原项目"),
    destination = join(base, "新项目");
  for (const path of [sourceDir, targetDir, folder, destination]) await mkdir(path);
  source = await launch(sourceDir);
  const p = (
    await request(source, {
      kind: "workspace",
      action: {
        kind: "save_project",
        project_id: null,
        settings: {
          name: "原项目",
          root_path: folder,
          default_profile_id: null,
          permission: "full_access",
          rules: "",
          revision: 0,
        },
      },
    })
  ).data.project;
  const m = (
    await memory(source, {
      kind: "save",
      memory_id: null,
      revision: 0,
      project_id: null,
      text: "原始通用记忆",
    })
  ).memory_id;
  await memory(source, {
    kind: "save",
    memory_id: m,
    revision: 1,
    project_id: p.id,
    text: "修改后的项目记忆",
  });
  await memory(source, { kind: "delete", memory_id: m, revision: 2 });
  const path = join(base, "完整历史.wpsettings");
  const exportAction = {
    kind: "export",
    project_id: p.id,
    profile_ids: [],
    memory_ids: [m],
    path,
    password,
    include_memory_history: true,
  };
  assert.equal(
    (
      await source.request({
        kind: "project_transfer",
        action: { ...exportAction, include_memory_history: false },
      })
    ).kind,
    "error",
  );
  await transfer(source, exportAction);
  const bytes = await readFile(path);
  for (const text of [password, "原始通用记忆", "修改后的项目记忆"])
    assert(!bytes.includes(Buffer.from(text)));
  report.checks.push("real_engine_exports_deleted_memory_with_encrypted_complete_revisions");
  await source.close();
  source = null;
  target = await launch(targetDir);
  const inspect = { kind: "inspect", path, password, root_path: destination, name: "导入项目" };
  const preview = await transfer(target, inspect);
  assert.equal(preview.memory_history[0].versions, 3);
  assert(preview.memories[0].deleted);
  const imported = await transfer(target, {
    ...inspect,
    kind: "import",
    fingerprint: preview.fingerprint,
  });
  const id = imported.receipt.memories[0].target_id;
  assert.notEqual(id, m);
  const list = () =>
    memory(target, {
      kind: "list",
      project_id: imported.receipt.project_id,
      search: "",
      include_deleted: false,
      offset: 0,
      limit: 64,
    });
  assert.equal((await list()).items.length, 0);
  const history = () =>
    memory(target, { kind: "history", memory_id: id, before_revision: null, limit: 64 });
  assert.equal((await history()).items.length, 4);
  await target.close();
  target = await launch(targetDir);
  assert.equal((await list()).items.length, 0);
  assert.equal(
    (await transfer(target, { ...inspect, kind: "import", fingerprint: preview.fingerprint }))
      .duplicate,
    true,
  );
  assert.equal((await history()).items.length, 4);
  report.checks.push("preview_counts_state_and_restart_dedup_preserve_inactive_imported_history");
  await memory(target, { kind: "restore", memory_id: id, revision: 4, target_revision: 1 });
  let active = (await list()).items[0];
  assert.equal(active.text, "原始通用记忆");
  assert.equal(active.project_id, null);
  await memory(target, { kind: "restore", memory_id: id, revision: 5, target_revision: 2 });
  active = (await list()).items[0];
  assert.equal(active.text, "修改后的项目记忆");
  assert.equal(active.project_id, imported.receipt.project_id);
  assert.equal((await history()).items.length, 6);
  report.checks.push(
    "restoration_keeps_original_global_or_project_scope_and_appends_a_new_version",
  );
  const damaged = Buffer.from(bytes);
  damaged[damaged.length - 1] ^= 1;
  const broken = join(base, "损坏包.wpsettings");
  await writeFile(broken, damaged);
  assert.equal(
    (await target.request({ kind: "project_transfer", action: { ...inspect, path: broken } })).kind,
    "error",
  );
  assert.equal((await history()).items.length, 6);
  report.checks.push("tampered_history_archive_is_rejected_without_mutating_restored_data");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  await source?.close().catch(() => {});
  await target?.close().catch(() => {});
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
