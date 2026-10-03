import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rename } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { root } from "./cargo.mjs";
import {
  launch,
  create,
  start,
  terminal,
  until,
  setFixture,
  processes,
} from "./tool-test-support.mjs";
import { startToolFixture } from "../services/execution-fixtures/tools.mjs";

const output = resolve(
  process.env.WORKPILOT_TEST_OUTPUT || join(root, ".test-results/installation-engine"),
);
await mkdir(output, { recursive: true });
const binary =
  process.env.WORKPILOT_ENGINE_BINARY ||
  join(root, "artifacts/workpilot-p12-browser-setup-2026-10-04/preview/workpilot-sidecar.exe");
const bundle = dirname(binary),
  fixture = await startToolFixture();
setFixture(fixture);
const originalPath = process.env.PATH;
process.env.PATH = join(process.env.SystemRoot, "System32");
process.env.WORKPILOT_ENGINE_BINARY = binary;
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  binarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  environment:
    "Windows developer machine; engine PATH restricted to System32. This is not a clean-OS test.",
  checks: [],
};
let engine;
const digest = (b) => createHash("sha256").update(b).digest("hex");
const acl = (p) =>
  execFileSync(
    join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "if([IO.Directory]::Exists($env:WORKPILOT_TEST_ACL_PATH)){[IO.Directory]::GetAccessControl($env:WORKPILOT_TEST_ACL_PATH).Sddl}else{[IO.File]::GetAccessControl($env:WORKPILOT_TEST_ACL_PATH).Sddl}",
    ],
    { windowsHide: true, encoding: "utf8", env: { ...process.env, WORKPILOT_TEST_ACL_PATH: p } },
  ).trim();
