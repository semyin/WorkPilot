import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { root } from "./cargo.mjs";
import { startExecutionFixture } from "../services/execution-fixtures/server.mjs";
const output = join(root, ".test-results/execution-engine");
await mkdir(output, { recursive: true });
const fixture = await startExecutionFixture();
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  service: "synthetic local HTTP only",
  checks: [],
};
const processes = [];
const empty = () => ({ supported: null, source: "unknown", checked_at_ms: null });
function profile(protocol, model) {
  return {
    id: crypto.randomUUID(),
    label: model,
    protocol,
    model,
    base_url: fixture.url,
    credential: null,
    auth: "none",
    supports_tools: true,
    supports_images: null,
    revision: 1,
    capabilities: {
      text: empty(),
      streaming: empty(),
      tools: { supported: true, source: "user", checked_at_ms: null },
      images: empty(),
      usage: empty(),
    },
    options: {
      max_output_tokens: 1024,
      temperature: null,
      reasoning_effort: null,
      chat_token_parameter: "max_completion_tokens",
      timeout_ms: 20000,
      idle_timeout_ms: 10000,
      anthropic_version: "2023-06-01",
    },
    pricing: null,
  };
}
async function until(check, timeout = 15000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(20);
  }
  throw new Error("Execution assertion timed out");
}
async function launch(directory, fault) {
  directory ||= await mkdtemp(join(output, "session-"));
  const child = spawn(
    process.env.WORKPILOT_ENGINE_BINARY ||
      join(root, "target/debug/workpilot-engine" + (process.platform === "win32" ? ".exe" : "")),
    ["--channel", "test", "--data-root", directory],
    {
      cwd: root,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, WORKPILOT_TEST_EXECUTION_CRASH: fault || "" },
    },
  );
  processes.push(child);
  const pending = new Map();
  const events = [];
  let stderr = "";
  child.stderr.on("data", (b) => {
    stderr += b;
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const wire = JSON.parse(line);
    if (wire.type === "reply") {
      const request = pending.get(wire.request_id);
      if (request) {
        clearTimeout(request.timer);
        pending.delete(wire.request_id);
        request.resolve(wire.response);
      }
    } else events.push(wire.event);
  });
  const request = (command, request_id = crypto.randomUUID()) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(request_id);
        reject(new Error("IPC reply timed out: " + command.kind + "; " + stderr));
      }, 10000);
      pending.set(request_id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ request_id, command }) + "\n");
    });
  await until(async () => events.some((e) => e.kind === "ready"));
  const close = async () => {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.stdin.end();
      await exited;
    }
    lines.close();
  };
  return { child, directory, request, events, close };
}
async function create(engine, protocol, model, extra = {}) {
  const p = profile(protocol, model);
  const saved = await engine.request({
    kind: "save_provider",
    profile: p,
    secret: null,
    clear_credential: false,
  });
  assert.equal(saved.kind, "provider_saved");
  const config = {
    title: model,
    goal: "Run the synthetic test " + model,
    constraints: ["Preserve original requirements"],
    project_rules: "",
    project_id: null,
    profile_id: p.id,
    mode: "execute",
    controlled_tools: true,
    limits: {
      max_steps: 32,
      max_duration_ms: 30000,
      context_bytes: 65536,
      max_result_bytes: 32768,
    },
    ...extra,
  };
  const result = await engine.request({ kind: "create_execution", config });
  assert.equal(result.kind, "receipt");
  return result.receipt.task_id;
}
async function snapshot(engine, task) {
  const r = await engine.request({ kind: "read", query: { kind: "execution", task_id: task } });
  assert.equal(r.kind, "execution");
  return r.snapshot;
}
async function start(engine, task) {
  const r = await engine.request({ kind: "start_execution", task_id: task });
  assert.equal(r.kind, "receipt", JSON.stringify(r));
}
async function terminal(engine, task) {
  return until(async () => {
    const s = await snapshot(engine, task);
    return ["completed", "failed", "interrupted", "awaiting_input"].includes(s.task.state) && s;
  });
}
try {
  let engine = await launch();
  for (const [protocol, model] of [
    ["chat_completions", "runtime-sum"],
    ["responses", "runtime-words"],
    ["messages", "runtime-product"],
  ]) {
    const task = await create(engine, protocol, model);
    await start(engine, task);
    const s = await terminal(engine, task);
    assert.equal(s.task.state, "completed", JSON.stringify(s.latest_run));
    assert.equal(s.steps.filter((s) => s.kind === "tool" && s.state === "completed").length, 3);
    report.checks.push(protocol + "_http_model_tool_result_loop");
  }
  const failed = await create(engine, "responses", "runtime-error");
  const before = fixture.records.length;
  await start(engine, failed);
  const error = await terminal(engine, failed);
  assert.equal(error.task.state, "failed");
  assert.equal(error.latest_run.diagnostic.code, "rate_limit");
  assert.equal(fixture.records.length, before + 1);
  report.checks.push("model_error_one_request_no_fallback");
  const holds = [];
  const count = fixture.records.length;
  for (let i = 0; i < 6; i++) {
    const task = await create(engine, "responses", "runtime-hold");
    holds.push(task);
    await start(engine, task);
  }
  await until(async () => fixture.records.length >= count + 4);
  assert.equal(fixture.records.length, count + 4);
  const states = await Promise.all(holds.map((t) => snapshot(engine, t)));
  assert.equal(states.filter((s) => s.task.state === "running").length, 4);
  assert.equal(states.filter((s) => s.task.state === "queued").length, 2);
  const pingAt = performance.now();
  assert.equal((await engine.request({ kind: "ping" })).kind, "receipt");
  report.controlReplyMs = performance.now() - pingAt;
  assert(report.controlReplyMs < 1000);
  // Cancel queued tasks before releasing slots so they cannot start accidentally.
  for (const task of [...holds.slice(4), ...holds.slice(0, 4)])
    await engine.request({ kind: "cancel", task_id: task });
  for (const task of holds) assert.equal((await terminal(engine, task)).task.state, "interrupted");
  assert.equal(fixture.records.length, count + 4);
  report.checks.push("four_slots_fifo_queue_and_responsive_control");
  await engine.close();
  for (const scenario of ["before_tool", "during_tool", "after_effect", "user_reported"]) {
    const fault = scenario === "user_reported" ? "during_tool" : scenario;
    engine = await launch(undefined, fault);
    const task = await create(engine, "responses", "runtime-crash");
    const begin = fixture.records.length;
    const exited = once(engine.child, "exit");
    await start(engine, task);
    const [code] = await exited;
    assert.equal(code, 86);
    engine = await launch(engine.directory);
    const s = await snapshot(engine, task);
    assert.equal(s.task.state, "interrupted");
    await delay(100);
    assert.equal(fixture.records.length, begin + 1);
    const action = s.context.pending.action_ids[0];
    const row = s.steps.find((s) => s.id === action);
    assert.equal(row.state, fault === "before_tool" ? "prepared" : "needs_review");
    if (fault === "during_tool") {
      await start(engine, task);
      const review = await terminal(engine, task);
      assert.equal(review.latest_run.reason, "tool_result_needs_review");
      assert.equal(fixture.records.length, begin + 1);
      assert.equal(
        (
          await engine.request({
            kind: "resolve_execution_action",
            task_id: task,
            action_id: action,
            resolution:
              scenario === "user_reported"
                ? { kind: "applied", output: "User independently verified this synthetic result." }
                : { kind: "not_applied" },
          })
        ).kind,
        "receipt",
      );
    }
    await start(engine, task);
    const done = await terminal(engine, task);
    assert.equal(done.task.state, "completed", JSON.stringify(done.latest_run));
    assert.equal(fixture.records.length, begin + 2);
    assert.equal(
      done.steps.filter((s) => s.name === "sample_write" && s.state === "completed").length,
      1,
    );
    if (fault === "after_effect")
      assert(
        engine.events.some(
          (e) =>
            e.kind === "action_reconciled" &&
            e.source === "recovery" &&
            e.resolution_source === "receipt",
        ),
      );
    if (scenario === "user_reported")
      assert(
        engine.events.some((e) => e.kind === "action_reconciled" && e.resolution_source === "user"),
      );
    report.checks.push("real_process_exit_" + scenario + "_manual_recovery");
    await engine.close();
  }
  assert(fixture.records.every((r) => r.correlationValid));
  report.httpRequests = fixture.records;
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.error = String(error);
  process.exitCode = 1;
} finally {
  for (const child of processes) if (child.exitCode === null) child.kill();
  await fixture.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
