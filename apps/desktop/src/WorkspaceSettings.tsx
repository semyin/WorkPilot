import { useEffect, useState } from "react";
import type {
  WorkspacePreferences,
  SchedulerSettings,
  DefaultToolSettings,
  PermissionMode,
} from "./generated/contracts";
import { executionCommand } from "./executionClient";
import { useWords } from "./workspaceClient";
import { InstallationPanel } from "./InstallationPanel";
import { BrowserSetupPanel } from "./BrowserSetupPanel";
import { ProjectTransferPanel } from "./ProjectTransferPanel";
export function WorkspaceSettings({
  preferences,
  scheduler,
  dataDir,
  onPreferences,
  onModels,
  onClose,
}: {
  preferences: WorkspacePreferences;
  scheduler: SchedulerSettings;
  dataDir: string;
  onPreferences: (p: WorkspacePreferences) => Promise<void>;
  onModels: () => void;
  onClose: () => void;
}) {
  const tr = useWords();
  const [draft, setDraft] = useState(preferences);
  const [parallel, setParallel] = useState(scheduler.max_running);
  const [defaults, setDefaults] = useState<DefaultToolSettings | null>(null);
  const [originalDefaults, setOriginalDefaults] = useState<DefaultToolSettings | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void executionCommand({ kind: "read", query: { kind: "tool_defaults" } })
      .then((r) => {
        if (r.kind === "tool_defaults") {
          setDefaults(r.settings);
          setOriginalDefaults(r.settings);
        }
      })
      .catch((e) => setError(String(e)));
  }, []);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      if (parallel !== scheduler.max_running)
        await executionCommand({
          kind: "configure_scheduler",
          settings: { max_running: parallel, revision: scheduler.revision },
        });
      if (defaults && defaults.permission !== originalDefaults?.permission) {
        await executionCommand({ kind: "configure_tool_defaults", settings: defaults });
        const updated = await executionCommand({ kind: "read", query: { kind: "tool_defaults" } });
        if (updated.kind === "tool_defaults") {
          setDefaults(updated.settings);
          setOriginalDefaults(updated.settings);
        }
      }
      await onPreferences(draft);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="workspace-modal" role="dialog" aria-label={tr("设置", "Settings")}>
      <section>
        <h2>{tr("设置", "Settings")}</h2>
        <label>
          {tr("界面语言", "Language")}
          <select
            aria-label={tr("界面语言", "Language")}
            value={draft.language}
            onChange={(e) => setDraft({ ...draft, language: e.target.value })}
          >
            <option value="zh">简体中文</option>
            <option value="en">English</option>
          </select>
        </label>
        <label>
          {tr("外观", "Appearance")}
          <select
            aria-label={tr("外观", "Appearance")}
            value={draft.theme}
            onChange={(e) => setDraft({ ...draft, theme: e.target.value })}
          >
            <option value="system">{tr("跟随系统", "System")}</option>
            <option value="light">{tr("浅色", "Light")}</option>
            <option value="dark">{tr("深色", "Dark")}</option>
          </select>
        </label>
        <button onClick={onModels}>{tr("配置模型服务", "Configure model services")}</button>
        <label>
          {tr("同时运行的助手上限", "Concurrent assistant limit")}
          <input
            type="number"
            min={1}
            max={16}
            value={parallel}
            onChange={(e) => setParallel(Number(e.target.value))}
          />
        </label>
        {defaults && (
          <label>
            {tr("新任务默认权限", "Default task permission")}
            <select
              aria-label={tr("新任务默认权限", "Default task permission")}
              value={defaults.permission}
              onChange={(e) =>
                setDefaults({ ...defaults, permission: e.target.value as PermissionMode })
              }
            >
              <option value="request_approval">{tr("请求审批", "Request approval")}</option>
              <option value="auto_review">{tr("帮我批准", "Review for me")}</option>
              <option value="full_access">{tr("完全访问", "Full access")}</option>
            </select>
          </label>
        )}
        {defaults && defaults.permission !== originalDefaults?.permission && (
          <p>
            {tr(
              "修改全局权限会暂停正在运行的任务，并使旧审批失效。保存外观或语言不会暂停任务。",
              "Changing global permission pauses running tasks and expires old approvals. Appearance and language changes keep tasks running.",
            )}
          </p>
        )}
        <details>
          <summary>{tr("数据位置", "Data location")}</summary>
          <p>{dataDir}</p>
          <small>
            {tr(
              "记录保存在本机。文件与终端 → 修改历史可备份所选文件版本；完整资料迁移仍在开发，请保留原数据目录。",
              "Records stay on this computer. File workspace → History can back up selected revisions. Full data migration is still in development; keep the original data directory.",
            )}
          </small>
        </details>
        <details>
          <summary>{tr("项目设置与记忆迁移", "Project settings and memory transfer")}</summary>
          <ProjectTransferPanel />
        </details>
        <details>
          <summary>{tr("Chrome / Edge 连接设置", "Chrome / Edge connection setup")}</summary>
          <BrowserSetupPanel />
        </details>
        <details>
          <summary>{tr("浏览器、技能与插件", "Browser, skills and plugins")}</summary>
          <p>
            {tr(
              "工作台顶部可管理技能与插件，浏览器面板可启动独立的 Chrome/Edge 或连接日常浏览器。当前需要电脑已有 Chrome/Edge。第三方插件的额外依赖仍需按其说明配置。",
              "Manage skills and plugins from the workspace toolbar. The browser panel starts an isolated Chrome/Edge or connects your daily browser. Chrome/Edge currently needs to be installed. Third-party plugins may need additional dependencies.",
            )}
          </p>
        </details>
        <details>
          <summary>{tr("通知", "Notifications")}</summary>
          <p>
            {tr(
              "当前在软件内显示需要输入、审批和错误。系统通知暂未提供。",
              "Input requests, approvals and errors are shown in the app. System notifications are not available yet.",
            )}
          </p>
        </details>
        <details>
          <summary>{tr("环境检查与诊断", "Environment and diagnostics")}</summary>
          <InstallationPanel />
        </details>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="model-actions">
          <button disabled={busy} onClick={() => void save()}>
            {tr("保存设置", "Save settings")}
          </button>
          <button disabled={busy} onClick={onClose}>
            {tr("关闭", "Close")}
          </button>
        </div>
      </section>
    </div>
  );
}
