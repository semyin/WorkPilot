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
        {tr("已包含的附件原文件：", "Included attachment originals: ")}
        {summary.included_media || 0} · {((summary.media_bytes || 0) / 1024 / 1024).toFixed(2)} MiB
      </p>
      <p>
        {tr("此包未包含的附件记录数：", "Attachment records outside this archive: ")}
        {summary.excluded_media}
        {" · "}
        {tr("文件历史数：", "File revisions outside this archive: ")}
        {summary.excluded_file_revisions}
      </p>
      <p>
        {tr("已包含的文件历史：", "Included file revisions: ")}
        {summary.included_file_revisions || 0} ·{" "}
        {((summary.history_bytes || 0) / 1024 / 1024).toFixed(2)} MiB
      </p>
      <p>
        {tr(
          "导入后先作为查阅档案保存，在下方另行确认恢复。新版档案包含附件原文和文件修改历史；旧版缺少这些原文时需要从原任务重新导出。当前项目文件仍可通过文件迁移入口搬迁。导入不会启动任务、覆盖当前文件或发送内容给模型。",
          "Imported archives remain read-only until restoration is confirmed below. New archives include attachment originals and file history; export old archives again from the source task if originals are missing. Current project files can be moved through file transfer. Import does not start tasks, overwrite current files or send content to models.",
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
