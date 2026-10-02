import { invoke } from "@tauri-apps/api/core";
import type { Command, Response, ContentRef } from "./generated/contracts";
export async function executionCommand(
  command: Command,
  english = localStorage.getItem("workpilot.language") === "en",
): Promise<Response> {
  const response = await invoke<Response>("engine_command", {
    request: { request_id: crypto.randomUUID(), command },
  });
  if (response.kind === "error") {
    const known: Record<string, [string, string]> = {
      conflict: [
        "内容或状态已变化，请重新打开后再操作。",
        "Content or state changed. Reopen and try again.",
      ],
      busy: [
        "任务或另一个操作仍在运行，请稍后重试。",
        "Work is still running. Try again after it finishes.",
      ],
      not_found: ["找不到这条记录，请刷新列表。", "Record not found. Refresh the list."],
      invalid_request: [
        "这项操作暂时不能执行，请检查输入和任务状态。",
        "This operation is unavailable. Check the input and task state.",
      ],
      storage: [
        "本机记录读写失败，请查看数据位置和可用空间。",
        "Local records could not be read or written. Check the data location and free space.",
      ],
    };
    throw new Error(
      (known[response.code]?.[english ? 1 : 0] || response.message) + "\n" + response.message,
    );
  }
  if (response.kind === "model_error")
    throw new Error(
      (english ? response.diagnostic.message_en : response.diagnostic.message_zh) +
        (response.diagnostic.detail ? "\n" + response.diagnostic.detail : ""),
    );
  return response;
}
export async function readExecutionContent(reference: ContentRef): Promise<string> {
  if (reference.bytes > 8 * 1024 * 1024) throw new Error("Saved content is too large");
  let text = "";
  let offset = 0;
  while (offset < reference.bytes) {
    const r = await executionCommand({
      kind: "read",
      query: { kind: "content", object_id: reference.object_id, offset, limit: 65536 },
    });
    if (r.kind !== "content" || r.page.next_offset <= offset)
      throw new Error("Saved content could not be read");
    text += r.page.text;
    offset = r.page.next_offset;
  }
  return text;
}
