import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  ProjectSettings,
  WorkspaceProject,
  ProfileCatalog,
  PermissionMode,
} from "../generated/contracts";
import { useWords, workspaceAction } from "../workspaceClient";
import { Dialog } from "./Dialog";
import { Select } from "./Menu";
export function ProjectDialog({
  project,
  catalog,
  onClose,
  onSaved,
}: {
  project: WorkspaceProject;
  catalog: ProfileCatalog;
  onClose: () => void;
  onSaved: (project: WorkspaceProject) => void;
}) {
  const tr = useWords();
  const [edit, setEdit] = useState<ProjectSettings>(project.settings);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await workspaceAction({
        kind: "save_project",
        project_id: project.id,
        settings: edit,
      });
      if (r.kind === "project_saved") onSaved(r.project);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={tr("项目设置", "Project settings")} onClose={onClose} busy={busy}>
      <p className="wb-description">
        {tr(
          "绑定工作文件夹，让相关任务共享模型、权限与项目规则。",
          "Connect a work folder and share model, permission and instructions across its tasks.",
        )}
      </p>
      <label>
        {tr("项目名称", "Project name")}
        <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
      </label>
      <label>
        {tr("项目文件夹", "Project folder")}
        <input
          value={edit.root_path}
          onChange={(e) => setEdit({ ...edit, root_path: e.target.value })}
        />
      </label>
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void invoke<string | null>("pick_project_folder")
            .then((path) => {
              if (path) setEdit((old) => ({ ...old, root_path: path }));
            })
            .catch((e) => setError(String(e)))
        }
      >
        {tr("选择文件夹…", "Choose folder…")}
      </button>
      <div className="wb-field">
        <span>{tr("默认模型", "Default model")}</span>
        <Select
          label={tr("默认模型", "Default model")}
          value={edit.default_profile_id || ""}
          options={[
            { value: "", label: tr("使用全局默认", "Use global default") },
            ...catalog.profiles.map(({ profile: p }) => ({
              value: p.id,
              label: p.label,
              description: p.model,
            })),
          ]}
          onChange={(value) => setEdit({ ...edit, default_profile_id: value || null })}
        />
      </div>
      <div className="wb-field">
        <span>{tr("默认权限", "Default permission")}</span>
        <Select
          label={tr("默认权限", "Default permission")}
          value={edit.permission}
          options={[
            { value: "request_approval", label: tr("请求审批", "Request approval") },
            { value: "auto_review", label: tr("帮我批准", "Review for me") },
            { value: "full_access", label: tr("完全访问", "Full access") },
          ]}
          onChange={(value) => setEdit({ ...edit, permission: value as PermissionMode })}
        />
      </div>
      <label>
        {tr("项目规则", "Project rules")}
        <textarea
          rows={3}
          value={edit.rules}
          onChange={(e) => setEdit({ ...edit, rules: e.target.value })}
        />
      </label>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="wb-dialog-actions">
        <button type="button" disabled={busy} onClick={onClose}>
          {tr("取消", "Cancel")}
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || !edit.name.trim() || !edit.root_path.trim()}
          onClick={() => void save()}
        >
          {tr("保存项目", "Save project")}
        </button>
      </div>
    </Dialog>
  );
}
