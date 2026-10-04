import assert from "node:assert/strict";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const serviceOrigin = "https://ws-ky8utskqnjn8b091.cn-beijing.maas.aliyuncs.com";
export const plannedModels = [
  {
    id: "p13-qwen-chat",
    family: "Qwen",
    model: "qwen3.8-flash",
    protocol: "chat_completions",
    modes: ["text", "tools", "image"],
  },
  {
    id: "p13-qwen-responses",
    family: "Qwen",
    model: "qwen3.8-flash",
    protocol: "responses",
    modes: ["text", "tools", "image"],
  },
  {
    id: "p13-qwen-messages",
    family: "Qwen",
    model: "qwen3.8-flash",
    protocol: "messages",
    modes: ["text", "tools", "image"],
  },
  {
    id: "p13-glm-chat",
    family: "GLM",
    model: "glm-5.3",
    protocol: "chat_completions",
    modes: ["tools"],
  },
  {
    id: "p13-deepseek-chat",
    family: "DeepSeek",
    model: "deepseek-v4.1-flash",
    protocol: "chat_completions",
    modes: ["tools"],
  },
];

export async function inputConfiguration() {
  const buffers = [];
  let bytes = 0;
  try {
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 65536) throw new Error("Credential input exceeded its limit");
      buffers.push(Buffer.from(chunk));
    }
    const all = Buffer.concat(buffers);
    let value;
    try {
      value = JSON.parse(all.toString("utf8").replace(/^\uFEFF/, ""));
    } catch {
      throw new Error("Invalid private input configuration");
    } finally {
      all.fill(0);
    }
    if (typeof value.key !== "string" || value.key.length < 12 || value.origin !== serviceOrigin)
      throw new Error("Expected the explicitly authorized service and a credential on stdin");
    return value;
  } finally {
    buffers.forEach((b) => b.fill(0));
  }
}

export function redactor(secret) {
  return (value) => {
    const text =
      typeof value === "string"
        ? value
        : JSON.stringify(
            value,
            (key, value) =>
              ["credential", "credential_ref", "credential_id", "secret", "authorization"].includes(
                key,
              )
                ? "[excluded]"
                : value,
            2,
          );
    return (text ?? String(value))
      .replaceAll(secret, "[REDACTED]")
      .replaceAll(serviceOrigin, "https://<workspace>.cn-beijing.maas.aliyuncs.com");
  };
}

export function provider(spec) {
  const unknown = () => ({ supported: null, source: "unknown", checked_at_ms: null });
  return {
    id: spec.id,
    label: "P13 real acceptance " + spec.id,
    protocol: spec.protocol,
    model: spec.model,
    base_url:
      serviceOrigin + (spec.protocol === "messages" ? "/apps/anthropic/v1" : "/compatible-mode/v1"),
    credential: null,
    auth: spec.protocol === "messages" ? "api_key" : "bearer",
    supports_tools: null,
    supports_images: null,
    revision: 1,
    capabilities: {
      text: unknown(),
      streaming: unknown(),
      tools: unknown(),
      images: unknown(),
      usage: unknown(),
    },
    options: {
      max_output_tokens: 8192,
      temperature: null,
      reasoning_effort: null,
      chat_token_parameter: "max_tokens",
      timeout_ms: 120000,
      idle_timeout_ms: 60000,
      anthropic_version: "2023-06-01",
    },
    pricing: null,
  };
}

export async function savedContent(ctx, reference) {
  if (!reference) return null;
  assert(reference.bytes <= 8 * 1024 * 1024, "The requested test evidence is too large");
  let text = "",
    offset = 0;
  while (offset < reference.bytes) {
    const r = await ctx.request({
      kind: "read",
      query: { kind: "content", object_id: reference.object_id, offset, limit: 65536 },
    });
    assert.equal(r.kind, "content");
    assert(r.page.next_offset > offset, "Content page did not advance");
    text += r.page.text;
    offset = r.page.next_offset;
  }
  return JSON.parse(text);
}

