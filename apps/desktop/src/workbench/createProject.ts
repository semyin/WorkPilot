import { invoke } from "@tauri-apps/api/core";
import { workspaceAction } from "../workspaceClient";

/** Creation asks only for the folder. Advanced defaults remain in Project settings. */
export async function createProjectFromFolder() {
  const path = await invoke<string | null>("pick_project_folder");
  if (!path) return null;
  const name =
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || path;
  const result = await workspaceAction({
    kind: "save_project",
    project_id: null,
    settings: {
      name: Array.from(name).slice(0, 200).join(""),
      root_path: path,
      default_profile_id: null,
      permission: "request_approval",
      rules: "",
      revision: 0,
    },
  });
  if (result.kind !== "project_saved")
    throw new Error("项目未保存，请重试。 / Project was not saved. Please try again.");
  return result.project;
}
