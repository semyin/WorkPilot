import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  rename,
  symlink,
  link,
  stat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { launch, create, until, profile } from "./tool-test-support.mjs";

const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/file-transfer");
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, "session-"));
const binary = process.env.WORKPILOT_ENGINE_BINARY || resolve("target/debug/workpilot-engine.exe");
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  binarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  checks: [],
};
const password = "file backup fixture " + crypto.randomUUID();
let source, target;
let credentialProfile;
const sourceData = join(root, "source-data"),
  targetData = join(root, "target-data");
const sourceFolder = join(root, "源 项目"),
  targetFolder = join(root, "目标 项目");
const request = (engine, task, action) =>
  engine.request({ kind: "file_transfer", task_id: task, action });
const ok = async (engine, task, action) => {
  const r = await request(engine, task, action);
  assert.equal(r.kind, "workbench", JSON.stringify(r));
  return r.data;
};
const wb = async (engine, task, action) => {
  const r = await engine.request({ kind: "workbench", task_id: task, action });
  assert.equal(r.kind, "workbench", JSON.stringify(r));
  return r.data;
};
const configure = async (engine, task, folder, permission = "request_approval") => {
  const old = await engine.request({ kind: "read", query: { kind: "task_tools", task_id: task } });
  const r = await engine.request({
    kind: "configure_task_tools",
    task_id: task,
    settings: {
      ...old.state.policy.settings,
      root_path: folder,
      permission,
      commands_enabled: true,
    },
  });
  assert.notEqual(r.kind, "error", JSON.stringify(r));
};
const finish = async (engine, task, id, expected = "completed") => {
  const op = await until(async () => {
    const { items } = await wb(engine, task, { kind: "operations" });
    const op = items.find((r) => r.operation.id === id)?.operation;
    return op && ["completed", "failed", "cancelled", "interrupted"].includes(op.state) && op;
  }, 60000);
  assert.equal(op.state, expected, JSON.stringify(op));
  return op;
};
const approve = (engine, task, op) =>
  wb(engine, task, { kind: "approve", operation_id: op.id, fingerprint: op.fingerprint });
const history = async (engine, task) =>
  (await wb(engine, task, { kind: "history", path: null, before: null, limit: 100 })).items;
