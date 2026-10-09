import { useEffect, useState } from "react";
import type {
  PluginInstallation,
  PluginVersion,
  SchedulePlan,
  WorkspaceArtifact,
} from "../generated/contracts";
import { executionCommand } from "../executionClient";
import { workspaceQuery, useWords } from "../workspaceClient";
import { Icon } from "./Icon";

export type Collection = "library" | "skills" | "schedules";
type Skill = { installation: PluginInstallation; version: PluginVersion };
export function CollectionPage({
  page,
  project,
  onManage,
  onArtifact,
  onBrowser,
}: {
  page: Collection;
  project: string | null;
  onManage: () => void;
  onArtifact: (artifact: WorkspaceArtifact) => void;
  onBrowser: () => void;
}) {
  const tr = useWords();
  const [artifacts, setArtifacts] = useState<WorkspaceArtifact[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [plans, setPlans] = useState<SchedulePlan[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [before, setBefore] = useState<string | null>(null),
    [more, setMore] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError("");
    const read = async () => {
      if (page === "library") {
        const tasks = await workspaceQuery({
          kind: "tasks",
          project_id: project,
          archived: false,
          search: "",
          before,
          limit: 12,
        });
        if (tasks.kind !== "tasks") return;
        const data = await Promise.all(
          tasks.tasks.map((task) => workspaceQuery({ kind: "artifacts", task_id: task.id })),
        );
        if (live) {
          setArtifacts(data.flatMap((r) => (r.kind === "artifacts" ? r.artifacts : [])));
          setMore(tasks.next_before);
        }
      } else if (page === "skills") {
        const r = await executionCommand({
          kind: "extensions",
          task_id: null,
          action: { kind: "catalog", query: null },
        });
        if (live && r.kind === "workbench")
          setSkills((r.data as unknown as { items: Skill[] }).items);
      } else {
        const r = await executionCommand({
          kind: "schedules",
          action: { kind: "list", include_deleted: false, offset: 0, limit: 12 },
        });
        if (live && r.kind === "schedules" && r.data.kind === "list") setPlans(r.data.items);
      }
    };
    void read()
      .catch((e) => {
        if (live) setError(String(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [page, project, before]);
  const intro =
    page === "library"
      ? tr(
          "与任务有关的文档、图片和其它成果，集中保存在这里。",
          "Documents, images and other artifacts from your tasks, together in one place.",
        )
      : page === "skills"
        ? tr(
            "让助手使用你熟悉的工作方法，并连接需要的工具。",
            "Give your assistant familiar working methods and connect the tools you need.",
          )
        : tr(
            "为重复工作安排时间。关闭窗口后继续运行，彻底退出后停止。",
            "Schedule repeated work. It continues with the window hidden and stops when you quit the app.",
          );
  return (
    <>
      <p className="wb-page-intro">{intro}</p>
      <div className="wb-page-toolbar">
        <h2>
          {page === "library"
            ? tr("最近的成果", "Recent artifacts")
            : page === "skills"
              ? tr("我的技能", "My skills")
              : tr("我的计划", "My schedules")}
        </h2>
        <button
          type="button"
          className={page === "library" ? "wb-outline-button" : "wb-solid-button"}
          onClick={onManage}
        >
          {page === "library"
            ? tr("添加资料", "Add material")
            : page === "skills"
              ? tr("创建技能", "Create a skill")
              : tr("新建计划", "New schedule")}
        </button>
      </div>
      {loading && (
        <p className="wb-working-line">
          <span className="wb-spinner" />
          {tr("正在读取…", "Loading…")}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {page === "library" && (
        <>
          {!!artifacts.length && (
            <div className="wb-result-list">
              {artifacts.map((a) => (
                <button
                  className="wb-result-row"
                  type="button"
                  key={a.id}
                  onClick={() => onArtifact(a)}
                >
                  <span className="wb-file-icon">
                    <Icon name="files" />
                  </span>
                  <span>
                    <strong>{a.title || a.path}</strong>
                    <small>
                      {a.path} · {Math.ceil(a.content.bytes / 1024)} KB
                    </small>
                  </span>
                  <Icon name="right" />
                </button>
              ))}
            </div>
          )}
          {!loading && !error && !artifacts.length && (
            <p className="wb-notice">
              {tr(
                "任务产生的成果会显示在这里。",
                "Artifacts created by your tasks will appear here.",
              )}
            </p>
          )}
          {(before || more) && (
            <div className="wb-button-row">
              {before && (
                <button onClick={() => setBefore(null)}>
                  {tr("最新成果", "Latest artifacts")}
                </button>
              )}
              {more && (
                <button onClick={() => setBefore(more)}>
                  {tr("更早的成果", "Earlier artifacts")}
                </button>
              )}
            </div>
          )}
        </>
      )}
      {page === "skills" && (
        <>
          {skills.map((s) => (
            <div className="wb-collection-row" key={s.installation.id}>
              <Icon name="spark" />
              <div>
                <h3>{s.version.manifest.name}</h3>
                <p>{s.version.manifest.description}</p>
              </div>
              <button className="wb-outline-button" onClick={onManage}>
                {tr("查看", "View")}
              </button>
            </div>
          ))}
          {!loading && !error && !skills.length && (
            <p className="wb-notice">
              {tr(
                "还没有安装技能，可以创建或导入自己的工作方法。",
                "No installed skills yet. Create or import your working methods.",
              )}
            </p>
          )}
          <h2 className="wb-connections-title">{tr("工具连接", "Tool connections")}</h2>
          <div className="wb-collection-row">
            <Icon name="globe" />
            <div>
              <h3>{tr("浏览器", "Browser")}</h3>
              <p>
                {tr(
                  "专用浏览器，或你已授权的 Chrome 与 Edge。",
                  "A dedicated browser, or Chrome and Edge pages you have authorized.",
                )}
              </p>
            </div>
            <button className="wb-outline-button" onClick={onBrowser}>
              {tr("管理", "Manage")}
            </button>
          </div>
        </>
      )}
      {page === "schedules" && (
        <>
          {plans.map((p) => (
            <div className="wb-collection-row" key={p.id}>
              <Icon name="clock" />
              <div>
                <h3>{p.spec.title}</h3>
                <p>
                  {p.next_at_ms
                    ? new Date(p.next_at_ms).toLocaleString()
                    : tr("暂无下次执行", "No upcoming run")}{" "}
                  · {p.spec.timezone}
                </p>
              </div>
              <button className="wb-outline-button" onClick={onManage}>
                {tr("查看计划", "View schedule")}
              </button>
            </div>
          ))}
          {!loading && !error && !plans.length && (
            <p className="wb-panel-caption">{tr("还没有定时计划。", "No schedules yet.")}</p>
          )}
          <div className="wb-notice">
            {tr(
              "定时执行也遵守你设置的权限。每次运行会创建独立任务，便于查看结果。",
              "Scheduled work respects your permissions. Each run creates its own task so you can review the result.",
            )}
          </div>
        </>
      )}
    </>
  );
}
