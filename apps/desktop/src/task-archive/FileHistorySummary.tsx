import { useWords } from "../workspaceClient";

export type RestoredFileHistory = {
  task_id: string;
  path: string;
  previous_path: string | null;
  change: string;
  at_ms: number;
  before_exists: boolean;
  before_bytes: number;
  after_exists: boolean;
  after_bytes: number;
};
export function FileHistorySummary({
  rows,
  included,
  tasks = [],
}: {
  rows?: RestoredFileHistory[];
  included?: boolean;
  tasks?: { task_id: string; title: string }[];
}) {
  const tr = useWords();
  if (included === false)
    return (
      <p>
        {tr(
          "这份旧档案没有随包保存独立文件历史。需要这些版本时，请从原任务重新导出新版档案。",
          "This older archive does not include the separate file history. Export a new archive from the source task if you need those versions.",
        )}
      </p>
    );
  if (!rows?.length) return null;
  const changes: Record<string, string> = {
    created: tr("新增", "Created"),
    modified: tr("修改", "Modified"),
    deleted: tr("删除", "Deleted"),
    renamed: tr("改名", "Renamed"),
  };
  return (
    <section
      className="transfer-preview"
      aria-label={tr("随任务恢复的文件历史", "File history restored with tasks")}
    >
      <h4>
        {tr("随任务恢复的文件历史", "File history restored with tasks")} · {rows.length}
      </h4>
      <p>
        {tr(
          "只把修改前后版本加入所选项目的历史，不覆盖当前文件。恢复后进入“文件与终端 → 修改历史”查看差异；恢复具体版本时会重新核对当前文件并按权限审批。原来的文件操作不会重跑。",
          "Adds before/after versions to the selected project's history without overwriting current files. After restoration, open Files and terminal → History to compare versions. Restoring a file checks its current version and requires the current permissions. Old file operations are not replayed.",
        )}
      </p>
      <ul>
        {rows.map((r, i) => (
          <li key={i}>
            <strong>{r.path}</strong> · {changes[r.change] || r.change}
            {tasks.length > 0 && <> · {tasks.find((t) => t.task_id === r.task_id)?.title}</>}
            {r.previous_path && <div>← {r.previous_path}</div>}
            <div>
              <small>
                {tr("修改前：", "Before: ")}
                {r.before_exists ? `${r.before_bytes} B` : tr("不存在", "absent")} ·{" "}
                {tr("修改后：", "After: ")}
                {r.after_exists ? `${r.after_bytes} B` : tr("不存在", "absent")}
              </small>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