const exists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};
try {
  await mkdir(join(sourceFolder, "资料 空格"), { recursive: true });
  await mkdir(targetFolder);
  const fixtures = new Map([
    ["hello.txt", Buffer.from("hello original\n第二行\n")],
    ["资料 空格/图片.bin", Buffer.from([0, 255, 254, 7, 0, 77])],
    ["资料 空格/empty.txt", Buffer.alloc(0)],
  ]);
  for (const [path, bytes] of fixtures) await writeFile(join(sourceFolder, path), bytes);
  await writeFile(join(targetFolder, "keep.txt"), "preserve me");
  source = await launch(sourceData);
  const from = await create(source, "responses", "files-source");
  await configure(source, from, sourceFolder);
  const archive = join(root, "项目 备份.wpfiles");
  const exporting = { kind: "export", paths: [...fixtures.keys()], path: archive, password };
  assert.equal((await ok(source, from, exporting)).files, 3);
  assert.equal((await request(source, from, exporting)).kind, "error");
  const bytes = await readFile(archive);
  assert.equal(bytes.subarray(0, 8).toString(), "WPFILE01");
  for (const raw of [password, "hello original", "资料 空格"])
    assert(!bytes.includes(Buffer.from(raw)));
  credentialProfile = profile("responses", "file-credential-canary");
  credentialProfile.auth = "bearer";
  const canary = "FILE-CREDENTIAL-FIXTURE-" + crypto.randomUUID();
  const saved = await source.request({
    kind: "save_provider",
    profile: credentialProfile,
    secret: canary,
    clear_credential: false,
  });
  assert.equal(saved.kind, "provider_saved");
  await writeFile(
    join(sourceFolder, "binary-with-credential.bin"),
    Buffer.concat([Buffer.from([255, 0]), Buffer.from(canary)]),
  );
  assert.equal(
    (
      await request(source, from, {
        ...exporting,
        paths: ["binary-with-credential.bin"],
        path: join(root, "rejected-secret.wpfiles"),
      })
    ).kind,
    "error",
  );
  assert.equal(await exists(join(root, "rejected-secret.wpfiles")), false);
  const removed = await source.request({
    kind: "delete_provider",
    profile_id: credentialProfile.id,
    expected_revision: credentialProfile.revision,
  });
  assert.notEqual(removed.kind, "error", JSON.stringify(removed));
  credentialProfile = null;
  report.checks.push(
    "registered_model_credential_in_binary_bytes_blocks_export_without_producing_an_archive",
  );
  for (const paths of [
    ["../keep.txt"],
    ["hello.txt", "hello.txt"],
    ["HELLO.txt", "hello.txt"],
    [".env"],
    ["missing.txt"],
  ]) {
    assert.equal(
      (
        await request(source, from, {
          ...exporting,
          paths,
          path: join(root, crypto.randomUUID() + ".wpfiles"),
        })
      ).kind,
      "error",
    );
  }
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "external.txt"), "outside");
  await symlink(outside, join(sourceFolder, "linked-folder"), "junction");
  await link(join(sourceFolder, "hello.txt"), join(sourceFolder, "hardlink.txt"));
  for (const paths of [["linked-folder/external.txt"], ["hardlink.txt"]])
    assert.equal(
      (
        await request(source, from, {
          ...exporting,
          paths,
          path: join(root, crypto.randomUUID() + ".wpfiles"),
        })
      ).kind,
      "error",
    );
  await source.close();
  source = null;
  await rename(sourceFolder, sourceFolder + "-offline");
  report.checks.push(
    "encrypted_exact_binary_export_no_overwrite_duplicate_missing_credential_path_traversal_junction_hardlink_rejected",
  );

  target = await launch(targetData);
  const task = await create(target, "responses", "files-target");
  await configure(target, task, targetFolder);
  const inspect = { kind: "inspect", path: archive, password, prefix: "迁入/新目录" };
  assert.equal(
    (await request(target, task, { ...inspect, password: "incorrect fixture passphrase" })).kind,
    "error",
  );
  const damaged = join(root, "damaged.wpfiles"),
    bad = Buffer.from(bytes);
  bad[bad.length - 1] ^= 1;
  await writeFile(damaged, bad);
  assert.equal((await request(target, task, { ...inspect, path: damaged })).kind, "error");
  assert.equal((await request(target, task, { ...inspect, prefix: "../escape" })).kind, "error");
  const preview = await ok(target, task, inspect);
  assert.equal(preview.files.length, 3);
  assert.equal(preview.conflicts.length, 0);
  assert.equal(await exists(join(targetFolder, inspect.prefix)), false);
  const importing = { ...inspect, kind: "import", fingerprint: preview.fingerprint };
  const pending = await ok(target, task, importing);
  assert.equal(pending.operation.state, "awaiting_approval");
  assert.equal(await exists(join(targetFolder, inspect.prefix)), false);
  assert.equal((await ok(target, task, importing)).operation.id, pending.operation.id);
  await approve(target, task, pending.operation);
  await finish(target, task, pending.operation.id);
  for (const [path, content] of fixtures)
    assert.deepEqual(await readFile(join(targetFolder, inspect.prefix, path)), content);
  const versions = await history(target, task);
  assert.equal(versions.length, 3);
  assert(
    versions.every(
      (v) =>
        v.operation_id === pending.operation.id &&
        v.source === "files_import" &&
        v.change === "created",
    ),
  );
  assert.equal(await readFile(join(targetFolder, "keep.txt"), "utf8"), "preserve me");
  report.checks.push(
    "separate_data_and_offline_source_nested_unicode_binary_empty_file_roundtrip_approval_waits_and_creates_linked_file_history",
  );

  await writeFile(join(targetFolder, inspect.prefix, "hello.txt"), "later user change");
  await target.close();
  target = await launch(targetData);
  assert.equal((await ok(target, task, importing)).operation.id, pending.operation.id);
  assert.equal(
    await readFile(join(targetFolder, inspect.prefix, "hello.txt"), "utf8"),
    "later user change",
  );
  assert.equal((await history(target, task)).length, 3);
  const duplicate = await ok(target, task, inspect);
  assert.equal(duplicate.previous_operation.id, pending.operation.id);
  const other = await create(target, "responses", "files-other");
  await configure(target, other, targetFolder);
  const conflicts = await ok(target, other, inspect);
  assert.equal(conflicts.can_import, false);
  assert.equal(conflicts.conflicts.length, 3);
  assert.equal(
    (await request(target, other, { ...importing, fingerprint: conflicts.fingerprint })).kind,
    "error",
  );
  report.checks.push(
    "restart_and_repeated_import_reuses_operation_without_replacing_later_edits_and_existing_targets_block_entire_new_import",
  );

  const staleInspect = { ...inspect, prefix: "stale" };
  let p = await ok(target, task, staleInspect);
  await mkdir(join(targetFolder, "stale"));
  await writeFile(join(targetFolder, "stale", "hello.txt"), "occupied");
  assert.equal(
    (await request(target, task, { ...staleInspect, kind: "import", fingerprint: p.fingerprint }))
      .kind,
    "error",
  );
  assert.equal(await exists(join(targetFolder, "stale", "资料 空格")), false);
  const staleApproval = { ...inspect, prefix: "stale-approval" };
  p = await ok(target, task, staleApproval);
  const op = (
    await ok(target, task, { ...staleApproval, kind: "import", fingerprint: p.fingerprint })
  ).operation;
  await mkdir(join(targetFolder, "stale-approval"));
  await writeFile(join(targetFolder, "stale-approval", "hello.txt"), "keep occupied");
  const rejected = await target.request({
    kind: "workbench",
    task_id: task,
    action: { kind: "approve", operation_id: op.id, fingerprint: op.fingerprint },
  });
  assert.equal(rejected.kind, "error");
  await finish(target, task, op.id, "failed");
  assert.equal(await exists(join(targetFolder, "stale-approval", "资料 空格")), false);
  assert.equal(
    await readFile(join(targetFolder, "stale-approval", "hello.txt"), "utf8"),
    "keep occupied",
  );
  report.checks.push(
    "changed_preview_and_late_approval_conflict_write_nothing_preserve_existing_bytes_and_mark_failed",
  );

  const stoppedInspect = { ...inspect, prefix: "stopped" };
  p = await ok(target, task, stoppedInspect);
  const stopped = (
    await ok(target, task, { ...stoppedInspect, kind: "import", fingerprint: p.fingerprint })
  ).operation;
  await wb(target, task, { kind: "stop", operation_id: stopped.id });
  await finish(target, task, stopped.id, "cancelled");
  assert.equal(await exists(join(targetFolder, "stopped")), false);
  const unapprovedInspect = { ...inspect, prefix: "restart-waits" };
  p = await ok(target, task, unapprovedInspect);
  const waiting = (
    await ok(target, task, { ...unapprovedInspect, kind: "import", fingerprint: p.fingerprint })
  ).operation;
  await target.close();
  target = await launch(targetData);
  assert.equal(await exists(join(targetFolder, "restart-waits")), false);
  const afterRestart = (await wb(target, task, { kind: "operations" })).items.find(
    (r) => r.operation.id === waiting.id,
  ).operation;
  assert(["awaiting_approval", "interrupted"].includes(afterRestart.state));
  report.checks.push("stop_pending_and_restart_never_write_or_automatically_replay_files");

  await configure(target, task, targetFolder, "auto_review");
  const autoInspect = { ...inspect, prefix: "auto-review" };
  p = await ok(target, task, autoInspect);
  const auto = (
    await ok(target, task, { ...autoInspect, kind: "import", fingerprint: p.fingerprint })
  ).operation;
  assert.equal(auto.state, "awaiting_approval");
  await approve(target, task, auto);
  await finish(target, task, auto.id);
  await configure(target, task, targetFolder, "full_access");
  const fullInspect = { ...inspect, prefix: "full" };
  p = await ok(target, task, fullInspect);
  const full = (
    await ok(target, task, { ...fullInspect, kind: "import", fingerprint: p.fingerprint })
  ).operation;
  assert.equal(full.state, "queued");
  await finish(target, task, full.id);
  report.checks.push("manual_file_import_obeys_request_approval_auto_review_and_full_access_modes");

  const chat = await create(target, "responses", "files-chat", { mode: "chat" });
  await configure(target, chat, targetFolder);
  const chatInspect = { ...inspect, prefix: "chat" };
  p = await ok(target, chat, chatInspect);
  assert.equal(
    (await request(target, chat, { ...chatInspect, kind: "import", fingerprint: p.fingerprint }))
      .kind,
    "error",
  );
  assert.equal(await exists(join(targetFolder, "chat")), false);
  await symlink(outside, join(targetFolder, "linked-target"), "junction");
  const linked = await ok(target, task, { ...inspect, prefix: "linked-target" });
  assert.equal(linked.can_import, false);
  assert.equal(await exists(join(outside, "hello.txt")), false);
  report.checks.push("chat_mode_cannot_write_and_linked_destination_cannot_escape_project");

  await target.close();
  target = null;
  async function scan(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await scan(p);
      else
        assert(!(await readFile(p)).includes(Buffer.from(password)), "Backup passphrase persisted");
    }
  }
  await scan(sourceData);
  await scan(targetData);
  report.checks.push("archive_passphrase_absent_from_normal_databases_content_records_and_logs");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  if (source && credentialProfile)
    await source
      .request({
        kind: "delete_provider",
        profile_id: credentialProfile.id,
        expected_revision: credentialProfile.revision,
      })
      .catch(() => {});
  await source?.close();
  await target?.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
