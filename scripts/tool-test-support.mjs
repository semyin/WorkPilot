import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { root } from "./cargo.mjs";
import { startExecutionFixture } from "../services/execution-fixtures/server.mjs";
const output = join(root, ".test-results/tools-engine");
await mkdir(output, { recursive: true });
let fixture = { url: "http://127.0.0.1:1" };
export function setFixture(value) {
  fixture = value;
}
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
      const timer = setTimeout(
        () => {
          pending.delete(request_id);
          reject(new Error("IPC reply timed out: " + command.kind + "; " + stderr));
        },
        (command.kind === "media" && ["preview", "finish_upload"].includes(command.action?.kind)) ||
          command.kind === "inspect_installation" ||
          command.kind === "history_transfer" ||
          command.kind === "file_transfer" ||
          command.kind === "media_transfer" ||
          command.kind === "task_archive" ||
          command.kind === "migration" ||
          command.kind === "project_transfer" ||
          command.kind === "extension_transfer"
          ? 120000
          : 10000,
      );
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
    return (
      ["completed", "failed", "interrupted", "awaiting_input", "awaiting_approval"].includes(
        s.task.state,
      ) && s
    );
  });
}

export { launch, profile, create, snapshot, start, terminal, until, processes, output };
