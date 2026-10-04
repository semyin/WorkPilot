import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { until, create, snapshot, start, terminal, setFixture } from "./tool-test-support.mjs";
import { media, uploadMedia } from "./media-transfer-support.mjs";
import { startExecutionFixture } from "../services/execution-fixtures/server.mjs";

const output = resolve(
  process.env.WORKPILOT_TEST_OUTPUT || ".test-results/task-media-restore-desktop",
);
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
  service: "Native Windows WebView2 and local synthetic model",
  checks: [],
};
let sourceNote;
const fixture = await startExecutionFixture((body, results) => {
  if (JSON.stringify(body).includes("RESTORED_QUEUE")) {
    if (!results.length)
      return {
        text: "",
        calls: [{ name: "document_read", args: { asset_id: sourceNote.id, start: 0, limit: 3 } }],
      };
    assert(JSON.stringify(results).includes("桌面附件原文 007"));
  }
  return {
    text: JSON.stringify(body).includes("RESTORED_QUEUE")
      ? "恢复后处理排队要求完成 007"
      : "恢复前保存的回答 42",
    calls: [],
  };
});
setFixture(fixture);
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
const archive = async (action) => {
  const r = await request({ kind: "task_archive", action });
  assert.equal(r.kind, "workbench", JSON.stringify(r));
  return r.data;
};
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
}
async function panel(english = false) {
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
  const engine = { request };
  const task = await create(engine, "responses", "restore-desktop", {
    title: "可继续的迁入任务",
    controlled_tools: false,
  });
  sourceNote = await uploadMedia(request, task, "原资料.txt", Buffer.from("桌面附件原文 007"));
  await uploadMedia(request, task, "尚未发送.txt", Buffer.from("只保留在附件库"));
  const removed = await uploadMedia(request, task, "已移除.txt", Buffer.from("已移除的资料"));
  await request({
    kind: "enqueue",
    task_id: task,
    text: "原有用户要求 42 [workpilot-file:" + sourceNote.id + "]",
  });
  await start(engine, task);
  assert.equal((await terminal(engine, task)).task.state, "completed");
  await media(request, task, { kind: "remove", asset_id: removed.id });
  await request({ kind: "enqueue", task_id: task, text: "下一步 RESTORED_QUEUE" });
  const source = await snapshot(engine, task);
  const path = join(directory, "桌面恢复.wptask"),
    password = "desktop restoration " + crypto.randomUUID();
  await archive({ kind: "export", task_id: task, path, password });
  const inspected = await archive({ kind: "inspect", path, password });
  const imported = await archive({
    kind: "import",
    path,
    password,
    fingerprint: inspected.fingerprint,
  });
  let { dialog, box } = await panel();
  await box.getByLabel("选择查阅档案", { exact: true }).selectOption(imported.archive_id);
  let restore = box.getByRole("region", { name: "从档案恢复任务", exact: true });
  await expect(restore.getByRole("button", { name: "预览任务恢复", exact: true })).toBeDisabled();
  await restore
    .getByLabel("恢复使用的模型", { exact: true })
    .selectOption(source.config.profile_id);
  await restore.getByRole("button", { name: "预览任务恢复", exact: true }).click();
  await expect(restore.locator(".archive-summary")).toContainText("排队消息：1", {
    timeout: 100000,
  });
  await expect(restore.locator(".archive-summary")).toContainText("已完成");
  await restore
    .getByRole("button", { name: "确认恢复为新任务", exact: true })
    .scrollIntoViewIfNeeded();
  assert(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 2));
  await page.screenshot({ path: join(output, "task-restore-preview-zh.png") });
  report.checks.push(
    "native_chinese_preview_retained_messages_manual_resume_and_permission_boundary",
  );
  const attachmentList = restore.getByRole("region", { name: "随任务恢复的附件", exact: true });
  await expect(attachmentList).toContainText("原资料.txt");
  await expect(attachmentList).toContainText("尚未发送.txt");
  await expect(attachmentList).toContainText("已移除，保留历史");
  await attachmentList.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "attachment-preview-zh.png") });
  const count = fixture.records.length;
  await restore.getByRole("button", { name: "确认恢复为新任务", exact: true }).click();
  await expect(restore.getByRole("button", { name: "打开恢复的任务", exact: true })).toBeVisible({
    timeout: 100000,
  });
  assert.equal(fixture.records.length, count);
  const saved = await archive({
    kind: "restore_preview",
    archive_id: imported.archive_id,
    project_id: null,
    profile_id: source.config.profile_id,
  });
  assert(saved.already_restored);
  await restore.getByRole("button", { name: "打开恢复的任务", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.locator(".conversation").getByText("恢复前保存的回答 42", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".conversation").getByText(/原有用户要求 42/)).toBeVisible();
  await page.screenshot({ path: join(output, "task-restore-conversation-zh.png") });
  await page.getByRole("button", { name: "文件成果与图片", exact: true }).click();
  const files = page.getByRole("dialog", { name: "文件成果与图片", exact: true });
  await expect(files.locator(".media-card")).toHaveCount(2);
  await files.getByRole("button", { name: "原资料.txt", exact: true }).click();
  await expect(files.locator(".media-detail")).toContainText("桌面附件原文 007");
  await expect(files.locator(".media-list")).not.toContainText("已移除.txt");
  await page.screenshot({ path: join(output, "attachment-original-zh.png") });
  await files.getByRole("button", { name: "关闭", exact: true }).click();
  report.checks.push(
    "restored_attachment_original_readable_unsent_preserved_removed_hidden_in_native_panel",
  );
  await page.getByRole("button", { name: "继续任务", exact: true }).click();
  await expect(
    page.locator(".conversation").getByText("恢复后处理排队要求完成 007", { exact: true }),
  ).toBeVisible();
  assert.equal((await snapshot(engine, saved.task_id)).task.state, "completed");
  assert.deepEqual(await snapshot(engine, task), source);
  report.checks.push(
    "confirm_creates_new_task_without_network_open_conversation_and_click_continue_delivers_saved_queue",
  );

  await page.getByRole("button", { name: "English", exact: true }).click();
  ({ dialog, box } = await panel(true));
  await box.getByLabel("Select archive to read", { exact: true }).selectOption(imported.archive_id);
  restore = box.getByRole("region", { name: "Restore task from archive", exact: true });
  await restore
    .getByLabel("Model for restoration", { exact: true })
    .selectOption(source.config.profile_id);
  await restore.getByRole("button", { name: "Preview task restoration", exact: true }).click();
  await expect(restore).toContainText("Repeating this action creates no duplicate");
  await restore
    .getByRole("button", { name: "Open restored task", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "task-restore-duplicate-en.png") });
  assert(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 2));
  await restore.getByRole("button", { name: "Open restored task", exact: true }).click();
  const englishArchive = join(directory, "english-attachments.wptask");
  await archive({ kind: "export", task_id: saved.task_id, path: englishArchive, password });
  const ep = await archive({ kind: "inspect", path: englishArchive, password });
  const ei = await archive({
    kind: "import",
    path: englishArchive,
    password,
    fingerprint: ep.fingerprint,
  });
  ({ dialog, box } = await panel(true));
  await box.getByLabel("Select archive to read", { exact: true }).selectOption(ei.archive_id);
  restore = box.getByRole("region", { name: "Restore task from archive", exact: true });
  await restore
    .getByLabel("Model for restoration", { exact: true })
    .selectOption(source.config.profile_id);
  await restore.getByRole("button", { name: "Preview task restoration", exact: true }).click();
  const enAttachments = restore.getByRole("region", {
    name: "Attachments restored with tasks",
    exact: true,
  });
  await expect(enAttachments).toContainText("Removed; history preserved", { timeout: 100000 });
  await enAttachments.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "attachment-preview-en.png") });
  assert.equal(errors.length, 0, errors.join("\n"));
  report.checks.push("english_idempotent_receipt_no_overflow_and_no_javascript_errors");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
  await page?.screenshot({ path: join(output, "failure.png") }).catch(() => {});
} finally {
  await close();
  await fixture.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
