import { useEffect, useState } from "react";
import type { Task } from "../generated/contracts";
import { executionCommand } from "../executionClient";
import { useWords } from "../workspaceClient";
import { Dialog } from "./Dialog";

export function TaskDeleteDialog({
  task,
  onClose,
  onDeleted,
}: {
  task: Task;
  onClose: () => void;
  onDeleted: (ids: string[]) => void;
}) {
  const tr = useWords();
  const [ids, setIds] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    void executionCommand({ kind: "read", query: { kind: "team", task_id: task.id } })
      .then((result) => {
        if (disposed) return;
        if (result.kind !== "team" || result.view.root_task_id !== task.id)
          throw new Error(
            tr("请从主任务删除整组协作记录。", "Delete the group from its main task."),
          );
        setIds([task.id, ...result.view.members.map((member) => member.task_id)]);
      })
      .catch((error) => {
        if (!disposed) setError(String(error));
      });
    return () => {
      disposed = true;
    };
  }, [task.id]);
  const remove = async () => {
    if (!ids || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await executionCommand({ kind: "delete_task", task_id: task.id });
      if (result.kind !== "receipt" || result.receipt.status !== "completed")
        throw new Error(tr("删除尚未完成，请重试。", "Deletion did not complete. Try again."));
      onDeleted(ids);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      className="wb-delete-dialog"
      title={tr("删除任务", "Delete task")}
      onClose={onClose}
      busy={busy}
    >
      <p className="wb-delete-title">{task.title}</p>
      <p className="wb-description">
        {tr(
          "将永久删除此任务的对话、附件记录和执行历史，无法撤销。项目文件夹和已生成的实际文件会保留。",
          "Permanently delete this task’s conversation, attachment records and execution history. This cannot be undone. The project folder and generated files are kept.",
        )}
      </p>
      {ids && ids.length > 1 && (
        <p className="wb-description">
          {tr(
            `同时删除该任务的 ${ids.length - 1} 个协作助手记录。`,
            `Also delete the records of its ${ids.length - 1} collaborating assistants.`,
          )}
        </p>
      )}
      {!ids && !error && <p className="wb-description">{tr("正在核对任务…", "Checking task…")}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="wb-dialog-actions">
        <button type="button" autoFocus disabled={busy} onClick={onClose}>
          {tr("取消", "Cancel")}
        </button>
        <button
          type="button"
          className="wb-danger-button"
          disabled={busy || !ids}
          onClick={() => void remove()}
        >
          {busy ? tr("正在删除…", "Deleting…") : tr("删除任务", "Delete task")}
        </button>
      </div>
    </Dialog>
  );
}
