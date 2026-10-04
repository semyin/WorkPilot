import { executionCommand } from "../executionClient";
import type {
  MigrationAction,
  MemoryItem,
  ProviderProfile,
  WorkspaceProject,
} from "../generated/contracts";
export async function migration<T>(action: MigrationAction): Promise<T> {
  const r = await executionCommand({ kind: "migration", action });
  if (r.kind !== "workbench") throw new Error("Migration response unavailable");
  return r.data as T;
}
export type Catalog = {
  projects: WorkspaceProject[];
  profiles: ProviderProfile[];
  memories: MemoryItem[];
  tasks: {
    id: string;
    project_id: string | null;
    title: string;
    state: string;
    archived: boolean;
  }[];
  extensions: {
    project_id: string;
    catalog: {
      items: {
        installation: { id: string; revision: number; scope: string | null };
        version: { manifest: { name: string } };
      }[];
      drafts: { id: string; scope: string | null; version: { manifest: { name: string } } }[];
    };
  }[];
};
export type Summary = {
  resume?: Receipt;
  archive_id: string;
  projects: {
    id: string;
    name: string;
    root_path: string;
    source_root: string | null;
    profiles: ProviderProfile[];
    memories: MemoryItem[];
    files: { path: string; bytes: number }[] | null;
    extensions: { source_id: string; draft: boolean; versions: number }[] | null;
  }[];
  tasks: {
    archive_id: string;
    tasks: { id: string; title: string }[];
    included_file_revisions: number;
    included_media: number;
  }[];
  history_roots: string[];
};
export type Receipt = {
  archive_id: string;
  status: string;
  error?: string;
  destinations?: import("../generated/contracts").MigrationDestination[];
  history_roots?: import("../generated/contracts").MigrationHistoryMapping[];
  projects: Record<string, { project_id: string }>;
  tasks: Record<string, { task_id: string; title: string; deleted?: boolean }>;
  files: Record<
    string,
    {
      task_id: string;
      operation_id: string;
      state: string;
      files: { path: string }[];
      deleted?: boolean;
    }
  >;
};
export type Preview = {
  recovery: {
    task_id: string;
    title: string;
    items: import("../task-archive/MigrationRecovery").RecoveryItem[];
  }[];
  fingerprint: string;
  summary: Summary;
  conflicts: string[];
  rules: string;
  receipt: Receipt | null;
};
