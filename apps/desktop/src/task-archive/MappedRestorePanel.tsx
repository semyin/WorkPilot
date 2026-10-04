import { useEffect, useState } from "react";
import { executionCommand } from "../executionClient";
import { useWords, workspaceQuery } from "../workspaceClient";
import { taskArchive } from "./client";
import type {
  ProfileCatalog,
  WorkspaceProject,
  TaskProfileMapping,
  TaskProjectMapping,
  HistoryRootMapping,
} from "../generated/contracts";
import { RecoverySummary, type RecoveryItem } from "./MigrationRecovery";
type Source = {
  task_id: string;
  title: string;
  project_id: string | null;
  model: { model: string; protocol: string; base_url: string } | null;
};
type Receipt = { task_id: string; title: string; deleted?: boolean };
type Options = Receipt & { already_restored: boolean; tasks?: Source[]; history_roots?: string[] };
type Preview = Receipt & {
  already_restored: boolean;
  fingerprint: string;
  tasks?: {
    task_id: string;
    title: string;
    recovery?: RecoveryItem[];
    project?: WorkspaceProject;
  }[];
};
export function MappedRestorePanel({
  archive,
  onOpen,
}: {
  archive: string;
  onOpen: (id: string) => void;
}) {
  const tr = useWords();
  const [sources, setSources] = useState<Source[]>([]),
    [models, setModels] = useState<ProfileCatalog["profiles"]>([]);
  const [projects, setProjects] = useState<WorkspaceProject[]>([]),
    [profiles, setProfiles] = useState<TaskProfileMapping[]>([]);
  const [mapping, setMapping] = useState<TaskProjectMapping[]>([]),
    [roots, setRoots] = useState<HistoryRootMapping[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null),
    [receipt, setReceipt] = useState<Receipt | null>(null);
  const [busy, setBusy] = useState(true),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void Promise.all([
      taskArchive<Options>({ kind: "team_restore_options", archive_id: archive }),
      executionCommand({ kind: "read", query: { kind: "profiles" } }),
      workspaceQuery({ kind: "overview" }),
    ])
      .then(([o, m, p]) => {
        if (!alive) return;
        if (o.already_restored) {
          setReceipt(o);
          return;
        }
        const sources = o.tasks || [];
        setSources(sources);
        const models = m.kind === "profiles" ? m.catalog.profiles : [];
        setModels(models);
        setProjects(p.kind === "overview" ? p.projects : []);
        setProfiles(
          sources.map((s) => ({
            task_id: s.task_id,
            profile_id:
              models.find(
                ({ profile: p }) =>
                  s.model &&
                  p.model === s.model.model &&
                  p.protocol === s.model.protocol &&
                  p.base_url === s.model.base_url,
              )?.profile.id || "",
          })),
        );
        setMapping(
          [...new Set(sources.map((s) => s.project_id))].map((source_project_id) => ({
            source_project_id,
            project_id: null,
          })),
        );
        setRoots((o.history_roots || []).map((source_root) => ({ source_root, project_id: "" })));
      })
      .catch((e) => {
        if (alive) setError(String(e));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [archive]);
  async function act(confirm: boolean) {
    setBusy(true);
    setError("");
    try {
      const options = { archive_id: archive, profiles, projects: mapping, history_roots: roots };
      if (confirm && preview) {
        setReceipt(
          await taskArchive<Receipt>({
            kind: "mapped_restore",
            ...options,
            fingerprint: preview.fingerprint,
          }),
        );
      } else setPreview(await taskArchive<Preview>({ kind: "mapped_restore_preview", ...options }));
    } catch (e) {
      setError(String(e));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }
  const optionList = (
    <>
      <option value="">{tr("请选择项目", "Choose project")}</option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.settings.name} · {p.settings.root_path}
        </option>
      ))}
    </>
  );
  return (
    <details>
      <summary>
        {tr("分别映射多个项目和原文件夹", "Map multiple projects and source folders")}
      </summary>
      <p>
        {tr(
          "每个原项目和历史目录都要明确选择。各任务保留自己的项目权限；不会自动合并不同目录。",
          "Map every original project and historical folder explicitly. Tasks retain separate project boundaries.",
        )}
      </p>
      {!receipt && (
        <fieldset disabled={busy}>
          {sources.map((s) => (
            <label key={s.task_id}>
              {s.title}
              <select
                value={profiles.find((p) => p.task_id === s.task_id)?.profile_id || ""}
                onChange={(e) => {
                  setProfiles((ps) =>
                    ps.map((p) =>
                      p.task_id === s.task_id ? { ...p, profile_id: e.target.value } : p,
                    ),
                  );
                  setPreview(null);
                }}
              >
                <option value="">{tr("选择模型", "Choose model")}</option>
                {models.map(({ profile: p }) => (
                  <option key={p.id} value={p.id}>
                    {p.label} · {p.model}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {mapping.map((m, i) => (
            <label key={m.source_project_id || "none"}>
              {tr("原项目 ", "Source project ")}
              {m.source_project_id || tr("未绑定", "Unbound")}
              <select
                value={m.project_id || ""}
                onChange={(e) => {
                  setMapping((ms) =>
                    ms.map((m, n) => (n === i ? { ...m, project_id: e.target.value || null } : m)),
                  );
                  setPreview(null);
                }}
              >
                {optionList}
              </select>
            </label>
          ))}
          {roots.map((r, i) => (
            <label key={r.source_root}>
              {tr("历史原目录 ", "Historical source folder ")}
              {r.source_root}
              <select
                value={r.project_id}
                onChange={(e) => {
                  setRoots((rs) =>
                    rs.map((r, n) => (n === i ? { ...r, project_id: e.target.value } : r)),
                  );
                  setPreview(null);
                }}
              >
                {optionList}
              </select>
            </label>
          ))}
          <button
            disabled={
              !profiles.length ||
              profiles.some((p) => !p.profile_id) ||
              roots.some((r) => !r.project_id)
            }
            onClick={() => void act(false)}
          >
            {tr("预览分别映射的恢复", "Preview mapped restoration")}
          </button>
        </fieldset>
      )}
      {preview && !preview.already_restored && !receipt && (
        <div className="transfer-preview">
          {preview.tasks?.map((t) => (
            <div key={t.task_id}>
              <p>
                {t.title} · {t.project?.settings.root_path}
              </p>
              <RecoverySummary items={t.recovery} />
            </div>
          ))}
          <button disabled={busy} onClick={() => void act(true)}>
            {tr("确认映射并恢复", "Confirm mappings and restore")}
          </button>
        </div>
      )}
      {receipt && (
        <p>
          {receipt.title}{" "}
          <button disabled={receipt.deleted} onClick={() => onOpen(receipt.task_id)}>
            {receipt.deleted
              ? tr("恢复任务已删除", "Restored task was deleted")
              : tr("打开恢复任务", "Open restored task")}
          </button>
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
