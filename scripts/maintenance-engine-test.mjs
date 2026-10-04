import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { launch, create } from "./tool-test-support.mjs";
import { project, saveFile, history, wb, archive, importArchive } from "./task-history-support.mjs";

const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/maintenance-engine");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "session-"));
const binary = process.env.WORKPILOT_ENGINE_BINARY || resolve("target/debug/workpilot-engine.exe");
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  binarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  checks: [],
};
const pass = (s) => report.checks.push(s);
let engine;
async function command(action) {
  const r = await engine.request({ kind: "maintenance", action });
  assert.equal(r.kind, "workbench", JSON.stringify(r));
  return r.data;
}
const preview = (selection) => command({ action: "preview", selection });
async function apply(data, p, extra = {}) {
  const child = spawn(binary, ["--maintenance", data], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (b) => (stdout += b));
  child.stderr.on("data", (b) => (stderr += b));
  const done = once(child, "exit");
  const timer = setTimeout(() => child.kill(), 120000);
  child.stdin.end(
    JSON.stringify({
      selection: p.selection,
      fingerprint: p.fingerprint,
      confirmation: p.confirmation,
      backup_path: null,
      backup_password: null,
      ...extra,
    }),
  );
  const [code] = await done;
  clearTimeout(timer);
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout);
}
const base = join(directory, "data"),
  data = join(base, "test");
const folder = join(directory, "project");
const password = "fixture backup " + crypto.randomUUID();
try {
  engine = await launch(base);
  const pid = await project(engine, "Maintenance fixture", folder);
  const task = await create(engine, "responses", "maintenance", { project_id: pid });
  await saveFile(engine, task, "preserve.txt", "old 1");
  await saveFile(engine, task, "preserve.txt", "old 2");
  await saveFile(engine, task, "preserve.txt", "current 3");
  const h = await history(engine, task);
  const rule = {
    kind: "versions",
    root_identity: h[0].root_identity,
    keep_last: 1,
    older_than_days: 0,
  };
  const p = await preview(rule);
  assert.equal(p.revision_ids.length, 2);
  assert.equal((await history(engine, task)).length, 3);
  const busy = await apply(data, p, {
    backup_path: join(directory, "no.wphistory"),
    backup_password: password,
  });
  assert.equal(busy.ok, false);
  assert.match(busy.error, /already in use|Busy|busy/);
  pass("preview_is_read_only_and_offline_helper_refuses_active_engine");

  await saveFile(engine, task, "preserve.txt", "current 4");
  await engine.close();
  engine = null;
  const stale = await apply(data, p);
  assert.equal(stale.ok, false);
  assert.match(stale.error, /变化|changed/);
  engine = await launch(base);
  assert.equal((await history(engine, task)).length, 4);
  const fresh = await preview(rule);
  await engine.close();
  engine = null;
  const failed = await apply(data, fresh, {
    backup_path: join(directory, "missing-parent/backup.wphistory"),
    backup_password: password,
  });
  assert.equal(failed.ok, false);
  engine = await launch(base);
  assert.equal((await history(engine, task)).length, 4);
  pass("stale_preview_and_backup_failure_preserve_every_revision");

  const ready = await preview(rule);
  await engine.close();
  engine = null;
  const backup = join(directory, "recoverable-history.wphistory");
  const saved = await apply(data, ready, { backup_path: backup, backup_password: password });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.result.pruned_versions, 3);
  assert.equal(saved.result.cleanup_error, null, JSON.stringify(saved));
  assert.equal(await readFile(join(folder, "preserve.txt"), "utf8"), "current 4");
  const bytes = await readFile(backup);
  assert(!bytes.includes(Buffer.from("old 1")));
  assert(!bytes.includes(Buffer.from(password)));
  engine = await launch(base);
  assert.equal((await history(engine, task)).length, 1);
  const inspected = await engine.request({
    kind: "history_transfer",
    task_id: task,
    action: { kind: "inspect", path: backup, password },
  });
  assert.equal(inspected.kind, "workbench", JSON.stringify(inspected));
  pass("encrypted_verified_backup_precedes_retention_and_current_project_file_is_untouched");

  const archivePath = join(directory, "before-delete.wptask");
  await archive(engine, { kind: "export", task_id: task, path: archivePath, password });
  const archiveId = await importArchive(engine, archivePath, password);
  const archived = await engine.request({
    kind: "workspace",
    action: { kind: "archive_task", task_id: task, archived: true },
  });
  assert.notEqual(archived.kind, "error", JSON.stringify(archived));
  const deleteTask = await preview({ kind: "tasks", root_task_ids: [task] });
  await engine.close();
  engine = null;
  const deleted = await apply(data, deleteTask);
  assert.equal(deleted.ok, true, JSON.stringify(deleted));
  assert.equal(deleted.result.cleanup_error, null, JSON.stringify(deleted));
  engine = await launch(base);
  assert.equal(
    (await engine.request({ kind: "read", query: { kind: "execution", task_id: task } })).kind,
    "error",
  );
  const list = await command({ action: "catalog" });
  assert(list.archives.archives.some((a) => a.archive_id === archiveId));
  const deleteArchive = await preview({ kind: "archives", archive_ids: [archiveId] });
  await engine.close();
  engine = null;
  const removed = await apply(data, deleteArchive);
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal(removed.result.cleanup_error, null, JSON.stringify(removed));
  engine = await launch(base);
  assert.equal((await command({ action: "catalog" })).archives.archives.length, 0);
  assert.equal(await readFile(join(folder, "preserve.txt"), "utf8"), "current 4");
  pass("permanent_task_deletion_keeps_archive_copy_until_explicit_archive_cleanup");

  await writeFile(join(data, "user-kept-file.txt"), "unrelated app-data file");
  const keyBefore = await readFile(join(data, "versions/key-id"), "utf8");
  const wipe = await preview({ kind: "reset" });
  await engine.close();
  engine = null;
  const wrong = await apply(data, wipe, { confirmation: "DELETE" });
  assert.equal(wrong.ok, false);
  const reset = await apply(data, wipe);
  assert.equal(reset.ok, true, JSON.stringify(reset));
  assert(reset.result.credential_references_processed >= 1);
  assert.equal(await readFile(join(data, "user-kept-file.txt"), "utf8"), "unrelated app-data file");
  assert.equal(await readFile(join(folder, "preserve.txt"), "utf8"), "current 4");
  assert(!(await readdir(data)).includes("versions"));
  engine = await launch(base);
  const empty = await command({ action: "catalog" });
  assert.equal(empty.groups.length, 0);
  assert.equal(empty.roots.length, 0);
  const newProject = await project(engine, "After reset", folder);
  const newTask = await create(engine, "responses", "after reset", { project_id: newProject });
  await saveFile(engine, newTask, "new-history.txt", "new protected version");
  assert.notEqual(await readFile(join(data, "versions/key-id"), "utf8"), keyBefore);
  pass(
    "explicit_reset_removes_owned_history_and_vault_key_preserves_projects_and_unknown_files_then_restarts",
  );
  report.passed = true;
} catch (e) {
  report.passed = false;
  report.error = String(e.stack || e);
  throw e;
} finally {
  await engine?.close().catch(() => {});
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ directory, ...report }));
}
