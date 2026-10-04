import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { useWords } from "./workspaceClient";

export type MaintenanceProgress = (running: boolean) => void;

export function MaintenanceStatus({
  running,
  showRestart,
}: {
  running: boolean;
  showRestart: boolean;
}) {
  const tr = useWords();
  const [error, setError] = useState("");
  return (
    <main className="maintenance-status" aria-label={tr("维护状态", "Maintenance status")}>
      <h1>WorkPilot</h1>
      <h2>
        {running
          ? tr("正在处理维护操作", "Maintenance is running")
          : tr("维护流程已结束", "Maintenance has finished")}
      </h2>
      <p>
        {tr(
          "请在设置中查看处理结果，结束后重新启动 WorkPilot。工作台已暂停刷新，不会重新提交任务。",
          "Review the result in Settings, then restart WorkPilot. Workspace refresh is paused; no tasks are resubmitted.",
        )}
      </p>
      {showRestart && (
        <button
          disabled={running}
          onClick={() => void invoke("maintenance_restart").catch((e) => setError(String(e)))}
        >
          {tr("重新启动 WorkPilot", "Restart WorkPilot")}
        </button>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
