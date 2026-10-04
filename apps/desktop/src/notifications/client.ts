import { invoke } from "@tauri-apps/api/core";
export interface NotificationPreferences {
  in_app: boolean;
  system: boolean;
  tray: boolean;
  foreground: boolean;
}
export type Delivery =
  "pending" | "off" | "foreground" | "startup" | "batched" | "submitted" | "unavailable" | "failed";
export interface Notice {
  id: string;
  sequence: number;
  task_id: string;
  at_ms: number;
  kind: "completed" | "failed" | "input" | "approval";
  read: boolean;
  delivery: Delivery;
}
export interface NotificationSnapshot {
  preferences: NotificationPreferences;
  entries: Notice[];
  unread: number;
  ready: boolean;
  active: boolean;
  storage_error: boolean;
  overflow: boolean;
  system_available: boolean;
  last_delivery: Delivery | null;
  open: { token: string; id: string | null } | null;
}
export interface NotificationNavigation {
  task_id: string;
  project_id: string | null;
}
export const notificationSnapshot = () => invoke<NotificationSnapshot>("notifications_snapshot");
export const noticeLabel = (kind: Notice["kind"], english: boolean) =>
  ({
    completed: ["任务已完成", "Task completed"],
    failed: ["任务出错", "Task error"],
    input: ["需要补充信息", "Input needed"],
    approval: ["等待你的审批", "Approval needed"],
  })[kind][english ? 1 : 0];
export function deliveryLabel(delivery: Delivery, english: boolean) {
  return {
    pending: ["等待提交系统通知", "Waiting to submit system notification"],
    off: ["系统通知已关闭", "System notifications are off"],
    foreground: ["当前在前台，已在软件内提醒", "Foreground: recorded inside WorkPilot"],
    startup: [
      "已保留在软件内，没有补发系统通知",
      "Kept in the app without resending a system notification",
    ],
    batched: [
      "短时间内还有其他通知，请在通知中心查看",
      "More notifications arrived together; view them here",
    ],
    submitted: [
      "已提交 Windows，是否显示由系统通知与勿扰设置决定",
      "Submitted to Windows; display depends on notification and Do Not Disturb settings",
    ],
    unavailable: [
      "当前副本未启用 Windows 安装版通知；软件内与托盘仍可用",
      "Windows installed-app notifications are unavailable in this copy; in-app and tray notices still work",
    ],
    failed: [
      "系统未能接收通知；任务和软件内记录不受影响",
      "The system could not accept the notification; tasks and in-app records are unaffected",
    ],
  }[delivery][english ? 1 : 0];
}
