import { chromium, expect as baseExpect } from "@playwright/test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { root } from "./cargo.mjs";
import {
  until,
  create,
  profile,
  setFixture,
  start,
  terminal,
  snapshot,
} from "./tool-test-support.mjs";
import { startToolFixture } from "../services/execution-fixtures/tools.mjs";

const expect = baseExpect.configure({ timeout: 20000 });
const output = resolve(
  process.env.WORKPILOT_TEST_OUTPUT || join(root, ".test-results/schedules-desktop"),
);
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "session-")),
  fixture = await startToolFixture();
setFixture(fixture);
const binary =
  process.env.WORKPILOT_DESKTOP_BINARY || join(root, "target/release/workpilot-desktop.exe");
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  binary: {
    path: binary,
    sha256: createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
  },
  service:
    "Actual native Windows WebView2 desktop, owned test data and local deterministic model. Real hide/quit/reopen, no OS sleep or real model.",
  checks: [],
};
let child, browser, page;
const errors = [];
const request = (command) =>
  page.evaluate(
    (command) =>
      window.__TAURI_INTERNALS__.invoke("engine_command", {
        request: { request_id: crypto.randomUUID(), command },
      }),
    command,
  );
async function admin(action) {
  const r = await request({ kind: "schedules", action });
  assert.equal(r.kind, "schedules", JSON.stringify(r));
  return r.data;
}
const list = async () =>
  (await admin({ kind: "list", include_deleted: true, offset: 0, limit: 16 })).items;
const history = async (id) =>
  (await admin({ kind: "history", schedule_id: id, before: null, limit: 64 })).items;
