import { executionCommand } from "../executionClient";
import type { ArchiveTask, ContentRef, TaskArchiveAction } from "../generated/contracts";
export type ArchiveSummary = {
  archive_id: string;
  created_at_ms: number;
  root_task_id: string;
  tasks: ArchiveTask[];
  counts: Record<string, number>;
  objects: number;
  bytes: number;
  excluded_media: number;
  excluded_file_revisions: number;
};
export type ArchivePreview = {
  kind: "preview";
  summary: ArchiveSummary;
  fingerprint: string;
  already_imported: boolean;
  imported_at_ms: number | null;
};
export type ArchiveEntry = {
  archive_id: string;
  title: string;
  tasks: number;
  imported_at_ms: number;
};
export type ArchivePage = {
  summary: ArchiveSummary;
  table: string;
  total: number;
  next_offset: number;
  records: { ordinal: number; label: string; task_id: string | null; content: ContentRef }[];
};
export async function taskArchive<T>(action: TaskArchiveAction): Promise<T> {
  const response = await executionCommand({ kind: "task_archive", action });
  if (response.kind !== "workbench") throw new Error("无法读取任务档案 / Cannot read task archive");
  return response.data as unknown as T;
}
export const categories: [string, string, string][] = [
  ["messages", "用户消息与队列", "Messages and queue"],
  ["events", "过程记录", "Events"],
  ["tasks", "主任务与助手", "Tasks and assistants"],
  ["execution_sessions", "目标与会话上下文", "Goals and session context"],
  ["execution_runs", "历次执行与模型", "Execution runs and models"],
  ["execution_steps", "模型与工具步骤", "Model and tool steps"],
  ["execution_checkpoints", "保存的执行节点", "Checkpoints"],
  ["team_members", "助手分工与交付", "Assignments and reports"],
  ["team_dependencies", "助手前后关系", "Assistant dependencies"],
  ["team_settings", "原协作设置", "Original team settings"],
  ["team_control", "原协作开关", "Original team controls"],
  ["team_action_receipts", "协作操作结果", "Team action results"],
  ["team_waiters", "原等待关系", "Original wait relationships"],
  ["agents", "助手身份记录", "Agent records"],
  ["runs", "执行状态与结果", "Run states and results"],
  ["approvals", "原审批记录", "Original approval records"],
  ["tool_calls", "工具调用记录", "Tool calls"],
  ["tool_approval_objects", "审批内容", "Approval content"],
  ["tool_result_objects", "工具完整正文", "Tool content links"],
  ["model_calls", "模型连接检查", "Model connection checks"],
  ["workbench_operations", "文件工作区操作", "File workspace operations"],
  ["workbench_output_objects", "文件操作正文", "File operation content links"],
  ["managed_file_changes", "旧版文件修改记录", "Legacy file changes"],
  ["artifacts", "旧版成果记录", "Legacy artifacts"],
  ["revisions", "旧版成果版本", "Legacy artifact versions"],
  ["controlled_effects", "执行效果记录", "Controlled effects"],
  ["execution_resolutions", "人工核对记录", "Manual resolutions"],
  ["commands", "操作回执", "Command receipts"],
  ["event_objects", "过程正文关联", "Event content links"],
  ["contents", "全部保存正文", "All saved content"],
];
