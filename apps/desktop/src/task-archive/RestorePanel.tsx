import { RecoverySummary, type RecoveryItem } from "./MigrationRecovery";
import { useEffect, useRef, useState } from "react";
import type { ProfileCatalog, WorkspaceProject } from "../generated/contracts";
import { executionCommand } from "../executionClient";
import { useWords, workspaceQuery, taskState } from "../workspaceClient";
import { taskArchive } from "./client";
import { FileHistorySummary, type RestoredFileHistory } from "./FileHistorySummary";
import { AttachmentSummary, CancelArchive, type RestoredAttachment } from "./Attachments";

type Receipt = {
  deleted?: boolean;
  task_id: string;
  title: string;
  restored_at_ms: number;
  fingerprint: string;
};
type Preview =
  | (Receipt & { already_restored: true })
  | {
      already_restored: false;
      fingerprint: string;
      title: string;
      messages: number;
      queued: number;
      history_items: number;
      recovery?: RecoveryItem[];
      history_results: number;
      model: string;
      protocol: string;
      base_url: string;
      project: WorkspaceProject | null;
      project_rules: string;
      state: string;
      mode: string;
      attachments?: RestoredAttachment[];
      file_history?: RestoredFileHistory[];
      file_history_included?: boolean;
    };
export function RestorePanel({
  archive,
  onOpen,
}: {
  archive: string;
  onOpen: (id: string) => void;
}) {
  const tr = useWords();
  const [profiles, setProfiles] = useState<ProfileCatalog["profiles"]>([]);
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [profile, setProfile] = useState("");
  const [project, setProject] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(true),
    gate = useRef(false);
  useEffect(() => {
    alive.current = true;
    void Promise.all([
      executionCommand({ kind: "read", query: { kind: "profiles" } }),
      workspaceQuery({ kind: "overview" }),
    ])
      .then(([models, overview]) => {
        if (!alive.current) return;
        if (models.kind === "profiles") setProfiles(models.catalog.profiles);
        if (overview.kind === "overview") setProjects(overview.projects);
      })
      .catch((e) => {
        if (alive.current) setError(String(e));
      });
    return () => {
      alive.current = false;
    };
  }, []);
  const act = async (confirm: boolean) => {
    if (gate.current) return;
    gate.current = true;
    setBusy(true);
    setError("");
    try {
      const options = { archive_id: archive, project_id: project || null, profile_id: profile };
      if (confirm && preview && !preview.already_restored) {
        const result = await taskArchive<Receipt>({
          kind: "restore",
          ...options,
          fingerprint: preview.fingerprint,
        });
        if (alive.current) {
          setReceipt(result);
          setPreview(null);
        }
      } else {
        const result = await taskArchive<Preview>({ kind: "restore_preview", ...options });
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
  };
  const restored = receipt || (preview?.already_restored ? preview : null);
  return (
    <section aria-label={tr("从档案恢复任务", "Restore task from archive")}>
      <h3>{tr("从档案恢复任务", "Restore task from archive")}</h3>
      <p>
        {tr(
          "保留单任务的对话、计划、排队消息、历史结果和附件。未完成或效果不确定的原操作须逐项人工核对；选择多助手档案时会显示团队恢复入口。",
          "Preserves conversation, plans, queued messages, saved results and attachments for one task. Unfinished or uncertain source operations require individual review. Selecting a team archive opens team restoration.",
        )}
      </p>
      <p>
        {tr(
          "请先迁移需要的项目文件。恢复后使用‘请求审批’，命令执行关闭。原审批、登录和定时任务不会启用；你手动继续后才会连接模型。",
          "Transfer any required project files first. Restored tasks require approval, with command execution disabled. Old approvals, logins and schedules stay inactive; only manual continuation connects to the model.",
        )}
      </p>
      {!restored && (
        <fieldset disabled={busy}>
          <legend>{tr("选择本机的模型和项目", "Choose a local model and project")}</legend>
          <label>
            {tr("恢复使用的模型", "Model for restoration")}
            <select
              aria-label={tr("恢复使用的模型", "Model for restoration")}
              value={profile}
              onChange={(e) => {
                setProfile(e.target.value);
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
          <small>
            {tr(
              "已有模型历史须匹配原协议、模型名称和服务地址。密钥使用当前电脑上的配置。",
              "Existing model history requires the original protocol, model name and service address. Credentials come from this computer.",
            )}
          </small>
          <label>
            {tr("恢复到项目", "Restore into project")}
            <select
              aria-label={tr("恢复到项目", "Restore into project")}
              value={project}
              onChange={(e) => {
                setProject(e.target.value);
                setPreview(null);
              }}
            >
              <option value="">
                {tr("不绑定项目（原任务无项目时）", "No project (if the original had none)")}
              </option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.settings.name} · {p.settings.root_path}
                </option>
              ))}
            </select>
          </label>
          <button disabled={!profile} onClick={() => void act(false)}>
            {tr("预览任务恢复", "Preview task restoration")}
          </button>
          {preview && !preview.already_restored && (
            <div className="archive-summary">
              <strong>{preview.title}</strong>
              <p>
                {tr("用户消息：", "Messages: ")}
                {preview.messages} · {tr("排队消息：", "Queued: ")}
                {preview.queued} · {tr("历史结果：", "Saved results: ")}
                {preview.history_results}
              </p>
              <p>
                {preview.model} · {preview.protocol} · {preview.base_url}
              </p>
              <p>{preview.project?.settings.root_path || tr("未绑定项目", "No project")}</p>
              <p>
                {tr("恢复后的状态：", "Restored state: ")}
                {taskState(preview.state, tr("zh", "en") === "en")} · {tr("模式：", "Mode: ")}
                {
                  (
                    {
                      chat: tr("聊天", "Chat"),
                      plan: tr("规划", "Plan"),
                      execute: tr("执行", "Execute"),
                    } as Record<string, string>
                  )[preview.mode]
                }
              </p>
              {preview.project_rules && (
                <details>
                  <summary>
                    {tr("恢复后保留的任务和项目规则", "Preserved task and project rules")}
                  </summary>
                  <pre>{preview.project_rules}</pre>
                </details>
              )}
              <AttachmentSummary attachments={preview.attachments} />
              <RecoverySummary items={preview.recovery} />
              <FileHistorySummary
                rows={preview.file_history}
                included={preview.file_history_included}
              />
              <button onClick={() => void act(true)}>
                {tr("确认恢复为新任务", "Restore as a new task")}
              </button>
            </div>
          )}
        </fieldset>
      )}
      {busy && <p role="status">{tr("正在核对恢复内容…", "Checking restoration…")}</p>}
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
              "这份档案已恢复，没有启动任务。重复操作不会新建任务或重置权限。",
              "This archive has been restored without starting the task. Repeating this action creates no duplicate and does not reset permissions.",
            )}
          </p>
          <p>
            {restored.title} · {new Date(restored.restored_at_ms).toLocaleString()}
          </p>
          <button disabled={restored.deleted} onClick={() => onOpen(restored.task_id)}>
            {tr("打开恢复的任务", "Open restored task")}
          </button>
        </div>
      )}
    </section>
  );
}
