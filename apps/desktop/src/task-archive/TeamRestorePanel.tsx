import { RecoverySummary, type RecoveryItem } from "./MigrationRecovery";
import { useEffect, useRef, useState } from "react";
import type { ProfileCatalog, WorkspaceProject } from "../generated/contracts";
import { executionCommand } from "../executionClient";
import { useWords, workspaceQuery, taskState } from "../workspaceClient";
import { taskArchive } from "./client";
import { FileHistorySummary, type RestoredFileHistory } from "./FileHistorySummary";
import { AttachmentSummary, CancelArchive, type RestoredAttachment } from "./Attachments";

type Receipt = { deleted?: boolean; task_id: string; title: string; restored_at_ms: number };
type Model = { model: string; protocol: string; base_url: string };
type Source = {
  task_id: string;
  title: string;
  state: string;
  parent_task_id: string | null;
  model: Model | null;
};
type Options =
  (Receipt & { already_restored: true }) | { already_restored: false; tasks: Source[] };
type Node = Omit<Source, "model"> &
  Model & {
    profile_id: string;
    mode: string;
    goal: string;
    depends_on: string[] | null;
    replaces_id: string | null;
    superseded_by: string | null;
    review: string | null;
    messages: number;
    queued: number;
    has_report: boolean;
    project_rules: string;
    recovery?: RecoveryItem[];
  };
type Preview =
  | (Receipt & { already_restored: true })
  | {
      already_restored: false;
      fingerprint: string;
      attachments?: RestoredAttachment[];
      file_history?: RestoredFileHistory[];
      file_history_included?: boolean;
      tasks: Node[];
      project: WorkspaceProject | null;
      settings: {
        enabled: boolean;
        max_parallel: number;
        max_members: number;
        max_depth: number;
        max_replacements: number;
      };
    };
