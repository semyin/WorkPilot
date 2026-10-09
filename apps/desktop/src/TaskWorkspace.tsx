import { useWorkbenchMotion } from "./workbench/motion";
import { CollectionPage, type Collection } from "./workbench/CollectionPage";
import { NewTaskWelcome } from "./workbench/NewTaskWelcome";
import { TaskSession } from "./task-workspace/TaskSession";
import { ComposerControls } from "./workbench/ComposerControls";
import { Icon } from "./workbench/Icon";
import {
  messageDrafts as savedMessages,
  creationDrafts as savedCreations,
} from "./workbench/drafts";
import { TaskMessages } from "./task-workspace/TaskMessages";
import { TaskCreateForm } from "./task-workspace/TaskCreateForm";
import { TaskInspector, type InspectorTab } from "./task-workspace/TaskInspector";
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
  PermissionMode,
} from "./generated/contracts";
import { executionCommand as command } from "./executionClient";
import { ToolPanel, initialTools } from "./ToolPanel";
import { TeamPanel } from "./TeamPanel";
import { ProjectSidebar } from "./ProjectSidebar";
import { MediaPanel } from "./MediaPanel";
import { MemoryPanel } from "./MemoryPanel";
import { SchedulePanel } from "./SchedulePanel";
import { media, attachmentMarkers } from "./mediaClient";
import type { MediaAsset } from "./generated/contracts";
import { ResizeHandle } from "./ResizeHandle";
import { FileWorkbench } from "./FileWorkbench";
import { ExtensionPanel } from "./ExtensionPanel";
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
  useWorkbenchMotion();
  const english = language === "en";
  const [page, setPage] = useState<"tasks" | Collection>("tasks");
  const [focusedArtifact, setFocusedArtifact] = useState<string | null>(null);
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
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("artifacts");
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
  const [message, setMessage] = useState(() => savedMessages.get(selected || "")?.text || "");
  const live = detail?.live_text || "";
  const reasoning = detail?.live_reasoning || "";
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const stopping = !!selected && taskReads.stopping(selected);
  const [history, setHistory] = useState<EventPage | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [reviewResults, setReviewResults] = useState<Record<string, string>>({});
  const archived = detail?.archived || false;
  const effectivePermission = detail?.effective_permission || "request_approval";
  const [fileWorkspace, setFileWorkspace] = useState(false);
  const [extensionsOpen, setExtensionsOpen] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  const [initialAttachments, setInitialAttachments] = useState<MediaAsset[]>([]);
  const [messageAttachments, setMessageAttachments] = useState<MediaAsset[]>(
    () => savedMessages.get(selected || "")?.attachments || [],
  );
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  useEffect(() => {
    setAttachmentBusy(false);
  }, [selected, creating]);
  const messageDrafts = useRef(savedMessages);
  const creationDrafts = useRef(savedCreations);
  const rememberCreation = () => {
    if (creating)
      creationDrafts.current.set(config.project_id || "", {
        config,
        tools,
        constraints,
        attachments: initialAttachments,
      });
  };
  const rememberMessage = () => {
    if (selected)
      messageDrafts.current.set(selected, { text: message, attachments: messageAttachments });
  };
  useEffect(() => {
    if (selected && !creating) {
      if (message || messageAttachments.length)
        savedMessages.set(selected, { text: message, attachments: messageAttachments });
      else savedMessages.delete(selected);
    }
  }, [selected, creating, message, messageAttachments]);
  useEffect(() => {
    if (creating)
      savedCreations.set(config.project_id || "", {
        config,
        tools,
        constraints,
        attachments: initialAttachments,
      });
  }, [creating, config, tools, constraints, initialAttachments]);
  const settingsTask = useRef("");
  const active =
    stopping ||
    (!!snapshot &&
      (["running", "stopping"].includes(snapshot.task.state) ||
        (snapshot.task.state === "queued" && !!snapshot.latest_run)));
  const completedWithoutMessages =
    snapshot?.task.state === "completed" &&
    !snapshot.messages.some((m) => ["queued", "steer_requested"].includes(m.state));
  const { status } = taskLabels(english);
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
        creationDrafts.current.delete(config.project_id || "");
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
  const configure = (selectedMode: WorkMode, selectedProfile = profile) =>
    snapshot &&
    command(
      {
        kind: "configure_execution",
        task_id: snapshot.task.id,
        mode: selectedMode,
        profile_id: selectedProfile || null,
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
      messageDrafts.current.delete(selected);
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
  const newTask = (project: WorkspaceProject | null) => {
    if (busy) return;
    setPage("tasks");
    rememberMessage();
    rememberCreation();
    setMessageAttachments([]);
    setCreating(true);
    chooseTask(null);
    localStorage.removeItem("workpilot.execution");
    setError("");
    setMessage("");
    const draft = creationDrafts.current.get(project?.id || "");
    if (draft) {
      setConfig(draft.config);
      setTools(draft.tools);
      setConstraints(draft.constraints);
      setInitialAttachments(draft.attachments);
      return;
    }
    setInitialAttachments([]);
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
    setPage("tasks");
    if (busy) return;
    rememberMessage();
    rememberCreation();
    chooseTask(id);
    setCreating(false);
    setError("");
    const draft = messageDrafts.current.get(id);
    setMessage(draft?.text || "");
    setMessageAttachments(draft?.attachments || []);
  };
  const renderTools = (approvalsOnly = false) =>
    snapshot && (
      <ToolPanel
        approvalsOnly={approvalsOnly}
        hideApprovals={!!desktop}
        key={`tools-${snapshot.task.id}`}
        task={snapshot.task.id}
        english={english}
        catalog={catalog}
        active={active}
        inherited={!!team && team.root_task_id !== snapshot.task.id}
        start={() => start(snapshot.task.id)}
      />
    );
  const toolPanel = renderTools();
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
  const openInspector = (tab: InspectorTab) => {
    setInspectorTab(tab);
    if (prefs?.inspector_closed) desktop?.onPreferences({ ...prefs, inspector_closed: false });
  };
  const canStop =
    !!snapshot &&
    (active ||
      ["awaiting_input", "awaiting_approval"].includes(snapshot.task.state) ||
      !!team?.members.some((m) =>
        ["queued", "running", "awaiting_input", "awaiting_approval"].includes(m.state),
      ));
  const onContinue = () => {
    if (snapshot)
      void act(async () => {
        await configure(mode);
        await start(snapshot.task.id);
      });
  };
  const changeMode = (value: WorkMode) =>
    void act(async () => {
      const origin = selection.current;
      await configure(value);
      if (selection.current === origin) setMode(value);
    });
  const changeProfile = (value: string) =>
    void act(async () => {
      const origin = selection.current;
      await configure(mode, value);
      if (selection.current === origin) setProfile(value);
    });
  const changePermission = (permission: PermissionMode | null) =>
    void act(async () => {
      if (!snapshot) return;
      const id = snapshot.task.id;
      const current = await command(
        { kind: "read", query: { kind: "task_tools", task_id: id } },
        english,
      );
      if (current.kind === "task_tools")
        await command(
          {
            kind: "configure_task_tools",
            task_id: id,
            settings: { ...current.state.policy.settings, permission },
          },
          english,
        );
    });
  const projectName =
    desktop?.overview?.projects.find(
      (p) => p.id === (creating ? config.project_id : snapshot?.task.project_id),
    )?.settings.name || tr("个人空间", "Personal space");
  return (
    <div
      className={`workbench ${prefs?.sidebar_closed ? "wb-sidebar-collapsed" : ""} ${["tasks", "library"].includes(page) && !creating && !prefs?.inspector_closed ? "wb-panel-open" : ""}`}
      data-sidebar-closed={!!prefs?.sidebar_closed}
      data-inspector-closed={!!prefs?.inspector_closed}
      style={
        prefs
          ? ({
              "--left": `${prefs.sidebar_width}px`,
              "--right": `${prefs.inspector_width}px`,
            } as CSSProperties)
          : undefined
      }
      role={desktop ? "region" : "dialog"}
      aria-label={tr("任务执行", "Task execution")}
    >
      <div className="wb-app-shell">
        {desktop ? (
          <>
            <div
              className="wb-sidebar-wrap"
              inert={prefs?.sidebar_closed}
              aria-hidden={prefs?.sidebar_closed}
            >
              <ProjectSidebar
                projects={desktop.overview?.projects || []}
                catalog={catalog}
                selected={page === "tasks" ? selected : null}
                onTasks={() => setPage("tasks")}
                taskPage={page === "tasks"}
                onSelect={selectTask}
                onNew={newTask}
                onProjectsChanged={desktop.onRefresh}
                english={english}
                taskReads={taskReads}
                busy={busy}
                onCollapse={() =>
                  prefs && desktop.onPreferences({ ...prefs, sidebar_closed: true })
                }
                navigation={[
                  {
                    label: tr("资料库", "Library"),
                    icon: "files",
                    active: page === "library",
                    onClick: () => setPage("library"),
                  },
                  {
                    label: tr("技能与连接", "Skills & connections"),
                    icon: "spark",
                    active: page === "skills",
                    onClick: () => setPage("skills"),
                  },
                  {
                    label: tr("定时任务", "Schedules"),
                    icon: "clock",
                    active: page === "schedules",
                    onClick: () => setPage("schedules"),
                  },
                  { label: tr("设置", "Settings"), icon: "settings", onClick: desktop.onSettings },
                ]}
              />
            </div>
          </>
        ) : (
          <aside className="model-list">
            <button type="button" onClick={() => newTask(null)}>
              {tr("+ 新建任务", "+ New task")}
            </button>
            {tasks.map((task) => (
              <button
                type="button"
                key={task.id}
                data-execution-id={task.id}
                onClick={() => selectTask(task.id)}
              >
                {task.title}
              </button>
            ))}
          </aside>
        )}
        <main className="wb-workspace">
          <TaskWorkspaceHeader
            english={english}
            desktop={desktop}
            selected={selected}
            onClose={onClose}
            onModels={onModels}
            title={
              page !== "tasks"
                ? {
                    library: tr("资料库", "Library"),
                    skills: tr("技能与连接", "Skills & connections"),
                    schedules: tr("定时任务", "Schedules"),
                  }[page]
                : creating
                  ? tr("新任务", "New task")
                  : snapshot?.task.title || tr("正在读取任务…", "Loading task…")
            }
            project={projectName}
            taskPage={page === "tasks"}
            showWorkspace={page === "tasks" || (page === "library" && !!snapshot)}
            status={
              page === "tasks" && !creating && snapshot ? (
                <span
                  className="wb-status-badge"
                  data-testid="execution-status"
                  data-task-id={snapshot.task.id}
                  data-state={stopping ? "stopping" : snapshot.task.state}
                >
                  {active ? (
                    <span className="wb-spinner" />
                  ) : (
                    <Icon
                      name={
                        snapshot.task.state === "completed"
                          ? "check"
                          : snapshot.task.state === "awaiting_approval"
                            ? "shield"
                            : "stop"
                      }
                    />
                  )}
                  {status(stopping ? "stopping" : snapshot.task.state)}
                </span>
              ) : undefined
            }
            open={{
              extensions: () => setExtensionsOpen(true),
              files: () => setFileWorkspace(true),
              browser: () => openInspector("browser"),
              memory: () => setMemoryOpen(true),
              schedules: () => setSchedulesOpen(true),
              media: () => setMediaOpen(true),
            }}
          />
          <div
            className="wb-conversation-scroll"
            key={page + (creating ? `create-${config.project_id || "standalone"}` : selected)}
          >
            {(error || readError) && (
              <div className="error" role="alert">
                {error || readError}
              </div>
            )}
            {page !== "tasks" ? (
              <div className="wb-conversation">
                <CollectionPage
                  key={page}
                  page={page}
                  project={creating ? config.project_id : snapshot?.task.project_id || null}
                  onManage={() =>
                    page === "library"
                      ? setMediaOpen(true)
                      : page === "skills"
                        ? setExtensionsOpen(true)
                        : setSchedulesOpen(true)
                  }
                  onArtifact={(a) => {
                    selectTask(a.task_id);
                    setFocusedArtifact(a.id);
                    openInspector("artifacts");
                  }}
                  onBrowser={() => {
                    setPage("tasks");
                    openInspector("browser");
                  }}
                />
              </div>
            ) : creating ? (
              <div className="wb-conversation">
                <NewTaskWelcome onPrompt={(goal) => setConfig({ ...config, goal })} />
              </div>
            ) : (
              snapshot && (
                <div className="wb-conversation">
                  <TaskSession
                    english={english}
                    desktop={!!desktop}
                    snapshot={snapshot}
                    active={active}
                    busy={busy}
                    archived={archived}
                    toolPanel={toolPanel}
                    teamPanel={teamPanel}
                    approvals={
                      snapshot.task.state === "awaiting_approval" ? renderTools(true) : null
                    }
                    onActivity={() => openInspector("activity")}
                    collaborators={
                      team && team.members.length > 0 ? (
                        <div className="wb-collaborators">
                          {team.members
                            .filter((m) => !m.superseded_by)
                            .map((m) => (
                              <button key={m.task_id} onClick={() => selectTask(m.task_id)}>
                                <span className="wb-initial">{m.role.slice(0, 1)}</span>
                                {m.role}
                                {m.state === "running" ? (
                                  <span className="wb-spinner" />
                                ) : (
                                  <Icon name={m.state === "completed" ? "check" : "clock"} />
                                )}
                              </button>
                            ))}
                        </div>
                      ) : null
                    }
                    setMediaOpen={setMediaOpen}
                    setExtensionsOpen={setExtensionsOpen}
                    setMessage={setMessage}
                    setMode={setMode}
                    act={act}
                    configure={configure}
                    start={start}
                    live={live}
                    reasoning={reasoning}
                    reviewResults={reviewResults}
                    setReviewResults={setReviewResults}
                    showHistory={showHistory}
                    history={history}
                    readHistory={readHistory}
                  />
                </div>
              )
            )}
          </div>
          {page === "tasks" && creating && (
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
              create={create}
              onModels={onModels}
            />
          )}
          {page === "tasks" && !creating && snapshot && (
            <div className="wb-composer-area wb-task-composer">
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
                stopping={stopping}
                canStop={canStop}
                canContinue={!active && !completedWithoutMessages}
                project={projectName}
                onStop={() => void stopTask(snapshot.task.id)}
                onContinue={onContinue}
                controls={(action, attachment) => (
                  <ComposerControls
                    attachment={attachment}
                    catalog={catalog}
                    profile={profile}
                    model={detail?.effective_profile || null}
                    mode={mode}
                    permission={effectivePermission}
                    onProfile={changeProfile}
                    onMode={changeMode}
                    onPermissionDetails={() => openInspector("tools")}
                    onPermission={changePermission}
                    disabled={active || busy || archived}
                    onModels={onModels}
                  >
                    {action}
                  </ComposerControls>
                )}
              />
            </div>
          )}
        </main>

        <TaskInspector
          english={english}
          prefs={prefs}
          creating={creating || !["tasks", "library"].includes(page)}
          focusedArtifact={focusedArtifact}
          snapshot={snapshot}
          toolPanel={toolPanel}
          teamPanel={teamPanel}
          busy={busy}
          active={active}
          mode={mode}
          setMode={setMode}
          profile={profile}
          setProfile={setProfile}
          limits={limits}
          setLimits={setLimits}
          saveSettings={() =>
            void act(async () => {
              await configure(mode);
            })
          }
          tab={inspectorTab}
          onTab={setInspectorTab}
          onClose={() => prefs && desktop?.onPreferences({ ...prefs, inspector_closed: true })}
          onFiles={() => setFileWorkspace(true)}
          catalog={catalog}
          resize={
            desktop && prefs ? (
              <ResizeHandle
                side="right"
                width={prefs.inspector_width}
                onChange={(inspector_width) => desktop.onPreferences({ ...prefs, inspector_width })}
                label={tr("调整详情栏宽度", "Resize details panel")}
              />
            ) : undefined
          }
          readHistory={() => {
            void readHistory();
          }}
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
