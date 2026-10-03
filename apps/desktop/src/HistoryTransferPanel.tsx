import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FileRevision, HistoryTransferAction } from "./generated/contracts";
import { executionCommand } from "./executionClient";
import { useWords } from "./workspaceClient";
import "./transfer.css";

type Preview = {
  fingerprint: string;
  revisions: number;
  bytes: number;
  already_imported: boolean;
  paths: { path: string; current: string }[];
};
export function HistoryTransferPanel({
  task,
  history,
  onImported,
}: {
  task: string;
  history: FileRevision[];
  onImported: () => Promise<void>;
}) {
  const tr = useWords();
  const [selected, setSelected] = useState<string[]>([]);
  const [destination, setDestination] = useState("");
  const [source, setSource] = useState("");
  const [exportPassword, setExportPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [importPassword, setImportPassword] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const guard = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
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
      if (mounted.current) {
        setError(String(e));
        setPreview(null);
      }
    } finally {
      guard.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const call = async (action: HistoryTransferAction) => {
    const r = await executionCommand({ kind: "history_transfer", task_id: task, action });
    if (r.kind !== "workbench") throw new Error("Unexpected history transfer response");
    return r.data as unknown as Preview;
  };
  const pick = async (save: boolean) => {
    const path = await invoke<string | null>("pick_history_archive", { save });
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
    <details className="history-transfer">
      <summary>{tr("备份与导入文件历史", "Back up and import file history")}</summary>
      <p>
        {tr(
          "只迁移勾选的历史版本及其来源。会话、模型配置、技能、记忆和项目当前文件不包含在此备份中。",
          "Transfers selected file revisions and their origins. Conversations, model settings, skills, memories and current project files are not included.",
        )}
      </p>
      <p>
        {tr(
          "口令至少 12 个字符，请单独保存。软件不会保存它，遗失后无法解密。每次最多 128 条历史、256 MiB 内容。",
          "Use at least 12 characters and keep the passphrase separately. WorkPilot does not save it and cannot decrypt the backup without it. Up to 128 revisions and 256 MiB per archive.",
        )}
      </p>
      <fieldset disabled={busy}>
        <legend>{tr("导出所选历史", "Export selected revisions")}</legend>
        <div className="transfer-selection">
          {history.map((r) => (
            <label key={r.id}>
              <input
                type="checkbox"
                checked={selected.includes(r.id)}
                aria-label={`${tr("备份版本", "Back up revision")}: ${r.path} · ${r.id.slice(0, 8)}`}
                onChange={(e) =>
                  setSelected((old) =>
                    e.target.checked ? [...old, r.id] : old.filter((id) => id !== r.id),
                  )
                }
              />
              <span>
                {r.path} · {new Date(r.at_ms).toLocaleString()}
              </span>
            </label>
          ))}
          {!history.length && (
            <p>{tr("当前没有可选择的历史。", "No revisions are available to select.")}</p>
          )}
        </div>
        <small>
          {tr(
            "这里列出已加载的历史；可在下方加载更早的修改。已选择：",
            "Showing loaded revisions; use Earlier changes below for more. Selected: ",
          )}
          {selected.length}
        </small>
        <label>
          {tr("备份保存位置", "Save backup to")}
          <input
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder="… .wphistory"
          />
        </label>
        <button type="button" onClick={() => void act(() => pick(true))}>
          {tr("选择保存位置", "Choose save location")}
        </button>
        <label>
          {tr("设置备份口令", "Backup passphrase")}
          <input
            type="password"
            autoComplete="new-password"
            value={exportPassword}
            onChange={(e) => setExportPassword(e.target.value)}
          />
        </label>
        <label>
          {tr("再次输入备份口令", "Repeat backup passphrase")}
          <input
            type="password"
            autoComplete="new-password"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={
            !selected.length ||
            selected.length > 128 ||
            !destination ||
            !valid(exportPassword) ||
            confirmation !== exportPassword
          }
          onClick={() =>
            void act(async () => {
              await call({
                kind: "export",
                revision_ids: selected,
                path: destination,
                password: exportPassword,
              });
              if (mounted.current) {
                setExportPassword("");
                setConfirmation("");
                setMessage(tr("加密历史备份已保存。", "Encrypted history backup saved."));
              }
            })
          }
        >
          {tr("保存加密备份", "Save encrypted backup")}
        </button>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>{tr("导入到当前项目历史", "Import into current project history")}</legend>
        <label>
          {tr("历史备份文件", "History backup file")}
          <input
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setPreview(null);
            }}
          />
        </label>
        <button type="button" onClick={() => void act(() => pick(false))}>
          {tr("选择备份文件", "Choose backup file")}
        </button>
        <label>
          {tr("输入备份口令", "Enter backup passphrase")}
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
        <button
          type="button"
          disabled={!source || !valid(importPassword)}
          onClick={() =>
            void act(async () => {
              const p = await call({ kind: "inspect", path: source, password: importPassword });
              if (mounted.current) setPreview(p);
            })
          }
        >
          {tr("预览备份", "Preview backup")}
        </button>
        {preview && (
          <div
            className="transfer-preview"
            role="region"
            aria-label={tr("历史导入预览", "History import preview")}
          >
            <p>
              {tr("历史记录：", "Revisions: ")}
              {preview.revisions} · {(preview.bytes / 1048576).toFixed(2)} MiB
            </p>
            <p>
              {tr(
                "导入只增加历史记录，不覆盖当前项目文件。之后可在历史列表查看内容，再按原审批流程恢复。缺少子文件夹时，需要先准备相应文件夹。",
                "Import adds history records without overwriting project files. Review and restore through the existing approval flow afterwards. Missing subfolders must be prepared before restoring.",
              )}
            </p>
            <ul>
              {preview.paths.map((p) => (
                <li key={p.path}>
                  <span>{p.path}</span> ·{" "}
                  {p.current === "exists"
                    ? tr("已有同名文件，将保留", "Existing file will be preserved")
                    : p.current === "missing"
                      ? tr("当前没有此文件", "File is currently absent")
                      : tr(
                          "当前路径无法读取，恢复前需检查",
                          "Path unavailable; check before restoring",
                        )}
                </li>
              ))}
            </ul>
            {preview.already_imported ? (
              <p>
                {tr(
                  "此备份已导入当前项目，不会重复添加。",
                  "Already imported into this project; no duplicate revisions will be added.",
                )}
              </p>
            ) : (
              <button
                type="button"
                onClick={() =>
                  void act(async () => {
                    await call({
                      kind: "import",
                      path: source,
                      password: importPassword,
                      fingerprint: preview.fingerprint,
                    });
                    if (mounted.current) {
                      setImportPassword("");
                      setPreview(null);
                      setMessage(
                        tr(
                          "历史已导入，当前项目文件保持原样。",
                          "History imported. Project files are unchanged.",
                        ),
                      );
                      await onImported();
                    }
                  })
                }
              >
                {tr("确认导入历史", "Confirm history import")}
              </button>
            )}
          </div>
        )}
      </fieldset>
      {busy && <p role="status">{tr("正在加密或核验文件…", "Encrypting or verifying files…")}</p>}
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </details>
  );
}
