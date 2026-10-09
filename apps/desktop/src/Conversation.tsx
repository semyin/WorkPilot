import { useEffect, useState } from "react";
import type { ConversationEntry, Message } from "./generated/contracts";
import { workspaceAction, workspaceQuery, useWords } from "./workspaceClient";
import { readExecutionContent } from "./executionClient";
import { Saved } from "./SavedContent";
import { AssistantMessage } from "./workbench/MessageBody";
import { Icon } from "./workbench/Icon";
export function Conversation({ task, sequence }: { task: string; sequence: number }) {
  const tr = useWords();
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const [before, setBefore] = useState<number | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    void workspaceQuery({ kind: "conversation", task_id: task, before, limit: 16 })
      .then((r) => {
        if (!disposed && r.kind === "conversation") {
          setEntries(r.entries);
          setNext(r.next_before);
          setError("");
        }
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
    };
  }, [task, sequence, before]);
  const groups: ConversationEntry[][] = [];
  for (const entry of entries) {
    const previous = groups.at(-1);
    if (entry.role === "assistant" && previous?.[0].role === "assistant") previous.push(entry);
    else groups.push([entry]);
  }
  return (
    <section className="wb-conversation-log" aria-label={tr("对话记录", "Conversation")}>
      {!!(next || before) && (
        <div className="wb-conversation-page">
          {next && (
            <button onClick={() => setBefore(next)}>{tr("更早的对话", "Earlier messages")}</button>
          )}
          {before && (
            <button onClick={() => setBefore(null)}>{tr("回到最新", "Latest messages")}</button>
          )}
        </div>
      )}
      {groups.map((group) => (
        <div key={group[0].sequence}>
          {group[0].role === "user" ? (
            <div className="wb-user-message">{group[0].text}</div>
          ) : (
            <AssistantMessage
              text={group.map((e) => e.text).join("\n\n")}
              at={group[0].at_ms}
              english={tr("zh", "en") === "en"}
            />
          )}
          {group
            .filter((e) => e.truncated)
            .map((e) => (
              <details key={e.sequence}>
                <summary>{tr("展开完整内容（分页）", "Full content (paged)")}</summary>
                <Saved reference={e.source} plain={e.role === "user"} />
              </details>
            ))}
        </div>
      ))}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
export function QueueEdit({
  task,
  message,
  compact = false,
}: {
  task: string;
  message: Message;
  compact?: boolean;
}) {
  const tr = useWords();
  const [edit, setEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const eligible = ["queued", "steer_requested"].includes(message.state);
  const act = async (cancel = false) => {
    setBusy(true);
    setError("");
    try {
      const base = {
        task_id: task,
        message_id: message.id,
        expected_object_id: message.content.object_id,
      };
      await workspaceAction(
        cancel
          ? { kind: "cancel_message", ...base }
          : { kind: "edit_message", ...base, text: edit || "" },
      );
      setEdit(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className={compact ? "wb-queue-actions" : "model-actions"}>
        <button
          type="button"
          className={compact ? "wb-queue-edit" : ""}
          aria-label={tr("编辑", "Edit")}
          disabled={busy || !eligible}
          onClick={() => {
            setBusy(true);
            void readExecutionContent(message.content)
              .then(setEdit)
              .catch((e) => setError(String(e)))
              .finally(() => setBusy(false));
          }}
        >
          {compact ? <Icon name="edit" /> : tr("编辑", "Edit")}
        </button>
        <button disabled={busy || !eligible} onClick={() => void act(true)}>
          {compact ? (
            <span aria-label={tr("取消消息", "Cancel message")}>
              <Icon name="close" />
            </span>
          ) : (
            tr("取消消息", "Cancel message")
          )}
        </button>
      </div>
      {edit !== null && (
        <div>
          <textarea
            aria-label={tr("编辑排队消息", "Edit queued message")}
            value={edit}
            onChange={(e) => setEdit(e.target.value)}
          />
          <button disabled={busy || !edit.trim()} onClick={() => void act()}>
            {tr("保存修改", "Save changes")}
          </button>
          <button disabled={busy} onClick={() => setEdit(null)}>
            {tr("放弃修改", "Discard changes")}
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
