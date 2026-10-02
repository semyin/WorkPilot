import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { root } from "./cargo.mjs";
import { startToolFixture } from "../services/execution-fixtures/tools.mjs";
const output = join(root, ".test-results/tools-desktop");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "session-"));
const fixture = await startToolFixture();
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  service: "synthetic model; native desktop and actual files",
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
async function create(page, profile, title, permission = "request_approval") {
  await page.getByRole("button", { name: "+ 新建任务", exact: true }).click();
  await page.getByLabel("任务名称（可留空）", { exact: true }).fill(title);
  await page.getByLabel("你想完成什么？", { exact: true }).fill("验证 " + title);
  await page.getByLabel("工作模式", { exact: true }).selectOption("execute");
  await page.getByLabel("任务模型", { exact: true }).selectOption(profile);
  await page.getByLabel("允许操作的文件夹", { exact: true }).fill(folder);
  await page.getByLabel("任务权限", { exact: true }).selectOption(permission);
  await page.getByRole("button", { name: "创建并开始", exact: true }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
}
const state = (page, value) =>
  expect(page.getByTestId("execution-status")).toHaveAttribute("data-state", value, {
    timeout: 20000,
  });
const folder = join(directory, "authorized-project");
await mkdir(folder);
const write = (path, text) => ({ name: "write_file", args: { path, text, expected_sha256: null } });
fixture.recipes.set("tools-native", [
  write("native.txt", "WorkPilot native approval"),
  { name: "register_artifact", args: { path: "native.txt" } },
]);
fixture.recipes.set("tools-full", [write("full.txt", "Full access executed")]);
fixture.recipes.set("tools-conflict", [write("conflict.txt", "Must never replace user edit")]);
fixture.recipes.set("tools-auto", [write("auto.txt", "Reviewed write")]);
let session;
try {
  session = await launch();
  let page = session.page;
  const profiles = {};
  for (const model of [
    "tools-native",
    "tools-full",
    "tools-conflict",
    "tools-auto",
    "review-approve",
  ])
    profiles[model] = await addProfile(page, model);
  await create(page, profiles["tools-native"], "文件写入审批");
  await state(page, "awaiting_approval");
  await expect(page.getByTestId("effective-permission")).toContainText("请求审批");
  await expect(page.locator(".approval-card")).toContainText("WorkPilot native approval");
  await page.screenshot({ path: join(output, "approval.png") });
  await page.getByRole("button", { name: "批准并继续", exact: true }).click();
  await state(page, "completed");
  assert.equal(await readFile(join(folder, "native.txt"), "utf8"), "WorkPilot native approval");
  await page.getByText("文件修改前后 (1)", { exact: true }).click();
  await page
    .locator(".tool-panel summary")
    .filter({ hasText: /^native\.txt$/ })
    .click();
  await expect(page.locator(".tool-panel")).toContainText("原文件不存在");
  await page.screenshot({ path: join(output, "file-versions.png") });
  report.checks.push("native_create_scope_exact_approval_execute_and_file_version_view");
  await create(page, profiles["tools-conflict"], "审批冲突");
  await state(page, "awaiting_approval");
  await writeFile(join(folder, "conflict.txt"), "User changed file during approval");
  await page.getByRole("button", { name: "批准并继续", exact: true }).click();
  await expect(page.locator(".tool-panel [role=alert]")).toBeVisible();
  assert.equal(
    await readFile(join(folder, "conflict.txt"), "utf8"),
    "User changed file during approval",
  );
  await page.getByRole("button", { name: "拒绝此操作", exact: true }).click();
  await state(page, "interrupted");
  report.checks.push("changed_file_approval_error_and_rejection_visible_without_write");
  await create(page, profiles["tools-full"], "完全访问写入", "full_access");
  await state(page, "completed");
  await expect(page.locator(".approval-card")).toHaveCount(0);
  assert.equal(await readFile(join(folder, "full.txt"), "utf8"), "Full access executed");
  report.checks.push("full_access_executes_without_manual_prompt");
  await page.getByRole("button", { name: "+ 新建任务", exact: true }).click();
  await page.getByLabel("任务名称（可留空）", { exact: true }).fill("独立审批写入");
  await page
    .getByLabel("你想完成什么？", { exact: true })
    .fill("Write a small test text file in the authorized project");
  await page.getByLabel("工作模式", { exact: true }).selectOption("execute");
  await page.getByLabel("任务模型", { exact: true }).selectOption(profiles["tools-auto"]);
  await page.getByLabel("允许操作的文件夹", { exact: true }).fill(folder);
  await page.getByLabel("任务权限", { exact: true }).selectOption("auto_review");
  await page
    .getByLabel("独立审批所用模型", { exact: true })
    .selectOption(profiles["review-approve"]);
  await page.getByRole("button", { name: "创建并开始", exact: true }).click();
  await state(page, "completed");
  assert.equal(await readFile(join(folder, "auto.txt"), "utf8"), "Reviewed write");
  await expect(page.getByTestId("effective-permission")).toContainText("帮我批准");
  await page.getByText("最近的审批记录", { exact: true }).click();
  await expect(page.locator(".tool-panel")).toContainText("independent_model_review");
  await page.screenshot({ path: join(output, "independent-review.png") });
  report.checks.push("independent_review_selection_and_record_visible");
  await quit(session);
  session = await launch();
  page = session.page;
  await state(page, "completed");
  await expect(page.getByTestId("effective-permission")).toContainText("帮我批准");
  report.checks.push("permissions_and_history_survive_full_desktop_restart");
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page.getByTestId("effective-permission")).toContainText("Review for me");
  await page.screenshot({ path: join(output, "tools-english.png") });
  report.checks.push("english_permission_workspace");
  assert.equal(errors.length, 0, errors.join("\n"));
  report.result = "passed";
} catch (e) {
  report.result = "failed";
  report.error = e.stack;
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
