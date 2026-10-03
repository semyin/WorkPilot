import { useEffect, useRef, useState } from "react";
import type {
  MemoryAction,
  MemoryData,
  MemoryItem,
  WorkspaceProject,
  ContentRef,
} from "./generated/contracts";
import { executionCommand } from "./executionClient";
import { useWords } from "./workspaceClient";
import "./memory.css";

async function memory(action: MemoryAction): Promise<MemoryData> {
  const r = await executionCommand({ kind: "memory", action });
  if (r.kind !== "memory") throw new Error("Unexpected memory response");
  return r.data;
}
async function download(reference: ContentRef) {
  if (reference.bytes > 32 * 1024 * 1024) throw new Error("导出内容过大 / Export is too large");
  const chunks: string[] = [];
  let offset = 0;
  while (offset < reference.bytes) {
    const r = await executionCommand({
      kind: "read",
      query: { kind: "content", object_id: reference.object_id, offset, limit: 65536 },
    });
    if (r.kind !== "content" || r.page.next_offset <= offset)
      throw new Error("无法读取导出文件 / Could not read export");
    chunks.push(r.page.text);
    offset = r.page.next_offset;
  }
  const url = URL.createObjectURL(new Blob(chunks, { type: "application/json;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "workpilot-memories.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
type Editor = { item: MemoryItem | null; text: string; project: string };
export function MemoryPanel({
  projects,
  initialProject,
  onClose,
  onNavigate,
}: {
  projects: WorkspaceProject[];
  initialProject: string | null;
  onClose: () => void;
  onNavigate: (task: string) => void;
}) {
  const tr = useWords();
  const [scope, setScope] = useState(initialProject || ""),
    [search, setSearch] = useState(""),
    [deleted, setDeleted] = useState(false),
    [offset, setOffset] = useState(0);
  const [items, setItems] = useState<MemoryItem[]>([]),
    [fetching, setFetching] = useState(true),
    [total, setTotal] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null),
    [history, setHistory] = useState<{
      current: MemoryItem;
      items: MemoryItem[];
      more: boolean;
    } | null>(null);
  const alive = useRef(true),
    working = useRef(false),
    generation = useRef(0),
    panel = useRef<HTMLElement>(null);
  const load = async () => {
    const gen = ++generation.current;
    const r = await memory({
      kind: "list",
      project_id: scope || null,
      search,
      include_deleted: deleted,
      offset,
      limit: 24,
    });
    if (!alive.current || gen !== generation.current || r.kind !== "list") return;
    if (offset > 0 && offset >= r.total) {
      setOffset(Math.max(0, Math.floor((r.total - 1) / 24) * 24));
      return;
    }
    setItems(r.items);
    setTotal(r.total);
    setFetching(false);
  };
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => {
      alive.current = false;
      generation.current++;
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    setFetching(true);
    let active = true,
      loading = false;
    const tick = async () => {
      if (loading || working.current) return;
      loading = true;
      try {
        await load();
      } catch (e) {
        if (active) {
          setError(String(e));
          setFetching(false);
        }
      } finally {
        loading = false;
      }
    };
    const initial = setTimeout(() => void tick(), 150),
      timer = setInterval(() => void tick(), 2000);
    return () => {
      active = false;
      generation.current++;
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [scope, search, deleted, offset]);
  const act = async (fn: () => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      if (alive.current) await load();
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const change = async (action: MemoryAction, message: string) => {
    await memory(action);
    setNotice(message);
  };
  const scopeName = (id: string | null) =>
    id
      ? projects.find((p) => p.id === id)?.settings.name || tr("已移除的项目", "Removed project")
      : tr("所有项目通用", "Global");
  const state = (m: MemoryItem) =>
    m.deleted
      ? tr("已删除 · 不生效", "Deleted · inactive")
      : {
          suggested: tr("待你确认 · 不生效", "Awaiting confirmation · inactive"),
          confirmed: tr("已确认 · 生效中", "Confirmed · active"),
          rejected: tr("已拒绝 · 不生效", "Rejected · inactive"),
        }[m.state];
  const time = (ms: number) =>
    ms ? new Date(ms).toLocaleString() : tr("早期记录", "Legacy record");
  const historyLabel = (value: string) =>
    ({
      created: tr("你创建并确认", "Created and confirmed by you"),
      suggested: tr("AI 提出候选", "AI proposed"),
      confirmed: tr("你确认了候选", "Confirmed by you"),
      rejected: tr("你拒绝了候选", "Rejected by you"),
      edited_and_confirmed: tr("你修改并确认", "Edited and confirmed by you"),
      deleted: tr("你删除了记忆", "Deleted by you"),
      legacy: tr("早期记录", "Legacy record"),
    })[value] ||
    (value.startsWith("restored:")
      ? tr("你恢复了版本 ", "Restored revision ") + value.split(":")[1]
      : value);
  const viewHistory = async (m: MemoryItem, before: number | null = null) => {
    const r = await memory({
      kind: "history",
      memory_id: m.id,
      before_revision: before,
      limit: 12,
    });
    if (r.kind === "history")
      setHistory((h) => ({
        current: m,
        items: before && h?.current.id === m.id ? [...h.items, ...r.items] : r.items,
        more: r.has_more,
      }));
    setEditor(null);
  };
  const choices = (
    <>
      <option value="">{tr("所有项目通用", "Global")}</option>
      {scope && !projects.some((p) => p.id === scope) && (
        <option value={scope}>{tr("当前项目", "Current project")}</option>
      )}
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.settings.name}
        </option>
      ))}
    </>
  );
  return (
    <div className="memory-backdrop">
      <section
        ref={panel}
        className="memory-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="memory-title"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) {
            e.stopPropagation();
            onClose();
          }
          if (e.key === "Tab") {
            const nodes = panel.current?.querySelectorAll<HTMLElement>(
              "button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href]",
            );
            if (!nodes?.length) return;
            const first = nodes[0],
              last = nodes[nodes.length - 1];
            if (
              e.shiftKey &&
              (document.activeElement === first || document.activeElement === panel.current)
            ) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <header>
          <div>
            <h2 id="memory-title">{tr("记忆", "Memory")}</h2>
            <p>
              {tr(
                "只记住你确认过的偏好。AI 提出的候选不会自动生效。",
                "Only preferences you confirm become active. AI candidates need your review.",
              )}
            </p>
          </div>
          <button disabled={busy} onClick={onClose}>
            {tr("关闭记忆", "Close memory")}
          </button>
        </header>
        <div className="memory-tools">
          <label>
            {tr("查看范围", "Scope")}
            <select
              aria-label={tr("查看记忆范围", "Memory scope")}
              value={scope}
              disabled={busy}
              onChange={(e) => {
                setScope(e.target.value);
                setOffset(0);
                setHistory(null);
                setEditor(null);
              }}
            >
              {choices}
            </select>
          </label>
          <label>
            {tr("搜索内容", "Search")}
            <input
              aria-label={tr("搜索记忆", "Search memories")}
              disabled={busy}
              value={search}
              maxLength={64}
              onChange={(e) => {
                setSearch(e.target.value);
                setOffset(0);
              }}
            />
          </label>
          <label className="memory-check">
            <input
              type="checkbox"
              disabled={busy}
              checked={deleted}
              onChange={(e) => {
                setDeleted(e.target.checked);
                setOffset(0);
              }}
            />
            {tr("显示已删除", "Include deleted")}
          </label>
          <button
            disabled={busy}
            onClick={() => {
              setHistory(null);
              setEditor({ item: null, text: "", project: scope });
            }}
          >
            {tr("添加记忆", "Add memory")}
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const r = await memory({ kind: "export", project_id: scope || null });
                if (r.kind === "export") {
                  await download(r.content);
                  setNotice(
                    tr(
                      `已导出 ${r.count} 条生效中的记忆。`,
                      `Exported ${r.count} active memories.`,
                    ),
                  );
                }
              })
            }
          >
            {tr("导出已确认记忆", "Export confirmed memories")}
          </button>
        </div>
        <div className="memory-status" aria-live="polite">
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
        </div>
        <div className="memory-body">
          <p className="memory-hint">
            {scope
              ? tr(
                  "这里显示当前项目和通用记忆。其他项目的记忆不会被当前任务读取。",
                  "Showing this project and global memories. Other projects' memories are excluded.",
                )
              : tr(
                  "这里显示通用记忆。请选择一个项目查看它的专属记忆。",
                  "Showing global memories. Select a project to view its own memories.",
                )}
          </p>
          {editor && (
            <form
              className="memory-editor"
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  await change(
                    {
                      kind: "save",
                      memory_id: editor.item?.id || null,
                      revision: editor.item?.revision || 0,
                      project_id: editor.project || null,
                      text: editor.text,
                    },
                    tr(
                      "已保存并确认，下次模型调用开始使用。",
                      "Saved and confirmed for the next model call.",
                    ),
                  );
                  setEditor(null);
                });
              }}
            >
              <h3>{editor.item ? tr("修改记忆", "Edit memory") : tr("添加记忆", "Add memory")}</h3>
              <label>
                {tr("适用范围", "Applies to")}
                <select
                  aria-label={tr("记忆适用范围", "Memory applies to")}
                  disabled={busy}
                  value={editor.project}
                  onChange={(e) => setEditor({ ...editor, project: e.target.value })}
                >
                  {choices}
                </select>
              </label>
              <label>
                {tr("记忆内容", "Preference")}
                <textarea
                  aria-label={tr("记忆内容", "Memory text")}
                  required
                  maxLength={4096}
                  rows={4}
                  disabled={busy}
                  value={editor.text}
                  onChange={(e) => setEditor({ ...editor, text: e.target.value })}
                />
              </label>
              <small>
                {tr(
                  "保存代表你确认这条偏好。请勿填写密码或密钥。",
                  "Saving confirms this preference. Do not include passwords or keys.",
                )}
              </small>
              {new TextEncoder().encode(editor.text).length > 4096 && (
                <p role="alert">
                  {tr(
                    "内容过长，请缩短后再保存。",
                    "This preference is too long. Shorten it before saving.",
                  )}
                </p>
              )}
              <div className="memory-actions">
                <button
                  type="submit"
                  disabled={
                    busy ||
                    !editor.text.trim() ||
                    new TextEncoder().encode(editor.text).length > 4096
                  }
                >
                  {tr("保存并确认", "Save and confirm")}
                </button>
                <button type="button" disabled={busy} onClick={() => setEditor(null)}>
                  {tr("取消编辑", "Cancel edit")}
                </button>
              </div>
            </form>
          )}
          {history && (
            <section className="memory-history" aria-label={tr("记忆历史", "Memory history")}>
              <div className="memory-actions">
                <h3>{tr("修改历史", "Revision history")}</h3>
                <button disabled={busy} onClick={() => setHistory(null)}>
                  {tr("收起历史", "Close history")}
                </button>
              </div>
              <p>
                {tr(
                  "恢复会新增一条记录；恢复待确认或已拒绝版本，不会让它自动生效。",
                  "Restore adds a revision. Restoring a candidate or rejected entry does not activate it.",
                )}
              </p>
              {history.items.map((v) => (
                <article key={v.revision} className="memory-revision">
                  <div>
                    <strong>
                      {tr("版本 ", "Revision ") + v.revision} · {historyLabel(v.change)}
                    </strong>
                    <small>
                      {time(v.updated_at_ms)} · {state(v)} · {scopeName(v.project_id)}
                    </small>
                    <p>{v.text}</p>
                  </div>
                  {!v.deleted && v.revision !== history.current.revision && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await change(
                            {
                              kind: "restore",
                              memory_id: v.id,
                              revision: history.current.revision,
                              target_revision: v.revision,
                            },
                            tr("已恢复所选版本。", "Selected revision restored."),
                          );
                          setHistory(null);
                        })
                      }
                    >
                      {tr("恢复此版本", "Restore this revision")}
                    </button>
                  )}
                </article>
              ))}
              {history.more && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      viewHistory(
                        history.current,
                        history.items[history.items.length - 1].revision,
                      ),
                    )
                  }
                >
                  {tr("更早的版本", "Earlier revisions")}
                </button>
              )}
            </section>
          )}
          <div className="memory-list" aria-label={tr("记忆列表", "Memory list")}>
            {fetching && <p role="status">{tr("正在加载记忆…", "Loading memories…")}</p>}
            {!fetching && items.length === 0 && (
              <div className="memory-empty">
                {search
                  ? tr("没有找到匹配的记忆。", "No matching memories.")
                  : tr(
                      "这个范围还没有记忆。你可以手动添加，也可以在任务中让 AI 提出候选。",
                      "No memories in this scope. Add one yourself or ask AI to propose a candidate in a task.",
                    )}
              </div>
            )}
            {!fetching &&
              items.map((m) => (
                <article
                  className={`memory-card ${m.deleted ? "memory-deleted" : ""}`}
                  key={m.id}
                  data-memory-id={m.id}
                >
                  <div className="memory-card-top">
                    <span className={`memory-badge ${m.state}`}>{state(m)}</span>
                    <small>{scopeName(m.project_id)}</small>
                  </div>
                  <p className="memory-text">{m.text}</p>
                  <div className="memory-source">
                    <small>
                      {tr("来源：", "Source: ")}
                      {m.source_label}
                    </small>
                    {m.source_quote && <blockquote>{m.source_quote}</blockquote>}
                    {m.source_task_id && (
                      <button
                        disabled={busy}
                        onClick={() => {
                          onNavigate(m.source_task_id!);
                          onClose();
                        }}
                      >
                        {tr("查看来源任务", "Open source task")}
                      </button>
                    )}
                    <small>
                      {tr("更新于 ", "Updated ")}
                      {time(m.updated_at_ms)} · {tr("版本 ", "Revision ")}
                      {m.revision}
                    </small>
                  </div>
                  <div className="memory-actions">
                    {!m.deleted && m.state === "suggested" && (
                      <>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act(() =>
                              change(
                                {
                                  kind: "decide",
                                  memory_id: m.id,
                                  revision: m.revision,
                                  confirm: true,
                                },
                                tr(
                                  "已确认，下次模型调用开始使用。",
                                  "Confirmed for the next model call.",
                                ),
                              ),
                            )
                          }
                        >
                          {tr("确认记住", "Confirm memory")}
                        </button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act(() =>
                              change(
                                {
                                  kind: "decide",
                                  memory_id: m.id,
                                  revision: m.revision,
                                  confirm: false,
                                },
                                tr(
                                  "已拒绝，不会作为偏好使用。",
                                  "Rejected; it will not be used as a preference.",
                                ),
                              ),
                            )
                          }
                        >
                          {tr("拒绝候选", "Reject candidate")}
                        </button>
                      </>
                    )}
                    {!m.deleted && (
                      <>
                        <button
                          disabled={busy}
                          onClick={() => {
                            setHistory(null);
                            setEditor({ item: m, text: m.text, project: m.project_id || "" });
                            panel.current?.querySelector(".memory-body")?.scrollTo({ top: 0 });
                          }}
                        >
                          {tr("修改", "Edit")}
                        </button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              await change(
                                { kind: "delete", memory_id: m.id, revision: m.revision },
                                tr(
                                  "已删除，不再从记忆库读取。可以勾选“显示已删除”后查看历史并恢复。",
                                  "Deleted from active retrieval. Include deleted entries to view history and restore.",
                                ),
                              );
                              setHistory(null);
                              setEditor(null);
                            })
                          }
                        >
                          {tr("删除", "Delete")}
                        </button>
                      </>
                    )}
                    <button
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await viewHistory(m);
                          panel.current?.querySelector(".memory-body")?.scrollTo({ top: 0 });
                        })
                      }
                    >
                      {tr("历史与撤销", "History and undo")}
                    </button>
                  </div>
                </article>
              ))}
          </div>
          <div className="memory-pagination">
            <small>{tr(`共 ${total} 条`, `${total} entries`)}</small>
            <button
              disabled={busy || offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 24))}
            >
              {tr("上一页", "Previous")}
            </button>
            <button disabled={busy || offset + 24 >= total} onClick={() => setOffset(offset + 24)}>
              {tr("下一页", "Next")}
            </button>
          </div>
          <p className="memory-hint">
            {tr(
              "修改从下一次模型调用起生效；已经发出的请求不会撤回。删除会保留历史以便撤销，历史对话和执行记录也会保留。",
              "Changes apply at the next model call; an already-sent request cannot be recalled. Deleted entries retain undo history. Past conversation and execution records remain.",
            )}
          </p>
        </div>
      </section>
    </div>
  );
}
