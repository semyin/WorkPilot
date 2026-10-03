import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { root } from "./cargo.mjs";
import { until } from "./tool-test-support.mjs";
import { browserTask } from "./browser-test-support.mjs";
import { browserScenario } from "./browser-scenario.mjs";
import { startBrowserFixture } from "../services/browser-fixtures/server.mjs";
const output = process.env.WORKPILOT_TEST_OUTPUT || join(root, ".test-results/browser-desktop");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "session-")),
  folder = join(directory, "project");
await mkdir(folder);
const binary =
  process.env.WORKPILOT_DESKTOP_BINARY || join(root, "target/release/workpilot-desktop.exe");
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  service: "Native Windows WebView and actual installed Chrome; local fixture, no paid model",
  binary: {
    path: binary,
    sha256: createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
  },
  checks: [],
};
const server = createServer().listen(0, "127.0.0.1");
await once(server, "listening");
const port = server.address().port;
await new Promise((r) => server.close(r));
const fixture = await startBrowserFixture();
let child, browser, page;
const request = (command) =>
  page.evaluate(
    (command) =>
      window.__TAURI_INTERNALS__.invoke("engine_command", {
        request: { request_id: crypto.randomUUID(), command },
      }),
    command,
  );
const errors = [];
try {
  child = spawn(binary, [], {
    cwd: root,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      WORKPILOT_CHANNEL: "test",
      WORKPILOT_DATA_DIR: directory,
      WORKPILOT_BROWSER_HEADLESS: "1",
      WEBVIEW2_USER_DATA_FOLDER: join(directory, "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
        "--remote-debugging-address=127.0.0.1 --remote-debugging-port=" + port,
    },
  });
  await until(async () => {
    try {
      return (await fetch("http://127.0.0.1:" + port + "/json/version")).ok;
    } catch {
      return false;
    }
  }, 30000);
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
  page = await until(async () =>
    browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => /tauri\.localhost|tauri:/.test(p.url())),
  );
  page.on("pageerror", (e) => errors.push(String(e)));
  await expect(page.getByText("引擎已连接", { exact: true })).toBeVisible({ timeout: 20000 });
  const b = await browserTask({ request }, folder, { permission: "request_approval" });
  await browserScenario({ page, task: b.task, url: fixture.url, report, output });
  const sessions = await b.control({ kind: "sessions" });
  const owned = sessions.sessions.find((s) => s.kind === "dedicated" && s.state === "connected");
  assert(owned?.owned_pid);
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("hide_window"));
  await delay(300);
  assert.doesNotThrow(() => process.kill(owned.owned_pid, 0));
  const exited = once(child, "exit");
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("exit_app")).catch(() => {});
  await exited;
  await until(async () => {
    try {
      process.kill(owned.owned_pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  report.checks.push("hide_keeps_dedicated_browser_alive_quit_closes_owned_browser");
  assert.deepEqual(errors, []);
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = String(e);
  if (page) await page.screenshot({ path: join(output, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    if (page)
      await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("exit_app")).catch(() => {});
    else child.kill();
    await exited;
  }
  await browser?.close().catch(() => {});
  await fixture.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
