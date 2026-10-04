import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Task } from "../generated/contracts";
import { useWords, workspaceQuery } from "../workspaceClient";
import { taskArchive, type ArchiveEntry, type ArchivePreview } from "./client";
import { ArchiveBrowser, ArchiveSummaryView } from "./ArchiveBrowser";
import "../transfer.css";
export function TaskArchivePanel() {
  const tr = useWords();
  const [tasks, setTasks] = useState<Task[]>([]),
    [task, setTask] = useState("");
  const [archived, setArchived] = useState(false),
    [nextTask, setNextTask] = useState<string | null>(null);
  const [archives, setArchives] = useState<ArchiveEntry[]>([]),
    [selected, setSelected] = useState("");
  const [destination, setDestination] = useState(""),
    [exportPassword, setExportPassword] = useState(""),
    [repeat, setRepeat] = useState("");
  const [source, setSource] = useState(""),
    [password, setPassword] = useState("");
  const [preview, setPreview] = useState<ArchivePreview | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const active = useRef(true),
    guard = useRef(false),
    loadGeneration = useRef(0);
  const refresh = async () => {
    const r = await taskArchive<{ archives: ArchiveEntry[] }>({ kind: "list" });
    if (active.current) setArchives(r.archives);
  };
  const loadTasks = async (old: boolean, before: string | null = null) => {
    const generation = ++loadGeneration.current;
    const r = await workspaceQuery({
      kind: "tasks",
      project_id: null,
      archived: old,
      search: "",
      before,
      limit: 64,
    });
    if (active.current && generation === loadGeneration.current && r.kind === "tasks") {
      setTasks((prior) => (before ? [...prior, ...r.tasks] : r.tasks));
      setNextTask(r.next_before);
    }
  };
  useEffect(() => {
    active.current = true;
    void Promise.all([refresh(), loadTasks(false)]).catch(
      (e) => active.current && setError(String(e)),
    );
    return () => {
      active.current = false;
      loadGeneration.current++;
    };
  }, []);
  const act = async (work: () => Promise<void>) => {
    if (guard.current) return;
    guard.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (e) {
      if (active.current) {
        setError(String(e));
        setPreview(null);
      }
    } finally {
      guard.current = false;
      if (active.current) setBusy(false);
    }
  };
  const pick = async (save: boolean) => {
    const path = await invoke<string | null>("pick_task_archive", { save });
    if (path && active.current) {
      if (save) setDestination(path);
      else {
        setSource(path);
        setPreview(null);
      }
    }
  };
  const canExport =
    !!destination && Array.from(exportPassword).length >= 12 && exportPassword === repeat;
  const exportArchive = async (saved: boolean) => {
    if (saved)
      await taskArchive({
        kind: "export_saved",
        archive_id: selected,
        path: destination,
        password: exportPassword,
      });
    else
      await taskArchive({
        kind: "export",
        task_id: task,
        path: destination,
        password: exportPassword,
      });
    if (active.current) {
      setExportPassword("");
      setRepeat("");
      setMessage(
        tr(
          "加密任务档案已保存。原任务保持不变。",
          "Encrypted task archive saved. The original task is unchanged.",
        ),
      );
    }
  };
  return (
    <section
      className="history-transfer task-archive-panel"
      aria-label={tr("任务与助手档案迁移", "Task and assistant archive transfer")}
    >
      <p>
        {tr(
          "把一个主任务及所有助手的已保存消息、上下文、交付、操作记录和关联正文一起备份。导入后可查阅，暂不能从档案继续执行。",
          "Back up a main task and all assistants, including saved messages, context, reports, operations and linked content. Imported archives are available for reading; resuming execution from an archive is not supported yet.",
        )}
      </p>
      <p>
        {tr(
          "先停止本组任务再导出。此包不包含当前项目文件、附件原文件、加密文件历史、登录凭据、定时计划或扩展安装；请保留原数据目录。最多 33 个任务、5 万条记录、4096 份正文、256 MiB；超限会明确报错，不会截断。",
          "Stop this task group before exporting. Current project files, attachment originals, encrypted file history, credentials, schedules and extension installations are excluded; keep the original data directory. Limits: 33 tasks, 50,000 records, 4,096 content objects and 256 MiB. Oversized archives fail explicitly without truncation.",
        )}
      </p>
      <fieldset disabled={busy}>
        <legend>{tr("备份任务档案", "Back up task archive")}</legend>
        <label>
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => {
              const value = e.target.checked;
              setArchived(value);
              setTask("");
              setTasks([]);
              void act(() => loadTasks(value));
            }}
          />
          {tr("选择已归档的任务", "Select archived tasks")}
        </label>
        <label>
          {tr("要备份的主任务", "Main task to back up")}
          <select
            aria-label={tr("要备份的主任务", "Main task to back up")}
            value={task}
            onChange={(e) => setTask(e.target.value)}
          >
            <option value="">{tr("请选择主任务", "Select a main task")}</option>
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </label>
        {nextTask && (
          <button onClick={() => void act(() => loadTasks(archived, nextTask))}>
            {tr("更多主任务", "More main tasks")}
          </button>
        )}
        <label>
          {tr("档案保存位置", "Archive destination")}
          <input
            aria-label={tr("档案保存位置", "Archive destination")}
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
          />
        </label>
        <button onClick={() => void act(() => pick(true))}>
          {tr("选择档案保存位置", "Choose archive destination")}
        </button>
        <label>
          {tr("档案备份口令", "Archive export passphrase")}
          <input
            type="password"
            autoComplete="new-password"
            aria-label={tr("档案备份口令", "Archive export passphrase")}
            value={exportPassword}
            onChange={(e) => setExportPassword(e.target.value)}
          />
        </label>
        <label>
          {tr("再次输入档案口令", "Repeat archive passphrase")}
          <input
            type="password"
            autoComplete="new-password"
            aria-label={tr("再次输入档案口令", "Repeat archive passphrase")}
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
        </label>
        <small>
          {tr(
            "至少 12 个字符，请自行保管；遗失后无法找回。",
            "At least 12 characters. Keep it safely; a lost passphrase cannot be recovered.",
          )}
        </small>
        <button disabled={!task || !canExport} onClick={() => void act(() => exportArchive(false))}>
          {tr("导出加密任务档案", "Export encrypted task archive")}
        </button>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>{tr("导入为查阅档案", "Import a read-only archive")}</legend>
        <label>
          {tr("任务档案文件", "Task archive file")}
          <input
            aria-label={tr("任务档案文件", "Task archive file")}
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setPreview(null);
            }}
          />
        </label>
        <button onClick={() => void act(() => pick(false))}>
          {tr("选择任务档案", "Choose task archive")}
        </button>
        <label>
          {tr("档案解密口令", "Archive import passphrase")}
          <input
            type="password"
            autoComplete="off"
            aria-label={tr("档案解密口令", "Archive import passphrase")}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setPreview(null);
            }}
          />
        </label>
        <button
          disabled={!source || Array.from(password).length < 12}
          onClick={() =>
            void act(async () => {
              const r = await taskArchive<ArchivePreview>({
                kind: "inspect",
                path: source,
                password,
              });
              if (active.current) setPreview(r);
            })
          }
        >
          {tr("核验并预览任务档案", "Verify and preview task archive")}
        </button>
        {preview && (
          <>
            <ArchiveSummaryView summary={preview.summary} />
            {preview.already_imported && (
              <p>
                {tr(
                  "这份档案已经导入；再次确认不会重复添加。",
                  "This archive is already imported; confirming again will not create a duplicate.",
                )}
              </p>
            )}
            <button
              onClick={() =>
                void act(async () => {
                  const r = await taskArchive<{ archive_id: string }>({
                    kind: "import",
                    path: source,
                    password,
                    fingerprint: preview.fingerprint,
                  });
                  if (active.current) {
                    setPassword("");
                    setPreview(null);
                    setSelected(r.archive_id);
                    setMessage(
                      tr(
                        "档案已保存，可在下方查阅。没有启动任何任务。",
                        "Archive saved for reading below. No tasks were started.",
                      ),
                    );
                  }
                  await refresh();
                })
              }
            >
              {preview.already_imported
                ? tr("核对已有档案", "Check existing archive")
                : tr("确认导入查阅档案", "Import read-only archive")}
            </button>
          </>
        )}
      </fieldset>
      {busy && <p role="status">{tr("正在处理档案…", "Processing archive…")}</p>}
      {message && <p role="status">{message}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <h3>{tr("已导入的任务档案", "Imported task archives")}</h3>
      <button disabled={busy} onClick={() => void act(refresh)}>
        {tr("刷新档案库", "Refresh archive library")}
      </button>
      <label>
        {tr("选择查阅档案", "Select archive to read")}
        <select
          aria-label={tr("选择查阅档案", "Select archive to read")}
          value={selected}
          disabled={busy}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="">{tr("请选择档案", "Select an archive")}</option>
          {archives.map((a) => (
            <option key={a.archive_id} value={a.archive_id}>
              {a.title} · {a.tasks} {tr("个任务", "tasks")} ·{" "}
              {new Date(a.imported_at_ms).toLocaleString()}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <>
          <button disabled={busy || !canExport} onClick={() => void act(() => exportArchive(true))}>
            {tr(
              "按上方位置和口令另存所选档案",
              "Export selected archive using the destination and passphrase above",
            )}
          </button>
          <ArchiveBrowser key={selected} archive={selected} />
        </>
      )}
    </section>
  );
}
