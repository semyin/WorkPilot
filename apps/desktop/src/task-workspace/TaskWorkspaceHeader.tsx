import type { TaskDesktop } from "./types";
import icon from "../../../../assets/icons/png/128.png";
export function TaskWorkspaceHeader({
  english,
  desktop,
  selected,
  onClose,
  onModels,
  open,
}: {
  english: boolean;
  desktop: TaskDesktop | undefined;
  selected: string | null;
  onClose: () => void;
  onModels: () => void;
  open: Record<"extensions" | "files" | "browser" | "memory" | "schedules" | "media", () => void>;
}) {
  const tr = (zh: string, en: string) => (english ? en : zh);
  const prefs = desktop?.preferences;
  return (
    <div className="model-header">
      <div>
        <h1>
          {desktop ? (
            <>
              <img src={icon} alt="" />
              WorkPilot
            </>
          ) : (
            tr("任务执行", "Task execution")
          )}
        </h1>
        <p>
          {desktop
            ? desktop.connected
              ? tr("引擎已连接", "Engine connected")
              : tr("正在连接…", "Connecting…")
            : tr(
                "模型驱动的任务循环 · 保存过程 · 手动继续",
                "Model-driven tasks · Saved progress · Manual continuation",
              )}
        </p>
      </div>
      <div className="model-actions">
        <button onClick={() => open.extensions()}>{tr("技能与插件", "Skills & plugins")}</button>
        {desktop && selected && (
          <>
            <button onClick={() => open.files()}>{tr("文件与终端", "Files and terminal")}</button>
            <button
              onClick={() => {
                open.browser();
                if (prefs?.inspector_closed)
                  desktop.onPreferences({ ...prefs, inspector_closed: false });
                setTimeout(
                  () =>
                    document
                      .getElementById("inspector-browser")
                      ?.scrollIntoView({ block: "start", behavior: "smooth" }),
                  50,
                );
              }}
            >
              {tr("浏览器", "Browser")}
            </button>
          </>
        )}
        {desktop && prefs && (
          <>
            <button
              aria-pressed={!prefs.sidebar_closed}
              onClick={() =>
                desktop.onPreferences({ ...prefs, sidebar_closed: !prefs.sidebar_closed })
              }
            >
              {tr("项目与任务", "Projects & tasks")}
            </button>
            <button onClick={desktop.onSettings}>{tr("设置", "Settings")}</button>
            {desktop.onNotifications && (
              <button
                onClick={desktop.onNotifications}
                data-testid="notification-center-open"
                aria-label={tr(
                  `通知中心（${desktop.unreadNotifications || 0} 条未读）`,
                  `Notification center (${desktop.unreadNotifications || 0} unread)`,
                )}
              >
                {tr("通知", "Notifications")}
                {!!desktop.unreadNotifications && (
                  <b className="notification-unread">{desktop.unreadNotifications}</b>
                )}
              </button>
            )}
            <button
              className="language"
              onClick={() => desktop.onPreferences({ ...prefs, language: english ? "zh" : "en" })}
            >
              {english ? "简体中文" : "English"}
            </button>
            <button
              aria-pressed={!prefs.inspector_closed}
              onClick={() =>
                desktop.onPreferences({ ...prefs, inspector_closed: !prefs.inspector_closed })
              }
            >
              {tr("详情面板", "Details panel")}
            </button>
          </>
        )}
        <button onClick={onModels}>{tr("模型服务", "Model services")}</button>
        <button onClick={() => open.memory()}>{tr("记忆", "Memory")}</button>
        <button onClick={() => open.schedules()}>{tr("定时任务", "Schedules")}</button>
        <button onClick={() => open.media()}>{tr("文件成果与图片", "Files and images")}</button>
        <button onClick={onClose}>
          {desktop ? tr("隐藏窗口", "Hide window") : tr("返回工作台", "Back to workspace")}
        </button>
      </div>
    </div>
  );
}
