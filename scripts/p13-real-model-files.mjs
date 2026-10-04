import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  createTask,
  waitTask,
  traceTask,
  modelCalls,
  savedContent,
} from "./p13-real-model-support.mjs";

const completedTool = (trace, name, path) =>
  trace.steps.some(
    (s) =>
      s.kind === "tool" &&
      s.name === name &&
      s.state === "completed" &&
      (!path || s.input?.arguments?.path === path),
  );
const family = (model) =>
  /qwen/i.test(model)
    ? "Qwen"
    : /glm/i.test(model)
      ? "GLM"
      : /deepseek/i.test(model)
        ? "DeepSeek"
        : "unknown";

export async function singleFile(ctx, spec, result) {
  const folder = join(ctx.directory, "files-" + spec.protocol);
  await mkdir(folder);
  await writeFile(join(folder, "values.json"), JSON.stringify({ values: [7, 11, 19] }));
  const permission = spec.protocol === "responses" ? "auto_review" : "request_approval";
  const goal =
    "这是受控平台验收。只用 read_file 读取 values.json，把 values 数组相加，用 write_file 新建 answer.txt，仅写总和的十进制数字且不加换行。随后必须 read_file 回读 answer.txt 并 register_artifact 登记。不要把计算过程代替文件，不要建计划或派助手，不用命令、浏览器或扩展；最后说明回读结果。";
  const task = await createTask(
    ctx,
    spec,
    "P13 real file " + spec.protocol,
    goal,
    folder,
    permission,
  );
  Object.assign(result, {
    taskId: task,
    protocol: spec.protocol,
    requestedModel: spec.model,
    permission,
    manualApprovals: 0,
  });
  await ctx.request({ kind: "start_execution", task_id: task });
  await waitTask(
    ctx,
    task,
    540000,
    permission === "request_approval"
      ? async () => {
          const r = await ctx.request({
            kind: "read",
            query: { kind: "task_tools", task_id: task },
          });
          const approval = r.state.approvals.find((a) => a.state === "pending");
          assert(approval, "Expected the concrete test-file approval");
          assert.equal(approval.intent.tool, "write_file");
          assert.equal(approval.intent.target, "answer.txt");
          assert.equal(approval.intent.arguments.text, "37");
          assert.equal(approval.intent.arguments.expected_sha256, null);
          await ctx.request({
            kind: "decide_tool_approval",
            task_id: task,
            approval_id: approval.id,
            fingerprint: approval.fingerprint,
            approve: true,
          });
          result.manualApprovals++;
          await ctx.request({ kind: "start_execution", task_id: task });
        }
      : null,
  );
  const trace = await traceTask(ctx, task);
  const tools = await ctx.request({ kind: "read", query: { kind: "task_tools", task_id: task } });
  const approval = tools.state.approvals.find((a) => a.intent.tool === "write_file");
  result.calls = modelCalls(trace, spec);
  result.taskState = trace.state;
  result.actualFile = await readFile(join(folder, "answer.txt"), "utf8").catch(() => null);
  result.approval = approval
    ? { state: approval.state, decidedBy: approval.decided_by, review: approval.review }
    : null;
  result.fileChanges = tools.state.changes.length;
  assert.equal(
    trace.state,
    "completed",
    ctx.redact(trace.latestRun?.diagnostic || trace.latestRun?.reason),
  );
  assert.equal(result.actualFile, "37");
  assert.deepEqual((await readdir(folder)).sort(), ["answer.txt", "values.json"]);
  assert(completedTool(trace, "read_file", "values.json"));
  assert(completedTool(trace, "write_file", "answer.txt"));
  assert(completedTool(trace, "read_file", "answer.txt"));
  assert(completedTool(trace, "register_artifact", "answer.txt"));
  assert.equal(tools.state.changes.length, 1);
  if (permission === "auto_review") assert.equal(approval?.decided_by, "independent_model_review");
}

