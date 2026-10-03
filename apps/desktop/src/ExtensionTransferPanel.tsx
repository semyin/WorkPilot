import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { executionCommand } from "./executionClient";
import { useWords } from "./workspaceClient";
import type {
  ExtensionSelection,
  ExtensionTransferAction,
  PluginInstallation,
  PluginVersion,
} from "./generated/contracts";
import "./transfer.css";

type Item = { installation: PluginInstallation; version: PluginVersion };
type PreviewEntry = Pick<PluginVersion, "manifest" | "files" | "permissions" | "warnings"> & {
  source_id: string;
  project_scoped: boolean;
  was_enabled: boolean;
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
      kind: "extensions",
      task_id: task,
      action: { kind: "catalog", query: null },
    });
    if (r.kind !== "workbench") throw new Error("Unexpected extension catalog response");
    if (alive.current) setItems((r.data as unknown as { items: Item[] }).items);
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
          "批量备份当前安装版本及配套文件。全局范围保留，项目扩展绑定当前选中任务的项目。导入后全部停用，凭据需重填，再逐项检查并启用。",
          "Back up selected current versions and resources. Global scope is preserved; project packages map to the selected task’s project. Imports remain disabled. Reconfigure credentials, review and enable each package.",
        )}
      </p>
      <p>
        {tr(
          "最多 32 个扩展、2048 个文件、合计 64 MiB 原文。不包含旧安装版本、未安装草稿、登录信息和运行中的会话。",
          "Up to 32 packages, 2048 files and 64 MiB of file content. Earlier installed versions, uninstalled drafts, sign-ins and running sessions are excluded.",
        )}
      </p>
      <fieldset disabled={busy}>
        <legend>{tr("导出所选扩展", "Export selected extensions")}</legend>
        <button
          onClick={() =>
            void act(async () => {
              await load();
              setSelection([]);
            })
          }
        >
          {tr("刷新扩展列表", "Refresh extension list")}
        </button>
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
                {i.enabled ? tr("已启用", "Enabled") : tr("已停用", "Disabled")}
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
            !selection.length ||
            selection.length > 32 ||
            !valid(exportPassword) ||
            repeat !== exportPassword
          }
          onClick={() =>
            void act(async () => {
              await call({
                kind: "export",
                selections: selection,
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
          {tr("保存扩展备份", "Save extension archive")} ({selection.length})
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
                  {entry.was_enabled ? tr("已启用", "Enabled") : tr("已停用", "Disabled")}
                  {tr("；导入后：已停用", "; after import: disabled")}
                </p>
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
