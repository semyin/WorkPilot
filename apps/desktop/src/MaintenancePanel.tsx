import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { MaintenanceSelection } from "./generated/contracts";
import { executionCommand } from "./executionClient";
import { useWords } from "./workspaceClient";
import type { MaintenanceProgress } from "./MaintenanceStatus";
type Catalog = {
  groups: { id: string; title: string; tasks: number }[];
  roots: { identity: string; path: string; versions: number }[];
  archives: { archives: { archive_id: string; title: string; tasks: number }[] };
};
type Preview = {
  fingerprint: string;
  tasks: string[];
  revision_ids: string[];
  archives: string[];
  totals: Record<string, number>;
  confirmation: string;
  backup_required: boolean;
};
export function MaintenancePanel({ onMaintenance }: { onMaintenance: MaintenanceProgress }) {
  const tr = useWords();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [kind, setKind] = useState<MaintenanceSelection["kind"]>("unreferenced");
  const [selected, setSelected] = useState<string[]>([]);
  const [root, setRoot] = useState("");
  const [keep, setKeep] = useState(10),
    [days, setDays] = useState(30);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirm, setConfirm] = useState("");
  const [path, setPath] = useState(""),
    [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false),
    [stopped, setStopped] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  const selection = (): MaintenanceSelection => {
    if (kind === "tasks") return { kind, root_task_ids: selected };
    if (kind === "archives") return { kind, archive_ids: selected };
    if (kind === "versions")
      return { kind, root_identity: root, keep_last: keep, older_than_days: days };
    return { kind };
  };
  const clear = () => {
    setPreview(null);
    setConfirm("");
    setError("");
  };
  async function command(
    action: { action: "catalog" } | { action: "preview"; selection: MaintenanceSelection },
  ) {
    const r = await executionCommand({ kind: "maintenance", action });
    if (r.kind !== "workbench")
      throw new Error(tr("维护结果不可用", "Maintenance response unavailable"));
    return r.data;
  }
  useEffect(() => {
    void command({ action: "catalog" })
      .then((v) => setCatalog(v as Catalog))
      .catch((e) => setError(String(e)));
  }, []);
  async function inspect() {
    setBusy(true);
    clear();
    try {
      setPreview((await command({ action: "preview", selection: selection() })) as Preview);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!preview || confirm !== preview.confirmation) return;
    setBusy(true);
    setError("");
    setStopped(true);
    onMaintenance(true);
    try {
      setResult(
        await invoke<Record<string, unknown>>("maintenance_apply", {
          request: {
            selection: selection(),
            fingerprint: preview.fingerprint,
            confirmation: confirm,
            backup_path: preview.backup_required ? path : null,
            backup_password: preview.backup_required ? password : null,
          },
        }),
      );
      setPassword("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      onMaintenance(false);
    }
  }
  const rows =
    kind === "tasks"
      ? catalog?.groups.map((r) => ({ id: r.id, label: `${r.title} (${r.tasks})` }))
      : catalog?.archives.archives.map((r) => ({
          id: r.archive_id,
          label: `${r.title} (${r.tasks})`,
        }));
  return (
    <section aria-label={tr("数据清理", "Data maintenance")}>
      <p>
        {tr(
          "先暂停运行中的任务。预览不会删除数据；确认后会停止引擎。处理完成后重新启动软件。",
          "Pause running tasks first. Preview does not delete data; confirmation stops the engine. Restart after maintenance.",
        )}
      </p>
      <fieldset disabled={busy || stopped}>
        <label>
          {tr("清理范围", "Cleanup scope")}
          <select
            aria-label={tr("清理范围", "Cleanup scope")}
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as MaintenanceSelection["kind"]);
              setSelected([]);
              clear();
            }}
          >
            <option value="unreferenced">
              {tr("仅回收未被记录使用的内容", "Collect unreferenced content only")}
            </option>
            <option value="versions">
              {tr("备份并清理旧文件版本", "Back up and prune old file versions")}
            </option>
            <option value="tasks">
              {tr("永久删除已归档的整组任务", "Permanently delete archived task groups")}
            </option>
            <option value="archives">
              {tr("移除导入的只读档案", "Remove imported read-only archives")}
            </option>
            <option value="reset">
              {tr("清空本机 WorkPilot 数据与凭据", "Reset local WorkPilot data and credentials")}
            </option>
          </select>
        </label>
        {kind === "versions" && (
          <>
            <label>
              {tr("文件历史位置", "History location")}
              <select
                aria-label={tr("文件历史位置", "History location")}
                value={root}
                onChange={(e) => {
                  setRoot(e.target.value);
                  clear();
                }}
              >
                <option value="">{tr("请选择", "Select")}</option>
                {catalog?.roots.map((r) => (
                  <option key={r.identity} value={r.identity}>
                    {r.path} ({r.versions})
                  </option>
                ))}
              </select>
            </label>
            <label>
              {tr("每个文件至少保留版本数", "Minimum versions retained per file")}
              <input
                type="number"
                min={1}
                max={1000}
                value={keep}
                onChange={(e) => {
                  setKeep(Number(e.target.value));
                  clear();
                }}
              />
            </label>
            <label>
              {tr("仅清理多少天前的版本", "Only prune versions older than days")}
              <input
                type="number"
                min={0}
                max={36500}
                value={days}
                onChange={(e) => {
                  setDays(Number(e.target.value));
                  clear();
                }}
              />
            </label>
          </>
        )}
        {(kind === "tasks" || kind === "archives") && (
          <div className="transfer-selection">
            {rows?.map((r) => (
              <label key={r.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(r.id)}
                  onChange={(e) => {
                    setSelected(
                      e.target.checked ? [...selected, r.id] : selected.filter((id) => id !== r.id),
                    );
                    clear();
                  }}
                />
                {r.label}
              </label>
            ))}
          </div>
        )}
        {kind === "tasks" && (
          <p>
            {tr(
              "删除所选根任务和全部助手的对话、附件、运行记录及文件版本。已导入的只读档案另行选择清理。项目文件保留。",
              "Deletes selected root tasks and all assistants, attachments, runs and file history. Imported read-only archives are separate. Project files remain.",
            )}
          </p>
        )}
        {kind === "reset" && (
          <p>
            {tr(
              "会移除当前数据目录的会话、设置、记忆、定时任务、扩展、文件历史和保存的模型/插件凭据。项目原文件、用户导出的包、更新前恢复副本及其他数据目录保留；请先导出需要的资料。更新恢复副本在软件更新中另行管理；清除本机版本密钥后，旧副本中的加密文件可能无法恢复，请优先另存口令备份。",
              "Removes conversations, settings, memory, schedules, extensions, history and saved credentials in this data directory. Project files and other data directories remain, along with exported archives and update recovery copies. Export anything you need first. Manage recovery copies separately in Software update. Removing the local history key may make encrypted files in older local copies unreadable; save a passphrase-protected export first.",
            )}
          </p>
        )}
        <button
          disabled={
            busy ||
            ((kind === "tasks" || kind === "archives") && !selected.length) ||
            (kind === "versions" && !root)
          }
          onClick={() => void inspect()}
        >
          {tr("预览清理范围", "Preview cleanup")}
        </button>
      </fieldset>
      {preview && (
        <div>
          {kind !== "reset" && kind !== "unreferenced" && (
            <p>
              {tr("将处理", "Will process")}: {preview.tasks.length} {tr("个任务", "tasks")},{" "}
              {preview.revision_ids.length} {tr("个文件版本", "file versions")},{" "}
              {preview.archives.length} {tr("份档案", "archives")}.
            </p>
          )}
          {kind === "unreferenced" && (
            <p>
              {tr(
                "仅回收不再被会话、附件、历史或恢复计划使用的内容；仍有引用的内容保留。",
                "Collect only content no longer referenced by conversations, attachments, history or recovery plans. Referenced content stays.",
              )}
            </p>
          )}
          {kind === "reset" && (
            <ul>
              {[
                ["tasks", tr("任务与助手", "Tasks and assistants")],
                ["file_revisions", tr("文件版本", "File versions")],
                ["media_assets", tr("附件与成果", "Attachments and outputs")],
                ["memories", tr("记忆", "Memory items")],
                ["schedules", tr("定时任务", "Schedules")],
                ["provider_profiles", tr("模型配置", "Model profiles")],
                ["extension_installations", tr("扩展安装记录", "Extension installations")],
              ].map(([key, label]) => (
                <li key={key}>
                  {label}: {preview.totals[key] ?? 0}
                </li>
              ))}
            </ul>
          )}
          {preview.backup_required && (
            <>
              <p>
                {tr(
                  "先保存并重新解密校验备份，再删除旧版本。备份失败将保留全部版本。",
                  "An encrypted backup is saved and decrypted for verification before pruning. Backup failure keeps every revision.",
                )}
              </p>
              <label>
                {tr("版本备份位置", "History backup path")}
                <input
                  value={path}
                  disabled={busy || stopped}
                  onChange={(e) => setPath(e.target.value)}
                />
              </label>
              <button
                disabled={busy || stopped}
                onClick={() =>
                  void invoke<string | null>("pick_history_archive", { save: true })
                    .then((p) => {
                      if (p) setPath(p);
                    })
                    .catch((e) => setError(String(e)))
                }
              >
                {tr("选择备份位置", "Choose backup location")}
              </button>
              <label>
                {tr("备份口令（至少12个字符）", "Backup passphrase (12+ characters)")}
                <input
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  disabled={busy}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
            </>
          )}
          <label>
            {tr("输入确认文字", "Type confirmation")} {preview.confirmation}
            <input
              aria-label={tr("输入确认文字", "Type confirmation")}
              value={confirm}
              disabled={busy || !!result}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
          <button
            disabled={
              busy ||
              !!result ||
              confirm !== preview.confirmation ||
              (preview.backup_required && (!path || Array.from(password).length < 12))
            }
            onClick={() => void apply()}
          >
            {tr("确认并停止引擎进行清理", "Confirm, stop engine and clean up")}
          </button>
        </div>
      )}
      {result && (
        <p role="status">
          {tr(
            result.cleanup_error
              ? "记录已处理，但内容回收未完成。项目原文件保留，请重启后重新预览。"
              : "处理完成。项目原文件保留，请重新启动软件。",
            result.cleanup_error
              ? "Records were processed, but content collection is incomplete. Project files remain. Restart and preview again."
              : "Maintenance completed. Project files remain. Restart the app.",
          )}
          {result.cleanup_error ? ` ${String(result.cleanup_error)}` : ""}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {stopped && (
        <button
          disabled={busy}
          onClick={() => void invoke("maintenance_restart").catch((e) => setError(String(e)))}
        >
          {tr("重新启动 WorkPilot", "Restart WorkPilot")}
        </button>
      )}
    </section>
  );
}
