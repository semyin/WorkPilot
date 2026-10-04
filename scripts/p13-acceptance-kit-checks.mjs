import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { saveProfile, createTask } from "./p13-engine-load.mjs";
import { eventually, start, snapshot, finished } from "./p13-engine-client.mjs";
import { digest } from "./p13-soak-workbench.mjs";

export async function verifyInstallation(context) {
  const began = performance.now();
  const pending = context.engine.request({ kind: "inspect_installation", verify_hashes: true });
  assert.equal((await context.engine.request({ kind: "ping" })).kind, "receipt");
  const reply = await pending;
  assert.equal(reply.kind, "installation", JSON.stringify(reply));
  assert(reply.report.manifest_present);
  assert.equal(reply.report.components.length, 9);
  assert(
    reply.report.components.every((c) => c.state === "verified" && c.files === c.checked_files),
  );
  return { elapsedMs: performance.now() - began, report: reply.report };
}

export async function verifyTools(context) {
  const { engine, fixture } = context;
  const project = join(context.project, "中文工具检查");
  await mkdir(project);
  const profile = await saveProfile(engine, fixture, "acceptance-owned-tools", {
    kind: "leaf",
    actions: [
      {
        name: "run_command",
        args: {
          program: "python",
          args: [
            "-c",
            "import pathlib,hashlib;pathlib.Path('python.txt').write_text(hashlib.sha256(b'42').hexdigest());pathlib.Path('中文.txt').write_text('测试资料 42',encoding='utf-8')",
          ],
          timeout_ms: 15000,
        },
      },
      {
        name: "run_command",
        args: {
          program: "node",
          args: ["-e", "require('fs').writeFileSync('node.txt',process.version)"],
          timeout_ms: 15000,
        },
      },
      { name: "run_command", args: { program: "git", args: ["init"], timeout_ms: 15000 } },
      {
        name: "run_command",
        args: {
          program: "git",
          args: ["add", "python.txt", "node.txt", "中文.txt"],
          timeout_ms: 15000,
        },
      },
      {
        name: "run_command",
        args: {
          program: "git",
          args: [
            "-c",
            "user.name=WorkPilot Acceptance",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "acceptance-synthetic-files",
          ],
          timeout_ms: 15000,
        },
      },
    ],
  });
  const task = await createTask(engine, profile, "便携验收：自有工具文件");
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
  let value;
  for (let attempt = 0; attempt < 8; attempt++) {
    value = await eventually(
      async () => {
        const current = await snapshot(engine, task);
        return (
          ["awaiting_approval", "completed", "failed", "interrupted"].includes(
            current.task.state,
          ) && current
        );
      },
      90000,
      80,
    );
    if (value.task.state !== "awaiting_approval") break;
    const policy = await engine.request({
      kind: "read",
      query: { kind: "task_tools", task_id: task },
    });
    const approval = policy.state.approvals.find((row) => row.state === "pending");
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
  }
  assert.equal(value.task.state, "completed", JSON.stringify(value.latest_run));
  const commands = value.steps.filter((row) => row.name === "run_command");
  assert.equal(commands.length, 5);
  for (const command of commands) {
    assert.equal(command.state, "completed");
    const result = await engine.request({
      kind: "read",
      query: { kind: "content", object_id: command.output.object_id, offset: 0, limit: 32768 },
    });
    const saved = JSON.parse(result.page.text),
      detail = JSON.parse(saved.output);
    assert.equal(saved.is_error, false);
    assert.equal(detail.containment, "windows_appcontainer_no_network");
  }
  assert.equal(await readFile(join(project, "python.txt"), "utf8"), digest(Buffer.from("42")));
  assert.match(await readFile(join(project, "node.txt"), "utf8"), /^v\d+\.\d+\.\d+$/);
  assert.equal(await readFile(join(project, "中文.txt"), "utf8"), "测试资料 42");
  const commit = execFileSync(
    join(context.installation, "git-runtime/cmd/git.exe"),
    ["log", "--format=%s", "-1"],
    {
      cwd: project,
      windowsHide: true,
      encoding: "utf8",
      timeout: 15000,
    },
  ).trim();
  assert.equal(commit, "acceptance-synthetic-files");
  return {
    task,
    commands: 5,
    containment: "windows_appcontainer_no_network",
    files: ["python.txt", "node.txt", "中文.txt"],
    verifiedGitCommit: commit,
  };
}

export async function verifyUnavailableModels(context, reopen) {
  const { fixture } = context;
  let engine = context.engine;
  const existing = await createTask(
    engine,
    context.profiles.leaf,
    "便携验收：本地历史",
    context.project,
  );
  const note = "模型服务不可达时仍保留的测试资料 42";
  await writeFile(join(context.project, "本地资料.txt"), note);
  await start(engine, existing);
  const completed = await finished(engine, existing);
  const output = completed.steps.findLast((step) => step.output)?.output;
  assert(output);
  const content = async () =>
    (
      await engine.request({
        kind: "read",
        query: { kind: "content", object_id: output.object_id, offset: 0, limit: 65536 },
      })
    ).page.text;
  const retainedText = await content();
  const availableRequests = fixture.records.length;
  const reserved = createServer().listen(0, "127.0.0.1");
  await once(reserved, "listening");
  const unavailable = `http://127.0.0.1:${reserved.address().port}`;
  await new Promise((done) => reserved.close(done));
  const catalog = await engine.request({ kind: "read", query: { kind: "profiles" } });
  const base = catalog.catalog.profiles.find(
    (row) => row.profile.id === context.profiles.leaf,
  ).profile;
  const failures = [];
  for (const protocol of ["chat_completions", "responses", "messages"]) {
    const profile = {
      ...base,
      id: crypto.randomUUID(),
      label: "本机不可达 " + protocol,
      model: "unavailable-fixture",
      protocol,
      base_url: unavailable,
      revision: 1,
    };
    assert.equal(
      (
        await engine.request({
          kind: "save_provider",
          profile,
          secret: null,
          clear_credential: false,
        })
      ).kind,
      "provider_saved",
    );
    const task = await createTask(engine, profile.id, "便携验收：不可达 " + protocol);
    await start(engine, task);
    const failed = await finished(engine, task, "failed");
    assert.equal(failed.latest_run.diagnostic.code, "network");
    assert.equal(failed.latest_run.profile.id, profile.id);
    assert.equal(failed.steps.filter((step) => step.kind === "model").length, 1);
    assert.equal(failed.steps.filter((step) => step.kind === "tool").length, 0);
    failures.push({
      task,
      protocol,
      run: failed.latest_run.run.id,
      diagnostic: failed.latest_run.diagnostic,
    });
  }
  await delay(300);
  assert.equal(fixture.records.length, availableRequests);
  await engine.close();
  engine = await reopen();
  context.engine = engine;
  for (const row of failures) {
    const after = await snapshot(engine, row.task);
    assert.equal(after.task.state, "failed");
    assert.equal(after.latest_run.run.id, row.run);
    assert.equal(after.steps.filter((step) => step.kind === "model").length, 1);
  }
  assert.equal(await content(), retainedText);
  const local = await engine.request({
    kind: "workbench",
    task_id: existing,
    action: { kind: "read_file", path: "本地资料.txt" },
  });
  assert.equal(local.kind, "workbench");
  assert.equal(local.data.text, note);
  assert.equal(fixture.records.length, availableRequests);
  return {
    failures,
    historyAndFileRetained: true,
    automaticRetryOrFallback: false,
    scope: "仅不可达本机端点；不是整机断网",
  };
}
