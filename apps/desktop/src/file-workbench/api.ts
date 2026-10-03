import type {
  FileVersion,
  FileRevision,
  WorkbenchAction,
  WorkbenchOperation,
} from "../generated/contracts";
import { executionCommand } from "../executionClient";

export type FileView = {
  path: string;
  version: FileVersion;
  text: string | null;
  editable: boolean;
  preview: string | null;
  hex_preview: string;
};
export type Entry = { name: string; directory: boolean; linked: boolean; bytes: number };
export type OperationRow = { operation: WorkbenchOperation; live_output: string };
export type GitState = {
  head: string;
  branch: string;
  fingerprint: string;
  entries: { path: string; previous_path: string | null; status: string; version: FileVersion }[];
};
export type RevisionView = {
  revision: FileRevision;
  before: FileView;
  after: FileView;
  current_version: FileVersion;
};
export async function call<T>(task: string, action: WorkbenchAction): Promise<T> {
  const r = await executionCommand({ kind: "workbench", task_id: task, action });
  if (r.kind !== "workbench") throw new Error("Unexpected file workspace response");
  return r.data as T;
}
