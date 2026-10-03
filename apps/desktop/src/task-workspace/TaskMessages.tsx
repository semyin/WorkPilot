import type { ExecutionSnapshot, MediaAsset } from "../generated/contracts";
import { FileAttachments } from "../FileAttachments";
import { QueueEdit } from "../Conversation";
import { Saved } from "../SavedContent";
import { executionCommand as command } from "../executionClient";
export function TaskMessages({
  english,
  desktop,
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
}) {
  const tr = (zh: string, en: string) => (english ? en : zh);
  return (
    <>
      {" "}
      <section className="execution-composer">
        <label>
          {tr("发送新的要求", "Send a new instruction")}
          <textarea
            rows={3}
            aria-label={tr("发送新的要求", "Send a new instruction")}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </label>
        {desktop && (
          <FileAttachments
            key={selected}
            assets={messageAttachments}
            onChange={setMessageAttachments}
            onBusy={setAttachmentBusy}
          />
        )}
        <button
          className="primary"
          disabled={busy || attachmentBusy || archived || !message.trim()}
          onClick={() => void sendMessage()}
        >
          {active
            ? tr("加入队列", "Queue message")
            : ["completed", "awaiting_input"].includes(snapshot.task.state)
              ? tr("发送并继续", "Send and continue")
              : tr("保存消息", "Save message")}
        </button>
        <small>
          {tr(
            "运行时默认排队；点击下方消息的“引导”可调整当前工作。中断或失败后，点击“继续任务”恢复。",
            "Messages queue while running. Use Guide to steer current work. Interrupted or failed tasks require Continue task.",
          )}
        </small>
      </section>
      <section className="execution-messages">
        {snapshot.messages
          .filter((m) => m.state !== "delivered")
          .map((m) => (
            <article key={m.id} data-message-id={m.id} data-message-state={m.state}>
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
              <QueueEdit task={snapshot.task.id} message={m} />
            </article>
          ))}
      </section>
    </>
  );
}
