import { useEffect, useRef, useState } from "react";
import { Saved } from "../SavedContent";
import { useWords } from "../workspaceClient";
import { categories, taskArchive, type ArchivePage, type ArchiveSummary } from "./client";
export function ArchiveSummaryView({ summary }: { summary: ArchiveSummary }) {
  const tr = useWords();
  return (
    <div className="archive-summary">
      <strong>{summary.tasks[0].title}</strong>
      <p>
        {tr("备份时间：", "Backed up: ")}
        {new Date(summary.created_at_ms).toLocaleString()}
      </p>
      <p>
        {tr("包含主任务及助手：", "Tasks including assistants: ")}
        {summary.tasks.length}
        {" · "}
        {tr("用户消息：", "Messages: ")}
        {summary.counts.messages}
        {" · "}
        {tr("过程记录：", "Events: ")}
        {summary.counts.events}
      </p>
      <p>
        {tr("保存正文：", "Saved content: ")}
        {summary.objects}
        {" · "}
        {(summary.bytes / 1024 / 1024).toFixed(2)} MiB
      </p>
      <ul>
        {summary.tasks.map((t) => (
          <li key={t.id}>
            {t.parent_task_id ? tr("助手：", "Assistant: ") : tr("主任务：", "Main task: ")}
            {t.title}
          </li>
        ))}
      </ul>
      <p>
        {tr("此包未包含的附件记录数：", "Attachment records outside this archive: ")}
        {summary.excluded_media}
        {" · "}
        {tr("文件历史数：", "File revisions outside this archive: ")}
        {summary.excluded_file_revisions}
      </p>
      <p>
        {tr(
          "这是查阅用的历史档案。附件原文件、加密文件历史、当前项目文件需用各自的迁移入口。档案不会恢复运行、启用旧审批或自动发送内容给模型。",
          "This is a read-only historical archive. Use the separate transfer tools for attachment originals, encrypted file history and current project files. It does not restore execution, activate old approvals or send content to models.",
        )}
      </p>
    </div>
  );
}
export function ArchiveBrowser({ archive }: { archive: string }) {
  const tr = useWords();
  const [table, setTable] = useState("messages");
  const [page, setPage] = useState<ArchivePage | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const generation = useRef(0);
  const read = async (name: string, offset: number) => {
    const gen = ++generation.current;
    setBusy(true);
    setError("");
    setPage(null);
    try {
      const next = await taskArchive<ArchivePage>({
        kind: "records",
        archive_id: archive,
        table: name,
        offset,
        limit: 16,
      });
      if (gen === generation.current) setPage(next);
    } catch (e) {
      if (gen === generation.current) setError(String(e));
    } finally {
      if (gen === generation.current) setBusy(false);
    }
  };
  useEffect(() => {
    setTable("messages");
    void read("messages", 0);
    return () => {
      generation.current++;
    };
  }, [archive]);
  return (
    <section aria-label={tr("查阅任务档案", "Browse task archive")}>
      {page && <ArchiveSummaryView summary={page.summary} />}
      <label>
        {tr("记录类别", "Record category")}
        <select
          aria-label={tr("记录类别", "Record category")}
          value={table}
          disabled={busy}
          onChange={(e) => {
            setTable(e.target.value);
            void read(e.target.value, 0);
          }}
        >
          {categories.map(([id, zh, en]) => (
            <option key={id} value={id}>
              {tr(zh, en)}
            </option>
          ))}
        </select>
      </label>
      {busy && <p role="status">{tr("正在读取档案…", "Reading archive…")}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {page && (
        <>
          <p>
            {tr("本类记录共：", "Records in this category: ")}
            {page.total}
          </p>
          {page.records.map((r) => (
            <details key={`${table}-${r.ordinal}`} className="archive-record">
              <summary>
                {r.ordinal}. {r.label || tr("查看保存的内容", "View saved content")}
              </summary>
              <ArchiveRecord content={r.content} />
            </details>
          ))}
          <div className="model-actions">
            <button disabled={busy || page.next_offset <= 16} onClick={() => void read(table, 0)}>
              {tr("档案首页", "First archive page")}
            </button>
            <button
              disabled={busy || page.next_offset >= page.total}
              onClick={() => void read(table, page.next_offset)}
            >
              {tr("下一页档案", "Next archive page")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
function ArchiveRecord({ content }: { content: ArchivePage["records"][number]["content"] }) {
  // Mount the content reader only when its enclosing details is expanded.
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const details = ref.current?.parentElement as HTMLDetailsElement | null;
    const toggle = () => setOpen(!!details?.open);
    details?.addEventListener("toggle", toggle);
    toggle();
    return () => details?.removeEventListener("toggle", toggle);
  }, []);
  return (
    <div ref={ref}>
      {open && <Saved reference={content} plain={content.media_type !== "application/json"} />}
    </div>
  );
}
