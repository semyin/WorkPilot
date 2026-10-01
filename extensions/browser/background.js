import { requireFixtureTab } from "./fixture-tab.js";

let port;
let attached;
let lastResult = { state: "disconnected" };
const pending = new Map();
let probing = false;
function nativeRequest(kind) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Native host response timed out"));
    }, 5000);
    pending.set(id, { resolve, reject, timeout });
    port.postMessage({ id, kind });
  });
}
async function disconnect() {
  for (const request of pending.values()) {
    clearTimeout(request.timeout);
    request.reject(new Error("连接已断开。"));
  }
  pending.clear();
  if (attached !== undefined) {
    const tabId = attached;
    attached = undefined;
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
  if (port) {
    const old = port;
    port = undefined;
    old.disconnect();
  }
}
async function probe(tabId) {
  const tab = await chrome.tabs.get(tabId);
  requireFixtureTab(tab);
  await disconnect();
  port = chrome.runtime.connectNative("com.workpilot.browser_probe");
  port.onMessage.addListener((message) => {
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timeout);
    pending.delete(message.id);
    request.resolve(message);
  });
  const connectedPort = port;
  port.onDisconnect.addListener(() => {
    if (port !== connectedPort) return;
    const error = chrome.runtime.lastError?.message || "Native host disconnected";
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error(error));
    }
    pending.clear();
    void disconnect();
  });
  const hello = await nativeRequest("hello");
  if (hello.protocol !== "workpilot.browser-probe.v1")
    throw new Error("Native host protocol mismatch");
  const instruction = await nativeRequest("probe");
  if (instruction.action !== "fill_click_read") throw new Error("Unsupported native action");
  await chrome.debugger.attach({ tabId }, "1.3");
  attached = tabId;
  const result = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    expression:
      "(() => { if (location.hostname !== '127.0.0.1' || location.pathname !== '/page' || document.title !== 'WorkPilot Browser Fixture') throw new Error('Fixture navigated away'); const input = document.querySelector('#name'); input.value = 'WorkPilot'; input.dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('#greet').click(); return {title:document.title,text:document.querySelector('#result').textContent}; })()",
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error("Fixture evaluation failed");
  await nativeRequest("result");
  lastResult = {
    state: "passed",
    browser: navigator.userAgent,
    nativeHostPid: hello.pid,
    result: result.result.value,
  };
  await disconnect();
  return lastResult;
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html"))
    return false;
  if (message.kind === "status") {
    sendResponse(lastResult);
    return false;
  }
  if (message.kind === "probe" && probing) {
    sendResponse({ state: "error", error: "验证正在进行，请等待完成或点击断开连接。" });
    return false;
  }
  if (message.kind === "probe") probing = true;
  const action =
    message.kind === "probe"
      ? probe(message.tabId)
      : message.kind === "disconnect"
        ? disconnect().then(() => ({ state: "disconnected" }))
        : Promise.reject(new Error("Unsupported action"));
  action
    .then(sendResponse)
    .catch(async (error) => {
      await disconnect();
      lastResult = { state: "error", error: error.message || String(error) };
      sendResponse(lastResult);
    })
    .finally(() => {
      if (message.kind === "probe") probing = false;
    });
  return true;
});
