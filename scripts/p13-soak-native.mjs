import { request } from "./p13-desktop-support.mjs";

// Observe only. Registering these listeners never closes a page, child or browser.
export function observeNativeLifecycle(session, record, progress) {
  const events = [],
    pending = [];
  let phase = "running";
  const observe = (kind, details = {}) => {
    const event = { at: new Date().toISOString(), phase, kind, ...details };
    events.push(event);
    progress("native-lifecycle", event);
    const write = record("native_lifecycle", event);
    write.catch(() => {});
    pending.push(write);
  };
  session.child.on("exit", (code, signal) =>
    observe("owned_desktop_exit", { pid: session.child.pid, code, signal }),
  );
  session.page.on("close", () => observe("webview_page_closed"));
  session.page.on("crash", () => observe("webview_page_crashed"));
  session.browser.on("disconnected", () => observe("webview_connection_disconnected"));
  return {
    events,
    beginShutdown() {
      phase = "harness_shutdown";
    },
    async flush() {
      await Promise.all(pending);
    },
  };
}

export function nativeEngine(session) {
  return {
    async request(command) {
      const long =
        command.kind === "media" && ["preview", "finish_upload"].includes(command.action?.kind);
      let timer;
      try {
        return await Promise.race([
          request(session.page, command),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Native request stalled: ${command.kind}`)),
              long ? 120000 : 15000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
