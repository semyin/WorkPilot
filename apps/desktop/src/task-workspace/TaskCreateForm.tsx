import type { ReactNode } from "react";
import type {
  ExecutionConfig,
  WorkMode,
  ToolSettings,
  ProfileCatalog,
  MediaAsset,
} from "../generated/contracts";
import type { TaskDesktop } from "./types";
import { ToolFields } from "../ToolPanel";
import { FileAttachments } from "../FileAttachments";
export function TaskCreateForm({
  english,
  desktop,
  config,
  setConfig,
  constraints,
  setConstraints,
  tools,
  setTools,
  catalog,
  initialAttachments,
  setInitialAttachments,
  setAttachmentBusy,
  attachmentBusy,
  busy,
  modes,
  profileOptions,
  create,
}: {
  english: boolean;
  desktop: TaskDesktop | undefined;
  config: ExecutionConfig;
  setConfig: (value: ExecutionConfig) => void;
  constraints: string;
  setConstraints: (value: string) => void;
  tools: ToolSettings;
  setTools: (value: ToolSettings) => void;
  catalog: ProfileCatalog;
  initialAttachments: MediaAsset[];
  setInitialAttachments: (value: MediaAsset[]) => void;
  setAttachmentBusy: (value: boolean) => void;
  attachmentBusy: boolean;
  busy: boolean;
  modes: ReactNode;
  profileOptions: ReactNode;
  create: (startNow?: boolean) => Promise<void>;
}) {
  const tr = (zh: string, en: string) => (english ? en : zh);
  return (
    <section className="execution-create">
      <h2>{tr("新建任务", "New task")}</h2>
      {config.project_id && (
        <p className="execution-notice">
          {tr("项目：", "Project: ")}
          {desktop?.overview?.projects.find((p) => p.id === config.project_id)?.settings.name}
        </p>
      )}
      <label>
        {tr("任务名称（可留空）", "Task title (optional)")}
        <input
          value={config.title}
          onChange={(e) => setConfig({ ...config, title: e.target.value })}
        />
      </label>
      <label>
        {tr("你想完成什么？", "What would you like to do?")}
        <textarea
          rows={5}
          aria-label={tr("你想完成什么？", "What would you like to do?")}
          value={config.goal}
          onChange={(e) => setConfig({ ...config, goal: e.target.value })}
        />
      </label>
      {desktop && (
        <FileAttachments
          key="initial"
          assets={initialAttachments}
          onChange={setInitialAttachments}
          onBusy={setAttachmentBusy}
        />
      )}
      <label>
        {tr("工作模式", "Work mode")}
        <select
          aria-label={tr("工作模式", "Work mode")}
          value={config.mode}
          onChange={(e) => setConfig({ ...config, mode: e.target.value as WorkMode })}
        >
          {modes}
        </select>
      </label>
      <label>
        {tr("任务模型", "Task model")}
        <select
          aria-label={tr("任务模型", "Task model")}
          value={config.profile_id || ""}
          onChange={(e) => setConfig({ ...config, profile_id: e.target.value || null })}
        >
          {profileOptions}
        </select>
      </label>
      <details>
        <summary>{tr("需要始终遵守的要求", "Requirements to preserve")}</summary>
        <label>
          {tr("限制条件（每行一条）", "Constraints (one per line)")}
          <textarea
            aria-label={tr("限制条件（每行一条）", "Constraints (one per line)")}
            value={constraints}
            onChange={(e) => setConstraints(e.target.value)}
          />
        </label>
        <label>
          {tr("提供给此任务的项目规则", "Project rules for this task")}
          <textarea
            aria-label={tr("提供给此任务的项目规则", "Project rules for this task")}
            value={config.project_rules}
            onChange={(e) => setConfig({ ...config, project_rules: e.target.value })}
          />
        </label>
      </details>
      <ToolFields value={tools} onChange={setTools} english={english} catalog={catalog} />
      <label className="check-label" hidden={!!desktop}>
        <input
          type="checkbox"
          checked={config.controlled_tools}
          onChange={(e) => setConfig({ ...config, controlled_tools: e.target.checked })}
        />
        {tr("启用内置样本工具（验证执行流程）", "Enable sample tools (test the execution flow)")}
      </label>
      <p hidden={!!desktop}>
        {tr(
          "样本工具用于验证流程。授权文件夹后可读取、搜索、修改文本文件和登记成果；浏览器操作将在后续接入。",
          "Sample tools test the execution flow. Authorize a folder to read, search, edit text files and register artifacts. Browser tools arrive later.",
        )}
      </p>
      <button
        className="primary"
        disabled={busy || attachmentBusy || !config.goal.trim()}
        onClick={() => void create()}
      >
        {tr("创建并开始", "Create and start")}
      </button>
      {config.mode === "execute" && (
        <button
          disabled={busy || attachmentBusy || !config.goal.trim()}
          onClick={() => void create(false)}
        >
          {tr("先创建并设置分工", "Create and configure team first")}
        </button>
      )}
    </section>
  );
}