async function boot() {
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  child = spawn(binary, [], {
    cwd: root,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      WORKPILOT_CHANNEL: "test",
      WORKPILOT_DATA_DIR: directory,
      WEBVIEW2_USER_DATA_FOLDER: join(directory, "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`,
    },
  });
  await until(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
    } catch {
      return false;
    }
  }, 30000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = await until(async () =>
    browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => /tauri\.localhost|tauri:/.test(p.url())),
  );
  page.setDefaultTimeout(20000);
  page.on("pageerror", (e) => errors.push(String(e)));
  await expect(page.getByText("引擎已连接", { exact: true })).toBeVisible();
}
async function quit() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    if (page)
      await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("exit_app")).catch(() => {});
    else child.kill();
    await exited;
  }
  await browser?.close().catch(() => {});
}
try {
  await boot();
  fixture.recipes.set("p11-scheduled-native", []);
  const seed = await create({ request }, "responses", "p11-scheduled-native", {
    mode: "chat",
    controlled_tools: false,
  });
  await start({ request }, seed);
  assert.equal((await terminal({ request }, seed)).task.state, "completed");
  const model = profile("responses", "p11-scheduled-native");
  assert.equal(
    (
      await request({
        kind: "save_provider",
        profile: model,
        secret: null,
        clear_credential: false,
      })
    ).kind,
    "provider_saved",
  );
  await page.reload();
  await page.getByRole("button", { name: "定时任务", exact: true }).click();
  let panel = page.getByRole("dialog", { name: "定时任务", exact: true });
  await panel.getByRole("button", { name: "新建计划", exact: true }).click();
  await panel.getByLabel("计划名称", { exact: true }).fill("每周资料整理");
  await panel
    .getByLabel("定时任务要求", { exact: true })
    .fill("检查本次目标，生成一段简明的进度说明。");
  await panel.getByLabel("计划模型服务", { exact: true }).selectOption(model.id);
  await panel.getByLabel("执行频率", { exact: true }).selectOption("daily");
  await panel.getByLabel("计划时区", { exact: true }).fill("America/New_York");
  await panel.getByLabel("每天执行时间", { exact: true }).fill("09:30");
  await panel.getByRole("button", { name: "预览下次时间", exact: true }).click();
  await expect(panel.locator(".schedule-form [role=status]")).toContainText("America/New_York");
  await panel.getByLabel("计划时区", { exact: true }).fill("Invalid/Zone");
  await panel.getByLabel("执行频率", { exact: true }).selectOption("once");
  await expect(panel.getByLabel("执行日期和时间", { exact: true })).toHaveValue("");
  await panel.getByLabel("执行频率", { exact: true }).selectOption("weekly");
  await panel.getByLabel("计划时区", { exact: true }).fill("Asia/Shanghai");
  await panel.getByLabel("周一", { exact: true }).uncheck();
  await panel.getByLabel("周三", { exact: true }).check();
  await panel.getByLabel("周五", { exact: true }).check();
  await panel.getByLabel("保存后启用", { exact: true }).uncheck();
  await page.screenshot({ path: join(output, "schedule-editor-zh.png") });
  await panel.getByRole("button", { name: "保存计划", exact: true }).click();
  const plan = await until(async () => (await list()).find((p) => p.spec.title === "每周资料整理"));
  assert.deepEqual(plan.spec.rule.weekdays, [3, 5]);
  assert.equal(plan.spec.permission, "request_approval");
  assert.equal(plan.spec.enabled, false);
  let card = panel.locator(`[data-schedule-id="${plan.id}"]`);
  await card.getByRole("button", { name: "启用", exact: true }).click();
  await expect(card.getByText("已启用", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "停用", exact: true }).click();
  await expect(card.getByText("已停用", { exact: true })).toBeVisible();
  report.checks.push("native_create_weekly_plan_preview_timezone_validate_and_enable_disable");

  await card.getByRole("button", { name: "编辑计划", exact: true }).click();
  await panel.getByLabel("计划名称", { exact: true }).fill("过时的编辑");
  const current = (await list()).find((p) => p.id === plan.id);
  await admin({
    kind: "set_enabled",
    schedule_id: plan.id,
    revision: current.revision,
    enabled: false,
  });
  await panel.getByRole("button", { name: "保存计划", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("内容或状态已变化");
  assert.equal((await list()).find((p) => p.id === plan.id).spec.title, "每周资料整理");
  await panel.getByRole("button", { name: "取消编辑", exact: true }).click();
  await card.getByRole("button", { name: "立即运行", exact: true }).click();
  await expect(panel.locator(".schedule-occurrence strong").first()).toHaveText("已完成");
  const first = (await history(plan.id))[0];
  await panel.getByRole("button", { name: "打开任务", exact: true }).click();
  await expect(panel).toHaveCount(0);
  assert.equal(
    await page.evaluate(() => localStorage.getItem("workpilot.execution")),
    first.task_id,
  );
  report.checks.push("stale_edit_rejected_manual_run_history_and_navigation_to_actual_task");

  const revision = (await list()).find((p) => p.id === plan.id).revision;
  for (let i = 0; i < 18; i++) {
    const r = await admin({ kind: "run_now", schedule_id: plan.id, revision });
    assert.equal((await terminal({ request }, r.occurrence.task_id)).task.state, "completed");
  }
  await page.getByRole("button", { name: "定时任务", exact: true }).click();
  panel = page.getByRole("dialog", { name: "定时任务", exact: true });
  card = panel.locator(`[data-schedule-id="${plan.id}"]`);
  await card.getByRole("button", { name: "每周资料整理", exact: true }).click();
  await expect(panel.locator(".schedule-occurrence")).toHaveCount(16);
  await panel.getByRole("button", { name: "更早记录", exact: true }).click();
  await expect(panel.locator(".schedule-occurrence")).toHaveCount(19);
  await delay(2300);
  await expect(panel.locator(".schedule-occurrence")).toHaveCount(19);
  await card.getByRole("button", { name: "删除计划", exact: true }).click();
  await expect(card).toHaveCount(0);
  await panel.getByLabel("显示已删除计划", { exact: true }).check();
  await expect(card.getByText("已删除", { exact: true })).toBeVisible();
  assert.equal((await history(plan.id)).length, 19);
  report.checks.push("history_pagination_survives_auto_refresh_and_deleted_plan_keeps_history");

  await panel.getByRole("button", { name: "新建计划", exact: true }).click();
  await panel.getByLabel("计划名称", { exact: true }).fill("后台单次验证");
  await panel.getByLabel("定时任务要求", { exact: true }).fill("生成一次后台运行结果");
  await panel.getByLabel("计划模型服务", { exact: true }).selectOption(model.id);
  await panel.getByLabel("计划时区", { exact: true }).fill("UTC");
  await panel
    .getByLabel("执行日期和时间", { exact: true })
    .fill(new Date(Date.now() + 9000).toISOString().slice(0, 19));
  await panel.getByRole("button", { name: "保存计划", exact: true }).click();
  const background = await until(async () =>
    (await list()).find((p) => p.spec.title === "后台单次验证"),
  );
  await panel.getByRole("button", { name: "关闭定时任务", exact: true }).click();
  const ordinary = await create({ request }, "responses", "runtime-hold", {
    mode: "chat",
    controlled_tools: false,
  });
  await start({ request }, ordinary);
  await until(async () => (await snapshot({ request }, ordinary)).task.state === "running");
  await page.getByRole("button", { name: "隐藏窗口", exact: true }).click();
  const occurred = await until(async () => (await history(background.id))[0], 20000);
  assert.equal((await terminal({ request }, occurred.task_id)).task.state, "completed");
  assert.equal((await terminal({ request }, ordinary)).task.state, "completed");
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("show_window"));
  assert.equal((await history(background.id)).length, 1);
  report.checks.push(
    "actual_desktop_hidden_ordinary_and_scheduled_tasks_run_restore_does_not_resubmit",
  );

  const next = {
    ...background.spec,
    title: "退出期间的计划",
    rule: { kind: "once", local: new Date(Date.now() + 6000).toISOString().slice(0, 19) },
  };
  const offline = await admin({ kind: "save", schedule_id: null, revision: 0, spec: next });
  const stopped = await create({ request }, "responses", "runtime-hold", {
    mode: "chat",
    controlled_tools: false,
  });
  await start({ request }, stopped);
  await until(async () => (await snapshot({ request }, stopped)).task.state === "running");
  await quit();
  await delay(6500);
  await boot();
  const missed = (await history(offline.schedule_id))[0];
  assert.equal(missed.state, "missed");
  assert.equal(missed.task_id, null);
  assert.equal((await snapshot({ request }, stopped)).task.state, "interrupted");
  await page.getByRole("button", { name: "定时任务", exact: true }).click();
  panel = page.getByRole("dialog", { name: "定时任务", exact: true });
  await panel.getByRole("button", { name: "退出期间的计划", exact: true }).click();
  await expect(
    panel.getByText("应用未运行，已记录错过，不会补跑。", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: join(output, "missed-after-restart-zh.png") });
  await panel.getByRole("button", { name: "关闭定时任务", exact: true }).click();
  report.checks.push(
    "actual_quit_stops_running_task_restart_records_missed_time_without_resuming_or_catch_up",
  );

  await page.getByRole("button", { name: "English", exact: true }).click();
  await page.getByRole("button", { name: "Schedules", exact: true }).click();
  panel = page.getByRole("dialog", { name: "Scheduled tasks", exact: true });
  await panel.getByRole("button", { name: "New schedule", exact: true }).click();
  await expect(panel.getByLabel("Schedule model", { exact: true })).toBeVisible();
  assert(await panel.evaluate((e) => e.scrollWidth <= e.clientWidth + 2));
  await page.screenshot({ path: join(output, "schedule-editor-en.png") });
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  assert.equal(errors.length, 0, errors.join("\n"));
  report.checks.push("english_layout_no_horizontal_overflow_escape_closes_dialog_no_js_errors");
  report.result = "passed";
} catch (e) {
  report.result = "failed";
  report.error = String(e.stack || e);
  process.exitCode = 1;
  await page?.screenshot({ path: join(output, "failure.png") }).catch(() => {});
} finally {
  await quit();
  await fixture.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
