import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { executionCommand } from "./executionClient";
import { useWords } from "./workspaceClient";
import type {
  ExtensionSelection,
  ExtensionTransferAction,
  PluginInstallation,
  PluginVersion,
  PluginPreview,
} from "./generated/contracts";
import "./transfer.css";

type Item = { installation: PluginInstallation; version: PluginVersion };
type PreviewEntry = Pick<PluginVersion, "manifest" | "files" | "permissions" | "warnings"> & {
  source_id: string;
  project_scoped: boolean;
  was_enabled: boolean;
  draft: boolean;
  installed: boolean;
  versions: {
    digest: string;
    version: string;
    files: PluginVersion["files"];
    permissions: string[];
  }[];
};
type Preview = {
  fingerprint: string;
  entries: PreviewEntry[];
  conflicts: string[];
  already_imported: boolean;
};
export function ExtensionTransferPanel({
  task,
  onImported,
}: {
  task: string | null;
  onImported: () => Promise<void>;
}) {
  const tr = useWords();
  const [items, setItems] = useState<Item[]>([]);
  const [selection, setSelection] = useState<ExtensionSelection[]>([]);
  const [drafts, setDrafts] = useState<PluginPreview[]>([]);
  const [draftIds, setDraftIds] = useState<string[]>([]);
  const [includeHistory, setIncludeHistory] = useState(true);
  const selectedCount = selection.length + draftIds.length;
  const [destination, setDestination] = useState(""),
    [source, setSource] = useState("");
  const [exportPassword, setExportPassword] = useState(""),
    [repeat, setRepeat] = useState("");
  const [password, setPassword] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const guard = useRef(false),
    alive = useRef(true);
  const load = async () => {
    const r = await executionCommand({
      kind: "extension_transfer",
      task_id: task,
      action: { kind: "catalog" },
    });
    if (r.kind !== "workbench") throw new Error("Unexpected extension catalog response");
    if (alive.current) {
      const data = r.data as unknown as { items: Item[]; drafts: PluginPreview[] };
      setItems(data.items);
      setDrafts(data.drafts);
    }
  };
  useEffect(() => {
    alive.current = true;
    void load().catch((e) => alive.current && setError(String(e)));
    return () => {
      alive.current = false;
    };
  }, [task]);
  const act = async (work: () => Promise<void>) => {
    if (guard.current) return;
    guard.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      if (alive.current) {
        setError(String(e));
        setPreview(null);
      }
    } finally {
      guard.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const call = async (action: ExtensionTransferAction) => {
    const r = await executionCommand({ kind: "extension_transfer", task_id: task, action });
    if (r.kind !== "workbench") throw new Error("Unexpected extension transfer response");
    return r.data;
  };
  const pick = async (save: boolean) => {
    const path = await invoke<string | null>("pick_extension_archive", { save });
    if (path && alive.current) {
      if (save) setDestination(path);
      else {
        setSource(path);
        setPreview(null);
      }
    }
  };
  const valid = (value: string) => Array.from(value).length >= 12;
  return (
    <details className="history-transfer project-transfer">
      <summary>{tr("技能与插件迁移", "Skill and plugin transfer")}</summary>
      <p>
        {tr(
          "备份扩展、历史版本和待安装草稿。全局范围保留，项目扩展绑定所选任务的项目。导入的扩展先停用，已卸载项和草稿保留原状态；凭据重填后再检查启用。",
          "Back up extensions, historical versions and pending drafts. Project packages map to the selected task's project. Imported extensions stay disabled; uninstalled items and drafts retain their state. Reconfigure credentials before activation.",
        )}
      </p>
      <p>
        {tr(
          "最多选择 32 项，每个扩展最多 128 个版本，所有版本合计最多 2048 个文件、64 MiB 原文。登录信息和运行中的会话不迁移。",
          "Select up to 32 items, with 128 versions per extension. All versions combined are limited to 2048 files and 64 MiB. Sign-ins and running sessions are excluded.",
        )}
      </p>
      <fieldset disabled={busy}>
        <legend>{tr("导出所选扩展", "Export selected extensions")}</legend>
        <button
          onClick={() =>
            void act(async () => {
              await load();
              setSelection([]);
              setDraftIds([]);
            })
          }
        >
          {tr("刷新扩展列表", "Refresh extension list")}
        </button>
        <label>
          <input
            type="checkbox"
            checked={includeHistory}
            onChange={(e) => setIncludeHistory(e.target.checked)}
          />
          {tr("包含所选扩展的历史版本", "Include earlier versions of selected extensions")}
        </label>
        <div className="transfer-selection">
          {items.map(({ installation: i, version: v }) => (
            <label key={i.id}>
              <input
                type="checkbox"
                checked={selection.some((s) => s.installation_id === i.id)}
                onChange={(e) =>
                  setSelection((old) =>
                    e.target.checked
                      ? [...old, { installation_id: i.id, revision: i.revision }]
                      : old.filter((s) => s.installation_id !== i.id),
                  )
                }
              />
              <span>
                {v.manifest.name} · {v.manifest.version} ·{" "}
                {i.scope ? tr("项目", "Project") : tr("全局", "Global")} ·{" "}
                {!i.installed
                  ? tr("已卸载，保留历史", "Uninstalled; history retained")
                  : i.enabled
                    ? tr("已启用", "Enabled")
                    : tr("已停用", "Disabled")}
              </span>
            </label>
          ))}
          {drafts.map((p) => (
            <label key={p.id}>
              <input
                type="checkbox"
                checked={draftIds.includes(p.id)}
                onChange={(e) =>
                  setDraftIds((old) =>
                    e.target.checked ? [...old, p.id] : old.filter((id) => id !== p.id),
                  )
                }
              />
              <span>
                {p.version.manifest.name} · {p.version.manifest.version} ·{" "}
                {tr("待安装草稿", "Pending draft")} ·{" "}
                {p.scope ? tr("项目", "Project") : tr("全局", "Global")}
              </span>
            </label>
          ))}
        </div>
        <label>
          {tr("扩展备份保存位置", "Extension archive destination")}
          <input
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder="WorkPilot-extensions.wpextensions"
          />
        </label>
        <button onClick={() => void act(() => pick(true))}>
          {tr("选择扩展备份保存位置", "Choose extension archive destination")}
        </button>
        <label>
          {tr(
            "扩展备份口令（至少 12 个字符）",
            "Extension backup passphrase (at least 12 characters)",
          )}
          <input
            type="password"
            autoComplete="new-password"
            value={exportPassword}
            onChange={(e) => setExportPassword(e.target.value)}
          />
        </label>
        <label>
          {tr("再次输入扩展备份口令", "Repeat extension backup passphrase")}
          <input
            type="password"
            autoComplete="new-password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
        </label>
        <button
          disabled={
            !destination ||
            !selectedCount ||
            selectedCount > 32 ||
            !valid(exportPassword) ||
            repeat !== exportPassword
          }
          onClick={() =>
            void act(async () => {
              await call({
                kind: "export",
                selections: selection,
                include_history: includeHistory,
                draft_ids: draftIds,
                path: destination,
                password: exportPassword,
              });
              if (alive.current) {
                setExportPassword("");
                setRepeat("");
                setNotice(tr("扩展备份已保存。", "Extension archive saved."));
              }
            })
          }
        >
          {tr("保存扩展备份", "Save extension archive")} ({selectedCount})
        </button>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>{tr("导入扩展备份", "Import extension archive")}</legend>
        <label>
          {tr("扩展备份来源文件", "Extension archive source file")}
          <input
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setPreview(null);
            }}
          />
        </label>
        <button onClick={() => void act(() => pick(false))}>
          {tr("选择扩展备份文件", "Choose extension archive file")}
        </button>
        <label>
          {tr("扩展导入口令", "Extension import passphrase")}
          <input
            type="password"
            autoComplete="off"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setPreview(null);
            }}
          />
        </label>
        <button
          disabled={!source || !valid(password)}
          onClick={() =>
            void act(async () => {
              const data = await call({ kind: "inspect", path: source, password });
              if (alive.current) setPreview(data as unknown as Preview);
            })
          }
        >
          {tr("预览扩展迁移", "Preview extension transfer")}
        </button>
        {preview && (
          <section
            className="transfer-preview"
            aria-label={tr("扩展迁移预览", "Extension transfer preview")}
          >
            <p>
              {tr(
                "导入仅保存为停用状态。同名记录不会被覆盖，脚本和服务不会自动运行。",
                "Imports are saved disabled. Existing packages are preserved; scripts and services will not start automatically.",
              )}
            </p>
            {preview.already_imported && (
              <p>
                {tr(
                  "此备份已经导入，不会重复添加或重新启用。",
                  "This archive was already imported. It will not add duplicates or re-enable packages.",
                )}
              </p>
            )}
            {preview.conflicts.map((text) => (
              <p className="extension-error" key={text}>
                {text}
              </p>
            ))}
            {preview.entries.map((entry) => (
              <details key={entry.source_id} open>
                <summary>
                  {entry.manifest.name} · {entry.manifest.version} ·{" "}
                  {entry.project_scoped ? tr("目标项目", "Target project") : tr("全局", "Global")}
                </summary>
                <p>{entry.manifest.description}</p>
                <p>
                  {tr("原状态：", "Source state: ")}
                  {entry.draft
                    ? tr("待安装草稿", "Pending draft")
                    : !entry.installed
                      ? tr("已卸载", "Uninstalled")
                      : entry.was_enabled
                        ? tr("已启用", "Enabled")
                        : tr("已停用", "Disabled")}
                  {tr("；导入后不会自动启用", "; will not activate on import")}
                </p>
                {!!entry.versions?.length && (
                  <details>
                    <summary>
                      {tr("一并保留的旧版本", "Earlier versions preserved")} ·{" "}
                      {entry.versions.length}
                    </summary>
                    <ul>
                      {entry.versions.map((v) => (
                        <li key={v.digest}>
                          {v.version} · {v.files.length} {tr("个文件", "files")} ·{" "}
                          {v.permissions.join(" · ")}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                <p>
                  {tr("权限声明：", "Declared access: ")}
                  {entry.permissions.join(" · ") || tr("无额外声明", "No additional declarations")}
                </p>
                <p>
                  {tr("依赖：", "Dependencies: ")}
                  {entry.manifest.dependencies.map((d) => `${d.id} ${d.version}`).join(" · ") ||
                    tr("无", "None")}
                </p>
                {entry.manifest.servers.length > 0 && (
                  <p>
                    {tr(
                      "外部服务的登录和运行环境需在本机重新检查。",
                      "Review external-service sign-in and runtime availability on this machine.",
                    )}
                  </p>
                )}
                {entry.manifest.servers.map((server) => (
                  <div key={server.id}>
                    <strong>{server.name}</strong>
                    {server.transport.kind === "http" ? (
                      <p>
                        {server.transport.url} · {tr("认证方式：", "Authentication: ")}
                        {server.transport.auth}
                      </p>
                    ) : (
                      <>
                        <p>
                          {tr("运行环境：", "Runtime: ")}
                          {server.transport.runtime} · {tr("入口：", "Entry: ")}
                          {server.transport.entry}
                        </p>
                        <p>
                          {tr("参数：", "Arguments: ")}
                          {JSON.stringify(server.transport.args)}
                        </p>
                        <p>
                          {tr("需重新填写的凭据名称：", "Credential names to reconfigure: ")}
                          {server.transport.secret_env.join(", ") || tr("无", "None")}
                        </p>
                      </>
                    )}
                  </div>
                ))}
                {entry.warnings.map((text, n) => (
                  <p key={n}>{text}</p>
                ))}
                <details>
                  <summary>
                    {tr("查看所含文件", "Included files")} ({entry.files.length})
                  </summary>
                  <ul>
                    {entry.files.map((file) => (
                      <li key={file.path}>
                        {file.path} · {file.bytes} B
                      </li>
                    ))}
                  </ul>
                </details>
              </details>
            ))}
            <button
              disabled={preview.conflicts.length > 0}
              onClick={() =>
                void act(async () => {
                  const result = (await call({
                    kind: "import",
                    path: source,
                    password,
                    fingerprint: preview.fingerprint,
                  })) as unknown as { duplicate: boolean };
                  if (alive.current) {
                    setPassword("");
                    setPreview(null);
                    setSelection([]);
                    setNotice(
                      result.duplicate
                        ? tr(
                            "此备份已经导入，没有重复添加。",
                            "Already imported; no duplicates added.",
                          )
                        : tr(
                            "已导入并保持停用。请在扩展详情中检查文件、填写凭据，再按依赖顺序启用。",
                            "Imported disabled. Review resources and credentials in package details, then enable dependencies before dependent packages.",
                          ),
                    );
                    await load();
                    await onImported();
                  }
                })
              }
            >
              {tr("确认导入并保持停用", "Import and keep disabled")}
            </button>
          </section>
        )}
      </fieldset>
      {busy && <p role="status">{tr("正在处理扩展备份…", "Processing extension archive…")}</p>}
      {error && (
        <p role="alert" className="extension-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </details>
  );
}
