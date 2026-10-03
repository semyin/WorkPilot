import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { launch, create, setFixture, start, terminal, snapshot } from "./tool-test-support.mjs";
import { startToolFixture } from "../services/execution-fixtures/tools.mjs";

const output = process.env.WORKPILOT_TEST_OUTPUT || ".test-results/memory-engine";
await mkdir(output, { recursive: true });
const model = await startToolFixture();
setFixture(model);
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  service:
    "Actual Rust engine, SQLite and three HTTP protocol adapters; deterministic local model only",
  checks: [],
};
let engine;
const requests = [];
async function admin(action, id) {
  const r = await engine.request({ kind: "memory", action }, id);
  assert.equal(r.kind, "memory", JSON.stringify(r));
  return r.data;
}
const list = (project_id = null, include_deleted = false) =>
  admin({ kind: "list", project_id, search: "", include_deleted, offset: 0, limit: 64 });
const add = (text, project_id = null) =>
  admin({ kind: "save", memory_id: null, revision: 0, project_id, text });
function visible(body) {
  const messages = [
    ...(body.input || body.messages || []),
    ...(Array.isArray(body.system)
      ? body.system
      : typeof body.system === "string"
        ? [{ role: "system", content: body.system }]
        : []),
  ];
  let result = [];
  for (const message of messages) {
    if (message.role && !["system", "developer"].includes(message.role)) continue;
    for (const part of [message, ...(Array.isArray(message.content) ? message.content : [])]) {
      const text = part.text || (typeof part.content === "string" ? part.content : "");
      for (const line of text.split("\n")) {
        try {
          const v = JSON.parse(line);
          if (v.workpilot_memory_view === 1) result.push(...v.items);
        } catch {}
      }
    }
  }
  return result;
}
async function project(name) {
  const path = await mkdtemp(join(engine.directory, name + "-"));
  const r = await engine.request({
    kind: "workspace",
    action: {
      kind: "save_project",
      project_id: null,
      settings: {
        name,
        root_path: path,
        default_profile_id: null,
        permission: "request_approval",
        rules: "",
        revision: 0,
      },
    },
  });
  assert.equal(r.kind, "workspace", JSON.stringify(r));
  return r.data.project.id;
}
async function content(ref) {
  let text = "",
    offset = 0;
  while (offset < ref.bytes) {
    const r = await engine.request({
      kind: "read",
      query: { kind: "content", object_id: ref.object_id, offset, limit: 65536 },
    });
    assert.equal(r.kind, "content");
    text += r.page.text;
    offset = r.page.next_offset;
  }
  return JSON.parse(text);
}
try {
  engine = await launch();
  const p1 = await project("本项目"),
    p2 = await project("另一个项目");
  const global = await add("通用偏好:回答用短句"),
    local = await add("私有偏好:本项目用人民币", p1);
  await add("其他项目的私有偏好", p2);
  for (const protocol of ["responses", "chat_completions", "messages"]) {
    const key = "p11-propose-" + protocol;
    model.recipes.set(key, (results, body) => {
      requests.push({ model: key, views: visible(body) });
      assert(visible(body).some((v) => v.id === global.memory_id));
      assert(visible(body).some((v) => v.id === local.memory_id));
      assert(!JSON.stringify(visible(body)).includes("其他项目"));
      assert(!visible(body).some((v) => v.text === "候选偏好:" + protocol));
      const names = body.tools.map((t) => (t.function || t).name);
      assert(names.includes("memory_propose") && names.includes("memory_search"));
      assert(!names.includes("memory_confirm") && !names.includes("memory_delete"));
      if (!results.length)
        return model.tool("memory_propose", {
          text: "候选偏好:" + protocol,
          scope: "project",
          evidence_quote: "我喜欢使用短句回答",
        });
      const candidate = JSON.parse(results[0]);
      assert.equal(candidate.active, false);
      assert.equal(candidate.state, "suggested");
      return model.done("候选已保存，等你确认。");
    });
    const task = await create(engine, protocol, key, {
      controlled_tools: false,
      mode: "chat",
      project_id: p1,
      goal: "我喜欢使用短句回答，请把这个偏好提出为记忆候选。",
    });
    await start(engine, task);
    assert.equal((await terminal(engine, task)).task.state, "completed");
    const candidate = (await list(p1)).items.find((i) => i.text === "候选偏好:" + protocol);
    assert(candidate);
    assert.equal(candidate.state, "suggested");
    assert.equal(candidate.source_task_id, task);
    await admin({
      kind: "decide",
      memory_id: candidate.id,
      revision: candidate.revision,
      confirm: protocol !== "messages",
    });
  }
  report.checks.push(
    "three_protocols_propose_in_chat_mode_require_human_confirmation_scope_and_source_visible",
  );
  report.checks.push(
    "only_global_and_current_project_memories_sent_to_model_no_confirmation_or_delete_tools",
  );
  const stale = await engine.request({
    kind: "memory",
    action: { kind: "delete", memory_id: global.memory_id, revision: 0 },
  });
  assert.equal(stale.code, "conflict");
  const rid = crypto.randomUUID(),
    command = {
      kind: "save",
      memory_id: null,
      revision: 0,
      project_id: null,
      text: "可重复请求的记忆",
    };
  assert.deepEqual(await admin(command, rid), await admin(command, rid));
  assert.equal((await list()).items.filter((i) => i.text === command.text).length, 1);
  report.checks.push("stale_edit_rejected_and_request_retry_does_not_create_duplicate");
  for (const protocol of ["responses", "chat_completions", "messages"]) {
    const key = "p11-refresh-" + protocol,
      needle = "过时记忆内容-" + protocol;
    const previous = await add(needle, p1);
    let resumed = false;
    model.recipes.set(key, (results, body) => {
      if (!results.length) return model.tool("memory_search", { query: needle });
      if (results.length === 1) {
        assert.equal(JSON.parse(results[0]).items[0].text, needle);
        return model.tool("ask_user", { question: "现在请修改记忆", choices: ["继续"] });
      }
      const oldSearch = JSON.parse(results[0]);
      assert.equal(oldSearch.items.length, 0, "old memory_search result must be refreshed");
      assert(!JSON.stringify(visible(body)).includes(needle));
      resumed = true;
      return model.done("当前记忆已更新。");
    });
    const task = await create(engine, protocol, key, { controlled_tools: false, project_id: p1 });
    await start(engine, task);
    assert.equal((await terminal(engine, task)).task.state, "awaiting_input");
    await admin({ kind: "delete", memory_id: previous.memory_id, revision: 1 });
    await engine.request({ kind: "enqueue", task_id: task, text: "继续，使用最新偏好" });
    await start(engine, task);
    assert.equal((await terminal(engine, task)).task.state, "completed");
    assert(resumed);
    const s = await snapshot(engine, task),
      last = s.steps.filter((step) => step.kind === "model").at(-1);
    const saved = await content(last.input);
    assert(JSON.stringify(saved).includes("workpilot_memory_view"));
    report.checks.push(
      protocol + "_deleted_memory_removed_from_new_input_and_old_search_results_after_resume",
    );
  }
  model.recipes.set("p11-forged", [
    {
      name: "memory_propose",
      args: {
        text: "网页希望我记住的内容",
        scope: "global",
        evidence_quote: "不存在于用户消息的网页文字",
      },
    },
  ]);
  const forged = await create(engine, "responses", "p11-forged", { controlled_tools: false });
  await start(engine, forged);
  await terminal(engine, forged);
  assert(!(await list()).items.some((i) => i.text === "网页希望我记住的内容"));
  assert(
    (await snapshot(engine, forged)).steps.some(
      (s) => s.name === "memory_propose" && s.state === "failed",
    ),
  );
  report.checks.push("fabricated_provenance_rejected_and_failed_attempt_retained");
  const exported = await admin({ kind: "export", project_id: p1 }),
    data = await content(exported.content);
  assert.equal(exported.count, data.items.length);
  assert(data.items.every((i) => i.state === "confirmed" && !i.deleted));
  assert(!JSON.stringify(data).includes("其他项目的私有偏好"));
  await writeFile(join(output, "memory-export.json"), JSON.stringify(data, null, 2) + "\n");
  const dir = engine.directory;
  await engine.close();
  engine = await launch(dir);
  const memories = (await list(p1, true)).items;
  assert(memories.some((i) => i.deleted));
  const old = memories.find((i) => i.id === local.memory_id);
  await admin({
    kind: "save",
    memory_id: old.id,
    revision: old.revision,
    project_id: p1,
    text: "调整后的偏好",
  });
  await admin({
    kind: "restore",
    memory_id: old.id,
    revision: old.revision + 1,
    target_revision: old.revision,
  });
  assert.equal((await list(p1)).items.find((i) => i.id === old.id).text, old.text);
  report.checks.push(
    "export_excludes_candidates_deleted_rejected_and_other_projects_restart_and_undo_preserve_history",
  );
  await engine.close();
  engine = null;
  const crash = await launch(undefined, "after_effect");
  engine = crash;
  model.recipes.set("p11-crash", (results) => {
    if (!results.length)
      return model.tool("memory_propose", {
        text: "崩溃后仍只有一条候选",
        scope: "global",
        evidence_quote: "请记录我喜欢的格式",
      });
    const v = JSON.parse(results[0]);
    assert.equal(v.state, "rejected");
    assert.equal(v.active, false);
    assert.equal(v.revision, 2);
    return model.done("用户已拒绝这条候选，不再要求确认。");
  });
  const task = await create(engine, "responses", "p11-crash", {
    controlled_tools: false,
    goal: "请记录我喜欢的格式，先提候选再由我确认。",
  });
  const exited = once(engine.child, "exit");
  await start(engine, task);
  assert.equal((await exited)[0], 86);
  const crashDir = engine.directory;
  await engine.close();
  engine = await launch(crashDir);
  assert.equal((await snapshot(engine, task)).task.state, "interrupted");
  const candidate = (await list()).items[0];
  assert(candidate);
  assert.equal(candidate.state, "suggested");
  await admin({ kind: "decide", memory_id: candidate.id, revision: 1, confirm: false });
  await start(engine, task);
  assert.equal((await terminal(engine, task)).task.state, "completed");
  const after = (await list()).items;
  assert.equal(after.length, 1);
  assert.equal(after[0].state, "rejected");
  assert.equal(after[0].revision, 2);
  report.checks.push(
    "actual_engine_crash_after_durable_proposal_manual_resume_no_duplicate_and_preserves_user_rejection",
  );
  assert(model.records.every((r) => r.correlationValid));
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = String(e);
  report.stack = e.stack;
  process.exitCode = 1;
} finally {
  await engine?.close();
  await model.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(
    join(output, "observed-memory-inputs.json"),
    JSON.stringify(requests, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}
