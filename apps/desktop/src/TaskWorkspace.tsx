import { MigrationRecovery } from "./task-archive/MigrationRecovery";
import { TaskMessages } from "./task-workspace/TaskMessages";
import { HistoryEvent } from "./task-workspace/HistoryEvent";
import { TaskCreateForm } from "./task-workspace/TaskCreateForm";
import { TaskInspector } from "./task-workspace/TaskInspector";
import { TaskWorkspaceHeader } from "./task-workspace/TaskWorkspaceHeader";
import { taskLabels } from "./task-workspace/taskLabels";
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { TaskReadStore } from "./task-workspace/taskReadStore";
import { readTaskDetail, useTaskSelection } from "./task-workspace/useTaskSelection";
import type {
  ExecutionConfig,
  ExecutionLimits,
  ProfileCatalog,
  Task,
  WorkMode,
  EventPage,
  WorkspaceProject,
} from "./generated/contracts";
import { executionCommand as command } from "./executionClient";
import { ToolPanel, initialTools } from "./ToolPanel";
import { TeamPanel } from "./TeamPanel";
import { ProjectSidebar } from "./ProjectSidebar";
import { Conversation } from "./Conversation";
import { MediaPanel } from "./MediaPanel";
import { MemoryPanel } from "./MemoryPanel";
import { SchedulePanel } from "./SchedulePanel";
import { media, attachmentMarkers } from "./mediaClient";
import type { MediaAsset } from "./generated/contracts";
import { ResizeHandle } from "./ResizeHandle";
import { FileWorkbench } from "./FileWorkbench";
import { ExtensionPanel } from "./ExtensionPanel";
import { workspaceAction } from "./workspaceClient";
import type { TaskDesktop } from "./task-workspace/types";
const limitsDefault: ExecutionLimits = {
  max_steps: 32,
  max_duration_ms: 300000,
  context_bytes: 65536,
  max_result_bytes: 32768,
};
export function TaskWorkspace({
  language,
  onClose,
  onModels,
  desktop,
}: {
  language: string;
  onClose: () => void;
  onModels: () => void;
  desktop?: TaskDesktop;
}) {
  const english = language === "en";
  const tr = (zh: string, en: string) => (english ? en : zh);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [catalog, setCatalog] = useState<ProfileCatalog>({ profiles: [], global_default: null });
  const [selected, setSelected] = useState<string | null>(
    localStorage.getItem("workpilot.execution"),
  );
  const [taskReads] = useState(() => new TaskReadStore());
  useSyncExternalStore(taskReads.subscribe, taskReads.version);
  const { detail, team, error: readError, selection } = useTaskSelection(selected, taskReads);
  const snapshot = detail
    ? { ...detail.snapshot, task: taskReads.task(detail.snapshot.task) }
    : null;
  const [creating, setCreating] = useState(!selected);
  const [browserOpen, setBrowserOpen] = useState(false);
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
  const live = detail?.live_text || "";
  const reasoning = detail?.live_reasoning || "";
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const stopping = !!selected && taskReads.stopping(selected);
  const [history, setHistory] = useState<EventPage | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [reviewResults, setReviewResults] = useState<Record<string, string>>({});
  const archived = detail?.archived || false;
  const effectiveModel = detail?.effective_profile
    ? `${detail.effective_profile.label} · ${detail.effective_profile.model}`
    : tr("尚未选择模型", "No model selected");
  const effectivePermission = detail?.effective_permission || "request_approval";
  const [renaming, setRenaming] = useState<string | null>(null);
  const [fileWorkspace, setFileWorkspace] = useState(false);
  const [extensionsOpen, setExtensionsOpen] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  const [initialAttachments, setInitialAttachments] = useState<MediaAsset[]>([]);
  const [messageAttachments, setMessageAttachments] = useState<MediaAsset[]>([]);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  useEffect(() => {
    setMessageAttachments([]);
    setAttachmentBusy(false);
  }, [selected, creating]);
  const settingsTask = useRef("");
  const active =
    stopping ||
    (!!snapshot &&
      (["running", "stopping"].includes(snapshot.task.state) ||
        (snapshot.task.state === "queued" && !!snapshot.latest_run)));
  const completedWithoutMessages =
    snapshot?.task.state === "completed" &&
    !snapshot.messages.some((m) => ["queued", "steer_requested"].includes(m.state));
  const { status, reasonLabel } = taskLabels(english);
  const chooseTask = (task: string | null) => {
    if (selection.current.task !== task)
      selection.current = { task, generation: selection.current.generation + 1 };
    setSelected(task);
  };
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const read = taskReads.beginRead();
        const [list, profiles] = await Promise.all([
          command({ kind: "read", query: { kind: "executions", limit: 64 } }),
          command({ kind: "read", query: { kind: "profiles" } }),
        ]);
        if (!disposed) {
          if (list.kind === "executions") {
            taskReads.observe(list.tasks, read);
            setTasks(list.tasks);
          }
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
  }, [taskReads]);
  useEffect(() => {
    setError("");
    setHistory(null);
    setShowHistory(false);
  }, [selected]);
  useEffect(() => {
    if (detail && settingsTask.current !== selected) {
      settingsTask.current = selected || "";
      setMode(detail.snapshot.task.mode);
      setProfile(detail.snapshot.task.profile_id || "");
      setLimits(detail.snapshot.config.limits);
    }
  }, [detail, selected]);
  const act = async (work: () => Promise<void>) => {
    const origin = selection.current;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      if (selection.current === origin) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const stopTask = (task: string) => {
    const token = taskReads.requestStop(task);
    return act(async () => {
      try {
        await command({ kind: "cancel", task_id: task }, english);
        taskReads.acknowledgeStop(task, token);
      } catch (e) {
        taskReads.rejectStop(task, token);
        throw e;
      }
    });
  };
  const start = (task: string) => command({ kind: "start_execution", task_id: task }, english);
  const create = (startNow = true) =>
    act(async () => {
      const data = {
        ...config,
        goal: config.goal + attachmentMarkers(initialAttachments),
        constraints: constraints.split("\n").filter((s) => s.trim()),
        title: config.title.trim() || config.goal.slice(0, 60),
      };
      const response = await command({ kind: "create_execution", config: data }, english);
      if (response.kind === "receipt" && response.receipt.task_id) {
        const task = response.receipt.task_id;
        if (initialAttachments.length)
          await media(task, { kind: "bind", asset_ids: initialAttachments.map((a) => a.id) });
        setInitialAttachments([]);
        chooseTask(task);
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
      const origin = selection.current;
      if (messageAttachments.length)
        await media(selected, { kind: "bind", asset_ids: messageAttachments.map((a) => a.id) });
      await command(
        {
          kind: "enqueue",
          task_id: selected,
          text: message + attachmentMarkers(messageAttachments),
        },
        english,
      );
      if (selection.current === origin) {
        setMessageAttachments([]);
        setMessage("");
      }
      const current = await readTaskDetail(selected, taskReads);
      // A user send to a completed/waiting task explicitly starts a new turn.
      // Interrupted/failed tasks always retain the separate Continue control.
      if (["completed", "awaiting_input"].includes(current.snapshot.task.state))
        await start(selected);
    });
  const readHistory = (after = 0) =>
    act(async () => {
      if (!selected) return;
      const origin = selection.current;
      const r = await command(
        { kind: "read", query: { kind: "events", task_id: selected, after, limit: 128 } },
        english,
      );
      if (selection.current === origin && r.kind === "events") {
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
    chooseTask(null);
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
    chooseTask(id);
    setCreating(false);
    setError("");
    setMessage("");
    setRenaming(null);
  };
  const toolPanel = snapshot && (
    <ToolPanel
      key={`tools-${snapshot.task.id}`}
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
        key={`team-${snapshot.task.id}`}
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
      <TaskWorkspaceHeader
        english={english}
        desktop={desktop}
        selected={selected}
        onClose={onClose}
        onModels={onModels}
        open={{
          extensions: () => setExtensionsOpen(true),
          files: () => setFileWorkspace(true),
          browser: () => setBrowserOpen(true),
          memory: () => setMemoryOpen(true),
          schedules: () => setSchedulesOpen(true),
          media: () => setMediaOpen(true),
        }}
      />
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
                taskReads={taskReads}
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
            {tasks.map((row) => {
              const task = taskReads.task(row);
              return (
                <button
                  key={task.id}
                  data-execution-id={task.id}
                  className={!creating && selected === task.id ? "chosen" : ""}
                  onClick={() => {
                    selectTask(task.id);
                  }}
                >
                  <strong>{task.title}</strong>
                  <small>{status(taskReads.state(task))}</small>
                </button>
              );
            })}
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
          {(error || readError) && (
            <div className="error" role="alert">
              {error || readError}
            </div>
          )}
          {creating ? (
            <TaskCreateForm
              english={english}
              desktop={desktop}
              config={config}
              setConfig={setConfig}
              constraints={constraints}
              setConstraints={setConstraints}
              tools={tools}
              setTools={setTools}
              catalog={catalog}
              initialAttachments={initialAttachments}
              setInitialAttachments={setInitialAttachments}
              setAttachmentBusy={setAttachmentBusy}
              attachmentBusy={attachmentBusy}
              busy={busy}
              modes={modes}
              profileOptions={profileOptions}
              create={create}
            />
          ) : (
            snapshot && (
              <>
                <div className="execution-title">
                  <h2>{snapshot.task.title}</h2>
                  <span
                    data-testid="execution-status"
                    data-task-id={snapshot.task.id}
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
                <MigrationRecovery key={`recovery-${snapshot.task.id}`} task={snapshot.task.id} />
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
                    disabled={busy || active || archived || completedWithoutMessages}
                    title={
                      completedWithoutMessages
                        ? tr("发送新的要求后再继续。", "Send a new instruction to continue.")
                        : undefined
                    }
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
                    onClick={() => void stopTask(snapshot.task.id)}
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
                {snapshot.latest_run?.reason === "awaiting_media_approval" && (
                  <button onClick={() => setMediaOpen(true)}>
                    {tr("查看文件或图片待批准操作", "Review pending file or image generation")}
                  </button>
                )}
                {snapshot.latest_run?.reason === "awaiting_extension_approval" && (
                  <button onClick={() => setExtensionsOpen(true)}>
                    {tr("查看扩展待批准操作", "Review pending extension action")}
                  </button>
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
                    key={`conversation-${snapshot.task.id}`}
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
                <TaskMessages
                  english={english}
                  desktop={!!desktop}
                  selected={selected}
                  snapshot={snapshot}
                  message={message}
                  setMessage={setMessage}
                  messageAttachments={messageAttachments}
                  setMessageAttachments={setMessageAttachments}
                  setAttachmentBusy={setAttachmentBusy}
                  busy={busy}
                  attachmentBusy={attachmentBusy}
                  archived={archived}
                  active={active}
                  sendMessage={sendMessage}
                  act={act}
                />
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
        <TaskInspector
          english={english}
          prefs={prefs}
          creating={creating}
          snapshot={snapshot}
          toolPanel={toolPanel}
          teamPanel={teamPanel}
          browserOpen={browserOpen}
          setBrowserOpen={setBrowserOpen}
          busy={busy}
          active={active}
          mode={mode}
          setMode={setMode}
          modes={modes}
          profile={profile}
          setProfile={setProfile}
          profileOptions={profileOptions}
          limits={limits}
          setLimits={setLimits}
          desktop={!!desktop}
          saveSettings={() =>
            void act(async () => {
              await configure(mode);
            })
          }
        />
      </div>
      {mediaOpen && (
        <MediaPanel
          key={`media-${creating ? "global" : selected || "global"}`}
          task={creating ? null : selected}
          onClose={() => setMediaOpen(false)}
          onAttach={(asset) => {
            if (!selected || asset.task_id !== selected)
              throw new Error(
                tr("请在附件所属任务中使用。", "Use the attachment in its own task."),
              );
            if (
              messageAttachments.length >= 16 &&
              !messageAttachments.some((a) => a.id === asset.id)
            )
              throw new Error(
                tr("一条消息最多添加 16 个附件。", "At most 16 attachments per message."),
              );
            setMessageAttachments((old) =>
              old.some((a) => a.id === asset.id) ? old : [...old, asset],
            );
            setMediaOpen(false);
          }}
        />
      )}
      {memoryOpen && (
        <MemoryPanel
          projects={desktop?.overview?.projects || []}
          initialProject={creating ? config.project_id : snapshot?.task.project_id || null}
          onClose={() => setMemoryOpen(false)}
          onNavigate={selectTask}
        />
      )}
      {schedulesOpen && (
        <SchedulePanel
          projects={desktop?.overview?.projects || []}
          catalog={catalog}
          initialProject={creating ? config.project_id : snapshot?.task.project_id || null}
          onClose={() => setSchedulesOpen(false)}
          onNavigate={selectTask}
        />
      )}
      {fileWorkspace && selected && (
        <FileWorkbench
          key={`files-${selected}`}
          task={selected}
          onClose={() => setFileWorkspace(false)}
        />
      )}
      {extensionsOpen && (
        <ExtensionPanel
          key={`extensions-${selected || "global"}`}
          task={selected}
          onClose={() => setExtensionsOpen(false)}
          onDraft={(goal) => {
            setConfig({
              ...config,
              title: tr("创建技能", "Create skill"),
              goal:
                tr(
                  "请为下列需求创建可复用技能草稿。保存技能说明和必要的脚本、参考资料或模板，供我检查。不要包含凭据，不要声称已启用；最后说明如何检查和测试。需求：\n",
                  "Create a reusable skill draft for the following requirement. Save the skill instructions and necessary scripts, references or templates for my review. Include no credentials. Do not claim it is enabled; explain review and testing steps. Requirement:\n",
                ) + goal,
              mode: "plan",
              profile_id: snapshot?.task.profile_id || config.profile_id,
              project_id: snapshot?.config.project_id || config.project_id,
            });
            setCreating(true);
            setExtensionsOpen(false);
          }}
        />
      )}
    </div>
  );
}
