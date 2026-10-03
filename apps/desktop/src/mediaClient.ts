import { executionCommand } from "./executionClient";
import type { MediaAdmin, MediaAsset, WorkbenchAction } from "./generated/contracts";
export async function media<T>(task: string | null, action: MediaAdmin): Promise<T> {
  const reply = await executionCommand({ kind: "media", task_id: task, action });
  if (reply.kind !== "workbench") throw new Error("Unexpected file response");
  return reply.data as T;
}
export async function mediaWork<T>(task: string, action: WorkbenchAction): Promise<T> {
  const reply = await executionCommand({ kind: "workbench", task_id: task, action });
  if (reply.kind !== "workbench") throw new Error("Unexpected file response");
  return reply.data as T;
}
export async function upload(
  file: File,
  source: "file" | "drop" | "paste",
  progress: (text: string) => void,
  signal?: AbortSignal,
): Promise<MediaAsset> {
  if (!file.size || file.size > 32 * 1024 * 1024)
    throw new Error("文件须为 1 字节至 32 MiB / File size must be 1 byte to 32 MiB");
  const { upload_id } = await media<{ upload_id: string }>(null, {
    kind: "begin_upload",
    name: file.name,
    bytes: file.size,
    source,
  });
  const cancel = () => {
    void media(null, { kind: "cancel_upload", upload_id }).catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (let offset = 0; offset < file.size; offset += 512 * 1024) {
      signal?.throwIfAborted();
      const data = new Uint8Array(await file.slice(offset, offset + 512 * 1024).arrayBuffer());
      let binary = "";
      for (let n = 0; n < data.length; n += 8192)
        binary += String.fromCharCode(...data.subarray(n, n + 8192));
      await media(null, { kind: "upload_chunk", upload_id, offset, base64: btoa(binary) });
      progress(
        `${file.name} · ${Math.round((Math.min(file.size, offset + data.length) / file.size) * 100)}%`,
      );
    }
    progress(`${file.name} · 正在读取 / Reading`);
    signal?.throwIfAborted();
    return (await media<{ asset: MediaAsset }>(null, { kind: "finish_upload", upload_id })).asset;
  } catch (e) {
    await media(null, { kind: "cancel_upload", upload_id }).catch(() => {});
    throw e;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
export function attachmentMarkers(assets: MediaAsset[]) {
  return assets.map((a) => `\n[workpilot-file:${a.id}] ${a.name}`).join("");
}
