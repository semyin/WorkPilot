import { useEffect, useState } from "react";
import type { Task, WorkspaceProject } from "../generated/contracts";
import { workspaceQuery, useWords, taskState } from "../workspaceClient";
import { Dialog } from "./Dialog";
import { Icon } from "./Icon";
export function TaskSearch({
  english,
  onSelect,
  onClose,
  initialArchived = false,
  onArchiveFilter,
  projects = [],
}: {
  english: boolean;
  onSelect: (id: string) => void;
  onClose: () => void;
  initialArchived?: boolean;
  onArchiveFilter?: (value: boolean) => void;
  projects?: WorkspaceProject[];
}) {
  const tr = useWords(),
    [query, setQuery] = useState(""),
    [archived, setArchived] = useState(initialArchived);
  const [tasks, setTasks] = useState<Task[]>([]),
    [index, setIndex] = useState(0),
    [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError("");
    setTasks([]);
    setIndex(0);
    const timer = setTimeout(
      () =>
        void workspaceQuery({
          kind: "tasks",
          project_id: null,
          archived,
          search: query,
          before: null,
          limit: 48,
        })
          .then((r) => {
            if (live && r.kind === "tasks") {
              setTasks(r.tasks);
              setLoading(false);
            }
          })
          .catch((e) => {
            if (live) {
              setError(String(e));
              setLoading(false);
            }
          }),
      140,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, archived]);
  const choose = (id: string) => {
    onClose();
    onSelect(id);
  };
  const highlight = (text: string) => {
    const index = text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
    if (!query.trim() || index < 0) return text;
    const end = index + query.trim().length;
    return (
      <>
        {text.slice(0, index)}
        <mark>{text.slice(index, end)}</mark>
        {text.slice(end)}
      </>
    );
  };
  return (
    <Dialog
      title={tr("搜索任务", "Search tasks")}
      onClose={onClose}
      className="wb-command-dialog"
      customLayout
    >
      <div className="wb-search-shell">
        <div className="wb-search-input-row">
          <Icon name="search" />
          <input
            autoFocus
            type="search"
            aria-label={tr("搜索任务", "Search tasks")}
            placeholder={tr("输入任务名称…", "Search task titles…")}
            value={query}
            role="combobox"
            aria-expanded="true"
            aria-controls="wb-search-results"
            aria-activedescendant={tasks[index] ? `wb-search-${index}` : undefined}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (["ArrowUp", "ArrowDown"].includes(e.key) && tasks.length) {
                e.preventDefault();
                const next =
                  (index + (e.key === "ArrowDown" ? 1 : -1) + tasks.length) % tasks.length;
                setIndex(next);
                document.getElementById(`wb-search-${next}`)?.scrollIntoView({ block: "nearest" });
              }
              if (e.key === "Enter" && tasks[index]) {
                e.preventDefault();
                choose(tasks[index].id);
              }
            }}
          />
          <button type="button" className="wb-search-escape" onClick={onClose}>
            Esc
          </button>
        </div>
        <div className="wb-search-caption">
          <span>{tr("最近任务 · 最多显示 48 条", "Recent tasks · Up to 48 results")}</span>
          <label>
            <input
              type="checkbox"
              checked={archived}
              onChange={(e) => {
                setArchived(e.target.checked);
                onArchiveFilter?.(e.target.checked);
              }}
            />
            {tr("已归档", "Archived")}
          </label>
        </div>
        <div
          id="wb-search-results"
          className="wb-search-results"
          role="listbox"
          aria-label={tr("搜索结果", "Search results")}
        >
          {tasks.map((task, i) => (
            <button
              type="button"
              className={`wb-search-result ${index === i ? "wb-active" : ""}`}
              role="option"
              aria-selected={index === i}
              tabIndex={-1}
              id={`wb-search-${i}`}
              key={task.id}
              onClick={() => choose(task.id)}
            >
              <span className="wb-search-task-icon">
                <Icon name="chat" />
              </span>
              <span className="wb-search-result-copy">
                <strong>{highlight(task.title)}</strong>
                <small>
                  {projects.find((p) => p.id === task.project_id)?.settings.name ||
                    tr("独立任务", "Standalone task")}
                  <i>·</i>
                  {taskState(task.state, english)}
                </small>
              </span>
              <Icon name="right" />
            </button>
          ))}
          {loading && <p role="status">{tr("正在查找…", "Searching…")}</p>}
          {!loading && !tasks.length && !error && (
            <p>
              {tr("没有找到任务，试试其它关键词。", "No tasks found. Try a different keyword.")}
            </p>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer>
          <span>
            ↑ ↓ {tr("选择", "Select")}　Enter {tr("打开", "Open")}
          </span>
          <span>Esc {tr("关闭", "Close")}</span>
        </footer>
      </div>
    </Dialog>
  );
}
