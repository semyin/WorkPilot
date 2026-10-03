import { useEffect, useRef, useState } from "react";
import type {
  ScheduleAction,
  ScheduleData,
  SchedulePlan,
  ScheduleSpec,
  ScheduleRule,
  ScheduleOccurrence,
  WorkspaceProject,
  ProfileCatalog,
} from "./generated/contracts";
import { executionCommand } from "./executionClient";
import { useWords, taskState } from "./workspaceClient";
import { Saved } from "./SavedContent";
import "./schedule.css";

async function schedules(action: ScheduleAction): Promise<ScheduleData> {
  const r = await executionCommand({ kind: "schedules", action });
  if (r.kind !== "schedules") throw new Error("Unexpected schedule response");
  return r.data;
}
function local(ms: number, tz: string) {
  // A timezone can be incomplete while the user is typing it.
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz }).format(ms);
  } catch {
    return "";
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (s: string) => parts.find((v) => v.type === s)?.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}
const timezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  } catch {
    return "Asia/Shanghai";
  }
};
type Editor = { id: string | null; revision: number; spec: ScheduleSpec };
export function SchedulePanel({
  projects,
  catalog,
  initialProject,
  onClose,
  onNavigate,
}: {
  projects: WorkspaceProject[];
  catalog: ProfileCatalog;
  initialProject: string | null;
  onClose: () => void;
  onNavigate: (task: string) => void;
}) {
  const tr = useWords(),
    english = tr("zh", "en") === "en";
  const [items, setItems] = useState<SchedulePlan[]>([]),
    [total, setTotal] = useState(0),
    [offset, setOffset] = useState(0),
    [deleted, setDeleted] = useState(false),
    [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<Editor | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [history, setHistory] = useState<ScheduleOccurrence[]>([]),
    [historyMore, setHistoryMore] = useState(false);
  const [zones, setZones] = useState<string[]>([]),
    [preview, setPreview] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const alive = useRef(true),
    working = useRef(false),
    gen = useRef(0),
    panel = useRef<HTMLElement>(null),
    expandedHistory = useRef(false),
    selectedRef = useRef(selected);
  selectedRef.current = selected;
  const format = (ms: number | null, zone?: string) => {
    if (ms === null) return tr("没有待执行时间", "No future trigger");
    try {
      return (
        new Intl.DateTimeFormat(english ? "en-US" : "zh-CN", {
          timeZone: zone,
          dateStyle: "medium",
          timeStyle: "medium",
        }).format(ms) + (zone ? ` · ${zone}` : "")
      );
    } catch {
      return String(ms);
    }
  };
  const refresh = async () => {
    const g = ++gen.current;
    const r = await schedules({ kind: "list", include_deleted: deleted, offset, limit: 12 });
    if (!alive.current || g !== gen.current || r.kind !== "list") return;
    setItems(r.items);
    setTotal(r.total);
    setLoading(false);
    if (offset > 0 && offset >= r.total)
      setOffset(Math.max(0, Math.floor((r.total - 1) / 12) * 12));
    const id = selectedRef.current;
    if (id && !expandedHistory.current) {
      const h = await schedules({ kind: "history", schedule_id: id, before: null, limit: 16 });
      if (
        alive.current &&
        !expandedHistory.current &&
        id === selectedRef.current &&
        h.kind === "history"
      ) {
        setHistory(h.items);
        setHistoryMore(h.has_more);
      }
    }
  };
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    void schedules({ kind: "timezones" })
      .then((r) => {
        if (alive.current && r.kind === "timezones") setZones(r.zones);
      })
      .catch((e) => {
        if (alive.current) setError(String(e));
      });
    return () => {
      alive.current = false;
      gen.current++;
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    let stopped = false,
      polling = false;
    setLoading(true);
    const tick = async () => {
      if (polling || working.current) return;
      polling = true;
      try {
        await refresh();
      } catch (e) {
        if (!stopped) {
          setError(String(e));
          setLoading(false);
        }
      } finally {
        polling = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 2000);
    return () => {
      stopped = true;
      gen.current++;
      clearInterval(timer);
    };
  }, [offset, deleted]);
  const act = async (fn: () => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      if (alive.current) await refresh();
    } catch (e) {
      if (alive.current) {
        setError(String(e));
        // Keep the editor's unsaved text, but update the list revision after a conflict.
        // The user's next explicit action must use the current plan, not the stale card.
        await refresh().catch(() => {});
      }
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const create = () => {
    const zone = timezone();
    expandedHistory.current = false;
    setSelected(null);
    setPreview("");
    setEditor({
      id: null,
      revision: 0,
      spec: {
        title: "",
        goal: "",
        project_id: initialProject,
        profile_id: catalog.global_default || catalog.profiles[0]?.profile.id || "",
        mode: "execute",
        permission: "request_approval",
        review_profile_id: null,
        commands_enabled: false,
        timezone: zone,
        rule: { kind: "once", local: local(Date.now() + 300000, zone) },
        enabled: true,
      },
    });
  };
  const patch = (value: Partial<ScheduleSpec>) => {
    if (editor) {
      setEditor({ ...editor, spec: { ...editor.spec, ...value } });
      setPreview("");
    }
  };
  const setRule = (rule: ScheduleRule) => patch({ rule });
  const describe = (r: ScheduleRule) =>
    r.kind === "once"
      ? tr("只执行一次", "Once")
      : r.kind === "interval"
        ? tr(`每 ${r.minutes} 分钟`, `Every ${r.minutes} minutes`)
        : r.kind === "daily"
          ? tr(
              `每天 ${String(r.hour).padStart(2, "0")}:${String(r.minute).padStart(2, "0")}`,
              `Daily ${String(r.hour).padStart(2, "0")}:${String(r.minute).padStart(2, "0")}`,
            )
          : tr(
              `每周 ${r.weekdays.map((d) => "一二三四五六日"[d - 1]).join("、")} ${String(r.hour).padStart(2, "0")}:${String(r.minute).padStart(2, "0")}`,
              `Weekly ${r.weekdays.map((d) => ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][d - 1]).join(", ")} ${String(r.hour).padStart(2, "0")}:${String(r.minute).padStart(2, "0")}`,
            );
  const reason = (s: string | null) =>
    ({
      application_was_closed: tr(
        "应用未运行，已记录错过，不会补跑。",
        "Application was closed. Missed times will not be replayed.",
      ),
      clock_jump_or_resume: tr(
        "时钟跳变或运行暂停后恢复，错过的时间不补跑。",
        "Clock jump or resume detected. Missed times will not be replayed.",
      ),
      missed_deadline: tr(
        "已错过触发时间，不自动补跑。",
        "Trigger was missed. No automatic catch-up.",
      ),
      previous_occurrence_active: tr(
        "上次任务仍在运行或等待处理，本次跳过。",
        "Previous occurrence is active or waiting. This one was skipped.",
      ),
      interrupted_dispatch: tr(
        "启动过程被中断，未自动重启。",
        "Dispatch was interrupted and was not restarted.",
      ),
    })[s || ""] ||
    s ||
    "";
  const occurrenceState = (o: ScheduleOccurrence) =>
    ({
      claimed: tr("正在启动", "Starting"),
      dispatched: o.task_state
        ? taskState(o.task_state, english)
        : tr("原任务已删除", "Task removed"),
      failed: tr("未能启动", "Could not start"),
      missed: tr("已错过", "Missed"),
      overlap: tr("已跳过，避免重叠", "Skipped to avoid overlap"),
      interrupted: tr("启动中断", "Dispatch interrupted"),
    })[o.state] || o.state;
  const choose = async (p: SchedulePlan) => {
    expandedHistory.current = false;
    setEditor(null);
    setSelected(p.id);
    selectedRef.current = p.id;
    const r = await schedules({ kind: "history", schedule_id: p.id, before: null, limit: 16 });
    if (r.kind === "history") {
      setHistory(r.items);
      setHistoryMore(r.has_more);
    }
  };
  const profiles = (
    <>
      <option value="">{tr("请选择模型服务", "Choose a model service")}</option>
      {catalog.profiles.map((p) => (
        <option key={p.profile.id} value={p.profile.id}>
          {p.profile.label} · {p.profile.model}
        </option>
      ))}
    </>
  );
  return (
    <div className="schedule-backdrop">
      <section
        ref={panel}
        className="schedule-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedule-title"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) {
            e.stopPropagation();
            onClose();
          }
          if (e.key === "Tab") {
            const nodes = panel.current?.querySelectorAll<HTMLElement>(
              "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary",
            );
            if (!nodes?.length) return;
            const first = nodes[0],
              last = nodes[nodes.length - 1];
            if (
              e.shiftKey &&
              (document.activeElement === first || document.activeElement === panel.current)
            ) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <header>
          <div>
            <h2 id="schedule-title">{tr("定时任务", "Scheduled tasks")}</h2>
            <p>
              {tr(
                "关窗后在托盘继续。彻底退出后停止；错过不补跑。",
                "Runs while hidden in the tray. Quitting stops it. Missed times are not replayed.",
              )}
            </p>
          </div>
          <button disabled={busy} onClick={onClose}>
            {tr("关闭定时任务", "Close schedules")}
          </button>
        </header>
        <div className="schedule-toolbar">
          <button disabled={busy} onClick={create}>
            {tr("新建计划", "New schedule")}
          </button>
          <label className="schedule-check">
            <input
              type="checkbox"
              checked={deleted}
              disabled={busy}
              onChange={(e) => {
                setDeleted(e.target.checked);
                setOffset(0);
              }}
            />
            {tr("显示已删除计划", "Include deleted schedules")}
          </label>
          <small>{tr(`共 ${total} 个计划`, `${total} schedules`)}</small>
        </div>
        <div className="schedule-messages" aria-live="polite">
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
        </div>
        <div className="schedule-columns">
          <aside className="schedule-list" aria-label={tr("定时计划列表", "Schedule list")}>
            {loading ? (
              <p>{tr("正在读取…", "Loading…")}</p>
            ) : items.length === 0 ? (
              <p>
                {tr(
                  "还没有计划。可以先创建一个只执行一次的计划。",
                  "No schedules yet. Start with a one-time schedule.",
                )}
              </p>
            ) : (
              items.map((p) => (
                <article className="schedule-card" data-schedule-id={p.id} key={p.id}>
                  <button
                    className="schedule-title-button"
                    disabled={busy}
                    onClick={() => void act(() => choose(p))}
                  >
                    {p.spec.title}
                  </button>
                  <span className="schedule-badge">
                    {p.deleted
                      ? tr("已删除", "Deleted")
                      : !p.spec.enabled
                        ? tr("已停用", "Disabled")
                        : p.next_at_ms === null
                          ? tr("单次计划已结束", "No future trigger")
                          : tr("已启用", "Enabled")}
                  </span>
                  <small>{describe(p.spec.rule)}</small>
                  <small>{p.spec.timezone}</small>
                  <p>
                    {tr("下次：", "Next: ")}
                    {format(p.next_at_ms, p.spec.timezone)}
                  </p>
                  {!p.deleted && (
                    <div className="schedule-actions">
                      <button
                        disabled={busy}
                        onClick={() => {
                          expandedHistory.current = false;
                          setPreview("");
                          setSelected(null);
                          setEditor({
                            id: p.id,
                            revision: p.revision,
                            spec: structuredClone(p.spec),
                          });
                        }}
                      >
                        {tr("编辑计划", "Edit schedule")}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await schedules({
                              kind: "set_enabled",
                              schedule_id: p.id,
                              revision: p.revision,
                              enabled: !p.spec.enabled,
                            });
                            setNotice(
                              p.spec.enabled
                                ? tr(
                                    "已停用未来触发；已经开始的任务继续。",
                                    "Future triggers disabled; existing tasks continue.",
                                  )
                                : tr(
                                    "已启用，只安排未来触发。",
                                    "Enabled for future triggers only.",
                                  ),
                            );
                          })
                        }
                      >
                        {p.spec.enabled ? tr("停用", "Disable") : tr("启用", "Enable")}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            const r = await schedules({
                              kind: "run_now",
                              schedule_id: p.id,
                              revision: p.revision,
                            });
                            await choose(p);
                            if (r.kind === "run")
                              setNotice(
                                r.occurrence.state === "dispatched"
                                  ? tr(
                                      "已创建独立任务，可在执行历史中打开。",
                                      "A separate task was created. Open it from run history.",
                                    )
                                  : reason(r.occurrence.reason) ||
                                      tr(
                                        "未能启动，请查看历史。",
                                        "Could not start; inspect history.",
                                      ),
                              );
                          })
                        }
                      >
                        {tr("立即运行", "Run now")}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await schedules({
                              kind: "delete",
                              schedule_id: p.id,
                              revision: p.revision,
                            });
                            setEditor(null);
                            setNotice(
                              tr(
                                "计划已删除，执行历史保留；已开始的任务不会被取消。",
                                "Schedule deleted. History remains and started tasks are not cancelled.",
                              ),
                            );
                          })
                        }
                      >
                        {tr("删除计划", "Delete schedule")}
                      </button>
                    </div>
                  )}
                </article>
              ))
            )}
            <div className="schedule-actions">
              <button
                disabled={busy || offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 12))}
              >
                {tr("上一页", "Previous")}
              </button>
              <button
                disabled={busy || offset + 12 >= total}
                onClick={() => setOffset(offset + 12)}
              >
                {tr("下一页", "Next")}
              </button>
            </div>
          </aside>
          <div className="schedule-detail">
            {editor ? (
              <form
                className="schedule-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(async () => {
                    const r = await schedules({
                      kind: "save",
                      schedule_id: editor.id,
                      revision: editor.revision,
                      spec: editor.spec,
                    });
                    if (r.kind === "updated") {
                      setEditor(null);
                      setSelected(r.schedule_id);
                      selectedRef.current = r.schedule_id;
                      setNotice(
                        tr(
                          "计划已保存，模型或项目设置改变后需要重新保存。",
                          "Schedule saved. Save it again if model or project settings change.",
                        ),
                      );
                    }
                  });
                }}
              >
                <h3>
                  {editor.id ? tr("编辑计划", "Edit schedule") : tr("新建计划", "New schedule")}
                </h3>
                <label>
                  {tr("计划名称", "Schedule name")}
                  <input
                    aria-label={tr("计划名称", "Schedule name")}
                    required
                    maxLength={200}
                    disabled={busy}
                    value={editor.spec.title}
                    onChange={(e) => patch({ title: e.target.value })}
                  />
                </label>
                <label>
                  {tr("每次要做什么", "What should each run do?")}
                  <textarea
                    aria-label={tr("定时任务要求", "Scheduled task instructions")}
                    required
                    rows={4}
                    maxLength={16000}
                    disabled={busy}
                    value={editor.spec.goal}
                    onChange={(e) => patch({ goal: e.target.value })}
                  />
                </label>
                <div className="schedule-row">
                  <label>
                    {tr("项目", "Project")}
                    <select
                      aria-label={tr("计划所属项目", "Schedule project")}
                      disabled={busy}
                      value={editor.spec.project_id || ""}
                      onChange={(e) =>
                        patch({
                          project_id: e.target.value || null,
                          commands_enabled: e.target.value ? editor.spec.commands_enabled : false,
                        })
                      }
                    >
                      <option value="">{tr("不绑定项目", "No project")}</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.settings.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {tr("模型服务", "Model service")}
                    <select
                      aria-label={tr("计划模型服务", "Schedule model")}
                      required
                      disabled={busy}
                      value={editor.spec.profile_id}
                      onChange={(e) => patch({ profile_id: e.target.value })}
                    >
                      {profiles}
                    </select>
                  </label>
                </div>
                {!catalog.profiles.length && (
                  <p>
                    {tr(
                      "请先在工作台的“模型服务”中添加可用模型。",
                      "Add a model in Model services first.",
                    )}
                  </p>
                )}
                <div className="schedule-row">
                  <label>
                    {tr("工作模式", "Work mode")}
                    <select
                      aria-label={tr("计划工作模式", "Schedule work mode")}
                      disabled={busy}
                      value={editor.spec.mode}
                      onChange={(e) => patch({ mode: e.target.value as ScheduleSpec["mode"] })}
                    >
                      <option value="chat">{tr("聊天与只读查看", "Chat / read only")}</option>
                      <option value="plan">
                        {tr("先规划，等我确认执行", "Plan, then wait for me")}
                      </option>
                      <option value="execute">{tr("直接执行", "Execute")}</option>
                    </select>
                  </label>
                  <label>
                    {tr("权限", "Permissions")}
                    <select
                      aria-label={tr("计划权限", "Schedule permissions")}
                      disabled={busy}
                      value={editor.spec.permission}
                      onChange={(e) =>
                        patch({ permission: e.target.value as ScheduleSpec["permission"] })
                      }
                    >
                      <option value="request_approval">{tr("请求审批", "Request approval")}</option>
                      <option value="auto_review">{tr("帮我批准", "Review for me")}</option>
                      <option value="full_access">{tr("完全访问", "Full access")}</option>
                    </select>
                  </label>
                </div>
                {editor.spec.permission === "auto_review" && (
                  <label>
                    {tr("审批模型", "Approval model")}
                    <select
                      disabled={busy}
                      value={editor.spec.review_profile_id || editor.spec.profile_id}
                      onChange={(e) => patch({ review_profile_id: e.target.value || null })}
                    >
                      {profiles}
                    </select>
                  </label>
                )}
                <label className="schedule-check">
                  <input
                    type="checkbox"
                    disabled={busy || !editor.spec.project_id}
                    checked={editor.spec.commands_enabled}
                    onChange={(e) => patch({ commands_enabled: e.target.checked })}
                  />
                  {tr(
                    "允许在项目目录运行命令（仍按权限审批）",
                    "Allow commands in the project, subject to approval rules",
                  )}
                </label>
                <div className="schedule-row">
                  <label>
                    {tr("执行频率", "Frequency")}
                    <select
                      aria-label={tr("执行频率", "Schedule frequency")}
                      disabled={busy}
                      value={editor.spec.rule.kind}
                      onChange={(e) => {
                        const kind = e.target.value;
                        setRule(
                          kind === "once"
                            ? { kind, local: local(Date.now() + 300000, editor.spec.timezone) }
                            : kind === "interval"
                              ? { kind, minutes: 60 }
                              : kind === "daily"
                                ? { kind, hour: 9, minute: 0 }
                                : { kind: "weekly", weekdays: [1], hour: 9, minute: 0 },
                        );
                      }}
                    >
                      <option value="once">{tr("只执行一次", "Once")}</option>
                      <option value="interval">{tr("每隔一段时间", "At an interval")}</option>
                      <option value="daily">{tr("每天", "Daily")}</option>
                      <option value="weekly">{tr("每周指定日", "Weekly")}</option>
                    </select>
                  </label>
                  <label>
                    {tr("按哪个时区计算", "Timezone")}
                    <input
                      aria-label={tr("计划时区", "Schedule timezone")}
                      list="schedule-zones"
                      disabled={busy}
                      required
                      value={editor.spec.timezone}
                      onChange={(e) => patch({ timezone: e.target.value })}
                    />
                    <datalist id="schedule-zones">
                      {zones.map((z) => (
                        <option key={z} value={z} />
                      ))}
                    </datalist>
                  </label>
                </div>
                {editor.spec.rule.kind === "once" && (
                  <label>
                    {tr("执行日期和时间（所选时区）", "Date and time in the selected timezone")}
                    <input
                      aria-label={tr("执行日期和时间", "Schedule date and time")}
                      type="datetime-local"
                      step="1"
                      required
                      disabled={busy}
                      value={editor.spec.rule.local}
                      onChange={(e) => setRule({ kind: "once", local: e.target.value })}
                    />
                  </label>
                )}
                {editor.spec.rule.kind === "interval" && (
                  <label>
                    {tr(
                      "间隔分钟数（从保存或重新启用开始）",
                      "Minutes between runs, from save or re-enable",
                    )}
                    <input
                      aria-label={tr("间隔分钟数", "Interval minutes")}
                      type="number"
                      min="1"
                      max="10080"
                      required
                      disabled={busy}
                      value={editor.spec.rule.minutes}
                      onChange={(e) =>
                        setRule({ kind: "interval", minutes: Number(e.target.value) })
                      }
                    />
                  </label>
                )}
                {(editor.spec.rule.kind === "daily" || editor.spec.rule.kind === "weekly") && (
                  <label>
                    {tr("执行时间（所选时区）", "Time in the selected timezone")}
                    <input
                      aria-label={tr("每天执行时间", "Daily time")}
                      type="time"
                      required
                      disabled={busy}
                      value={`${String(editor.spec.rule.hour).padStart(2, "0")}:${String(editor.spec.rule.minute).padStart(2, "0")}`}
                      onChange={(e) => {
                        const [hour, minute] = e.target.value.split(":").map(Number);
                        setRule({ ...editor.spec.rule, hour, minute } as ScheduleRule);
                      }}
                    />
                  </label>
                )}
                {editor.spec.rule.kind === "weekly" && (
                  <div className="schedule-weekdays">
                    {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                      <label className="schedule-check" key={day}>
                        <input
                          type="checkbox"
                          disabled={busy}
                          checked={
                            editor.spec.rule.kind === "weekly" &&
                            editor.spec.rule.weekdays.includes(day)
                          }
                          onChange={(e) => {
                            if (editor.spec.rule.kind === "weekly")
                              setRule({
                                ...editor.spec.rule,
                                weekdays: e.target.checked
                                  ? [...editor.spec.rule.weekdays, day].sort()
                                  : editor.spec.rule.weekdays.filter((d) => d !== day),
                              });
                          }}
                        />
                        {tr(
                          "周" + "一二三四五六日"[day - 1],
                          ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][day - 1],
                        )}
                      </label>
                    ))}
                  </div>
                )}
                <label className="schedule-check">
                  <input
                    type="checkbox"
                    checked={editor.spec.enabled}
                    disabled={busy}
                    onChange={(e) => patch({ enabled: e.target.checked })}
                  />
                  {tr("保存后启用", "Enable after saving")}
                </label>
                <div className="schedule-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const r = await schedules({
                          kind: "preview",
                          rule: editor.spec.rule,
                          timezone: editor.spec.timezone,
                        });
                        if (r.kind === "preview")
                          setPreview(format(r.next_at_ms, editor.spec.timezone));
                      })
                    }
                  >
                    {tr("预览下次时间", "Preview next time")}
                  </button>
                  <span role="status">{preview}</span>
                </div>
                <p className="schedule-hint">
                  {tr(
                    "需要审批时会停下来等你。同一计划不重叠；错过只记录，不补跑。电脑时区改变不会修改这里的时区；夏令时不存在的时刻跳过，重复时刻只取第一次。",
                    "Approvals wait for you. Runs do not overlap and missed times are recorded only. Changing the computer timezone does not change this timezone. Daylight-saving gaps are skipped; repeated times use the first occurrence.",
                  )}
                </p>
                <div className="schedule-actions">
                  <button type="submit" disabled={busy || !editor.spec.profile_id}>
                    {tr("保存计划", "Save schedule")}
                  </button>
                  <button type="button" disabled={busy} onClick={() => setEditor(null)}>
                    {tr("取消编辑", "Cancel edit")}
                  </button>
                </div>
              </form>
            ) : selected ? (
              <section aria-label={tr("执行历史", "Run history")}>
                <h3>{tr("执行历史", "Run history")}</h3>
                <p className="schedule-hint">
                  {tr(
                    "每次运行是一个独立任务。打开任务可查看结果、处理审批或手动继续。",
                    "Each run is a separate task. Open it to read results, approve actions or continue manually.",
                  )}
                </p>
                {history.length === 0 ? (
                  <p>{tr("还没有触发记录。", "No trigger records yet.")}</p>
                ) : (
                  history.map((o) => (
                    <article
                      className="schedule-occurrence"
                      key={o.id}
                      data-occurrence-state={o.state}
                    >
                      <div className="schedule-actions">
                        <strong>{occurrenceState(o)}</strong>
                        <small>
                          {o.trigger === "timer"
                            ? tr("定时触发", "Timer")
                            : tr("手动运行", "Manual")}
                        </small>
                        {o.active && <small>{tr("仍在进行或等待处理", "Active or waiting")}</small>}
                      </div>
                      <p>{format(o.due_at_ms, timezone())}</p>
                      {o.reason && <p className="schedule-reason">{reason(o.reason)}</p>}
                      {o.missed_until_ms !== null && (
                        <p>
                          {tr("错过范围截至 ", "Missed range ends ")}
                          {format(o.missed_until_ms, timezone())}
                          {o.missed_count !== null
                            ? tr(`，共 ${o.missed_count} 次。`, `, ${o.missed_count} occurrences.`)
                            : tr("；这段时间不补跑。", "; no catch-up for this range.")}
                        </p>
                      )}
                      {o.task_id && (
                        <button
                          disabled={busy}
                          onClick={() => {
                            onNavigate(o.task_id!);
                            onClose();
                          }}
                        >
                          {tr("打开任务", "Open task")}
                        </button>
                      )}
                      <details>
                        <summary>
                          {tr("当时的计划设置", "Settings used for this occurrence")}
                        </summary>
                        <Saved reference={o.plan} />
                      </details>
                    </article>
                  ))
                )}
                {historyMore && (
                  <p className="schedule-hint">
                    {tr(
                      "当前显示最近 16 条；点击下面按钮暂时停止自动刷新并查看更早记录。",
                      "Showing the latest 16 entries. Load older entries to inspect history.",
                    )}
                  </p>
                )}
                {historyMore && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const r = await schedules({
                          kind: "history",
                          schedule_id: selected,
                          before: history.at(-1)?.sequence || null,
                          limit: 16,
                        });
                        if (r.kind === "history") {
                          expandedHistory.current = true;
                          setHistory((h) => [...h, ...r.items]);
                          setHistoryMore(r.has_more);
                        }
                      })
                    }
                  >
                    {tr("更早记录", "Earlier runs")}
                  </button>
                )}
              </section>
            ) : (
              <div className="schedule-empty">
                {tr(
                  "选择左侧计划查看执行历史，或新建计划。",
                  "Select a schedule to view its history, or create a new one.",
                )}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
