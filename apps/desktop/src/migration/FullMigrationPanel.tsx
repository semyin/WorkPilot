import { useEffect, useRef, useState } from "react";
import { useWords } from "../workspaceClient";
import type {
  MigrationDestination,
  MigrationHistoryMapping,
  MigrationSelection,
} from "../generated/contracts";
import { migration, type Catalog, type Preview, type Receipt, type Summary } from "./client";
import { RecoverySummary } from "../task-archive/MigrationRecovery";
import { MigrationSelectionForm } from "./Selection";
export function FullMigrationPanel({ onOpen }: { onOpen: (id: string) => void }) {
  const tr = useWords();
  const [catalog, setCatalog] = useState<Catalog | null>(null),
    [selected, setSelected] = useState<MigrationSelection[]>([]);
  const [path, setPath] = useState(""),
    [password, setPassword] = useState(""),
    [repeat, setRepeat] = useState("");
  const [summary, setSummary] = useState<Summary | null>(null),
    [destinations, setDestinations] = useState<MigrationDestination[]>([]);
  const [roots, setRoots] = useState<MigrationHistoryMapping[]>([]),
    [preview, setPreview] = useState<Preview | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const gate = useRef(false);
  useEffect(() => {
    let alive = true;
    void migration<Catalog>({ kind: "catalog" })
      .then((r) => {
        if (alive) setCatalog(r);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, []);
  async function act(work: () => Promise<void>) {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (e) {
      setError(String(e));
      setPreview(null);
    } finally {
      gate.current = false;
      setBusy(false);
    }
  }
  const invalidate = () => {
    setSummary(null);
    setPreview(null);
    setReceipt(null);
  };
  return (
    <section className="history-transfer project-transfer migration-panel">
      <p>
        {tr(
          "一次选择项目、会话、配置、记忆、技能和文件，保存为一个口令保护的迁移包。导入创建新项目，模型密钥需重新填写。",
          "Select projects, conversations, configuration, memories, skills and files in one pass. Import creates new projects; enter model credentials again.",
        )}
      </p>
      {catalog && (
        <MigrationSelectionForm
          catalog={catalog}
          selected={selected}
          disabled={busy}
          onChange={setSelected}
        />
      )}
      <label>
        {tr("迁移包完整路径（.wpmigrate）", "Full archive path (.wpmigrate)")}
        <input
          disabled={busy}
          value={path}
          onChange={(e) => {
            setPath(e.target.value);
            invalidate();
          }}
        />
      </label>
      <label>
        {tr("口令（至少 12 个字符）", "Passphrase (at least 12 characters)")}
        <input
          type="password"
          autoComplete="new-password"
          disabled={busy}
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            invalidate();
          }}
        />
      </label>
      <label>
        {tr("导出时重复口令", "Repeat passphrase for export")}
        <input
          type="password"
          autoComplete="new-password"
          disabled={busy}
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
        />
      </label>
      <div className="model-actions">
        <button
          disabled={
            busy || !selected.length || password.length < 12 || password !== repeat || !path
          }
          onClick={() =>
            void act(async () => {
              await migration({ kind: "export", selections: selected, path, password });
              setPassword("");
              setRepeat("");
              setMessage(tr("统一迁移包已保存。", "Unified archive saved."));
            })
          }
        >
          {tr("导出所选资料", "Export selected data")}
        </button>
        <button
          disabled={busy || password.length < 12 || !path}
          onClick={() =>
            void act(async () => {
              const s = await migration<Summary>({ kind: "inspect", path, password });
              setSummary(s);
              setPreview(null);
              setReceipt(s.resume || null);
              setDestinations(
                s.resume?.destinations ||
                  s.projects.map((p) => ({
                    source_project_id: p.id,
                    name: p.name + " · " + tr("迁入", "Imported"),
                    root_path: "",
                  })),
              );
              setRoots(
                s.resume?.history_roots ||
                  s.history_roots.map((root) => ({
                    source_root: root,
                    source_project_id: s.projects.find((p) => p.source_root === root)?.id || "",
                  })),
              );
            })
          }
        >
          {tr("读取并核验迁移包", "Read and verify archive")}
        </button>
      </div>
      {summary && (
        <div className="transfer-preview">
          <strong>{tr("逐个选择新项目位置", "Choose each new project location")}</strong>
          <p>
            {tr(
              "目标文件夹须已存在。遇到同名项目、已绑定目录或选定文件冲突会拒绝导入。",
              "Folders must exist. Existing project names, bound folders and selected-file conflicts are rejected.",
            )}
          </p>
          {summary.projects.map((p) => (
            <fieldset key={p.id} disabled={busy}>
              <legend>{p.name}</legend>
              <p>
                {p.profiles.length} {tr("个模型", "models")} · {p.memories.length}{" "}
                {tr("条记忆", "memories")} · {p.files?.length || 0}{" "}
                {tr("个当前文件", "current files")}
              </p>
              {(["name", "root_path"] as const).map((field) => (
                <label key={field}>
                  {field === "name"
                    ? tr("新项目名称", "New project name")
                    : tr("目标文件夹", "Destination folder")}
                  <input
                    value={destinations.find((d) => d.source_project_id === p.id)?.[field] || ""}
                    onChange={(e) => {
                      setDestinations((ds) =>
                        ds.map((d) =>
                          d.source_project_id === p.id ? { ...d, [field]: e.target.value } : d,
                        ),
                      );
                      setPreview(null);
                    }}
                  />
                </label>
              ))}
            </fieldset>
          ))}
          {roots.map((root, i) => (
            <label key={root.source_root}>
              {tr("历史原文件夹 ", "Historical source folder ")}
              {root.source_root}
              <select
                disabled={busy}
                value={root.source_project_id}
                onChange={(e) => {
                  setRoots((rs) =>
                    rs.map((r, n) => (n === i ? { ...r, source_project_id: e.target.value } : r)),
                  );
                  setPreview(null);
                }}
              >
                <option value="">{tr("选择目标项目", "Choose destination project")}</option>
                {summary.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {destinations.find((d) => d.source_project_id === p.id)?.name || p.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <p>
            {summary.tasks.reduce((n, t) => n + t.tasks.length, 0)}{" "}
            {tr("个主任务/助手", "tasks and assistants")}
          </p>
          <button
            disabled={
              busy ||
              destinations.some((d) => !d.name.trim() || !d.root_path.trim()) ||
              roots.some((r) => !r.source_project_id)
            }
            onClick={() =>
              void act(async () => {
                setPreview(
                  await migration<Preview>({
                    kind: "preview",
                    path,
                    password,
                    destinations,
                    history_roots: roots,
                  }),
                );
              })
            }
          >
            {tr("预览全部导入", "Preview complete import")}
          </button>
        </div>
      )}
      {preview && (
        <div className="transfer-preview">
          <p>{preview.rules}</p>
          {preview.recovery?.map((t) => (
            <div key={t.task_id}>
              <strong>{t.title}</strong>
              <RecoverySummary items={t.items} />
            </div>
          ))}
          {preview.conflicts.map((c, i) => (
            <p className="error" key={i}>
              {c}
            </p>
          ))}
          <button
            disabled={busy || preview.conflicts.length > 0}
            onClick={() =>
              void act(async () => {
                const r = await migration<Receipt>({
                  kind: "import",
                  path,
                  password,
                  destinations,
                  history_roots: roots,
                  fingerprint: preview.fingerprint,
                });
                setReceipt(r);
                if (r.status !== "partial") {
                  setPassword("");
                  setRepeat("");
                }
              })
            }
          >
            {preview.receipt
              ? tr("继续未完成导入", "Resume incomplete import")
              : tr("确认导入新项目与记录", "Confirm new projects and records")}
          </button>
        </div>
      )}
      {receipt && (
        <div className="transfer-preview">
          <strong>
            {tr("导入状态：", "Import status: ")}
            {{
              importing: tr("正在导入", "Importing"),
              partial: tr("部分完成，可继续导入", "Partially complete; import can resume"),
              awaiting_file_approval: tr(
                "记录已导入，文件等待审批",
                "Records imported; file approval required",
              ),
              complete: tr("导入完成", "Import complete"),
            }[receipt.status] || receipt.status}
          </strong>
          {receipt.error && <p className="error">{receipt.error}</p>}
          {Object.entries(receipt.tasks).map(([id, t]) => (
            <p key={id}>
              {t.title}{" "}
              <button disabled={t.deleted} onClick={() => onOpen(t.task_id)}>
                {t.deleted
                  ? tr("已删除，保留去重记录", "Deleted; import receipt retained")
                  : tr("打开恢复任务", "Open restored task")}
              </button>
            </p>
          ))}
          {Object.entries(receipt.files).map(([id, f]) => (
            <div key={id}>
              <p>
                {f.deleted
                  ? tr(
                      "文件迁入任务已删除，保留防重复记录",
                      "File import task deleted; receipt retained",
                    )
                  : `${f.files.length} ${
                      f.state === "completed"
                        ? tr(
                            "个文件已处理，请在任务中查看记录",
                            "files processed; view the task record",
                          )
                        : tr("个文件需要单独核对", "files require separate review")
                    }`}
              </p>
              <button
                disabled={busy || f.deleted}
                onClick={() =>
                  void act(async () => {
                    if (f.state !== "completed")
                      await migration({
                        kind: "prepare_files",
                        archive_id: receipt.archive_id,
                        source_project_id: id,
                      });
                    onOpen(f.task_id);
                  })
                }
              >
                {f.deleted
                  ? tr("已永久删除", "Permanently deleted")
                  : f.state === "completed"
                    ? tr("打开文件处理记录", "Open file operation record")
                    : tr("核对文件写入并打开审批", "Review file writes and open approval")}
              </button>
            </div>
          ))}
          <p>
            {tr(
              "任务需手动继续。迁入未决操作必须逐项填写核对说明；旧审批不生效。",
              "Continue tasks manually. Review each unresolved migrated operation; old approvals are inactive.",
            )}
          </p>
        </div>
      )}
      {busy && (
        <button
          onClick={() => void migration({ kind: "cancel" }).catch((e) => setError(String(e)))}
        >
          {tr("停止本次迁移", "Stop this migration")}
        </button>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
