import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  ExtensionAdmin,
  ExtensionEffect,
  PluginInstallation,
  PluginPreview,
  PluginVersion,
  McpServerSpec,
  WorkbenchAction,
  WorkbenchOperation,
  JsonValue,
} from "./generated/contracts";
import { executionCommand } from "./executionClient";
import { useWords } from "./workspaceClient";
import { Saved } from "./SavedContent";
import { ExtensionTransferPanel } from "./ExtensionTransferPanel";
import "./extensions.css";
type Tool = { name: string; description?: string; inputSchema: JsonValue };
type Server = {
  spec: McpServerSpec;
  credential_configured: boolean;
  catalog: null | {
    tools: Tool[];
    tool_digests: Record<string, string>;
    state: string;
    protocol_version: string;
  };
};
type Item = { installation: PluginInstallation; version: PluginVersion; servers: Server[] };
type Catalog = {
  items: Item[];
  previews: PluginPreview[];
  history: { action: string; at_ms: number; data: PluginInstallation }[];
};
export function ExtensionPanel({
  task,
  onClose,
  onDraft,
}: {
  task: string | null;
  onClose: () => void;
  onDraft: (goal: string) => void;
}) {
  const tr = useWords();
  const [catalog, setCatalog] = useState<Catalog>({ items: [], previews: [], history: [] });
  const [source, setSource] = useState(""),
    [query, setQuery] = useState(""),
    [project, setProject] = useState(false);
  const [preview, setPreview] = useState<PluginPreview | null>(null),
    [resource, setResource] = useState<{ path: string; text: string | null; bytes: number } | null>(
      null,
    );
  const [chosen, setChosen] = useState(""),
    [goal, setGoal] = useState("");
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [operations, setOperations] = useState<WorkbenchOperation[]>([]);
  const [credential, setCredential] = useState<{ server: string; key: string } | null>(null),
    [secret, setSecret] = useState("");
  const [exportPath, setExportPath] = useState(""),
    [clientId, setClientId] = useState(""),
    [scopes, setScopes] = useState("");
  const [login, setLogin] = useState<{
    flow_id: string;
    authorization_url: string;
    state: string;
  } | null>(null);
  const [test, setTest] = useState<{ server: Server; tool: Tool } | null>(null),
    [args, setArgs] = useState("{}"),
    [scriptArgs, setScriptArgs] = useState("[]");
  const [history, setHistory] = useState<Catalog["history"]>([]);
  const live = useRef(true),
    working = useRef(false);
  const admin = async <T,>(action: ExtensionAdmin): Promise<T> => {
    const r = await executionCommand({ kind: "extensions", task_id: task, action });
    if (r.kind !== "workbench") throw new Error("Unexpected extension response");
    return r.data as T;
  };
  const work = async <T,>(action: WorkbenchAction): Promise<T> => {
    if (!task)
      throw new Error(
        tr(
          "请先选择一个绑定文件夹的执行任务。",
          "Select an execution task with a project folder first.",
        ),
      );
    const r = await executionCommand({ kind: "workbench", task_id: task, action });
    if (r.kind !== "workbench") throw new Error("Unexpected tool response");
    return r.data as T;
  };
  const refresh = async () => {
    const data = await admin<Catalog>({ kind: "catalog", query: query || null });
    if (live.current) setCatalog(data);
    if (task) {
      const ops = await work<{ items: { operation: WorkbenchOperation }[] }>({
        kind: "operations",
      });
      if (live.current)
        setOperations(ops.items.map((v) => v.operation).filter((v) => v.kind === "extension"));
    }
  };
  const act = async (fn: () => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      working.current = false;
      if (live.current) setBusy(false);
    }
  };
  useEffect(() => {
    live.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (!working.current) await refresh();
      } catch (e) {
        if (live.current) setError(String(e));
      }
      if (live.current) timer = setTimeout(poll, 1200);
    };
    void poll();
    return () => {
      live.current = false;
      clearTimeout(timer);
    };
  }, [task, query]);
  useEffect(() => {
    if (!login || login.state !== "waiting") return;
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const v = await admin<{ state: string; message?: string }>({
          kind: "oauth_status",
          flow_id: login.flow_id,
        });
        if (disposed) return;
        if (v.state !== "waiting") {
          setLogin({ ...login, state: v.state });
          setNotice(v.message || v.state);
          await refresh();
        } else timer = setTimeout(poll, 1000);
      } catch (e) {
        if (!disposed) {
          setError(String(e));
          setLogin({ ...login, state: "failed" });
        }
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [login?.flow_id, login?.state]);
  const item = catalog.items.find((v) => v.installation.id === chosen);
  const run = (effect: ExtensionEffect) =>
    act(async () => {
      await work({ kind: "extension", effect });
      setNotice(
        tr("操作已提交，请在下方查看或批准。", "Operation submitted. Review its status below."),
      );
    });
  const base = item
    ? { installation_id: item.installation.id, revision: item.installation.revision }
    : null;
  const status = (s: string) =>
    ({
      awaiting_approval: tr("等待批准", "Awaiting approval"),
      queued: tr("排队中", "Queued"),
      running: tr("执行中", "Running"),
      stopping: tr("正在停止", "Stopping"),
      completed: tr("已完成", "Completed"),
      failed: tr("失败", "Failed"),
      cancelled: tr("已停止", "Stopped"),
    })[s] || s;
  return (
    <div
      className="extensions-overlay"
      role="dialog"
      aria-label={tr("技能与插件", "Skills & plugins")}
    >
      <header>
        <div>
          <h2>{tr("技能与插件", "Skills & plugins")}</h2>
          <p>
            {tr(
              "按任务加载技能，连接外部工具。安装前可以检查所有文件和权限。",
              "Load skills as needed and connect external tools. Inspect files and permissions before installing.",
            )}
          </p>
        </div>
        <button onClick={onClose}>{tr("关闭", "Close")}</button>
      </header>
      {error && (
        <div className="extension-error" role="alert">
          {error}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="extension-columns">
        <aside>
          <label>
            {tr("搜索已安装扩展", "Search installed extensions")}
            <input value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          {catalog.items.length === 0 && (
            <p>
              {tr(
                "还没有匹配的扩展。可从目录或压缩包导入，也可以让 AI 创建技能。",
                "No matching extensions. Import a folder or ZIP, or create a skill with AI.",
              )}
            </p>
          )}
          {catalog.items.map((v) => (
            <button
              className="extension-choice"
              aria-pressed={chosen === v.installation.id}
              key={v.installation.id}
              onClick={() => {
                setChosen(v.installation.id);
                setResource(null);
                setTest(null);
                setCredential(null);
                setHistory([]);
              }}
            >
              <strong>{v.version.manifest.name}</strong>
              <small>
                {v.version.manifest.version} ·{" "}
                {v.installation.enabled ? tr("已启用", "Enabled") : tr("已停用", "Disabled")} ·{" "}
                {v.installation.scope ? tr("项目", "Project") : tr("全局", "Global")}
              </small>
            </button>
          ))}
          <h3>
            {tr("等待确认", "Awaiting confirmation")} ({catalog.previews.length})
          </h3>
          {catalog.previews.map((p) => (
            <button
              className="extension-choice"
              key={p.id}
              onClick={() => {
                setPreview(p);
                setResource(null);
              }}
            >
              {p.version.manifest.name}
              <small>
                {p.draft
                  ? tr("AI 草稿 · 尚未启用", "AI draft · Not enabled")
                  : tr("安装预览", "Install preview")}
              </small>
            </button>
          ))}
          <details>
            <summary>{tr("操作记录", "Activity history")}</summary>
            {catalog.history.map((h, n) => (
              <p key={n}>
                {new Date(h.at_ms).toLocaleString()} · {h.action}
              </p>
            ))}
          </details>
        </aside>
        <main>
          <ExtensionTransferPanel key={task || "global"} task={task} onImported={refresh} />
          <section>
            <h3>{tr("导入扩展", "Import extension")}</h3>
            <label>
              {tr("本地目录、ZIP 完整路径或下载地址", "Folder, full ZIP path or download URL")}
              <input
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder={tr(
                  "粘贴路径或 HTTPS ZIP 下载地址",
                  "Paste a path or HTTPS ZIP download URL",
                )}
              />
            </label>
            <label className="extension-inline">
              <input
                type="checkbox"
                checked={project}
                onChange={(e) => setProject(e.target.checked)}
                disabled={!task}
              />
              {tr("仅用于当前项目", "Current project only")}
            </label>
            <button
              disabled={busy || !source.trim()}
              onClick={() =>
                void act(async () => {
                  setPreview(
                    await admin<PluginPreview>({ kind: "preview", source: source.trim(), project }),
                  );
                  setResource(null);
                })
              }
            >
              {tr("检查安装包", "Inspect package")}
            </button>
          </section>
          <section>
            <h3>{tr("让 AI 创建技能", "Create a skill with AI")}</h3>
            <label>
              {tr("描述希望反复使用的方法", "Describe a reusable method")}
              <textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder={tr(
                  "例如：按我的格式检查报告，并附上检查清单",
                  "For example: review reports using my format and include a checklist",
                )}
              />
            </label>
            <button disabled={!goal.trim() || busy} onClick={() => onDraft(goal.trim())}>
              {tr("准备创建任务", "Prepare skill task")}
            </button>
            <small>
              {tr(
                "接着选择模型并启动任务。AI 只保存草稿，仍由你检查并确认启用。",
                "Choose a model and start the task next. AI saves a draft; you review and enable it.",
              )}
            </small>
          </section>
          {preview && (
            <section className="extension-preview">
              <h3>
                {tr("安装前预览", "Review before installation")} · {preview.version.manifest.name}{" "}
                {preview.version.manifest.version}
              </h3>
              <p>{preview.version.manifest.description}</p>
              <p className="extension-break">
                {tr("来源", "Source")}: {preview.source}
              </p>
              <p>
                {tr("范围", "Scope")}:{" "}
                {preview.scope ? tr("当前项目", "Current project") : tr("全部项目", "All projects")}
              </p>
              <ul>
                {preview.version.permissions.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              {preview.version.warnings.map((w) => (
                <p key={w}>{w}</p>
              ))}
              {preview.version.manifest.dependencies.length > 0 && (
                <p>
                  {tr("需要已启用依赖", "Requires enabled dependencies")}:{" "}
                  {preview.version.manifest.dependencies
                    .map((d) => d.id + " " + d.version)
                    .join(", ")}
                </p>
              )}
              <details>
                <summary>
                  {tr("查看文件与内容摘要", "Files and content digest")} (
                  {preview.version.files.length})
                </summary>
                <code className="extension-break">{preview.version.digest}</code>
                {preview.version.files.map((f) => (
                  <button
                    className="extension-file"
                    key={f.path}
                    onClick={() =>
                      void act(async () =>
                        setResource(
                          await admin({
                            kind: "preview_resource",
                            draft_id: preview.id,
                            path: f.path,
                          }),
                        ),
                      )
                    }
                  >
                    {f.path} · {f.bytes} B
                  </button>
                ))}
              </details>
              <div className="extension-buttons">
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const i = await admin<PluginInstallation>({
                        kind: "confirm",
                        draft_id: preview.id,
                        digest: preview.version.digest,
                        enable: true,
                      });
                      setChosen(i.id);
                      setPreview(null);
                      setResource(null);
                      setNotice(tr("已安装并启用。", "Installed and enabled."));
                    })
                  }
                >
                  {tr("确认安装并启用", "Confirm and enable")}
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await admin({ kind: "discard_preview", draft_id: preview.id });
                      setPreview(null);
                      setResource(null);
                    })
                  }
                >
                  {tr("丢弃预览", "Discard preview")}
                </button>
              </div>
            </section>
          )}
          {item && base && (
            <section>
              <h3>
                {item.version.manifest.name} <small>{item.version.manifest.version}</small>
              </h3>
              <p>{item.version.manifest.description}</p>
              <div className="extension-buttons">
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await admin({
                        kind: "set_enabled",
                        ...base,
                        enabled: !item.installation.enabled,
                      });
                    })
                  }
                >
                  {item.installation.enabled ? tr("停用", "Disable") : tr("启用", "Enable")}
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await admin({ kind: "uninstall", ...base });
                      setChosen("");
                      setNotice(
                        tr(
                          "已卸载，项目文件和历史产物保留。",
                          "Uninstalled. Project files and historical outputs are preserved.",
                        ),
                      );
                    })
                  }
                >
                  {tr("卸载", "Uninstall")}
                </button>
                <button
                  onClick={() =>
                    void act(async () => {
                      const r = await admin<{ history: Catalog["history"] }>({
                        kind: "versions",
                        installation_id: base.installation_id,
                      });
                      setHistory(r.history);
                    })
                  }
                >
                  {tr("版本记录", "Version history")}
                </button>
              </div>
              {history
                .filter(
                  (h) =>
                    h.data.active_digest &&
                    h.data.active_digest !== item.installation.active_digest,
                )
                .map((h, n) => (
                  <p key={n}>
                    {new Date(h.at_ms).toLocaleString()}{" "}
                    <button
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await admin({ kind: "rollback", ...base, digest: h.data.active_digest });
                          setHistory([]);
                        })
                      }
                    >
                      {tr("回退到此版本", "Restore this version")}
                    </button>
                  </p>
                ))}
              <h4>{tr("技能及资源", "Skills and resources")}</h4>
              {item.version.skills.map((s) => (
                <p key={s.name}>
                  <button
                    onClick={() =>
                      void act(async () =>
                        setResource(await admin({ kind: "read_resource", ...base, path: s.path })),
                      )
                    }
                  >
                    {s.name}
                  </button>{" "}
                  {s.description}
                </p>
              ))}
              <details>
                <summary>{tr("全部资源与脚本测试", "All resources and script tests")}</summary>
                <label>
                  {tr("脚本参数（JSON 数组）", "Script arguments (JSON array)")}
                  <input value={scriptArgs} onChange={(e) => setScriptArgs(e.target.value)} />
                </label>
                {item.version.files.map((f) => (
                  <div key={f.path} className="extension-buttons">
                    <button
                      onClick={() =>
                        void act(async () =>
                          setResource(
                            await admin({ kind: "read_resource", ...base, path: f.path }),
                          ),
                        )
                      }
                    >
                      {f.path}
                    </button>
                    {/(^|\/)scripts\/.+\.(m?js|cjs|py|ps1)$/.test(f.path) && (
                      <button
                        disabled={busy || !task || !item.installation.enabled}
                        onClick={() =>
                          void act(async () => {
                            const args: unknown = JSON.parse(scriptArgs);
                            if (!Array.isArray(args) || !args.every((a) => typeof a === "string"))
                              throw new Error(
                                tr(
                                  "参数必须是文字数组。",
                                  "Arguments must be an array of strings.",
                                ),
                              );
                            await work({
                              kind: "extension",
                              effect: { kind: "run_script", ...base, path: f.path, args },
                            });
                          })
                        }
                      >
                        {tr("测试脚本", "Test script")}
                      </button>
                    )}
                  </div>
                ))}
              </details>
              <h4>{tr("外部工具服务", "External tool services")}</h4>
              {item.servers.map((s) => (
                <article className="extension-server" key={s.spec.id}>
                  <strong>{s.spec.name}</strong>
                  <p>
                    {s.spec.transport.kind === "http"
                      ? s.spec.transport.url
                      : tr("本地程序 · 遵循当前任务权限", "Local process · Uses task permissions")}
                  </p>
                  <button
                    disabled={busy || !task || !item.installation.enabled}
                    onClick={() => void run({ kind: "discover", ...base, server_id: s.spec.id })}
                  >
                    {tr("检查连接并发现工具", "Check connection and discover tools")}
                  </button>
                  {s.spec.transport.kind === "http" && s.spec.transport.auth !== "none" && (
                    <>
                      <p>
                        {s.credential_configured
                          ? tr("已配置登录凭据", "Credential configured")
                          : tr("尚未配置登录凭据", "No credential configured")}
                      </p>
                      <button
                        onClick={() => {
                          setCredential({ server: s.spec.id, key: "authorization" });
                          setSecret("");
                        }}
                      >
                        {tr("设置或清除密钥", "Set or clear credential")}
                      </button>
                      {s.spec.transport.auth === "oauth" && (
                        <details>
                          <summary>{tr("浏览器登录", "Browser sign-in")}</summary>
                          <label>
                            {tr(
                              "公开客户端编号（服务要求时填写）",
                              "Public client ID (if required)",
                            )}
                            <input value={clientId} onChange={(e) => setClientId(e.target.value)} />
                          </label>
                          <label>
                            {tr("申请范围（空格分隔）", "Scopes (space-separated)")}
                            <input value={scopes} onChange={(e) => setScopes(e.target.value)} />
                          </label>
                          <button
                            disabled={busy}
                            onClick={() =>
                              void act(async () => {
                                setLogin(
                                  await admin({
                                    kind: "oauth_start",
                                    ...base,
                                    server_id: s.spec.id,
                                    client_id: clientId.trim() || null,
                                    scopes: scopes.trim() ? scopes.trim().split(/\s+/) : [],
                                  }),
                                );
                              })
                            }
                          >
                            {tr("准备登录", "Prepare sign-in")}
                          </button>
                        </details>
                      )}
                    </>
                  )}
                  {s.spec.transport.kind === "stdio" &&
                    s.spec.transport.secret_env.map((key) => (
                      <button
                        key={key}
                        onClick={() => {
                          setCredential({ server: s.spec.id, key });
                          setSecret("");
                        }}
                      >
                        {tr("配置凭据", "Credential")} {key}
                      </button>
                    ))}
                  <p>
                    {s.catalog
                      ? tr(
                          `已发现 ${s.catalog.tools.length} 个工具`,
                          `Discovered ${s.catalog.tools.length} tools`,
                        )
                      : tr("尚未检查工具", "Tools not checked yet")}
                  </p>
                  {s.catalog?.tools.map((t) => (
                    <p key={t.name}>
                      <button
                        disabled={!item.installation.enabled}
                        onClick={() => {
                          setTest({ server: s, tool: t });
                          setArgs("{}");
                        }}
                      >
                        {t.name}
                      </button>{" "}
                      {t.description}
                    </p>
                  ))}
                </article>
              ))}
              {credential && (
                <div className="extension-credential">
                  <h4>
                    {tr("凭据设置", "Credential settings")} · {credential.key}
                  </h4>
                  <input
                    aria-label={tr("扩展凭据", "Extension credential")}
                    type="password"
                    autoComplete="off"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                  />
                  <button
                    disabled={busy || !secret}
                    onClick={() =>
                      void act(async () => {
                        const value = secret;
                        setSecret("");
                        await admin({
                          kind: "save_credential",
                          ...base,
                          server_id: credential.server,
                          key: credential.key,
                          secret: value,
                        });
                        setCredential(null);
                      })
                    }
                  >
                    {tr("保存到系统凭据存储", "Save to system credential store")}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        setSecret("");
                        await admin({
                          kind: "save_credential",
                          ...base,
                          server_id: credential.server,
                          key: credential.key,
                          secret: null,
                        });
                        setCredential(null);
                      })
                    }
                  >
                    {tr("清除凭据", "Clear credential")}
                  </button>
                </div>
              )}
              {test && (
                <div>
                  <h4>
                    {tr("测试工具", "Test tool")} · {test.tool.name}
                  </h4>
                  <details>
                    <summary>{tr("参数说明", "Parameter schema")}</summary>
                    <pre>{JSON.stringify(test.tool.inputSchema, null, 2)}</pre>
                  </details>
                  <label>
                    {tr("工具参数（JSON）", "Tool arguments (JSON)")}
                    <textarea
                      aria-label={tr("工具参数（JSON）", "Tool arguments (JSON)")}
                      value={args}
                      onChange={(e) => setArgs(e.target.value)}
                    />
                  </label>
                  <button
                    disabled={busy || !task || !item.installation.enabled}
                    onClick={() =>
                      void act(async () => {
                        await work({
                          kind: "extension",
                          effect: {
                            kind: "call",
                            ...base,
                            server_id: test.server.spec.id,
                            tool: test.tool.name,
                            tool_digest: test.server.catalog!.tool_digests[test.tool.name],
                            arguments: JSON.parse(args) as JsonValue,
                          },
                        });
                      })
                    }
                  >
                    {tr("提交测试调用", "Submit test call")}
                  </button>
                </div>
              )}
              <details>
                <summary>{tr("导出安装包", "Export package")}</summary>
                <label>
                  {tr("新 ZIP 文件完整路径", "Full path for a new ZIP file")}
                  <input value={exportPath} onChange={(e) => setExportPath(e.target.value)} />
                </label>
                <button
                  disabled={busy || !exportPath}
                  onClick={() =>
                    void act(async () => {
                      await admin({ kind: "export", ...base, destination: exportPath });
                      setNotice(
                        tr(
                          "已导出，单独保存的凭据不会写入安装包。",
                          "Exported. Stored credentials are excluded.",
                        ),
                      );
                    })
                  }
                >
                  {tr("导出", "Export")}
                </button>
              </details>
            </section>
          )}
          {login && (
            <section>
              <h3>{tr("登录进度", "Sign-in status")}</h3>
              <p>
                {login.state === "waiting"
                  ? tr(
                      "等待你在浏览器中授权；五分钟后过期。",
                      "Waiting for browser authorization; expires in five minutes.",
                    )
                  : login.state}
              </p>
              {login.state === "waiting" && (
                <>
                  <button
                    onClick={() =>
                      void act(async () => {
                        await invoke("extension_open_login", { url: login.authorization_url });
                      })
                    }
                  >
                    {tr("打开登录页面", "Open sign-in page")}
                  </button>
                  <button
                    onClick={() =>
                      void act(async () => {
                        await admin({ kind: "oauth_cancel", flow_id: login.flow_id });
                        setLogin(null);
                      })
                    }
                  >
                    {tr("取消登录", "Cancel sign-in")}
                  </button>
                </>
              )}
            </section>
          )}
          {resource && (
            <section>
              <h3>{resource.path}</h3>
              {resource.text !== null ? (
                <pre className="extension-resource">{resource.text}</pre>
              ) : (
                <p>
                  {tr("二进制或较大资源", "Binary or large resource")} · {resource.bytes} B
                </p>
              )}
              <button onClick={() => setResource(null)}>{tr("收起内容", "Hide content")}</button>
            </section>
          )}
          <section>
            <h3>{tr("扩展操作与确认", "Extension operations and approvals")}</h3>
            {!task && (
              <p>
                {tr(
                  "选择一个执行任务后，可以测试工具和脚本。",
                  "Select an execution task to test tools and scripts.",
                )}
              </p>
            )}
            {operations.slice(0, 32).map((op) => (
              <article
                className="extension-operation"
                key={op.id}
                data-extension-operation={op.id}
                data-operation-state={op.state}
              >
                <strong>{op.summary}</strong>
                <p>{status(op.state)}</p>
                {op.error && <p role="alert">{op.error}</p>}
                <details>
                  <summary>{tr("查看完整输入与结果", "View full input and result")}</summary>
                  {op.input && <Saved reference={op.input} />}{" "}
                  {op.output && <Saved reference={op.output} />}
                </details>
                {op.state === "awaiting_approval" && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await work({
                          kind: "approve",
                          operation_id: op.id,
                          fingerprint: op.fingerprint,
                        });
                      })
                    }
                  >
                    {tr("批准这一次", "Approve once")}
                  </button>
                )}
                {["awaiting_approval", "queued", "running", "stopping"].includes(op.state) && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await work({ kind: "stop", operation_id: op.id });
                      })
                    }
                  >
                    {tr("停止", "Stop")}
                  </button>
                )}
              </article>
            ))}
          </section>
        </main>
      </div>
    </div>
  );
}
