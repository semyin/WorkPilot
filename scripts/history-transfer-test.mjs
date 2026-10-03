import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { launch, create, until, profile } from "./tool-test-support.mjs";
const output = resolve(
  process.env.WORKPILOT_TEST_OUTPUT || ".test-results/history-transfer-engine",
);
await mkdir(output, { recursive: true });
const binary = process.env.WORKPILOT_ENGINE_BINARY || resolve("target/debug/workpilot-engine.exe");
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  binarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  checks: [],
};
const passphrase = "fixture history passphrase";
let source, target;
async function setup(engine, folder, name, permission = "full_access") {
  const task = await create(engine, "responses", name);
  const result = await engine.request({
    kind: "configure_task_tools",
    task_id: task,
    settings: {
      root_path: folder,
      permission,
      commands_enabled: false,
      review_profile_id: null,
      revision: 0,
    },
  });
  assert.equal(result.kind, "receipt");
  return task;
}
async function wb(engine, task, action) {
  const r = await engine.request({ kind: "workbench", task_id: task, action });
  assert.equal(r.kind, "workbench", JSON.stringify(r));
  return r.data;
}
const history = async (e, t) =>
  (await wb(e, t, { kind: "history", path: null, before: null, limit: 100 })).items;
async function done(e, t, operation) {
  return until(async () => {
    const rows = await wb(e, t, { kind: "operations" });
    const op = rows.items.find((r) => r.operation.id === operation.id)?.operation;
    if (op?.state === "failed") throw new Error(op.error);
    return op?.state === "completed" && op;
  }, 20000);
}
const transfer = (e, t, action) => e.request({ kind: "history_transfer", task_id: t, action });
async function ok(e, t, action) {
  const r = await transfer(e, t, action);
  assert.equal(r.kind, "workbench", JSON.stringify(r));
  return r.data;
}
try {
  const base = await mkdtemp(join(output, "中文 迁移-"));
  const original = join(base, "原项目"),
    destination = join(base, "新项目");
  await mkdir(original);
  await mkdir(destination);
  const sourceData = join(base, "source-data"),
    targetData = join(base, "target-data");
  await mkdir(sourceData);
  await mkdir(targetData);
  source = await launch(sourceData);
  const sourceTask = await setup(source, original, "source-history");
  const privateProfile = profile("responses", "excluded-model-configuration");
  privateProfile.auth = "bearer";
  const modelCanary = "MODEL-CREDENTIAL-FIXTURE-P12";
  const privateSaved = await source.request({
    kind: "save_provider",
    profile: privateProfile,
    secret: modelCanary,
    clear_credential: false,
  });
  assert.equal(privateSaved.kind, "provider_saved");
  const name = "中文 历史.bin",
    bytes = Buffer.from([0, 255, 17, 13, 10, 244, 123, 0, 99]);
  await writeFile(join(original, name), bytes);
  const initial = await wb(source, sourceTask, { kind: "read_file", path: name });
  const change = await wb(source, sourceTask, {
    kind: "edit",
    edit: { kind: "delete", path: name, expected: initial.version },
  });
  await done(source, sourceTask, change.operation);
  const rows = await history(source, sourceTask);
  assert.equal(rows.length, 1);
  const archive = join(base, "选定历史.wphistory");
  await ok(source, sourceTask, {
    kind: "export",
    revision_ids: [rows[0].id],
    path: archive,
    password: passphrase,
  });
  const saved = await readFile(archive);
  assert(!saved.includes(Buffer.from(modelCanary)));
  await source.request({
    kind: "delete_provider",
    profile_id: privateSaved.profile.profile.id,
    expected_revision: privateSaved.profile.profile.revision,
  });
  for (const secret of [
    Buffer.from(passphrase),
    bytes,
    Buffer.from(sourceData),
    Buffer.from("key-id"),
  ])
    assert(!saved.includes(secret));
  const repeated = await transfer(source, sourceTask, {
    kind: "export",
    revision_ids: [rows[0].id],
    path: archive,
    password: passphrase,
  });
  assert.equal(repeated.kind, "error");
  assert.deepEqual(await readFile(archive), saved);
  await source.close();
  source = null;
  // Remove the source directory from its original location. A different data root
  // creates a different vault credential; no source vault key or objects are copied.
  await rename(sourceData, sourceData + "-offline");
  target = await launch(targetData);
  const task = await setup(target, destination, "target-history", "request_approval");
  await writeFile(join(destination, name), "existing user file");
  const action = { kind: "inspect", path: archive, password: passphrase };
  const wrong = await transfer(target, task, { ...action, password: "wrong fixture passphrase" });
  assert.equal(wrong.kind, "error");
  assert.equal((await history(target, task)).length, 0);
  const corrupt = join(base, "damaged.wphistory"),
    bad = Buffer.from(saved);
  bad[bad.length - 1] ^= 1;
  await writeFile(corrupt, bad);
  assert.equal((await transfer(target, task, { ...action, path: corrupt })).kind, "error");
  assert.equal((await history(target, task)).length, 0);
  const preview = await ok(target, task, action);
  assert.equal(preview.paths[0].current, "exists");
  assert.equal(preview.revisions, 1);
  const beforeProfiles = await target.request({ kind: "read", query: { kind: "profiles" } });
  const stale = await transfer(target, task, {
    kind: "import",
    path: archive,
    password: passphrase,
    fingerprint: "0".repeat(64),
  });
  assert.equal(stale.kind, "error");
  assert.equal((await history(target, task)).length, 0);
  report.checks.push(
    "encrypted_export_no_overwrite_wrong_password_damaged_and_stale_preview_leave_history_unchanged",
  );
  const imported = await ok(target, task, {
    kind: "import",
    path: archive,
    password: passphrase,
    fingerprint: preview.fingerprint,
  });
  assert.equal(imported.duplicate, false);
  assert.equal(await readFile(join(destination, name), "utf8"), "existing user file");
  const newRows = await history(target, task);
  assert.deepEqual(
    await target.request({ kind: "read", query: { kind: "profiles" } }),
    beforeProfiles,
  );
  assert.equal(newRows.length, 1);
  assert.equal(newRows[0].origin.task_id, sourceTask);
  assert.equal(newRows[0].origin.revision_id, rows[0].id);
  assert.notEqual(newRows[0].root_identity, rows[0].root_identity);
  const again = await ok(target, task, {
    kind: "import",
    path: archive,
    password: passphrase,
    fingerprint: preview.fingerprint,
  });
  assert.equal(again.duplicate, true);
  assert.equal((await history(target, task)).length, 1);
  assert.notEqual(
    await readFile(join(sourceData + "-offline", "test/versions/key-id"), "utf8"),
    await readFile(join(targetData, "test/versions/key-id"), "utf8"),
  );
  report.checks.push(
    "independent_vault_import_preserves_current_file_origins_and_deduplicates_repeated_requests",
  );
  report.checks.push(
    "model_configuration_and_credential_are_excluded_and_target_profiles_are_unchanged",
  );
  const revision = await wb(target, task, { kind: "revision", revision_id: newRows[0].id });
  const restore = await wb(target, task, {
    kind: "edit",
    edit: {
      kind: "restore",
      revision_id: newRows[0].id,
      before: true,
      expected: revision.current_version,
    },
  });
  assert.equal(restore.operation.state, "awaiting_approval");
  assert.equal(await readFile(join(destination, name), "utf8"), "existing user file");
  await wb(target, task, {
    kind: "approve",
    operation_id: restore.operation.id,
    fingerprint: restore.operation.fingerprint,
  });
  await done(target, task, restore.operation);
  assert.deepEqual(await readFile(join(destination, name)), bytes);
  assert.equal((await history(target, task)).length, 2);
  report.checks.push(
    "restoring_imported_binary_requires_existing_approval_and_preserves_replaced_file_as_a_new_revision",
  );
  await target.close();
  target = null;
  target = await launch(targetData);
  assert.equal((await history(target, task)).length, 2);
  assert.equal((await ok(target, task, action)).already_imported, true);
  assert(!JSON.stringify(target.events).includes(passphrase));
  await target.close();
  target = null;
  async function scan(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, item.name);
      if (item.isDirectory()) await scan(p);
      else
        assert(
          !(await readFile(p)).includes(Buffer.from(passphrase)),
          "Passphrase persisted in test data",
        );
    }
  }
  await scan(targetData);
  await scan(sourceData + "-offline");
  report.checks.push(
    "restart_preserves_import_receipt_and_history_no_passphrase_in_database_objects_or_events",
  );
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = String(e.stack || e);
  process.exitCode = 1;
} finally {
  await source?.close();
  await target?.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
