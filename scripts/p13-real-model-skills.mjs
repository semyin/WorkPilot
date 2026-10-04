// A real Qwen workflow; management decisions are explicit test-driver actions.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createTask,
  waitTask,
  traceTask,
  modelCalls,
  saveEvidence,
} from "./p13-real-model-support.mjs";

const skillName = "p13-reusable-summary";
const privatePrefix = "青禾验收";
const preference = `我希望这个项目的演示汇报标题统一以“${privatePrefix}”开头。`;
const outputText = `${privatePrefix}|合计=23`;
const finishedTools = (trace, name) =>
  trace.steps.filter((s) => s.name === name && s.state === "completed");
const resultOf = (step) => JSON.parse(step.output.output);
const views = (trace) =>
  trace.steps
    .filter((s) => s.kind === "model")
    .flatMap((s) =>
      (s.input.messages || []).flatMap((m) =>
        (m.content || []).flatMap((p) => {
          if (typeof p.text !== "string") return [];
          try {
            const v = JSON.parse(p.text);
            return v.workpilot_memory_view === 1 ? [v] : [];
          } catch {
            return [];
          }
        }),
      ),
    );

export async function skillsMemory(ctx, spec, scenario) {
  const ext = async (task_id, action) => {
    const r = await ctx.request({ kind: "extensions", task_id, action });
    assert.equal(r.kind, "workbench");
    return r.data;
  };
  const memory = async (action) => {
    const r = await ctx.request({ kind: "memory", action });
    assert.equal(r.kind, "memory");
    return r.data;
  };
  const list = (project_id, include_deleted = false) =>
    memory({
      kind: "list",
      project_id,
      search: "",
      include_deleted,
      offset: 0,
      limit: 64,
    });
  const project = async (label) => {
    const folder = join(ctx.directory, "project-" + label);
    await mkdir(folder);
    const r = await ctx.request({
      kind: "workspace",
      action: {
        kind: "save_project",
        project_id: null,
        settings: {
          name: "P13 isolated " + label,
          root_path: folder,
          default_profile_id: spec.id,
          permission: "request_approval",
          rules: "",
          revision: 0,
        },
      },
    });
    assert.equal(r.kind, "workspace");
    return { id: r.data.project.id, folder };
  };
  const a = await project("A"),
    b = await project("B");
  ctx.report.workflowScope = {
    model: spec.model,
    protocol: spec.protocol,
    projectA: a.id,
    projectB: b.id,
    inputFiles: "Synthetic values only; no user project, account, scripts or external extension.",
    confirmations:
      "Independent test-driver management commands, not AI self-approval or real user acceptance.",
  };
  ctx.report.managementActions = [];
  const managed = async (description, action, invoke) => {
    const entry = {
      at: new Date().toISOString(),
      actor: "explicit_test_driver_management",
      description,
      action,
    };
    ctx.report.managementActions.push(entry);
    const r = await invoke();
    entry.completed = true;
    return r;
  };
  const run = async (result, title, goal, p, mode = "chat", approve = null) => {
    const id = await createTask(ctx, spec, title, goal, p.folder, "request_approval", {
      projectId: p.id,
      mode,
      constraints: [
        "Only this isolated project and local skill/memory APIs. No shell, browser, third-party service, script execution, delegation, permission changes or hidden confirmation.",
      ],
      projectRules:
        "Use actual read-only skill and memory discovery; candidates need a separate management confirmation. File effects still require their exact approval.",
    });
    const record = { taskId: id, mode, requestedModel: spec.model };
    (result.tasks ||= []).push(record);
    await ctx.request({ kind: "start_execution", task_id: id });
    let trace;
    try {
      await waitTask(ctx, id, 540000, approve ? () => approve(id) : null, true);
    } finally {
      trace = await traceTask(ctx, id);
      Object.assign(record, {
        state: trace.state,
        text: trace.text,
        calls: modelCalls(trace, spec),
      });
    }
    assert(record.calls.length > 0);
    assert(
      record.calls.every((c) => c.actualModel === spec.model),
      "Preserve the actual returned model identity",
    );
    assert(
      !trace.steps.some((s) =>
        ["run_command", "extension_action", "delegate_agents"].includes(s.name),
      ),
      "This sample authorizes no executable extension, command or team",
    );
    return { id, trace };
  };
  const must = async (id, work) => {
    if (!(await scenario(id, work)))
      throw new Error(`Dependent workflow stopped after ${id}; later cases were not attempted`);
  };
  let draftTask, draft, candidate, installation;

  await must("skills:real_creator_draft_stays_inactive", async (result) => {
    const goal = `请为当前项目创建可复用技能 ${skillName}。先实际搜索 skill-creator 并读取它的 SKILL.md，再用 skill_draft 保存项目草稿。用途：以后用户要求按项目偏好生成数字汇总时，搜索已确认的“汇报标题”项目记忆得到标题前缀，读取用户指定 JSON 文件的 values 数组求和，写报告并回读登记。只生成 SKILL.md 和 references/format.md 两份 Markdown，不生成脚本、插件服务器或凭据。SKILL.md 的 name 必须是 ${skillName}，description 说明用途与触发时机，并要求使用时先读 references/format.md。参考说明中规定输出严格为“{标题前缀}|合计={总和}”，只一行无末尾换行；没有已确认偏好时先询问，不编造。该技能必须适用于不同输入数字，不能内置本次结果。保存后说明等待人工确认，不要自行启用、不修改项目文件。`;
    const r = await run(result, "P13 real skill draft", goal, a, "execute");
    draftTask = r.id;
    const search = finishedTools(r.trace, "skill_search").find((s) =>
      resultOf(s).items.some((i) => i.installation.id === "builtin-skill-creator"),
    );
    const creatorRead = finishedTools(r.trace, "skill_read").find(
      (s) =>
        s.input.arguments.installation_id === "builtin-skill-creator" &&
        s.input.arguments.path === "SKILL.md",
    );
    const created = finishedTools(r.trace, "skill_draft");
    assert(search && creatorRead && created.length === 1);
    assert(search.ordinal < creatorRead.ordinal && creatorRead.ordinal < created[0].ordinal);
    assert.equal(created[0].input.arguments.project, true);
    assert.deepEqual(created[0].input.arguments.files.map((f) => f.path).sort(), [
      "SKILL.md",
      "references/format.md",
    ]);
    const catalog = await ext(draftTask, { kind: "catalog", query: null });
    assert(!catalog.items.some((i) => i.version.manifest.id === skillName));
    const previews = catalog.previews.filter((p) =>
      p.version.skills.some((s) => s.name === skillName),
    );
    assert.equal(previews.length, 1);
    draft = previews[0];
    assert(draft.draft && draft.scope);
    assert.equal(draft.version.manifest.servers.length, 0);
    const resources = {};
    for (const path of ["SKILL.md", "references/format.md"]) {
      const item = await ext(draftTask, { kind: "preview_resource", draft_id: draft.id, path });
      assert.equal(typeof item.text, "string");
      resources[path] = item.text;
    }
    assert.match(resources["SKILL.md"], /references\/format\.md/);
    assert.match(resources["SKILL.md"] + resources["references/format.md"], /memory_search|记忆/);
    assert(!JSON.stringify(resources).includes(privatePrefix));
    result.draft = draft;
    result.resources = resources;
    result.creatorReadBeforeDraft = true;
    result.activeBeforeConfirmation = false;
    await saveEvidence(ctx, "generated-skill-resources.json", resources);
  });

  await must("memory:real_proposal_stays_unconfirmed", async (result) => {
    const r = await run(
      result,
      "P13 real memory candidate",
      `${preference}请以我的这句原话为来源，使用 memory_propose 保存项目范围的长期偏好候选。不要自行确认，不创建技能或写文件。`,
      a,
    );
    assert.equal(r.trace.state, "completed");
    const proposed = finishedTools(r.trace, "memory_propose");
    assert.equal(proposed.length, 1);
    assert.equal(proposed[0].input.arguments.scope, "project");
    const returned = resultOf(proposed[0]);
    assert.equal(returned.active, false);
    assert.equal(returned.state, "suggested");
    candidate = (await list(a.id)).items.find((i) => i.source_task_id === r.id);
    assert(candidate && candidate.project_id === a.id && candidate.state === "suggested");
    assert(candidate.text.includes(privatePrefix));
    assert(
      preference.includes(candidate.source_quote),
      "The evidence quote must be from the stated synthetic preference",
    );
    result.candidate = candidate;
  });

  const absent = async (result, title, p) => {
    const r = await run(
      result,
      title,
      `只用只读工具：skill_search 查询 ${skillName}，memory_search 查询“汇报标题”。两者都必须实际调用，并如实说明是否有当前有效内容。不要创建、确认、恢复或修改任何东西，不读取其它项目。`,
      p,
    );
    assert.equal(r.trace.state, "completed");
    const skills = finishedTools(r.trace, "skill_search"),
      memories = finishedTools(r.trace, "memory_search");
    assert(skills.length && memories.length);
    assert(
      skills.every((s) => !resultOf(s).items.some((i) => i.version.manifest.id === skillName)),
    );
    assert(
      memories.every(
        (s) =>
          !resultOf(s).items.some((i) => i.id === candidate.id || i.text.includes(privatePrefix)),
      ),
    );
    const memoryViews = views(r.trace);
    assert(memoryViews.length, "Inspect the actual memory context sent with the model input");
    assert(
      memoryViews.every(
        (v) => !v.items.some((i) => i.id === candidate.id || i.text.includes(privatePrefix)),
      ),
    );
    assert(
      !JSON.stringify(
        r.trace.steps.filter((s) => s.kind === "model").map((s) => s.input.messages),
      ).includes(privatePrefix),
    );
    result.skillAbsent = true;
    result.memoryAbsentFromSearchAndModelInput = true;
  };
  await must("scope:unconfirmed_skill_and_memory_are_not_model_context", (result) =>
    absent(result, "P13 before management confirmation", a),
  );

  await must("management:explicit_confirmation_enable_and_memory_decision", async (result) => {
    const confirm = {
      kind: "confirm",
      draft_id: draft.id,
      digest: draft.version.digest,
      enable: true,
    };
    await managed("Confirm the inspected Markdown-only project skill and enable it", confirm, () =>
      ext(draftTask, confirm),
    );
    const catalog = await ext(draftTask, { kind: "catalog", query: skillName });
    installation = catalog.items.find((i) =>
      i.version.skills.some((s) => s.name === skillName),
    )?.installation;
    assert(installation?.enabled && installation?.installed && installation?.scope);
    const decide = {
      kind: "decide",
      memory_id: candidate.id,
      revision: candidate.revision,
      confirm: true,
    };
    await managed("Confirm this exact synthetic project memory candidate", decide, () =>
      memory(decide),
    );
    candidate = (await list(a.id)).items.find((i) => i.id === candidate.id);
    assert.equal(candidate.state, "confirmed");
    result.installation = installation;
    result.confirmedMemory = candidate;
    result.actor = "Test driver; no model confirmation tool was invoked";
  });

  await must("reuse:new_task_reads_skill_memory_and_produces_verified_file", async (result) => {
    await writeFile(join(a.folder, "values.json"), JSON.stringify({ values: [3, 7, 13] }));
    const goal = `请实际找到并使用项目技能 ${skillName}，先读技能和它要求的参考说明，再通过 memory_search 检索已确认的“汇报标题”偏好。读取当前 values.json，按技能规则把报告写到新文件 summary.txt，然后回读并登记成果。不要猜标题前缀，不更新记忆，不创建新技能，不用脚本、浏览器或其它项目。`;
    const approve = async (task_id) => {
      const state = await ctx.request({ kind: "read", query: { kind: "task_tools", task_id } });
      const a = state.state.approvals.find((a) => a.state === "pending");
      assert(a && a.intent.tool === "write_file" && a.intent.target === "summary.txt");
      assert.equal(a.intent.arguments.expected_sha256, null);
      assert.equal(a.intent.arguments.text, outputText);
      const action = {
        kind: "decide_tool_approval",
        task_id,
        approval_id: a.id,
        fingerprint: a.fingerprint,
        approve: true,
      };
      await managed("Approve only the reviewed synthetic summary.txt creation", action, () =>
        ctx.request(action),
      );
      result.fileApprovals = (result.fileApprovals || 0) + 1;
      await ctx.request({ kind: "start_execution", task_id });
    };
    const r = await run(
      result,
      "P13 real skill and confirmed memory reuse",
      goal,
      a,
      "execute",
      approve,
    );
    assert.equal(r.trace.state, "completed");
    for (const path of ["SKILL.md", "references/format.md"])
      assert(
        finishedTools(r.trace, "skill_read").some(
          (s) =>
            s.input.arguments.installation_id === installation.id &&
            s.input.arguments.path === path,
        ),
      );
    assert(
      finishedTools(r.trace, "memory_search").some((s) =>
        resultOf(s).items.some((i) => i.id === candidate.id),
      ),
    );
    assert(views(r.trace).some((v) => v.items.some((i) => i.id === candidate.id)));
    for (const name of ["read_file", "write_file", "register_artifact"])
      assert(finishedTools(r.trace, name).some((s) => s.input.arguments.path === "summary.txt"));
    assert.equal(result.fileApprovals, 1);
    assert.equal(await readFile(join(a.folder, "summary.txt"), "utf8"), outputText);
    assert.deepEqual((await readdir(a.folder)).sort(), ["summary.txt", "values.json"]);
    result.actualFile = outputText;
    result.confirmedMemorySourceTask = candidate.source_task_id;
    result.installedSkill = installation.id;
  });

  await must("scope:other_project_does_not_receive_skill_or_memory", (result) =>
    absent(result, "P13 project B isolation", b),
  );
  await must(
    "deletion:new_task_cannot_reuse_deleted_memory_or_uninstalled_skill",
    async (result) => {
      const remove = { kind: "delete", memory_id: candidate.id, revision: candidate.revision };
      await managed("Delete only this confirmed synthetic memory", remove, () => memory(remove));
      const uninstall = {
        kind: "uninstall",
        installation_id: installation.id,
        revision: installation.revision,
      };
      await managed("Uninstall only the skill created by this workflow", uninstall, () =>
        ext(draftTask, uninstall),
      );
      const deleted = (await list(a.id, true)).items.find((i) => i.id === candidate.id);
      assert.equal(deleted.deleted, true);
      await absent(result, "P13 after explicit deletion and uninstall", a);
      assert.equal(
        await readFile(join(a.folder, "summary.txt"), "utf8"),
        outputText,
        "Uninstall must preserve the previously generated project file",
      );
      result.existingFilePreserved = true;
      result.deletedMemory = deleted;
    },
  );
}
