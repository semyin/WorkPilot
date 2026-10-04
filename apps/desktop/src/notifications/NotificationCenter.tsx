import { useContext, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LanguageContext, workspaceQuery, useWords } from "../workspaceClient";
import type { WorkspaceProject } from "../generated/contracts";
import {
  deliveryLabel,
  notificationSnapshot,
  noticeLabel,
  type NotificationNavigation,
  type NotificationSnapshot,
} from "./client";
import "./notifications.css";

export function NotificationCenter({
  onOpen,
  projects,
  disabled,
  openRequest,
  onUnread,
}: {
  onOpen: (target: NotificationNavigation) => void;
  projects: WorkspaceProject[];
  disabled: boolean;
  openRequest: number;
  onUnread: (count: number) => void;
}) {
  const english = useContext(LanguageContext);
  const tr = useWords();
  const [snapshot, setSnapshot] = useState<NotificationSnapshot | null>(null);
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(20);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [titles, setTitles] = useState<Record<string, { title: string; project: string | null }>>(
    {},
  );
  const onOpenRef = useRef(onOpen);
  const disabledRef = useRef(disabled);
  const busyRef = useRef(false);
  onOpenRef.current = onOpen;
  disabledRef.current = disabled;
  const navigate = async (id: string) => {
    if (busyRef.current) return;
    if (disabledRef.current) {
      setOpen(true);
      setError(
        tr(
          "维护完成后，请先重启软件再打开任务。",
          "Restart after maintenance before opening a task.",
        ),
      );
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const target = await invoke<NotificationNavigation>("notifications_open", { id });
      onOpenRef.current(target);
      setOpen(false);
    } catch {
      setOpen(true);
      setError(
        tr(
          "这条任务已删除或暂时无法打开。通知不会自动执行任务。",
          "This task was deleted or is unavailable. Notifications never start work automatically.",
        ),
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  useEffect(() => {
    let disposed = false;
    let generation = 0;
    let stop: (() => void) | undefined;
    const refresh = async () => {
      const current = ++generation;
      try {
        const value = await notificationSnapshot();
        if (disposed || current !== generation) return;
        setSnapshot(value);
        if (value.open) {
          const request = await invoke<{ id: string | null } | null>("notifications_take_open");
          if (disposed || !request) return;
          setOpen(true);
          if (request.id) await navigateRef.current(request.id);
        }
      } catch {
        if (!disposed) setError("通知暂不可读取 / Notifications are unavailable");
      }
    };
    void listen("workpilot-notifications", () => void refresh())
      .then((unlisten) => {
        if (disposed) unlisten();
        else {
          stop = unlisten;
          void refresh();
        }
      })
      .catch(() => {
        if (!disposed) void refresh();
      });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);
  const ids =
    snapshot?.entries
      .slice(0, limit)
      .map((n) => n.task_id)
      .join(",") || "";
  useEffect(() => {
    if (!open || disabled || !ids) return;
    let disposed = false;
    const queue = [...new Set(ids.split(","))];
    const resolve = async () => {
      while (!disposed && queue.length) {
        const task = queue.shift()!;
        try {
          const response = await workspaceQuery({ kind: "detail", task_id: task });
          if (!disposed && response.kind === "detail")
            setTitles((previous) => ({
              ...previous,
              [task]: {
                title: response.snapshot.task.title,
                project: response.snapshot.task.project_id,
              },
            }));
        } catch {
          /* Deleted records keep a neutral ID label and never navigate blindly. */
        }
      }
    };
    void Promise.all([resolve(), resolve(), resolve(), resolve()]);
    return () => {
      disposed = true;
    };
  }, [open, disabled, ids]);
  const unread = snapshot?.preferences.in_app ? snapshot.unread : 0;
  useEffect(() => {
    onUnread(unread);
  }, [unread, onUnread]);
  useEffect(() => {
    if (openRequest > 0) {
      setOpen(true);
      setError("");
    }
  }, [openRequest]);
  return (
    <>
      {disabled && (
        <button
          className="notification-launcher"
          data-testid="notification-center-open"
          aria-label={tr(`通知中心（${unread} 条未读）`, `Notification center (${unread} unread)`)}
          aria-expanded={open}
          onClick={() => {
            setOpen(true);
            setError("");
          }}
        >
          <span aria-hidden="true">♧</span> {tr("通知", "Notifications")}
          {unread > 0 && <b>{unread}</b>}
        </button>
      )}
      {open && (
        <div
          className="workspace-modal notification-modal"
          role="dialog"
          aria-label={tr("通知中心", "Notification center")}
        >
          <section>
            <div className="notification-heading">
              <h2>{tr("通知中心", "Notification center")}</h2>
              <button onClick={() => setOpen(false)}>{tr("关闭", "Close")}</button>
            </div>
            <p>
              {tr(
                "保留最近 128 条提醒。打开只查看任务，不会继续执行。",
                "Keeps the latest 128 notifications. Opening only views the task; it never resumes work.",
              )}
            </p>
            <button
              disabled={disabled || busy || !snapshot?.unread}
              onClick={() => {
                setError("");
                void invoke("notifications_read", { id: null }).catch(() =>
                  setError(tr("已读状态未能保存。", "Could not mark notifications as read.")),
                );
              }}
            >
              {tr("全部标为已读", "Mark all as read")}
            </button>
            {snapshot?.overflow && (
              <p role="status">
                {tr(
                  "短时间内提醒较多，部分状态请到任务列表查看。",
                  "Many changes arrived together; check the task list for additional states.",
                )}
              </p>
            )}
            {snapshot?.storage_error && (
              <p role="alert">
                {tr(
                  "通知记录未能保存；任务记录仍可在工作台查看。",
                  "Notification records could not be saved; task records remain in the workspace.",
                )}
              </p>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {!snapshot?.entries.length && (
              <p>{tr("还没有新的任务提醒。", "No new task notifications yet.")}</p>
            )}
            <ol className="notification-list">
              {snapshot?.entries.slice(0, limit).map((notice) => {
                const task = titles[notice.task_id];
                const project = projects.find((p) => p.id === task?.project);
                return (
                  <li
                    key={notice.id}
                    data-notification-kind={notice.kind}
                    data-unread={!notice.read}
                  >
                    <strong>{noticeLabel(notice.kind, english)}</strong>
                    {!notice.read && (
                      <span className="notification-unread">{tr("未读", "Unread")}</span>
                    )}
                    <p>{task?.title || tr("任务", "Task") + " " + notice.task_id.slice(0, 8)}</p>
                    {task && (
                      <small>
                        {project?.settings.name ||
                          (task.project
                            ? tr("原项目", "Original project")
                            : tr("独立任务", "Standalone task"))}
                      </small>
                    )}
                    <time dateTime={new Date(notice.at_ms).toISOString()}>
                      {new Date(notice.at_ms).toLocaleString(english ? "en" : "zh-CN")}
                    </time>
                    <small>{deliveryLabel(notice.delivery, english)}</small>
                    <button disabled={disabled || busy} onClick={() => void navigate(notice.id)}>
                      {tr("打开任务", "Open task")}
                    </button>
                  </li>
                );
              })}
            </ol>
            {snapshot && snapshot.entries.length > limit && (
              <button onClick={() => setLimit((n) => n + 20)}>
                {tr("显示更早提醒", "Show earlier notifications")}
              </button>
            )}
          </section>
        </div>
      )}
    </>
  );
}
