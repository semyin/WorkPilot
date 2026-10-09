import type { ToolApproval } from "../generated/contracts";
import { Saved } from "../SavedContent";
import { Icon } from "./Icon";
import { useWords } from "../workspaceClient";

export function ApprovalCard({
  approval: a,
  disabled,
  onDecide,
}: {
  approval: ToolApproval;
  disabled: boolean;
  onDecide: (approve: boolean) => void;
}) {
  const tr = useWords();
  return (
    <section
      className="wb-approval"
      data-approval-id={a.id}
      aria-label={tr("操作审批", "Action approval")}
    >
      <div className="wb-approval-title">
        <Icon name="shield" />
        {a.intent.tool === "write_file"
          ? tr("需要你确认一次文件修改", "A file change needs your approval")
          : tr("需要你确认一次操作", "An action needs your approval")}
      </div>
      <p>
        {a.intent.tool === "write_file"
          ? a.intent.version.exists
            ? tr("将替换已有文件内容。", "This will replace the existing file contents.")
            : tr(
                "将在已授权范围内创建文件。",
                "This will create a file within the authorized scope.",
              )
          : a.intent.tool}
      </p>
      <div className="wb-approval-scope">
        <Icon name="folder" />
        <span>{a.intent.target}</span>
      </div>
      <details>
        <summary>{tr("查看文件与具体操作", "View files and action details")}</summary>
        <p>
          {a.intent.risk === "process"
            ? tr(
                "在系统隔离中运行：可修改已选文件夹，不具备网络访问能力；系统允许的公共资源仍可能可读。",
                "Runs in isolation with access to the selected folder and no network capability; OS-permitted public resources may remain readable.",
              )
            : tr("仅限本任务已授权的文件夹。", "Limited to this task's authorized folder.")}
        </p>
        <pre>
          {a.intent.tool === "write_file"
            ? String((a.intent.arguments as { text?: unknown }).text ?? "")
            : JSON.stringify(a.intent.arguments, null, 2)}
        </pre>
        {a.review && <p>{a.review.reason || a.review.state}</p>}
        <p>
          {tr(
            "只批准这次操作及当前版本。文件或权限变化后，需要重新确认。",
            "Approval is for this action and version only. File or permission changes require a new review.",
          )}
        </p>
      </details>
      <div className="wb-button-row">
        <button className="wb-solid-button" disabled={disabled} onClick={() => onDecide(true)}>
          {tr("批准并继续", "Approve and continue")}
        </button>
        <button className="wb-outline-button" disabled={disabled} onClick={() => onDecide(false)}>
          {tr("拒绝此操作", "Reject action")}
        </button>
      </div>
      <details className="wb-approval-record">
        <summary>{tr("完整审批依据", "Full approval details")}</summary>
        <pre>{JSON.stringify(a, null, 2)}</pre>
        {a.review?.input && <Saved reference={a.review.input} />}
        {a.review?.output && <Saved reference={a.review.output} />}
      </details>
    </section>
  );
}