export async function snapshot(ctx, task_id) {
  const r = await ctx.request({ kind: "read", query: { kind: "execution", task_id } });
  assert.equal(r.kind, "execution");
  return r.snapshot;
}

export async function waitTask(ctx, task, timeoutMs, approval, stopOnInput = false) {
  const deadline = Date.now() + timeoutMs;
  let nextProgress = 0;
  while (Date.now() < deadline) {
    const s = await snapshot(ctx, task);
    if (s.task.state === "awaiting_approval" && approval) await approval(s);
    else if (
      ["completed", "failed", "interrupted", "awaiting_approval"].includes(s.task.state) ||
      (s.task.state === "awaiting_input" && (s.context.question || stopOnInput))
    )
      return s;
    if (Date.now() >= nextProgress) {
      console.log(JSON.stringify({ waiting: task, state: s.task.state }));
      nextProgress = Date.now() + 15000;
    }
    await delay(250);
  }
  await ctx.request({ kind: "cancel", task_id: task }).catch(() => {});
  throw new Error("Real-model scenario reached its explicit time budget; no retry was made");
}

export async function traceTask(ctx, task) {
  const s = await snapshot(ctx, task);
  const steps = [];
  for (const step of s.steps) {
    const input = await savedContent(ctx, step.input);
    const output = await savedContent(ctx, step.output);
    steps.push({ ...step, input, output });
  }
  const trace = {
    task: s.task,
    state: s.task.state,
    latestRun: s.latest_run,
    text: s.context.last_text,
    steps,
  };
  ctx.traces[task] = trace;
  return trace;
}

export async function createTask(
  ctx,
  spec,
  title,
  goal,
  folder,
  permission = "full_access",
  options = {},
) {
  const created = await ctx.request({
    kind: "create_execution",
    config: {
      title,
      goal,
      constraints: options.constraints || [
        "Only the deliberately prepared files in this isolated project; no commands, browser, plugins, external business or further delegation by members",
      ],
      project_rules:
        options.projectRules ||
        "Use the requested file and team tools only. Do not read or change other directories. Do not claim an unverified result.",
      project_id: options.projectId || null,
      profile_id: spec.id,
      mode: options.mode || "execute",
      controlled_tools: false,
      limits: {
        max_steps: 96,
        max_duration_ms: 900000,
        context_bytes: 262144,
        max_result_bytes: 65536,
      },
    },
  });
  assert.equal(created.kind, "receipt");
  const task = created.receipt.task_id;
  ctx.roots.add(task);
  await ctx.request({
    kind: "configure_task_tools",
    task_id: task,
    settings: {
      root_path: folder,
      permission,
      commands_enabled: false,
      review_profile_id: permission === "auto_review" ? spec.id : null,
      revision: 0,
    },
  });
  return task;
}

export function modelCalls(trace, spec) {
  return trace.steps
    .filter((s) => s.kind === "model")
    .map((s) => ({
      stepId: s.id,
      state: s.state,
      startedAtMs: s.started_at_ms,
      endedAtMs: s.ended_at_ms,
      requestedModel: spec.model,
      protocol: spec.protocol,
      requestedFamily: spec.family,
      actualModel: s.output?.actual_model ?? null,
      finishReason: s.output?.finish_reason ?? null,
      usage: s.output?.usage ?? null,
    }));
}

export async function scanPlaintext(directory, secret) {
  const needles = [Buffer.from(secret, "utf8"), Buffer.from(secret, "utf16le")];
  const findings = [];
  let count = 0;
  const walk = async (folder) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error("A test output unexpectedly contains a link");
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const bytes = await readFile(path);
        count++;
        if (needles.some((n) => bytes.includes(n))) findings.push(relative(directory, path));
      }
    }
  };
  try {
    await walk(directory);
    return { filesChecked: count, plaintextCredentialFound: !!findings.length, findings };
  } finally {
    needles.forEach((b) => b.fill(0));
  }
}

export async function saveEvidence(ctx, name, value) {
  const text = ctx.redact(value);
  await writeFile(join(ctx.directory, name), text + "\n", { encoding: "utf8" });
}
