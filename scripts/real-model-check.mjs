// Explicitly invoked, user-configured real-service test. Never part of CI.
// Setup reads a single JSON object from stdin. The key goes to WorkPilot's
// system credential store, not this script's files or reports.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { root } from "./cargo.mjs";
const directory = join(root, ".test-results/real-model-2026-10-02");
await mkdir(directory, { recursive: true });
let setup;
if (process.argv.includes("--setup")) {
  let input = "";
  for await (const b of process.stdin) input += b;
  setup = JSON.parse(input);
  input = "";
}
const child = spawn(
  join(root, "target/debug/workpilot-engine" + (process.platform === "win32" ? ".exe" : "")),
  ["--channel", "test", "--data-root", directory],
  { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
);
const pending = new Map();
const events = [];
let stderr = "";
child.stderr.on("data", (b) => {
  stderr += b;
});
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const w = JSON.parse(line);
  if (w.type === "reply") {
    const p = pending.get(w.request_id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(w.request_id);
      p.resolve(w.response);
    }
  } else events.push(w.event);
});
function request(command) {
  return new Promise((resolve, reject) => {
    const request_id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(request_id);
      reject(new Error("Local reply timed out"));
    }, 110000);
    pending.set(request_id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ request_id, command }) + "\n");
  });
}
async function until(check, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const r = await check();
    if (r) return r;
    await delay(100);
  }
  throw new Error("Test timed out");
}
async function content(ref) {
  let text = "",
    offset = 0;
  while (offset < ref.bytes) {
    const r = await request({
      kind: "read",
      query: { kind: "content", object_id: ref.object_id, offset, limit: 65536 },
    });
    if (r.kind !== "content") throw new Error("Content unavailable");
    text += r.page.text;
    offset = r.page.next_offset;
  }
  return JSON.parse(text);
}
const report = {
  at: new Date().toISOString(),
  service: "User-provided Alibaba Cloud workspace",
  synthetic: false,
  checks: [],
};
try {
  await until(async () => events.some((e) => e.kind === "ready"), 15000);
  if (setup) {
    const entries = [];
    for (const protocol of ["chat_completions", "responses", "messages"]) {
      const id = "real-aliyun-" + protocol;
      const catalog = await request({ kind: "read", query: { kind: "profiles" } });
      const existing = catalog.catalog.profiles.find((x) => x.profile.id === id)?.profile;
      const profile = {
        ...existing,
        id,
        label: "阿里云真实验证 " + protocol,
        protocol,
        base_url:
          setup.origin + (protocol === "messages" ? "/apps/anthropic/v1" : "/compatible-mode/v1"),
        model: setup.model,
        credential: existing?.credential || null,
        auth: protocol === "messages" ? "api_key" : "bearer",
        supports_tools: null,
        supports_images: null,
        revision: existing?.revision || 1,
        options: {
          max_output_tokens: 4096,
          temperature: null,
          reasoning_effort: null,
          chat_token_parameter: "max_tokens",
          timeout_ms: 90000,
          idle_timeout_ms: 30000,
          anthropic_version: "2023-06-01",
        },
      };
      const r = await request({
        kind: "save_provider",
        profile,
        secret: setup.key,
        clear_credential: false,
      });
      if (r.kind !== "provider_saved")
        throw new Error("Could not save test configuration: " + JSON.stringify(r));
      entries.push({ id, protocol, base_url: profile.base_url, model: profile.model });
    }
    await writeFile(join(directory, "configuration.json"), JSON.stringify(entries, null, 2));
    setup.key = "";
    setup = null;
  }
  const entries = JSON.parse(await readFile(join(directory, "configuration.json"), "utf8"));
  if (process.argv.includes("--cleanup")) {
    const r = await request({ kind: "read", query: { kind: "profiles" } });
    for (const p of r.catalog.profiles) {
      const cleared = await request({
        kind: "save_provider",
        profile: p.profile,
        secret: null,
        clear_credential: true,
      });
      if (cleared.kind !== "provider_saved") throw new Error("Credential cleanup failed");
    }
    report.checks.push({ kind: "credential_cleanup", result: "passed" });
  } else {
    for (const p of entries) {
      const result = { protocol: p.protocol, model: p.model, endpoint: p.base_url, checks: [] };
      for (const mode of process.argv.includes("--image-only")
        ? ["image"]
        : ["text", "tools", "image"]) {
        const started = await request({
          kind: "start_model_probe",
          profile_id: p.id,
          task_id: null,
          agent_id: null,
          mode,
          prompt: mode === "text" ? "Only reply WorkPilot_REAL_OK." : "",
        });
        if (started.kind !== "model_started") {
          result.checks.push({ mode, result: "failed", diagnostic: started.diagnostic });
          break;
        }
        const call = await until(async () => {
          const r = await request({ kind: "read", query: { kind: "model_calls", limit: 64 } });
          return r.calls.find((c) => c.id === started.call.id && c.state !== "running");
        });
        const output = call.output ? await content(call.output) : null;
        result.checks.push({ mode, state: call.state, diagnostic: call.diagnostic, output });
        if (call.state !== "completed") break;
      }
      if (result.checks.some((c) => c.mode === "tools" && c.state === "completed")) {
        const config = {
          title: "真实多轮验证 " + p.protocol,
          goal: "这是平台功能验收，只操作内置样本。请严格依次调用 sample_lookup 读取 numbers，调用 sample_calculate 求和，将真实计算结果用 sample_write 保存为 real-sum，然后 sample_read 回读确认。不要使用 update_plan。最后中文说明计算结果和保存回读结果。不需要创建真实文件。",
          constraints: ["仅操作内置样本，不操作外部业务"],
          project_rules: "",
          project_id: null,
          profile_id: p.id,
          mode: "execute",
          controlled_tools: true,
          limits: {
            max_steps: 24,
            max_duration_ms: 240000,
            context_bytes: 131072,
            max_result_bytes: 65536,
          },
        };
        const created = await request({ kind: "create_execution", config });
        if (created.kind !== "receipt") throw new Error("Task creation failed");
        const task_id = created.receipt.task_id;
        await request({ kind: "start_execution", task_id });
        const s = await until(async () => {
          const r = await request({ kind: "read", query: { kind: "execution", task_id } });
          return (
            ["completed", "failed", "interrupted", "awaiting_input"].includes(
              r.snapshot.task.state,
            ) && r.snapshot
          );
        }, 250000);
        result.execution = {
          state: s.task.state,
          reason: s.latest_run.reason,
          diagnostic: s.latest_run.diagnostic,
          text: s.context.last_text,
          tools: s.steps
            .filter((t) => t.kind === "tool")
            .map((t) => ({ name: t.name, state: t.state })),
          task_id,
        };
      }
      if (
        result.checks.some((c) => c.state !== "completed") ||
        (!process.argv.includes("--image-only") &&
          (result.execution?.state !== "completed" ||
            !result.checks.find((c) => c.mode === "tools")?.output?.tool_calls?.length))
      ) {
        report.failed = true;
        process.exitCode = 1;
      }
      report.checks.push(result);
      await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
      console.log(JSON.stringify(result));
    }
  }
  report.finished = true;
} catch (e) {
  report.error = String(e).replaceAll(setup?.key || "NOT-A-KEY", "[REDACTED]");
  process.exitCode = 1;
} finally {
  const exit = once(child, "exit");
  child.stdin.end();
  await exit;
  lines.close();
  for (const p of pending.values()) clearTimeout(p.timer);
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      finished: report.finished,
      error: report.error,
      protocols: report.checks.length,
    }),
  );
}
