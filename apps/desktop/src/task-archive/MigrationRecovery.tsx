import { useEffect, useState } from "react";
import { taskArchive } from "./client";
import { useWords } from "../workspaceClient";
export type RecoveryItem = { kind: string; source_id: string; detail: string; record?: unknown };
export function RecoverySummary({ items }: { items?: RecoveryItem[] }) {
  const tr = useWords();
  if (!items?.length) return null;
  return (
    <div className="transfer-preview project-transfer">
      <strong>
        {tr(
          "这些原操作必须人工核对后才能继续",
          "Review these original operations before continuing",
        )}
      </strong>
      <p>
        {tr(
          "恢复不会重做旧操作。请核对原来是否已经完成，以及新位置应该如何处理。",
          "Restoration never replays old actions. Check whether they already happened and what should be done at the destination.",
        )}
      </p>
      <ol>
        {items.map((item, i) => (
          <li key={i}>
            <code>{item.source_id}</code>
            <p>
              {item.kind} · {item.detail}
            </p>
            {item.record != null && (
              <details>
                <summary>{tr("原操作记录", "Original operation record")}</summary>
                <pre>{JSON.stringify(item.record, null, 2)}</pre>
              </details>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
export function MigrationRecovery({ task }: { task: string }) {
  const tr = useWords();
  const [items, setItems] = useState<RecoveryItem[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    setItems([]);
    setNotes([]);
    setError("");
    void taskArchive<{ required: boolean; items: RecoveryItem[] }>({
      kind: "recovery_status",
      task_id: task,
    })
      .then((r) => {
        if (alive && r.required) {
          setItems(r.items);
          setNotes(r.items.map(() => ""));
        }
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [task]);
  if (!items.length && !error) return null;
  return (
    <section
      className="history-transfer project-transfer"
      aria-label={tr("迁入操作核对", "Review migrated operations")}
    >
      <RecoverySummary items={items} />
      {items.map((item, i) => (
        <label key={i}>
          {tr("第 ", "Item ")}
          {i + 1} · {item.source_id}
          <textarea
            disabled={busy}
            value={notes[i] || ""}
            placeholder={tr(
              "说明已经发生的结果，以及接下来允许怎样处理",
              "Describe observed effects and how to proceed",
            )}
            onChange={(e) => setNotes((old) => old.map((s, n) => (n === i ? e.target.value : s)))}
          />
        </label>
      ))}
      {items.length > 0 && (
        <button
          disabled={busy || notes.some((n) => n.trim().length < 2)}
          onClick={() =>
            void (async () => {
              setBusy(true);
              setError("");
              try {
                await taskArchive({ kind: "resolve_recovery", task_id: task, notes });
                setItems([]);
              } catch (e) {
                setError(String(e));
              } finally {
                setBusy(false);
              }
            })()
          }
        >
          {tr("保存核对说明；稍后手动继续", "Save review; continue manually later")}
        </button>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
