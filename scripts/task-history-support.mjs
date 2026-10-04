import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { until } from "./tool-test-support.mjs";

export const refused = (r) => assert(["error", "model_error"].includes(r.kind), JSON.stringify(r));
export async function project(engine, name, root_path, permission = "full_access") {
  await mkdir(root_path, { recursive: true });
  const r = await engine.request({
    kind: "workspace",
    action: {
      kind: "save_project",
      project_id: null,
      settings: {
        name,
        root_path,
        permission,
        default_profile_id: null,
        rules: "",
        revision: 0,
      },
    },
  });
  assert.equal(r.kind, "workspace", JSON.stringify(r));
  return r.data.project.id;
}
export async function wb(engine, task, action) {
  const r = await engine.request({ kind: "workbench", task_id: task, action });
  assert.equal(r.kind, "workbench", JSON.stringify(r));
  return r.data;
}
export const history = async (e, t) =>
  (await wb(e, t, { kind: "history", path: null, before: null, limit: 100 })).items;
export async function done(engine, task, operation, state = "completed") {
  return until(async () => {
    const r = (await wb(engine, task, { kind: "operations" })).items.find(
      (r) => r.operation.id === operation.id,
    )?.operation;
    if (r?.state === "failed" && state !== "failed") throw new Error(r.error);
    return r?.state === state && r;
  }, 20000);
}
export async function saveFile(engine, task, path, text) {
  const current = await wb(engine, task, { kind: "read_file", path });
  const r = await wb(engine, task, {
    kind: "edit",
    edit: { kind: "save", path, expected: current.version, text },
  });
  await done(engine, task, r.operation);
}
export async function archive(engine, action) {
  const r = await engine.request({ kind: "task_archive", action });
  assert.equal(r.kind, "workbench", JSON.stringify(r));
  return r.data;
}
export async function importArchive(engine, path, password) {
  const p = await archive(engine, { kind: "inspect", path, password });
  const r = await archive(engine, { kind: "import", path, password, fingerprint: p.fingerprint });
  return r.archive_id;
}
