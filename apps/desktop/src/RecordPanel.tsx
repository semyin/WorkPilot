import { useEffect, useRef, useState } from "react";
import type { ContentRef, Event as EngineEvent } from "./generated/contracts";
import { workspaceAction, workspaceQuery, useWords } from "./workspaceClient";
import { Saved } from "./SavedContent";
import { executionCommand } from "./executionClient";
export function RecordEvent({ event }: { event: EngineEvent }) {
  const [expanded, setExpanded] = useState(false);
  const tr = useWords();
  const refs: ContentRef[] = [];
  if ("content" in event && event.content) refs.push(event.content);
  if (event.kind === "context_compacted") refs.push(event.archive);
  if (event.kind === "execution_created") refs.push(event.goal);
  if (event.kind === "task_restored") refs.push(event.history);
  if (event.kind === "team_changed" && event.record) refs.push(event.record);
  if (event.kind === "execution_ended" && event.output) refs.push(event.output);
  if (event.kind === "execution_step_changed") {
    if (event.input) refs.push(event.input);
    if (event.output) refs.push(event.output);
  }
  if (event.kind === "tool_approval_requested") refs.push(event.intent);
  if (event.kind === "managed_file_changed") {
    if (event.change.before_content) refs.push(event.change.before_content);
    refs.push(event.change.after_content);
  }
  return (
    <details onToggle={(e) => setExpanded(e.currentTarget.open)}>
      <summary>
        #{event.sequence} · {event.kind}
      </summary>
      {expanded && (
        <>
          <small>
            {tr("所属任务：", "Task: ")}
            {event.task_id}
          </small>
          <pre>{JSON.stringify(event, null, 2)}</pre>
          {refs.map((r, i) => (
            <Saved
              key={`${r.object_id}-${i}`}
              reference={r}
              plain={r.media_type !== "application/json"}
            />
          ))}
        </>
      )}
    </details>
  );
}
export function RecordPanel({ task }: { task: string }) {
  const tr = useWords();
  const [query, setQuery] = useState("");
  const [events, setEvents] = useState<EngineEvent[]>([]);
  const [cursor, setCursor] = useState(0);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scanned, setScanned] = useState(0);
  const [error, setError] = useState("");
  const [exported, setExported] = useState("");
  const [exporting, setExporting] = useState(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [task],
  );
  const read = async (after = 0) => {
    const gen = ++generation.current;
    setBusy(true);
    setError("");
    setEvents([]);
    setScanned(0);
    try {
      if (!query.trim()) {
        const r = await executionCommand({
          kind: "read",
          query: { kind: "events", task_id: task, after, limit: 64 },
        });
        if (gen === generation.current && r.kind === "events") {
          setEvents(r.page.events);
          setCursor(r.page.next_after);
          setMore(r.page.has_more);
        }
      } else {
        let next = after;
        const results: EngineEvent[] = [];
        let count = 0;
        while (gen === generation.current) {
          const r = await workspaceQuery({
            kind: "search_records",
            task_id: task,
            text: query,
            after: next,
            limit: 64,
          });
          if (gen !== generation.current || r.kind !== "search_records") break;
          next = r.next_after;
          results.push(...r.events);
          count += 1;
          setScanned(count);
          setEvents([...results]);
          setCursor(next);
          setMore(r.has_more);
          if (!r.has_more || results.length >= 64) break;
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
    } catch (e) {
      if (gen === generation.current) setError(String(e));
    } finally {
      if (gen === generation.current) setBusy(false);
    }
  };
  const exportAll = async () => {
    setExporting(true);
    setError("");
    try {
      const r = await workspaceAction({ kind: "export_records", task_id: task });
      if (r.kind === "exported")
        setExported(
          `${r.path}\n${tr("事件", "Events")}: ${r.events.toLocaleString()} · ${tr("内容文件", "Content files")}: ${r.objects.toLocaleString()}`,
        );
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  };
  return (
    <section className="record-panel">
      <h3>{tr("完整记录", "Complete records")}</h3>
      <p>
        {tr(
          "分页查看保存的记录。搜索和导出包含此任务及成员的完整正文。密钥不在记录中。",
          "Read persisted records by page. Search and export include full saved content for this task and its members. Credentials are excluded.",
        )}
      </p>
      <input
        type="search"
        aria-label={tr("搜索完整记录", "Search complete records")}
        value={query}
        onChange={(e) => {
          generation.current++;
          setBusy(false);
          setEvents([]);
          setCursor(0);
          setMore(false);
          setQuery(e.target.value);
        }}
        placeholder={tr("正文或操作名称…", "Text or action name…")}
      />
      <div className="model-actions">
        <button disabled={busy} onClick={() => void read()}>
          {query.trim() ? tr("搜索记录", "Search records") : tr("从头查看", "Read from start")}
        </button>
        {more && (
          <button disabled={busy} onClick={() => void read(cursor)}>
            {tr("下一页记录", "Next record page")}
          </button>
        )}
        {busy && (
          <button
            onClick={() => {
              generation.current++;
              setBusy(false);
            }}
          >
            {tr("停止搜索", "Stop search")}
          </button>
        )}
        <button disabled={exporting} onClick={() => void exportAll()}>
          {exporting
            ? tr("正在导出…", "Exporting…")
            : tr("导出完整记录", "Export complete records")}
        </button>
      </div>
      {busy && (
        <p role="status">
          {tr("正在检索记录页：", "Scanning record page: ")}
          {scanned}
        </p>
      )}
      {exported && (
        <div className="execution-notice">
          <strong>{tr("完整记录已导出", "Complete records exported")}</strong>
          <pre>{exported}</pre>
          <button
            onClick={() =>
              void navigator.clipboard
                .writeText(exported.split("\n")[0])
                .catch((e) => setError(String(e)))
            }
          >
            {tr("复制导出位置", "Copy export location")}
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {events.map((e) => (
        <RecordEvent key={e.sequence} event={e} />
      ))}
      <small>
        {tr(
          "页面只显示当前批次；导出包含全部已保存记录。",
          "Only the current page is rendered; export includes all persisted records.",
        )}
      </small>
    </section>
  );
}
