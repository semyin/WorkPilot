import { useContext, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LanguageContext, useWords } from "../workspaceClient";
import {
  notificationSnapshot,
  deliveryLabel,
  type Delivery,
  type NotificationPreferences,
  type NotificationSnapshot,
} from "./client";
export function NotificationSettings() {
  const english = useContext(LanguageContext);
  const tr = useWords();
  const [snapshot, setSnapshot] = useState<NotificationSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const currentSnapshot = useRef<NotificationSnapshot | null>(null);
  const readGeneration = useRef(0);
  const lifetime = useRef(0);
  const alive = useRef(false);
  const busyRef = useRef(false);
  const refreshPending = useRef(false);
  const readError =
    "通知设置暂时无法读取，已保存的设置不受影响 / Notification settings could not be refreshed; saved settings remain";
  const refresh = async (duringMutation = false) => {
    if (!alive.current) return;
    if (busyRef.current && !duringMutation) {
      refreshPending.current = true;
      return;
    }
    const generation = ++readGeneration.current;
    try {
      const value = await notificationSnapshot();
      if (!alive.current || generation !== readGeneration.current) return;
      currentSnapshot.current = value;
      setSnapshot(value);
      setError((previous) => (previous === readError ? "" : previous));
    } catch {
      if (alive.current && generation === readGeneration.current) setError(readError);
    }
  };
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    alive.current = true;
    lifetime.current++;
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
      alive.current = false;
      lifetime.current++;
      readGeneration.current++;
      busyRef.current = false;
      refreshPending.current = false;
      stop?.();
    };
  }, []);
  const finishMutation = (started: number) => {
    if (!alive.current || lifetime.current !== started) return;
    busyRef.current = false;
    setBusy(false);
    if (refreshPending.current) {
      refreshPending.current = false;
      void refresh();
    }
  };
  const save = async (key: keyof NotificationPreferences, enabled: boolean) => {
    if (!alive.current || busyRef.current || !currentSnapshot.current) return;
    const started = lifetime.current;
    const preferences = { ...currentSnapshot.current.preferences, [key]: enabled };
    busyRef.current = true;
    readGeneration.current++;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await invoke("notifications_save", {
        preferences,
      });
      if (!alive.current || lifetime.current !== started) return;
      // The save acknowledgement is authoritative even if the subsequent read
      // fails. Never restore a pre-save snapshot or report that write as failed.
      const saved = { ...currentSnapshot.current!, preferences };
      currentSnapshot.current = saved;
      setSnapshot(saved);
      setMessage(tr("通知设置已保存。", "Notification settings saved."));
      refreshPending.current = false;
      await refresh(true);
    } catch {
      if (alive.current && lifetime.current === started)
        setError(
          tr(
            "通知设置未能保存，原设置保留。",
            "Could not save notification settings. Previous settings remain.",
          ),
        );
    } finally {
      finishMutation(started);
    }
  };
  const test = async () => {
    if (!alive.current || busyRef.current) return;
    const started = lifetime.current;
    busyRef.current = true;
    readGeneration.current++;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await invoke<Delivery>("notifications_test");
      if (!alive.current || lifetime.current !== started) return;
      setMessage(deliveryLabel(result, english));
      refreshPending.current = false;
      await refresh(true);
    } catch {
      if (alive.current && lifetime.current === started)
        setError(
          tr("通知测试失败；不会影响任务。", "The notification test failed; tasks are unaffected."),
        );
    } finally {
      finishMutation(started);
    }
  };
  return (
    <div className="notification-settings">
      <p>
        {tr(
          "完成、出错、需要输入或审批时提醒。以下开关修改后立即保存。",
          "Get notified when tasks finish, fail, need input or need approval. Changes save immediately.",
        )}
      </p>
      {snapshot &&
        (
          [
            ["in_app", "软件内未读提醒", "In-app unread indicator"],
            ["system", "Windows 系统通知", "Windows system notifications"],
            ["tray", "托盘红点和未读数量", "Tray badge and unread count"],
            [
              "foreground",
              "窗口在前台时也弹系统通知",
              "Also show system notifications while the window is focused",
            ],
          ] as const
        ).map(([key, zh, en]) => (
          <label key={key}>
            <input
              type="checkbox"
              checked={snapshot.preferences[key]}
              disabled={
                busy ||
                !snapshot.ready ||
                !snapshot.active ||
                (key === "foreground" && !snapshot.preferences.system)
              }
              onChange={(event) => void save(key, event.target.checked)}
            />
            {tr(zh, en)}
          </label>
        ))}
      <p>
        {tr(
          "默认只在软件退到后台时弹系统通知。重启不会重新弹历史通知。连续到达的提醒最多每两秒弹一次，所有记录仍在通知中心。",
          "By default, system notifications appear only in the background. Restarting never resends history. Bursts show at most one system popup every two seconds; all records remain in the notification center.",
        )}
      </p>
      <p>
        {tr(
          "系统弹窗只显示简短状态，不带任务标题、项目名称或正文。打开通知后只会查看任务，不会批准操作或继续执行。",
          "System popups contain only a short status, without task titles, project names or content. Opening one only views the task; it never approves or resumes work.",
        )}
      </p>
      {snapshot && !snapshot.system_available && <p>{deliveryLabel("unavailable", english)}</p>}
      <button disabled={busy || !snapshot?.active} onClick={() => void test()}>
        {tr("发送一条测试通知", "Send a test notification")}
      </button>
      <small>
        {tr(
          "此按钮会主动测试一次，不受前台和系统通知开关限制。Windows 勿扰或关闭通知时可能不显示；任务状态一直保留在软件内。免安装包不会借用其他软件的通知身份。",
          "This explicit test bypasses the foreground and system-notification switches. Windows may suppress it when notifications or Do Not Disturb settings block it. Task states stay in WorkPilot. Portable builds do not borrow another app's notification identity.",
        )}
      </small>
      {snapshot?.storage_error && (
        <p role="alert">
          {tr(
            "通知记录无法保存；本轮仍可查看任务状态。请检查数据目录空间或权限。",
            "Notification records could not be saved. Current task states are still available. Check data-folder space and permissions.",
          )}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
