import { ApprovalCard } from "./workbench/ApprovalCard";
import { useEffect, useRef, useState } from "react";
import { Select } from "./workbench/Menu";
import type {
  DefaultToolSettings,
  PermissionMode,
  ProfileCatalog,
  ToolApproval,
  ToolSettings,
  ToolTaskState,
} from "./generated/contracts";
import { executionCommand as command } from "./executionClient";
import { Saved } from "./SavedContent";
export const initialTools: ToolSettings = {
  root_path: null,
  permission: null,
  commands_enabled: false,
  review_profile_id: null,
  revision: 0,
};
const permissionNames = {
  request_approval: ["请求审批", "Request approval"],
  auto_review: ["帮我批准", "Review for me"],
  full_access: ["完全访问", "Full access"],
};
function permissionOptions(english: boolean, inherit = false) {
  return [
    ...(inherit
      ? [{ value: "", label: english ? "Inherit project / global default" : "继承项目 / 全局设置" }]
      : []),
    ...Object.entries(permissionNames).map(([value, names]) => ({
      value,
      label: names[english ? 1 : 0],
    })),
  ];
}
export function ToolFields({
  value,
  onChange,
  english,
  catalog,
}: {
  value: ToolSettings;
  onChange: (v: ToolSettings) => void;
  english: boolean;
  catalog: ProfileCatalog;
}) {
  const tr = (zh: string, en: string) => (english ? en : zh);
  return (
    <div className="tool-fields">
      <label>
        {tr("允许操作的文件夹（完整路径，可留空）", "Authorized folder (absolute path, optional)")}
        <input
          aria-label={tr("允许操作的文件夹", "Authorized folder")}
          value={value.root_path || ""}
          onChange={(e) => onChange({ ...value, root_path: e.target.value || null })}
        />
      </label>
      <label>
        {tr("任务权限", "Task permission")}
        <Select
          label={tr("任务权限", "Task permission")}
          value={value.permission || ""}
          options={permissionOptions(english, true)}
          onChange={(permission) =>
            onChange({ ...value, permission: (permission || null) as PermissionMode | null })
          }
        />
      </label>
      <label>
        {tr("独立审批所用模型", "Independent review model")}
        <Select
          label={tr("独立审批所用模型", "Independent review model")}
          value={value.review_profile_id || ""}
          options={[
            {
              value: "",
              label: tr(
                "继承全局设置；未设置时使用任务模型独立审查",
                "Inherit default; otherwise review separately with task model",
              ),
            },
            ...catalog.profiles.map(({ profile: p }) => ({ value: p.id, label: p.label })),
          ]}
          onChange={(id) => onChange({ ...value, review_profile_id: id || null })}
        />
      </label>
      <label className="check-label">
        <input
          type="checkbox"
          checked={value.commands_enabled}
          onChange={(e) => onChange({ ...value, commands_enabled: e.target.checked })}
        />
        {tr("允许提出命令执行请求", "Enable command requests")}
      </label>
      <p>
        {tr(
          "填写文件夹即授权读取其中的普通文本文件。修改文件按所选权限审批。聊天和规划模式只读。",
          "Selecting a folder authorizes text reads. Writes follow the selected permission. Chat and Plan are read-only.",
        )}
      </p>
      {value.commands_enabled && (
        <p>
          {tr(
            value.permission === "full_access"
              ? "完全访问下，命令可使用你当前系统账户的权限；仍可停止并查看记录。"
              : "命令按当前有效权限执行。若继承了完全访问，可使用你的系统账户权限；其余两档在 Windows 使用系统隔离、禁止网络，并始终需要人工确认。隔离后仍可读到系统允许的公共资源。",
            value.permission === "full_access"
              ? "Full-access commands use your OS account permissions; cancellation and logs remain available."
              : "Commands follow the effective permission: inherited Full access uses your OS account. Other modes always need a human and use a Windows AppContainer without network capabilities. OS-permitted public resources can still be readable.",
          )}
        </p>
      )}
    </div>
  );
}
export function ToolPanel({
  task,
  english,
  catalog,
  active,
  start,
  inherited = false,
  approvalsOnly = false,
  hideApprovals = false,
}: {
  task: string;
  english: boolean;
  catalog: ProfileCatalog;
  active: boolean;
  start: () => Promise<unknown>;
  inherited?: boolean;
  approvalsOnly?: boolean;
  hideApprovals?: boolean;
}) {
  const tr = (zh: string, en: string) => (english ? en : zh);
  const [state, setState] = useState<ToolTaskState | null>(null);
  const [settings, setSettings] = useState(initialTools);
  const [defaults, setDefaults] = useState<DefaultToolSettings>({
    permission: "request_approval",
    review_profile_id: null,
    revision: 0,
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const seen = useRef("");
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    seen.current = "";
    setState(null);
    const poll = async () => {
      try {
        const r = await command(
          { kind: "read", query: { kind: "task_tools", task_id: task } },
          english,
        );
        if (disposed) return;
        if (r.kind === "task_tools") {
          setState(r.state);
          if (seen.current !== r.state.policy.epoch) {
            seen.current = r.state.policy.epoch;
            setSettings(r.state.policy.settings);
            setDefaults(r.state.policy.defaults);
          }
        }
      } catch (e) {
        if (!disposed) setError(String(e));
      }
      if (!disposed) timer = setTimeout(poll, 400);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [task, english]);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const decide = (a: ToolApproval, approve: boolean) =>
    act(async () => {
      await command(
        {
          kind: "decide_tool_approval",
          task_id: task,
          approval_id: a.id,
          fingerprint: a.fingerprint,
          approve,
        },
        english,
      );
      await start();
    });
  if (!state) return null;
  const pending = state.approvals.filter((a) => a.state === "pending" && !a.consumed);
  if (approvalsOnly)
    return (
      <>
        {pending.map((a) => (
          <ApprovalCard
            key={a.id}
            approval={a}
            disabled={busy || active}
            onDecide={(approve) => void decide(a, approve)}
          />
        ))}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </>
    );
  return (
    <section className="tool-panel">
      <p data-testid="effective-permission">
        {tr("当前有效权限：", "Effective permission: ")}
        {permissionNames[state.policy.effective_permission][english ? 1 : 0]} ·{" "}
        {state.policy.settings.root_path || tr("未授权文件夹", "No folder authorized")}
      </p>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      <details>
        <summary>{tr("工具与权限设置", "Tool and permission settings")}</summary>
        {inherited ? (
          <p>
            {tr(
              "成员继承主任务的文件夹与权限上限。需要调整时，请返回主任务。",
              "This member inherits its parent's folder and permission ceiling. Edit the main task to change them.",
            )}
          </p>
        ) : (
          <>
            <ToolFields
              value={settings}
              onChange={setSettings}
              english={english}
              catalog={catalog}
            />
            <p>
              {tr(
                "保存任务设置会停止当前运行并使旧审批失效；之后可手动继续。",
                "Saving stops this task and expires previous approvals. Continue manually afterwards.",
              )}
            </p>
            <button
              disabled={busy}
              onClick={() =>
                void act(() =>
                  command({ kind: "configure_task_tools", task_id: task, settings }, english),
                )
              }
            >
              {tr("保存任务权限", "Save task permissions")}
            </button>
          </>
        )}
        <details>
          <summary>{tr("全局默认权限", "Global permission defaults")}</summary>
          <Select
            label={tr("全局默认权限", "Global permission defaults")}
            value={defaults.permission}
            options={permissionOptions(english)}
            onChange={(permission) =>
              setDefaults({ ...defaults, permission: permission as PermissionMode })
            }
          />
          <Select
            label={tr("全局审批模型", "Global review model")}
            value={defaults.review_profile_id || ""}
            options={[
              { value: "", label: tr("各任务模型独立审查", "Each task model, separate review") },
              ...catalog.profiles.map(({ profile: p }) => ({ value: p.id, label: p.label })),
            ]}
            onChange={(id) => setDefaults({ ...defaults, review_profile_id: id || null })}
          />
          <p>
            {tr(
              "保存全局设置会停止所有运行中的任务，使旧审批失效。",
              "Saving global defaults stops running tasks and expires previous approvals.",
            )}
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void act(() =>
                command({ kind: "configure_tool_defaults", settings: defaults }, english),
              )
            }
          >
            {tr("保存全局权限", "Save global permissions")}
          </button>
        </details>
      </details>
      {!hideApprovals &&
        pending.map((a) => (
          <article className="approval-card" key={a.id} data-approval-id={a.id}>
            <h3>
              {tr("等待你确认：", "Approval required: ")}
              {a.intent.tool === "write_file"
                ? tr(
                    a.intent.version.exists ? "替换文件内容" : "新建文件",
                    a.intent.version.exists ? "Replace file contents" : "Create file",
                  )
                : a.intent.tool === "run_command"
                  ? tr("运行命令", "Run a command")
                  : a.intent.tool}
            </h3>
            <p>
              {tr("目标：", "Target: ")}
              {a.intent.target}
            </p>
            <p>
              {tr("执行范围：", "Execution scope: ")}
              {a.intent.risk === "process"
                ? tr(
                    "系统隔离：可修改已选文件夹，无法访问网络；系统允许的公共资源仍可能可读。",
                    "AppContainer: selected folder access, no network capability; OS-permitted public resources may be readable.",
                  )
                : tr("仅限本任务已授权的文件夹", "Only this task's authorized folder")}
            </p>
            {a.intent.tool === "write_file" ? (
              <>
                <p>{tr("准备写入的完整内容：", "Complete proposed contents:")}</p>
                <pre>{String((a.intent.arguments as { text?: unknown }).text ?? "")}</pre>
              </>
            ) : (
              <pre>{JSON.stringify(a.intent.arguments, null, 2)}</pre>
            )}
            {a.review && (
              <p>
                {tr("独立审批意见：", "Independent review: ")}
                {a.review.reason || a.review.state}
              </p>
            )}
            {a.review?.diagnostic && (
              <p>{english ? a.review.diagnostic.message_en : a.review.diagnostic.message_zh}</p>
            )}
            <small>
              {tr(
                "只批准此版本的操作。文件或权限改变后，需要重新确认。",
                "Approval covers this exact action and version. File or policy changes invalidate it.",
              )}
            </small>
            <div className="model-actions">
              <button disabled={busy || active} onClick={() => void decide(a, true)}>
                {tr("批准并继续", "Approve and continue")}
              </button>
              <button disabled={busy || active} onClick={() => void decide(a, false)}>
                {tr("拒绝此操作", "Reject action")}
              </button>
            </div>
            <details>
              <summary>{tr("完整审批依据", "Full approval details")}</summary>
              <pre>{JSON.stringify(a, null, 2)}</pre>
              {a.review?.input && <Saved reference={a.review.input} />}
              {a.review?.output && <Saved reference={a.review.output} />}
            </details>
          </article>
        ))}
      {state.changes.length > 0 && (
        <details>
          <summary>
            {tr("文件修改前后", "File versions before and after")} ({state.changes.length})
          </summary>
          {state.changes.map((change) => (
            <details key={change.action_id}>
              <summary>{change.path}</summary>
              <p>{tr("修改前", "Before")}</p>
              {change.before_content ? (
                <Saved reference={change.before_content} plain />
              ) : (
                <p>{tr("原文件不存在", "New file")}</p>
              )}
              <p>{tr("修改后", "After")}</p>
              <Saved reference={change.after_content} plain />
            </details>
          ))}
        </details>
      )}
      <details>
        <summary>{tr("最近的审批记录", "Recent approval records")}</summary>
        {state.approvals.map((a) => (
          <details key={a.id}>
            <summary>
              {a.intent.tool} · {a.state} · {a.decided_by}
            </summary>
            <pre>{JSON.stringify(a, null, 2)}</pre>
            {a.review?.input && <Saved reference={a.review.input} />}
            {a.review?.output && <Saved reference={a.review.output} />}
          </details>
        ))}
      </details>
    </section>
  );
}
