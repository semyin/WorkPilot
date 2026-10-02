// Manual real-service acceptance. Credentials enter via stdin and are removed afterwards.
// This script is never run by CI and uses only a fresh, isolated test workspace.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { root } from "./cargo.mjs";
import { launch, profile, snapshot, start, until } from "./tool-test-support.mjs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const setup = JSON.parse(input);
input = "";
const output = join(root, ".test-results/real-teams");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "session-"));
const engine = await launch(directory);
const profiles = [];
const report = {
  at: new Date().toISOString(),
  synthetic: false,
  service: "User-provided Alibaba Cloud workspace",
  directory,
  checks: [],
};
try {
  for (const protocol of ["chat_completions", "messages", "responses"]) {
    const p = profile(protocol, setup.model);
    p.id = "real-team-" + protocol;
    p.label = "真实协作 " + protocol;
    p.auth = protocol === "messages" ? "api_key" : "bearer";
    p.base_url =
      setup.origin + (protocol === "messages" ? "/apps/anthropic/v1" : "/compatible-mode/v1");
    p.options = {
      ...p.options,
      max_output_tokens: 4096,
      chat_token_parameter: "max_tokens",
      timeout_ms: 90000,
      idle_timeout_ms: 30000,
    };
    const r = await engine.request({
      kind: "save_provider",
      profile: p,
      secret: setup.key,
      clear_credential: false,
    });
    assert.equal(r.kind, "provider_saved");
    profiles.push(p);
  }
  setup.key = "";
  const folder = join(directory, "project");
  await mkdir(folder);
  await writeFile(join(folder, "values-a.json"), '{"values":[6,6]}');
  await writeFile(join(folder, "values-b.json"), '{"values":[10,20]}');
  const goal = `这是 WorkPilot 多助手真实验收，仅操作授权测试目录。必须一次 delegate_agents 创建恰好三个独立成员：a 用 profile_id=${profiles[0].id}，读取 values-a.json 求和，用 write_file 新建 a.txt 仅写 12，再回读并 register_artifact；b 用 profile_id=${profiles[1].id}，读取 values-b.json 求和，新建 b.txt 仅写 30，再回读并登记；join 用 profile_id=${profiles[2].id}，depends_on=["a","b"]，等前两者交付后读取 a.txt、b.txt，把总和 42 写进新文件 answer.txt，回读并登记。把上述细节写进各成员 goal。成员不要再派人。主助手用 wait_for_agents 等待，逐一 inspect_agent 检查实际交付，并用 review_agent_result 接受准确的交付。最后主助手自己回读 answer.txt 确認42，中文报告成果来源。不要建立额外助手，不要使用命令，不需要用户参与，不要调用 update_plan。`;
  const created = await engine.request({
    kind: "create_execution",
    config: {
      title: "真实三助手协作验收",
      goal,
      constraints: ["每名成员只做自己的分工，不再分派；只操作此测试目录；禁止命令和外部业务"],
      project_rules: "",
      project_id: null,
      profile_id: profiles[2].id,
      mode: "execute",
      controlled_tools: false,
      limits: {
        max_steps: 80,
        max_duration_ms: 240000,
        context_bytes: 262144,
        max_result_bytes: 65536,
      },
    },
  });
  assert.equal(created.kind, "receipt");
  const task = created.receipt.task_id;
  report.task_id = task;
  assert.equal(
    (
      await engine.request({
        kind: "configure_team",
        task_id: task,
        settings: {
          enabled: true,
          max_parallel: 3,
          max_members: 3,
          max_depth: 1,
          max_replacements: 0,
          revision: 0,
        },
      })
    ).kind,
    "receipt",
  );
  assert.equal(
    (
      await engine.request({
        kind: "configure_task_tools",
        task_id: task,
        settings: {
          root_path: folder,
          permission: "full_access",
          commands_enabled: false,
          review_profile_id: null,
          revision: 0,
        },
      })
    ).kind,
    "receipt",
  );
  await start(engine, task);
  const s = await until(async () => {
    const s = await snapshot(engine, task);
    return (
      (["completed", "failed", "interrupted"].includes(s.task.state) ||
        (s.task.state === "awaiting_input" && s.context.question)) &&
      s
    );
  }, 300000);
  const team = await engine.request({ kind: "read", query: { kind: "team", task_id: task } });
  report.state = s.task.state;
  report.diagnostic = s.latest_run?.diagnostic;
  report.text = s.context.last_text;
  report.members = team.view.members;
  report.models = profiles.map((p) => ({ id: p.id, protocol: p.protocol, model: p.model }));
  report.outputs = {};
  for (const path of ["a.txt", "b.txt", "answer.txt"])
    report.outputs[path] = await readFile(join(folder, path), "utf8").catch(() => null);
  report.member_runs = await Promise.all(
    team.view.members.map(async (m) => {
      const s = await snapshot(engine, m.task_id);
      return {
        task_id: m.task_id,
        profile_id: s.config.profile_id,
        state: s.task.state,
        diagnostic: s.latest_run?.diagnostic,
        steps: s.steps.map((s) => ({ name: s.name, state: s.state })),
        text: s.context.last_text,
      };
    }),
  );
  assert.equal(s.task.state, "completed");
  assert.equal(team.view.members.length, 3);
  assert.equal(new Set(team.view.members.map((m) => m.profile_id)).size, 3);
  assert(
    team.view.members.every((m) => m.state === "completed" && m.review === "accepted" && m.report),
  );
  assert.equal(report.outputs["answer.txt"]?.trim(), "42");
  report.checks.push(
    "real_three_protocol_profiles_independent_members_dependency_files_review_and_parent_readback",
  );
  report.result = "passed";
} catch (e) {
  report.result = "failed";
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  setup.key = "";
  const catalog = await engine.request({ kind: "read", query: { kind: "profiles" } });
  for (const p of catalog.catalog.profiles) {
    assert.equal(
      (
        await engine.request({
          kind: "save_provider",
          profile: p.profile,
          secret: null,
          clear_credential: true,
        })
      ).kind,
      "provider_saved",
    );
  }
  const clean = await engine.request({ kind: "read", query: { kind: "profiles" } });
  report.credentials_removed = clean.catalog.profiles.every((p) => p.credential_saved === false);
  await engine.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        result: report.result,
        state: report.state,
        members: report.members?.length,
        checks: report.checks,
        credentials_removed: report.credentials_removed,
        error: report.error,
      },
      null,
      2,
    ),
  );
}
