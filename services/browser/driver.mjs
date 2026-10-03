import { spawn } from "node:child_process";
import { mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createServer } from "node:net";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { PageDriver, allowedUrl } from "../../extensions/companion/cdp-actions.js";
const sessions = new Map(),
  pendingPairs = new Map(),
  starting = new Set();
let configuration,
  pairingServer,
  closing = false;
const limit = 16 * 1024 * 1024;
const errorText = (e) => (e instanceof Error ? e.message : String(e));
const timeout = (p, ms = 15000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Browser operation timed out; verify the page before retrying.")),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
function owned(task, id) {
  const s = sessions.get(id);
  if (!s || s.task !== task) throw new Error("This browser session does not belong to the task.");
  if (s.disconnected) throw new Error("Browser disconnected. Connect it again explicitly.");
  return s;
}
function tab(s, id) {
  const t = s.tabs.get(id);
  if (!t || t.closed) throw new Error("The selected tab is closed or was not connected.");
  return t;
}
function active(s) {
  if (s.disconnected) throw new Error("Browser disconnected. Connect it again explicitly.");
  if (s.manual) throw new Error("Browser is under manual control. Resume automation explicitly.");
}
class PipeCdp {
  constructor(child) {
    this.child = child;
    this.next = 0;
    this.pending = new Map();
    this.listeners = new Set();
    let data = Buffer.alloc(0);
    child.stdio[4].on("data", (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.length > limit) {
        this.close(new Error("Browser protocol output exceeds limit."));
        return;
      }
      let at;
      while ((at = data.indexOf(0)) >= 0) {
        const raw = data.subarray(0, at);
        data = data.subarray(at + 1);
        try {
          const m = JSON.parse(raw);
          if (m.id) {
            const p = this.pending.get(m.id);
            if (p) {
              this.pending.delete(m.id);
              clearTimeout(p.timer);
              m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result || {});
            }
          } else for (const fn of this.listeners) fn(m);
        } catch {
          this.close(new Error("Invalid browser protocol response."));
        }
      }
    });
    child.once("exit", () => this.close(new Error("Browser exited.")));
    child.once("error", (e) => this.close(e));
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Browser command timed out; its effect may need review."));
      }, 12000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdio[3].write(
        JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0",
        (e) => {
          if (e) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(e);
          }
        },
      );
    });
  }
  close(e) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }
}
async function browserExecutable(channel) {
  const names =
    process.platform === "win32"
      ? [
          join(
            process.env.PROGRAMFILES || "C:/Program Files",
            channel === "chrome"
              ? "Google/Chrome/Application/chrome.exe"
              : "Microsoft/Edge/Application/msedge.exe",
          ),
          join(
            process.env["PROGRAMFILES(X86)"] || "C:/Program Files (x86)",
            channel === "chrome"
              ? "Google/Chrome/Application/chrome.exe"
              : "Microsoft/Edge/Application/msedge.exe",
          ),
          join(
            process.env.LOCALAPPDATA || "",
            channel === "chrome"
              ? "Google/Chrome/Application/chrome.exe"
              : "Microsoft/Edge/Application/msedge.exe",
          ),
        ]
      : process.platform === "darwin"
        ? [
            channel === "chrome"
              ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
              : "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          ]
        : channel === "chrome"
          ? ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
          : ["/usr/bin/microsoft-edge"];
  for (const p of names)
    try {
      await access(p);
      return p;
    } catch {}
  throw new Error("The selected browser is not installed. Browser packaging is completed in P12.");
}
async function attachDedicated(s, targetId) {
  if (s.targets.has(targetId)) return s.targets.get(targetId);
  active(s);
  if ([...s.tabs.values()].filter((t) => !t.closed).length >= 32)
    throw new Error("A browser session can control at most 32 tabs.");
  const { sessionId } = await s.cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const id = randomUUID();
  const driver = new PageDriver((m, p, child) => s.cdp.send(m, p, child || sessionId), id);
  const t = { id, targetId, sessionId, driver, closed: false, title: "", url: "about:blank" };
  s.targets.set(targetId, t);
  s.tabs.set(id, t);
  await driver.initialize();
  return t;
}
function reserve(task, channel, ancestors, kind) {
  if (!["chrome", "msedge"].includes(channel)) throw new Error("Unsupported browser.");
  if (closing) throw new Error("Browser worker is shutting down.");
  for (const [id, s] of sessions) {
    if (s.pending && s.expires < Date.now()) {
      s.disconnected = true;
      s.pending = false;
      pendingPairs.delete(s.token);
    }
    if (s.disconnected) sessions.delete(id);
  }
  if (sessions.size + starting.size >= 16)
    throw new Error("At most 16 browser sessions may be connected.");
  for (const s of sessions.values())
    if (kind === "dedicated" && s.task === task && s.kind === "dedicated" && !s.disconnected)
      throw new Error("This task already has a dedicated browser.");
  for (const r of starting)
    if (r.task === task && r.kind === kind)
      throw new Error("This browser connection is already starting.");
  const ticket = { task, ancestors, kind, cancelled: false };
  starting.add(ticket);
  return ticket;
}
function stillStarting(ticket) {
  if (ticket.cancelled || closing) throw new Error("Browser connection was cancelled.");
}
async function startSession(task, channel, ancestors) {
  const ticket = reserve(task, channel, ancestors, "dedicated");
  let s;
  try {
    const profile = join(configuration.data, "browser-profiles", task, channel);
    await mkdir(profile, { recursive: true });
    const executable = await browserExecutable(channel);
    stillStarting(ticket);
    const child = spawn(
      executable,
      [
        "--remote-debugging-pipe",
        "--user-data-dir=" + profile,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        ...(configuration.headless ? ["--headless=new"] : []),
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: true },
    );
    s = {
      id: randomUUID(),
      task,
      ancestors,
      kind: "dedicated",
      channel,
      child,
      cdp: new PipeCdp(child),
      tabs: new Map(),
      targets: new Map(),
      manual: false,
      disconnected: false,
      queue: Promise.resolve(),
    };
    sessions.set(s.id, s);
    child.once("exit", () => {
      s.disconnected = true;
      for (const t of s.tabs.values()) t.closed = true;
    });
    s.cdp.listeners.add((m) => {
      if (m.method === "Target.targetDestroyed") {
        const t = s.targets.get(m.params.targetId);
        if (t) {
          t.closed = true;
          t.driver.closed = true;
          s.tabs.delete(t.id);
          s.targets.delete(m.params.targetId);
        }
      }
      if (m.method === "Target.targetInfoChanged") {
        const t = s.targets.get(m.params.targetInfo.targetId);
        if (t) {
          t.title = m.params.targetInfo.title;
          t.url = m.params.targetInfo.url;
        }
      }
      if (
        m.method === "Target.targetCreated" &&
        !s.manual &&
        !s.disconnected &&
        m.params.targetInfo.type === "page" &&
        s.targets.has(m.params.targetInfo.openerId)
      )
        void attachDedicated(s, m.params.targetInfo.targetId).catch(() => {});
      for (const t of s.tabs.values())
        if (m.sessionId === t.sessionId || t.driver.children.has(m.sessionId))
          void t.driver
            .event(m.method, m.params, m.sessionId === t.sessionId ? undefined : m.sessionId)
            .catch(() => {});
    });
    await s.cdp.send("Target.setDiscoverTargets", { discover: true });
    // Downloads are retrieved explicitly into project history, never a browser default folder.
    await s.cdp.send("Browser.setDownloadBehavior", { behavior: "deny" });
    const version = await s.cdp.send("Browser.getVersion");
    s.version = version.product;
    const { targetInfos } = await s.cdp.send("Target.getTargets");
    for (const t of targetInfos.filter((t) => t.type === "page"))
      await attachDedicated(s, t.targetId);
    stillStarting(ticket);
    return view(s);
  } catch (e) {
    if (s) await disconnect(s);
    throw e;
  } finally {
    starting.delete(ticket);
  }
}
function view(s) {
  if (s.pending && s.expires < Date.now()) {
    s.pending = false;
    s.disconnected = true;
    s.error = "Pairing code expired. Generate a new code.";
    pendingPairs.delete(s.token);
  }
  return {
    id: s.id,
    task_id: s.task,
    channel: s.channel,
    kind: s.kind,
    version: s.version || "",
    owned_pid: s.kind === "dedicated" ? s.child.pid : null,
    state: s.disconnected
      ? "disconnected"
      : s.pending
        ? "awaiting_extension"
        : s.manual
          ? "manual"
          : "connected",
    tabs: [...s.tabs.values()]
      .filter((t) => !t.closed)
      .map((t) => ({
        id: t.id,
        title: t.title || "",
        url: t.driver?.url || t.url || "",
        dialog: t.driver?.dialog || t.dialog || null,
      })),
    error: s.error || null,
  };
}
async function disconnect(s) {
  if (s.disconnecting) return s.disconnecting;
  s.disconnecting = disconnectNow(s);
  return s.disconnecting;
}
async function disconnectNow(s) {
  s.disconnected = true;
  s.pending = false;
  for (const t of s.tabs.values()) {
    t.closed = true;
    if (t.driver) t.driver.closed = true;
  }
  if (s.kind === "dedicated") {
    const exited = s.child.exitCode === null ? once(s.child, "exit") : Promise.resolve();
    await timeout(s.cdp.send("Browser.close"), 3000).catch(() => {});
    await timeout(exited, 3000).catch(() => s.child.kill());
  } else if (s.peer) {
    try {
      await timeout(s.peer.request({ kind: "disconnect" }), 2000);
    } catch {}
    s.peer.socket.destroy();
  }
  for (const [code, pair] of pendingPairs) if (pair === s) pendingPairs.delete(code);
}
async function pairing() {
  if (pairingServer) return pairingServer.address().port;
  pairingServer = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.setTimeout(10000, () => socket.destroy());
    let buffer = "",
      s = null,
      next = 0;
    const requests = new Map();
    const peer = {
      socket,
      request: (action) =>
        new Promise((resolve, reject) => {
          const id = "host-" + ++next;
          const timer = setTimeout(() => {
            requests.delete(id);
            reject(new Error("Connected browser did not answer."));
          }, 15000);
          requests.set(id, { resolve, reject, timer });
          socket.write(JSON.stringify({ id, action }) + "\n");
        }),
    };
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > limit) {
        socket.destroy();
        return;
      }
      let n;
      while ((n = buffer.indexOf("\n")) >= 0) {
        const raw = buffer.slice(0, n);
        buffer = buffer.slice(n + 1);
        let m;
        try {
          m = JSON.parse(raw);
        } catch {
          socket.destroy();
          return;
        }
        if (!s) {
          const code = typeof m.token === "string" ? m.token : "";
          const candidate = pendingPairs.get(code);
          if (
            !candidate ||
            candidate.expires < Date.now() ||
            candidate.channel !== m.channel ||
            !timingSafeEqual(Buffer.from(candidate.token), Buffer.from(code))
          ) {
            socket.end(JSON.stringify({ error: "Invalid or expired pairing code." }) + "\n");
            return;
          }
          pendingPairs.delete(code);
          s = candidate;
          s.pending = false;
          s.peer = peer;
          s.version = String(m.version || "").slice(0, 256);
          socket.setTimeout(0);
          socket.write(JSON.stringify({ paired: true, session_id: s.id }) + "\n");
        } else if (m.id) {
          const p = requests.get(m.id);
          if (p) {
            clearTimeout(p.timer);
            requests.delete(m.id);
            m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
          }
        } else if (m.kind === "tabs") {
          s.tabs.clear();
          for (const t of (m.tabs || []).slice(0, 32))
            s.tabs.set(String(t.id), {
              id: String(t.id),
              title: String(t.title || "").slice(0, 500),
              url: String(t.url || ""),
              dialog: t.dialog || null,
              closed: false,
            });
        }
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (s) {
        s.disconnected = true;
        s.error = "Browser extension disconnected. Reconnect explicitly.";
      }
      for (const p of requests.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("Browser connection lost; no action will be replayed."));
      }
      requests.clear();
    });
  });
  await new Promise((resolve, reject) => {
    pairingServer.once("error", reject);
    pairingServer.listen(0, "127.0.0.1", resolve);
  });
  return pairingServer.address().port;
}
async function pairSession(task, channel, ancestors) {
  const ticket = reserve(task, channel, ancestors, "connected");
  try {
    const port = await pairing();
    stillStarting(ticket);
    const token = port + "-" + randomBytes(24).toString("hex");
    const s = {
      id: randomUUID(),
      task,
      channel,
      ancestors,
      kind: "connected",
      pending: true,
      manual: false,
      disconnected: false,
      tabs: new Map(),
      token,
      expires: Date.now() + 600000,
      queue: Promise.resolve(),
    };
    sessions.set(s.id, s);
    pendingPairs.set(token, s);
    return { session: view(s), pairing_code: token, expires_at: s.expires };
  } finally {
    starting.delete(ticket);
  }
}
async function perform(s, action, validate = false) {
  active(s);
  if (s.kind === "connected") {
    if (!s.peer) throw new Error("Connect the browser extension first.");
    if (action.tab_id) tab(s, action.tab_id);
    return s.peer.request({ kind: validate ? "validate" : "perform", action });
  }
  if (action.kind === "tabs") return view(s);
  if (action.kind === "new_tab") {
    if ([...s.tabs.values()].filter((t) => !t.closed).length >= 32)
      throw new Error("A browser session can control at most 32 tabs.");
    const url = allowedUrl(action.url);
    if (validate) return { url, session: s.id };
    const r = await s.cdp.send("Target.createTarget", { url });
    const t = await attachDedicated(s, r.targetId);
    return { tab_id: t.id, url };
  }
  const t = tab(s, action.tab_id);
  if (validate) return t.driver.guard(action);
  if (action.kind === "close_tab") {
    await t.driver.guard(action);
    await s.cdp.send("Target.closeTarget", { targetId: t.targetId });
    t.closed = true;
    s.tabs.delete(t.id);
    s.targets.delete(t.targetId);
    return { closed: true };
  }
  return t.driver.perform(action);
}
async function handle(m) {
  if (m.kind === "init") {
    if (configuration) throw new Error("Already initialized.");
    configuration = m;
    return { ready: true };
  }
  if (!configuration) throw new Error("Browser driver is not initialized.");
  if (m.kind === "shutdown") {
    closing = true;
    for (const r of starting) r.cancelled = true;
    await Promise.allSettled([...sessions.values()].filter((s) => !s.disconnected).map(disconnect));
    pairingServer?.close();
    return { closed: true };
  }
  if (m.kind === "cancel_task" || m.kind === "cancel_all") {
    const matches = (s) =>
      m.kind === "cancel_all" || s.task === m.task || s.ancestors.includes(m.task);
    for (const r of starting) if (matches(r)) r.cancelled = true;
    await Promise.allSettled(
      [...sessions.values()].filter((s) => !s.disconnected && matches(s)).map(disconnect),
    );
    return { stopped: true };
  }
  if (closing) throw new Error("Browser worker is shutting down.");
  if (m.kind === "control") {
    const c = m.control;
    if (c.kind === "sessions")
      return { sessions: [...sessions.values()].filter((s) => s.task === m.task).map(view) };
    if (c.kind === "start") return startSession(m.task, c.channel, m.ancestors || []);
    if (c.kind === "pair") return pairSession(m.task, c.channel, m.ancestors || []);
    const s = owned(m.task, c.session_id);
    if (c.kind === "disconnect") {
      await disconnect(s);
      return view(s);
    }
    if (c.kind === "takeover") {
      s.manual = true;
      if (s.kind === "dedicated") {
        const t = [...s.tabs.values()].find((t) => !t.closed);
        if (t) await s.cdp.send("Page.bringToFront", {}, t.sessionId);
      } else await s.peer.request({ kind: "takeover" });
      return view(s);
    }
    if (c.kind === "resume") {
      if (s.kind === "connected") await s.peer.request({ kind: "resume" });
      for (const t of s.tabs.values())
        if (t.driver) {
          t.driver.document = null;
          t.driver.snapshots.clear();
        }
      s.manual = false;
      return view(s);
    }
    throw new Error("Unknown browser control.");
  }
  if (m.action.kind === "start_dedicated") {
    if (!["chrome", "msedge"].includes(m.action.channel))
      throw new Error("Unsupported browser channel.");
    if (m.kind === "validate") return { channel: m.action.channel, task: m.task };
    return startSession(m.task, m.action.channel, m.ancestors || []);
  }
  const s = owned(m.task, m.action.session_id);
  if (m.action.kind === "tabs")
    return s.kind === "connected"
      ? { ...view(s), ...(await s.peer.request({ kind: "tabs" })) }
      : view(s);
  const work = () => perform(s, m.action, m.kind === "validate");
  const result = s.queue.then(work, work);
  s.queue = result.catch(() => {});
  return result;
}
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line.length > limit) {
    process.exitCode = 1;
    lines.close();
    return;
  }
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  void handle(m)
    .then(
      (result) => process.stdout.write(JSON.stringify({ id: m.id, result }) + "\n"),
      (e) => process.stdout.write(JSON.stringify({ id: m.id, error: errorText(e) }) + "\n"),
    )
    .then(() => {
      if (m.kind === "shutdown") process.exit(0);
    });
});
lines.on("close", () => {
  if (!closing) void handle({ kind: "shutdown" }).finally(() => process.exit(0));
});