export async function distinctModelTeam(ctx, profiles, result, options = {}) {
  const alpha = profiles.find((p) => p.id === (options.alphaProfile || "p13-glm-chat"));
  const beta = profiles.find((p) => p.family === "DeepSeek");
  const lead = profiles.find((p) => p.id === "p13-qwen-responses");
  assert(alpha && beta && lead);
  const folder = join(ctx.directory, "team-files");
  await mkdir(folder);
  await writeFile(join(folder, "values-a.json"), JSON.stringify({ values: [13, 29] }));
  await writeFile(join(folder, "values-b.json"), JSON.stringify({ values: [17, 31] }));
  const placeholder = "P13_PENDING_NOT_AN_OUTPUT\n";
  if (options.alphaExisting) await writeFile(join(folder, "a.txt"), placeholder);
  let goal = `这是 WorkPilot 真实不同模型协作验收，只操作授权测试目录。必须一次 delegate_agents 创建恰好三个成员，标识必须为 alpha、beta、join：alpha 用 profile_id=${alpha.id}，读取 values-a.json 的 values 相加，把十进制总和（仅数字无换行）用 write_file 新建 a.txt，read_file 回读并 register_artifact；beta 用 profile_id=${beta.id}，读取 values-b.json 求和，新建 b.txt，仅数字无换行，回读并登记；join 用 profile_id=${lead.id}，depends_on=["alpha","beta"]，必须等前两者交付，读取 a.txt 和 b.txt，把两数相加仅写数字到新文件 answer.txt，回读并登记。分派 goal 写全这些要求，三个成员不得再派人。主任务使用 wait_for_agents 等待，分别 inspect_agent 检查真实交付并 review_agent_result 接受正确成果。最后主任务自己 read_file 回读 answer.txt，说明三个成果的来源。不要另建成员，不要调用命令、浏览器、扩展或 update_plan，不操作外部业务。`;
  if (options.alphaExisting)
    goal = goal.replace(
      "用 write_file 新建 a.txt",
      "先 read_file 读取已有 a.txt（它只有占位文本，不是成果）取得准确 sha256，再用 write_file 以这个摘要为 expected_sha256 覆盖 a.txt",
    );
  if (options.clarifyNull)
    goal +=
      ' 本轮是独立新任务，澄清工具参数：新文件 expected_sha256 必须是 JSON 的 null 值，不能是字符串 "null"，不能是空字符串或自己计算的 hash。请把这段规则及例子完整放入三个成员的 goal：例如 write_file({"path":"example.txt","text":"你的计算结果","expected_sha256":null})。例子仅解释参数，请实际写自己被分配的文件和真实计算结果。路径直接写文件名，勿加 ./。如果仍失败，保留错误并停止提出问题，不可代替其它成员写文件，也不可声称成功。';
  const task = await createTask(ctx, lead, "P13 real distinct-model team", goal, folder);
  Object.assign(result, {
    taskId: task,
    assignments: { alpha, beta, join: lead },
    permission: "full_access",
    commandsEnabled: false,
    promptRevision: options.clarifyNull ? "json-null-v2" : "original-v1",
    alphaFileMode: options.alphaExisting ? "read_hash_and_replace_existing" : "create_new",
    initialAlphaFile: options.alphaExisting ? placeholder : null,
    midRunHumanInstructions: 0,
    automaticModelFallbacks: 0,
  });
  await ctx.request({
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
  });
  await ctx.request({ kind: "start_execution", task_id: task });
  let waitError;
  try {
    await waitTask(ctx, task, 960000);
  } catch (error) {
    waitError = error;
  }
  const root = await traceTask(ctx, task);
  const response = await ctx.request({ kind: "read", query: { kind: "team", task_id: task } });
  assert.equal(response.kind, "team");
  result.taskState = root.state;
  result.parentCalls = modelCalls(root, lead);
  result.parentText = root.text;
  result.members = [];
  for (const member of response.view.members) {
    const spec = profiles.find((p) => p.id === member.profile_id);
    const trace = await traceTask(ctx, member.task_id);
    const delivery = await savedContent(ctx, member.report);
    result.members.push({ ...member, calls: spec ? modelCalls(trace, spec) : [], delivery });
  }
  result.outputs = {};
  for (const path of ["a.txt", "b.txt", "answer.txt"])
    result.outputs[path] = await readFile(join(folder, path), "utf8").catch(() => null);
  if (waitError) throw waitError;
  assert.equal(
    root.state,
    "completed",
    ctx.redact(root.latestRun?.diagnostic || root.latestRun?.reason),
  );
  assert.equal(result.members.length, 3);
  assert(
    result.members.every((m) => m.state === "completed" && m.review === "accepted" && m.report),
  );
  const a = result.members.find((m) => m.key === "alpha"),
    b = result.members.find((m) => m.key === "beta"),
    aggregate = result.members.find((m) => m.key === "join");
  assert(a && b && aggregate);
  assert.equal(a.profile_id, alpha.id);
  assert.equal(b.profile_id, beta.id);
  assert.equal(aggregate.profile_id, lead.id);
  assert.deepEqual([...aggregate.depends_on].sort(), [a.task_id, b.task_id].sort());
  assert.deepEqual(result.outputs, { "a.txt": "42", "b.txt": "48", "answer.txt": "90" });
  assert.deepEqual((await readdir(folder)).sort(), [
    "a.txt",
    "answer.txt",
    "b.txt",
    "values-a.json",
    "values-b.json",
  ]);
  for (const [m, file] of [
    [a, "a.txt"],
    [b, "b.txt"],
    [aggregate, "answer.txt"],
  ]) {
    const trace = ctx.traces[m.task_id];
    assert(completedTool(trace, "write_file", file));
    assert(completedTool(trace, "read_file", file));
    assert(completedTool(trace, "register_artifact", file));
    assert(m.delivery.artifacts.some((artifact) => artifact.path === file));
  }
  if (options.alphaExisting) {
    const steps = ctx.traces[a.task_id].steps;
    const wrote = steps.find(
      (s) =>
        s.name === "write_file" && s.state === "completed" && s.input?.arguments?.path === "a.txt",
    );
    const oldHash = createHash("sha256").update(placeholder).digest("hex");
    assert.equal(wrote.input.arguments.expected_sha256, oldHash);
    const readBefore = steps.some(
      (s) =>
        s.name === "read_file" &&
        s.state === "completed" &&
        s.input?.arguments?.path === "a.txt" &&
        s.ordinal < wrote.ordinal &&
        JSON.parse(s.output.output).text === placeholder,
    );
    assert(readBefore, "The member must actually read the old placeholder and its version first");
    result.alphaExistingFileEvidence = {
      readBeforeWrite: true,
      expectedOriginalSha256: oldHash,
      finalText: result.outputs["a.txt"],
    };
  }
  const returnedFamilies = new Set(
    result.members
      .flatMap((m) => m.calls.map((c) => family(c.actualModel || "")))
      .filter((f) => f !== "unknown"),
  );
  result.actualReportedFamilies = [...returnedFamilies];
  assert(
    returnedFamilies.size >= 2,
    "At least two distinct service-reported model families must actually run",
  );
  const joinStarted = Math.min(...aggregate.calls.map((c) => c.startedAtMs));
  const aEnded = Math.max(...a.calls.map((c) => c.endedAtMs));
  const bEnded = Math.max(...b.calls.map((c) => c.endedAtMs));
  assert(
    joinStarted >= Math.max(aEnded, bEnded),
    "Dependent model ran before prerequisite deliveries",
  );
  result.dependencyTimes = { joinStarted, aEnded, bEnded };
  const aDone = ctx.events.find(
    (e) => e.kind === "execution_ended" && e.task_id === a.task_id && e.state === "completed",
  );
  const bDone = ctx.events.find(
    (e) => e.kind === "execution_ended" && e.task_id === b.task_id && e.state === "completed",
  );
  const joinRun = ctx.events.find(
    (e) => e.kind === "execution_started" && e.task_id === aggregate.task_id,
  );
  assert(aDone && bDone && joinRun);
  assert(joinRun.sequence > aDone.sequence && joinRun.sequence > bDone.sequence);
  result.dependencyEvents = {
    aCompleted: aDone.sequence,
    bCompleted: bDone.sequence,
    joinStarted: joinRun.sequence,
  };
  assert(completedTool(root, "read_file", "answer.txt"));
  for (const m of result.members) {
    assert(
      root.steps.some(
        (s) =>
          s.name === "inspect_agent" &&
          s.state === "completed" &&
          s.input?.arguments?.member_id === m.task_id,
      ),
    );
    assert(
      root.steps.some(
        (s) =>
          s.name === "review_agent_result" &&
          s.state === "completed" &&
          s.input?.arguments?.member_id === m.task_id &&
          s.input?.arguments?.accept === true,
      ),
    );
  }
}
