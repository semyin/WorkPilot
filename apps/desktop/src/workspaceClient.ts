import { createContext, useContext } from "react";
import type { WorkspaceAction, WorkspaceQuery, WorkspaceData } from "./generated/contracts";
import { executionCommand } from "./executionClient";
export const LanguageContext = createContext(false);
export function useWords() {
  const english = useContext(LanguageContext);
  return (zh: string, en: string) => (english ? en : zh);
}
export async function workspaceQuery(query: WorkspaceQuery): Promise<WorkspaceData> {
  const r = await executionCommand({ kind: "read", query: { kind: "workspace", query } });
  if (r.kind !== "workspace") throw new Error("Unexpected workspace response");
  return r.data;
}
export async function workspaceAction(action: WorkspaceAction): Promise<WorkspaceData> {
  const r = await executionCommand({ kind: "workspace", action });
  if (r.kind !== "workspace") throw new Error("Unexpected workspace response");
  return r.data;
}
export function taskState(state: string, english: boolean) {
  return ({
    queued: ["排队", "Queued"],
    running: ["运行中", "Running"],
    stopping: ["正在停止", "Stopping"],
    interrupted: ["已中断", "Interrupted"],
    failed: ["失败", "Failed"],
    completed: ["已完成", "Completed"],
    awaiting_input: ["等待输入", "Awaiting input"],
    awaiting_approval: ["等待审批", "Awaiting approval"],
  }[state] || [state, state])[english ? 1 : 0];
}
