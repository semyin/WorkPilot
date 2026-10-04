import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";
import { join, resolve } from "node:path";
import { launchEngine } from "./p13-engine-client.mjs";
import { launchDesktop, quitDesktop } from "./p13-desktop-support.mjs";

export async function statusHarness(directory, binary, native) {
  if (native) {
    const session = await launchDesktop(binary, directory);
    await session.page.evaluate(() => {
      window.__statusOriginal = window.__TAURI_INTERNALS__.invoke;
      window.__statusBypassRequestIds = new Set();
    });
    return {
      page: session.page,
      errors: session.errors,
      request: (command) =>
        session.page.evaluate((command) => {
          const request_id = crypto.randomUUID();
          window.__statusBypassRequestIds.add(request_id);
          return window.__statusOriginal("engine_command", {
            request: { request_id, command },
          });
        }, command),
      close: () => quitDesktop(session),
    };
  }
  const engine = await launchEngine(binary, join(directory, "data"));
  let server, browser;
  try {
    server = await createServer({
      root: resolve("apps/desktop"),
      configFile: resolve("apps/desktop/vite.config.ts"),
      logLevel: "error",
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    await server.listen();
    browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    // The dev page has no favicon; satisfy Chrome's automatic request without masking app errors.
    await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (message) => {
      if (message.type() === "error")
        errors.push(message.text() + " @ " + JSON.stringify(message.location()));
    });
    await page.exposeBinding("workpilotStatusInvoke", (_, { command, args }) => {
      if (command === "engine_command") return engine.request(args.request.command);
      if (["set_desktop_locale", "hide_window"].includes(command)) return;
      throw new Error("Unexpected UI test command: " + command);
    });
    await page.addInitScript(() => {
      window.__TAURI_INTERNALS__ = {
        invoke: (command, args) => window.workpilotStatusInvoke({ command, args }),
      };
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
    await expect(page.getByText(/^(引擎已连接|Engine connected)$/)).toBeVisible();
    return {
      page,
      errors,
      request: engine.request,
      close: async () => {
        await browser.close();
        await server.close();
        await engine.close();
      },
    };
  } catch (e) {
    await browser?.close();
    await server?.close();
    await engine.close();
    throw e;
  }
}

export async function responseGates(page) {
  const gates = [];
  await page.exposeBinding("workpilotStatusGate", async (_, message) => {
    const gate = gates.find(
      (g) => !g.claimed && g.phase === message.phase && g.match(message.command),
    );
    if (!gate) return null;
    gate.claimed = true;
    gate.hit(message.response);
    await gate.wait;
    return gate.override === undefined ? null : { override: gate.override };
  });
  await page.evaluate(() => {
    const internals = window.__TAURI_INTERNALS__;
    if (Object.getOwnPropertyDescriptor(internals, "invoke")?.writable === false) {
      // Release Tauri keeps invoke immutable. Delay only this isolated window's
      // actual engine IPC fetch; leave its protected internals and key untouched.
      const original = window.fetch;
      const ipcUrl = internals.convertFileSrc("engine_command", "ipc");
      const overridden = (value, previous) =>
        new Response(JSON.stringify(value), {
          status: previous?.status || 200,
          headers: previous?.headers || {
            "Content-Type": "application/json",
            "Tauri-Response": "ok",
          },
        });
      window.fetch = async (resource, init) => {
        if (String(resource) !== ipcUrl) return original(resource, init);
        const envelope = JSON.parse(init.body);
        const { request_id, command } = envelope.request;
        if (window.__statusBypassRequestIds.delete(request_id)) return original(resource, init);
        const before = await window.workpilotStatusGate({ phase: "before", command });
        if (before?.override) return overridden(before.override);
        const response = await original(resource, init);
        const result = await response.clone().json();
        const after = await window.workpilotStatusGate({
          phase: "after",
          command,
          response: result,
        });
        return after?.override ? overridden(after.override, response) : response;
      };
      window.__statusGateTransport = "native_ipc_fetch";
    } else {
      const original = internals.invoke;
      internals.invoke = async (name, args) => {
        if (name !== "engine_command") return original(name, args);
        const command = args.request.command;
        const before = await window.workpilotStatusGate({ phase: "before", command });
        if (before?.override) return before.override;
        const response = await original(name, args);
        const after = await window.workpilotStatusGate({ phase: "after", command, response });
        return after?.override ?? response;
      };
      window.__statusGateTransport = "development_invoke";
    }
    window.__statusObservations = [];
    window.__statusMismatches = [];
    new MutationObserver(() => {
      const title = document.querySelector('[data-testid="execution-status"]');
      if (!title) return;
      const task = title.dataset.taskId;
      const sidebar = document.querySelector(`[data-execution-id="${task}"] [data-state]`);
      if (!sidebar) return;
      const value = { task, title: title.dataset.state, sidebar: sidebar.dataset.state };
      const entries = window.__statusObservations;
      if (JSON.stringify(entries.at(-1)) !== JSON.stringify(value)) entries.push(value);
      if (value.title !== value.sidebar) window.__statusMismatches.push(value);
    }).observe(document.body, { attributes: true, childList: true, subtree: true });
  });
  return {
    transport: await page.evaluate(() => window.__statusGateTransport),
    hold(match, phase = "after", override) {
      let release, hit, timeout;
      const wait = new Promise(
        (done) =>
          (release = () => {
            clearTimeout(timeout);
            done();
          }),
      );
      const captured = new Promise((done, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error("Test response gate did not receive its expected IPC within 15 seconds"),
            ),
          15000,
        );
        hit = (value) => {
          clearTimeout(timeout);
          done(value);
        };
      });
      gates.push({ match, phase, override, wait, hit, release, claimed: false });
      return { captured, release };
    },
    releaseAll: () => gates.forEach((g) => g.release()),
  };
}
