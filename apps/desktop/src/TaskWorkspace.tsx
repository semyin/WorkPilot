import { useEffect, useRef, useState, type CSSProperties } from "react";
import type {
  ContentRef,
  ExecutionConfig,
  ExecutionLimits,
  ExecutionSnapshot,
  ExecutionStep,
  ProfileCatalog,
  Task,
  TaskState,
  WorkMode,
  EventPage,
  Event as EngineEvent,
  TeamView,
  WorkspacePreferences,
  WorkspaceProject,
} from "./generated/contracts";
import { executionCommand as command } from "./executionClient";
import { Saved } from "./SavedContent";
import { ToolFields, ToolPanel, initialTools } from "./ToolPanel";
import { TeamPanel } from "./TeamPanel";
import { ProjectSidebar } from "./ProjectSidebar";
import { Conversation, QueueEdit, TextAttachments } from "./Conversation";
import { RecordPanel, ArtifactPanel } from "./RecordPanel";
import { ResizeHandle } from "./ResizeHandle";
import { FileWorkbench } from "./FileWorkbench";
import { workspaceAction, workspaceQuery } from "./workspaceClient";
import type { Overview } from "./App";
import icon from "../../../assets/icons/png/128.png";
const limitsDefault: ExecutionLimits = {
  max_steps: 32,
  max_duration_ms: 300000,
  context_bytes: 65536,
  max_result_bytes: 32768,
};
function HistoryEvent({ event }: { event: EngineEvent }) {
  const [expanded, setExpanded] = useState(false);
  const references: ContentRef[] = [];
  if ("content" in event && event.content) references.push(event.content);
  if (event.kind === "context_compacted") references.push(event.archive);
  if (event.kind === "execution_created") references.push(event.goal);
  if (event.kind === "execution_ended" && event.output) references.push(event.output);
  if (event.kind === "team_changed" && event.record) references.push(event.record);
  if (event.kind === "workbench_changed" && event.record) references.push(event.record);
  if (event.kind === "execution_step_changed") {
    if (event.input) references.push(event.input);
    if (event.output) references.push(event.output);
  }
  return (
    <details onToggle={(e) => setExpanded(e.currentTarget.open)}>
      <summary>
        #{event.task_sequence} · {event.kind}
      </summary>
      {expanded && (
        <>
          <pre>{JSON.stringify(event, null, 2)}</pre>
          {references.map((r) => (
            <Saved key={r.object_id} reference={r} plain={r.media_type !== "application/json"} />
          ))}
        </>
      )}
    </details>
  );
}
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
export function TaskWorkspace({
  language,
  onClose,
  onModels,
  desktop,
}: {
  language: string;
  onClose: () => void;
  onModels: () => void;
  desktop?: {
    overview: Overview | null;
    preferences: WorkspacePreferences;
    connected: boolean;
    onRefresh: () => void;
    onPreferences: (p: WorkspacePreferences) => void;
    onSettings: () => void;
  };
}) {
  const english = language === "en";
  const tr = (zh: string, en: string) => (english ? en : zh);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [catalog, setCatalog] = useState<ProfileCatalog>({ profiles: [], global_default: null });
  const [selected, setSelected] = useState<string | null>(
    localStorage.getItem("workpilot.execution"),
  );
  const [snapshot, setSnapshot] = useState<ExecutionSnapshot | null>(null);
  const [team, setTeam] = useState<TeamView | null>(null);
  const [creating, setCreating] = useState(!selected);
  const [config, setConfig] = useState<ExecutionConfig>({
    title: "",
    goal: "",
    constraints: [],
    project_rules: "",
    project_id: null,
    profile_id: null,
    mode: "chat",
    controlled_tools: false,
    limits: limitsDefault,
  });
  const [tools, setTools] = useState(initialTools);
  const [constraints, setConstraints] = useState("");
  const [mode, setMode] = useState<WorkMode>("chat");
  const [profile, setProfile] = useState("");
  const [limits, setLimits] = useState(limitsDefault);
  const [message, setMessage] = useState("");
  const [live, setLive] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [history, setHistory] = useState<EventPage | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [reviewResults, setReviewResults] = useState<Record<string, string>>({});
  const [archived, setArchived] = useState(false);
  const [effectiveModel, setEffectiveModel] = useState("");
  const [effectivePermission, setEffectivePermission] = useState("request_approval");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [fileWorkspace, setFileWorkspace] = useState(false);
  const selectionGeneration = useRef(0);
  const settingsTask = useRef("");
  const active =
    !!snapshot?.latest_run && ["queued", "running", "stopping"].includes(snapshot.task.state);
  const status = (s: TaskState) =>
    ({
      queued: tr("排队", "Queued"),
      running: tr("运行中", "Running"),
      stopping: tr("正在停止", "Stopping"),
      interrupted: tr("已中断", "Interrupted"),
      failed: tr("失败", "Failed"),
      completed: tr("已完成", "Completed"),
      awaiting_input: tr("等待输入", "Awaiting input"),
      awaiting_approval: tr("等待审批", "Awaiting approval"),
    })[s];
  const reasonLabel = (r: string | null | undefined) =>
    ({
      team_waiting: tr(
        "主助手正在等待成员交付，成员继续工作。",
        "The lead is waiting; members continue working.",
      ),
      team_results_need_review: tr(
        "还有成员成果需要检查。可查看团队情况，再继续主任务。",
        "Member deliveries still need review. Inspect the team and continue the lead.",
      ),
      parent_stopped: tr(
        "主任务已停止，成员一起暂停。",
        "The parent stopped; this member is paused.",
      ),
      awaiting_approval: tr("等待你确认具体操作。", "Waiting for action approval."),
      approval_rejected: tr(
        "你已拒绝此操作，任务已暂停。",
        "The action was rejected; this task is paused.",
      ),
      user_stop: tr(
        "你停止了任务，可手动继续。",
        "You stopped the task. Continue manually when ready.",
      ),
      engine_exit: tr(
        "程序曾退出，任务未自动重跑。",
        "The engine exited. This task was not restarted.",
      ),
      step_limit: tr(
        "达到步骤上限，已暂停。可调整上限后继续。",
        "The step limit was reached. Adjust limits or continue.",
      ),
      time_limit: tr("达到时间上限，已暂停。", "The time limit was reached."),
      context_limit_pinned_requirements: tr(
        "必须保留的要求已超过上下文容量。可提高容量或新建任务。",
        "Pinned requirements exceed the context budget. Increase it or start a new task.",
      ),
      tool_result_needs_review: tr(
        "有工具结果不确定，请先核对下方记录。",
        "A tool result is uncertain. Review the action below.",
      ),
      plan_has_unfinished_steps: tr(
        "计划中还有未完成项，任务已暂停。",
        "The plan still has unfinished steps.",
      ),
    })[r || ""] || "";
  const refresh = async (task: string) => {
    const result = await workspaceQuery({ kind: "detail", task_id: task });
    if (result.kind === "detail") return result;
    throw new Error(tr("无法读取任务。", "Could not read this task."));
  };
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const [list, profiles] = await Promise.all([
          command({ kind: "read", query: { kind: "executions", limit: 64 } }),
          command({ kind: "read", query: { kind: "profiles" } }),
        ]);
        if (!disposed) {
          if (list.kind === "executions") setTasks(list.tasks);
          if (profiles.kind === "profiles") setCatalog(profiles.catalog);
        }
      } catch (e) {
        if (!disposed) setError(String(e));
      }
      if (!disposed) timer = setTimeout(poll, 750);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    const generation = ++selectionGeneration.current;
    setSnapshot(null);
    setError("");
    setTeam(null);
    setLive("");
    setReasoning("");
    setHistory(null);
    setStopping(false);
    if (!selected) return;
    localStorage.setItem("workpilot.execution", selected);
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const [view, teamResult] = await Promise.all([
          refresh(selected),
          command({ kind: "read", query: { kind: "team", task_id: selected } }),
        ]);
        if (disposed || generation !== selectionGeneration.current) return;
        const detail = view.snapshot;
        setSnapshot(detail);
        setArchived(view.archived);
        setEffectivePermission(view.effective_permission);
        setEffectiveModel(
          view.effective_profile
            ? `${view.effective_profile.label} · ${view.effective_profile.model}`
            : tr("尚未选择模型", "No model selected"),
        );
        setLive(view.live_text);
        setReasoning(view.live_reasoning);
        if (teamResult.kind === "team") setTeam(teamResult.view);
        if (!["running", "stopping", "queued"].includes(detail.task.state)) setStopping(false);
        if (settingsTask.current !== selected) {
          settingsTask.current = selected;
          setMode(detail.task.mode);
          setProfile(detail.task.profile_id || "");
          setLimits(detail.config.limits);
        }
        if (!disposed) timer = setTimeout(poll, 150);
      } catch (e) {
        if (!disposed) {
          setError(e instanceof Error ? e.message : String(e));
          timer = setTimeout(poll, 1000);
        }
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [selected, english]);
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStopping(false);
    } finally {
      setBusy(false);
    }
  };
  const start = (task: string) => command({ kind: "start_execution", task_id: task }, english);
  const create = (startNow = true) =>
    act(async () => {
      const data = {
        ...config,
        constraints: constraints.split("\n").filter((s) => s.trim()),
        title: config.title.trim() || config.goal.slice(0, 60),
      };
      const response = await command({ kind: "create_execution", config: data }, english);
      if (response.kind === "receipt" && response.receipt.task_id) {
        const task = response.receipt.task_id;
        setSelected(task);
        setCreating(false);
        settingsTask.current = "";
        if (
          tools.root_path ||
          tools.permission ||
          tools.commands_enabled ||
          tools.review_profile_id
        )
          await command({ kind: "configure_task_tools", task_id: task, settings: tools }, english);
        if (startNow) await start(task);
      }
    });
  const configure = (selectedMode: WorkMode) =>
    snapshot &&
    command(
      {
        kind: "configure_execution",
        task_id: snapshot.task.id,
        mode: selectedMode,
        profile_id: profile || null,
        limits,
      },
      english,
    );
  const sendMessage = () =>
    act(async () => {
      if (!selected || !message.trim()) return;
      const generation = selectionGeneration.current;
      await command({ kind: "enqueue", task_id: selected, text: message }, english);
      setMessage("");
      const current = await refresh(selected);
      if (generation === selectionGeneration.current) setSnapshot(current.snapshot);
      // A user send to a completed/waiting task explicitly starts a new turn.
      // Interrupted/failed tasks always retain the separate Continue control.
      if (["completed", "awaiting_input"].includes(current.snapshot.task.state))
        await start(selected);
    });
  const readHistory = (after = 0) =>
    act(async () => {
      if (!selected) return;
      const r = await command(
        { kind: "read", query: { kind: "events", task_id: selected, after, limit: 128 } },
        english,
      );
      if (r.kind === "events") {
        setHistory(r.page);
        setShowHistory(true);
      }
    });
  const profileOptions = (
    <>
      <option value="">{tr("继承默认模型", "Inherit default model")}</option>
      {catalog.profiles.map(({ profile }) => (
        <option key={profile.id} value={profile.id}>
          {profile.label} · {profile.model}
        </option>
      ))}
    </>
  );
  const modes = (
    <>
      <option value="chat">{tr("聊天", "Chat")}</option>
      <option value="plan">{tr("先规划再执行", "Plan first")}</option>
      <option value="execute">{tr("直接执行", "Execute")}</option>
    </>
  );
  const needsReview = snapshot?.steps.filter((s) => s.state === "needs_review") || [];
  const newTask = (project: WorkspaceProject | null) => {
    setCreating(true);
    setSelected(null);
    localStorage.removeItem("workpilot.execution");
    setError("");
    setMessage("");
    setConfig({
      ...config,
      title: "",
      goal: "",
      constraints: [],
      project_rules: "",
      project_id: project?.id || null,
      profile_id: null,
      mode: "chat",
      controlled_tools: false,
    });
    setTools(
      project
        ? {
            ...initialTools,
            root_path: project.settings.root_path,
            permission: project.settings.permission,
          }
        : initialTools,
    );
    setConstraints("");
  };
  const selectTask = (id: string) => {
    setSelected(id);
    setCreating(false);
    setError("");
    setMessage("");
    setRenaming(null);
  };
  const attach = (text: string, initial: boolean) => {
    const updated = (initial ? config.goal : message) + text;
    if (new TextEncoder().encode(updated).length > 16384) {
      setError(
        tr(
          "输入与附件合计不能超过 16 KiB，请缩短后重试。",
          "Instructions and attachments must total at most 16 KiB.",
        ),
      );
      return;
    }
    if (initial) setConfig({ ...config, goal: updated });
    else setMessage(updated);
  };
  const toolPanel = snapshot && (
    <ToolPanel
      key={snapshot.task.id}
      task={snapshot.task.id}
      english={english}
      catalog={catalog}
      active={active}
      inherited={!!team && team.root_task_id !== snapshot.task.id}
      start={() => start(snapshot.task.id)}
    />
  );
  const teamPanel = snapshot &&
    team &&
    (snapshot.task.mode === "execute" || team.members.length > 0) && (
      <TeamPanel
        key={snapshot.task.id}
        task={snapshot.task.id}
        view={team}
        mode={snapshot.task.mode}
        catalog={catalog}
        english={english}
        active={active}
        status={status}
        open={selectTask}
      />
    );
  const prefs = desktop?.preferences;
  return (
    <div
      className={
        desktop
          ? "model-overlay execution-overlay workspace-root"
          : "model-overlay execution-overlay"
      }
      style={
        prefs
          ? ({
              "--left": prefs.sidebar_closed ? "0px" : `${prefs.sidebar_width}px`,
              "--right": prefs.inspector_closed ? "0px" : `${prefs.inspector_width}px`,
            } as CSSProperties)
          : undefined
      }
      role={desktop ? "region" : "dialog"}
      aria-label={tr("任务执行", "Task execution")}
    >
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
          {desktop && selected && (
            <button onClick={() => setFileWorkspace(true)}>
              {tr("文件与终端", "Files and terminal")}
            </button>
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
          <button onClick={onClose}>
            {desktop ? tr("隐藏窗口", "Hide window") : tr("返回工作台", "Back to workspace")}
          </button>
        </div>
      </div>
      <div className="execution-columns">
        {desktop ? (
          <>
            <div className="workspace-sidebar-wrap" hidden={prefs?.sidebar_closed}>
              <ProjectSidebar
                projects={desktop.overview?.projects || []}
                catalog={catalog}
                selected={selected}
                onSelect={selectTask}
                onNew={newTask}
                onProjectsChanged={desktop.onRefresh}
                english={english}
              />
            </div>
            {prefs && !prefs.sidebar_closed ? (
              <ResizeHandle
                side="left"
                width={prefs.sidebar_width}
                onChange={(sidebar_width) => desktop.onPreferences({ ...prefs, sidebar_width })}
                label={tr("调整项目栏宽度", "Resize project sidebar")}
              />
            ) : (
              <div />
            )}
          </>
        ) : (
          <aside className="model-list">
            <button
              onClick={() => {
                setCreating(true);
                setError("");
                setConfig({
                  ...config,
                  title: "",
                  goal: "",
                  constraints: [],
                  project_rules: "",
                  mode: "chat",
                  controlled_tools: false,
                });
                setConstraints("");
                setTools(initialTools);
              }}
            >
              {tr("+ 新建任务", "+ New task")}
            </button>
            {tasks.map((task) => (
              <button
                key={task.id}
                data-execution-id={task.id}
                className={!creating && selected === task.id ? "chosen" : ""}
                onClick={() => {
                  setSelected(task.id);
                  setCreating(false);
                  setError("");
                }}
              >
                <strong>{task.title}</strong>
                <small>{status(task.state)}</small>
              </button>
            ))}
            <small>
              {tr(
                "关闭此页面或隐藏窗口后，任务继续运行。",
                "Tasks keep running when this page or window is hidden.",
              )}
            </small>
          </aside>
        )}
        <main className="execution-main">
          {desktop && !!desktop.overview?.notices.length && (
            <details className="workspace-notices">
              <summary>
                {tr("需要处理", "Needs attention")} · {desktop.overview.notices.length}
              </summary>
              {desktop.overview.notices.map((n) => (
                <button key={n.task_id} onClick={() => selectTask(n.task_id)}>
                  {n.title} · {status(n.state)}
                </button>
              ))}
            </details>
          )}
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          {creating ? (
            <section className="execution-create">
              <h2>{tr("新建任务", "New task")}</h2>
              {config.project_id && (
                <p className="execution-notice">
                  {tr("项目：", "Project: ")}
                  {
                    desktop?.overview?.projects.find((p) => p.id === config.project_id)?.settings
                      .name
                  }
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
              {desktop && <TextAttachments onAttach={(text) => attach(text, true)} />}
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
                {tr(
                  "启用内置样本工具（验证执行流程）",
                  "Enable sample tools (test the execution flow)",
                )}
              </label>
              <p hidden={!!desktop}>
                {tr(
                  "样本工具用于验证流程。授权文件夹后可读取、搜索、修改文本文件和登记成果；浏览器操作将在后续接入。",
                  "Sample tools test the execution flow. Authorize a folder to read, search, edit text files and register artifacts. Browser tools arrive later.",
                )}
              </p>
              <button
                className="primary"
                disabled={busy || !config.goal.trim()}
                onClick={() => void create()}
              >
                {tr("创建并开始", "Create and start")}
              </button>
              {config.mode === "execute" && (
                <button disabled={busy || !config.goal.trim()} onClick={() => void create(false)}>
                  {tr("先创建并设置分工", "Create and configure team first")}
                </button>
              )}
            </section>
          ) : (
            snapshot && (
              <>
                <div className="execution-title">
                  <h2>{snapshot.task.title}</h2>
                  <span
                    data-testid="execution-status"
                    data-state={stopping ? "stopping" : snapshot.task.state}
                  >
                    {stopping ? tr("正在停止", "Stopping") : status(snapshot.task.state)}
                  </span>
                </div>
                {desktop && (
                  <>
                    <div className="workspace-task-meta">
                      <small>
                        {effectiveModel} ·{" "}
                        {effectivePermission === "full_access"
                          ? tr("完全访问", "Full access")
                          : effectivePermission === "auto_review"
                            ? tr("帮我批准", "Review for me")
                            : tr("请求审批", "Request approval")}{" "}
                        ·{" "}
                        {snapshot.task.mode === "chat"
                          ? tr("聊天", "Chat")
                          : snapshot.task.mode === "plan"
                            ? tr("规划", "Plan")
                            : tr("执行", "Execute")}
                      </small>
                      {team?.root_task_id === snapshot.task.id && (
                        <>
                          <button onClick={() => setRenaming(snapshot.task.title)}>
                            {tr("重命名", "Rename")}
                          </button>
                          <button
                            disabled={busy || active}
                            onClick={() =>
                              void act(async () => {
                                await workspaceAction({
                                  kind: "archive_task",
                                  task_id: snapshot.task.id,
                                  archived: !archived,
                                });
                                setArchived(!archived);
                              })
                            }
                          >
                            {archived
                              ? tr("恢复任务", "Restore task")
                              : tr("归档任务", "Archive task")}
                          </button>
                        </>
                      )}
                    </div>
                    {renaming !== null && (
                      <div className="model-actions">
                        <input
                          aria-label={tr("新的任务名称", "New task title")}
                          value={renaming}
                          onChange={(e) => setRenaming(e.target.value)}
                        />
                        <button
                          disabled={busy || !renaming.trim()}
                          onClick={() =>
                            void act(async () => {
                              await workspaceAction({
                                kind: "rename_task",
                                task_id: snapshot.task.id,
                                title: renaming,
                              });
                              setRenaming(null);
                            })
                          }
                        >
                          {tr("保存名称", "Save title")}
                        </button>
                        <button onClick={() => setRenaming(null)}>{tr("取消", "Cancel")}</button>
                      </div>
                    )}
                    {archived && (
                      <p className="execution-notice">
                        {tr(
                          "任务已归档。恢复后可继续。",
                          "This task is archived. Restore it to continue.",
                        )}
                      </p>
                    )}
                  </>
                )}
                {!desktop && toolPanel}
                <details className="execution-goal">
                  <summary>{tr("任务目标和限制", "Goal and constraints")}</summary>
                  <p>{snapshot.context.goal}</p>
                  {snapshot.context.constraints.map((c, i) => (
                    <p key={i}>• {c}</p>
                  ))}
                </details>
                <div className="model-actions">
                  <button
                    disabled={busy || active || archived}
                    onClick={() =>
                      void act(async () => {
                        await configure(mode);
                        await start(snapshot.task.id);
                      })
                    }
                  >
                    {tr("继续任务", "Continue task")}
                  </button>
                  <button
                    disabled={
                      busy ||
                      stopping ||
                      (!active &&
                        !["awaiting_input", "awaiting_approval"].includes(snapshot.task.state) &&
                        !team?.members.some((m) =>
                          ["queued", "running", "awaiting_input", "awaiting_approval"].includes(
                            m.state,
                          ),
                        ))
                    }
                    onClick={() => {
                      setStopping(true);
                      void act(async () => {
                        await command({ kind: "cancel", task_id: snapshot.task.id }, english);
                      });
                    }}
                  >
                    {tr("停止任务", "Stop task")}
                  </button>
                  <button disabled={busy} onClick={() => void readHistory()}>
                    {tr("完整事件", "Full events")}
                  </button>
                </div>
                {!desktop && teamPanel}
                {snapshot.latest_run?.diagnostic && (
                  <div className="error" role="alert">
                    {english
                      ? snapshot.latest_run.diagnostic.message_en
                      : snapshot.latest_run.diagnostic.message_zh}
                    <p>{snapshot.latest_run.diagnostic.detail}</p>
                  </div>
                )}
                {reasonLabel(snapshot.latest_run?.reason) && (
                  <p className="execution-notice">{reasonLabel(snapshot.latest_run?.reason)}</p>
                )}
                {snapshot.context.question && (
                  <section className="execution-question">
                    <h3>{tr("需要你的输入", "Your input is needed")}</h3>
                    <p>
                      {snapshot.context.question.plan_confirmation
                        ? tr(
                            "计划已保存。可补充要求，或明确开始执行。",
                            "The plan is saved. Revise your requirements or explicitly start execution.",
                          )
                        : snapshot.context.question.text}
                    </p>
                    <div className="model-actions">
                      {snapshot.context.question.choices.map((choice) => (
                        <button key={choice} onClick={() => setMessage(choice)}>
                          {choice}
                        </button>
                      ))}
                      {snapshot.context.question.plan_confirmation && (
                        <button
                          className="primary"
                          disabled={busy || active}
                          onClick={() =>
                            void act(async () => {
                              await configure("execute");
                              setMode("execute");
                              await start(snapshot.task.id);
                            })
                          }
                        >
                          {tr("开始执行计划", "Execute this plan")}
                        </button>
                      )}
                    </div>
                  </section>
                )}
                {!!snapshot.context.plan.length && (
                  <ol className="execution-plan">
                    {snapshot.context.plan.map((s) => (
                      <li key={s.id} data-plan-state={s.status}>
                        <span>
                          {s.status === "done" ? "✓" : s.status === "running" ? "◉" : "○"}
                        </span>{" "}
                        {s.text}
                      </li>
                    ))}
                  </ol>
                )}
                {desktop && (
                  <Conversation
                    key={snapshot.task.id}
                    task={snapshot.task.id}
                    sequence={snapshot.task.last_sequence}
                  />
                )}
                <pre
                  className="execution-answer"
                  data-testid="execution-answer"
                  hidden={!!desktop && !active}
                >
                  {live ||
                    snapshot.context.last_text ||
                    (active
                      ? tr("等待模型回复…", "Waiting for model output…")
                      : snapshot.task.state === "awaiting_input"
                        ? tr(
                            "请补充所需信息或确认上方计划。",
                            "Provide the requested input or confirm the plan above.",
                          )
                        : tr(
                            "本次没有完整的文字结果，可查看右侧执行过程。",
                            "No complete text result is available. See the execution trace.",
                          ))}
                </pre>
                {reasoning && (
                  <details>
                    <summary>{tr("服务公开的推理", "Reasoning shared by the service")}</summary>
                    <pre>{reasoning}</pre>
                  </details>
                )}
                {snapshot.context.digest && (
                  <p>
                    {tr(
                      "已整理较早的上下文，原始记录仍可查看；任务目标和用户要求保留。",
                      "Earlier context was condensed. Original records, the goal and user requirements are preserved.",
                    )}
                  </p>
                )}
                {needsReview.map((s) => (
                  <section className="execution-review" key={s.id}>
                    <strong>
                      {tr("结果需要核对：", "Review required: ")}
                      {s.name}
                    </strong>
                    <p>
                      {tr(
                        "继续任务会先查询已保存的执行凭据。有凭据就采用原结果；没有凭据时，需要你核对是否执行过。",
                        "Continue first checks the saved receipt. An existing result is reused; without a receipt, verify what actually happened.",
                      )}
                    </p>
                    <button
                      disabled={busy || active}
                      onClick={() =>
                        void act(async () => {
                          await command(
                            {
                              kind: "resolve_execution_action",
                              task_id: snapshot.task.id,
                              action_id: s.id,
                              resolution: { kind: "not_applied" },
                            },
                            english,
                          );
                        })
                      }
                    >
                      {tr("确认未执行，允许重新运行", "Confirm not applied; allow another attempt")}
                    </button>
                  </section>
                ))}
                <section className="execution-composer">
                  <label>
                    {tr("发送新的要求", "Send a new instruction")}
                    <textarea
                      rows={3}
                      aria-label={tr("发送新的要求", "Send a new instruction")}
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                    />
                  </label>
                  {desktop && <TextAttachments onAttach={(text) => attach(text, false)} />}
                  <button
                    className="primary"
                    disabled={busy || archived || !message.trim()}
                    onClick={() => void sendMessage()}
                  >
                    {active
                      ? tr("加入队列", "Queue message")
                      : ["completed", "awaiting_input"].includes(snapshot.task.state)
                        ? tr("发送并继续", "Send and continue")
                        : tr("保存消息", "Save message")}
                  </button>
                  <small>
                    {tr(
                      "运行时默认排队；点击下方消息的“引导”可调整当前工作。中断或失败后，点击“继续任务”恢复。",
                      "Messages queue while running. Use Guide to steer current work. Interrupted or failed tasks require Continue task.",
                    )}
                  </small>
                </section>
                <section className="execution-messages">
                  {snapshot.messages
                    .filter((m) => m.state !== "delivered")
                    .map((m) => (
                      <article key={m.id} data-message-id={m.id} data-message-state={m.state}>
                        <small>
                          {m.state === "steer_requested"
                            ? tr("等待在安全边界引导", "Steering at the next safe boundary")
                            : m.state === "cancelled"
                              ? tr("已取消", "Cancelled")
                              : tr("尚未处理", "Not yet processed")}
                        </small>
                        <Saved reference={m.content} plain />
                        <button
                          disabled={busy || m.state !== "queued"}
                          onClick={() =>
                            void act(async () => {
                              await command(
                                { kind: "steer", task_id: snapshot.task.id, message_id: m.id },
                                english,
                              );
                            })
                          }
                        >
                          {tr("引导", "Guide")}
                        </button>
                        <QueueEdit task={snapshot.task.id} message={m} />
                      </article>
                    ))}
                </section>
                {needsReview.map((s) => (
                  <section key={"result-" + s.id} className="execution-review">
                    <label>
                      {tr(
                        "已执行的结果（确认后填写）",
                        "Existing result (verify before recording)",
                      )}
                      <textarea
                        aria-label={tr(
                          "已执行的结果（确认后填写）",
                          "Existing result (verify before recording)",
                        )}
                        value={reviewResults[s.id] || ""}
                        onChange={(e) =>
                          setReviewResults({ ...reviewResults, [s.id]: e.target.value })
                        }
                      />
                    </label>
                    <button
                      disabled={busy || active || !reviewResults[s.id]?.trim()}
                      onClick={() =>
                        void act(async () => {
                          await command(
                            {
                              kind: "resolve_execution_action",
                              task_id: snapshot.task.id,
                              action_id: s.id,
                              resolution: { kind: "applied", output: reviewResults[s.id] },
                            },
                            english,
                          );
                        })
                      }
                    >
                      {tr("确认已执行，采用此结果", "Confirm applied; use this result")}
                    </button>
                  </section>
                ))}
                {showHistory && (
                  <section className="execution-history">
                    <h3>{tr("完整事件记录", "Complete event history")}</h3>
                    {history?.events.map((e) => (
                      <HistoryEvent key={e.sequence} event={e} />
                    ))}
                    <button disabled={busy} onClick={() => void readHistory()}>
                      {tr("从头查看", "Read from start")}
                    </button>
                    {history?.has_more && (
                      <button disabled={busy} onClick={() => void readHistory(history.next_after)}>
                        {tr("下一页", "Next page")}
                      </button>
                    )}
                  </section>
                )}
              </>
            )
          )}
        </main>
        {desktop &&
          (prefs && !prefs.inspector_closed ? (
            <ResizeHandle
              side="right"
              width={prefs.inspector_width}
              onChange={(inspector_width) => desktop.onPreferences({ ...prefs, inspector_width })}
              label={tr("调整详情栏宽度", "Resize details panel")}
            />
          ) : (
            <div />
          ))}
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
                  <button
                    onClick={() =>
                      void act(async () => {
                        await configure(mode);
                      })
                    }
                  >
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
                  <section>
                    <h3>{tr("网页", "Browser")}</h3>
                    <p>
                      {tr(
                        "日常浏览器接入将在 P08 实现。",
                        "Connection to your everyday browser arrives in P08.",
                      )}
                    </p>
                  </section>
                </>
              )}
            </>
          )}
        </aside>
      </div>
      {fileWorkspace && selected && (
        <FileWorkbench key={selected} task={selected} onClose={() => setFileWorkspace(false)} />
      )}
    </div>
  );
}
