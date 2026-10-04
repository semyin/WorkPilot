import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FileRevision, WorkbenchAction, WorkbenchOperation } from "./generated/contracts";
import {
  call,
  type FileView,
  type Entry,
  type OperationRow,
  type GitState,
  type RevisionView,
} from "./file-workbench/api";
import { useWords } from "./workspaceClient";
import { Saved } from "./SavedContent";
import { FileHistory } from "./file-workbench/FileHistory";
import { FileTransferPanel } from "./file-workbench/FileTransferPanel";
import "./files.css";

export function FileWorkbench({ task, onClose }: { task: string; onClose: () => void }) {
  const tr = useWords();
  const [tab, setTab] = useState("files");
  const [directory, setDirectory] = useState(".");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [root, setRoot] = useState("");
  const [file, setFile] = useState<FileView | null>(null);
  const [draft, setDraft] = useState("");
  const [newPath, setNewPath] = useState("");
  const [rename, setRename] = useState("");
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<{ path: string; line: number; text: string }[]>([]);
  const [searchNote, setSearchNote] = useState("");
  const [history, setHistory] = useState<FileRevision[]>([]);
  const [moreHistory, setMoreHistory] = useState(false);
  const [revision, setRevision] = useState<RevisionView | null>(null);
  const [operations, setOperations] = useState<OperationRow[]>([]);
  const [intent, setIntent] = useState<Record<string, unknown>>({});
  const [program, setProgram] = useState("powershell");
  const [command, setCommand] = useState("");
  const [argumentsText, setArgumentsText] = useState("[]");
  const [seconds, setSeconds] = useState(300);
  const [port, setPort] = useState("");
  const [git, setGit] = useState<GitState | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [gitDiff, setGitDiff] = useState<{ staged: string; unstaged: string } | null>(null);
  const [htmlPreview, setHtmlPreview] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dirty = !!file && draft !== (file.text ?? "");
  const current = useRef({ file, draft, dirty });
  current.current = { file, draft, dirty };
  const saves = useRef(new Map<string, { path: string; text: string }>());
  const effects = useRef(new Map<string, WorkbenchAction>());
  const previewOperation = useRef<string | null>(null);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const fileGeneration = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (previewOperation.current) void invoke("project_preview_close").catch(() => {});
    };
  }, []);
  const act = async (work: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const list = async (path = directory) => {
    const r = await call<{ root_path: string; listing: { entries: Entry[]; truncated: boolean } }>(
      task,
      { kind: "list", path },
    );
    if (mounted.current) {
      setDirectory(path);
      setEntries(r.listing.entries);
      setTruncated(r.listing.truncated);
      setRoot(r.root_path);
    }
  };
  const read = async (path: string) => {
    if (current.current.dirty)
      throw new Error(
        tr(
          "请先保存或放弃当前编辑，再打开其它文件。",
          "Save or discard the current edit before opening another file.",
        ),
      );
    const generation = ++fileGeneration.current;
    const r = await call<FileView>(task, { kind: "read_file", path });
    if (mounted.current && generation === fileGeneration.current) {
      setFile(r);
      setDraft(r.text ?? "");
      setRename(path);
      setHtmlPreview(false);
      setTab("files");
    }
  };
  const historyPage = async (append = false) => {
    const r = await call<{ items: FileRevision[]; has_more: boolean }>(task, {
      kind: "history",
      path: null,
      before: append ? (history.at(-1)?.id ?? null) : null,
      limit: 50,
    });
    if (mounted.current) {
      setHistory((old) => (append ? [...old, ...r.items] : r.items));
      setMoreHistory(r.has_more);
    }
  };
  const refreshGit = async () => {
    const r = await call<{ status: GitState }>(task, { kind: "git_status" });
    if (mounted.current) {
      setGit(r.status);
      setSelection([]);
    }
  };
  const send = async (action: WorkbenchAction) => {
    const result = await call<{ operation: WorkbenchOperation; intent?: unknown }>(task, action);
    if (result.intent) setIntent((old) => ({ ...old, [result.operation.id]: result.intent }));
    if (action.kind === "edit" && action.edit.kind === "save")
      saves.current.set(result.operation.id, { path: action.edit.path, text: action.edit.text });
    if (["edit", "terminal", "git_commit"].includes(action.kind))
      effects.current.set(result.operation.id, action);
    await poll();
  };
  const poll = async () => {
    const r = await call<{ items: OperationRow[] }>(task, { kind: "operations" });
    if (!mounted.current) return;
    setOperations(r.items);
    if (
      previewOperation.current &&
      r.items.some(
        ({ operation }) =>
          operation.id === previewOperation.current && operation.state !== "running",
      )
    ) {
      previewOperation.current = null;
      void invoke("project_preview_close").catch(() => {});
    }
    for (const { operation } of r.items) {
      const effect = effects.current.get(operation.id);
      if (effect && ["completed", "failed", "cancelled", "interrupted"].includes(operation.state)) {
        effects.current.delete(operation.id);
        if (operation.state === "completed") {
          if (effect.kind === "git_commit") await refreshGit();
          if (effect.kind === "edit") {
            const edit = effect.edit;
            if (edit.kind === "rename" && current.current.file?.path === edit.path) {
              setFile((old) =>
                old?.path === edit.path ? { ...old, path: edit.destination } : old,
              );
              setRename(edit.destination);
            }
            if (
              edit.kind === "delete" &&
              current.current.file?.path === edit.path &&
              !current.current.dirty
            ) {
              setFile(null);
              setDraft("");
            }
          }
        }
        await list();
      }
      const pending = saves.current.get(operation.id);
      if (
        !pending ||
        !["completed", "failed", "cancelled", "interrupted"].includes(operation.state)
      )
        continue;
      saves.current.delete(operation.id);
      if (
        operation.state === "completed" &&
        current.current.file?.path === pending.path &&
        current.current.draft === pending.text
      ) {
        const updated = await call<FileView>(task, { kind: "read_file", path: pending.path });
        if (
          mounted.current &&
          current.current.file?.path === pending.path &&
          current.current.draft === pending.text
        ) {
          setFile(updated);
          setDraft(updated.text ?? "");
        }
        await list();
      }
    }
  };
  useEffect(() => {
    void act(() => list("."));
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        await poll();
      } catch (e) {
        if (!disposed) setError(String(e));
      }
      if (!disposed) timer = setTimeout(refresh, 800);
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [task]);
  const stateName = (state: string) =>
    ({
      awaiting_approval: tr("等待确认", "Awaiting approval"),
      queued: tr("排队", "Queued"),
      running: tr("运行中", "Running"),
      completed: tr("完成", "Completed"),
      failed: tr("失败", "Failed"),
      cancelled: tr("已停止", "Stopped"),
      interrupted: tr("已中断", "Interrupted"),
      stopping: tr("停止中", "Stopping"),
    })[state] || state;
  const external = async (path: string, folder: boolean) => {
    await invoke("project_open_external", { taskId: task, path, folder });
  };
  const operationTitle = (op: WorkbenchOperation) => {
    if (op.kind === "history_import") return tr("导入文件历史", "Import file history");
    if (op.kind === "files_import") return tr("导入项目文件", "Import project files");
    if (op.kind === "terminal") return tr("运行命令 · ", "Run command · ") + op.summary;
    if (op.kind === "git_commit") return tr("提交选中文件", "Commit selected files");
    if (op.summary.startsWith("恢复文件版本 ")) return tr("恢复文件版本", "Restore file version");
    for (const [prefix, translated] of [
      ["保存 ", tr("保存 ", "Save ")],
      ["删除 ", tr("删除 ", "Delete ")],
      ["重命名 ", tr("重命名 ", "Rename ")],
    ])
      if (op.summary.startsWith(prefix)) return translated + op.summary.slice(prefix.length);
    return op.summary;
  };
  const tabs = [
    ["files", tr("文件", "Files")],
    ["history", tr("修改历史", "File history")],
    ["transfer", tr("文件迁移", "File transfer")],
    ["terminal", tr("终端", "Terminal")],
    ["git", "Git"],
  ];
  return (
    <div className="file-workbench-backdrop">
      <section
        className="file-workbench"
        role="dialog"
        aria-modal="true"
        aria-label={tr("文件与终端", "Files and terminal")}
      >
        <header>
          <div>
            <h2>{tr("项目工作区", "Project workspace")}</h2>
            <small title={root}>{root || tr("读取项目文件夹…", "Reading project folder…")}</small>
          </div>
          <button onClick={() => (dirty ? setDiscard(true) : onClose())}>
            {tr("返回对话", "Back to conversation")}
          </button>
        </header>
        <nav className="file-tabs">
          {tabs.map(([key, label]) => (
            <button
              key={key}
              aria-pressed={tab === key}
              onClick={() => {
                setTab(key);
                if (key === "history") void act(() => historyPage());
                if (key === "git") void act(refreshGit);
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        {discard && (
          <div className="file-warning">
            {tr("当前编辑尚未保存。", "The current edit has not been saved.")}
            <button onClick={onClose}>{tr("放弃编辑并返回", "Discard and return")}</button>
            <button onClick={() => setDiscard(false)}>{tr("继续编辑", "Keep editing")}</button>
          </div>
        )}
        {error && (
          <div className="file-warning" role="alert">
            <strong>{tr("操作未完成", "The operation could not be completed")}</strong>
            <p>{error}</p>
            <button onClick={() => setError("")}>{tr("关闭提示", "Dismiss")}</button>
          </div>
        )}
        <main className="file-workbench-main">
          {tab === "transfer" && (
            <FileTransferPanel
              task={task}
              onOperation={async (op, intent) => {
                if (intent) setIntent((old) => ({ ...old, [op.id]: intent }));
                effects.current.set(op.id, { kind: "import_files", manifest_blob: "" });
                await poll();
              }}
            />
          )}
          {tab === "files" && (
            <div className="file-browser">
              <aside>
                <div className="file-toolbar">
                  <button
                    disabled={directory === "." || busy}
                    onClick={() =>
                      void act(() =>
                        list(
                          directory.includes("/")
                            ? directory.slice(0, directory.lastIndexOf("/"))
                            : ".",
                        ),
                      )
                    }
                  >
                    {tr("上一级", "Up")}
                  </button>
                  <button disabled={busy} onClick={() => void act(() => list())}>
                    {tr("刷新文件", "Refresh files")}
                  </button>
                  <button onClick={() => void act(() => external(".", true))}>
                    {tr("打开文件夹", "Open folder")}
                  </button>
                </div>
                <small>{directory}</small>
                <div className="file-tree">
                  {entries.map((e) => (
                    <button
                      key={e.name}
                      disabled={e.linked || busy}
                      title={
                        e.linked ? tr("暂不访问链接文件", "Linked files are not accessed") : e.name
                      }
                      onClick={() => {
                        const path = directory === "." ? e.name : directory + "/" + e.name;
                        void act(() => (e.directory ? list(path) : read(path)));
                      }}
                    >
                      {e.directory ? "▸ " : "· "}
                      {e.name}
                    </button>
                  ))}
                </div>
                {truncated && (
                  <small>
                    {tr(
                      "此目录仅显示前 256 项，可用搜索定位文件。",
                      "Only 256 entries are shown; use search to locate files.",
                    )}
                  </small>
                )}
                <label>
                  {tr("新文件名称或相对路径", "New file name or relative path")}
                  <input value={newPath} onChange={(e) => setNewPath(e.target.value)} />
                </label>
                <button
                  disabled={busy || !newPath.trim()}
                  onClick={() => void act(() => read(newPath.trim()))}
                >
                  {tr("打开或新建文件", "Open or create file")}
                </button>
                <label>
                  {tr("搜索文件内容", "Search file contents")}
                  <input value={query} onChange={(e) => setQuery(e.target.value)} />
                </label>
                <button
                  disabled={busy || !query}
                  onClick={() =>
                    void act(async () => {
                      const r = await call<{
                        result: { matches: typeof matches; skipped: number; truncated: boolean };
                      }>(task, { kind: "search", text: query });
                      setMatches(r.result.matches);
                      setSearchNote(
                        tr("跳过文件数：", "Skipped files: ") +
                          r.result.skipped +
                          (r.result.truncated
                            ? tr("；结果达到上限", "; results reached the limit")
                            : ""),
                      );
                    })
                  }
                >
                  {tr("搜索内容", "Search contents")}
                </button>
                <small>{searchNote}</small>
                {matches.map((m, i) => (
                  <button
                    className="file-search-match"
                    key={i}
                    onClick={() => void act(() => read(m.path))}
                  >
                    {m.path}:{m.line}
                    <small>{m.text}</small>
                  </button>
                ))}
              </aside>
              <section className="file-editor">
                {file ? (
                  <>
                    <div className="file-toolbar">
                      <h3>
                        {file.path}
                        {dirty ? " •" : ""}
                      </h3>
                      <small>{file.version.bytes.toLocaleString()} bytes</small>
                    </div>
                    <div className="file-toolbar">
                      <button
                        disabled={busy || !file.editable}
                        onClick={() =>
                          void act(() =>
                            send({
                              kind: "edit",
                              edit: {
                                kind: "save",
                                path: file.path,
                                expected: file.version,
                                text: draft,
                              },
                            }),
                          )
                        }
                      >
                        {tr("保存文件", "Save file")}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            const r = await call<FileView>(task, {
                              kind: "read_file",
                              path: file.path,
                            });
                            setFile(r);
                            setDraft(r.text ?? "");
                          })
                        }
                      >
                        {tr("放弃编辑并重新读取", "Discard edit and reload")}
                      </button>
                      <button
                        disabled={busy || !file.version.exists}
                        onClick={() => void act(() => external(file.path, false))}
                      >
                        {tr("用其它应用打开", "Open in another app")}
                      </button>
                      {file.path.toLowerCase().endsWith(".html") && file.text !== null && (
                        <button onClick={() => setHtmlPreview(!htmlPreview)}>
                          {tr("静态网页预览", "Static HTML preview")}
                        </button>
                      )}
                    </div>
                    {htmlPreview ? (
                      <iframe
                        title={tr("静态网页预览", "Static HTML preview")}
                        sandbox=""
                        srcDoc={draft}
                      />
                    ) : file.editable ? (
                      <textarea
                        className="source-editor"
                        aria-label={tr("文件正文", "File contents")}
                        spellCheck={false}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if ((e.ctrlKey || e.metaKey) && e.key === "s") {
                            e.preventDefault();
                            void act(() =>
                              send({
                                kind: "edit",
                                edit: {
                                  kind: "save",
                                  path: file.path,
                                  expected: file.version,
                                  text: draft,
                                },
                              }),
                            );
                          }
                        }}
                      />
                    ) : (
                      <div>
                        <p>
                          {tr(
                            "此文件以原始字节保留历史。内置编辑器支持不超过 256 KiB 的 UTF-8 文本，其它格式可以外部打开。",
                            "History preserves the original bytes. The editor supports UTF-8 text up to 256 KiB; other formats can be opened externally.",
                          )}
                        </p>
                        {file.preview && (
                          <img className="file-image" src={file.preview} alt={file.path} />
                        )}
                        <details>
                          <summary>{tr("文件头信息", "File header")}</summary>
                          <pre>{file.hex_preview}</pre>
                        </details>
                      </div>
                    )}
                    <details>
                      <summary>{tr("重命名或删除", "Rename or delete")}</summary>
                      <label>
                        {tr("新的相对路径", "New relative path")}
                        <input value={rename} onChange={(e) => setRename(e.target.value)} />
                      </label>
                      <div className="file-toolbar">
                        <button
                          disabled={busy || dirty || !file.version.exists || rename === file.path}
                          onClick={() =>
                            void act(() =>
                              send({
                                kind: "edit",
                                edit: {
                                  kind: "rename",
                                  path: file.path,
                                  destination: rename,
                                  expected: file.version,
                                },
                              }),
                            )
                          }
                        >
                          {tr("提交重命名", "Request rename")}
                        </button>
                        <button
                          disabled={busy || dirty || !file.version.exists}
                          onClick={() =>
                            void act(() =>
                              send({
                                kind: "edit",
                                edit: { kind: "delete", path: file.path, expected: file.version },
                              }),
                            )
                          }
                        >
                          {tr("删除并保留历史", "Delete and keep history")}
                        </button>
                      </div>
                    </details>
                  </>
                ) : (
                  <div className="file-empty">
                    {tr("选择左侧文件开始查看和编辑。", "Choose a file to read or edit.")}
                  </div>
                )}
              </section>
            </div>
          )}
          {tab === "history" && (
            <FileHistory
              task={task}
              history={history}
              historyPage={historyPage}
              moreHistory={moreHistory}
              revision={revision}
              setRevision={setRevision}
              busy={busy}
              act={act}
              send={send}
            />
          )}
          {tab === "terminal" && (
            <section className="file-terminal">
              <h3>{tr("运行项目命令", "Run a project command")}</h3>
              <p>
                {tr(
                  "命令在当前任务的项目文件夹执行，沿用任务权限。停止只结束本软件启动的进程；命令结束后保存文件变化。",
                  "Commands use this task’s project folder and permissions. Stop ends only owned processes; file changes are recorded afterward.",
                )}
              </p>
              <label>
                {tr("命令环境", "Command environment")}
                <select value={program} onChange={(e) => setProgram(e.target.value)}>
                  <option value="powershell">PowerShell</option>
                  <option value="custom">{tr("指定可执行程序", "Custom executable")}</option>
                </select>
              </label>
              {program === "powershell" ? (
                <label>
                  {tr("终端命令", "Terminal command")}
                  <textarea
                    aria-label={tr("终端命令", "Terminal command")}
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder="Get-ChildItem"
                  />
                </label>
              ) : (
                <>
                  <label>
                    {tr("可执行程序路径或名称", "Executable path or name")}
                    <input value={command} onChange={(e) => setCommand(e.target.value)} />
                  </label>
                  <label>
                    {tr("参数列表（JSON 数组）", "Arguments (JSON array)")}
                    <textarea
                      value={argumentsText}
                      onChange={(e) => setArgumentsText(e.target.value)}
                    />
                  </label>
                </>
              )}
              <div className="file-toolbar">
                <label>
                  {tr("最长运行秒数", "Maximum run seconds")}
                  <input
                    type="number"
                    min="1"
                    max="86400"
                    value={seconds}
                    onChange={(e) => setSeconds(Number(e.target.value))}
                  />
                </label>
                <label>
                  {tr("预览端口（可留空）", "Preview port (optional)")}
                  <input
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    placeholder="3000"
                  />
                </label>
              </div>
              <button
                disabled={busy || !command.trim()}
                onClick={() =>
                  void act(async () => {
                    const args =
                      program === "powershell"
                        ? [
                            "-NoLogo",
                            "-NoProfile",
                            "-NonInteractive",
                            "-Command",
                            "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); New-PSDrive -Name WorkPilotProject -PSProvider FileSystem -Root '" +
                              root.replaceAll("'", "''") +
                              "' -Scope Global | Out-Null; Set-Location -LiteralPath 'WorkPilotProject:\\'; " +
                              command,
                          ]
                        : JSON.parse(argumentsText);
                    if (!Array.isArray(args) || args.some((a) => typeof a !== "string"))
                      throw new Error(
                        tr("参数必须是一组字符串。", "Arguments must be an array of strings."),
                      );
                    await send({
                      kind: "terminal",
                      program: program === "powershell" ? "powershell" : command,
                      args,
                      timeout_ms: seconds * 1000,
                      preview_port: port.trim() ? Number(port) : null,
                    });
                  })
                }
              >
                {tr("运行命令", "Run command")}
              </button>
              <p>
                <small>
                  {tr(
                    "命令执行期间同项目的写入按顺序进行。长服务请用下方“停止”；关闭预览窗口不会停止服务，彻底退出软件会结束服务。",
                    "Writes to the same project are serialized while commands run. Stop long services below; closing a preview keeps its service running, while quitting WorkPilot stops it.",
                  )}
                </small>
              </p>
            </section>
          )}
          {tab === "git" && (
            <section className="file-git">
              <div className="file-toolbar">
                <h3>
                  {tr("版本管理", "Version control")} · {git?.branch || "Git"}
                </h3>
                <button disabled={busy} onClick={() => void act(refreshGit)}>
                  {tr("刷新 Git", "Refresh Git")}
                </button>
              </div>
              <p>
                {tr(
                  "仅提交选中文件的当前内容，保留其它已暂存或未提交的修改。此入口不运行提交钩子、不自动推送。",
                  "Commit current contents of selected files while preserving other staged and unstaged changes. Commit hooks and automatic push are not run.",
                )}
              </p>
              {git && (
                <div className="file-git-grid">
                  <div>
                    {git.entries.map((e) => (
                      <div key={e.path} className="file-git-row">
                        <label>
                          <input
                            type="checkbox"
                            checked={selection.includes(e.path)}
                            onChange={(event) =>
                              setSelection((old) =>
                                event.target.checked
                                  ? [
                                      ...new Set([
                                        ...old,
                                        e.path,
                                        ...(e.previous_path ? [e.previous_path] : []),
                                      ]),
                                    ]
                                  : old.filter((p) => p !== e.path && p !== e.previous_path),
                              )
                            }
                          />
                          <code>{e.status}</code>
                          {e.path}
                        </label>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              const r = await call<{ diff: typeof gitDiff }>(task, {
                                kind: "git_diff",
                                path: e.path,
                              });
                              setGitDiff(r.diff);
                            })
                          }
                        >
                          {tr("查看差异", "View diff")}
                        </button>
                      </div>
                    ))}
                    {!git.entries.length && (
                      <p>{tr("没有待提交的修改。", "No pending changes.")}</p>
                    )}
                  </div>
                  <div>
                    {gitDiff && (
                      <>
                        <h4>{tr("已暂存的差异", "Staged diff")}</h4>
                        <pre>{gitDiff.staged || "—"}</pre>
                        <h4>{tr("未暂存的差异", "Unstaged diff")}</h4>
                        <pre>{gitDiff.unstaged || "—"}</pre>
                      </>
                    )}
                  </div>
                </div>
              )}
              <label>
                {tr("提交说明", "Commit message")}
                <input value={message} onChange={(e) => setMessage(e.target.value)} />
              </label>
              <p>
                {tr("本次选择：", "Selected: ")}
                {selection.join("、") || tr("尚未选择文件", "No files selected")}
              </p>
              <button
                disabled={busy || !git || !selection.length || !message.trim()}
                onClick={() =>
                  void act(() =>
                    send({
                      kind: "git_commit",
                      paths: selection,
                      message,
                      expected_status: git!.fingerprint,
                    }),
                  )
                }
              >
                {tr("提交选中文件", "Commit selected files")}
              </button>
            </section>
          )}
        </main>
        <section
          className="file-operations"
          aria-label={tr("工作区操作记录", "Workspace operations")}
        >
          <h3>{tr("操作与确认", "Operations and approvals")}</h3>
          {operations.length === 0 && (
            <small>
              {tr(
                "保存、恢复、终端和提交结果会出现在这里。",
                "Save, restore, terminal and commit results appear here.",
              )}
            </small>
          )}
          {operations.map(({ operation: op, live_output }) => (
            <article key={op.id} data-operation-id={op.id} data-operation-state={op.state}>
              <div className="file-toolbar">
                <strong>{operationTitle(op)}</strong>
                <span>{stateName(op.state)}</span>
                {op.pid && <small>PID {op.pid}</small>}
                {op.state === "awaiting_approval" && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        send({ kind: "approve", operation_id: op.id, fingerprint: op.fingerprint }),
                      )
                    }
                  >
                    {tr("确认执行", "Approve operation")}
                  </button>
                )}
                {["awaiting_approval", "queued", "running", "stopping"].includes(op.state) && (
                  <button
                    onClick={() => void act(() => send({ kind: "stop", operation_id: op.id }))}
                  >
                    {tr("停止", "Stop")}
                  </button>
                )}
                {op.state === "running" && op.preview_port && (
                  <button
                    onClick={() =>
                      void act(async () => {
                        await invoke("project_preview_open", { taskId: task, operationId: op.id });
                        previewOperation.current = op.id;
                      })
                    }
                  >
                    {tr("打开运行预览", "Open running preview")}
                  </button>
                )}
              </div>
              {op.error && <p role="status">{op.error}</p>}
              {live_output && <pre>{live_output}</pre>}
              <details
                onToggle={(e) => {
                  if (e.currentTarget.open && !intent[op.id])
                    void call<{ intent: unknown }>(task, { kind: "operation", operation_id: op.id })
                      .then(
                        (r) =>
                          mounted.current && setIntent((old) => ({ ...old, [op.id]: r.intent })),
                      )
                      .catch((e) => setError(String(e)));
                }}
              >
                <summary>
                  {tr("查看具体操作与完整结果", "Inspect exact action and full result")}
                </summary>
                <pre>{intent[op.id] ? JSON.stringify(intent[op.id], null, 2) : "…"}</pre>
                {op.output && <Saved reference={op.output} plain />}
                {op.stdout && (
                  <>
                    <h4>{tr("标准输出", "Standard output")}</h4>
                    <Saved reference={op.stdout} plain />
                  </>
                )}
                {op.stderr && op.stderr.bytes > 0 && (
                  <>
                    <h4>{tr("错误输出", "Error output")}</h4>
                    <Saved reference={op.stderr} plain />
                  </>
                )}
              </details>
            </article>
          ))}
        </section>
      </section>
    </div>
  );
}
