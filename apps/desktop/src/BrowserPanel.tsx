import { useEffect, useRef, useState } from "react";
import type {
  BrowserAction,
  BrowserControl,
  WorkbenchAction,
  WorkbenchOperation,
} from "./generated/contracts";
import { executionCommand } from "./executionClient";
import { useWords } from "./workspaceClient";
import { Saved } from "./SavedContent";
import "./browser.css";
type Tab = {
  id: string;
  url: string;
  title: string;
  dialog?: { type: string; message: string } | null;
};
type Session = {
  id: string;
  channel: string;
  kind: string;
  state: string;
  version: string;
  tabs: Tab[];
  error?: string;
};
type ElementRef = {
  reference: string;
  tag: string;
  name: string;
  type: string;
  href: string;
  value: string;
};
type Page = {
  document: string | null;
  url: string;
  frames: {
    frame_id: string;
    url: string;
    title?: string;
    text?: string;
    elements?: ElementRef[];
    error?: string;
  }[];
  dialog?: { type: string; message: string } | null;
};
async function call<T>(task: string, action: WorkbenchAction): Promise<T> {
  const r = await executionCommand({ kind: "workbench", task_id: task, action });
  if (r.kind !== "workbench") throw new Error("Unexpected browser response");
  return r.data as T;
}
export function BrowserPanel({
  task,
  open,
  onOpen,
}: {
  task: string;
  open: boolean;
  onOpen: (value: boolean) => void;
}) {
  const tr = useWords();
  const [sessions, setSessions] = useState<Session[]>([]),
    [sessionId, setSessionId] = useState(""),
    [tabId, setTabId] = useState("");
  const [page, setPage] = useState<Page | null>(null),
    [image, setImage] = useState(""),
    [pair, setPair] = useState(""),
    [url, setUrl] = useState(""),
    [query, setQuery] = useState("");
  const [reference, setReference] = useState(""),
    [text, setText] = useState(""),
    [path, setPath] = useState("download.bin"),
    [operations, setOperations] = useState<WorkbenchOperation[]>([]);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const mounted = useRef(true),
    busyRef = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const session = sessions.find((s) => s.id === sessionId),
    tab = session?.tabs.find((t) => t.id === tabId);
  const control = (control: BrowserControl) =>
    call<any>(task, { kind: "browser_control", control });
  const read = async (sid = sessionId, tid = tabId) => {
    setPage(null);
    setReference("");
    setImage("");
    const value = await call<Page>(task, {
      kind: "browser",
      action: { kind: "snapshot", session_id: sid, tab_id: tid, query: query || null },
    });
    if (mounted.current) {
      setPage(value);
      setReference("");
      setImage("");
    }
  };
  const refresh = async () => {
    const [s, ops] = await Promise.all([
      control({ kind: "sessions" }),
      call<{ items: { operation: WorkbenchOperation }[] }>(task, { kind: "operations" }),
    ]);
    if (!mounted.current) return;
    setSessions(s.sessions);
    setOperations(ops.items.map((v) => v.operation).filter((v) => v.kind === "browser"));
  };
  useEffect(() => {
    if (!open) return;
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    const run = async () => {
      try {
        await refresh();
      } catch (e) {
        if (!disposed) setError(String(e));
      }
      if (!disposed) timer = setTimeout(run, 1200);
    };
    void run();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [task, open]);
  const act = async (work: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
      await refresh();
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const send = async (action: BrowserAction) => {
    await call(task, { kind: "browser", action });
  };
  const select = (sid: string, tid = "") => {
    setSessionId(sid);
    setTabId(tid);
    setPage(null);
    setImage("");
    setReference("");
  };
  const state = (value: string) =>
    ({
      connected: tr("已连接", "Connected"),
      awaiting_extension: tr("等待扩展连接", "Waiting for extension"),
      manual: tr("手动接管中", "Manual control"),
      disconnected: tr("已断开", "Disconnected"),
      awaiting_approval: tr("等待确认", "Awaiting approval"),
      queued: tr("排队", "Queued"),
      running: tr("执行中", "Running"),
      completed: tr("已完成", "Completed"),
      failed: tr("失败", "Failed"),
      cancelled: tr("已停止", "Stopped"),
      interrupted: tr("已中断", "Interrupted"),
    })[value] || value;
  const ready = !!session && session.state === "connected" && !!tab,
    canAct = ready && !!page?.document;
  const target = () => ({ session_id: sessionId, tab_id: tabId, document: page!.document! });
  return (
    <details
      id="inspector-browser"
      className="browser-panel"
      open={open}
      onToggle={(e) => onOpen(e.currentTarget.open)}
    >
      <summary>{tr("浏览器工作区", "Browser workspace")}</summary>
      <p>
        {tr(
          "先为当前任务启动专用浏览器，或连接日常浏览器中的指定标签页。网页内容不能改变任务权限。",
          "Start a dedicated browser or connect a specific tab in your daily browser. Page content cannot change task permissions.",
        )}
      </p>
      <div className="browser-actions">
        {(["chrome", "msedge"] as const).map((channel) => (
          <button
            key={channel}
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const s = await control({ kind: "start", channel });
                select(s.id, s.tabs[0]?.id || "");
                if (s.tabs[0]) await read(s.id, s.tabs[0].id);
              })
            }
          >
            {tr("启动专用 ", "Start dedicated ")}
            {channel === "chrome" ? "Chrome" : "Edge"}
          </button>
        ))}
      </div>
      <details>
        <summary>{tr("连接日常 Chrome / Edge", "Connect daily Chrome / Edge")}</summary>
        <p>
          {tr(
            "首次使用须安装 WorkPilot Browser Companion 扩展并注册本机连接程序。P00 的 Probe 扩展仍保留，此处使用新的 Companion 扩展。",
            "Install WorkPilot Browser Companion and register its native host first. The earlier P00 Probe is separate.",
          )}
        </p>
        <ol>
          <li>{tr("在下方选择浏览器，生成本任务连接码。", "Generate a code for this task.")}</li>
          <li>
            {tr(
              "在浏览器打开要操作的网页，点击 Companion 扩展，粘贴连接码并点击“连接当前标签页”。",
              "Open the desired page, click Companion, paste the code and connect the current tab.",
            )}
          </li>
          <li>
            {tr(
              "回到这里选择已连接的标签页。连接码十分钟有效，只可使用一次。",
              "Select the connected tab here. Codes expire in ten minutes and can be used once.",
            )}
          </li>
        </ol>
        <div className="browser-actions">
          {(["chrome", "msedge"] as const).map((channel) => (
            <button
              key={channel}
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const r = await control({ kind: "pair", channel });
                  setPair(r.pairing_code);
                  select(r.session.id);
                })
              }
            >
              {tr("生成 ", "Pair ")}
              {channel === "chrome" ? "Chrome" : "Edge"}
              {tr(" 连接码", "")}
            </button>
          ))}
        </div>
        {pair && (
          <label>
            {tr("只粘贴到你的 WorkPilot 扩展", "Paste only into your WorkPilot extension")}
            <textarea
              aria-label={tr(
                "只粘贴到你的 WorkPilot 扩展",
                "Paste only into your WorkPilot extension",
              )}
              readOnly
              value={pair}
              onFocus={(e) => e.target.select()}
            />
          </label>
        )}
      </details>
      <label>
        {tr("当前浏览器", "Browser session")}
        <select
          aria-label={tr("当前浏览器", "Browser session")}
          disabled={busy}
          value={sessionId}
          onChange={(e) => select(e.target.value)}
        >
          <option value="">{tr("请选择", "Select")}</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.kind === "dedicated" ? tr("专用", "Dedicated") : tr("日常", "Daily")}{" "}
              {s.channel === "chrome" ? "Chrome" : "Edge"} · {state(s.state)}
            </option>
          ))}
        </select>
      </label>
      {session && (
        <>
          <small>
            {session.version} · {state(session.state)}
          </small>
          {session.error && <p role="status">{session.error}</p>}
          <div className="browser-actions">
            <button
              disabled={
                busy || session.state === "disconnected" || session.state === "awaiting_extension"
              }
              onClick={() =>
                void act(async () => {
                  await control({
                    kind: session.state === "manual" ? "resume" : "takeover",
                    session_id: sessionId,
                  });
                  setPage(null);
                  setImage("");
                })
              }
            >
              {session.state === "manual"
                ? tr("恢复自动操作", "Resume automation")
                : tr("手动接管", "Take over")}
            </button>
            <button
              disabled={busy || session.state === "disconnected"}
              onClick={() =>
                void act(async () => {
                  await control({ kind: "disconnect", session_id: sessionId });
                  setPage(null);
                  setImage("");
                  setPair("");
                })
              }
            >
              {tr("断开连接", "Disconnect")}
            </button>
          </div>
          <label>
            {tr("已授权标签页", "Authorized tab")}
            <select
              aria-label={tr("已授权标签页", "Authorized tab")}
              disabled={busy}
              value={tabId}
              onChange={(e) => {
                setTabId(e.target.value);
                setPage(null);
                setImage("");
                setReference("");
              }}
            >
              <option value="">{tr("请选择", "Select")}</option>
              {session.tabs.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title || t.url || t.id}
                </option>
              ))}
            </select>
          </label>
          {tab && <p className="browser-url">{tab.url}</p>}
          <label>
            {tr("网页地址", "Page URL")}
            <input
              value={url}
              placeholder="https://example.com"
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <div className="browser-actions">
            <button
              disabled={busy || !canAct || !url}
              onClick={() => void act(() => send({ kind: "navigate", ...target(), url }))}
            >
              {tr("访问地址", "Navigate")}
            </button>
            <button
              disabled={busy || session.state !== "connected" || !url}
              onClick={() => void act(() => send({ kind: "new_tab", session_id: sessionId, url }))}
            >
              {tr("新标签页", "New tab")}
            </button>
            <button
              disabled={busy || !canAct}
              onClick={() => void act(() => send({ kind: "close_tab", ...target() }))}
            >
              {tr("关闭此页", "Close tab")}
            </button>
          </div>
          <label>
            {tr("查找页面元素", "Find elements")}
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tr("例如：搜索、提交、上传", "For example: Search, Submit, Upload")}
            />
          </label>
          <div className="browser-actions">
            <button disabled={busy || !ready} onClick={() => void act(() => read())}>
              {tr("读取当前页面", "Read page")}
            </button>
            <button
              disabled={busy || !canAct}
              onClick={() =>
                void act(async () => {
                  const r = await call<{ image: string }>(task, {
                    kind: "browser",
                    action: { kind: "screenshot", ...target() },
                  });
                  setImage(r.image);
                })
              }
            >
              {tr("查看截图", "Capture screenshot")}
            </button>
          </div>
          {image && (
            <img
              className="browser-image"
              src={image}
              alt={tr("当前连接标签页的截图", "Screenshot of the connected tab")}
            />
          )}
          {!!(page?.dialog || tab?.dialog) && (
            <div className="execution-notice">
              <p>{page?.dialog?.message || tab?.dialog?.message}</p>
              <div className="browser-actions">
                <button
                  disabled={busy || !canAct}
                  onClick={() =>
                    void act(() =>
                      send({ kind: "dialog", ...target(), accept: true, text: text || null }),
                    )
                  }
                >
                  {tr("确认网页弹窗", "Accept dialog")}
                </button>
                <button
                  disabled={busy || !canAct}
                  onClick={() =>
                    void act(() => send({ kind: "dialog", ...target(), accept: false, text: null }))
                  }
                >
                  {tr("取消网页弹窗", "Dismiss dialog")}
                </button>
              </div>
            </div>
          )}
          {page && (
            <>
              <label>
                {tr("选择已读取的元素", "Element from the last page read")}
                <select
                  aria-label={tr("选择已读取的元素", "Element from the last page read")}
                  disabled={busy}
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                >
                  <option value="">{tr("请选择", "Select")}</option>
                  {page.frames.flatMap((f) =>
                    (f.elements || []).map((e) => (
                      <option key={e.reference} value={e.reference}>
                        [{e.tag}] {e.name || e.type || e.reference}
                      </option>
                    )),
                  )}
                </select>
              </label>
              <label>
                {tr("要填写的内容", "Text to fill")}
                <textarea value={text} onChange={(e) => setText(e.target.value)} />
              </label>
              <div className="browser-actions">
                <button
                  disabled={busy || !canAct || !reference}
                  onClick={() => void act(() => send({ kind: "click", ...target(), reference }))}
                >
                  {tr("点击元素", "Click element")}
                </button>
                <button
                  disabled={busy || !canAct || !reference}
                  onClick={() =>
                    void act(() => send({ kind: "fill", ...target(), reference, text }))
                  }
                >
                  {tr("填写元素", "Fill element")}
                </button>
              </div>
              <details>
                <summary>{tr("上传与下载", "Upload and download")}</summary>
                <p>
                  {tr(
                    "填写相对于项目文件夹的路径。上传最多 512 KiB，下载最多 8 MiB。下载会保留文件版本并登记成果。",
                    "Use a project-relative path. Uploads: 512 KiB; downloads: 8 MiB. Downloads preserve file history and register an artifact.",
                  )}
                </p>
                <label>
                  {tr("项目文件路径", "Project file path")}
                  <input value={path} onChange={(e) => setPath(e.target.value)} />
                </label>
                <div className="browser-actions">
                  {(["upload", "download"] as const).map((kind) => (
                    <button
                      key={kind}
                      disabled={busy || !canAct || !reference || !path}
                      onClick={() =>
                        void act(async () => {
                          const f = await call<{
                            version: import("./generated/contracts").FileVersion;
                          }>(task, { kind: "read_file", path });
                          await send({ kind, ...target(), reference, path, expected: f.version });
                        })
                      }
                    >
                      {kind === "upload"
                        ? tr("上传到该字段", "Upload to field")
                        : tr("下载该链接", "Download link")}
                    </button>
                  ))}
                </div>
              </details>
              <details>
                <summary>
                  {tr("页面结构与正文（外部资料）", "Page structure and text (untrusted content)")}
                </summary>
                {page.frames.map((f) => (
                  <div key={f.frame_id}>
                    <strong>{f.title || f.url}</strong>
                    {f.error ? <p>{f.error}</p> : <pre>{f.text}</pre>}
                  </div>
                ))}
              </details>
            </>
          )}
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <h4>{tr("浏览器操作与确认", "Browser operations and approvals")}</h4>
      {operations.slice(0, 16).map((op) => (
        <article
          className="browser-operation"
          key={op.id}
          data-browser-operation={op.id}
          data-operation-state={op.state}
        >
          <strong>
            {(
              {
                read: tr("读取页面", "Read page"),
                start_dedicated: tr("启动专用浏览器", "Start dedicated browser"),
                navigate: tr("访问网页", "Navigate"),
                new_tab: tr("新标签页", "New tab"),
                close_tab: tr("关闭标签页", "Close tab"),
                click: tr("点击元素", "Click element"),
                fill: tr("填写内容", "Fill field"),
                upload: tr("上传文件", "Upload file"),
                download: tr("下载文件", "Download file"),
                dialog: tr("处理网页弹窗", "Handle dialog"),
              } as Record<string, string>
            )[op.summary.split(" · ")[0]] || tr("浏览器操作", "Browser action")}{" "}
            · {state(op.state)}
          </strong>
          <p>{op.summary.split(" · ").slice(1).join(" · ")}</p>
          <small>{new Date(op.at_ms).toLocaleTimeString()}</small>
          {op.error && <p role="status">{op.error}</p>}
          <div className="browser-actions">
            {op.state === "awaiting_approval" && (
              <button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await call(task, {
                      kind: "approve",
                      operation_id: op.id,
                      fingerprint: op.fingerprint,
                    });
                  })
                }
              >
                {tr("确认执行", "Approve operation")}
              </button>
            )}
            {["awaiting_approval", "queued", "running", "stopping"].includes(op.state) && (
              <button
                onClick={() =>
                  void act(async () => {
                    await call(task, { kind: "stop", operation_id: op.id });
                  })
                }
              >
                {tr("停止 / 拒绝", "Stop / reject")}
              </button>
            )}
          </div>
          <details>
            <summary>{tr("具体操作与完整结果", "Exact action and full result")}</summary>
            {op.input && <Saved reference={op.input} />}{" "}
            {op.output && <Saved reference={op.output} />}
          </details>
        </article>
      ))}
      <button
        disabled={busy}
        onClick={() =>
          void act(async () => {
            await executionCommand({ kind: "start_execution", task_id: task });
          })
        }
      >
        {tr("确认完成后继续 AI 任务", "Continue AI task after approval")}
      </button>
    </details>
  );
}
