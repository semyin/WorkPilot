// Explicit user-provided service test, isolated credentials and synthetic project files.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { root } from "./cargo.mjs";
import { launch, snapshot, start, until } from "./tool-test-support.mjs";
const directory = join(root, ".test-results/real-model-2026-10-02");
const entries = JSON.parse(await readFile(join(directory, "configuration.json"), "utf8"));
const engine = await launch(directory);
const report = {
  at: new Date().toISOString(),
  synthetic: false,
  service: "User-provided Alibaba Cloud workspace",
  checks: [],
};
try {
  for (const p of entries) {
    const permission = p.protocol === "responses" ? "auto_review" : "request_approval";
    const folder = join(directory, "tools-" + p.protocol + "-" + crypto.randomUUID());
    await mkdir(folder);
    await writeFile(join(folder, "values.json"), '{"values":[4,8,12]}');
    const config = {
      title: "真实文件工具验证 " + p.protocol,
      goal: "这是一项平台验收，操作当前授权目录里的测试文件。请依次读取 values.json，将里面三个数相加，把总和用 write_file 写入新的 answer.txt（内容只能是数字24，不带换行），然后用 read_file 回读，并用 register_artifact 登记 answer.txt。只做这些操作，不创建计划，不使用命令。最后中文简短报告实际结果。",
      constraints: ["只读写本任务已授权的测试目录"],
      project_rules: "",
      project_id: null,
      profile_id: p.id,
      mode: "execute",
      controlled_tools: false,
      limits: {
        max_steps: 24,
        max_duration_ms: 240000,
        context_bytes: 131072,
        max_result_bytes: 65536,
      },
    };
    const created = await engine.request({ kind: "create_execution", config });
    assert.equal(created.kind, "receipt");
    const task = created.receipt.task_id;
    assert.equal(
      (
        await engine.request({
          kind: "configure_task_tools",
          task_id: task,
          settings: {
            root_path: folder,
            permission,
            review_profile_id: p.id,
            commands_enabled: false,
            revision: 0,
          },
        })
      ).kind,
      "receipt",
    );
    await start(engine, task);
    let approvals = 0;
    const s = await until(async () => {
      const s = await snapshot(engine, task);
      if (s.task.state === "awaiting_approval") {
        const r = await engine.request({
          kind: "read",
          query: { kind: "task_tools", task_id: task },
        });
        const a = r.state.approvals.find((a) => a.state === "pending");
        assert(a);
        assert.equal(a.intent.tool, "write_file");
        assert.equal(a.intent.target, "answer.txt");
        assert.equal(a.intent.arguments.text, "24");
        assert.equal(a.intent.arguments.expected_sha256, null);
        // This is the concrete test write the user authorized. Never approve another effect.
        assert.equal(
          (
            await engine.request({
              kind: "decide_tool_approval",
              task_id: task,
              approval_id: a.id,
              fingerprint: a.fingerprint,
              approve: true,
            })
          ).kind,
          "receipt",
        );
        approvals++;
        await start(engine, task);
        return false;
      }
      return ["completed", "failed", "interrupted", "awaiting_input"].includes(s.task.state) && s;
    }, 270000);
    const r = await engine.request({ kind: "read", query: { kind: "task_tools", task_id: task } });
    const review = r.state.approvals.find((a) => a.intent.tool === "write_file");
    const actual = await readFile(join(folder, "answer.txt"), "utf8").catch(() => null);
    const result = {
      protocol: p.protocol,
      model: p.model,
      permission,
      state: s.task.state,
      reason: s.latest_run.reason,
      diagnostic: s.latest_run.diagnostic,
      actual_file: actual,
      task_id: task,
      manually_approved: approvals,
      review: review?.review,
      decided_by: review?.decided_by,
      changes: r.state.changes.length,
      text: s.context.last_text,
      steps: s.steps.map((s) => ({ name: s.name, state: s.state })),
    };
    report.checks.push(result);
    await writeFile(join(directory, "tools-report.json"), JSON.stringify(report, null, 2));
    assert.equal(s.task.state, "completed");
    assert.equal(actual, "24");
    assert.equal(r.state.changes.length, 1);
    assert(s.steps.some((s) => s.name === "register_artifact" && s.state === "completed"));
    if (permission === "auto_review") {
      assert.equal(approvals, 0);
      assert.equal(review.decided_by, "independent_model_review");
    }
    console.log(p.protocol + ": actual file read/write/readback/artifact passed; " + permission);
  }
  report.result = "passed";
} catch (e) {
  report.result = "failed";
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  await engine.close();
  await writeFile(join(directory, "tools-report.json"), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({ result: report.result, count: report.checks.length, error: report.error }),
  );
}
