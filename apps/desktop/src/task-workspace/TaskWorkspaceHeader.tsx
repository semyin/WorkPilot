import type { ReactNode } from "react";
import type { TaskDesktop } from "./types";
import { Icon } from "../workbench/Icon";
export function TaskWorkspaceHeader({
  english,
  desktop,
  onClose,
  onModels,
  title,
  project,
  status,
  taskPage = true,
  showWorkspace = true,
}: {
  english: boolean;
  desktop: TaskDesktop | undefined;
  selected: string | null;
  onClose: () => void;
  onModels: () => void;
  open: Record<"extensions" | "files" | "browser" | "memory" | "schedules" | "media", () => void>;
  title: string;
  project: string;
  status?: ReactNode;
  taskPage?: boolean;
  showWorkspace?: boolean;
}) {
  const tr = (zh: string, en: string) => (english ? en : zh);
  const prefs = desktop?.preferences;
  return (
    <header className="wb-workspace-header">
      <div className="wb-header-title">
        {prefs?.sidebar_closed && (
          <button
            type="button"
            className="wb-icon-button"
            aria-label={tr("展开侧栏", "Expand sidebar")}
            onClick={() => desktop?.onPreferences({ ...prefs, sidebar_closed: false })}
          >
            <Icon name="leftPanel" />
          </button>
        )}
        <div>
          <div className="wb-breadcrumb">
            {project} <span>/</span> {taskPage ? tr("任务", "Task") : tr("工作空间", "Workspace")}
          </div>
          <h1>{title}</h1>
        </div>
      </div>
      <div className="wb-header-actions">
        {status}
        {desktop?.onNotifications && (
          <button
            type="button"
            className="wb-icon-button wb-notification-button"
            title={tr("通知", "Notifications")}
            data-testid="notification-center-open"
            aria-label={tr(
              `通知中心（${desktop.unreadNotifications || 0} 条未读）`,
              `Notification center (${desktop.unreadNotifications || 0} unread)`,
            )}
            onClick={desktop.onNotifications}
          >
            <Icon name="bell" />
            {!!desktop.unreadNotifications && <i className="wb-notification-dot" />}
          </button>
        )}
        {desktop && prefs && showWorkspace && (
          <button
            type="button"
            className="wb-icon-button"
            title={tr("成果、文件与执行过程", "Artifacts, files and activity")}
            aria-label={tr("详情面板", "Details panel")}
            aria-expanded={!prefs.inspector_closed}
            onClick={() =>
              desktop.onPreferences({ ...prefs, inspector_closed: !prefs.inspector_closed })
            }
          >
            <Icon name="rightPanel" />
          </button>
        )}
        {!desktop && (
          <>
            <button type="button" onClick={onModels}>
              {tr("模型服务", "Model services")}
            </button>
            <button type="button" onClick={onClose}>
              {tr("返回工作台", "Back to workspace")}
            </button>
          </>
        )}
      </div>
    </header>
  );
}
