import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { savedContent } from "./p13-real-model-support.mjs";

export async function probe(ctx, spec, mode, result, promptOverride = null) {
  Object.assign(result, {
    requestedModel: spec.model,
    requestedFamily: spec.family,
    protocol: spec.protocol,
    mode,
  });
  const prompt =
    promptOverride ||
    (mode === "text"
      ? "Only reply exactly P13_REAL_TEXT_OK."
      : mode === "image"
        ? "Identify the dominant color of the attached image. Reply only the English color word in lowercase."
        : "Call workpilot_echo once with message exactly WorkPilot. Do not do other work.");
  result.prompt = prompt;
  const started = await ctx.request({
    kind: "start_model_probe",
    profile_id: spec.id,
    task_id: null,
    agent_id: null,
    mode,
    prompt,
  });
  assert.equal(started.kind, "model_started", ctx.redact(started));
  result.callId = started.call.id;
  const deadline = Date.now() + 140000;
  let call;
  while (Date.now() < deadline) {
    const r = await ctx.request({ kind: "read", query: { kind: "model_calls", limit: 64 } });
    assert.equal(r.kind, "model_calls");
    call = r.calls.find((c) => c.id === started.call.id);
    if (call && call.state !== "running") break;
    await delay(250);
  }
  if (!call || call.state === "running") {
    await ctx.request({ kind: "cancel_model_probe", call_id: started.call.id }).catch(() => {});
    throw new Error("Probe reached the explicit test timeout; no retry was made");
  }
  const output = await savedContent(ctx, call.output);
  Object.assign(result, {
    callState: call.state,
    startedAtMs: call.started_at_ms,
    endedAtMs: call.ended_at_ms,
    actualReportedModel: output?.actual_model ?? null,
    diagnostic: call.diagnostic,
    finishReason: output?.finish_reason ?? null,
    output,
  });
  assert.equal(call.state, "completed", ctx.redact(call.diagnostic));
  assert(output?.actual_model, "The service did not identify the model used");
  if (mode === "text") assert.equal(output.text.trim(), "P13_REAL_TEXT_OK");
  if (mode === "tools") {
    assert.equal(output.tool_calls.length, 1);
    assert.equal(output.tool_calls[0].name, "workpilot_echo");
    assert.deepEqual(output.tool_calls[0].arguments, { message: "WorkPilot" });
    result.scope =
      "Real model returned a complete tool proposal; this diagnostic does not execute that tool.";
  }
  if (mode === "image") {
    assert.match(output.text.trim(), /^(blue|蓝色?)[.!。]?$/i);
    result.scope =
      "Built-in 64x64 solid blue PNG input only; not OCR, document vision or image generation.";
  }
}
