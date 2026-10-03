import { useState, type ReactNode } from "react";
import type {
  ExecutionSnapshot,
  ExecutionStep,
  ExecutionLimits,
  WorkspacePreferences,
  WorkMode,
} from "../generated/contracts";
import { BrowserPanel } from "../BrowserPanel";
import { ArtifactPanel, RecordPanel } from "../RecordPanel";
import { Saved } from "../SavedContent";
function Step({ step, english }: { step: ExecutionStep; english: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const words = {
    prepared: ["待执行", "Prepared"],
    running: ["执行中", "Running"],
    completed: ["已完成", "Completed"],
    failed: ["失败", "Failed"],
    cancelled: ["已取消", "Cancelled"],
    skipped: ["已跳过", "Skipped"],
    needs_review: ["结果待核对", "Needs review"],
  };
  return (
    <article className="execution-step" data-step-name={step.name} data-step-state={step.state}>
      <button onClick={() => setExpanded(!expanded)}>
        <span>{step.kind === "model" ? (english ? "Model" : "模型") : step.name}</span>
        <small>{words[step.state][english ? 1 : 0]}</small>
      </button>
      {expanded && (
        <div>
          <small>{english ? "Input" : "输入"}</small>
          <Saved reference={step.input} />
          {step.output && (
            <>
              <small>{english ? "Result" : "结果"}</small>
              <Saved reference={step.output} />
            </>
          )}
        </div>
      )}
    </article>
  );
}

export function TaskInspector({
  english,
  desktop,
  prefs,
  creating,
  snapshot,
  toolPanel,
  teamPanel,
  browserOpen,
  setBrowserOpen,
  busy,
  active,
  mode,
  setMode,
  modes,
  profile,
  setProfile,
  profileOptions,
  limits,
  setLimits,
  saveSettings,
}: {
  english: boolean;
  desktop: boolean;
  prefs: WorkspacePreferences | undefined;
  creating: boolean;
  snapshot: ExecutionSnapshot | null;
  toolPanel: ReactNode;
  teamPanel: ReactNode;
  browserOpen: boolean;
  setBrowserOpen: (value: boolean) => void;
  busy: boolean;
  active: boolean;
  mode: WorkMode;
  setMode: (value: WorkMode) => void;
  modes: ReactNode;
  profile: string;
  setProfile: (value: string) => void;
  profileOptions: ReactNode;
  limits: ExecutionLimits;
  setLimits: (value: ExecutionLimits) => void;
  saveSettings: () => void;
}) {
  const tr = (zh: string, en: string) => (english ? en : zh);
  return (
    <aside className="execution-details" hidden={prefs?.inspector_closed}>
      {desktop && creating && (
        <div className="workspace-empty">
          <h2>{tr("从一个目标开始", "Start with a goal")}</h2>
          <p>
            {tr(
              "任务开始后，这里会显示执行过程、协作成员和成果文件。",
              "Once you start, execution steps, team members and artifacts appear here.",
            )}
          </p>
        </div>
      )}
      {!creating && snapshot && (
        <>
          {desktop && (
            <>
              <nav className="inspector-links">
                {[
                  ["tools", tr("权限", "Permissions")],
                  ["team", tr("协作", "Team")],
                  ["trace", tr("过程", "Trace")],
                  ["artifacts", tr("成果", "Artifacts")],
                  ["records", tr("记录", "Records")],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() =>
                      document
                        .getElementById(`inspector-${id}`)
                        ?.scrollIntoView({ block: "start", behavior: "smooth" })
                    }
                  >
                    {label}
                  </button>
                ))}
              </nav>
              <section id="inspector-tools">{toolPanel}</section>
              <BrowserPanel
                key={snapshot.task.id}
                task={snapshot.task.id}
                open={browserOpen}
                onOpen={setBrowserOpen}
              />
              <section id="inspector-team">{teamPanel}</section>
              <div id="inspector-trace" />
            </>
          )}
          <h2>{tr("执行过程", "Execution trace")}</h2>
          <p>
            {tr(
              "真实工具按左侧有效权限执行。每个步骤都可展开查看输入与结果；文件修改和审批会留下记录。",
              "Real tools follow the effective permission on the left. Expand steps for their inputs and results; file changes and approvals are recorded.",
            )}
          </p>
          <details>
            <summary>{tr("模式、模型与运行上限", "Mode, model and limits")}</summary>
            <fieldset disabled={busy || active}>
              <label>
                {tr("工作模式", "Work mode")}
                <select
                  aria-label={tr("修改工作模式", "Change work mode")}
                  value={mode}
                  onChange={(e) => setMode(e.target.value as WorkMode)}
                >
                  {modes}
                </select>
              </label>
              <label>
                {tr("任务模型", "Task model")}
                <select
                  aria-label={tr("修改任务模型", "Change task model")}
                  value={profile}
                  onChange={(e) => setProfile(e.target.value)}
                >
                  {profileOptions}
                </select>
              </label>
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
              <button onClick={() => saveSettings()}>
                {tr("保存运行设置", "Save run settings")}
              </button>
            </fieldset>
          </details>
          <small>
            {tr(
              "最近 64 个步骤。展开查看实际输入和结果；更早过程见“完整事件”。",
              "Latest 64 steps. Expand inputs and results; earlier records are in Full events.",
            )}
          </small>
          {snapshot.steps.map((step) => (
            <Step key={step.id} step={step} english={english} />
          ))}
          {snapshot.latest_run && (
            <details>
              <summary>{tr("本次执行信息", "Current run details")}</summary>
              <pre>{JSON.stringify(snapshot.latest_run, null, 2)}</pre>
            </details>
          )}
          {desktop && (
            <>
              <section id="inspector-artifacts">
                <ArtifactPanel
                  key={snapshot.task.id}
                  task={snapshot.task.id}
                  sequence={snapshot.task.last_sequence}
                />
              </section>
              <section id="inspector-records">
                <RecordPanel key={snapshot.task.id} task={snapshot.task.id} />
              </section>
            </>
          )}
        </>
      )}
    </aside>
  );
}
