import { PageDriver, allowedUrl } from "./cdp-actions.js";
let port,
  paired = false,
  manual = false,
  state = "disconnected",
  lastError = "";
const tabs = new Map();
let pendingPair;
async function sendTabs() {
  if (port && paired)
    port.postMessage({
      kind: "tabs",
      tabs: [...tabs.values()].map((t) => ({
        id: String(t.id),
        url: t.driver.url,
        title: t.title || "",
        dialog: t.driver.dialog,
      })),
    });
}
async function attach(tabId) {
  if (tabs.has(tabId)) return tabs.get(tabId);
  if (tabs.size >= 32) throw new Error("A browser session can control at most 32 tabs.");
  await chrome.debugger.attach({ tabId }, "1.3");
  const driver = new PageDriver(
    (method, params, sessionId) =>
      chrome.debugger.sendCommand({ tabId, ...(sessionId ? { sessionId } : {}) }, method, params),
    String(tabId),
  );
  const item = { id: tabId, driver };
  tabs.set(tabId, item);
  try {
    await driver.initialize();
  } catch (e) {
    tabs.delete(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
    throw e;
  }
  await sendTabs();
  return item;
}
async function disconnect(error = "") {
  const connected = port;
  port = null;
  paired = false;
  manual = false;
  state = "disconnected";
  lastError = error;
  pendingPair?.reject(new Error(error || "Disconnected"));
  pendingPair = null;
  const ids = [...tabs.keys()];
  tabs.clear();
  await Promise.allSettled(ids.map((tabId) => chrome.debugger.detach({ tabId })));
  connected?.disconnect();
}
chrome.debugger.onEvent.addListener((source, method, params) => {
  const t = tabs.get(source.tabId);
  if (!t) return;
  void t.driver
    .event(method, params, source.sessionId)
    .then(() => sendTabs())
    .catch(() => {});
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (manual) return;
  if (tabs.has(source.tabId)) {
    tabs.get(source.tabId).driver.closed = true;
    tabs.delete(source.tabId);
    void sendTabs();
    if (!tabs.size) void disconnect("Tab control was revoked: " + reason);
  }
});
chrome.tabs.onRemoved.addListener((id) => {
  if (tabs.has(id)) {
    tabs.delete(id);
    void sendTabs();
  }
});
chrome.tabs.onCreated.addListener((t) => {
  if (paired && !manual && tabs.has(t.openerTabId)) void attach(t.id).catch(() => {});
});
async function command(message) {
  if (message.kind === "disconnect") {
    await disconnect();
    return { disconnected: true };
  }
  if (!paired) throw new Error("Browser is not paired.");
  if (message.kind === "tabs")
    return {
      tabs: [...tabs.values()].map((t) => ({
        id: String(t.id),
        url: t.driver.url,
        title: t.title || "",
        dialog: t.driver.dialog,
      })),
    };
  if (message.kind === "takeover") {
    manual = true;
    state = "manual";
    await Promise.allSettled([...tabs.keys()].map((tabId) => chrome.debugger.detach({ tabId })));
    return { manual: true };
  }
  if (message.kind === "resume") {
    const ids = [...tabs.keys()];
    tabs.clear();
    for (const id of ids) await attach(id);
    manual = false;
    state = "connected";
    return { resumed: true };
  }
  if (manual) throw new Error("Browser is under manual control.");
  const a = message.action;
  if (a.kind === "new_tab") {
    if (tabs.size >= 32) throw new Error("A browser session can control at most 32 tabs.");
    const url = allowedUrl(a.url);
    if (message.kind === "validate") return { url };
    const created = await chrome.tabs.create({ url, active: false });
    await attach(created.id);
    return { tab_id: String(created.id), url };
  }
  const t = tabs.get(Number(a.tab_id));
  if (!t) throw new Error("Tab was not explicitly connected to this task.");
  if (message.kind === "validate") return t.driver.guard(a);
  if (a.kind === "close_tab") {
    await t.driver.guard(a);
    await chrome.tabs.remove(t.id);
    tabs.delete(t.id);
    return { closed: true };
  }
  const r = await t.driver.perform(a);
  if (a.kind === "snapshot") {
    t.title = r.frames.find((f) => f.title)?.title || "";
    await sendTabs();
  }
  return r;
}
async function connect(code, tabId) {
  if (!/^\d{1,5}-[a-f0-9]{48}$/.test(code))
    throw new Error("请粘贴 WorkPilot 当前任务提供的完整连接码。");
  const selected = await chrome.tabs.get(tabId);
  const details = selected.url
    ? selected
    : (await chrome.debugger.getTargets()).find((t) => t.tabId === tabId);
  if (!details?.url) throw new Error("当前标签页地址不可用，请先打开要连接的 HTTP(S) 网页。");
  allowedUrl(details.url);
  await disconnect();
  lastError = "";
  state = "connecting";
  port = chrome.runtime.connectNative("com.workpilot.browser_companion");
  const native = port;
  const ready = new Promise((resolve, reject) => {
    const attempt = { resolve, reject };
    pendingPair = attempt;
    setTimeout(() => {
      if (pendingPair === attempt) {
        pendingPair = null;
        reject(new Error("连接超时，请确认 WorkPilot 正在运行。"));
      }
    }, 10000);
  });
  native.onDisconnect.addListener(() => {
    if (port === native) void disconnect(chrome.runtime.lastError?.message || "WorkPilot 已断开。");
  });
  native.onMessage.addListener((m) => {
    if (port !== native) return;
    if (m.paired) {
      paired = true;
      state = "connected";
      pendingPair?.resolve();
      pendingPair = null;
      return;
    }
    if (m.error && !m.id) {
      pendingPair?.reject(new Error(m.error));
      pendingPair = null;
      return;
    }
    if (m.id && m.action)
      void command(m.action).then(
        (result) => {
          if (port === native) native.postMessage({ id: m.id, result });
        },
        (e) => {
          if (port === native) native.postMessage({ id: m.id, error: String(e.message || e) });
        },
      );
  });
  native.postMessage({
    kind: "pair",
    token: code,
    channel: navigator.userAgent.includes("Edg/") ? "msedge" : "chrome",
    version: navigator.userAgent,
  });
  await ready;
  await attach(tabId);
  return { state, tab_id: tabId };
}
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html"))
    return false;
  if (m.kind === "status") {
    reply({
      state,
      error: lastError,
      tabs: [...tabs.values()].map((t) => ({ id: t.id, url: t.driver.url })),
    });
    return false;
  }
  const work =
    m.kind === "connect"
      ? connect(m.code, m.tab_id)
      : m.kind === "disconnect"
        ? disconnect().then(() => ({ state: "disconnected" }))
        : Promise.reject(new Error("Unknown action"));
  work.then(reply).catch(async (e) => {
    await disconnect(String(e.message || e));
    reply({ state: "error", error: lastError });
  });
  return true;
});
