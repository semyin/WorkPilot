import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FileTransferAction, WorkbenchOperation } from "../generated/contracts";
import { executionCommand } from "../executionClient";
import { useWords } from "../workspaceClient";
import { call, type Entry } from "./api";
import "../transfer.css";

type Preview = {
  fingerprint: string;
  archive_id: string;
  root_path: string;
  bytes: number;
  files: { source: string; target: string; bytes: number }[];
  conflicts: { path: string; reason: string }[];
  previous_operation: WorkbenchOperation | null;
  can_import: boolean;
};
export function FileTransferPanel({
  task,
  onOperation,
}: {
  task: string;
  onOperation: (operation: WorkbenchOperation, intent?: unknown) => Promise<void>;
}) {
  const tr = useWords();
  const [directory, setDirectory] = useState(".");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [destination, setDestination] = useState("");
  const [source, setSource] = useState("");
  const [exportPassword, setExportPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [importPassword, setImportPassword] = useState("");
  const [prefix, setPrefix] = useState("迁入文件");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const mounted = useRef(true),
    guard = useRef(false);
  const act = async (work: () => Promise<void>) => {
    if (guard.current) return;
    guard.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (e) {
      if (mounted.current) {
        setError(String(e));
        setPreview(null);
      }
    } finally {
      guard.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const browse = async (path: string) => {
    const result = await call<{ listing: { entries: Entry[]; truncated: boolean } }>(task, {
      kind: "list",
      path,
    });
    if (mounted.current) {
      setDirectory(path);
      setEntries(result.listing.entries);
      setTruncated(result.listing.truncated);
    }
  };
  useEffect(() => {
    mounted.current = true;
    void act(() => browse("."));
    return () => {
      mounted.current = false;
    };
  }, [task]);
  const transfer = async <T,>(action: FileTransferAction): Promise<T> => {
    const result = await executionCommand({ kind: "file_transfer", task_id: task, action });
    if (result.kind !== "workbench") throw new Error("Unexpected file transfer response");
    return result.data as T;
  };
  const pick = async (save: boolean) => {
    const path = await invoke<string | null>("pick_file_archive", { save });
    if (path && mounted.current) {
      if (save) setDestination(path);
      else {
        setSource(path);
        setPreview(null);
      }
    }
  };
  const valid = (p: string) => Array.from(p).length >= 12;
  return (
    <section className="history-transfer" aria-label={tr("项目文件迁移", "Project file transfer")}>
      <h3>{tr("备份和导入所选文件", "Back up and import selected files")}</h3>
      <p>
        {tr(
          "备份当前选中的文件内容，保留相对文件夹结构。最多 128 个文件、单文件 64 MiB、合计 256 MiB。",
          "Back up selected current files and relative folders. Up to 128 files, 64 MiB each and 256 MiB total.",
        )}
      </p>
      <p>
        {tr(
          "口令至少 12 个字符，请单独保存。软件不保存口令。常见凭据文件、内部环境和链接文件不能迁移。",
          "Keep a passphrase of at least 12 characters separately. It is not saved. Common credential files, internal environments and linked files cannot be transferred.",
        )}
      </p>
      <fieldset disabled={busy}>
        <legend>{tr("导出项目文件", "Export project files")}</legend>
        <div className="file-toolbar">
          <strong>{directory}</strong>
          <button
            disabled={directory === "."}
            onClick={() =>
              void act(() =>
                browse(
                  directory.includes("/") ? directory.slice(0, directory.lastIndexOf("/")) : ".",
                ),
              )
            }
          >
            {tr("上一级", "Parent folder")}
          </button>
          <button onClick={() => void act(() => browse(directory))}>
            {tr("刷新列表", "Refresh list")}
          </button>
        </div>
        <div className="transfer-selection">
          {entries.map((e) => {
            const path = directory === "." ? e.name : `${directory}/${e.name}`;
            return e.directory ? (
              <button key={path} disabled={e.linked} onClick={() => void act(() => browse(path))}>
                {tr("打开文件夹：", "Open folder: ")}
                {e.name}
              </button>
            ) : (
              <label key={path}>
                <input
                  type="checkbox"
                  disabled={e.linked || (!selected.includes(path) && selected.length >= 128)}
                  aria-label={`${tr("备份文件", "Back up file")}: ${path}`}
                  checked={selected.includes(path)}
                  onChange={(event) =>
                    setSelected((old) =>
                      event.target.checked ? [...old, path] : old.filter((p) => p !== path),
                    )
                  }
                />
                <span>
                  {e.name} · {e.bytes} B
                </span>
              </label>
            );
          })}
          {!entries.length && <p>{tr("文件夹为空", "This folder is empty")}</p>}
        </div>
        {truncated && (
          <p>
            {tr(
              "当前文件夹只显示前 256 项。可在文件页整理到子文件夹后再选择。",
              "Only the first 256 entries are shown. Arrange files into subfolders in Files to select more.",
            )}
          </p>
        )}
        <details>
          <summary>
            {tr("已选文件：", "Selected files: ")}
            {selected.length}
          </summary>
          {selected.map((path) => (
            <label key={path}>
              <input
                type="checkbox"
                checked
                onChange={() => setSelected((old) => old.filter((p) => p !== path))}
              />
              {path}
            </label>
          ))}
        </details>
        <label>
          {tr("文件备份保存位置", "File backup destination")}
          <input
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder="… .wpfiles"
          />
        </label>
        <button onClick={() => void act(() => pick(true))}>
          {tr("选择保存位置", "Choose save location")}
        </button>
        <label>
          {tr("设置文件备份口令", "File backup passphrase")}
          <input
            type="password"
            autoComplete="new-password"
            value={exportPassword}
            onChange={(e) => setExportPassword(e.target.value)}
          />
        </label>
        <label>
          {tr("再次输入文件备份口令", "Repeat file backup passphrase")}
          <input
            type="password"
            autoComplete="new-password"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
          />
        </label>
        <button
          disabled={
            !selected.length ||
            !destination ||
            !valid(exportPassword) ||
            confirmation !== exportPassword
          }
          onClick={() =>
            void act(async () => {
              await transfer({
                kind: "export",
                paths: selected,
                path: destination,
                password: exportPassword,
              });
              if (mounted.current) {
                setMessage(tr("文件备份已保存。", "File backup saved."));
                setExportPassword("");
                setConfirmation("");
              }
            })
          }
        >
          {tr("加密导出文件", "Export encrypted files")}
        </button>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>{tr("导入到当前项目", "Import into current project")}</legend>
        <label>
          {tr("文件备份来源", "File backup source")}
          <input
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setPreview(null);
            }}
            placeholder="… .wpfiles"
          />
        </label>
        <button onClick={() => void act(() => pick(false))}>
          {tr("选择文件备份", "Choose file backup")}
        </button>
        <label>
          {tr("解密文件备份口令", "Decrypt file backup passphrase")}
          <input
            type="password"
            autoComplete="off"
            value={importPassword}
            onChange={(e) => {
              setImportPassword(e.target.value);
              setPreview(null);
            }}
          />
        </label>
        <label>
          {tr("目标子文件夹（留空为项目根目录）", "Destination subfolder (empty for project root)")}
          <input
            value={prefix}
            onChange={(e) => {
              setPrefix(e.target.value);
              setPreview(null);
            }}
          />
        </label>
        <button
          disabled={!source || !valid(importPassword)}
          onClick={() =>
            void act(async () => {
              const result = await transfer<Preview>({
                kind: "inspect",
                path: source,
                password: importPassword,
                prefix,
              });
              if (mounted.current) setPreview(result);
            })
          }
        >
          {tr("预览文件导入", "Preview file import")}
        </button>
        {preview && (
          <div aria-label={tr("文件导入预览", "File import preview")}>
            <p>
              {preview.root_path} · {preview.files.length} {tr("个文件", "files")} · {preview.bytes}{" "}
              B
            </p>
            <div className="transfer-selection">
              {preview.files.map((f) => (
                <p key={f.source}>
                  {f.source} → {f.target} · {f.bytes} B
                </p>
              ))}
            </div>
            {!!preview.conflicts.length && !preview.previous_operation && (
              <div role="alert">
                <strong>
                  {tr(
                    "存在冲突：请更换目标子文件夹。",
                    "Conflicts found: choose another destination subfolder.",
                  )}
                </strong>
                {preview.conflicts.map((c) => (
                  <p key={c.path}>
                    {c.path} · {c.reason}
                  </p>
                ))}
              </div>
            )}
            <p>
              {tr(
                "只新增文件，不覆盖同名文件。按当前权限等待审批或执行。若中途停止，已写入的文件会保留并记录历史，不会自动重跑。",
                "Creates files without overwriting. Uses current approval permissions. If stopped, completed files and history are retained; the operation is not replayed automatically.",
              )}
            </p>
            {preview.previous_operation && (
              <p>
                {tr(
                  "此位置已有导入记录，只查看原操作。",
                  "An import record already exists for this destination; view the original operation.",
                )}
              </p>
            )}
            <button
              disabled={!preview.can_import}
              onClick={() =>
                void act(async () => {
                  const result = await transfer<{
                    operation: WorkbenchOperation;
                    intent?: unknown;
                  }>({
                    kind: "import",
                    path: source,
                    password: importPassword,
                    prefix,
                    fingerprint: preview.fingerprint,
                  });
                  if (mounted.current) {
                    setImportPassword("");
                    setPreview(null);
                    setMessage(
                      tr(
                        "已加入下方操作记录，请查看审批或执行结果。",
                        "Added to operations below. Check approval or execution results.",
                      ),
                    );
                    await onOperation(result.operation, result.intent);
                  }
                })
              }
            >
              {preview.previous_operation
                ? tr("查看原导入操作", "View original import")
                : tr("提交文件导入", "Submit file import")}
            </button>
          </div>
        )}
      </fieldset>
      {busy && <p role="status">{tr("正在处理文件备份…", "Processing file backup…")}</p>}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
