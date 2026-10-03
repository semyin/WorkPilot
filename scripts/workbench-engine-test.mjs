import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, readdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import {
  launch,
  create,
  until,
  setFixture,
  start,
  terminal as waitRun,
} from "./tool-test-support.mjs";
import { startToolFixture } from "../services/execution-fixtures/tools.mjs";
import { root } from "./cargo.mjs";
const output = join(root, ".test-results/workbench-engine");
await mkdir(output, { recursive: true });
const folder = await mkdtemp(join(output, "中文 项目-"));
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  service: "real local files, Git, Windows processes; no paid model",
  checks: [],
};
let engine;
let unrelated;
const fixture = await startToolFixture();
setFixture(fixture);
const wb = async (task, action, id = crypto.randomUUID()) => {
  const r = await engine.request({ kind: "workbench", task_id: task, action }, id);
  assert.equal(r.kind, "workbench", JSON.stringify(r));
  return r.data;
};
const configure = async (task, permission = "full_access") => {
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
const finish = async (task, id, state = "completed") => {
  const op = await until(async () => {
    const r = await wb(task, { kind: "operations" });
    const op = r.items.find((r) => r.operation.id === id)?.operation;
    return op && ["completed", "failed", "cancelled", "interrupted"].includes(op.state) && op;
  }, 30000);
  assert.equal(op.state, state, JSON.stringify(op));
  return op;
};
const execute = async (task, action, state = "completed") => {
  const result = await wb(task, action);
  const op = result.operation;
  if (op.state === "awaiting_approval")
    await wb(task, { kind: "approve", operation_id: op.id, fingerprint: op.fingerprint });
  return finish(task, op.id, state);
};
const read = async (task, path) => wb(task, { kind: "read_file", path });
const history = async (task, path = null) =>
  (await wb(task, { kind: "history", path, before: null, limit: 100 })).items;
const git = (...args) =>
  execFileSync("git", args, { cwd: folder, encoding: "utf8", windowsHide: true });
const missing = { exists: false, sha256: null, bytes: 0, identity: null };
try {
  engine = await launch();
  const task = await create(engine, "responses", "P07-workspace");
  await configure(task, "request_approval");
  const name = "中文 空格 " + "long-".repeat(24) + ".txt";
  await writeFile(join(folder, name), "before\n第二行\n");
  const acl = (protect = false) =>
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        (protect
          ? "$a=[System.IO.File]::GetAccessControl($env:WORKPILOT_ACL_TEST_FILE); $a.SetAccessRuleProtection($true,$false); $a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.WindowsIdentity]::GetCurrent().User,'FullControl','Allow')); [System.IO.File]::SetAccessControl($env:WORKPILOT_ACL_TEST_FILE,$a); "
          : "") + "[System.IO.File]::GetAccessControl($env:WORKPILOT_ACL_TEST_FILE).Sddl",
      ],
      {
        windowsHide: true,
        encoding: "utf8",
        env: { ...process.env, WORKPILOT_ACL_TEST_FILE: join(folder, name) },
      },
    ).trim();
  const originalAcl = process.platform === "win32" ? acl(true) : null;
  const initial = await read(task, name);
  const pending = await wb(task, {
    kind: "edit",
    edit: { kind: "save", path: name, expected: initial.version, text: "agent update\n" },
  });
  assert.equal(pending.operation.state, "awaiting_approval");
  assert.equal(await readFile(join(folder, name), "utf8"), "before\n第二行\n");
  await writeFile(join(folder, name), "external user edit\n");
  const rejected = await engine.request({
    kind: "workbench",
    task_id: task,
    action: {
      kind: "approve",
      operation_id: pending.operation.id,
      fingerprint: pending.operation.fingerprint,
    },
  });
  assert.equal(rejected.kind, "error");
  assert.equal(await readFile(join(folder, name), "utf8"), "external user edit\n");
  await wb(task, { kind: "stop", operation_id: pending.operation.id });
  report.checks.push(
    "approval_binds_exact_version_chinese_spaces_long_name_external_edit_preserved",
  );
  const current = await read(task, name);
  const saved = await wb(task, {
    kind: "edit",
    edit: { kind: "save", path: name, expected: current.version, text: "saved new content\n" },
  });
  const approvals = await Promise.all(
    [1, 2].map(() =>
      engine.request({
        kind: "workbench",
        task_id: task,
        action: {
          kind: "approve",
          operation_id: saved.operation.id,
          fingerprint: saved.operation.fingerprint,
        },
      }),
    ),
  );
  assert(approvals.some((r) => r.kind === "workbench"));
  await finish(task, saved.operation.id);
  let versions = await history(task, name);
  assert.equal(versions.filter((r) => r.operation_id === saved.operation.id).length, 1);
  const snapshot = await wb(task, { kind: "revision", revision_id: versions[0].id });
  assert.equal(snapshot.before.text, "external user edit\n");
  assert.equal(snapshot.after.text, "saved new content\n");
  await execute(task, {
    kind: "edit",
    edit: {
      kind: "restore",
      revision_id: versions[0].id,
      before: true,
      expected: snapshot.current_version,
    },
  });
  assert.equal(await readFile(join(folder, name), "utf8"), "external user edit\n");
  assert.equal((await history(task, name)).length, 2);
  if (originalAcl)
    assert.equal(acl(), originalAcl, "private access rules must survive save and restore");
  report.checks.push(
    "concurrent_approval_consumed_once_restore_preserves_before_and_current_bytes",
  );
  await configure(task);
  await writeFile(join(folder, "CaseSensitive.txt"), "original");
  const caseFile = await read(task, "CaseSensitive.txt");
  await execute(task, {
    kind: "edit",
    edit: {
      kind: "save",
      path: "CaseSensitive.txt",
      expected: caseFile.version,
      text: "new bytes",
    },
  });
  const staleCase = await engine.request({
    kind: "workbench",
    task_id: task,
    action: {
      kind: "edit",
      edit: {
        kind: "save",
        path: process.platform === "win32" ? "casesensitive.TXT" : "CaseSensitive.txt",
        expected: caseFile.version,
        text: "must not overwrite",
      },
    },
  });
  assert.equal(staleCase.kind, "error");
  assert.equal(await readFile(join(folder, "CaseSensitive.txt"), "utf8"), "new bytes");
  const hugePath = join(folder, "too-large.bin");
  const huge = await open(hugePath, "w");
  await huge.truncate(64 * 1024 * 1024 + 1);
  await huge.close();
  const oversized = await engine.request({
    kind: "workbench",
    task_id: task,
    action: { kind: "read_file", path: "too-large.bin" },
  });
  assert.equal(oversized.kind, "error");
  await unlink(hugePath);
  report.checks.push("private_windows_acl_preserved_case_alias_conflict_and_64MiB_limit_rejected");
  const sensitive = "api_key=synthetic-history-sensitive\n";
  await execute(task, {
    kind: "edit",
    edit: { kind: "save", path: "secret-config.txt", expected: missing, text: sensitive },
  });
  const sensitiveRevision = (await history(task, "secret-config.txt"))[0];
  assert.equal(
    (await wb(task, { kind: "revision", revision_id: sensitiveRevision.id })).after.text,
    sensitive,
  );
  const vault = join(engine.directory, "test", "versions");
  for (const entry of await readdir(vault)) {
    const bytes = await readFile(join(vault, entry));
    assert(!bytes.includes(Buffer.from("synthetic-history-sensitive")));
  }
  assert(
    !(await readFile(join(engine.directory, "test", "workpilot.sqlite3"))).includes(
      Buffer.from("synthetic-history-sensitive"),
    ),
  );
  report.checks.push("exact_sensitive_file_bytes_are_encrypted_outside_trace_objects");
  const binary = Buffer.alloc(3 * 1024 * 1024, 0xda);
  binary[0] = 0;
  binary[100] = 255;
  await writeFile(join(folder, "二进制.bin"), binary);
  let b = await read(task, "二进制.bin");
  assert.equal(b.editable, false);
  await execute(task, {
    kind: "edit",
    edit: { kind: "delete", path: "二进制.bin", expected: b.version },
  });
  assert.equal((await read(task, "二进制.bin")).version.exists, false);
  const deleted = (await history(task, "二进制.bin"))[0];
  await execute(task, {
    kind: "edit",
    edit: { kind: "restore", revision_id: deleted.id, before: true, expected: missing },
  });
  assert.deepEqual(await readFile(join(folder, "二进制.bin")), binary);
  const original = await read(task, name);
  await execute(task, {
    kind: "edit",
    edit: { kind: "rename", path: name, destination: "renamed.txt", expected: original.version },
  });
  const renamed = (await history(task, "renamed.txt"))[0];
  assert.equal(renamed.change, "renamed");
  assert.equal(renamed.previous_path, name);
  report.checks.push("binary_three_megabyte_delete_restore_and_rename_history");
  const command =
    "const fs=require('fs');fs.writeFileSync('script-new.txt','new');fs.renameSync('renamed.txt','script-renamed.txt');fs.unlinkSync('secret-config.txt');console.log('script complete')";
  const terminal = await execute(task, {
    kind: "terminal",
    program: process.execPath,
    args: ["-e", command],
    timeout_ms: 20000,
    preview_port: null,
  });
  const changes = (await history(task)).filter((r) => r.operation_id === terminal.id);
  assert(changes.some((r) => r.path === "script-new.txt" && r.change === "created"));
  assert(changes.some((r) => r.path === "secret-config.txt" && r.change === "deleted"));
  assert(changes.some((r) => r.path === "script-renamed.txt" && r.change === "renamed"));
  report.checks.push("actual_script_creates_renames_deletes_with_restorable_before_images");
  fixture.recipes.set("p07-model-history", [
    {
      name: "write_file",
      args: { path: "model-managed.txt", text: "model original", expected_sha256: null },
    },
    {
      name: "run_command",
      args: {
        program: process.execPath,
        args: ["-e", "require('fs').writeFileSync('model-managed.txt','model command edit')"],
        timeout_ms: 20000,
      },
    },
  ]);
  const modelTask = await create(engine, "responses", "p07-model-history", {
    controlled_tools: false,
  });
  await configure(modelTask);
  await start(engine, modelTask);
  assert.equal((await waitRun(engine, modelTask)).task.state, "completed");
  const modelVersions = await history(modelTask, "model-managed.txt");
  assert.equal(modelVersions.length, 2);
  const commandVersion = modelVersions.find((r) => r.source === "run_command");
  assert(commandVersion, JSON.stringify(modelVersions));
  assert(modelVersions.some((r) => r.source === "write_file"));
  const modelImage = await wb(modelTask, { kind: "revision", revision_id: commandVersion.id });
  assert.equal(modelImage.before.text, "model original");
  assert.equal(modelImage.after.text, "model command edit");
  report.checks.push("model_write_file_and_run_command_share_browsable_exact_file_history");
  git("init", "-q");
  git("config", "user.name", "WorkPilot Test");
  git("config", "user.email", "workpilot-test@example.invalid");
  await writeFile(join(folder, ".gitignore"), "*.bin\n");
  await writeFile(join(folder, "chosen.txt"), "base\n");
  await writeFile(join(folder, "staged-user.txt"), "base\n");
  await writeFile(join(folder, "unstaged-user.txt"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  await writeFile(join(folder, "chosen.txt"), "chosen change\n");
  await writeFile(join(folder, "staged-user.txt"), "staged user change\n");
  git("add", "staged-user.txt");
  await writeFile(join(folder, "unstaged-user.txt"), "unstaged user change\n");
  await writeFile(join(folder, "new-[selected].txt"), "new selected\n");
  await writeFile(join(folder, "new-s.txt"), "unselected wildcard match\n");
  const gs = await wb(task, { kind: "git_status" });
  await execute(task, {
    kind: "git_commit",
    paths: ["chosen.txt", "new-[selected].txt"],
    message: "P07 selected changes",
    expected_status: gs.status.fingerprint,
  });
  assert.deepEqual(
    git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").trim().split(/\r?\n/).sort(),
    ["chosen.txt", "new-[selected].txt"],
  );
  assert.equal(git("diff", "--cached", "--name-only").trim(), "staged-user.txt");
  assert.equal(git("diff", "--name-only").trim(), "unstaged-user.txt");
  assert.equal(git("status", "--porcelain", "--", "new-s.txt").trim(), "?? new-s.txt");
  assert.equal(await readFile(join(folder, "staged-user.txt"), "utf8"), "staged user change\n");
  report.checks.push("git_selected_commit_preserves_other_staged_and_unstaged_changes");
  const service = createServer().listen(0, "127.0.0.1");
  await once(service, "listening");
  const port = service.address().port;
  await new Promise((r) => service.close(r));
  unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const running = await wb(task, {
    kind: "terminal",
    program: process.execPath,
    args: [
      "-e",
      "require('http').createServer((q,s)=>s.end('P07 preview')).listen(" +
        port +
        ",'127.0.0.1');console.log('ready');setInterval(()=>{},1000)",
    ],
    timeout_ms: 30000,
    preview_port: port,
  });
  await until(async () => {
    try {
      return (await fetch("http://127.0.0.1:" + port)).ok;
    } catch {
      return false;
    }
  });
  const url = await until(async () => {
    try {
      return await wb(task, { kind: "preview", operation_id: running.operation.id });
    } catch {
      return false;
    }
  });
  assert.equal(url.url, "http://127.0.0.1:" + port + "/");
  const started = performance.now();
  await wb(task, { kind: "stop", operation_id: running.operation.id });
  await finish(task, running.operation.id, "cancelled");
  report.stopMs = Math.round(performance.now() - started);
  assert(report.stopMs < 5000);
  assert.equal(unrelated.exitCode, null);
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  const denied = await engine.request({
    kind: "workbench",
    task_id: task,
    action: { kind: "preview", operation_id: running.operation.id },
  });
  assert.equal(denied.kind, "error");
  report.checks.push("owned_live_preview_port_stops_without_killing_unrelated_process");
  const beforeCrash = await wb(task, {
    kind: "terminal",
    program: process.execPath,
    args: [
      "-e",
      "require('fs').writeFileSync('crash-edit.txt','written once');setInterval(()=>{},1000)",
    ],
    timeout_ms: 30000,
    preview_port: null,
  });
  await until(async () => {
    try {
      return (await readFile(join(folder, "crash-edit.txt"), "utf8")) === "written once";
    } catch {
      return false;
    }
  });
  const directory = engine.directory;
  const exited = once(engine.child, "exit");
  engine.child.kill();
  await exited;
  engine = null;
  engine = await launch(directory);
  const recovered = (await wb(task, { kind: "operations" })).items.find(
    (r) => r.operation.id === beforeCrash.operation.id,
  ).operation;
  assert.equal(recovered.state, "interrupted");
  assert((await history(task, "crash-edit.txt")).some((r) => r.source.startsWith("recovered:")));
  assert.equal(await readFile(join(folder, "crash-edit.txt"), "utf8"), "written once");
  report.checks.push("engine_crash_recovers_observed_file_history_without_replaying_command");
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = String(e);
  throw e;
} finally {
  if (engine) await engine.close();
  await fixture.close();
  if (unrelated) {
    const exited = once(unrelated, "exit");
    unrelated.kill();
    await exited;
  }
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
