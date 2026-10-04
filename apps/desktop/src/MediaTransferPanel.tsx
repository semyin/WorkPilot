import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { MediaAsset, MediaTransferAction } from "./generated/contracts";
import { executionCommand } from "./executionClient";
import { useWords } from "./workspaceClient";
import "./transfer.css";
type Preview = {
  fingerprint: string;
  already_imported: boolean;
  conflicts: string[];
  same_names: string[];
  receipt: {
    at_ms: number;
    assets: { source_asset_id: string; asset_id: string; name: string }[];
  } | null;
  entries: {
    source_id: string;
    source_name: string;
    name: string;
    bytes: number;
    media_type?: string;
    units?: number;
    warnings?: string[];
  }[];
};
export function MediaTransferPanel({
  task,
  assets,
  onImported,
}: {
  task: string;
  assets: MediaAsset[];
  onImported: () => Promise<void>;
}) {
  const tr = useWords();
  const [selected, setSelected] = useState<string[]>([]),
    [destination, setDestination] = useState(""),
    [source, setSource] = useState("");
  const [exportPassword, setExportPassword] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [importPassword, setImportPassword] = useState("");
  const [prefix, setPrefix] = useState(""),
    [preview, setPreview] = useState<Preview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const mounted = useRef(true),
    guard = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const transfer = async <T,>(action: MediaTransferAction): Promise<T> => {
    const r = await executionCommand({ kind: "media_transfer", task_id: task, action });
    if (r.kind !== "workbench") throw new Error("Unexpected attachment transfer response");
    return r.data as T;
  };
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
  const pick = async (save: boolean) => {
    const path = await invoke<string | null>("pick_media_archive", { save });
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
    <section
      className="history-transfer"
      aria-label={tr("附件与成果迁移", "Attachment and output transfer")}
    >
      <h3>{tr("备份和迁移附件原内容", "Back up and transfer attachment originals")}</h3>
      <p>
        {tr(
          "选择当前任务的附件或成果，使用口令加密。每批最多 64 项、单项 32 MiB、合计 256 MiB。口令至少 12 个字符，请单独保管，软件不会保存。",
          "Select attachments or outputs from this task. Encrypt up to 64 items, 32 MiB each and 256 MiB total. Keep a passphrase of at least 12 characters separately; WorkPilot does not save it.",
        )}
      </p>
      <fieldset disabled={busy}>
        <legend>{tr("导出所选附件", "Export selected attachments")}</legend>
        <div className="transfer-selection">
          {assets.map((a) => (
            <label key={a.id}>
              <input
                type="checkbox"
                aria-label={`${tr("备份附件", "Back up attachment")}: ${a.name} · ${a.id.slice(0, 8)}`}
                checked={selected.includes(a.id)}
                disabled={!selected.includes(a.id) && selected.length >= 64}
                onChange={(e) =>
                  setSelected((old) =>
                    e.target.checked ? [...old, a.id] : old.filter((id) => id !== a.id),
                  )
                }
              />
              <span>
                {a.name} · {Math.ceil(a.bytes / 1024)} KB · {new Date(a.at_ms).toLocaleString()}
              </span>
            </label>
          ))}
          {!assets.length && <p>{tr("当前任务没有附件。", "This task has no attachments.")}</p>}
        </div>
        <small>
          {tr("列出最近 256 项；已选：", "Showing the latest 256 items; selected: ")}
          {selected.length}
        </small>
        <label>
          {tr("附件备份保存位置", "Attachment backup destination")}
          <input
            value={destination}
            placeholder="… .wpmedia"
            onChange={(e) => setDestination(e.target.value)}
          />
        </label>
        <button onClick={() => void act(() => pick(true))}>
          {tr("选择保存位置", "Choose save location")}
        </button>
        <label>
          {tr("设置附件备份口令", "Attachment backup passphrase")}
          <input
            type="password"
            autoComplete="new-password"
            value={exportPassword}
            onChange={(e) => setExportPassword(e.target.value)}
          />
        </label>
        <label>
          {tr("再次输入附件备份口令", "Repeat attachment backup passphrase")}
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
                asset_ids: selected,
                path: destination,
                password: exportPassword,
              });
              if (mounted.current) {
                setExportPassword("");
                setConfirmation("");
                setMessage(tr("附件备份已保存。", "Attachment backup saved."));
              }
            })
          }
        >
          {tr("加密导出附件", "Export encrypted attachments")}
        </button>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>{tr("导入到当前任务", "Import into current task")}</legend>
        <label>
          {tr("附件备份来源", "Attachment backup source")}
          <input
            value={source}
            placeholder="… .wpmedia"
            onChange={(e) => {
              setSource(e.target.value);
              setPreview(null);
            }}
          />
        </label>
        <button onClick={() => void act(() => pick(false))}>
          {tr("选择附件备份", "Choose attachment backup")}
        </button>
        <label>
          {tr("解密附件备份口令", "Decrypt attachment backup passphrase")}
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
          {tr("名称前缀（可留空）", "Name prefix (optional)")}
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
                name_prefix: prefix,
              });
              if (mounted.current) setPreview(result);
            })
          }
        >
          {tr("预览附件导入", "Preview attachment import")}
        </button>
        {preview && (
          <div role="region" aria-label={tr("附件导入预览", "Attachment import preview")}>
            <p>
              {preview.entries.length}{" "}
              {preview.already_imported
                ? tr("项资料的首次导入记录：", "items in the original import receipt: ")
                : tr(
                    "项资料，导入后保存在当前任务中。",
                    "items, stored in the current task after import.",
                  )}
              {preview.already_imported && preview.receipt
                ? new Date(preview.receipt.at_ms).toLocaleString()
                : ""}
            </p>
            <div className="transfer-selection">
              {preview.already_imported
                ? preview.receipt?.assets.map((a) => <p key={a.asset_id}>{a.name}</p>)
                : preview.entries.map((e) => (
                    <p key={e.source_id}>
                      {e.source_name} → {e.name} · {e.bytes} B{" "}
                      {e.media_type ? `· ${e.media_type}` : ""}
                      {e.units !== undefined ? ` · ${e.units} ${tr("段/页/行", "units")}` : ""}
                    </p>
                  ))}
            </div>
            {preview.entries.flatMap((e) =>
              (e.warnings || []).map((warning, i) => (
                <p key={`${e.source_id}-${i}`}>
                  {e.name} · {warning}
                </p>
              )),
            )}
            {!!preview.conflicts.length && (
              <div role="alert">
                {preview.conflicts.map((c) => (
                  <p key={c}>{c}</p>
                ))}
              </div>
            )}
            {!!preview.same_names.length && (
              <p>
                {tr(
                  "这些名称已存在，会作为独立资料保留，不会覆盖：",
                  "These names already exist and will be kept as separate snapshots: ",
                )}
                {preview.same_names.join("、")}
              </p>
            )}
            {!preview.already_imported && (
              <p>
                {tr(
                  "导入会重新检查原文件，保留来源，生成新的附件记录。项目文件不改动。需要发送给模型时，在资料卡点击“加入下一条消息”，返回对话后发送。",
                  "Import rechecks original files, preserves origins and creates new attachment records. Project files stay unchanged. To send a file to a model, choose Add to next message on its card, then send the message.",
                )}
              </p>
            )}
            {preview.already_imported && (
              <p>
                {tr(
                  "这份备份已导入过。上面显示首次导入时的名称；本次填写的名称前缀不会应用，后来移除的资料也不会重新出现。",
                  "This archive was already imported. The names above are from the original import. The current name prefix will not apply, and subsequently removed items stay removed.",
                )}
              </p>
            )}
            <button
              disabled={!!preview.conflicts.length}
              onClick={() =>
                void act(async () => {
                  const result = await transfer<{ duplicate: boolean }>({
                    kind: "import",
                    path: source,
                    password: importPassword,
                    name_prefix: prefix,
                    fingerprint: preview.fingerprint,
                  });
                  if (mounted.current) {
                    setImportPassword("");
                    setPreview(null);
                    setMessage(
                      result.duplicate
                        ? tr("已导入过，未重复添加。", "Already imported; no duplicates added.")
                        : tr(
                            "附件已导入，可在“附件与成果”查看。",
                            "Attachments imported. Open Attachments & outputs to view them.",
                          ),
                    );
                    await onImported();
                  }
                })
              }
            >
              {preview.already_imported
                ? tr("核对导入状态", "Check import status")
                : tr("确认导入附件", "Confirm attachment import")}
            </button>
          </div>
        )}
      </fieldset>
      {busy && (
        <div>
          <p role="status">
            {tr(
              "正在核验附件，较大的文件需要一些时间…",
              "Checking attachments; larger files may take some time…",
            )}
          </p>
          <button
            onClick={() =>
              void transfer<{ cancel_requested: boolean }>({ kind: "cancel" })
                .then((r) => {
                  if (mounted.current)
                    setMessage(
                      r.cancel_requested
                        ? tr(
                            "已请求停止，正在等待清理完成。",
                            "Stop requested; waiting for cleanup.",
                          )
                        : tr(
                            "操作尚未开始或已经结束。",
                            "The operation has not started or has already ended.",
                          ),
                    );
                })
                .catch((e) => {
                  if (mounted.current) setError(String(e));
                })
            }
          >
            {tr("停止附件迁移", "Stop attachment transfer")}
          </button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
