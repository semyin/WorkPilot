import { ArtifactPreview } from "../workbench/ArtifactPreview";
import { ProjectFiles } from "../workbench/ProjectFiles";
import { useState, type ReactNode } from "react";
import type {
  ExecutionSnapshot,
  ExecutionStep,
  ExecutionLimits,
  WorkspacePreferences,
  WorkMode,
  ProfileCatalog,
} from "../generated/contracts";
import { BrowserPanel } from "../BrowserPanel";
import { RecordPanel } from "../RecordPanel";
import { Saved } from "../SavedContent";
import { Disclosure } from "../workbench/Disclosure";
import { Menu, Select } from "../workbench/Menu";
import { Icon } from "../workbench/Icon";
export type InspectorTab =
  "artifacts" | "files" | "activity" | "tools" | "team" | "browser" | "settings";
function Step({ step, english }: { step: ExecutionStep; english: boolean }) {
  const words: Record<string, string[]> = {
    prepared: ["待执行", "Prepared"],
    running: ["执行中", "Running"],
    completed: ["已完成", "Completed"],
    failed: ["失败", "Failed"],
    cancelled: ["已取消", "Cancelled"],
    skipped: ["已跳过", "Skipped"],
    needs_review: ["结果待核对", "Needs review"],
  };
  return (
    <article className="wb-timeline-item" data-step-name={step.name} data-step-state={step.state}>
      <Disclosure
        title={
          <>
            <span>{step.kind === "model" ? (english ? "Model" : "模型") : step.name}</span>
            <small>{words[step.state]?.[english ? 1 : 0] || step.state}</small>
          </>
        }
      >
        <small>{english ? "Input" : "输入"}</small>
        <Saved reference={step.input} />
        {step.output && (
          <>
            <small>{english ? "Result" : "结果"}</small>
            <Saved reference={step.output} />
          </>
        )}
      </Disclosure>
    </article>
  );
}
export function TaskInspector({
  english,
  prefs,
  creating,
  snapshot,
  toolPanel,
  teamPanel,
  busy,
  active,
  mode,
  setMode,
  profile,
  setProfile,
  limits,
  setLimits,
  saveSettings,
  tab,
  onTab,
  onClose,
  onFiles,
  catalog,
  readHistory,
  resize,
  focusedArtifact,
}: {
  english: boolean;
  prefs: WorkspacePreferences | undefined;
  creating: boolean;
  snapshot: ExecutionSnapshot | null;
  toolPanel: ReactNode;
  teamPanel: ReactNode;
  busy: boolean;
  active: boolean;
  mode: WorkMode;
  setMode: (value: WorkMode) => void;
  profile: string;
  setProfile: (value: string) => void;
  limits: ExecutionLimits;
  setLimits: (value: ExecutionLimits) => void;
  saveSettings: () => void;
  tab: InspectorTab;
  onTab: (tab: InspectorTab) => void;
  onClose: () => void;
  onFiles: () => void;
  catalog: ProfileCatalog;
  readHistory: () => void;
  resize?: ReactNode;
  focusedArtifact?: string | null;
}) {
  const tr = (zh: string, en: string) => (english ? en : zh);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const labels = {
    artifacts: tr("成果", "Artifacts"),
    files: tr("文件", "Files"),
    activity: tr("过程", "Activity"),
    tools: tr("权限与审批", "Permissions & approvals"),
    team: tr("协作成员", "Team"),
    browser: tr("浏览器", "Browser"),
    settings: tr("运行设置", "Run settings"),
  };
  return (
    <aside
      className="wb-work-panel wb-inspector"
      aria-label={tr("任务工作区", "Task workspace")}
      aria-hidden={creating || prefs?.inspector_closed}
      inert={creating || prefs?.inspector_closed}
    >
      {resize}
      <div className="wb-panel-heading">
        <strong>{tr("工作区", "Workspace")}</strong>
        <button
          type="button"
          className="wb-icon-button wb-panel-tools"
          aria-label={tr("工作区工具", "Workspace tools")}
          onClick={(e) => setMenu(menu ? null : e.currentTarget)}
        >
          <Icon name="more" />
        </button>
        <button
          type="button"
          className="wb-icon-button"
          aria-label={tr("关闭工作区", "Close workspace")}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <nav className="wb-panel-tabs">
        <button
          type="button"
          className={tab === "artifacts" ? "wb-active" : ""}
          aria-pressed={tab === "artifacts"}
          onClick={() => onTab("artifacts")}
        >
          {labels.artifacts}
        </button>
        <button
          type="button"
          className={tab === "files" ? "wb-active" : ""}
          aria-pressed={tab === "files"}
          disabled={!snapshot}
          onClick={() => onTab("files")}
        >
          {tr("文件", "Files")}
        </button>
        <button
          type="button"
          className={tab === "activity" ? "wb-active" : ""}
          aria-pressed={tab === "activity"}
          onClick={() => onTab("activity")}
        >
          {labels.activity}
        </button>
        {!["artifacts", "files", "activity"].includes(tab) && <span>{labels[tab]}</span>}
      </nav>
      <div className="wb-panel-content" key={`${snapshot?.task.id || "new"}:${tab}`}>
        {creating || !snapshot ? (
          <div className="wb-notice">
            <Icon name="files" />
            <h2>{tr("工作成果，随时在旁", "Your work, close at hand")}</h2>
            <p>
              {tr(
                "任务开始后，在这里查看成果、过程和需要处理的操作。",
                "Artifacts, activity and actions appear here once a task starts.",
              )}
            </p>
          </div>
        ) : (
          <>
            {tab === "artifacts" && (
              <ArtifactPreview
                focused={focusedArtifact}
                key={snapshot.task.id}
                task={snapshot.task.id}
                sequence={snapshot.task.last_sequence}
              />
            )}
            {tab === "files" && (
              <ProjectFiles
                key={snapshot.task.id}
                task={snapshot.task.id}
                onManage={onFiles}
                onBrowser={() => onTab("browser")}
              />
            )}
            {tab === "tools" && (
              <section className="wb-legacy-details" id="inspector-tools">
                {toolPanel}
              </section>
            )}
            {tab === "team" && (
              <section className="wb-legacy-details" id="inspector-team">
                {teamPanel || <p>{tr("当前没有协作成员。", "No team members in this task.")}</p>}
              </section>
            )}
            {tab === "browser" && (
              <BrowserPanel
                key={snapshot.task.id}
                task={snapshot.task.id}
                open
                onOpen={(open) => {
                  if (!open) onTab("artifacts");
                }}
              />
            )}
            {tab === "settings" && (
              <section className="wb-legacy-details">
                <h2>{labels.settings}</h2>
                <Disclosure title={tr("任务目标和限制", "Goal and constraints")}>
                  <p>{snapshot.context.goal}</p>
                  {snapshot.context.constraints.map((c, i) => (
                    <p key={i}>• {c}</p>
                  ))}
                </Disclosure>
                <fieldset disabled={busy || active}>
                  <div className="wb-field">
                    <span>{tr("工作模式", "Work mode")}</span>
                    <Select
                      label={tr("修改工作模式", "Change work mode")}
                      value={mode}
                      onChange={(v) => setMode(v as WorkMode)}
                      options={[
                        { value: "chat", label: tr("聊天", "Chat") },
                        { value: "plan", label: tr("先规划再执行", "Plan first") },
                        { value: "execute", label: tr("直接执行", "Execute") },
                      ]}
                    />
                  </div>
                  <div className="wb-field">
                    <span>{tr("任务模型", "Task model")}</span>
                    <Select
                      label={tr("修改任务模型", "Change task model")}
                      value={profile}
                      onChange={setProfile}
                      options={[
                        { value: "", label: tr("继承默认模型", "Inherit default model") },
                        ...catalog.profiles.map(({ profile: p }) => ({
                          value: p.id,
                          label: p.label,
                          description: p.model,
                        })),
                      ]}
                    />
                  </div>
                  <label>
                    {tr("每次执行最多步骤", "Steps per run")}
                    <input
                      type="number"
                      value={limits.max_steps}
                      onChange={(e) => setLimits({ ...limits, max_steps: Number(e.target.value) })}
                    />
                  </label>
                  <label>
                    {tr("每次执行最多秒数", "Seconds per run")}
                    <input
                      type="number"
                      value={limits.max_duration_ms / 1000}
                      onChange={(e) =>
                        setLimits({ ...limits, max_duration_ms: Number(e.target.value) * 1000 })
                      }
                    />
                  </label>
                  <label>
                    {tr("上下文容量（KiB）", "Context budget (KiB)")}
                    <input
                      type="number"
                      value={limits.context_bytes / 1024}
                      onChange={(e) =>
                        setLimits({ ...limits, context_bytes: Number(e.target.value) * 1024 })
                      }
                    />
                  </label>
                  <button type="button" onClick={saveSettings}>
                    {tr("保存运行设置", "Save run settings")}
                  </button>
                </fieldset>
              </section>
            )}
            {tab === "activity" && (
              <>
                <h2>{tr("执行过程", "Execution trace")}</h2>
                <p className="wb-panel-caption">
                  {tr(
                    "最近 64 个步骤，可展开查看输入与结果。",
                    "Latest 64 steps. Expand to see inputs and results.",
                  )}
                </p>
                {snapshot.steps.map((step) => (
                  <Step key={step.id} step={step} english={english} />
                ))}
                <Disclosure title={tr("本次执行信息", "Current run details")}>
                  <pre>{JSON.stringify(snapshot.latest_run, null, 2)}</pre>
                </Disclosure>
                <button type="button" onClick={readHistory}>
                  {tr("完整事件", "Full events")}
                </button>
                <Disclosure title={tr("查找与导出完整记录", "Find and export complete records")}>
                  <section className="wb-legacy-details" id="inspector-records">
                    <RecordPanel key={snapshot.task.id} task={snapshot.task.id} />
                  </section>
                </Disclosure>
              </>
            )}
          </>
        )}
      </div>
      {menu && (
        <Menu
          anchor={menu}
          label={tr("工作区工具", "Workspace tools")}
          items={[
            { value: "tools", label: labels.tools, icon: "shield" },
            { value: "team", label: labels.team, icon: "chat" },
            { value: "browser", label: labels.browser, icon: "globe" },
            {
              value: "files",
              label: tr("文件与终端", "Files and terminal"),
              icon: "terminal",
              disabled: !snapshot,
            },
            { value: "settings", label: labels.settings, icon: "settings" },
          ]}
          onClose={() => setMenu(null)}
          onPick={(value) => (value === "files" ? onFiles() : onTab(value as InspectorTab))}
        />
      )}
    </aside>
  );
}
