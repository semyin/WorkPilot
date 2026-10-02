import { useEffect, useState } from "react";
import type {
  AgentReport,
  Command,
  MemberSpec,
  ProfileCatalog,
  TeamMember,
  TeamView,
  TaskState,
  WorkMode,
} from "./generated/contracts";
import { executionCommand as command, readExecutionContent } from "./executionClient";
import { Saved } from "./SavedContent";

type Props = {
  task: string;
  view: TeamView;
  catalog: ProfileCatalog;
  english: boolean;
  open: (id: string) => void;
  status: (s: TaskState) => string;
  active: boolean;
  mode: WorkMode;
};
function MemberCard({ member: m, ...p }: Props & { member: TeamMember }) {
  const tr = (zh: string, en: string) => (p.english ? en : zh);
  const [report, setReport] = useState<AgentReport | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [role, setRole] = useState(m.role);
  const [goal, setGoal] = useState(m.goal);
  const [profile, setProfile] = useState(m.profile_id);
  const [reason, setReason] = useState("");
  useEffect(() => {
    let closed = false;
    setReport(null);
    if (expanded && m.report)
      void readExecutionContent(m.report)
        .then((text) => {
          if (!closed) setReport(JSON.parse(text));
        })
        .catch((e) => {
          if (!closed) setError(String(e));
        });
    return () => {
      closed = true;
    };
  }, [m.report?.object_id, expanded]);
  const act = async (c: Command) => {
    setBusy(true);
    setError("");
    try {
      await command(c, p.english);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const model = p.catalog.profiles.find((v) => v.profile.id === m.profile_id)?.profile;
  const title = (id: string) => p.view.members.find((v) => v.task_id === id)?.role || id;
  const owner = m.parent_task_id === p.task;
  return (
    <article className="team-member" data-member-id={m.task_id} data-member-state={m.state}>
      <div className="team-member-heading">
        <strong>{m.role}</strong>
        <span>
          {p.status(m.state)}
          {m.pending_start ? tr(" · 等待开始", " · Pending start") : ""}
        </span>
      </div>
      <p>{m.goal}</p>
      <small>
        {model ? `${model.label} · ${model.model}` : m.profile_id} · {tr("第", "Depth ")}
        {m.depth}
        {tr("层", "")}
      </small>
      {!!m.depends_on.length && (
        <p>
          {tr("等待这些成员交付：", "Dependencies: ")}
          {m.depends_on.map(title).join("、")}
        </p>
      )}
      {m.depth > 1 && (
        <p>
          {tr("由以下成员分派：", "Delegated by: ")}
          {title(m.parent_task_id)}
        </p>
      )}
      {m.replaces_id && (
        <p>
          {tr("接替：", "Replaces: ")}
          {title(m.replaces_id)} · {m.replacement_reason}
        </p>
      )}
      {m.superseded_by && (
        <p>
          {tr("后续由以下成员接手：", "Replaced by: ")}
          {title(m.superseded_by)}
        </p>
      )}
      {m.diagnostic && (
        <p className="error">{p.english ? m.diagnostic.message_en : m.diagnostic.message_zh}</p>
      )}
      {m.review !== "pending" && (
        <p>
          {m.review === "accepted"
            ? tr("成果已检查并接受", "Delivery inspected and accepted")
            : tr("已明确放弃此分支", "Branch explicitly abandoned")}{" "}
          · {m.review_reason}
        </p>
      )}
      <div className="model-actions">
        <button onClick={() => p.open(m.task_id)}>
          {tr("打开过程与审批", "Open trace and approvals")}
        </button>
        {m.report && (
          <button onClick={() => setExpanded(!expanded)}>
            {expanded ? tr("收起交付", "Hide delivery") : tr("查看交付", "Inspect delivery")}
          </button>
        )}
      </div>
      {expanded && report && (
        <div className="team-delivery">
          <pre>{report.summary || tr("本次没有完整文字结果。", "No complete text result.")}</pre>
          <p>
            {tr("输入 / 输出用量：", "Input / output tokens: ")}
            {report.usage.input_tokens ?? tr("未返回", "Unavailable")} /{" "}
            {report.usage.output_tokens ?? tr("未返回", "Unavailable")}
          </p>
          {report.summary_truncated && (
            <p>
              {tr(
                "摘要已截短，完整内容保留在运行记录中。",
                "Summary shortened; full content remains in the trace.",
              )}
            </p>
          )}
          {report.artifacts.map((a) => (
            <details key={a.revision_id}>
              <summary>
                {tr("成果：", "Artifact: ")}
                {a.path}
              </summary>
              <Saved reference={a.content} plain />
            </details>
          ))}
          <details>
            <summary>{tr("完整交付记录", "Complete delivery record")}</summary>
            <Saved reference={m.report!} />
          </details>
          {owner &&
            !m.superseded_by &&
            m.review === "pending" &&
            ["completed", "failed", "interrupted", "awaiting_input", "awaiting_approval"].includes(
              m.state,
            ) && (
              <>
                <label>
                  {tr("检查结论", "Inspection reason")}
                  <input value={reason} onChange={(e) => setReason(e.target.value)} />
                </label>
                <div className="model-actions">
                  <button
                    disabled={busy || !reason.trim() || m.state !== "completed"}
                    onClick={() =>
                      void act({
                        kind: "review_team_member",
                        task_id: p.task,
                        member_id: m.task_id,
                        report_id: m.report!.object_id,
                        accept: true,
                        reason,
                      })
                    }
                  >
                    {tr("接受成果", "Accept delivery")}
                  </button>
                  <button
                    disabled={busy || !reason.trim()}
                    onClick={() =>
                      void act({
                        kind: "review_team_member",
                        task_id: p.task,
                        member_id: m.task_id,
                        report_id: m.report!.object_id,
                        accept: false,
                        reason,
                      })
                    }
                  >
                    {tr("放弃此分支", "Abandon branch")}
                  </button>
                </div>
              </>
            )}
        </div>
      )}
      {owner &&
        !m.superseded_by &&
        (m.pending_start || ["failed", "interrupted"].includes(m.state)) && (
          <details>
            <summary>
              {m.pending_start
                ? tr("调整分工和模型", "Adjust assignment and model")
                : tr("建立接替助手", "Create replacement")}
            </summary>
            {m.pending_start && (
              <>
                <label>
                  {tr("职责名称", "Role")}
                  <input value={role} onChange={(e) => setRole(e.target.value)} />
                </label>
                <label>
                  {tr("具体目标", "Assignment")}
                  <textarea
                    aria-label={tr("具体目标", "Assignment")}
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                  />
                </label>
              </>
            )}
            <label>
              {tr("成员模型", "Member model")}
              <select
                aria-label={tr("成员模型", "Member model")}
                value={profile}
                onChange={(e) => setProfile(e.target.value)}
              >
                {p.catalog.profiles.map(({ profile: v }) => (
                  <option key={v.id} value={v.id}>
                    {v.label} · {v.model}
                  </option>
                ))}
              </select>
            </label>
            {!m.pending_start && (
              <label>
                {tr("接替原因", "Replacement reason")}
                <input value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
            )}
            <button
              disabled={busy || (m.pending_start ? !goal.trim() || !role.trim() : !reason.trim())}
              onClick={() =>
                void act(
                  m.pending_start
                    ? {
                        kind: "override_team_member",
                        task_id: p.task,
                        member_id: m.task_id,
                        spec: {
                          key: m.key,
                          role,
                          goal,
                          profile_id: profile,
                          depends_on: p.view.members
                            .filter((v) => m.depends_on.includes(v.task_id))
                            .map((v) => v.key),
                        },
                      }
                    : {
                        kind: "replace_team_member",
                        task_id: p.task,
                        member_id: m.task_id,
                        profile_id: profile,
                        reason,
                      },
                )
              }
            >
              {m.pending_start
                ? tr("保存分工", "Save assignment")
                : tr("创建新助手接手", "Create new attempt")}
            </button>
          </details>
        )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
export function TeamPanel(p: Props) {
  const tr = (zh: string, en: string) => (p.english ? en : zh);
  const [settings, setSettings] = useState(p.view.settings);
  const [scheduler, setScheduler] = useState(p.view.scheduler);
  const [spec, setSpec] = useState<MemberSpec>({
    key: "",
    role: "",
    goal: "",
    profile_id: null,
    depends_on: [],
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setSettings(p.view.settings);
  }, [p.view.settings.revision, p.task]);
  useEffect(() => {
    setScheduler(p.view.scheduler);
  }, [p.view.scheduler.revision]);
  const act = async (c: Command) => {
    setBusy(true);
    setError("");
    try {
      await command(c, p.english);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const isRoot = p.task === p.view.root_task_id;
  const members = isRoot
    ? p.view.members
    : p.view.members.filter((m) => m.parent_task_id === p.task);
  const peers = p.view.members.filter((m) => m.parent_task_id === p.task && !m.superseded_by);
  const live = p.active || p.view.members.some((m) => ["running", "stopping"].includes(m.state));
  return (
    <section className="team-panel" aria-label={tr("协作助手", "Team assistants")}>
      <div className="team-member-heading">
        <h3>
          {tr("协作助手", "Team assistants")} · {members.length}
        </h3>
        {!isRoot && (
          <button onClick={() => p.open(p.view.root_task_id)}>
            {tr("返回主任务", "Return to main task")}
          </button>
        )}
      </div>
      <p>
        {!p.view.settings.enabled
          ? tr(
              "协作已关闭，可在团队设置中开启。",
              "Delegation is disabled. Enable it in team settings.",
            )
          : !members.length
            ? tr(
                "需要时由主助手分工，也可以先手动添加成员。",
                "The lead can delegate when useful, or you can add members first.",
              )
            : members.every(
                  (m) => m.superseded_by || m.review === "accepted" || m.review === "abandoned",
                )
              ? tr(
                  "所有分工已处理，可查看各成员的交付和记录。",
                  "All assignments are resolved. Inspect member deliveries and traces below.",
                )
              : p.view.scheduling_enabled
                ? tr(
                    "按依赖推进；成员独立执行，主助手检查交付后汇总。",
                    "Dependencies determine dispatch. Members run independently; the lead reviews deliveries.",
                  )
                : tr(
                    "团队已暂停。继续主任务后才会启动尚未完成的成员。",
                    "Team paused. Continue the main task to resume unfinished members.",
                  )}
      </p>
      {isRoot && (
        <details>
          <summary>{tr("团队设置与同时运行数量", "Team settings and concurrency")}</summary>
          <label className="check-label">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
            />
            {tr("允许助手按需分工", "Allow delegation when useful")}
          </label>
          {(
            [
              [
                "max_parallel",
                tr("本任务同时运行上限（含主助手）", "Concurrent members, including lead"),
                1,
                8,
              ],
              [
                "max_members",
                tr("累计成员上限（含接替）", "Total members, including replacements"),
                1,
                32,
              ],
              ["max_depth", tr("最多分派层数", "Maximum delegation depth"), 1, 3],
              ["max_replacements", tr("每项分工最多接替次数", "Replacements per assignment"), 0, 5],
            ] as const
          ).map(([key, label, min, max]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                min={min}
                max={max}
                value={settings[key]}
                onChange={(e) => setSettings({ ...settings, [key]: Number(e.target.value) })}
              />
            </label>
          ))}
          <button
            disabled={busy || live}
            onClick={() => void act({ kind: "configure_team", task_id: p.task, settings })}
          >
            {tr("保存团队设置", "Save team settings")}
          </button>
          <label>
            {tr("所有任务同时运行总上限", "Global concurrent runs")}
            <input
              type="number"
              min={1}
              max={16}
              value={scheduler.max_running}
              onChange={(e) => setScheduler({ ...scheduler, max_running: Number(e.target.value) })}
            />
          </label>
          <button
            disabled={busy || live}
            onClick={() => void act({ kind: "configure_scheduler", settings: scheduler })}
          >
            {tr("保存全局数量", "Save global limit")}
          </button>
        </details>
      )}
      <details>
        <summary>{tr("手动添加分工", "Add an assignment")}</summary>
        <label>
          {tr("成员标识（简短且不重复）", "Unique short member key")}
          <input value={spec.key} onChange={(e) => setSpec({ ...spec, key: e.target.value })} />
        </label>
        <label>
          {tr("职责名称", "Role")}
          <input value={spec.role} onChange={(e) => setSpec({ ...spec, role: e.target.value })} />
        </label>
        <label>
          {tr("具体目标", "Assignment")}
          <textarea
            aria-label={tr("具体目标", "Assignment")}
            value={spec.goal}
            onChange={(e) => setSpec({ ...spec, goal: e.target.value })}
          />
        </label>
        <label>
          {tr("成员模型", "Member model")}
          <select
            aria-label={tr("成员模型", "Member model")}
            value={spec.profile_id || ""}
            onChange={(e) => setSpec({ ...spec, profile_id: e.target.value || null })}
          >
            <option value="">{tr("继承主助手模型", "Inherit lead model")}</option>
            {p.catalog.profiles.map(({ profile: v }) => (
              <option key={v.id} value={v.id}>
                {v.label} · {v.model}
              </option>
            ))}
          </select>
        </label>
        {!!peers.length && (
          <fieldset>
            <legend>{tr("等这些成员交付后开始", "Start after these members deliver")}</legend>
            {peers.map((m) => (
              <label className="check-label" key={m.task_id}>
                <input
                  type="checkbox"
                  checked={spec.depends_on.includes(m.key)}
                  onChange={(e) =>
                    setSpec({
                      ...spec,
                      depends_on: e.target.checked
                        ? [...spec.depends_on, m.key]
                        : spec.depends_on.filter((k) => k !== m.key),
                    })
                  }
                />
                {m.role}
              </label>
            ))}
          </fieldset>
        )}
        <button
          disabled={
            busy ||
            !spec.key.trim() ||
            !spec.role.trim() ||
            !spec.goal.trim() ||
            !p.view.settings.enabled ||
            p.mode !== "execute"
          }
          onClick={() => void act({ kind: "add_team_members", task_id: p.task, members: [spec] })}
        >
          {tr("添加成员", "Add member")}
        </button>
      </details>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {members.map((m) => (
        <MemberCard key={m.task_id} {...p} member={m} />
      ))}
    </section>
  );
}
