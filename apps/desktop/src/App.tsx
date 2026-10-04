import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LegacyApp } from "./LegacyApp";
import { TaskWorkspace } from "./TaskWorkspace";
import { ModelSettings } from "./ModelSettings";
import { WorkspaceSettings } from "./WorkspaceSettings";
import { MaintenanceStatus } from "./MaintenanceStatus";
import { LanguageContext, workspaceAction, workspaceQuery } from "./workspaceClient";
import type { WorkspaceData, WorkspacePreferences } from "./generated/contracts";
export type Overview = Extract<WorkspaceData, { kind: "overview" }>;
const defaults: WorkspacePreferences = {
  language: localStorage.getItem("workpilot.language") === "en" ? "en" : "zh",
  theme: "system",
  sidebar_width: 250,
  inspector_width: 380,
  sidebar_closed: false,
  inspector_closed: false,
  revision: 0,
};
export function App() {
  if (new URLSearchParams(location.search).has("diagnostics")) return <LegacyApp />;
  return <Workbench />;
}
function Workbench() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [preferences, setPreferences] = useState(defaults);
  const [models, setModels] = useState(false);
  const [settings, setSettings] = useState(false);
  const [workspaceGeneration, setWorkspaceGeneration] = useState(0);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [connected, setConnected] = useState(false);
  const [maintenance, setMaintenance] = useState<boolean | null>(null);
  const english = preferences.language === "en";
  const refresh = async () => {
    const r = await workspaceQuery({ kind: "overview" });
    if (r.kind === "overview") {
      setOverview(r);
      setPreferences(r.preferences);
      setConnected(true);
    }
  };
  useEffect(() => {
    if (maintenance !== null) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await workspaceQuery({ kind: "overview" });
        if (!disposed && r.kind === "overview") {
          setOverview(r);
          setPreferences(r.preferences);
          setConnected(true);
          setConnectionError("");
        }
      } catch (e) {
        if (!disposed) {
          setConnected(false);
          setConnectionError(String(e));
        }
      }
      if (!disposed) timer = setTimeout(poll, 1500);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [maintenance]);
  useEffect(() => {
    document.documentElement.lang = english ? "en" : "zh-CN";
    document.documentElement.dataset.theme = preferences.theme;
    localStorage.setItem("workpilot.language", preferences.language);
    void invoke("set_desktop_locale", { language: preferences.language }).catch(() => {});
  }, [preferences.language, preferences.theme, english]);
  const save = async (p: WorkspacePreferences) => {
    await workspaceAction({ kind: "save_preferences", preferences: p });
    await refresh();
  };
  const update = (p: WorkspacePreferences) => {
    void save(p).catch((e) => setError(String(e)));
  };
  return (
    <LanguageContext.Provider value={english}>
      {maintenance !== null ? (
        <MaintenanceStatus running={maintenance} showRestart={!settings} />
      ) : (
        <TaskWorkspace
          key={workspaceGeneration}
          language={preferences.language}
          onClose={() => void invoke("hide_window").catch((e) => setError(String(e)))}
          onModels={() => setModels(true)}
          desktop={{
            overview,
            preferences,
            connected,
            onRefresh: () => void refresh().catch((e) => setError(String(e))),
            onPreferences: update,
            onSettings: () => setSettings(true),
          }}
        />
      )}
      {maintenance === null && (error || connectionError) && (
        <div className="workspace-connection-error" role="alert">
          {error
            ? english
              ? "The change could not be saved. Review the details and try again."
              : "这项更改未能保存，请查看详情后重试。"
            : english
              ? "The engine could not be reached. No work has been resubmitted."
              : "暂时无法连接执行引擎，没有重新提交任务。"}
          <details>
            <summary>{english ? "Details" : "查看详情"}</summary>
            {error || connectionError}
          </details>
          <button
            onClick={() =>
              void refresh()
                .then(() => {
                  setError("");
                  setConnectionError("");
                })
                .catch((e) => setError(String(e)))
            }
          >
            {error ? (english ? "Dismiss" : "关闭提示") : english ? "Reconnect" : "重新连接"}
          </button>
        </div>
      )}
      {settings && overview && (
        <WorkspaceSettings
          preferences={preferences}
          scheduler={overview.scheduler}
          dataDir={overview.data_dir}
          onPreferences={save}
          onMaintenance={setMaintenance}
          onModels={() => {
            setSettings(false);
            setModels(true);
          }}
          onClose={() => setSettings(false)}
          onOpenTask={(id) => {
            localStorage.setItem("workpilot.execution", id);
            localStorage.removeItem("workpilot.project");
            setSettings(false);
            setWorkspaceGeneration((value) => value + 1);
          }}
        />
      )}{" "}
      {models && <ModelSettings language={preferences.language} onClose={() => setModels(false)} />}
    </LanguageContext.Provider>
  );
}
