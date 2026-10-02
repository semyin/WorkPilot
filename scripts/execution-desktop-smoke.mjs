import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { root } from "./cargo.mjs";
import { startExecutionFixture } from "../services/execution-fixtures/server.mjs";
const output = join(root, ".test-results/execution-desktop");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "session-"));
const fixture = await startExecutionFixture();
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  service: "synthetic local HTTP only",
  checks: [],
};
const errors = [];
async function until(check, timeout = 20000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const value = await check().catch(() => false);
    if (value) return value;
    await delay(50);
  }
  throw new Error("Native execution assertion timed out");
}
async function launch() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const child = spawn(
    process.env.WORKPILOT_DESKTOP_BINARY || join(root, "target/release/workpilot-desktop.exe"),
    [],
    {
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
    },
  );
  try {
    await until(async () => (await fetch("http://127.0.0.1:" + port + "/json/version")).ok);
    const browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
    const page = await until(async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => /tauri\.localhost|tauri:/.test(p.url())),
    );
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(page.url().split("?")[0] + "?diagnostics=1");
    await expect(page.getByText("引擎已连接", { exact: true })).toBeVisible();
    return { child, browser, page };
  } catch (e) {
    child.kill();
    throw e;
  }
}
async function command(page, command) {
  return page.evaluate(
    (command) =>
      window.__TAURI_INTERNALS__.invoke("engine_command", {
        request: { request_id: crypto.randomUUID(), command },
      }),
    command,
  );
}
async function snapshot(page) {
  const task = await page.evaluate(() => localStorage.getItem("workpilot.execution"));
  const r = await command(page, { kind: "read", query: { kind: "execution", task_id: task } });
  assert.equal(r.kind, "execution");
  return r.snapshot;
}
async function quit(session) {
  const exit = once(session.child, "exit");
  await session.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("exit_app")).catch(() => {});
  await exit;
  await session.browser.close().catch(() => {});
}
async function addProfile(page, model) {
  const empty = { supported: null, source: "unknown", checked_at_ms: null };
  const p = {
    id: crypto.randomUUID(),
    label: model,
    protocol: "responses",
    model,
    base_url: fixture.url,
    credential: null,
    auth: "none",
    supports_tools: true,
    supports_images: null,
    revision: 1,
    capabilities: {
      text: empty,
      streaming: empty,
      tools: { supported: true, source: "user", checked_at_ms: null },
      images: empty,
      usage: empty,
    },
    options: {
      max_output_tokens: 1024,
      temperature: null,
      reasoning_effort: null,
      chat_token_parameter: "max_completion_tokens",
      timeout_ms: 20000,
      idle_timeout_ms: 10000,
      anthropic_version: "2023-06-01",
    },
    pricing: null,
  };
  assert.equal(
    (
      await command(page, {
        kind: "save_provider",
        profile: p,
        secret: null,
        clear_credential: false,
      })
    ).kind,
    "provider_saved",
  );
  return p.id;
}
async function create(page, profile, title, mode = "execute") {
  await page.getByRole("button", { name: "+ 新建任务", exact: true }).click();
  await page.getByLabel("任务名称（可留空）", { exact: true }).fill(title);
  await page.getByLabel("你想完成什么？", { exact: true }).fill("验证 " + title);
  await page.getByLabel("工作模式", { exact: true }).selectOption(mode);
  await page.getByLabel("任务模型", { exact: true }).selectOption(profile);
  await page.getByLabel("启用内置样本工具（验证执行流程）", { exact: true }).check();
  await page.getByRole("button", { name: "创建并开始", exact: true }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
}
const state = (page, value) =>
  expect(page.getByTestId("execution-status")).toHaveAttribute("data-state", value, {
    timeout: 20000,
  });
let session;
try {
  session = await launch();
  let page = session.page;
  const profiles = {};
  for (const model of [
    "runtime-sum",
    "runtime-ask",
    "runtime-plan",
    "runtime-guide",
    "runtime-hold",
    "runtime-error",
  ])
    profiles[model] = await addProfile(page, model);
  await page.getByRole("button", { name: "任务执行", exact: true }).click();
  await create(page, profiles["runtime-sum"], "求和与保存");
  await state(page, "completed");
  await expect(page.getByTestId("execution-answer")).toContainText("24");
  const sum = await snapshot(page);
  assert.equal(sum.steps.filter((s) => s.kind === "tool" && s.state === "completed").length, 3);
  await page.locator('[data-step-name="sample_write"] button').click();
  await expect(page.locator('[data-step-name="sample_write"]')).toContainText("24");
  await page.getByRole("button", { name: "完整事件", exact: true }).click();
  await expect(page.getByRole("heading", { name: "完整事件记录", exact: true })).toBeVisible();
  await page.screenshot({ path: join(output, "task-completed.png") });
  report.checks.push("native_create_model_tool_loop_expand_result_and_full_events");
  await create(page, profiles["runtime-plan"], "先规划后执行", "plan");
  await state(page, "awaiting_input");
  assert.equal((await snapshot(page)).steps.filter((s) => s.name === "sample_write").length, 0);
  await page.screenshot({ path: join(output, "plan-confirmation.png") });
  await page.getByRole("button", { name: "开始执行计划", exact: true }).click();
  await state(page, "completed");
  assert((await snapshot(page)).context.plan.every((p) => p.status === "done"));
  report.checks.push("plan_readonly_until_explicit_execute_confirmation");
  await create(page, profiles["runtime-ask"], "询问与回答");
  await state(page, "awaiting_input");
  await expect(page.getByText("请选择颜色", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "蓝色", exact: true }).click();
  await page.getByRole("button", { name: "发送并继续", exact: true }).click();
  await state(page, "completed");
  assert((await snapshot(page)).context.directions.some((d) => d.text === "蓝色"));
  report.checks.push("answer_question_then_new_run_continues_original_session");
  await create(page, profiles["runtime-guide"], "排队后手动引导");
  await expect(page.locator('[data-step-name="sample_wait"]')).toHaveAttribute(
    "data-step-state",
    "running",
  );
  await page.getByLabel("发送新的要求", { exact: true }).fill("GUIDE_NOW");
  await page.getByRole("button", { name: "加入队列", exact: true }).click();
  await page.getByRole("button", { name: "引导", exact: true }).click();
  await state(page, "completed");
  await expect(page.getByTestId("execution-answer")).toContainText("引导");
  assert(
    (await snapshot(page)).steps.some((s) => s.name === "sample_write" && s.state === "skipped"),
  );
  report.checks.push("queued_instruction_promoted_to_guide_skips_unstarted_action");
  await create(page, profiles["runtime-hold"], "停止并手动继续");
  await state(page, "running");
  await page.getByRole("button", { name: "停止任务", exact: true }).click();
  await state(page, "interrupted");
  const stopped = await snapshot(page);
  const stoppedCount = fixture.records.length;
  await page.getByLabel("发送新的要求", { exact: true }).fill("保留原要求继续");
  await page.getByRole("button", { name: "保存消息", exact: true }).click();
  assert.equal(fixture.records.length, stoppedCount);
  await page.getByRole("button", { name: "继续任务", exact: true }).click();
  await state(page, "completed");
  assert.equal((await snapshot(page)).latest_run.predecessor_id, stopped.latest_run.run.id);
  report.checks.push("stop_preserves_context_new_message_waits_for_manual_continue");
  await create(page, profiles["runtime-hold"], "隐藏后后台执行");
  await state(page, "running");
  await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("plugin:window|close", { label: "main" }),
  );
  assert.equal(
    await page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "main" }),
    ),
    false,
  );
  await until(async () => (await snapshot(page)).task.state === "completed");
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("show_window"));
  await state(page, "completed");
  report.checks.push("closing_window_keeps_actual_task_running_in_background");
  await create(page, profiles["runtime-error"], "错误停止");
  await state(page, "failed");
  await expect(page.locator(".execution-main")).toContainText("请求过于频繁");
  report.checks.push("model_error_visible_without_silent_retry");
  await create(page, profiles["runtime-hold"], "重启后不自动重跑");
  await state(page, "running");
  const beforeRestart = fixture.records.length;
  await quit(session);
  session = await launch();
  page = session.page;
  await page.getByRole("button", { name: "任务执行", exact: true }).click();
  await state(page, "interrupted");
  assert.equal(fixture.records.length, beforeRestart);
  await page.getByRole("button", { name: "继续任务", exact: true }).click();
  await state(page, "completed");
  report.checks.push("desktop_exit_restart_waits_for_manual_continuation");
  await page.getByRole("button", { name: "返回工作台", exact: true }).click();
  await page.getByRole("button", { name: "English", exact: true }).click();
  await page.getByRole("button", { name: "Task execution", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveAttribute("aria-label", "Task execution");
  await page.screenshot({ path: join(output, "task-english.png") });
  report.checks.push("english_task_workspace");
  assert.equal(errors.length, 0, errors.join("\n"));
  assert(fixture.records.every((r) => r.correlationValid));
  report.result = "passed";
  report.requests = fixture.records;
} catch (e) {
  report.result = "failed";
  report.error = String(e);
  process.exitCode = 1;
  if (session) await session.page.screenshot({ path: join(output, "failure.png") }).catch(() => {});
} finally {
  if (session && session.child.exitCode === null)
    await quit(session).catch(() => session.child.kill());
  await fixture.close();
  report.pageErrors = errors;
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
