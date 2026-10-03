import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { executionCommand } from "./executionClient";
import { useWords, workspaceQuery } from "./workspaceClient";
import type {
  WorkspaceProject,
  ProviderProfile,
  MemoryItem,
  ProjectTransferAction,
} from "./generated/contracts";
import "./transfer.css";
type Preview = {
  fingerprint: string;
  source_project: string;
  rules: string;
  root_path: string;
  profiles: ProviderProfile[];
  memories: MemoryItem[];
  memory_history: { memory_id: string; versions: number }[];
  conflicts: string[];
  already_imported: boolean;
  credentials_required: boolean;
};
export function ProjectTransferPanel() {
  const tr = useWords();
  const [projects, setProjects] = useState<WorkspaceProject[]>([]),
    [profiles, setProfiles] = useState<ProviderProfile[]>([]);
  const [project, setProject] = useState(""),
    [memories, setMemories] = useState<MemoryItem[]>([]),
    [total, setTotal] = useState(0),
    [offset, setOffset] = useState(0);
  const [profileIds, setProfileIds] = useState<string[]>([]),
    [memoryIds, setMemoryIds] = useState<string[]>([]);
  const [includeHistory, setIncludeHistory] = useState(false);
  const [destination, setDestination] = useState(""),
    [exportPassword, setExportPassword] = useState(""),
    [repeat, setRepeat] = useState("");
  const [source, setSource] = useState(""),
    [password, setPassword] = useState(""),
    [folder, setFolder] = useState(""),
    [name, setName] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const guard = useRef(false),
    alive = useRef(true),
    generation = useRef(0);
  useEffect(() => {
    alive.current = true;
    void Promise.all([
      workspaceQuery({ kind: "overview" }),
      executionCommand({ kind: "read", query: { kind: "profiles" } }),
    ])
      .then(([overview, models]) => {
        if (!alive.current) return;
        if (overview.kind === "overview") setProjects(overview.projects);
        if (models.kind === "profiles") setProfiles(models.catalog.profiles.map((p) => p.profile));
      })
      .catch((e) => alive.current && setError(String(e)));
    return () => {
      alive.current = false;
      generation.current++;
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
      if (alive.current) {
        setError(String(e));
        setPreview(null);
      }
    } finally {
      guard.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const call = async (action: ProjectTransferAction) => {
    const r = await executionCommand({ kind: "project_transfer", action });
    if (r.kind !== "workbench") throw new Error("Unexpected settings transfer response");
    return r.data as unknown as Preview;
  };
  const loadMemories = async (id: string, append = false, withHistory = includeHistory) => {
    const current = ++generation.current;
    const start = append ? offset : 0;
    const r = await executionCommand({
      kind: "memory",
      action: {
        kind: "list",
        project_id: id,
        search: "",
        include_deleted: withHistory,
        offset: start,
        limit: 64,
      },
    });
    if (
      !alive.current ||
      current !== generation.current ||
      r.kind !== "memory" ||
      r.data.kind !== "list"
    )
      return;
    const items = r.data.items.filter((m) => withHistory || m.state === "confirmed");
    setMemories((old) => (append ? [...old, ...items] : items));
    setOffset(start + r.data.items.length);
    setTotal(r.data.total);
  };
  const selectProject = async (id: string) => {
    setProject(id);
    setMemories([]);
    setMemoryIds([]);
    setOffset(0);
    setTotal(0);
    generation.current++;
    const selected = projects.find((p) => p.id === id)?.settings.default_profile_id;
    setProfileIds(selected && profiles.some((p) => p.id === selected) ? [selected] : []);
    if (id) await loadMemories(id);
  };
  const toggle = (ids: string[], id: string, checked: boolean) =>
    checked ? [...ids, id] : ids.filter((v) => v !== id);
  const pick = async (save: boolean) => {
    const path = await invoke<string | null>("pick_settings_archive", { save });
    if (path && alive.current) {
      if (save) setDestination(path);
      else {
        setSource(path);
        setPreview(null);
      }
    }
  };
  const valid = (p: string) => Array.from(p).length >= 12;
  const memoryState = (m: MemoryItem) =>
    m.deleted
      ? tr("已删除", "Deleted")
      : m.state === "suggested"
        ? tr("待确认", "Pending confirmation")
        : m.state === "rejected"
          ? tr("已拒绝", "Rejected")
          : tr("已确认", "Confirmed");
  const changeImport = (setter: (s: string) => void, value: string) => {
    setter(value);
    setPreview(null);
  };
  return (
    <div className="project-transfer history-transfer">
      <p>
        {tr(
          "本入口迁移项目名称和规则、勾选的模型配置与记忆。可包含候选、已删除记忆和旧版本；会话、技能、定时计划、项目文件和文件历史不在此包内。",
          "Transfers project name and rules, selected model configurations and memories, optionally including candidates, deleted entries and revisions. Conversations, skills, schedules, project files and file history are not included.",
        )}
      </p>
      <p>
        {tr(
          "口令至少 12 个字符，软件不保存口令。每次最多选择 128 个模型和 128 条记忆，设置包最多 1 MiB。",
          "Use at least 12 characters; WorkPilot does not save the passphrase. Up to 128 models, 128 memories and 1 MiB per settings archive.",
        )}
      </p>
      <fieldset disabled={busy}>
        <legend>{tr("导出项目设置", "Export project settings")}</legend>
        <label>
          {tr("源项目", "Source project")}
          <select
            aria-label={tr("源项目", "Source project")}
            value={project}
            onChange={(e) => void act(() => selectProject(e.target.value))}
          >
            <option value="">{tr("选择项目", "Select a project")}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.settings.name}
              </option>
            ))}
          </select>
        </label>
        <p>
          {tr(
            "模型配置（不包含密钥；可取消默认勾选）",
            "Model configurations (no credentials; you may deselect the default)",
          )}
        </p>
        <div className="transfer-selection">
          {profiles.map((p) => (
            <label key={p.id}>
              <input
                type="checkbox"
                checked={profileIds.includes(p.id)}
                onChange={(e) => setProfileIds(toggle(profileIds, p.id, e.target.checked))}
              />
              <span>
                {p.label} · {p.model}
              </span>
            </label>
          ))}
        </div>
        <label>
          <input
            type="checkbox"
            checked={includeHistory}
            onChange={(e) => {
              const enabled = e.target.checked;
              setIncludeHistory(enabled);
              setMemoryIds([]);
              if (project) void act(() => loadMemories(project, false, enabled));
            }}
          />
          {tr("包含记忆历史与未生效记录", "Include memory history and inactive entries")}
        </label>
        {includeHistory && (
          <p>
            {tr(
              "候选、已拒绝、已删除的记忆保持原状态。每条最多 256 个历史版本，每包最多 2048 个；超限会明确报错，不截断历史。曾属于其它项目的旧版本暂不导出。",
              "Candidates, rejected and deleted entries keep their state. Limits: 256 revisions per entry, 2048 per archive; oversized or cross-project histories are rejected without truncation.",
            )}
          </p>
        )}
        <p>
          {includeHistory
            ? tr("选择记忆及全部历史", "Select memories and their complete history")
            : tr("选择已确认的记忆", "Select confirmed memories")}
        </p>
        <div className="transfer-selection">
          {memories.map((m) => (
            <label key={m.id}>
              <input
                type="checkbox"
                checked={memoryIds.includes(m.id)}
                onChange={(e) => setMemoryIds(toggle(memoryIds, m.id, e.target.checked))}
              />
              <span>
                {m.project_id ? tr("项目", "Project") : tr("通用", "Global")} ·{" "}
                {includeHistory && `${memoryState(m)} · `}
                {m.text}
              </span>
            </label>
          ))}
        </div>
        {offset < total && (
          <button type="button" onClick={() => void act(() => loadMemories(project, true))}>
            {tr("加载更多记忆", "Load more memories")}
          </button>
        )}
        <small>
          {tr("已选模型 / 记忆：", "Selected models / memories: ")}
          {profileIds.length} / {memoryIds.length}
        </small>
        <label>
          {tr("设置包保存位置", "Save settings archive to")}
          <input value={destination} onChange={(e) => setDestination(e.target.value)} />
        </label>
        <button type="button" onClick={() => void act(() => pick(true))}>
          {tr("选择设置包保存位置", "Choose settings archive location")}
        </button>
        <label>
          {tr("设置迁移口令", "Settings archive passphrase")}
          <input
            type="password"
            autoComplete="new-password"
            value={exportPassword}
            onChange={(e) => setExportPassword(e.target.value)}
          />
        </label>
        <label>
          {tr("再次输入迁移口令", "Repeat settings passphrase")}
          <input
            type="password"
            autoComplete="new-password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={
            !project ||
            !destination ||
            !valid(exportPassword) ||
            exportPassword !== repeat ||
            profileIds.length > 128 ||
            memoryIds.length > 128
          }
          onClick={() =>
            void act(async () => {
              await call({
                kind: "export",
                project_id: project,
                profile_ids: profileIds,
                memory_ids: memoryIds,
                include_memory_history: includeHistory,
                path: destination,
                password: exportPassword,
              });
              if (alive.current) {
                setExportPassword("");
                setRepeat("");
                setMessage(tr("项目设置包已保存。", "Project settings archive saved."));
              }
            })
          }
        >
          {tr("保存项目设置包", "Save project settings archive")}
        </button>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>{tr("导入为新项目", "Import as a new project")}</legend>
        <label>
          {tr("项目设置包", "Project settings archive")}
          <input value={source} onChange={(e) => changeImport(setSource, e.target.value)} />
        </label>
        <button type="button" onClick={() => void act(() => pick(false))}>
          {tr("选择项目设置包", "Choose project settings archive")}
        </button>
        <label>
          {tr("输入迁移口令", "Enter settings passphrase")}
          <input
            type="password"
            autoComplete="off"
            value={password}
            onChange={(e) => changeImport(setPassword, e.target.value)}
          />
        </label>
        <label>
          {tr("新项目名称", "New project name")}
          <input value={name} onChange={(e) => changeImport(setName, e.target.value)} />
        </label>
        <label>
          {tr("目标项目文件夹", "Target project folder")}
          <input value={folder} onChange={(e) => changeImport(setFolder, e.target.value)} />
        </label>
        <button
          type="button"
          onClick={() =>
            void act(async () => {
              const p = await invoke<string | null>("pick_project_folder");
              if (p && alive.current) changeImport(setFolder, p);
            })
          }
        >
          {tr("选择目标文件夹", "Choose target folder")}
        </button>
        <button
          type="button"
          disabled={!source || !folder || !name.trim() || !valid(password)}
          onClick={() =>
            void act(async () => {
              const p = await call({
                kind: "inspect",
                path: source,
                password,
                root_path: folder,
                name,
              });
              if (alive.current) setPreview(p);
            })
          }
        >
          {tr("预览项目迁移", "Preview project transfer")}
        </button>
        {preview && (
          <div
            className="transfer-preview"
            role="region"
            aria-label={tr("项目迁移预览", "Project transfer preview")}
          >
            <p>
              {preview.source_project} → {name}
            </p>
            <p>{preview.root_path}</p>
            <p>
              {tr(
                "导入后权限为“请求审批”。现有模型和全局默认模型保持不变，不会移动或覆盖项目文件。",
                "Imported project uses Request approval. Existing models and the global default stay unchanged. Project files will not be moved or overwritten.",
              )}
            </p>
            {preview.credentials_required && (
              <p>
                {tr(
                  "这些模型使用密钥，导入后需要重新填写。",
                  "These models use credentials. Re-enter them after import.",
                )}
              </p>
            )}
            <details>
              <summary>{tr("查看项目规则", "Review project rules")}</summary>
              <pre>{preview.rules || tr("无项目规则", "No project rules")}</pre>
            </details>
            <p>
              {tr("新建模型配置：", "New model configurations: ")}
              {preview.profiles.length}
            </p>
            <ul>
              {preview.profiles.map((p) => (
                <li key={p.id}>
                  {p.label} · {p.model} · {p.base_url}
                </li>
              ))}
            </ul>
            <p>
              {preview.memory_history.length
                ? tr(
                    "只会启用当前已确认且未删除的记忆。候选仍待确认，已拒绝或已删除的记录不会生效。通用记忆会用于所有项目。导入后可在“记忆”中查看和恢复旧版本。",
                    "Only currently confirmed, undeleted memories become active. Candidates still need confirmation; rejected and deleted entries stay inactive. Global memories apply to all projects. Review and restore revisions in Memory after import.",
                  )
                : tr(
                    "确认导入后，下列记忆生效。通用记忆会用于所有项目。",
                    "Confirming import activates these memories. Global memories apply to all projects.",
                  )}
            </p>
            <ul>
              {preview.memories.map((m) => (
                <li key={m.id}>
                  {m.project_id ? tr("项目", "Project") : tr("通用", "Global")} · {m.text}
                  {preview.memory_history.find((h) => h.memory_id === m.id) && (
                    <small>
                      {" "}
                      · {memoryState(m)} ·{" "}
                      {preview.memory_history.find((h) => h.memory_id === m.id)!.versions}{" "}
                      {tr("个历史版本", "historical revisions")}
                    </small>
                  )}
                </li>
              ))}
            </ul>
            {preview.conflicts.map((c, i) => (
              <p className="error" key={i}>
                {c}
              </p>
            ))}
            {preview.already_imported ? (
              <p>
                {tr(
                  "此设置包已导入该文件夹，不会重复添加。",
                  "Already imported for this folder; nothing will be duplicated.",
                )}
              </p>
            ) : (
              <button
                type="button"
                disabled={preview.conflicts.length > 0}
                onClick={() =>
                  void act(async () => {
                    await call({
                      kind: "import",
                      path: source,
                      password,
                      root_path: folder,
                      name,
                      fingerprint: preview.fingerprint,
                    });
                    if (alive.current) {
                      setPassword("");
                      setPreview(null);
                      setMessage(
                        tr(
                          preview.credentials_required
                            ? "项目设置已导入。请在“配置模型服务”中重新填写密钥；已有配置和文件保持原样。"
                            : "项目设置已导入，已有配置和文件保持原样。",
                          preview.credentials_required
                            ? "Project settings imported. Re-enter credentials in Configure model services. Existing configurations and files are unchanged."
                            : "Project settings imported. Existing configurations and files are unchanged.",
                        ),
                      );
                    }
                  })
                }
              >
                {tr("确认导入项目设置与记忆", "Confirm project and memory import")}
              </button>
            )}
          </div>
        )}
      </fieldset>
      {busy && <p role="status">{tr("正在处理项目设置…", "Processing project settings…")}</p>}
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
