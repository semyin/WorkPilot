import { useState } from "react";
import { useWords } from "../workspaceClient";
import { taskArchive } from "./client";

export type RestoredAttachment = {
  source_task_id: string;
  name: string;
  bytes: number;
  removed: boolean;
  media_type: string;
  units: number;
  warnings: string[];
};

export function AttachmentSummary({
  attachments,
  tasks = [],
}: {
  attachments?: RestoredAttachment[];
  tasks?: { task_id: string; title: string }[];
}) {
  const tr = useWords();
  if (!attachments?.length) return null;
  return (
    <section aria-label={tr("随任务恢复的附件", "Attachments restored with tasks")}>
      <h4>{tr("随任务恢复的附件", "Attachments restored with tasks")}</h4>
      <p>
        {tr(
          "原文件已重新核验。每个附件仍属于原来的任务；未发送的附件仍需发送后才能交给模型，已移除的附件不会重新启用。项目文件的位置只保留为来源说明。",
          "Original files have been verified again. Each attachment stays with its task. Unsent attachments still need to be sent to reach the model; removed attachments stay removed. Project paths are retained only as provenance.",
        )}
      </p>
      <ul>
        {attachments.map((a, i) => (
          <li key={i}>
            <strong>{a.name}</strong> · {(a.bytes / 1024).toFixed(1)} KiB · {a.media_type}
            {tasks.length > 0 && <> · {tasks.find((t) => t.task_id === a.source_task_id)?.title}</>}
            {a.removed && <> · {tr("已移除，保留历史", "Removed; history preserved")}</>}
            {a.warnings.map((warning, j) => (
              <p key={j}>{warning}</p>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CancelArchive() {
  const tr = useWords();
  const [requested, setRequested] = useState(false);
  const [message, setMessage] = useState("");
  return (
    <div>
      <button
        disabled={requested}
        onClick={() => {
          setRequested(true);
          void taskArchive<{ cancel_requested: boolean }>({ kind: "cancel" })
            .then((r) => {
              setMessage(
                r.cancel_requested
                  ? tr(
                      "正在停止，请等待当前操作结束。",
                      "Stopping; waiting for the current operation to finish.",
                    )
                  : tr(
                      "当前操作已结束或尚未开始。",
                      "The operation has finished or has not started.",
                    ),
              );
            })
            .catch((e) => {
              setMessage(String(e));
              setRequested(false);
            });
        }}
      >
        {tr("取消档案操作", "Cancel archive operation")}
      </button>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
