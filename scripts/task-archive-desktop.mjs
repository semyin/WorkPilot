import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { until, create } from "./tool-test-support.mjs";

const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/task-archive-desktop");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "session-"));
const binary =
  process.env.WORKPILOT_DESKTOP_BINARY || resolve("target/release/workpilot-desktop.exe");
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  binarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
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
async function close() {
  if (child && child.exitCode === null) {
    const done = once(child, "exit");
    if (page)
      await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("exit_app")).catch(() => {});
    else child.kill();
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 10000);
    await done;
    clearTimeout(timer);
  }
  await browser?.close();
  child = browser = page = null;
}
async function openPanel(english = false) {
  await page.getByRole("button", { name: english ? "Settings" : "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: english ? "Settings" : "设置", exact: true });
  await dialog
    .locator("summary")
    .filter({ hasText: english ? "Task and assistant archive transfer" : "任务与助手档案迁移" })
    .click();
  return { dialog, box: dialog.locator(".task-archive-panel") };
}
try {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  child = spawn(binary, [], {
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      WORKPILOT_CHANNEL: "test",
      WORKPILOT_DATA_DIR: join(directory, "data"),
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
  page.on("pageerror", (e) => errors.push(String(e)));
  page.setDefaultTimeout(30000);
  await expect(page.getByText("引擎已连接", { exact: true })).toBeVisible();
  const root = await create({ request }, "responses", "archive-ui", {
    title: "桌面任务档案",
    controlled_tools: false,
  });
  assert.equal(
    (
      await request({
        kind: "configure_team",
        task_id: root,
        settings: {
          enabled: true,
          max_parallel: 3,
          max_members: 16,
          max_depth: 2,
          max_replacements: 2,
          revision: 0,
        },
      })
    ).kind,
    "receipt",
  );
  assert.equal(
    (
      await request({
        kind: "add_team_members",
        task_id: root,
        members: [
          {
            key: "checker",
            role: "资料核对",
            goal: "核对已保存的资料",
            profile_id: null,
            depends_on: [],
          },
        ],
      })
    ).kind,
    "receipt",
  );
  for (let i = 0; i < 20; i++)
    assert.equal(
      (await request({ kind: "enqueue", task_id: root, text: `排队消息 ${i + 1}：完整内容 42` }))
        .kind,
      "receipt",
    );
  const before = (await request({ kind: "read", query: { kind: "execution", task_id: root } }))
    .snapshot;
  const archive = join(directory, "桌面任务.wptask"),
    password = "desktop archive test passphrase";
  let { dialog, box } = await openPanel();
  await box.getByLabel("要备份的主任务", { exact: true }).selectOption(root);
  await box.getByLabel("档案保存位置", { exact: true }).fill(archive);
  await box.getByLabel("档案备份口令", { exact: true }).fill(password);
  await box.getByLabel("再次输入档案口令", { exact: true }).fill("different passphrase");
  await expect(box.getByRole("button", { name: "导出加密任务档案", exact: true })).toBeDisabled();
  await box.getByLabel("再次输入档案口令", { exact: true }).fill(password);
  await box.getByRole("button", { name: "导出加密任务档案", exact: true }).click();
  await expect(
    box.getByText("加密任务档案已保存。原任务保持不变。", { exact: true }),
  ).toBeVisible();
  await expect(box.getByLabel("档案备份口令", { exact: true })).toHaveValue("");
  const bytes = await readFile(archive);
  assert.equal(bytes.subarray(0, 8).toString(), "WPTASK01");
  report.checks.push(
    "native_desktop_password_confirmation_export_root_and_assistant_queue_original_unchanged",
  );

  await box.getByLabel("任务档案文件", { exact: true }).fill(archive);
  await box.getByLabel("档案解密口令", { exact: true }).fill("incorrect archive passphrase");
  await box.getByRole("button", { name: "核验并预览任务档案", exact: true }).click();
  await expect(box.getByRole("alert")).toContainText("口令错误");
  await box.getByLabel("档案解密口令", { exact: true }).fill(password);
  await box.getByRole("button", { name: "核验并预览任务档案", exact: true }).click();
  await expect(box.locator(".archive-summary")).toContainText("包含主任务及助手：2");
  await expect(box.locator(".archive-summary")).toContainText("用户消息：20");
  await box.getByRole("button", { name: "确认导入查阅档案", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "task-archive-preview-zh.png") });
  await box.getByRole("button", { name: "确认导入查阅档案", exact: true }).click();
  await expect(
    box.getByText("档案已保存，可在下方查阅。没有启动任何任务。", { exact: true }),
  ).toBeVisible();
  await expect(box.getByLabel("档案解密口令", { exact: true })).toHaveValue("");
  await expect(box.locator(".archive-record")).toHaveCount(16);
  await box.locator(".archive-record").first().locator("summary").first().click();
  await expect(box.locator(".archive-record").first().locator(".saved-content")).toContainText(
    "object_id",
  );
  const linked = box
    .locator(".archive-record")
    .first()
    .locator(".saved-content > details > summary");
  await linked.click();
  await expect(box.locator(".archive-record").first()).toContainText("排队消息 1：完整内容 42");
  await box.getByRole("button", { name: "下一页档案", exact: true }).click();
  await expect(box.locator(".archive-record")).toHaveCount(4);
  await box.getByLabel("记录类别", { exact: true }).selectOption("team_members");
  await expect(box.locator(".archive-record")).toHaveCount(1);
  await box.locator(".archive-record summary").first().click();
  await expect(box.locator(".archive-record")).toContainText("资料核对");
  assert.deepEqual(
    (await request({ kind: "read", query: { kind: "execution", task_id: root } })).snapshot,
    before,
  );
  assert(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 2));
  await page.screenshot({ path: join(output, "task-archive-read-zh.png") });
  report.checks.push(
    "wrong_password_then_preview_import_paginated_messages_linked_full_body_assistant_report_no_run_or_overflow",
  );

  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "English", exact: true }).click();
  ({ dialog, box } = await openPanel(true));
  await box.getByLabel("Task archive file", { exact: true }).fill(archive);
  await box.getByLabel("Archive import passphrase", { exact: true }).fill(password);
  await box.getByRole("button", { name: "Verify and preview task archive", exact: true }).click();
  await expect(
    box.getByText(
      "This archive is already imported; confirming again will not create a duplicate.",
      { exact: true },
    ),
  ).toBeVisible();
  await box
    .getByRole("button", { name: "Check existing archive", exact: true })
    .scrollIntoViewIfNeeded();
  assert(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 2));
  await page.screenshot({ path: join(output, "task-archive-en.png") });
  await box.getByRole("button", { name: "Check existing archive", exact: true }).click();
  await expect(
    box.getByText("Archive saved for reading below. No tasks were started.", { exact: true }),
  ).toBeVisible();
  const listing = await request({ kind: "task_archive", action: { kind: "list" } });
  assert.equal(listing.data.archives.length, 1);
  assert.equal(errors.length, 0, errors.join("\n"));
  report.checks.push("english_boundary_and_duplicate_preview_one_archive_no_javascript_errors");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
  await page?.screenshot({ path: join(output, "failure.png") }).catch(() => {});
} finally {
  await close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
