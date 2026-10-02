import { useEffect, useState } from "react";
import type { ContentRef } from "./generated/contracts";
import { executionCommand as command } from "./executionClient";
import { readExecutionContent } from "./executionClient";
import { useWords } from "./workspaceClient";

function references(value: unknown, found: Map<string, ContentRef>, depth = 0) {
  if (!value || typeof value !== "object" || depth > 12) return;
  const v = value as Record<string, unknown>;
  if (
    typeof v.object_id === "string" &&
    /^[a-f0-9]{64}$/.test(v.object_id) &&
    typeof v.bytes === "number" &&
    typeof v.media_type === "string"
  ) {
    found.set(v.object_id, v as ContentRef);
    return;
  }
  for (const item of Object.values(v)) {
    if (typeof item === "string" && item.startsWith("{")) {
      try {
        references(JSON.parse(item), found, depth + 1);
      } catch {
        /* ordinary text */
      }
    } else references(item, found, depth + 1);
  }
}
export function Saved({
  reference,
  plain = false,
  depth = 0,
}: {
  reference: ContentRef;
  plain?: boolean;
  depth?: number;
}) {
  const tr = useWords();
  const [copyStatus, setCopyStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const [next, setNext] = useState(0);
  const [text, setText] = useState("…");
  const [refs, setRefs] = useState<ContentRef[]>([]);
  useEffect(() => {
    setOffset(0);
  }, [reference.object_id]);
  useEffect(() => {
    let disposed = false;
    void command({
      kind: "read",
      query: { kind: "content", object_id: reference.object_id, offset, limit: 65536 },
    })
      .then((r) => {
        if (disposed) return;
        if (r.kind !== "content") throw new Error(tr("无法读取记录", "Could not read record"));
        setNext(r.page.next_offset);
        setRefs([]);
        let content = r.page.text;
        if (!plain && offset === 0 && r.page.next_offset >= reference.bytes) {
          try {
            const parsed: unknown = JSON.parse(content);
            content = JSON.stringify(parsed, null, 2);
            const found = new Map<string, ContentRef>();
            references(parsed, found);
            found.delete(reference.object_id);
            setRefs([...found.values()]);
          } catch {
            /* display plain text */
          }
        }
        setText(content);
      })
      .catch((e) => {
        if (!disposed) setText(String(e));
      });
    return () => {
      disposed = true;
    };
  }, [reference.object_id, reference.bytes, offset, plain]);
  return (
    <div className="saved-content">
      <pre>{text}</pre>
      <button
        onClick={() => {
          setCopyStatus("");
          if (reference.bytes > 8 * 1024 * 1024) {
            setCopyStatus(
              tr(
                "这条记录较大，请使用“导出完整记录”保存全文。",
                "Use Export complete records for this large record.",
              ),
            );
            return;
          }
          void readExecutionContent(reference)
            .then((v) => navigator.clipboard.writeText(v))
            .then(() => setCopyStatus(tr("已复制全部内容", "Full content copied")))
            .catch((e) => setCopyStatus(String(e)));
        }}
      >
        {tr("复制完整内容", "Copy full content")}
      </button>
      {copyStatus && <small role="status">{copyStatus}</small>}
      {(offset > 0 || next < reference.bytes) && (
        <div className="model-actions">
          <small>
            {offset}–{next} / {reference.bytes} bytes
          </small>
          <button disabled={!offset} onClick={() => setOffset(0)}>
            {tr("首页", "First")}
          </button>
          <button disabled={next >= reference.bytes} onClick={() => setOffset(next)}>
            {tr("下一页", "Next")}
          </button>
        </div>
      )}
      {depth < 3 &&
        refs.map((r) => <AttachedContent key={r.object_id} reference={r} depth={depth + 1} />)}
    </div>
  );
}
function AttachedContent({ reference, depth }: { reference: ContentRef; depth: number }) {
  const tr = useWords();
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        {tr("完整记录", "Full record")} · {reference.media_type} · {reference.bytes} bytes
      </summary>
      {open && (
        <Saved
          reference={reference}
          plain={reference.media_type !== "application/json"}
          depth={depth}
        />
      )}
    </details>
  );
}
