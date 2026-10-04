import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useWords } from "./workspaceClient";
import { UpdateBackupPanel } from "./UpdateBackupPanel";
import type { MaintenanceProgress } from "./MaintenanceStatus";

type UpdatePreview = {
  version: string;
  current_version: string;
  notes: string;
  bytes: number;
  files: number;
  fingerprint: string;
  key_id: string;
  application: string[];
  tools: string[];
  database_min: number;
  database_target: number;
  recovery?: { executable: string; instructions: string };
};
type UpdateStatus = {
  current_version: string;
  supported: boolean;
  last_update: null | {
    state: string;
    message: string;
    previous_install: string | null;
    previous_data: string | null;
    recovery_locations: { kind: string; path: string }[];
  };
};
export function UpdatePanel({ onMaintenance }: { onMaintenance: MaintenanceProgress }) {
  const tr = useWords();
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<UpdatePreview | null>(null);
  const [ready, setReady] = useState(false),
    [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    void invoke<UpdateStatus>("update_status")
      .then(setStatus)
      .catch((e) => setError(String(e)));
  }, []);
  const changed = (value: string) => {
    setSource(value);
    setPreview(null);
    setReady(false);
    setConfirmed(false);
  };
  async function choose() {
    try {
      const path = await invoke<string | null>("pick_update_package");
      if (path) changed(path);
    } catch (e) {
      setError(String(e));
    }
  }
  async function run(action: "inspect" | "prepare" | "install") {
    if (busy) return;
    setBusy(action);
    setError("");
    if (action === "inspect") {
      setPreview(null);
      setReady(false);
      setConfirmed(false);
    }
    try {
      if (action === "install") {
        await invoke("update_install", { fingerprint: preview?.fingerprint, confirmed });
      } else {
        const next = await invoke<UpdatePreview>("update_" + action, {
          source,
          fingerprint: preview?.fingerprint,
        });
        setPreview(next);
        setReady(action === "prepare");
        setConfirmed(false);
      }
    } catch (e) {
      setError(String(e));
      if (action !== "inspect") setReady(false);
    } finally {
      setBusy("");
    }
  }
  return (
    <section
      className="installation-panel"
      aria-label={tr("检查与安装更新", "Check and install updates")}
    >
      <h3>{tr("检查与安装更新", "Check and install updates")}</h3>
      <p>
        {tr("当前版本：", "Current version: ")}
        {status?.current_version ?? "…"}
      </p>
      <p>
        {tr(
          "由你主动检查和决定安装时间。支持本机签名更新包，或私有 HTTPS 更新源。",
          "Check and install only when you choose. Use a signed local package or a private HTTPS update source.",
        )}
      </p>
      <label>
        {tr("更新源或本机更新包", "Update source or local package")}
        <input
          value={source}
          disabled={!!busy}
          onChange={(e) => changed(e.target.value)}
          placeholder="https://…/WorkPilot.wpupdate"
        />
      </label>
      <div className="model-actions">
        <button disabled={!!busy} onClick={() => void choose()}>
          {tr("选择更新包", "Choose update package")}
        </button>
        <button
          disabled={!!busy || !source.trim() || status?.supported === false}
          onClick={() => void run("inspect")}
        >
          {tr("检查更新", "Check update")}
        </button>
      </div>
      {preview && (
        <div className="transfer-preview">
          <h4>
            {preview.current_version} → {preview.version}
          </h4>
          <p>{preview.notes}</p>
          <p>
            {preview.files} {tr("个文件", "files")} · {(preview.bytes / 1048576).toFixed(1)} MiB
          </p>
          <p>
            {tr("程序变更：", "Application changes: ")}
            {preview.application.join("、")}
          </p>
          <p>
            {tr("随包工具变更：", "Bundled tool changes: ")}
            {preview.tools.join("、") || tr("无", "None")}
          </p>
          <p>
            {tr(
              "第三方插件由技能与插件页面单独管理，本次不替换已安装插件。",
              "Installed third-party plugins remain managed separately in Skills and plugins.",
            )}
          </p>
          <p>
            {tr("签名已核验：", "Verified signing key: ")}
            {preview.key_id}
          </p>
          <button disabled={!!busy || ready} onClick={() => void run("prepare")}>
            {tr("下载并核验完整更新", "Prepare and verify full update")}
          </button>
        </div>
      )}
      {ready && (
        <div>
          <p>
            {tr(
              "新版已准备好。安装将停止正在执行的任务并退出软件，在本机保存原程序与完整数据副本，再检查新版的数据迁移。失败时恢复原程序和数据。完成后请手动重新打开，原任务不会自动续跑。",
              "The verified update is ready. Installation stops tasks and exits, keeps the previous app and full local data, then checks data migration. Failure restores both. Reopen manually; interrupted tasks will not resume automatically.",
            )}
          </p>
          {preview?.recovery && (
            <div className="update-recovery-entry">
              <h4>{tr("打不开软件时的恢复入口", "Recovery if the app cannot open")}</h4>
              <p>
                {tr(
                  "如果更新中断后原快捷方式打不开，双击下列工具并按提示恢复。它已保存在程序目录外，同位置还有文字说明。恢复不会自动执行任务。",
                  "If an interrupted update leaves the usual shortcut unavailable, double-click this recovery tool and follow its prompts. It is already saved outside the app folder, alongside written instructions. Recovery does not restart tasks.",
                )}
              </p>
              <p>{preview.recovery.executable}</p>
              <button
                disabled={!!busy}
                onClick={() =>
                  void invoke("update_open_recovery_folder").catch((e) => setError(String(e)))
                }
              >
                {tr("打开恢复工具所在文件夹", "Open recovery tool folder")}
              </button>
            </div>
          )}
          <label className="update-confirmation">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={!!busy}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {tr(
              "我确认停止任务、备份数据并立即安装",
              "I confirm stopping tasks, backing up data and installing now",
            )}
          </label>
          <button disabled={!!busy || !confirmed} onClick={() => void run("install")}>
            {tr("退出并安装更新", "Exit and install update")}
          </button>
        </div>
      )}
      {busy && (
        <p role="status">
          {tr(
            "正在核验更新，请稍候。准备期间可以继续其它任务。",
            "Verifying the update. Other tasks can continue while preparing.",
          )}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {status?.last_update && (
        <details>
          <summary>{tr("上次更新与保留副本", "Previous update and retained backups")}</summary>
          <p>{status.last_update.message}</p>
          {status.last_update.recovery_locations.map((item) => (
            <p key={item.path}>
              {
                (
                  {
                    previous_program: tr("更新前程序：", "Previous app: "),
                    previous_data: tr("更新前数据：", "Previous data: "),
                    discarded_program: tr("未采用的程序：", "Discarded app: "),
                    discarded_data: tr("未采用的数据：", "Discarded data: "),
                    staged_program: tr("暂存程序：", "Staged app: "),
                    staged_data: tr("暂存数据：", "Staged data: "),
                  } as Record<string, string>
                )[item.kind]
              }
              {item.path}
            </p>
          ))}
          {status.last_update.recovery_locations.length === 0 && (
            <p>{tr("没有保留的更新副本目录。", "No retained update copy directories.")}</p>
          )}
        </details>
      )}
      <UpdateBackupPanel onMaintenance={onMaintenance} />
      <small>
        {tr(
          "当前使用私有开发签名验证更新内容，尚未配置公开更新站点或 Windows 发布者证书。更新只访问你填写的地址，不上传项目、任务或密钥。",
          "Private development signatures protect update contents. No public update service or Windows publisher certificate is configured. Only the source you enter is contacted; projects, tasks and credentials are never uploaded.",
        )}
      </small>
    </section>
  );
}
