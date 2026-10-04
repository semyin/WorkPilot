import { useEffect, useRef, useState } from "react";
import type { TeamView, WorkspaceData } from "../generated/contracts";
import { executionCommand } from "../executionClient";
import { workspaceQuery } from "../workspaceClient";
import type { TaskReadStore } from "./taskReadStore";

type Detail = Extract<WorkspaceData, { kind: "detail" }>;
type Selection = { task: string | null; generation: number };
type View = { selection: Selection; detail: Detail; team: TeamView };

export async function readTaskDetail(task: string, reads: TaskReadStore): Promise<Detail> {
  const read = reads.beginRead();
  const result = await workspaceQuery({ kind: "detail", task_id: task });
  if (result.kind !== "detail" || result.snapshot.task.id !== task)
    throw new Error("任务详情与请求不匹配 / Task detail does not match its request");
  reads.observe([result.snapshot.task], read);
  return result;
}

/** Binds detail, team and errors to one selection; old selection replies never become its view. */
export function useTaskSelection(selected: string | null, reads: TaskReadStore) {
  const selection = useRef<Selection>({ task: selected, generation: 0 });
  if (selection.current.task !== selected)
    selection.current = { task: selected, generation: selection.current.generation + 1 };
  const identity = selection.current;
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<{ selection: Selection; text: string } | null>(null);
  useEffect(() => {
    if (!identity.task) return;
    const task = identity.task;
    localStorage.setItem("workpilot.execution", task);
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const [detail, team] = await Promise.all([
          readTaskDetail(task, reads),
          executionCommand({ kind: "read", query: { kind: "team", task_id: task } }),
        ]);
        if (disposed || selection.current !== identity) return;
        if (
          team.kind !== "team" ||
          (team.view.root_task_id !== task && !team.view.members.some((m) => m.task_id === task))
        )
          throw new Error("团队记录与任务不匹配 / Team does not match its task");
        setView({ selection: identity, detail, team: team.view });
        setError(null);
        timer = setTimeout(poll, 150);
      } catch (e) {
        if (disposed || selection.current !== identity) return;
        setError({ selection: identity, text: e instanceof Error ? e.message : String(e) });
        timer = setTimeout(poll, 1000);
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [identity, reads]);
  const current = view?.selection === identity ? view : null;
  return {
    detail: current?.detail || null,
    team: current?.team || null,
    error: error?.selection === identity ? error.text : "",
    selection,
  };
}
