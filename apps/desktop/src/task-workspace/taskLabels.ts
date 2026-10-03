import type { TaskState } from "../generated/contracts";
export function taskLabels(english: boolean) {
  const tr = (zh: string, en: string) => (english ? en : zh);
  const status = (s: TaskState) =>
    ({
      queued: tr("排队", "Queued"),
      running: tr("运行中", "Running"),
      stopping: tr("正在停止", "Stopping"),
      interrupted: tr("已中断", "Interrupted"),
      failed: tr("失败", "Failed"),
      completed: tr("已完成", "Completed"),
      awaiting_input: tr("等待输入", "Awaiting input"),
      awaiting_approval: tr("等待审批", "Awaiting approval"),
    })[s];
  const reasonLabel = (r: string | null | undefined) =>
    ({
      team_waiting: tr(
        "主助手正在等待成员交付，成员继续工作。",
        "The lead is waiting; members continue working.",
      ),
      team_results_need_review: tr(
        "还有成员成果需要检查。可查看团队情况，再继续主任务。",
        "Member deliveries still need review. Inspect the team and continue the lead.",
      ),
      parent_stopped: tr(
        "主任务已停止，成员一起暂停。",
        "The parent stopped; this member is paused.",
      ),
      awaiting_approval: tr("等待你确认具体操作。", "Waiting for action approval."),
      awaiting_media_approval: tr(
        "文件或图片生成需要确认，请查看待批准操作。",
        "File or image generation needs approval. Review the pending action.",
      ),
      image_service_error: tr(
        "图片服务出错，任务已停止。请在文件成果与图片中查看原因。",
        "The image service failed and the task stopped. See Files and images for details.",
      ),
      awaiting_extension_approval: tr(
        "扩展操作需要确认。查看并批准后，再继续任务。",
        "An extension action needs approval. Review it, then continue the task.",
      ),
      approval_rejected: tr(
        "你已拒绝此操作，任务已暂停。",
        "The action was rejected; this task is paused.",
      ),
      user_stop: tr(
        "你停止了任务，可手动继续。",
        "You stopped the task. Continue manually when ready.",
      ),
      engine_exit: tr(
        "程序曾退出，任务未自动重跑。",
        "The engine exited. This task was not restarted.",
      ),
      step_limit: tr(
        "达到步骤上限，已暂停。可调整上限后继续。",
        "The step limit was reached. Adjust limits or continue.",
      ),
      time_limit: tr("达到时间上限，已暂停。", "The time limit was reached."),
      context_limit_pinned_requirements: tr(
        "必须保留的要求已超过上下文容量。可提高容量或新建任务。",
        "Pinned requirements exceed the context budget. Increase it or start a new task.",
      ),
      tool_result_needs_review: tr(
        "有工具结果不确定，请先核对下方记录。",
        "A tool result is uncertain. Review the action below.",
      ),
      plan_has_unfinished_steps: tr(
        "计划中还有未完成项，任务已暂停。",
        "The plan still has unfinished steps.",
      ),
    })[r || ""] || "";
  return { status, reasonLabel };
}
