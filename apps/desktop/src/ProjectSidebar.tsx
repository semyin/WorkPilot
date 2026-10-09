import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { TaskReadStore } from "./task-workspace/taskReadStore";
import type { WorkspaceProject, ProfileCatalog, Task } from "./generated/contracts";
import { workspaceAction, workspaceQuery, useWords, taskState } from "./workspaceClient";
import { Icon, type IconName } from "./workbench/Icon";
import { Menu } from "./workbench/Menu";
import { Dialog } from "./workbench/Dialog";
import { ProjectGroup } from "./workbench/ProjectGroup";
import { ProjectDialog } from "./workbench/ProjectDialog";
import { TaskSearch } from "./workbench/TaskSearch";
import appIcon from "../../../assets/icons/png/128.png";

export function ProjectSidebar({
  projects,
  catalog,
  selected,
  onSelect,
  onNew,
  onProjectsChanged,
  english,
  taskReads,
  navigation,
  onCollapse,
  onTasks,
  taskPage = true,
  busy = false,
}: {
  projects: WorkspaceProject[];
  catalog: ProfileCatalog;
  selected: string | null;
  onSelect: (id: string) => void;
  onNew: (project: WorkspaceProject | null) => void;
  onProjectsChanged: () => void;
  english: boolean;
  taskReads: TaskReadStore;
  navigation?: Array<{ label: string; icon: IconName; active?: boolean; onClick: () => void }>;
  onCollapse?: () => void;
  onTasks?: () => void;
  taskPage?: boolean;
  busy?: boolean;
}) {
  useSyncExternalStore(taskReads.subscribe, taskReads.version);
  const tr = useWords();
  const [project, setProject] = useState(localStorage.getItem("workpilot.project") || "");
  const [archived, setArchived] = useState(false),
    [tasks, setTasks] = useState<Task[]>([]);
  const [before, setBefore] = useState<string | null>(null),
    [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0);
  const [editing, setEditing] = useState<WorkspaceProject | null | undefined>(undefined);
  const [search, setSearch] = useState(false);
  const [menu, setMenu] = useState<{
    task: Task;
    anchor: HTMLElement;
    point?: { x: number; y: number };
  } | null>(null);
  const [rename, setRename] = useState<Task | null>(null),
    [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const [loadedQuery, setLoadedQuery] = useState("");
  const queryKey = `${archived}:${before || ""}`;
  const visibleTasks = loadedQuery === queryKey ? tasks : [];
  useEffect(() => {
    localStorage.setItem("workpilot.project", project);
  }, [project]);
  useEffect(() => {
    const gen = ++generation.current;
    let timer: ReturnType<typeof setTimeout>,
      disposed = false;
    const poll = async () => {
      try {
        const read = taskReads.beginRead();
        const r = await workspaceQuery({
          kind: "tasks",
          project_id: null,
          archived,
          search: "",
          before,
          limit: 48,
        });
        if (!disposed && gen === generation.current && r.kind === "tasks") {
          taskReads.observe(r.tasks, read);
          setTasks(r.tasks);
          setLoadedQuery(`${archived}:${before || ""}`);
          setNext(r.next_before);
          setError("");
        }
      } catch (e) {
        if (!disposed) setError(String(e));
      }
      if (!disposed) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [archived, before, taskReads, refresh]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        !(e.ctrlKey || e.metaKey) ||
        e.isComposing ||
        document.querySelector(
          "dialog[open], .workspace-modal, .model-overlay:not(.workspace-root)",
        )
      )
        return;
      if (e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearch(true);
      }
      if (e.key.toLowerCase() === "n" && !busy) {
        e.preventDefault();
        onNew(projects.find((p) => p.id === project) || null);
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onNew, project, projects, busy]);
  const mutate = async (action: () => Promise<unknown>) => {
    setSaving(true);
    setError("");
    try {
      await action();
      setRefresh((x) => x + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };
  const row = (raw: Task, independent = false) => {
    const task = taskReads.task(raw),
      state = taskReads.state(task);
    return (
      <button
        key={task.id}
        type="button"
        data-execution-id={task.id}
        className={`wb-task-link ${selected === task.id ? "wb-current" : ""} ${independent ? "wb-independent" : ""}`}
        disabled={busy}
        title={task.title}
        onClick={() => {
          setProject(task.project_id || "");
          onSelect(task.id);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ task, anchor: e.currentTarget, point: { x: e.clientX, y: e.clientY } });
        }}
        onKeyDown={(e) => {
          if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") {
            e.preventDefault();
            setMenu({ task, anchor: e.currentTarget });
          }
        }}
      >
        {["running", "queued", "awaiting_approval"].includes(state) ? (
          <i className="wb-task-dot wb-live" />
        ) : (
          <Icon name={state === "completed" ? "check" : "chat"} />
        )}
        <span>{task.title}</span>
        <small title={taskState(state, english)}>
          {Date.now() - task.updated_at_ms < 3600000
            ? tr("现在", "Now")
            : new Intl.DateTimeFormat(english ? "en" : "zh-CN", {
                month: "numeric",
                day: "numeric",
              }).format(task.updated_at_ms)}
        </small>
      </button>
    );
  };
  return (
    <aside className="wb-sidebar" aria-label={tr("主导航", "Main navigation")}>
      <div className="wb-brand">
        <img src={appIcon} alt="" />
        <strong>WorkPilot</strong>
        {onCollapse && (
          <button
            type="button"
            className="wb-icon-button"
            aria-label={tr("收起侧栏", "Collapse sidebar")}
            onClick={onCollapse}
          >
            <Icon name="leftPanel" />
          </button>
        )}
      </div>
      <button
        type="button"
        className="wb-new-task"
        aria-label={tr("+ 新建任务", "+ New task")}
        disabled={busy}
        onClick={() => onNew(projects.find((p) => p.id === project) || null)}
      >
        <Icon name="plus" />
        <span>{tr("新建任务", "New task")}</span>
        <kbd>Ctrl + N</kbd>
      </button>
      <nav className="wb-primary-nav">
        <button
          type="button"
          aria-label={tr("搜索任务", "Search tasks")}
          onClick={() => setSearch(true)}
        >
          <Icon name="search" />
          <span>{tr("搜索", "Search")}</span>
          <kbd>Ctrl + K</kbd>
        </button>
        <button
          type="button"
          aria-label={tr("任务", "Tasks")}
          className={taskPage ? "wb-selected" : ""}
          onClick={() => {
            onTasks?.();
            setArchived(false);
            setBefore(null);
          }}
        >
          <Icon name="chat" />
          <span>{tr("任务", "Tasks")}</span>
          <span className="wb-nav-count">{visibleTasks.length}</span>
        </button>
        {navigation
          ?.filter((item) => item.icon !== "settings")
          .map((item) => (
            <button
              type="button"
              className={item.active ? "wb-selected" : ""}
              key={item.label}
              onClick={item.onClick}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
      </nav>
      <div className="wb-sidebar-scroll">
        <div className="wb-section-caption">
          <span>{tr("项目", "Projects")}</span>
          <button
            type="button"
            className="wb-icon-button"
            aria-label={tr("新建项目", "New project")}
            onClick={() => setEditing(null)}
          >
            <Icon name="plus" />
          </button>
        </div>
        <nav className="wb-task-list" aria-label={tr("任务列表", "Task list")}>
          {projects.map((p) => (
            <ProjectGroup
              key={p.id}
              name={p.settings.name}
              count={visibleTasks.filter((t) => t.project_id === p.id).length}
              onSelect={() => setProject(p.id)}
              onSettings={() => setEditing(p)}
              onNew={() => {
                setProject(p.id);
                onNew(p);
              }}
            >
              {visibleTasks.filter((t) => t.project_id === p.id).map((t) => row(t))}
              {!visibleTasks.some((t) => t.project_id === p.id) && (
                <small className="wb-empty-group">{tr("暂无任务", "No tasks")}</small>
              )}
            </ProjectGroup>
          ))}
          <div className="wb-section-caption wb-recent-caption">
            {tr("最近的独立任务", "Recent standalone tasks")}
          </div>
          {visibleTasks
            .filter((t) => !t.project_id || !projects.some((p) => p.id === t.project_id))
            .map((t) => row(t, true))}
          {!visibleTasks.length && (
            <p className="wb-empty-group">{tr("从一个新任务开始。", "Start with a new task.")}</p>
          )}
        </nav>
        <div className="wb-pagination">
          {before && (
            <button type="button" onClick={() => setBefore(null)}>
              {tr("首页", "First")}
            </button>
          )}
          {next && (
            <button type="button" onClick={() => setBefore(next)}>
              {tr("更多任务", "More tasks")}
            </button>
          )}
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="wb-sidebar-bottom">
        {navigation
          ?.filter((item) => item.icon === "settings")
          .map((item) => (
            <button type="button" key={item.label} onClick={item.onClick}>
              <Icon name="settings" />
              <span>{item.label}</span>
            </button>
          ))}
        <div className="wb-local-space">
          <span className="wb-avatar">W</span>
          <div>
            <strong>{tr("个人空间", "Personal space")}</strong>
            <small>{tr("保存在本机", "Saved on this device")}</small>
          </div>
          <span className="wb-status-dot" />
        </div>
      </div>
      {search && (
        <TaskSearch
          projects={projects}
          english={english}
          initialArchived={archived}
          onArchiveFilter={(value) => {
            setArchived(value);
            setBefore(null);
          }}
          onSelect={onSelect}
          onClose={() => setSearch(false)}
        />
      )}
      {editing !== undefined && (
        <ProjectDialog
          project={editing}
          catalog={catalog}
          onClose={() => setEditing(undefined)}
          onSaved={(p) => {
            setProject(p.id);
            setEditing(undefined);
            onProjectsChanged();
          }}
        />
      )}
      {menu && (
        <Menu
          anchor={menu.anchor}
          point={menu.point}
          label={menu.task.title}
          items={[
            { value: "rename", label: tr("重命名", "Rename"), icon: "edit" },
            {
              value: "archive",
              label: archived ? tr("恢复任务", "Restore task") : tr("归档任务", "Archive task"),
              icon: "archive",
              disabled:
                saving ||
                ["running", "stopping", "queued", "awaiting_approval"].includes(
                  taskReads.state(menu.task),
                ),
              description: tr("保留内容与执行记录", "Keep its content and history"),
            },
          ]}
          onClose={() => setMenu(null)}
          onPick={(value) => {
            const target = menu.task;
            if (value === "rename") {
              setRename(target);
              setTitle(target.title);
            } else
              void mutate(() =>
                workspaceAction({ kind: "archive_task", task_id: target.id, archived: !archived }),
              );
          }}
        />
      )}
      {rename && (
        <Dialog
          title={tr("重命名任务", "Rename task")}
          busy={saving}
          onClose={() => setRename(null)}
        >
          <label>
            {tr("新的任务名称", "New task title")}
            <input
              autoFocus
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing && title.trim() && !saving)
                  void mutate(async () => {
                    await workspaceAction({
                      kind: "rename_task",
                      task_id: rename.id,
                      title: title.trim(),
                    });
                    setRename(null);
                  });
              }}
            />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="wb-dialog-actions">
            <button
              type="button"
              className="primary"
              disabled={saving || !title.trim()}
              onClick={() =>
                void mutate(async () => {
                  await workspaceAction({
                    kind: "rename_task",
                    task_id: rename.id,
                    title: title.trim(),
                  });
                  setRename(null);
                })
              }
            >
              {tr("保存名称", "Save title")}
            </button>
          </div>
        </Dialog>
      )}
    </aside>
  );
}
