import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useWords } from "./workspaceClient";
import type { MaintenanceProgress } from "./MaintenanceStatus";
type Preview = {
  fingerprint: string;
  files: number;
  bytes: number;
  skipped: string[];
  items: { path: string; files: number; bytes: number; retained_exports: number }[];
};
export function UpdateBackupPanel({ onMaintenance }: { onMaintenance: MaintenanceProgress }) {
  const tr = useWords();
  const [preview, setPreview] = useState<Preview | null>(null),
    [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [stopped, setStopped] = useState(false),
    [done, setDone] = useState(false);
  async function inspect() {
    setBusy(true);
    setError("");
    setConfirmation("");
    try {
      setPreview(await invoke<Preview>("update_backups_preview"));
    } catch (e) {
      setError(String(e));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!preview || confirmation !== "DELETE") return;
    setBusy(true);
    setError("");
    setStopped(true);
    onMaintenance(true);
    try {
      await invoke("update_backups_delete", { fingerprint: preview.fingerprint, confirmation });
      setDone(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      onMaintenance(false);
    }
  }
  return (
    <section aria-label={tr("更新恢复副本管理", "Update recovery copies")}>
      <h4>{tr("更新恢复副本管理", "Update recovery copies")}</h4>
      <p>
        {tr(
          "更新前的旧程序和旧数据默认保留在本机。这里可预览并永久删除已经完成或回滚的更新副本。当前程序、当前数据、系统凭据和用户导出包会保留。",
          "Previous app and data copies are kept locally. Preview and permanently delete copies from completed or rolled-back updates here. The current app/data, system credentials and exported archives are retained.",
        )}
      </p>
      <button disabled={busy || stopped} onClick={() => void inspect()}>
        {tr("预览恢复副本清理", "Preview recovery cleanup")}
      </button>
      {preview && (
        <div className="transfer-preview">
          <p>
            {preview.files} {tr("个文件", "files")} · {(preview.bytes / 1048576).toFixed(1)} MiB
          </p>
          {preview.items.map((item) => (
            <details key={item.path}>
              <summary>{item.path}</summary>
              <p>
                {item.files}{" "}
                {tr("个待删除文件；保留导出包：", "files to remove; retained exports: ")}
                {item.retained_exports}
              </p>
            </details>
          ))}
          {preview.skipped.map((text) => (
            <p key={text}>{text}</p>
          ))}
          {preview.files > 0 && !stopped && (
            <>
              <p>
                {tr(
                  "确认后会先停止所有任务。删除后不能再用这些副本恢复；当前任务数据仍保留。请输入 DELETE 确认。",
                  "Confirmation stops all tasks first. Removed copies can no longer be used for recovery; current task data stays. Type DELETE to confirm.",
                )}
              </p>
              <label>
                {tr("确认删除恢复副本", "Confirm recovery copy deletion")}
                <input
                  value={confirmation}
                  disabled={busy}
                  onChange={(e) => setConfirmation(e.target.value)}
                />
              </label>
              <button disabled={busy || confirmation !== "DELETE"} onClick={() => void remove()}>
                {tr("停止任务并删除这些副本", "Stop tasks and delete these copies")}
              </button>
            </>
          )}
        </div>
      )}
      {busy && <p role="status">{tr("正在核对恢复副本…", "Checking recovery copies…")}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {stopped && !busy && (
        <p>
          {done
            ? tr(
                "恢复副本已清理。请关闭并重新打开 WorkPilot 后继续使用。",
                "Recovery copies removed. Close and reopen WorkPilot to continue.",
              )
            : tr(
                "执行器已停止，请重新打开 WorkPilot 核对结果。",
                "The engine is stopped. Reopen WorkPilot to check the result.",
              )}
        </p>
      )}
      {stopped && !busy && (
        <button onClick={() => void invoke("exit_app")}>
          {tr("关闭 WorkPilot", "Close WorkPilot")}
        </button>
      )}
    </section>
  );
}
