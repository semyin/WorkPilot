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
export function TextAttachments({ onAttach }: { onAttach: (text: string) => void }) {
  const tr = useWords();
  const [error, setError] = useState("");
  return (
    <>
      <label className="attachment-input">
        {tr("附加文本文件", "Attach text file")}
        <input
          type="file"
          accept=".txt,.md,.csv,.json,.log,.ts,.js,.rs,.py,.html,.css,.xml,.yaml,.yml"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            setError("");
            try {
              if (file.size > 8192)
                throw new Error(
                  tr("请选择不超过 8 KiB 的文本文件。", "Choose a text file of at most 8 KiB."),
                );
              const bytes = await file.arrayBuffer();
              const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
              if (text.includes("\0"))
                throw new Error(tr("这个文件不是普通文本。", "This file is not plain text."));
              onAttach(`\n\n[${file.name}]\n${text}\n[/${file.name}]`);
            } catch (err) {
              setError(String(err));
            }
          }}
        />
      </label>
      <small>
        {tr(
          "文本会附在输入框中，一起发送给所选模型。图片和 Office 文件输入在 P10 接入。",
          "Text is added to the composer and sent to the selected model. Image and Office inputs arrive in P10.",
        )}
      </small>
      {error && <p className="error">{error}</p>}
    </>
  );
}
