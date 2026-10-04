import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile, access, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { root } from "./cargo.mjs";
import { launch, create, start, terminal, setFixture } from "./tool-test-support.mjs";
import { startToolFixture } from "../services/execution-fixtures/tools.mjs";

const output = resolve(
  process.env.WORKPILOT_TEST_OUTPUT || join(root, ".test-results/git-sandbox"),
);
await mkdir(output, { recursive: true });
const binary = resolve(
  process.env.WORKPILOT_ENGINE_BINARY ||
    join(root, "artifacts/workpilot-p12-complete-2026-10-04/preview/workpilot-sidecar.exe"),
);
process.env.WORKPILOT_ENGINE_BINARY = binary;
const bundle = dirname(binary),
  fixture = await startToolFixture();
setFixture(fixture);
const directory = await mkdtemp(join(output, "中文 Git-")),
  project = join(directory, "project"),
  outside = join(directory, "outside");
await mkdir(project);
await mkdir(outside);
await writeFile(join(project, "content.txt"), "inside version one");
await writeFile(join(project, "中文 文件.txt"), "中文版本内容");
await writeFile(join(outside, "private.cfg"), "[secret]\nvalue=OUTSIDE-SENTINEL\n");
const powershell = join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
const acl = (path) =>
  execFileSync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[IO.Directory]::GetAccessControl($env:WORKPILOT_ACL_FIXTURE).Sddl",
    ],
    { encoding: "utf8", windowsHide: true, env: { ...process.env, WORKPILOT_ACL_FIXTURE: path } },
  ).trim();
const before = Object.fromEntries(
  [directory, outside, project, join(bundle, "git-runtime")].map((path) => [path, acl(path)]),
);
let connections = 0;
const server = createServer((socket) => {
  connections++;
  socket.destroy();
}).listen(0, "127.0.0.1");
await once(server, "listening");
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  checks: [],
  binarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  gitSha256: createHash("sha256")
    .update(await readFile(join(bundle, "git-runtime/sandbox/bin/git.exe")))
    .digest("hex"),
};
let engine;
async function run(name, args, succeeds) {
  fixture.recipes.set(name, [
    { name: "run_command", args: { program: "git", args, timeout_ms: 10000 } },
  ]);
  const task = await create(engine, "responses", name, { controlled_tools: false });
  assert.equal(
    (
      await engine.request({
        kind: "configure_task_tools",
        task_id: task,
        settings: {
          root_path: project,
          permission: "request_approval",
          commands_enabled: true,
          review_profile_id: null,
          revision: 0,
        },
      })
    ).kind,
    "receipt",
  );
  await start(engine, task);
  const awaiting = await terminal(engine, task);
  assert.equal(awaiting.task.state, "awaiting_approval");
  const policy = await engine.request({
    kind: "read",
    query: { kind: "task_tools", task_id: task },
  });
  const approval = policy.state.approvals.find((entry) => entry.state === "pending");
  assert(approval);
  assert.equal(
    (
      await engine.request({
        kind: "decide_tool_approval",
        task_id: task,
        approval_id: approval.id,
        fingerprint: approval.fingerprint,
        approve: true,
      })
    ).kind,
    "receipt",
  );
  await start(engine, task);
  const finished = await terminal(engine, task);
  assert.equal(finished.task.state, "completed");
  const step = finished.steps.filter((entry) => entry.name === "run_command").at(-1);
  assert.equal(step.state, succeeds ? "completed" : "failed");
  const content = await engine.request({
    kind: "read",
    query: { kind: "content", object_id: step.output.object_id, offset: 0, limit: 32768 },
  });
  const saved = JSON.parse(content.page.text),
    detail = JSON.parse(saved.output);
  assert.equal(detail.containment, "windows_appcontainer_no_network");
  assert.equal(saved.is_error, !succeeds);
  return detail;
}
try {
  engine = await launch(join(directory, "data"));
  assert.match((await run("version", ["--version"], true)).stdout_preview, /workpilot\.1/);
  await run("init", ["init", "-b", "main"], true);
  await run("add", ["add", "content.txt", "中文 文件.txt"], true);
  await run(
    "commit",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "sandbox-first",
    ],
    true,
  );
  await run("nested-branch", ["branch", "nested/name"], true);
  assert.match(
    (await run("show", ["show", "HEAD:content.txt"], true)).stdout_preview,
    /inside version one/,
  );
  assert.equal(
    (await run("unicode-show", ["show", "HEAD:中文 文件.txt"], true)).stdout_preview,
    "中文版本内容",
  );
  report.checks.push(
    "version_init_add_commit_nested_refs_and_read_work_in_real_approved_appcontainer_commands",
  );
  const privateRead = await run(
    "read-outside",
    ["config", "--file=../outside/private.cfg", "--get", "secret.value"],
    false,
  );
  assert(!JSON.stringify(privateRead).includes("OUTSIDE-SENTINEL"));
  // .git is excluded from file snapshots; the OS boundary must still reject a
  // link beneath that directory. No user's repository or link is changed.
  await symlink(outside, join(project, ".git/outside-link"), "junction");
  const linkedRead = await run(
    "read-link",
    ["config", "--file=.git/outside-link/private.cfg", "--get", "secret.value"],
    false,
  );
  assert(!JSON.stringify(linkedRead).includes("OUTSIDE-SENTINEL"));
  await run("write-outside", ["init", "../outside/escape"], false);
  await assert.rejects(access(join(outside, "escape/.git")));
  assert.equal(
    await readFile(join(outside, "private.cfg"), "utf8"),
    "[secret]\nvalue=OUTSIDE-SENTINEL\n",
  );
  report.checks.push(
    "parent_and_junction_reads_and_parent_writes_remain_denied_without_expanding_project_permissions",
  );
  await run("network", ["ls-remote", `git://127.0.0.1:${server.address().port}/repository`], false);
  assert.equal(connections, 0);
  report.checks.push("git_native_protocol_cannot_connect_outside_no_network_container");
  await engine.close();
  engine = null;
  for (const [path, expected] of Object.entries(before)) assert.equal(acl(path), expected);
  report.checks.push("project_ancestor_outside_and_runtime_acls_are_unchanged_after_commands");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  await engine?.close().catch(() => {});
  await fixture.close();
  await new Promise((resolve) => server.close(resolve));
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