export function TeamRestorePanel({
  archive,
  onOpen,
}: {
  archive: string;
  onOpen: (id: string) => void;
}) {
  const tr = useWords();
  const [profiles, setProfiles] = useState<ProfileCatalog["profiles"]>([]);
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [project, setProject] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const alive = useRef(true),
    gate = useRef(false);
  useEffect(() => {
    alive.current = true;
    void Promise.all([
      executionCommand({ kind: "read", query: { kind: "profiles" } }),
      workspaceQuery({ kind: "overview" }),
      taskArchive<Options>({ kind: "team_restore_options", archive_id: archive }),
    ])
      .then(([models, overview, options]) => {
        if (!alive.current) return;
        if (overview.kind === "overview") setProjects(overview.projects);
        if (models.kind === "profiles") setProfiles(models.catalog.profiles);
        if (options.already_restored) {
          setReceipt(options);
          return;
        }
        setSources(options.tasks);
        if (models.kind === "profiles") {
          const initial: Record<string, string> = {};
          for (const source of options.tasks) {
            const pin = source.model;
            if (pin)
              initial[source.task_id] =
                models.catalog.profiles.find(
                  ({ profile: p }) =>
                    p.model === pin.model &&
                    p.protocol === pin.protocol &&
                    p.base_url === pin.base_url,
                )?.profile.id || "";
          }
          setMapping(initial);
        }
      })
      .catch((e) => {
        if (alive.current) setError(String(e));
      })
      .finally(() => {
        if (alive.current) setBusy(false);
      });
    return () => {
      alive.current = false;
    };
  }, [archive]);
  async function act(confirm: boolean) {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setError("");
    try {
      const options = {
        archive_id: archive,
        project_id: project || null,
        profiles: sources.map((t) => ({
          task_id: t.task_id,
          profile_id: mapping[t.task_id] || "",
        })),
      };
      if (confirm && preview && !preview.already_restored) {
        const result = await taskArchive<Receipt>({
          kind: "team_restore",
          ...options,
          fingerprint: preview.fingerprint,
        });
        if (alive.current) {
          setReceipt(result);
          setPreview(null);
        }
      } else {
        const result = await taskArchive<Preview>({ kind: "team_restore_preview", ...options });
        if (alive.current) setPreview(result);
      }
    } catch (e) {
      if (alive.current) {
        setError(String(e));
        setPreview(null);
      }
    } finally {
      gate.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const restored = receipt || (preview?.already_restored ? preview : null);
  const name = (id: string) => sources.find((s) => s.task_id === id)?.title || id;
  const review = (value: string | null) =>
    value
      ? {
          pending: tr("待检查交付", "Review pending"),
          accepted: tr("交付已认可", "Delivery accepted"),
          abandoned: tr("已放弃此分支", "Branch abandoned"),
        }[value] || value
      : "";
  return (
    <section aria-label={tr("从档案恢复多助手任务", "Restore a task group from archive")}>
      <h3>{tr("从档案恢复多助手任务", "Restore a task group from archive")}</h3>
      <p>
        {tr(
          "保留主任务与助手的分工、依赖、接替关系、对话、附件和交付检查结论。未决原操作须人工核对；涉及多个项目或原文件夹时，请使用下方的分别映射入口。",
          "Preserves assignments, dependencies, replacements, conversations, attachments and delivery reviews. Unresolved source operations require review. For multiple projects or source folders, use the separate mapping section below.",
        )}
      </p>
      <p>
        {tr(
          "请先迁移所需文件。恢复不会启动团队；每个助手都采用‘请求审批’，命令执行关闭。手动继续主任务后，符合条件的未完成助手才按依赖启动。已完成、失败、被接替或放弃的分支不会自动重跑。",
          "Transfer required files first. Restoration starts no tasks; every assistant requires approval with commands disabled. Manually continue the main task to start eligible unfinished assistants in dependency order. Completed, failed, replaced and abandoned branches do not automatically rerun.",
        )}
      </p>
      {!restored && (
        <fieldset disabled={busy}>
          <legend>{tr("逐一选择本机模型", "Choose local models for each task")}</legend>
          <small>
            {tr(
              "已有模型历史须匹配原协议、模型名称和服务地址；使用本机密钥。尚未运行的助手可另选模型。",
              "Existing history requires the original protocol, model name and address, using local credentials. Assistants that have never run can use another model.",
            )}
          </small>
          {sources.map((s) => (
            <div className="archive-summary" key={s.task_id}>
              <strong>
                {s.parent_task_id ? tr("助手：", "Assistant: ") : tr("主任务：", "Main task: ")}
                {s.title}
              </strong>
              {s.parent_task_id && (
                <p>
                  {tr("上级任务：", "Parent task: ")}
                  {name(s.parent_task_id)}
                </p>
              )}
              {s.model && (
                <p>
                  {tr("原模型：", "Original model: ")}
                  {s.model.model} · {s.model.protocol} · {s.model.base_url}
                </p>
              )}
              <label>
                {tr("本机模型：", "Local model: ")}
                {s.title}
                <select
                  aria-label={tr("本机模型：", "Local model: ") + s.title}
                  value={mapping[s.task_id] || ""}
                  onChange={(e) => {
                    setMapping({ ...mapping, [s.task_id]: e.target.value });
                    setPreview(null);
                  }}
                >
                  <option value="">{tr("请选择模型配置", "Select model configuration")}</option>
                  {profiles.map(({ profile: p }) => (
                    <option key={p.id} value={p.id}>
                      {p.label} · {p.model} · {p.protocol}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ))}
          <label>
            {tr("团队恢复到项目", "Restore team into project")}
            <select
              aria-label={tr("团队恢复到项目", "Restore team into project")}
              value={project}
              onChange={(e) => {
                setProject(e.target.value);
                setPreview(null);
              }}
            >
              <option value="">
                {tr("不绑定项目（原团队无项目时）", "No project (if the original had none)")}
              </option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.settings.name} · {p.settings.root_path}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={!sources.length || sources.some((s) => !mapping[s.task_id])}
            onClick={() => void act(false)}
          >
            {tr("预览团队恢复", "Preview team restoration")}
          </button>
          {preview && !preview.already_restored && (
            <div aria-label={tr("团队恢复预览", "Team restoration preview")}>
              <AttachmentSummary attachments={preview.attachments} tasks={preview.tasks} />
              {preview.tasks.map((t) => (
                <RecoverySummary key={t.task_id} items={t.recovery} />
              ))}
              <FileHistorySummary
                rows={preview.file_history}
                included={preview.file_history_included}
                tasks={preview.tasks}
              />
              <p>{preview.project?.settings.root_path || tr("未绑定项目", "No project")}</p>
              <p>
                {tr("团队协作：", "Team coordination: ")}
                {preview.settings.enabled ? tr("开启", "Enabled") : tr("关闭", "Disabled")} ·{" "}
                {tr("最多同时运行的助手：", "Max parallel assistants: ")}
                {preview.settings.max_parallel} · {tr("成员上限：", "Member limit: ")}
                {preview.settings.max_members}
              </p>
              {preview.tasks.map((t) => (
                <div className="archive-summary" key={t.task_id}>
                  <strong>{t.title}</strong>
                  <p>
                    {tr("恢复后的状态：", "Restored state: ")}
                    {taskState(t.state, tr("zh", "en") === "en")}
                    {t.review && " · " + review(t.review)}
                  </p>
                  <p>
                    {t.model} · {t.protocol} · {t.base_url}
                  </p>
                  {t.parent_task_id && (
                    <p>
                      {tr("上级任务：", "Parent task: ")}
                      {name(t.parent_task_id)}
                    </p>
                  )}
                  {!!t.depends_on?.length && (
                    <p>
                      {tr("先等待：", "Depends on: ")}
                      {t.depends_on.map(name).join("、")}
                    </p>
                  )}
                  {t.replaces_id && (
                    <p>
                      {tr("接替：", "Replaces: ")}
                      {name(t.replaces_id)}
                    </p>
                  )}
                  {t.superseded_by && (
                    <p>
                      {tr("已由其他助手接替：", "Replaced by: ")}
                      {name(t.superseded_by)}
                    </p>
                  )}
                  <p>
                    {tr("用户消息：", "Messages: ")}
                    {t.messages} · {tr("排队消息：", "Queued: ")}
                    {t.queued} ·{" "}
                    {t.has_report
                      ? tr("保留交付记录", "Delivery preserved")
                      : tr("尚无交付记录", "No delivery yet")}
                  </p>
                  <details>
                    <summary>{tr("任务内容和规则", "Task instructions and rules")}</summary>
                    <pre>{t.goal}</pre>
                    <pre>{t.project_rules}</pre>
                  </details>
                </div>
              ))}
              <p>
                {tr(
                  "原审批和定时任务不会启用。待检查的交付需要重新查看后才能认可。",
                  "Old approvals and schedules remain inactive. Pending deliveries require a new inspection before acceptance.",
                )}
              </p>
              <button onClick={() => void act(true)}>
                {tr("确认恢复为新团队", "Restore as a new task group")}
              </button>
            </div>
          )}
        </fieldset>
      )}
      {busy && <p role="status">{tr("正在核对团队恢复内容…", "Checking team restoration…")}</p>}
      {busy && <CancelArchive />}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {restored && (
        <div role="status">
          <p>
            {tr(
              "这份档案已恢复。恢复操作不会自动启动任务；重复操作不会新建团队或重置权限。",
              "This archive is restored. Restoration does not start tasks; repeating it creates no duplicate and resets no permissions.",
            )}
          </p>
          <p>
            {restored.title} · {new Date(restored.restored_at_ms).toLocaleString()}
          </p>
          <button disabled={restored.deleted} onClick={() => onOpen(restored.task_id)}>
            {tr("打开恢复的主任务", "Open restored main task")}
          </button>
        </div>
      )}
    </section>
  );
}
