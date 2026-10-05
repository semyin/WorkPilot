import { useEffect, useState } from "react";
import type { ConversationEntry, Message } from "./generated/contracts";
import { workspaceAction, workspaceQuery, useWords } from "./workspaceClient";
import { readExecutionContent } from "./executionClient";
import { Saved } from "./SavedContent";
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
  return (
    <section className="conversation" aria-label={tr("对话记录", "Conversation")}>
      <div className="model-actions">
        {next && (
          <button onClick={() => setBefore(next)}>{tr("更早的对话", "Earlier messages")}</button>
        )}
        {before && (
          <button onClick={() => setBefore(null)}>{tr("回到最新", "Latest messages")}</button>
        )}
      </div>
      {entries.map((e) => (
        <article key={e.sequence} className={`conversation-turn ${e.role}`}>
          <small>{e.role === "user" ? tr("你", "You") : tr("助手", "Assistant")}</small>
          <pre>{e.text}</pre>
          {e.truncated && (
            <details>
              <summary>{tr("展开完整内容（分页）", "Full content (paged)")}</summary>
              <Saved reference={e.source} plain={e.role === "user"} />
            </details>
          )}
        </article>
      ))}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
export function QueueEdit({ task, message }: { task: string; message: Message }) {
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
      <div className="model-actions">
        <button
          disabled={busy || !eligible}
          onClick={() => {
            setBusy(true);
            void readExecutionContent(message.content)
              .then(setEdit)
              .catch((e) => setError(String(e)))
              .finally(() => setBusy(false));
          }}
        >
          {tr("编辑", "Edit")}
        </button>
        <button disabled={busy || !eligible} onClick={() => void act(true)}>
          {tr("取消消息", "Cancel message")}
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
