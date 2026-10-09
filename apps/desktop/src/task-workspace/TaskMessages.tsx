import { ComposerInput } from "../workbench/ComposerInput";
import type { ExecutionSnapshot, MediaAsset } from "../generated/contracts";
import { FileAttachments } from "../FileAttachments";
import { QueueEdit } from "../Conversation";
import { Saved } from "../SavedContent";
import { executionCommand as command } from "../executionClient";
import type { ReactNode } from "react";
import { Icon } from "../workbench/Icon";
export function TaskMessages({
  english,
  selected,
  snapshot,
  message,
  setMessage,
  messageAttachments,
  setMessageAttachments,
  setAttachmentBusy,
  busy,
  attachmentBusy,
  archived,
  active,
  sendMessage,
  act,
  controls,
  stopping,
  onStop,
  onContinue,
  canStop,
  canContinue,
  project,
}: {
  english: boolean;
  desktop: boolean;
  selected: string | null;
  snapshot: ExecutionSnapshot;
  message: string;
  setMessage: (value: string) => void;
  messageAttachments: MediaAsset[];
  setMessageAttachments: (value: MediaAsset[]) => void;
  setAttachmentBusy: (value: boolean) => void;
  busy: boolean;
  attachmentBusy: boolean;
  archived: boolean;
  active: boolean;
  sendMessage: () => Promise<void>;
  act: (work: () => Promise<void>) => Promise<void>;
  controls: (action: ReactNode, attachment?: ReactNode) => ReactNode;
  stopping: boolean;
  canStop: boolean;
  canContinue: boolean;
  project: string;
  onStop: () => void;
  onContinue: () => void;
}) {
  const tr = (zh: string, en: string) => (english ? en : zh);
  return (
    <>
      {snapshot.messages.some((m) => m.state !== "delivered") && (
        <section className="wb-queue-list execution-messages">
          {snapshot.messages
            .filter((m) => m.state !== "delivered")
            .map((m) => (
              <article
                className="wb-queue-item"
                key={m.id}
                data-message-id={m.id}
                data-message-state={m.state}
              >
                <small>
                  {m.state === "steer_requested"
                    ? tr("等待在安全边界引导", "Steering at the next safe boundary")
                    : m.state === "cancelled"
                      ? tr("已取消", "Cancelled")
                      : tr("尚未处理", "Not yet processed")}
                </small>
                <Saved reference={m.content} plain />
                <button
                  disabled={busy || m.state !== "queued"}
                  onClick={() =>
                    void act(async () => {
                      await command(
                        { kind: "steer", task_id: snapshot.task.id, message_id: m.id },
                        english,
                      );
                    })
                  }
                >
                  {tr("引导", "Guide")}
                </button>
                <QueueEdit compact task={snapshot.task.id} message={m} />
              </article>
            ))}
        </section>
      )}
      <FileAttachments
        compact
        key={selected}
        assets={messageAttachments}
        onChange={setMessageAttachments}
        onBusy={setAttachmentBusy}
      >
        {(attachment) => (
          <>
            <ComposerInput
              disabled={busy || archived}
              rows={2}
              aria-label={tr("发送新的要求", "Send a new instruction")}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={tr("补充要求，或把文件拖到这里…", "Add instructions or attach a file…")}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing &&
                  message.trim() &&
                  !busy &&
                  !attachmentBusy &&
                  !archived
                ) {
                  e.preventDefault();
                  void sendMessage();
                }
              }}
            />

            {controls(
              message.trim() ? (
                <>
                  {canStop && (
                    <button
                      type="button"
                      className="wb-icon-button"
                      aria-label={tr("停止任务", "Stop task")}
                      title={tr("停止任务，保留输入草稿", "Stop task and keep the draft")}
                      disabled={busy || stopping}
                      onClick={onStop}
                    >
                      <Icon name="stop" />
                    </button>
                  )}
                  <button
                    type="button"
                    className="wb-send-button"
                    aria-label={
                      active
                        ? tr("加入队列", "Queue message")
                        : ["completed", "awaiting_input"].includes(snapshot.task.state)
                          ? tr("发送并继续", "Send and continue")
                          : tr("保存消息", "Save message")
                    }
                    disabled={busy || attachmentBusy || archived}
                    onClick={() => void sendMessage()}
                  >
                    <Icon name="arrow" />
                  </button>
                </>
              ) : canStop ? (
                <button
                  type="button"
                  className="wb-send-button"
                  aria-label={tr("停止任务", "Stop task")}
                  disabled={busy || stopping}
                  onClick={onStop}
                >
                  <Icon name="stop" />
                </button>
              ) : (
                <button
                  type="button"
                  className="wb-send-button"
                  aria-label={
                    canContinue
                      ? tr("继续任务", "Continue task")
                      : tr("发送要求", "Send instruction")
                  }
                  disabled={busy || !canContinue || archived}
                  onClick={onContinue}
                >
                  <Icon name={canContinue ? "play" : "arrow"} />
                </button>
              ),
              attachment,
            )}
          </>
        )}
      </FileAttachments>
      <div className="wb-composer-hint">
        <span>
          {tr(
            active ? "运行时发送的要求会排队，可选择立即引导" : `当前项目：${project}`,
            active
              ? "Messages queue while running; guide to steer immediately"
              : `Current project: ${project}`,
          )}
        </span>
        <span>
          Enter {tr("发送", "Send")} · Shift Enter {tr("换行", "New line")}
        </span>
      </div>
    </>
  );
}
