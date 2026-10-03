import type { FileRevision, WorkbenchAction } from "../generated/contracts";
import { useWords } from "../workspaceClient";
import { HistoryTransferPanel } from "../HistoryTransferPanel";
import { call, type RevisionView } from "./api";
function Changes({ before, after }: { before: string; after: string }) {
  const a = before.split("\n"),
    b = after.split("\n");
  let start = 0,
    end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - end - 1] === b[b.length - end - 1]
  )
    end++;
  const rows = [
    ...a.slice(Math.max(0, start - 3), start).map((line) => ({ sign: " ", line })),
    ...a.slice(start, a.length - end).map((line) => ({ sign: "-", line })),
    ...b.slice(start, b.length - end).map((line) => ({ sign: "+", line })),
    ...b.slice(b.length - end, b.length - end + 3).map((line) => ({ sign: " ", line })),
  ];
  return (
    <pre className="file-diff">
      {rows.slice(0, 3000).map((row, i) => (
        <span key={i} data-change={row.sign}>
          {row.sign} {row.line}
          {"\n"}
        </span>
      ))}
      {rows.length > 3000 && "\n…（差异展示前 3000 行 / First 3000 diff lines）"}
    </pre>
  );
}

export function FileHistory({
  task,
  history,
  historyPage,
  moreHistory,
  revision,
  setRevision,
  busy,
  act,
  send,
}: {
  task: string;
  history: FileRevision[];
  historyPage: (append?: boolean) => Promise<void>;
  moreHistory: boolean;
  revision: RevisionView | null;
  setRevision: (value: RevisionView) => void;
  busy: boolean;
  act: (work: () => Promise<void>) => Promise<void>;
  send: (action: WorkbenchAction) => Promise<void>;
}) {
  const tr = useWords();
  return (
    <section className="file-history">
      <HistoryTransferPanel
        key={task}
        task={task}
        history={history}
        onImported={() => historyPage()}
      />
      <div className="file-toolbar">
        <h3>{tr("项目修改历史", "Project file history")}</h3>
        <button disabled={busy} onClick={() => void act(() => historyPage())}>
          {tr("刷新历史", "Refresh history")}
        </button>
      </div>
      <p>
        {tr(
          "恢复前会核对当前版本，并先保存当前内容。命令记录执行前后的差异；期间外部应用的每一次瞬间修改不保证逐条保存。",
          "Restore checks the current version and preserves it first. Command history captures before/after changes, not every intermediate external edit.",
        )}
      </p>
      <div className="file-history-grid">
        <div>
          {history.map((r) => (
            <button
              key={r.id}
              className="file-history-row"
              onClick={() =>
                void act(async () =>
                  setRevision(
                    await call<RevisionView>(task, { kind: "revision", revision_id: r.id }),
                  ),
                )
              }
            >
              <strong>{r.path}</strong>
              <small>
                {{
                  created: tr("新增", "Created"),
                  modified: tr("修改", "Modified"),
                  deleted: tr("删除", "Deleted"),
                  renamed: tr("改名", "Renamed"),
                }[r.change] || r.change}{" "}
                · {new Date(r.at_ms).toLocaleString()}
              </small>
              <small>
                {r.source} · {r.task_id.slice(0, 8)}
              </small>
              {r.origin && (
                <small>
                  {tr("导入来源任务：", "Imported from task: ")}
                  {r.origin.task_id.slice(0, 8)} · {r.origin.source}
                </small>
              )}
              {r.previous_path && <small>← {r.previous_path}</small>}
            </button>
          ))}
          {!history.length && (
            <p>{tr("还没有保存的文件修改。", "No file changes have been recorded yet.")}</p>
          )}
          {moreHistory && (
            <button onClick={() => void act(() => historyPage(true))}>
              {tr("更早的修改", "Earlier changes")}
            </button>
          )}
        </div>
        <div>
          {revision ? (
            <>
              <h3>{revision.revision.path}</h3>
              <div className="file-toolbar">
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      send({
                        kind: "edit",
                        edit: {
                          kind: "restore",
                          revision_id: revision.revision.id,
                          before: true,
                          expected: revision.current_version,
                        },
                      }),
                    )
                  }
                >
                  {tr("恢复修改前版本", "Restore before version")}
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      send({
                        kind: "edit",
                        edit: {
                          kind: "restore",
                          revision_id: revision.revision.id,
                          before: false,
                          expected: revision.current_version,
                        },
                      }),
                    )
                  }
                >
                  {tr("恢复修改后版本", "Restore after version")}
                </button>
              </div>
              {revision.before.text !== null && revision.after.text !== null ? (
                <Changes before={revision.before.text} after={revision.after.text} />
              ) : (
                <p>
                  {tr(
                    "二进制或大文件：可恢复原始内容；不提供文本差异。",
                    "Binary or large file: original bytes can be restored; text diff is unavailable.",
                  )}
                </p>
              )}
              <details>
                <summary>{tr("查看两个完整版本", "View both complete versions")}</summary>
                <div className="file-versions">
                  {[revision.before, revision.after].map((v, i) => (
                    <div key={i}>
                      <h4>{i ? tr("修改后", "After") : tr("修改前", "Before")}</h4>
                      <small>
                        {v.version.bytes} bytes · {v.version.sha256}
                      </small>
                      {v.preview ? (
                        <img className="file-image" src={v.preview} alt={v.path} />
                      ) : (
                        <pre>{v.text ?? v.hex_preview}</pre>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            </>
          ) : (
            <p>{tr("选择一条修改查看差异。", "Choose a change to inspect its versions.")}</p>
          )}
        </div>
      </div>
    </section>
  );
}
