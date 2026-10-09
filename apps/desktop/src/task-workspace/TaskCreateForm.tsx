import { ComposerInput } from "../workbench/ComposerInput";
import { useEffect, useState } from "react";
import { Dialog } from "../workbench/Dialog";
import { ComposerControls } from "../workbench/ComposerControls";
import { Icon } from "../workbench/Icon";
import { executionCommand } from "../executionClient";
import type { PermissionMode } from "../generated/contracts";

import type {
  ExecutionConfig,
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
  create,
  onModels,
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
  create: (startNow?: boolean) => Promise<void>;
  onModels: () => void;
}) {
  const tr = (zh: string, en: string) => (english ? en : zh);
  const [options, setOptions] = useState(false);
  const [globalPermission, setGlobalPermission] = useState<PermissionMode | null>(null);
  useEffect(() => {
    let live = true;
    void executionCommand({ kind: "read", query: { kind: "tool_defaults" } })
      .then((r) => {
        if (live && r.kind === "tool_defaults") setGlobalPermission(r.settings.permission);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const project = desktop?.overview?.projects.find((p) => p.id === config.project_id);
  const modelId =
    config.profile_id || project?.settings.default_profile_id || catalog.global_default;
  const model = catalog.profiles.find((p) => p.profile.id === modelId)?.profile || null;
  return (
    <footer className="wb-composer-area">
      <FileAttachments
        compact
        assets={initialAttachments}
        onChange={setInitialAttachments}
        onBusy={setAttachmentBusy}
      >
        {(attachment) => (
          <>
            <ComposerInput
              autoFocus
              rows={2}
              disabled={busy}
              aria-label={tr("你想完成什么？", "What would you like to do?")}
              placeholder={tr(
                "你想完成什么？可以附上文件或图片…",
                "What would you like to do? Add files or images…",
              )}
              value={config.goal}
              onChange={(e) => setConfig({ ...config, goal: e.target.value })}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing &&
                  config.goal.trim() &&
                  !busy &&
                  !attachmentBusy &&
                  model
                ) {
                  e.preventDefault();
                  void create();
                }
              }}
            />

            <ComposerControls
              attachment={attachment}
              catalog={catalog}
              profile={config.profile_id || ""}
              model={model}
              mode={config.mode}
              permission={tools.permission}
              inheritedPermission={project?.settings.permission || globalPermission}
              disabled={busy}
              onModels={onModels}
              onProfile={(value) => setConfig({ ...config, profile_id: value || null })}
              onMode={(value) => setConfig({ ...config, mode: value })}
              onPermission={(value) => setTools({ ...tools, permission: value })}
            >
              <button
                type="button"
                className="wb-send-button"
                aria-label={tr("创建并开始", "Create and start")}
                title={tr("创建并开始", "Create and start")}
                disabled={busy || attachmentBusy || !config.goal.trim() || !model}
                onClick={() => void create()}
              >
                <Icon name="arrow" />
              </button>
            </ComposerControls>
          </>
        )}
      </FileAttachments>
      <div className="wb-composer-hint">
        <button
          type="button"
          aria-label={tr("任务选项", "Task options")}
          title={tr("任务选项", "Task options")}
          onClick={() => setOptions(true)}
        >
          {tr("当前项目：", "Current project: ")}
          {project?.settings.name || tr("个人空间", "Personal space")}
        </button>
        <span>
          Enter {tr("发送", "Send")} · Shift + Enter {tr("换行", "New line")}
        </span>
      </div>
      {!model && (
        <div className="wb-notice">
          <span>{tr("先配置一个模型，就可以开始工作。", "Connect a model to start working.")}</span>
          <button type="button" onClick={onModels}>
            {tr("配置模型服务", "Configure model services")}
          </button>
        </div>
      )}
      {options && (
        <Dialog
          title={tr("任务选项", "Task options")}
          onClose={() => setOptions(false)}
          busy={busy}
        >
          <label>
            {tr("任务名称（可留空）", "Task title (optional)")}
            <input
              value={config.title}
              onChange={(e) => setConfig({ ...config, title: e.target.value })}
            />
          </label>
          <label>
            {tr("限制条件（每行一条）", "Constraints (one per line)")}
            <textarea
              rows={2}
              aria-label={tr("限制条件（每行一条）", "Constraints (one per line)")}
              value={constraints}
              onChange={(e) => setConstraints(e.target.value)}
            />
          </label>
          <label>
            {tr("提供给此任务的项目规则", "Project rules for this task")}
            <textarea
              rows={2}
              aria-label={tr("提供给此任务的项目规则", "Project rules for this task")}
              value={config.project_rules}
              onChange={(e) => setConfig({ ...config, project_rules: e.target.value })}
            />
          </label>
          <ToolFields value={tools} onChange={setTools} english={english} catalog={catalog} />
          {!desktop && (
            <label>
              <input
                type="checkbox"
                checked={config.controlled_tools}
                onChange={(e) => setConfig({ ...config, controlled_tools: e.target.checked })}
              />
              {tr("启用样本工具", "Enable sample tools")}
            </label>
          )}
          {config.mode === "execute" && (
            <button
              type="button"
              disabled={busy || attachmentBusy || !config.goal.trim() || !model}
              onClick={() => void create(false)}
            >
              {tr("先创建并设置分工", "Create and configure team first")}
            </button>
          )}
          <div className="wb-dialog-actions">
            <button type="button" className="wb-solid-button" onClick={() => setOptions(false)}>
              {tr("完成", "Done")}
            </button>
          </div>
        </Dialog>
      )}
    </footer>
  );
}
