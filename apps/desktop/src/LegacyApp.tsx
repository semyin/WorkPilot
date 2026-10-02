import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import icon from "../../../assets/icons/png/128.png";
import { zh, en } from "./i18n";
import { ModelSettings } from "./ModelSettings";
import { TaskWorkspace } from "./TaskWorkspace";
import type {
  Event as EngineEvent,
  Snapshot,
  Command,
  Response,
  Task,
  EventPage,
} from "./generated/contracts";
const native = isTauri();
export function LegacyApp() {
  const [language, setLanguage] = useState(
    localStorage.getItem("workpilot.language") === "en" ? "en" : "zh",
  );
  const t = language === "en" ? en : zh;
  const [connected, setConnected] = useState(false);
  const [restoring, setRestoring] = useState(native);
  const [events, setEvents] = useState<EngineEvent[]>([]);
  const [status, setStatus] = useState<
    "idle" | "running" | "stopping" | "completed" | "interrupted"
  >("idle");
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [error, setError] = useState("");
  const [gap, setGap] = useState(false);
  const [tab, setTab] = useState("file");
  const [webOpen, setWebOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [history, setHistory] = useState<EventPage | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const historyGeneration = useRef(0);
  const sequence = useRef(0);
  const preview = useRef<HTMLDivElement>(null);
  const previewActions = useRef<Promise<void>>(Promise.resolve());
  const busy = status === "running" || status === "stopping";
  useEffect(() => {
    document.documentElement.lang = language === "en" ? "en" : "zh-CN";
    localStorage.setItem("workpilot.language", language);
  }, [language]);
  useEffect(() => {
    if (!native) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let delay = 100;
      try {
        const snapshot = await invoke<Snapshot>("engine_snapshot", { after: sequence.current });
        if (cancelled) return;
        setConnected(snapshot.alive);
        if (snapshot.error) setError(snapshot.error);
        if (snapshot.history_truncated) setGap(true);
        sequence.current = snapshot.next_after;
        if (snapshot.has_more) delay = 0;
        else setRestoring(false);
        if (snapshot.events.length) {
          const batch = snapshot.events;
          setEvents((previous) => [...previous, ...batch].slice(-200));
          for (const event of batch) {
            if (event.kind === "probe_started") {
              setStatus("running");
              setProgress({ current: 0, total: 0 });
            }
            if (event.kind === "progress")
              setProgress({ current: event.current!, total: event.total! });
            if (event.kind === "probe_ended")
              setStatus(event.reason === "completed" ? "completed" : "interrupted");
            if (event.kind === "error") {
              setError(event.message || t.error);
              setStatus("interrupted");
            }
            if (event.kind === "task_state_changed" && event.state === "interrupted")
              setStatus("interrupted");
          }
        }
        if (!snapshot.alive)
          setStatus((state) =>
            state === "running" || state === "stopping" ? "interrupted" : state,
          );
      } catch (error) {
        if (!cancelled) {
          setError(String(error));
          setConnected(false);
          setRestoring(false);
        }
      }
      if (!cancelled) timer = setTimeout(poll, delay);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [t.error]);
  useEffect(() => {
    if (!native) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const result = await invoke<Response>("engine_command", {
          request: {
            request_id: crypto.randomUUID(),
            command: { kind: "read", query: { kind: "tasks", before: null, limit: 64 } },
          },
        });
        if (!cancelled && result.kind === "tasks")
          setTasks(result.page.tasks.sort((a, b) => b.updated_at_ms - a.updated_at_ms));
      } catch {
        /* Connection errors are displayed by the event poll. */
      }
      if (!cancelled) timer = setTimeout(refresh, 1000);
    };
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);
  const loadHistory = async (task: Task, after = 0) => {
    const generation = ++historyGeneration.current;
    setSelectedTask(task);
    setTab("history");
    setHistoryLoading(true);
    try {
      const response = await invoke<Response>("engine_command", {
        request: {
          request_id: crypto.randomUUID(),
          command: { kind: "read", query: { kind: "events", task_id: task.id, after, limit: 128 } },
        },
      });
      if (generation !== historyGeneration.current) return;
      if (response.kind === "events") setHistory(response.page);
      else if (response.kind === "error") setError(response.message);
    } catch (error) {
      if (generation === historyGeneration.current) setError(String(error));
    } finally {
      if (generation === historyGeneration.current) setHistoryLoading(false);
    }
  };
  useEffect(() => {
    if (!native || !webOpen || tab !== "web" || !preview.current) return;
    let disposed = false;
    let inFlight = false;
    let resizePending = false;
    const update = () => {
      if (disposed || !preview.current) return;
      if (inFlight) {
        resizePending = true;
        return;
      }
      inFlight = true;
      resizePending = false;
      previewActions.current = previewActions.current
        .catch(() => {})
        .then(async () => {
          if (disposed || !preview.current) return;
          const { x, y, width, height } = preview.current.getBoundingClientRect();
          await invoke<void>("preview_open", { x, y, width, height });
        })
        .catch((error) => {
          if (!disposed) setError(String(error));
        });
      void previewActions.current.finally(() => {
        inFlight = false;
        if (resizePending && !disposed) update();
      });
    };
    const observer = new ResizeObserver(() => {
      void update();
    });
    observer.observe(preview.current);
    void update();
    return () => {
      disposed = true;
      observer.disconnect();
      previewActions.current = previewActions.current
        .catch(() => {})
        .then(() => invoke<void>("preview_close"))
        .catch((error) => setError(String(error)));
    };
  }, [webOpen, tab]);
  const send = async (command: Command) => {
    setError("");
    try {
      const response = await invoke<Response>("engine_command", {
        request: { request_id: crypto.randomUUID(), command },
      });
      if (response.kind === "error") throw new Error(response.message);
    } catch (error) {
      setError(String(error));
      setStatus("interrupted");
    }
  };
  const start = (long = false) => {
    setStatus("running");
    void send({ kind: "start_probe", ticks: long ? 10_000 : 50, interval_ms: long ? 1 : 100 });
  };
  const windowAction = async (command: string) => {
    try {
      await invoke(command);
    } catch (error) {
      setError(String(error));
    }
  };
  const fileHtml =
    "<!doctype html><html lang='" +
    language +
    "'><head><meta charset='utf-8'><style>body{font:15px/1.8 system-ui,sans-serif;color:#424855;padding:28px;margin:0}h1{font-size:25px;color:#202530;line-height:1.35}small{color:#8a909d}hr{border:0;border-top:1px solid #e9ebef;margin:24px 0}</style></head><body><small>WORKPILOT / LOCAL PREVIEW</small><h1>" +
    t.fileTitle +
    "</h1><hr><p>" +
    t.fileBody +
    "</p></body></html>";
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img src={icon} alt="" />
          <strong>WorkPilot</strong>
          <span>α</span>
        </div>
        <p className="eyebrow">{t.workspace}</p>
        <div className="project">
          <span className="folder-mark">▱</span>
          <span>{t.project}</span>
        </div>
        <div className="phase">
          <span className="phase-dot" />
          {t.phase}
        </div>
        <div className="saved-tasks">
          <p className="eyebrow">{t.savedTasks}</p>
          {tasks.length === 0 && <small>{t.noSavedTasks}</small>}
          {tasks.slice(0, 12).map((task) => (
            <button
              key={task.id}
              onClick={() => void loadHistory(task)}
              data-task-id={task.id}
              data-task-state={task.state}
            >
              <span>{task.title === "P01 persistence probe" ? t.probeTask : task.title}</span>
              <small>{t.taskState[task.state]}</small>
            </button>
          ))}
          {tasks.length > 12 && <small>{t.recentTasks}</small>}
        </div>
        <div className="sidebar-bottom">
          <button
            disabled={!connected}
            onClick={() => {
              setWebOpen(false);
              setTasksOpen(true);
            }}
          >
            {t.execution}
          </button>
          <button
            disabled={!connected}
            onClick={() => {
              setWebOpen(false);
              setModelsOpen(true);
            }}
          >
            {t.models}
          </button>
          <div className={"connection " + (connected ? "online" : "")}>
            <i />
            {connected ? t.ready : t.disconnected}
          </div>
          <button className="language" onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>
            {t.switchLanguage}
          </button>
          <small>{t.version}</small>
        </div>
      </aside>
      <main className="main">
        <header>
          <span>{t.phase}</span>
          <span className="tag">LOCAL</span>
        </header>
        <section className="welcome">
          <div className="welcome-mark">
            W<span>↗</span>
          </div>
          <h1>{t.welcome}</h1>
          <p>{t.subtitle}</p>
          <p className="scope">{native ? t.scope : t.noNative}</p>
          <div className="actions">
            <button
              className="primary"
              disabled={!connected || busy || restoring}
              onClick={() => start()}
            >
              ▶ &nbsp;{t.start}
            </button>
            <button disabled={!connected || busy || restoring} onClick={() => start(true)}>
              {t.long}
            </button>
            <button
              className="stop"
              disabled={!connected || !busy || restoring}
              onClick={() => {
                setStatus("stopping");
                void send({ kind: "stop" });
              }}
            >
              ■ &nbsp;{status === "stopping" ? t.stopping : t.stop}
            </button>
          </div>
        </section>
        {error && (
          <div className="error" role="alert">
            {t.error}：{error}
          </div>
        )}
        <section className="activity">
          <div className="section-heading">
            <h2>{t.console}</h2>
            <span className={"status " + (restoring ? "idle" : status)}>
              {restoring ? t.restoring : t[status]}
            </span>
          </div>
          <div className="metrics">
            <span>
              {t.progress}
              <strong data-testid="progress">
                {restoring ? "—" : progress.current + " / " + progress.total}
              </strong>
            </span>
            <span>
              {t.events}
              <strong data-testid="event-count">{sequence.current}</strong>
            </span>
          </div>
          <div className="progress-track">
            <div
              style={{
                width: (progress.total ? (progress.current / progress.total) * 100 : 0) + "%",
              }}
            />
          </div>
          <div className="event-list" aria-label={t.console}>
            {events.length === 0 && <div className="empty">{t.empty}</div>}
            {events
              .slice()
              .reverse()
              .map((event) => (
                <div
                  className="event"
                  key={event.sequence}
                  data-sequence={event.sequence}
                  data-at-ms={event.at_ms}
                >
                  <span className="event-id">{String(event.sequence).padStart(3, "0")}</span>
                  <span>
                    {t.event[event.kind]}
                    {event.kind === "progress" ? " · " + event.current + " / " + event.total : ""}
                  </span>
                  <time>
                    {new Date(event.at_ms).toLocaleTimeString(
                      language === "zh" ? "zh-CN" : "en-GB",
                      { hour12: false },
                    )}
                  </time>
                </div>
              ))}
          </div>
          <small className="log-note">{gap ? t.hiddenGap : t.latest}</small>
        </section>
        <footer>
          <span>{t.footer}</span>
          <button
            disabled={!native}
            onClick={() => {
              void windowAction("hide_window");
            }}
          >
            {t.hide}
          </button>
          <button
            disabled={!native}
            onClick={() => {
              void windowAction("exit_app");
            }}
          >
            {t.quit}
          </button>
        </footer>
      </main>
      <aside className="preview-panel">
        <div className="preview-header">
          <strong>{t.preview}</strong>
          <span>↗</span>
        </div>
        <div className="tabs">
          <button className={tab === "file" ? "selected" : ""} onClick={() => setTab("file")}>
            {t.file}
          </button>
          <button className={tab === "web" ? "selected" : ""} onClick={() => setTab("web")}>
            {t.web}
          </button>
          <button className={tab === "history" ? "selected" : ""} onClick={() => setTab("history")}>
            {t.history}
          </button>
        </div>
        <div className="file-bar">
          {tab === "file"
            ? "▤  " + t.fileName
            : tab === "web"
              ? "◎  " + t.webUrl
              : t.persistedHistory}
        </div>
        {tab === "file" ? (
          <iframe title={t.fileTitle} sandbox="" srcDoc={fileHtml} />
        ) : tab === "history" ? (
          <section className="history-panel">
            <p>
              {selectedTask
                ? selectedTask.title === "P01 persistence probe"
                  ? t.probeTask
                  : selectedTask.title
                : t.selectTask}
            </p>
            {selectedTask && (
              <button disabled={historyLoading} onClick={() => void loadHistory(selectedTask)}>
                {t.firstPage}
              </button>
            )}
            <div data-testid="saved-history">
              {!historyLoading &&
                history?.events.map((event) => (
                  <details key={event.sequence}>
                    <summary>
                      #{event.task_sequence} · {t.event[event.kind]}
                    </summary>
                    <pre>{JSON.stringify(event, null, 2)}</pre>
                  </details>
                ))}
            </div>
            {selectedTask && history?.has_more && (
              <button
                disabled={historyLoading}
                onClick={() => void loadHistory(selectedTask, history.next_after)}
              >
                {t.nextPage}
              </button>
            )}
            <small>{t.historyScope}</small>
          </section>
        ) : (
          <div className="browser-slot" ref={preview}>
            {!webOpen && (
              <div className="browser-empty">
                <span>◎</span>
                <p>{t.webHint}</p>
                <button disabled={!native} onClick={() => setWebOpen(true)}>
                  {t.openWeb}
                </button>
              </div>
            )}
          </div>
        )}
      </aside>
      {modelsOpen && <ModelSettings language={language} onClose={() => setModelsOpen(false)} />}
      {tasksOpen && (
        <TaskWorkspace
          language={language}
          onClose={() => setTasksOpen(false)}
          onModels={() => {
            setTasksOpen(false);
            setModelsOpen(true);
          }}
        />
      )}
    </div>
  );
}
