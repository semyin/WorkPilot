import { chromium, expect } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { root } from "./cargo.mjs";

const output = join(root, ".test-results/desktop");
await mkdir(output, { recursive: true });
async function unusedPort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function waitUntil(check, timeout = 10000) {
  const started = performance.now();
  while (performance.now() - started < timeout) {
    const result = await check().catch(() => false);
    if (result) return result;
    await delay(50);
  }
  throw new Error("Timed out waiting for native desktop probe");
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function launch(existingDirectory) {
  const directory = existingDirectory || (await mkdtemp(join(output, "session-")));
  const port = await unusedPort();
  const start = performance.now();
  const child = spawn(
    process.env.WORKPILOT_DESKTOP_BINARY || join(root, "target/release/workpilot-desktop.exe"),
    [],
    {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        WORKPILOT_CHANNEL: "test",
        WORKPILOT_DATA_DIR: directory,
        WEBVIEW2_USER_DATA_FOLDER: join(directory, "webview"),
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
          "--remote-debugging-address=127.0.0.1 --remote-debugging-port=" + port,
      },
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.once("error", (error) => {
    stderr += error;
  });
  try {
    await waitUntil(
      async () => (await fetch("http://127.0.0.1:" + port + "/json/version")).ok,
      20000,
    );
    const browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
    const page = await waitUntil(async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => /tauri\.localhost|tauri:/.test(p.url())),
    );
    await page.goto(page.url().split("?")[0] + "?diagnostics=1");
    await expect(page.getByText("引擎已连接", { exact: true })).toBeVisible();
    const startupMs = performance.now() - start;
    return { child, browser, page, directory, startupMs, stderr: () => stderr };
  } catch (error) {
    child.kill();
    throw new Error(String(error) + "\n" + stderr);
  }
}
const report = {
  platform: process.platform,
  node: process.version,
  at: new Date().toISOString(),
  checks: [],
  samples: {},
};
let session;
try {
  session = await launch();
  const { page, child } = session;
  report.samples.startupObservedMs = session.startupMs;
  const rows = page.locator(".event");
  await expect(
    page.frameLocator("iframe").getByRole("heading", { name: "欢迎使用 WorkPilot" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Turn ideas into action." })).toBeVisible();
  await page.screenshot({ path: join(output, "native-english.png") });
  await page.getByRole("button", { name: "简体中文", exact: true }).click();
  report.checks.push("native_bilingual_file_preview");
  await page.evaluate(() => {
    window.probeMetrics = { feedback: [], stopped: [], eventLatency: [] };
    let clickAt;
    let lastSequence = "";
    document.addEventListener(
      "click",
      (event) => {
        if (event.target.closest("button.stop")) clickAt = performance.now();
      },
      true,
    );
    new MutationObserver(() => {
      const status = document.querySelector(".status").textContent;
      if (clickAt !== undefined && status === "正在停止…")
        window.probeMetrics.feedback.push(performance.now() - clickAt);
      if (clickAt !== undefined && status === "已中断") {
        window.probeMetrics.stopped.push(performance.now() - clickAt);
        clickAt = undefined;
      }
      const first = document.querySelector(".event");
      if (first && first.dataset.sequence !== lastSequence) {
        lastSequence = first.dataset.sequence;
        window.probeMetrics.eventLatency.push(Date.now() - Number(first.dataset.atMs));
      }
    }).observe(document.querySelector(".activity"), {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  const stopSamples = [];
  for (let i = 0; i < 20; i++) {
    await page.getByRole("button", { name: "开始验证" }).click();
    await expect(page.getByTestId("progress")).not.toHaveText("0 / 0");
    const start = performance.now();
    await page.getByRole("button", { name: /^■/ }).click();
    await expect(page.locator(".status")).toHaveText("已中断");
    stopSamples.push(performance.now() - start);
  }
  report.samples.stopObservedMs = stopSamples;
  report.samples.stopP95Ms = [...stopSamples].sort((a, b) => a - b)[
    Math.ceil(stopSamples.length * 0.95) - 1
  ];
  report.checks.push("native_start_stop_20_samples");
  await page.getByRole("button", { name: "开始验证" }).click();
  await expect(page.getByTestId("progress")).not.toHaveText("0 / 0");
  const countBeforeHide = Number(await page.getByTestId("event-count").textContent());
  await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("plugin:window|close", { label: "main" }),
  );
  assert.equal(
    await page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "main" }),
    ),
    false,
  );
  await delay(1800);
  const logFiles = (await readdir(join(session.directory, "test"))).filter((f) =>
    f.endsWith(".jsonl"),
  );
  const log = await readFile(join(session.directory, "test", logFiles[0]), "utf8");
  const hiddenEvents = log
    .trim()
    .split("\n")
    .map(JSON.parse)
    .filter((event) => event.sequence > countBeforeHide && event.kind === "progress");
  assert.ok(
    hiddenEvents.length >= 10,
    "Engine did not keep progressing while the window was hidden",
  );
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("show_window"));
  await expect(page.getByTestId("progress")).not.toHaveText("0 / 0");
  assert.equal(
    await page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "main" }),
    ),
    true,
  );
  report.checks.push("close_hides_and_reopens_same_engine");
  await page.getByRole("button", { name: /^■/ }).click();
  await expect(page.locator(".status")).toHaveText("已中断");
  await page.getByRole("button", { name: "长日志验证" }).click();
  await expect(page.locator(".status")).toHaveText("已完成", { timeout: 60000 });
  assert.ok((await rows.count()) <= 200);
  assert.ok(Number(await page.getByTestId("event-count").textContent()) > 10000);
  await page.screenshot({ path: join(output, "native-chinese-long-log.png") });
  report.checks.push("ten_thousand_events_bounded_ui");
  report.samples.domMetrics = await page.evaluate(() => window.probeMetrics);
  for (const [key, values] of Object.entries(report.samples.domMetrics)) {
    report.samples[key + "P95Ms"] = [...values].sort((a, b) => a - b)[
      Math.ceil(values.length * 0.95) - 1
    ];
  }
  report.samples.processes = JSON.parse(
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-File",
        join(root, "scripts/measure-processes.ps1"),
        "-RootProcessId",
        String(child.pid),
      ],
      { encoding: "utf8", windowsHide: true },
    ),
  );
  await page.getByRole("button", { name: "网页", exact: true }).click();
  await page.getByRole("button", { name: "打开网页样本" }).click();
  const preview = await waitUntil(
    async () =>
      session.browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().startsWith("https://example.com")),
    15000,
  );
  await expect(preview).toHaveTitle("Example Domain");
  await expect(preview.locator("body")).toContainText("domain");
  await preview.screenshot({ path: join(output, "native-browser-preview.png") });
  report.checks.push("native_embedded_external_page");
  await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("plugin:window|close", { label: "main" }),
  );
  assert.equal(
    await page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "main" }),
    ),
    false,
  );
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("show_window"));
  assert.equal(
    await page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "main" }),
    ),
    true,
  );
  report.checks.push("close_and_reopen_with_child_webview");
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.getByRole("button", { name: "网页", exact: true }).click();
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await expect
    .poll(
      () =>
        session.browser
          .contexts()
          .flatMap((context) => context.pages())
          .filter((target) => target.url().startsWith("https://example.com")).length,
    )
    .toBe(0);
  await expect(
    page.frameLocator("iframe").getByRole("heading", { name: "欢迎使用 WorkPilot" }),
  ).toBeVisible();
  report.checks.push("switching_preview_tabs_leaves_no_orphan_webview");
  const filesBeforeExit = (await readdir(join(session.directory, "test"))).filter((f) =>
    f.endsWith(".jsonl"),
  );
  const eventsBeforeExit = (
    await readFile(join(session.directory, "test", filesBeforeExit[0]), "utf8")
  )
    .trim()
    .split("\n")
    .map(JSON.parse);
  const enginePid = eventsBeforeExit[0].pid;
  const exited = once(child, "exit");
  await page
    .getByRole("button", { name: "彻底退出" })
    .click()
    .catch(() => {});
  await Promise.race([
    exited,
    delay(5000).then(() => {
      throw new Error("Desktop did not exit");
    }),
  ]);
  await waitUntil(async () => !alive(enginePid));
  const fullLog = await readFile(join(session.directory, "test", filesBeforeExit[0]), "utf8");
  assert.match(fullLog.trim().split("\n").at(-1), /"kind":"bye"/);
  report.checks.push("explicit_exit_flushes_log_and_stops_engine");
  const savedDirectory = session.directory;
  await session.browser.close().catch(() => {});
  session = await launch(savedDirectory);
  await expect(session.page.locator(".status")).toHaveText("已完成", { timeout: 15000 });
  await expect(session.page.locator(".saved-tasks button").first()).toBeVisible({ timeout: 15000 });
  const savedTask = await session.page
    .locator(".saved-tasks button")
    .first()
    .getAttribute("data-task-id");
  await session.page.locator(".saved-tasks button").first().click();
  await expect(session.page.getByTestId("saved-history").locator("details").first()).toBeVisible();
  const firstSequence = await session.page
    .getByTestId("saved-history")
    .locator("summary")
    .first()
    .innerText();
  assert.match(firstSequence, /^#1 /);
  if (await session.page.getByRole("button", { name: "下一页", exact: true }).isVisible()) {
    await session.page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(
      session.page.getByTestId("saved-history").locator("summary").first(),
    ).toContainText("#129");
  }
  await session.page.screenshot({ path: join(output, "native-persisted-history.png") });
  const layout = await session.page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
    startTop: document.querySelector(".actions").getBoundingClientRect().top,
    footerBottom: document.querySelector("footer").getBoundingClientRect().bottom,
  }));
  assert.ok(layout.scrollHeight <= layout.viewportHeight + 1, JSON.stringify(layout));
  assert.ok(layout.startTop >= 0 && layout.footerBottom <= layout.viewportHeight + 1);
  report.checks.push("restart_reads_saved_tasks_and_paginated_history");
  report.samples.reopenedTaskId = savedTask;
  // A new active task is killed with its host, then inspected on the next launch.
  await session.page.getByRole("button", { name: "开始验证" }).click();
  await expect(session.page.locator(".status")).toHaveText("进行中");
  await delay(500);
  const beforeCrash = await session.page.evaluate(async () =>
    window.__TAURI_INTERNALS__.invoke("engine_command", {
      request: {
        request_id: crypto.randomUUID(),
        command: { kind: "read", query: { kind: "tasks", before: null, limit: 64 } },
      },
    }),
  );
  const activeTask = beforeCrash.page.tasks.find((task) => task.state === "running");
  assert.ok(activeTask);
  session.child.kill();
  await once(session.child, "exit");
  await session.browser.close().catch(() => {});
  session = await launch(savedDirectory);
  await expect(session.page.locator('[data-task-id="' + activeTask.id + '"]')).toHaveAttribute(
    "data-task-state",
    "interrupted",
    { timeout: 15000 },
  );
  await expect(session.page.locator(".status")).not.toHaveText("进行中", { timeout: 15000 });
  report.checks.push("host_crash_marks_saved_task_interrupted_without_rerun");
  await session.page
    .getByRole("button", { name: "彻底退出", exact: true })
    .click()
    .catch(() => {});
  await waitUntil(async () => !alive(session.child.pid));
  await session.browser.close().catch(() => {});
  session = await launch();
  const crashLogFile = (await readdir(join(session.directory, "test"))).find((f) =>
    f.endsWith(".jsonl"),
  );
  const ready = JSON.parse(
    (await readFile(join(session.directory, "test", crashLogFile), "utf8")).split("\n")[0],
  );
  session.child.kill();
  await waitUntil(async () => !alive(ready.pid));
  report.checks.push("host_force_kill_closes_owned_engine_job");
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  report.stderr = session?.stderr();
  if (session?.page)
    await session.page.screenshot({ path: join(output, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (session?.child && alive(session.child.pid)) session.child.kill();
  await session?.browser?.close().catch(() => {});
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
