import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { TaskReadStore } from "./task-workspace/taskReadStore";
import { invoke } from "@tauri-apps/api/core";
import type {
  WorkspaceProject,
  ProjectSettings,
  ProfileCatalog,
  Task,
  PermissionMode,
} from "./generated/contracts";
import { workspaceAction, workspaceQuery, useWords, taskState } from "./workspaceClient";
const fresh: ProjectSettings = {
  name: "",
  root_path: "",
  default_profile_id: null,
  permission: "request_approval",
  rules: "",
  revision: 0,
};
export function ProjectSidebar({
  projects,
  catalog,
  selected,
  onSelect,
  onNew,
  onProjectsChanged,
  english,
  taskReads,
}: {
  projects: WorkspaceProject[];
  catalog: ProfileCatalog;
  selected: string | null;
  onSelect: (id: string) => void;
  onNew: (project: WorkspaceProject | null) => void;
  onProjectsChanged: () => void;
  english: boolean;
  taskReads: TaskReadStore;
}) {
  useSyncExternalStore(taskReads.subscribe, taskReads.version);
  const tr = useWords();
  const [project, setProject] = useState<string>(localStorage.getItem("workpilot.project") || "");
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [before, setBefore] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [edit, setEdit] = useState<ProjectSettings | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    localStorage.setItem("workpilot.project", project);
    setBefore(null);
  }, [project, search, archived]);
  useEffect(() => {
    const gen = ++generation.current;
    let timer: ReturnType<typeof setTimeout>;
    let disposed = false;
    const poll = async () => {
      try {
        const read = taskReads.beginRead();
        const r = await workspaceQuery({
          kind: "tasks",
          project_id: project || null,
          archived,
          search,
          before,
          limit: 48,
        });
        if (!disposed && gen === generation.current && r.kind === "tasks") {
          taskReads.observe(r.tasks, read);
          setTasks(r.tasks);
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
  }, [project, search, archived, before, taskReads]);
  const selectedProject = projects.find((p) => p.id === project) || null;
  const save = async () => {
    if (!edit) return;
    setSaving(true);
    setError("");
    try {
      const r = await workspaceAction({
        kind: "save_project",
        project_id: editingId,
        settings: edit,
      });
      if (r.kind === "project_saved") {
        setProject(r.project.id);
        setEdit(null);
        onProjectsChanged();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <aside className="workspace-sidebar">
      <button className="primary" onClick={() => onNew(selectedProject)}>
        {tr("+ 新建任务", "+ New task")}
      </button>
      <div className="sidebar-section-title">
        <strong>{tr("项目", "Projects")}</strong>
        <button
          aria-label={tr("新建项目", "New project")}
          onClick={() => {
            setEdit({ ...fresh });
            setEditingId(null);
          }}
        >
          ＋
        </button>
      </div>
      <select
        aria-label={tr("筛选项目", "Filter project")}
        value={project}
        onChange={(e) => setProject(e.target.value)}
      >
        <option value="">{tr("所有项目与独立任务", "All projects and standalone tasks")}</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.settings.name}
          </option>
        ))}
      </select>
      {selectedProject && (
        <button
          className="project-settings-link"
          onClick={() => {
            setEditingId(project);
            setEdit({ ...selectedProject.settings });
          }}
        >
          {tr("项目设置", "Project settings")}
        </button>
      )}
      <input
        type="search"
        aria-label={tr("搜索任务", "Search tasks")}
        placeholder={tr("搜索任务名称…", "Search task titles…")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="sidebar-tabs">
        <button aria-pressed={!archived} onClick={() => setArchived(false)}>
          {tr("任务", "Tasks")}
        </button>
        <button aria-pressed={archived} onClick={() => setArchived(true)}>
          {tr("已归档", "Archived")}
        </button>
      </div>
      <nav className="workspace-task-list" aria-label={tr("任务列表", "Task list")}>
        {tasks.map((row) => {
          const t = taskReads.task(row);
          const state = taskReads.state(t);
          return (
            <button
              key={t.id}
              data-execution-id={t.id}
              className={selected === t.id ? "chosen" : ""}
              onClick={() => onSelect(t.id)}
            >
              <strong>{t.title}</strong>
              <small>
                <i data-state={state} />
                {taskState(state, english)} ·{" "}
                {new Intl.DateTimeFormat(english ? "en" : "zh-CN", {
                  month: "short",
                  day: "numeric",
                }).format(t.updated_at_ms)}
              </small>
            </button>
          );
        })}
        {!tasks.length && <p>{tr("这里还没有任务。", "No tasks here yet.")}</p>}
      </nav>
      <div className="model-actions">
        {before && <button onClick={() => setBefore(null)}>{tr("首页", "First")}</button>}
        {next && <button onClick={() => setBefore(next)}>{tr("更多任务", "More tasks")}</button>}
      </div>
      <small>
        {tr(
          "关窗口后继续运行；托盘菜单可彻底退出。",
          "Closing the window keeps work running. Quit from the tray menu.",
        )}
      </small>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {edit && (
        <div
          className="workspace-modal"
          role="dialog"
          aria-label={tr("项目设置", "Project settings")}
        >
          <section>
            <h2>
              {editingId ? tr("项目设置", "Project settings") : tr("新建项目", "New project")}
            </h2>
            <p>
              {tr(
                "绑定一个真实文件夹。默认模型、权限和规则用于之后新建的任务。",
                "Bind a real folder. Defaults apply to tasks created afterwards.",
              )}
            </p>
            <label>
              {tr("项目名称", "Project name")}
              <input
                value={edit.name}
                onChange={(e) => setEdit({ ...edit, name: e.target.value })}
              />
            </label>
            <label>
              {tr("项目文件夹", "Project folder")}
              <input
                value={edit.root_path}
                onChange={(e) => setEdit({ ...edit, root_path: e.target.value })}
              />
            </label>
            <button
              onClick={() => {
                void invoke<string | null>("pick_project_folder")
                  .then((path) => {
                    if (path) setEdit({ ...edit, root_path: path });
                  })
                  .catch((e) => setError(String(e)));
              }}
            >
              {tr("选择文件夹…", "Choose folder…")}
            </button>
            <label>
              {tr("默认模型", "Default model")}
              <select
                aria-label={tr("默认模型", "Default model")}
                value={edit.default_profile_id || ""}
                onChange={(e) => setEdit({ ...edit, default_profile_id: e.target.value || null })}
              >
                <option value="">{tr("使用全局默认", "Use global default")}</option>
                {catalog.profiles.map(({ profile: p }) => (
                  <option key={p.id} value={p.id}>
                    {p.label} · {p.model}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {tr("默认权限", "Default permission")}
              <select
                aria-label={tr("默认权限", "Default permission")}
                value={edit.permission}
                onChange={(e) => setEdit({ ...edit, permission: e.target.value as PermissionMode })}
              >
                <option value="request_approval">{tr("请求审批", "Request approval")}</option>
                <option value="auto_review">{tr("帮我批准", "Review for me")}</option>
                <option value="full_access">{tr("完全访问", "Full access")}</option>
              </select>
            </label>
            <label>
              {tr("项目规则", "Project rules")}
              <textarea
                rows={4}
                value={edit.rules}
                onChange={(e) => setEdit({ ...edit, rules: e.target.value })}
              />
            </label>
            {error && <p className="error">{error}</p>}
            <div className="model-actions">
              <button
                disabled={saving || !edit.name.trim() || !edit.root_path.trim()}
                onClick={() => void save()}
              >
                {tr("保存项目", "Save project")}
              </button>
              <button
                disabled={saving}
                onClick={() => {
                  setEdit(null);
                  setError("");
                }}
              >
                {tr("取消", "Cancel")}
              </button>
            </div>
          </section>
        </div>
      )}
    </aside>
  );
}
