import { useEffect, useState } from "react";
import type { WorkspaceArtifact } from "../generated/contracts";
import { workspaceQuery, useWords } from "../workspaceClient";
import { executionCommand, readExecutionContent } from "../executionClient";
import { Saved } from "../SavedContent";
import { MessageBody } from "./MessageBody";
import { Icon } from "./Icon";

export function ArtifactPreview({
  task,
  sequence,
  focused,
}: {
  task: string;
  sequence: number;
  focused?: string | null;
}) {
  const tr = useWords();
  const [items, setItems] = useState<WorkspaceArtifact[]>([]),
    [chosen, setChosen] = useState<string | null>(focused || null);
  const [text, setText] = useState(""),
    [more, setMore] = useState(false),
    [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (focused) setChosen(focused);
  }, [focused]);
  useEffect(() => {
    let live = true;
    void workspaceQuery({ kind: "artifacts", task_id: task })
      .then((r) => {
        if (live && r.kind === "artifacts") {
          setItems(r.artifacts);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (live) {
          setError(String(e));
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [task, sequence]);
  const current = items.find((a) => a.id === chosen) || items[0];
  useEffect(() => {
    let live = true;
    setText("");
    setMore(false);
    setError("");
    if (current)
      void executionCommand({
        kind: "read",
        query: { kind: "content", object_id: current.content.object_id, offset: 0, limit: 65536 },
      })
        .then((r) => {
          if (live && r.kind === "content") {
            setText(r.page.text);
            setMore(r.page.next_offset < current.content.bytes);
          }
        })
        .catch((e) => {
          if (live) setError(String(e));
        });
    return () => {
      live = false;
    };
  }, [current?.id, current?.revision_id]);
  const download = async () => {
    if (!current) return;
    try {
      const full = await readExecutionContent(current.content);
      const url = URL.createObjectURL(new Blob([full], { type: current.content.media_type }));
      const link = document.createElement("a");
      link.href = url;
      link.download = current.path.split(/[\\/]/).at(-1) || "artifact.txt";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <>
      {current ? (
        <>
          <h2>{current.path.split(/[\\/]/).at(-1)}</h2>
          <div className="wb-panel-caption">
            {tr("当前任务的成果", "Artifact from this task")} ·{" "}
            {Math.ceil(current.content.bytes / 1024)} KB
          </div>
          <button className="wb-outline-button" onClick={() => void download()}>
            <Icon name="download" /> {tr("下载文件", "Download file")}
          </button>
          <article className="wb-paper wb-artifact-document">
            <MessageBody text={text} />
            {more && (
              <details>
                <summary>{tr("查看完整内容", "View full content")}</summary>
                <Saved reference={current.content} plain />
              </details>
            )}
          </article>
          <div className="wb-panel-meta">{current.path}</div>
          {items.length > 1 && (
            <h3 className="wb-other-artifacts">{tr("其它成果", "Other artifacts")}</h3>
          )}
          {items
            .filter((a) => a.id !== current.id)
            .map((a) => (
              <button className="wb-result-row" key={a.id} onClick={() => setChosen(a.id)}>
                <Icon name="files" />
                <strong>{a.path.split(/[\\/]/).at(-1)}</strong>
                <Icon name="right" />
              </button>
            ))}
        </>
      ) : (
        <>
          <h2>{tr("任务成果", "Task artifacts")}</h2>
          <p className="wb-panel-caption">
            {loading
              ? tr("正在读取…", "Loading…")
              : tr("生成的文件会出现在这里。", "Files created by this task will appear here.")}
          </p>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
