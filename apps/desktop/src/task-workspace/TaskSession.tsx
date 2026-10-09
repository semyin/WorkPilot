import type { ReactNode } from "react";
import type { ExecutionSnapshot, EventPage, WorkMode } from "../generated/contracts";
import { executionCommand as command } from "../executionClient";
import { MigrationRecovery } from "../task-archive/MigrationRecovery";
import { Conversation } from "../Conversation";
import { HistoryEvent } from "./HistoryEvent";
import { taskLabels } from "./taskLabels";
import { AssistantMessage } from "../workbench/MessageBody";
import { Disclosure } from "../workbench/Disclosure";
import { Icon } from "../workbench/Icon";
export type TaskSessionProps = {
  english: boolean;
  desktop: boolean;
  snapshot: ExecutionSnapshot;
  active: boolean;
  busy: boolean;
  archived: boolean;
  toolPanel: ReactNode;
  teamPanel: ReactNode;
  approvals?: ReactNode;
  collaborators?: ReactNode;
  onActivity?: () => void;
  setMediaOpen: (value: boolean) => void;
  setExtensionsOpen: (value: boolean) => void;
  setMessage: (value: string) => void;
  setMode: (value: WorkMode) => void;
  act: (work: () => Promise<void>) => Promise<void>;
  configure: (mode: WorkMode) => Promise<unknown> | null;
  start: (id: string) => Promise<unknown>;
  live: string;
  reasoning: string;
  reviewResults: Record<string, string>;
  setReviewResults: (value: Record<string, string>) => void;
  showHistory: boolean;
  history: EventPage | null;
  readHistory: (after?: number) => Promise<void>;
};
export function TaskSession({
  english,
  desktop,
  snapshot,
  active,
  busy,
  archived,
  toolPanel,
  teamPanel,
  approvals,
  collaborators,
  onActivity,
  setMediaOpen,
  setExtensionsOpen,
  setMessage,
  setMode,
  act,
  configure,
  start,
  live,
  reasoning,
  reviewResults,
  setReviewResults,
  showHistory,
  history,
  readHistory,
}: TaskSessionProps) {
  const tr = (zh: string, en: string) => (english ? en : zh);
  const { reasonLabel } = taskLabels(english);
  const needsReview = snapshot.steps.filter((step) => step.state === "needs_review");
  return (
    <>
      {archived && (
        <p className="wb-notice">
          {tr("任务已归档，恢复后可继续。", "This task is archived. Restore it to continue.")}
        </p>
      )}
      <MigrationRecovery key={`recovery-${snapshot.task.id}`} task={snapshot.task.id} />
      {!desktop && toolPanel}
      {!desktop && teamPanel}
      {snapshot.latest_run?.diagnostic && (
        <div className="error" role="alert">
          {english
            ? snapshot.latest_run.diagnostic.message_en
            : snapshot.latest_run.diagnostic.message_zh}
          <p>{snapshot.latest_run.diagnostic.detail}</p>
        </div>
      )}

      {snapshot.latest_run?.reason === "awaiting_media_approval" && (
        <button onClick={() => setMediaOpen(true)}>
          {tr("查看文件或图片待批准操作", "Review pending file or image generation")}
        </button>
      )}
      {snapshot.latest_run?.reason === "awaiting_extension_approval" && (
        <button onClick={() => setExtensionsOpen(true)}>
          {tr("查看扩展待批准操作", "Review pending extension action")}
        </button>
      )}
      {snapshot.context.question && (
        <section className="execution-question">
          <h3>{tr("需要你的输入", "Your input is needed")}</h3>
          <p>
            {snapshot.context.question.plan_confirmation
              ? tr(
                  "计划已保存。可补充要求，或明确开始执行。",
                  "The plan is saved. Revise your requirements or explicitly start execution.",
                )
              : snapshot.context.question.text}
          </p>
          <div className="model-actions">
            {snapshot.context.question.choices.map((choice) => (
              <button key={choice} onClick={() => setMessage(choice)}>
                {choice}
              </button>
            ))}
            {snapshot.context.question.plan_confirmation && (
              <button
                className="primary"
                disabled={busy || active}
                onClick={() =>
                  void act(async () => {
                    await configure("execute");
                    setMode("execute");
                    await start(snapshot.task.id);
                  })
                }
              >
                {tr("开始执行计划", "Execute this plan")}
              </button>
            )}
          </div>
        </section>
      )}
      {!!snapshot.context.plan.length && (
        <ol className="execution-plan">
          {snapshot.context.plan.map((s) => (
            <li key={s.id} data-plan-state={s.status}>
              <span>{s.status === "done" ? "✓" : s.status === "running" ? "◉" : "○"}</span> {s.text}
            </li>
          ))}
        </ol>
      )}
      {desktop && (
        <Conversation
          key={`conversation-${snapshot.task.id}`}
          task={snapshot.task.id}
          sequence={snapshot.task.last_sequence}
        />
      )}
      <div data-testid="execution-answer" hidden={!!desktop && !active}>
        <AssistantMessage
          english={english}
          text={
            live ||
            snapshot.context.last_text ||
            (active
              ? tr("等待模型回复…", "Waiting for model output…")
              : snapshot.task.state === "awaiting_input"
                ? tr(
                    "请补充所需信息或确认上方计划。",
                    "Provide the requested input or confirm the plan above.",
                  )
                : tr(
                    "本次没有完整的文字结果，可查看右侧执行过程。",
                    "No complete text result is available. See the execution trace.",
                  ))
          }
        />
      </div>
      {snapshot.steps.some((s) => s.kind !== "model") && (
        <Disclosure
          className="wb-step-summary"
          title={tr(
            `已完成 ${snapshot.steps.filter((s) => s.state === "completed").length} 个步骤`,
            `${snapshot.steps.filter((s) => s.state === "completed").length} steps completed`,
          )}
        >
          <div className="wb-step-list">
            {snapshot.steps
              .filter((s) => s.kind !== "model")
              .slice(-4)
              .map((s) => (
                <div key={s.id}>
                  <Icon name={s.state === "completed" ? "check" : "clock"} />
                  {s.name}
                </div>
              ))}
            <button className="wb-menu-row" onClick={onActivity}>
              {tr("查看完整执行过程", "View the complete activity")}
              <Icon name="right" />
            </button>
          </div>
        </Disclosure>
      )}
      {collaborators}
      {snapshot.task.state !== "awaiting_approval" && reasonLabel(snapshot.latest_run?.reason) && (
        <p className="wb-notice">{reasonLabel(snapshot.latest_run?.reason)}</p>
      )}
      {approvals}
      {reasoning && (
        <details>
          <summary>{tr("服务公开的推理", "Reasoning shared by the service")}</summary>
          <pre>{reasoning}</pre>
        </details>
      )}
      {snapshot.context.digest && (
        <p>
          {tr(
            "已整理较早的上下文，原始记录仍可查看；任务目标和用户要求保留。",
            "Earlier context was condensed. Original records, the goal and user requirements are preserved.",
          )}
        </p>
      )}
      {needsReview.map((s) => (
        <section className="execution-review" key={s.id}>
          <strong>
            {tr("结果需要核对：", "Review required: ")}
            {s.name}
          </strong>
          <p>
            {tr(
              "继续任务会先查询已保存的执行凭据。有凭据就采用原结果；没有凭据时，需要你核对是否执行过。",
              "Continue first checks the saved receipt. An existing result is reused; without a receipt, verify what actually happened.",
            )}
          </p>
          <button
            disabled={busy || active}
            onClick={() =>
              void act(async () => {
                await command(
                  {
                    kind: "resolve_execution_action",
                    task_id: snapshot.task.id,
                    action_id: s.id,
                    resolution: { kind: "not_applied" },
                  },
                  english,
                );
              })
            }
          >
            {tr("确认未执行，允许重新运行", "Confirm not applied; allow another attempt")}
          </button>
        </section>
      ))}

      {needsReview.map((s) => (
        <section key={"result-" + s.id} className="execution-review">
          <label>
            {tr("已执行的结果（确认后填写）", "Existing result (verify before recording)")}
            <textarea
              aria-label={tr(
                "已执行的结果（确认后填写）",
                "Existing result (verify before recording)",
              )}
              value={reviewResults[s.id] || ""}
              onChange={(e) => setReviewResults({ ...reviewResults, [s.id]: e.target.value })}
            />
          </label>
          <button
            disabled={busy || active || !reviewResults[s.id]?.trim()}
            onClick={() =>
              void act(async () => {
                await command(
                  {
                    kind: "resolve_execution_action",
                    task_id: snapshot.task.id,
                    action_id: s.id,
                    resolution: { kind: "applied", output: reviewResults[s.id] },
                  },
                  english,
                );
              })
            }
          >
            {tr("确认已执行，采用此结果", "Confirm applied; use this result")}
          </button>
        </section>
      ))}
      {showHistory && (
        <section className="execution-history">
          <h3>{tr("完整事件记录", "Complete event history")}</h3>
          {history?.events.map((e) => (
            <HistoryEvent key={e.sequence} event={e} />
          ))}
          <button disabled={busy} onClick={() => void readHistory()}>
            {tr("从头查看", "Read from start")}
          </button>
          {history?.has_more && (
            <button disabled={busy} onClick={() => void readHistory(history.next_after)}>
              {tr("下一页", "Next page")}
            </button>
          )}
        </section>
      )}
    </>
  );
}