async function wb(task, action) {
  const r = await engine.request({ kind: "workbench", task_id: task, action });
  assert.equal(r.kind, "workbench", JSON.stringify(r));
  return r.data;
}
async function configure(task, folder, permission) {
  const r = await engine.request({
    kind: "configure_task_tools",
    task_id: task,
    settings: {
      root_path: folder,
      permission,
      commands_enabled: true,
      review_profile_id: null,
      revision: 0,
    },
  });
  assert.equal(r.kind, "receipt", JSON.stringify(r));
}
async function exercise(permission) {
  const name = "bundled-" + permission,
    folder = await mkdtemp(join(output, "中文 脚本-"));
  const actions = [
    {
      name: "run_command",
      args: {
        program: "python",
        args: [
          "-c",
          "import json,sqlite3,hashlib,pathlib; p=pathlib.Path('python-result.json'); p.write_text(json.dumps({'sqlite':sqlite3.sqlite_version,'hash':hashlib.sha256(b'ok').hexdigest()})); pathlib.Path('中文.txt').write_text('中文内容',encoding='utf-8'); print('中文输出 python-ok')",
        ],
        timeout_ms: 15000,
      },
    },
    {
      name: "run_command",
      args: {
        program: "node",
        args: [
          "-e",
          "require('fs').writeFileSync('node-result.txt',process.version);console.log('node-ok')",
        ],
        timeout_ms: 15000,
      },
    },
    { name: "run_command", args: { program: "git", args: ["init"], timeout_ms: 15000 } },
    {
      name: "run_command",
      args: {
        program: "git",
        args: ["add", "python-result.json", "node-result.txt"],
        timeout_ms: 15000,
      },
    },
    {
      name: "run_command",
      args: {
        program: "git",
        args: [
          "-c",
          "user.name=WorkPilot Test",
          "-c",
          "user.email=fixture@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          "bundled-runtime-fixture",
        ],
        timeout_ms: 15000,
      },
    },
  ];
  fixture.recipes.set(name, permission === "full_access" ? actions : actions.slice(0, 3));
  const task = await create(engine, "responses", name, {
    controlled_tools: false,
    limits: {
      max_steps: 32,
      max_duration_ms: 180000,
      context_bytes: 65536,
      max_result_bytes: 32768,
    },
  });
  await configure(task, folder, permission);
  await start(engine, task);
  for (let n = 0; n < 8; n++) {
    const s = await terminal(engine, task);
    if (s.task.state === "awaiting_approval") {
      const state = await engine.request({
        kind: "read",
        query: { kind: "task_tools", task_id: task },
      });
      const a =
        state.state.approvals.find((a) => a.state === "pending") || state.state.approvals.at(-1);
      const r = await engine.request({
        kind: "decide_tool_approval",
        task_id: task,
        approval_id: a.id,
        fingerprint: a.fingerprint,
        approve: true,
      });
      assert.equal(r.kind, "receipt", JSON.stringify(r));
      await start(engine, task);
      continue;
    }
    assert.equal(s.task.state, "completed", JSON.stringify(s.latest_run));
    const steps = s.steps.filter((s) => s.name === "run_command");
    assert.equal(
      steps.filter((s) => s.state === "completed").length,
      permission === "full_access" ? 5 : 2,
    );
    if (permission !== "full_access") {
      const failed = steps.at(-1);
      assert.equal(failed.state, "failed");
      const saved = JSON.parse(
        (
          await engine.request({
            kind: "read",
            query: { kind: "content", object_id: failed.output.object_id, offset: 0, limit: 32768 },
          })
        ).page.text,
      );
      const detail = JSON.parse(saved.output);
      assert.equal(saved.is_error, true);
      assert.equal(detail.containment, "windows_appcontainer_no_network");
      assert.match(
        detail.stderr_preview,
        /unable to get current working directory: Permission denied/,
      );
      report.knownFailures = [
        {
          id: "T-P12-04",
          component: "Git in AppContainer",
          observed: detail.stderr_preview.trim(),
          scope:
            "Generic git init cannot resolve directory ancestors under restricted permissions; no broader permission fallback. Full-access commands and existing approved workbench Git operations work.",
        },
      ];
    }
    break;
  }
  assert.match(await readFile(join(folder, "node-result.txt"), "utf8"), /^v22\.23\.2$/);
  assert.equal(await readFile(join(folder, "中文.txt"), "utf8"), "中文内容");
  assert.equal(
    JSON.parse(await readFile(join(folder, "python-result.json"), "utf8")).hash,
    digest(Buffer.from("ok")),
  );
  if (permission === "full_access") {
    const status = await wb(task, { kind: "git_status" });
    assert(status, JSON.stringify(status));
    const history = execFileSync(
      join(bundle, "git-runtime/cmd/git.exe"),
      ["log", "--format=%s", "-1"],
      { cwd: folder, windowsHide: true, encoding: "utf8" },
    );
    assert.equal(history.trim(), "bundled-runtime-fixture");
    // Existing Git workbench operations retain their explicit approval route.
    const git = (...args) =>
      execFileSync(join(bundle, "git-runtime/cmd/git.exe"), args, {
        cwd: folder,
        windowsHide: true,
        encoding: "utf8",
      });
    git("config", "user.name", "WorkPilot Test");
    git("config", "user.email", "fixture@example.invalid");
    const policy = (
      await engine.request({ kind: "read", query: { kind: "task_tools", task_id: task } })
    ).state.policy.settings;
    assert.equal(
      (
        await engine.request({
          kind: "configure_task_tools",
          task_id: task,
          settings: { ...policy, permission: "request_approval" },
        })
      ).kind,
      "receipt",
    );
    await writeFile(join(folder, "approved.txt"), "approved workbench commit");
    const gs = await wb(task, { kind: "git_status" });
    const created = await wb(task, {
      kind: "git_commit",
      paths: ["approved.txt"],
      message: "approved-workbench",
      expected_status: gs.status.fingerprint,
    });
    assert.equal(created.operation.state, "awaiting_approval");
    await wb(task, {
      kind: "approve",
      operation_id: created.operation.id,
      fingerprint: created.operation.fingerprint,
    });
    const finished = await until(async () => {
      const op = (await wb(task, { kind: "operation", operation_id: created.operation.id }))
        .operation;
      return ["completed", "failed"].includes(op.state) && op;
    });
    assert.equal(finished.state, "completed", JSON.stringify(finished));
    assert.equal(git("log", "--format=%s", "-1").trim(), "approved-workbench");
    report.checks.push(
      "request_approval_workbench_git_commit_uses_bundled_git_and_explicit_approval",
    );
  }
  report.checks.push(
    permission +
      (permission === "full_access"
        ? "_bundled_python_unicode_node_git_commit_without_developer_PATH"
        : "_bundled_python_unicode_node_work_and_git_compatibility_failure_is_recorded"),
  );
  return task;
}
try {
  const before = Object.fromEntries(
    [
      "browser-runtime/node.exe",
      "python-runtime",
      "python-runtime/python.exe",
      "git-runtime",
      "git-runtime/cmd/git.exe",
    ].map((p) => [p, acl(join(bundle, p))]),
  );
  engine = await launch(await mkdtemp(join(output, "data-")));
  const started = Date.now(),
    checking = engine.request({ kind: "inspect_installation", verify_hashes: true });
  assert.equal(
    (await engine.request({ kind: "read", query: { kind: "tasks", before: null, limit: 10 } }))
      .kind,
    "tasks",
  );
  const inspected = await checking;
  assert.equal(inspected.kind, "installation", JSON.stringify(inspected));
  assert.equal(inspected.report.manifest_present, true);
  assert.equal(inspected.report.components.length, 7);
  assert(
    inspected.report.components.every((c) => c.state === "verified" && c.files === c.checked_files),
    JSON.stringify(inspected.report),
  );
  assert(!JSON.stringify(inspected).includes(process.env.USERPROFILE));
  report.verificationMs = Date.now() - started;
  report.components = inspected.report.components.map((c) => ({
    id: c.id,
    files: c.files,
    bytes: c.bytes,
  }));
  report.checks.push("full_installed_inventory_verified_and_engine_responsive");
  await exercise("full_access");
  await exercise("request_approval");
  await engine.close();
  engine = null;
  for (const [p, expected] of Object.entries(before))
    assert.equal(acl(join(bundle, p)), expected, "Runtime ACL was not restored: " + p);
  report.checks.push("sandbox_uses_only_owned_runtime_roots_and_restores_their_permissions");

  const damaged = await mkdtemp(join(output, "损坏 安装-"));
  await copyFile(binary, join(damaged, "workpilot-sidecar.exe"));
  await copyFile(
    join(bundle, "workpilot-runtime-check.exe"),
    join(damaged, "workpilot-runtime-check.exe"),
  );
  process.env.WORKPILOT_ENGINE_BINARY = join(damaged, "workpilot-sidecar.exe");
  await writeFile(join(damaged, "worker.bin"), "valid");
  const catalog = {
    schema_version: 1,
    target: "windows-x86_64",
    components: [
      {
        id: "fixture",
        version: "1",
        source: "fixture",
        license: "fixture",
        files: [{ path: "worker.bin", bytes: 5, sha256: digest(Buffer.from("valid")) }],
      },
    ],
  };
  const manifest = join(damaged, "runtime-catalog.json");
  await writeFile(manifest, JSON.stringify(catalog));
  engine = await launch(await mkdtemp(join(output, "damage-data-")));
  const check = () => engine.request({ kind: "inspect_installation", verify_hashes: true });
  assert.equal((await check()).report.components[0].state, "verified");
  await writeFile(join(damaged, "worker.bin"), "wrong");
  assert.equal((await check()).report.components[0].state, "incomplete");
  await rename(join(damaged, "worker.bin"), join(damaged, "worker-saved.bin"));
  assert.match((await check()).report.components[0].issues[0], /missing/);
  const task = await create(engine, "responses", "missing-tool");
  await configure(task, damaged, "full_access");
  const r = await engine.request({
    kind: "workbench",
    task_id: task,
    action: {
      kind: "terminal",
      program: "python",
      args: ["--version"],
      timeout_ms: 10000,
      preview_port: null,
    },
  });
  assert.equal(r.kind, "error", JSON.stringify(r));
  assert.match(r.message, /missing|缺失/);
  catalog.components[0].files[0].path = "../outside.txt";
  await writeFile(manifest, JSON.stringify(catalog));
  assert.equal((await check()).kind, "error");
  const checker = join(damaged, "workpilot-runtime-check.exe");
  await rename(checker, checker + ".saved");
  const missingChecker = await check();
  assert.equal(missingChecker.kind, "error");
  assert.match(missingChecker.message, /Runtime checker is missing/);
  await rename(checker + ".saved", checker);
  await rename(manifest, join(damaged, "saved-catalog.json"));
  assert.equal((await check()).report.manifest_present, false);
  report.checks.push(
    "damaged_missing_traversal_and_missing_checker_rejected_no_global_python_fallback",
  );
  await engine.close();
  engine = null;
  report.status = report.knownFailures?.length ? "passed_with_known_failure" : "passed";
} catch (e) {
  report.status = "failed";
  report.error = String(e.stack || e);
  process.exitCode = 1;
} finally {
  await engine?.close().catch(() => {});
  for (const p of processes) if (p.exitCode === null) p.kill();
  process.env.PATH = originalPath;
  await fixture.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
