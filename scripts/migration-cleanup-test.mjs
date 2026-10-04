import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { launch } from "./tool-test-support.mjs";
import { project, wb, done } from "./task-history-support.mjs";

const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/migration-cleanup");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "session-"));
const binary = process.env.WORKPILOT_ENGINE_BINARY || resolve("target/debug/workpilot-engine.exe");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  binarySha256: digest(await readFile(binary)),
  checks: [],
};
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );
const targetBase = join(directory, "target"),
  data = join(targetBase, "test");
const password = "Migration cleanup fixture " + crypto.randomUUID();
let source, target;
const migration = async (engine, action) => {
  const r = await engine.request({ kind: "migration", action });
  assert.equal(r.kind, "workbench", JSON.stringify(r));
  return r.data;
};
async function cleanup(selection) {
  const p = await target.request({ kind: "maintenance", action: { action: "preview", selection } });
  assert.equal(p.kind, "workbench", JSON.stringify(p));
  await target.close();
  target = null;
  const child = spawn(binary, ["--maintenance", data], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (bytes) => (stdout += bytes));
  child.stderr.on("data", (bytes) => (stderr += bytes));
  const ended = once(child, "exit");
  const timer = setTimeout(() => child.kill(), 120000);
  child.stdin.end(
    JSON.stringify({
      selection,
      fingerprint: p.data.fingerprint,
      confirmation: p.data.confirmation,
      backup_path: null,
      backup_password: null,
    }),
  );
  const [code] = await ended;
  clearTimeout(timer);
  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.result.cleanup_error, null, JSON.stringify(result));
  target = await launch(targetBase);
}
async function deleteTask(task) {
  const r = await target.request({
    kind: "workspace",
    action: {
      kind: "archive_task",
      task_id: task,
      archived: true,
    },
  });
  assert.equal(r.kind, "workspace", JSON.stringify(r));
  await cleanup({ kind: "tasks", root_task_ids: [task] });
}
async function writePlan(archive, scope, task) {
  const proposed = await migration(target, {
    kind: "prepare_files",
    archive_id: archive,
    source_project_id: scope,
  });
  assert.equal(proposed.operation.state, "awaiting_approval");
  const approved = await wb(target, task, {
    kind: "approve",
    operation_id: proposed.operation.id,
    fingerprint: proposed.operation.fingerprint,
  });
  await done(target, task, approved.operation);
}
try {
  source = await launch(join(directory, "source"));
  target = await launch(targetBase);
  const sourceFolders = [join(directory, "原一"), join(directory, "原二")];
  const targetFolders = [join(directory, "新一"), join(directory, "新二")];
  const first = await project(source, "First source", sourceFolders[0]);
  const second = await project(source, "Second source", sourceFolders[1]);
  const contents = [
    "unique first migration bytes",
    "pending second migration bytes",
    "shared migration bytes",
  ];
  const shas = contents.map((text) => digest(Buffer.from(text)));
  await writeFile(join(sourceFolders[0], "unique.txt"), contents[0]);
  await writeFile(join(sourceFolders[1], "pending.txt"), contents[1]);
  for (const folder of sourceFolders) await writeFile(join(folder, "shared.txt"), contents[2]);
  for (const folder of targetFolders) await mkdir(folder);
  const path = join(directory, "selected-files.wpmigrate");
  await migration(source, {
    kind: "export",
    path,
    password,
    selections: [first, second].map((id, i) => ({
      project_id: id,
      profile_ids: [],
      memory_ids: [],
      task_ids: [],
      extensions: [],
      draft_ids: [],
      files: [i === 0 ? "unique.txt" : "pending.txt", "shared.txt"],
    })),
  });
  await source.close();
  source = null;
  const inspected = await migration(target, { kind: "inspect", path, password });
  const archive = inspected.archive_id;
  const args = {
    path,
    password,
    destinations: [first, second].map((id, i) => ({
      source_project_id: id,
      name: "Imported " + i,
      root_path: targetFolders[i],
    })),
    history_roots: [],
  };
  const preview = await migration(target, { kind: "preview", ...args });
  const receipt = await migration(target, {
    kind: "import",
    ...args,
    fingerprint: preview.fingerprint,
  });
  const a = receipt.files[first],
    b = receipt.files[second];
  await writePlan(archive, first, a.task_id);
  await cleanup({ kind: "unreferenced" });
  for (const sha of [...shas, a.manifest_blob, b.manifest_blob])
    assert(
      await exists(join(data, "versions", sha)),
      "Live migration content was collected: " + sha,
    );
  assert.equal(await exists(join(targetFolders[1], "pending.txt")), false);
  report.checks.push(
    "Completed and pending live file tasks protect manifests and shared encrypted source bytes during garbage collection",
  );

  await deleteTask(a.task_id);
  const after = await migration(target, { kind: "status", archive_id: archive });
  assert.equal(after.files[first].deleted, true);
  assert.equal(after.files[first].task_id, a.task_id);
  assert.equal(after.files[first].operation_id, a.operation_id);
  assert.equal(after.files[first].manifest_blob, undefined);
  assert.deepEqual(after.files[first].files, []);
  assert.equal(await exists(join(data, "versions", a.manifest_blob)), false);
  assert.equal(await exists(join(data, "versions", shas[0])), false);
  for (const sha of [shas[1], shas[2], b.manifest_blob])
    assert(await exists(join(data, "versions", sha)));
  assert.equal(await readFile(join(targetFolders[0], "unique.txt"), "utf8"), contents[0]);
  report.checks.push(
    "Permanent deletion releases the removed file-task manifest and unique bytes while preserving another pending plan and current project files",
  );

  const denied = await target.request({
    kind: "migration",
    action: { kind: "prepare_files", archive_id: archive, source_project_id: first },
  });
  assert.equal(denied.kind, "error", JSON.stringify(denied));
  assert.match(JSON.stringify(denied), /permanently deleted/);
  const againPreview = await migration(target, { kind: "preview", ...args });
  const again = await migration(target, {
    kind: "import",
    ...args,
    fingerprint: againPreview.fingerprint,
  });
  assert.equal(again.files[first].deleted, true);
  assert.equal((await migration(target, { kind: "catalog" })).tasks.length, 1);
  await cleanup({ kind: "unreferenced" });
  assert.equal(
    (await migration(target, { kind: "status", archive_id: archive })).files[first].deleted,
    true,
  );
  assert.equal(await exists(join(data, "versions", a.manifest_blob)), false);
  report.checks.push(
    "Restart, repeated import and file preparation preserve the deletion tombstone without accessing a removed manifest or recreating the task",
  );

  await writePlan(archive, second, b.task_id);
  assert.equal(await readFile(join(targetFolders[1], "pending.txt"), "utf8"), contents[1]);
  assert.equal(await readFile(join(targetFolders[1], "shared.txt"), "utf8"), contents[2]);
  await deleteTask(b.task_id);
  const complete = await migration(target, { kind: "status", archive_id: archive });
  assert.equal(complete.status, "complete");
  for (const sha of [...shas, a.manifest_blob, b.manifest_blob])
    assert.equal(await exists(join(data, "versions", sha)), false);
  assert.equal(await readFile(join(targetFolders[1], "pending.txt"), "utf8"), contents[1]);
  assert.equal((await migration(target, { kind: "catalog" })).tasks.length, 0);
  report.checks.push(
    "The retained pending plan still approves and writes exact bytes; deleting its task later releases all remaining staged contents without deleting project files",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  await source?.close();
  await target?.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
