import assert from "node:assert/strict";
export async function media(request, task, action) {
  const r = await request({ kind: "media", task_id: task, action });
  assert.equal(r.kind, "workbench", JSON.stringify(r));
  return r.data;
}
export async function uploadMedia(request, task, name, bytes) {
  const { upload_id } = await media(request, null, {
    kind: "begin_upload",
    name,
    bytes: bytes.length,
    source: "file",
  });
  for (let offset = 0; offset < bytes.length; offset += 512 * 1024)
    await media(request, null, {
      kind: "upload_chunk",
      upload_id,
      offset,
      base64: bytes.subarray(offset, offset + 512 * 1024).toString("base64"),
    });
  const { asset } = await media(request, null, { kind: "finish_upload", upload_id });
  await media(request, task, { kind: "bind", asset_ids: [asset.id] });
  return { ...asset, task_id: task };
}
export async function configureMediaTask(request, task, folder, permission = "request_approval") {
  const old = await request({ kind: "read", query: { kind: "task_tools", task_id: task } });
  const r = await request({
    kind: "configure_task_tools",
    task_id: task,
    settings: {
      ...old.state.policy.settings,
      root_path: folder,
      permission,
      commands_enabled: false,
    },
  });
  assert.notEqual(r.kind, "error", JSON.stringify(r));
}
export async function transferMedia(request, task, action) {
  const r = await request({ kind: "media_transfer", task_id: task, action });
  assert.equal(r.kind, "workbench", JSON.stringify(r));
  return r.data;
}
