import appIcon from "../../../assets/icons/png/128.png";
import { Dialog } from "./workbench/Dialog";
import { Select } from "./workbench/Menu";
import { Icon, type IconName } from "./workbench/Icon";
import { lazy, Suspense, useEffect, useState } from "react";
import type {
  WorkspacePreferences,
  SchedulerSettings,
  DefaultToolSettings,
  PermissionMode,
  ProfileCatalog,
} from "./generated/contracts";
import { executionCommand } from "./executionClient";
import { useWords } from "./workspaceClient";
import { InstallationPanel } from "./InstallationPanel";
import { MaintenancePanel } from "./MaintenancePanel";
import type { MaintenanceProgress } from "./MaintenanceStatus";
import { UpdatePanel } from "./UpdatePanel";
import { BrowserSetupPanel } from "./BrowserSetupPanel";
import { FullMigrationPanel } from "./migration/FullMigrationPanel";
import { ProjectTransferPanel } from "./ProjectTransferPanel";
import { NotificationSettings } from "./notifications/NotificationSettings";
const TaskArchivePanel = lazy(() =>
  import("./task-archive/TaskArchivePanel").then((module) => ({
    default: module.TaskArchivePanel,
  })),
);
export function WorkspaceSettings({
  preferences,
  scheduler,
  dataDir,
  onPreferences,
  onModels,
  onMemory,
  onClose,
  onOpenTask,
  onMaintenance,
}: {
  preferences: WorkspacePreferences;
  scheduler: SchedulerSettings;
  dataDir: string;
  onPreferences: (p: WorkspacePreferences) => Promise<void>;
  onModels: () => void;
  onMemory: () => void;
  onClose: () => void;
  onOpenTask: (id: string) => void;
  onMaintenance: MaintenanceProgress;
}) {
  const tr = useWords();
  const [draft, setDraft] = useState(preferences);
  const [motion, setMotion] = useState(localStorage.getItem("workpilot.motion") !== "off");
  const [catalog, setCatalog] = useState<ProfileCatalog>({ profiles: [], global_default: null });
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void executionCommand({ kind: "read", query: { kind: "profiles" } })
      .then((r) => {
        if (live && r.kind === "profiles") {
          setCatalog(r.catalog);
          setDefaultModel(r.catalog.global_default);
        }
      })
      .catch((e) => setError(String(e)));
    return () => {
      live = false;
    };
  }, []);
  const [parallel, setParallel] = useState(scheduler.max_running);
  const [defaults, setDefaults] = useState<DefaultToolSettings | null>(null);
  const [originalDefaults, setOriginalDefaults] = useState<DefaultToolSettings | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState("general");
  const [visited, setVisited] = useState(["general"]);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
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
      if (defaultModel !== catalog.global_default)
        await executionCommand({
          kind: "set_default_profile",
          scope: { kind: "global" },
          profile_id: defaultModel,
        });
      await onPreferences(draft);
      localStorage.setItem("workpilot.motion", motion ? "on" : "off");
      document.documentElement.dataset.motion = motion ? "on" : "off";
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const sections: Array<[string, string, IconName]> = [
    ["general", tr("通用与外观", "General"), "settings"],
    ["models", tr("模型服务", "Models"), "spark"],
    ["permissions", tr("任务与权限", "Tasks & permissions"), "shield"],
    ["browser", tr("浏览器与连接", "Browser & connections"), "globe"],
    ["notifications", tr("通知", "Notifications"), "bell"],
    ["memory", tr("记忆", "Memory"), "files"],
    ["data", tr("数据与维护", "Data & maintenance"), "folder"],
  ];
  return (
    <Dialog
      title={tr("设置", "Settings")}
      onClose={onClose}
      busy={busy}
      className="wb-settings-dialog"
      customLayout
    >
      <div className="wb-settings-layout">
        <aside className="wb-settings-navigation">
          <h2>{tr("设置", "Settings")}</h2>
          <nav aria-label={tr("设置目录", "Settings navigation")}>
            {sections.map(([key, label, icon]) => (
              <button
                type="button"
                key={key}
                aria-current={section === key ? "page" : undefined}
                onClick={() => {
                  setSection(key);
                  setVisited((old) => (old.includes(key) ? old : [...old, key]));
                }}
              >
                <Icon name={icon} />
                <span>{label}</span>
              </button>
            ))}
          </nav>
          <div className="wb-settings-brand">
            <img src={appIcon} alt="" />
            WorkPilot
          </div>
        </aside>
        <div className="wb-settings-main">
          <header>
            <div>
              <h3>{sections.find(([key]) => key === section)?.[1]}</h3>
              <p>{tr("为你的工作方式调整细节", "Make this workspace your own")}</p>
            </div>
            <button
              type="button"
              className="wb-icon-button"
              aria-label={tr("关闭设置", "Close settings")}
              onClick={onClose}
              disabled={busy}
            >
              <Icon name="close" />
            </button>
          </header>
          <div className="wb-settings-scroll">
            <section hidden={section !== "general"}>
              <div className="wb-settings-group-label">
                {tr("让工作台更适合你", "Make this workspace your own")}
              </div>
              <div className="wb-settings-row">
                <div>
                  <strong>{tr("外观", "Appearance")}</strong>
                  <p>{tr("选择明亮、深色或跟随系统", "Choose light, dark or match your system")}</p>
                </div>
                <Select
                  label={tr("外观", "Appearance")}
                  value={draft.theme}
                  options={[
                    { value: "system", label: tr("跟随系统", "System") },
                    { value: "light", label: tr("浅色", "Light") },
                    { value: "dark", label: tr("深色", "Dark") },
                  ]}
                  onChange={(value) => setDraft({ ...draft, theme: value })}
                />
              </div>
              <div className="wb-settings-row">
                <div>
                  <strong>{tr("界面动画", "Interface animations")}</strong>
                  <p>
                    {tr(
                      "展开、收起与页面切换采用轻量过渡；尊重系统的减少动态效果设置。",
                      "Subtle transitions for panels and views, respecting reduced motion.",
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  className="wb-settings-switch"
                  role="switch"
                  aria-label={tr("界面动画", "Interface animations")}
                  aria-checked={motion}
                  onClick={() => setMotion(!motion)}
                >
                  <span />
                </button>
              </div>
              <div className="wb-settings-row">
                <div>
                  <strong>{tr("默认模型", "Default model")}</strong>
                  <p>
                    {tr(
                      "新任务默认使用的模型，可在输入栏单独更换。",
                      "Default for new tasks; choose a different model in the composer.",
                    )}
                  </p>
                </div>
                <Select
                  label={tr("新任务默认模型", "Default model for new tasks")}
                  value={defaultModel || ""}
                  onChange={(v) => setDefaultModel(v || null)}
                  options={[
                    { value: "", label: tr("未设置", "Not set") },
                    ...catalog.profiles.map(({ profile: p }) => ({ value: p.id, label: p.label })),
                  ]}
                />
              </div>
              <div className="wb-settings-row">
                <div>
                  <strong>{tr("界面语言", "Language")}</strong>
                  <p>
                    {tr("菜单、状态与提示使用的语言", "Language for menus, status and messages")}
                  </p>
                </div>
                <Select
                  label={tr("界面语言", "Language")}
                  value={draft.language}
                  options={[
                    { value: "zh", label: "简体中文" },
                    { value: "en", label: "English" },
                  ]}
                  onChange={(value) => setDraft({ ...draft, language: value })}
                />
              </div>
              <p className="wb-settings-note">
                Ctrl + N {tr("新建任务", "New task")} · Ctrl + K {tr("搜索任务", "Search tasks")}
              </p>
            </section>
            <section hidden={section !== "models"}>
              {catalog.profiles.map(({ profile: p }) => (
                <div className="wb-service-row" key={p.id}>
                  <span className="wb-service-icon">
                    <Icon name="spark" />
                  </span>
                  <div>
                    <strong>{p.label}</strong>
                    <small>{p.model}</small>
                  </div>
                  <button className="wb-outline-button" onClick={onModels}>
                    {tr("管理", "Manage")}
                  </button>
                </div>
              ))}
              <p>
                {tr(
                  "统一管理服务地址、凭据和可用模型。任务中只需选择要使用的模型。",
                  "Manage service addresses, credentials and available models here. Choose a model in each task.",
                )}
              </p>
              <button type="button" onClick={onModels}>
                {tr("配置模型服务", "Configure model services")}
              </button>
            </section>
            <section hidden={section !== "permissions"}>
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
                <div className="wb-field">
                  <span>{tr("新任务默认权限", "Default task permission")}</span>
                  <Select
                    label={tr("新任务默认权限", "Default task permission")}
                    value={defaults.permission}
                    options={[
                      { value: "request_approval", label: tr("请求审批", "Request approval") },
                      { value: "auto_review", label: tr("帮我批准", "Review for me") },
                      { value: "full_access", label: tr("完全访问", "Full access") },
                    ]}
                    onChange={(value) =>
                      setDefaults({ ...defaults, permission: value as PermissionMode })
                    }
                  />
                </div>
              )}
            </section>
            <section hidden={section !== "memory"}>
              <p className="wb-settings-intro">
                {tr(
                  "值得长期记住的要求，先由助手提出，再由你确认保存。",
                  "The assistant suggests lasting preferences, and you confirm what is saved.",
                )}
              </p>
              <button className="wb-outline-button" type="button" onClick={onMemory}>
                {tr("管理记忆", "Manage memory")}
              </button>
            </section>
            {visited.includes("browser") && (
              <section hidden={section !== "browser"}>
                <p>
                  {tr(
                    "使用专用浏览器，或连接你授权的日常浏览器。",
                    "Use the dedicated browser or connect your authorized everyday browser.",
                  )}
                </p>
                <BrowserSetupPanel />
              </section>
            )}
            {visited.includes("notifications") && (
              <section hidden={section !== "notifications"}>
                <NotificationSettings />
              </section>
            )}
            {visited.includes("data") && (
              <section hidden={section !== "data"}>
                {" "}
                <details>
                  <summary>{tr("数据位置", "Data location")}</summary>
                  <p>{dataDir}</p>
                  <small>
                    {tr(
                      "记录保存在本机。可使用完整资料迁移选择项目、任务、扩展与文件；修改历史也可单独备份。导入前会显示路径和权限确认。",
                      "Records stay on this computer. Full migration lets you select projects, tasks, extensions and files; file history can also be backed up separately. Paths and permissions are shown before importing.",
                    )}
                  </small>
                </details>
                <details>
                  <summary>{tr("完整资料迁移", "Complete data migration")}</summary>
                  <FullMigrationPanel onOpen={onOpenTask} />
                </details>
                <details>
                  <summary>
                    {tr("项目设置与记忆迁移", "Project settings and memory transfer")}
                  </summary>
                  <ProjectTransferPanel />
                </details>
                <details onToggle={(e) => setArchiveOpen(e.currentTarget.open)}>
                  <summary>
                    {tr("任务与助手档案迁移", "Task and assistant archive transfer")}
                  </summary>
                  {archiveOpen && (
                    <Suspense fallback={<p>{tr("正在打开任务档案…", "Opening task archives…")}</p>}>
                      <TaskArchivePanel onOpen={onOpenTask} />
                    </Suspense>
                  )}
                </details>
              </section>
            )}
            {visited.includes("data") && (
              <section hidden={section !== "data"}>
                {" "}
                <details>
                  <summary>{tr("环境检查与诊断", "Environment and diagnostics")}</summary>
                  <InstallationPanel />
                </details>
                <details>
                  <summary>{tr("软件更新", "Software update")}</summary>
                  <UpdatePanel onMaintenance={onMaintenance} />
                </details>
                <details onToggle={(e) => setMaintenanceOpen(e.currentTarget.open)}>
                  <summary>{tr("数据清理与恢复初始状态", "Data maintenance and reset")}</summary>
                  {maintenanceOpen && <MaintenancePanel onMaintenance={onMaintenance} />}
                </details>
              </section>
            )}
          </div>
          {defaults && defaults.permission !== originalDefaults?.permission && (
            <p className="wb-settings-warning">
              {tr(
                "权限已更改：保存会暂停运行中的任务，并使旧审批失效。",
                "Permission changed: saving pauses running tasks and expires old approvals.",
              )}
            </p>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <footer>
            <span>{tr("设置保存在本机", "Settings stay on this device")}</span>
            <button
              type="button"
              className="wb-solid-button"
              disabled={busy}
              onClick={() => void save()}
            >
              {tr("保存设置", "Save settings")}
            </button>
          </footer>
        </div>
      </div>
    </Dialog>
  );
}
