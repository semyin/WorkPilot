import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { root } from "./cargo.mjs";
import { create, until } from "./tool-test-support.mjs";
import { workbenchScenario } from "./workbench-scenario.mjs";
const output = join(root, ".test-results/workbench-desktop");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "session-"));
const folder = join(directory, "project");
await mkdir(folder);
const desktopBinary =
  process.env.WORKPILOT_DESKTOP_BINARY || join(root, "target/release/workpilot-desktop.exe");
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  service: "native Windows WebView, real files and processes; no paid model",
  binary: {
    path: desktopBinary,
    sha256: createHash("sha256")
      .update(await readFile(desktopBinary))
      .digest("hex"),
  },
  checks: [],
};
async function freePort() {
  const s = createServer().listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}
const port = await freePort();
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
  child = spawn(desktopBinary, [], {
    cwd: root,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      WORKPILOT_CHANNEL: "test",
      WORKPILOT_DATA_DIR: directory,
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
  await writeFile(join(folder, "notes.txt"), "original\n第二行\n");
  await writeFile(
    join(folder, "preview.html"),
    "<h1>Static preview</h1><script>window.__p07UnsafeScriptRan=true</script>",
  );
  const task = await create({ request }, "responses", "P07 native workspace");
  const configured = await request({
    kind: "configure_task_tools",
    task_id: task,
    settings: {
      root_path: folder,
      permission: "request_approval",
      commands_enabled: true,
      review_profile_id: null,
      revision: 0,
    },
  });
  assert.notEqual(configured.kind, "error", JSON.stringify(configured));
  await workbenchScenario({ page, folder, task, report, output });
  await page.getByRole("button", { name: "Back to conversation", exact: true }).click();
  const old = await request({ kind: "read", query: { kind: "task_tools", task_id: task } });
  await request({
    kind: "configure_task_tools",
    task_id: task,
    settings: { ...old.state.policy.settings, permission: "full_access" },
  });
  const previewPort = await freePort();
  const html =
    "<h1>Isolated runtime preview</h1><script>Promise.resolve().then(()=>window.__TAURI_INTERNALS__.invoke('engine_command',{request:{request_id:'preview-test',command:{kind:'ping'}}})).then(()=>document.body.dataset.host='allowed').catch(()=>document.body.dataset.host='blocked')</script>";
  const source =
    "require('http').createServer((q,s)=>{s.setHeader('Content-Type','text/html; charset=utf-8');s.end(" +
    JSON.stringify(html) +
    ")}).listen(" +
    previewPort +
    ",'127.0.0.1');console.log('preview ready');setInterval(()=>{},1000)";
  const started = await request({
    kind: "workbench",
    task_id: task,
    action: {
      kind: "terminal",
      program: process.execPath,
      args: ["-e", source],
      timeout_ms: 60000,
      preview_port: previewPort,
    },
  });
  assert.equal(started.kind, "workbench", JSON.stringify(started));
  const operation = started.data.operation;
  await until(async () => {
    try {
      return (await fetch("http://127.0.0.1:" + previewPort)).ok;
    } catch {
      return false;
    }
  });
  await until(async () => {
    try {
      await page.evaluate(
        ({ task, operation }) =>
          window.__TAURI_INTERNALS__.invoke("project_preview_open", {
            taskId: task,
            operationId: operation,
          }),
        { task, operation: operation.id },
      );
      return true;
    } catch {
      return false;
    }
  });
  const preview = await until(async () =>
    browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().startsWith("http://127.0.0.1:" + previewPort)),
  );
  await expect(preview.getByRole("heading", { name: "Isolated runtime preview" })).toBeVisible();
  await expect(preview.locator("body")).toHaveAttribute("data-host", "blocked");
  const direct = await preview.evaluate(async () => {
    try {
      await window.__TAURI_INTERNALS__.invoke("project_preview_close");
      return "allowed";
    } catch {
      return "blocked";
    }
  });
  assert.equal(direct, "blocked");
  report.checks.push("owned_runtime_preview_is_a_separate_webview_without_host_commands");
  await preview.screenshot({ path: join(output, "isolated-runtime-preview.png") });
  await request({
    kind: "workbench",
    task_id: task,
    action: { kind: "stop", operation_id: operation.id },
  });
  await until(async () => {
    const r = await request({ kind: "workbench", task_id: task, action: { kind: "operations" } });
    return (
      r.data.items.find((r) => r.operation.id === operation.id)?.operation.state === "cancelled"
    );
  });
  const invalid = await request({
    kind: "workbench",
    task_id: task,
    action: { kind: "preview", operation_id: operation.id },
  });
  assert.equal(invalid.kind, "error");
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("project_preview_close"));
  report.checks.push("stopped_runtime_port_cannot_be_opened_again");
  const long = await request({
    kind: "workbench",
    task_id: task,
    action: {
      kind: "terminal",
      program: process.execPath,
      args: ["-e", "console.log('alive');setInterval(()=>{},1000)"],
      timeout_ms: 60000,
      preview_port: null,
    },
  });
  const longId = long.data.operation.id;
  const pid = await until(async () => {
    const r = await request({ kind: "workbench", task_id: task, action: { kind: "operations" } });
    return r.data.items.find((r) => r.operation.id === longId)?.operation.pid;
  });
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("hide_window"));
  await delay(250);
  assert.doesNotThrow(() => process.kill(pid, 0));
  const exited = once(child, "exit");
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("exit_app")).catch(() => {});
  await exited;
  await until(async () => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  report.checks.push("hide_keeps_owned_terminal_alive_quit_ends_it");
  assert.deepEqual(errors, []);
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = String(e);
  if (page) await page.screenshot({ path: join(output, "failure.png") }).catch(() => {});
  throw e;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    if (page)
      await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("exit_app")).catch(() => {});
    else child.kill();
    await exited;
  }
  if (browser) await browser.close().catch(() => {});
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
