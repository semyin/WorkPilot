import assert from "node:assert/strict";
import { create, until } from "./tool-test-support.mjs";
export async function browserTask(
  engine,
  folder,
  { permission = "full_access", model = "p08-browser", controlled = true } = {},
) {
  const task = await create(engine, "responses", model, { controlled_tools: controlled });
  const settings = {
    root_path: folder,
    permission,
    commands_enabled: false,
    review_profile_id: null,
    revision: 0,
  };
  assert.notEqual(
    (await engine.request({ kind: "configure_task_tools", task_id: task, settings })).kind,
    "error",
  );
  const raw = (action) => engine.request({ kind: "workbench", task_id: task, action });
  const wb = async (action) => {
    const r = await raw(action);
    assert.equal(r.kind, "workbench", JSON.stringify(r));
    return r.data;
  };
  const content = async (ref) => {
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
  };
  const finish = async (op, expected = "completed") => {
    const result = await until(async () => {
      const r = await wb({ kind: "operations" });
      return r.items.find(
        (v) =>
          v.operation.id === op.id &&
          ["completed", "failed", "cancelled", "interrupted"].includes(v.operation.state),
      )?.operation;
    }, 30000);
    assert.equal(result.state, expected, JSON.stringify(result));
    return result.output ? content(result.output) : result;
  };
  const approve = async (op) => {
    await wb({ kind: "approve", operation_id: op.id, fingerprint: op.fingerprint });
    return finish(op);
  };
  const browser = async (action) => {
    const r = await wb({ kind: "browser", action });
    return r.operation
      ? r.operation.state === "awaiting_approval"
        ? approve(r.operation)
        : finish(r.operation)
      : r;
  };
  const control = (control) => wb({ kind: "browser_control", control });
  const snapshot = async (session_id, tab_id, query = null) =>
    until(async () => {
      try {
        return await browser({ kind: "snapshot", session_id, tab_id, query });
      } catch (e) {
        if (String(e).includes("Page navigated while reading")) return false;
        throw e;
      }
    });
  const navigate = async (session_id, tab_id, url) => {
    const page = await snapshot(session_id, tab_id);
    await browser({ kind: "navigate", session_id, tab_id, document: page.document, url });
    return until(async () => {
      try {
        const p = await snapshot(session_id, tab_id);
        return p.frames.some((f) => f.text) && p;
      } catch {
        return false;
      }
    }, 15000);
  };
  return {
    task,
    settings,
    raw,
    wb,
    browser,
    control,
    snapshot,
    navigate,
    approve,
    finish,
    content,
  };
}
export function element(page, match) {
  const e = page.frames.flatMap((f) => f.elements || []).find(match);
  assert(e, "Required element absent: " + JSON.stringify(page));
  return e;
}
