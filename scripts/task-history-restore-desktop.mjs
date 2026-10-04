import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { until, create, snapshot, start, terminal, setFixture } from "./tool-test-support.mjs";
import { project, wb, saveFile, history, importArchive } from "./task-history-support.mjs";
import { startExecutionFixture } from "../services/execution-fixtures/server.mjs";

const output = resolve(
  process.env.WORKPILOT_TEST_OUTPUT || ".test-results/task-history-restore-desktop",
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
const fixture = await startExecutionFixture((body) => ({
  text: JSON.stringify(body).includes("RESTORED_QUEUE")
    ? "恢复后处理排队要求完成 007"
    : "恢复前保存的回答 42",
  calls: [],
}));
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

  const sourceFolder = join(directory, "原项目"),
    targetFolder = join(directory, "目标项目");
  const sourceProject = await project(engine, "原项目", sourceFolder);
  const targetProject = await project(engine, "恢复目标项目", targetFolder);
  const task = await create(engine, "responses", "history-desktop", {
    title: "带历史的迁入任务",
    project_id: sourceProject,
    controlled_tools: false,
  });
  await request({ kind: "enqueue", task_id: task, text: "保存项目的两个历史版本" });
  await start(engine, task);
  assert.equal((await terminal(engine, task)).task.state, "completed");
  const name = "计划说明.txt";
  await saveFile(engine, task, name, "第一版内容 42");
  await saveFile(engine, task, name, "第二版内容 007");
  await writeFile(join(targetFolder, name), "目标项目的当前内容");
  const source = await snapshot(engine, task);
  const path = join(directory, "桌面文件历史.wptask"),
    password = "desktop history " + crypto.randomUUID();
  await archive({ kind: "export", task_id: task, path, password });
  const imported = await importArchive(engine, path, password);
  let { dialog, box } = await panel();
  await box.getByLabel("选择查阅档案", { exact: true }).selectOption(imported);
  let restore = box.getByRole("region", { name: "从档案恢复任务", exact: true });
  await restore
    .getByLabel("恢复使用的模型", { exact: true })
    .selectOption(source.config.profile_id);
  await restore.getByLabel("恢复到项目", { exact: true }).selectOption(targetProject);
  await restore.getByRole("button", { name: "预览任务恢复", exact: true }).click();
  const list = restore.getByRole("region", { name: "随任务恢复的文件历史", exact: true });
  await expect(list.getByRole("listitem")).toHaveCount(2, { timeout: 100000 });
  await expect(list).toContainText(name);
  await expect(list).toContainText("不覆盖当前文件");
  await list.scrollIntoViewIfNeeded();
  assert(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 2));
  await page.screenshot({ path: join(output, "history-preview-zh.png") });
  const calls = fixture.records.length;
  await restore.getByRole("button", { name: "确认恢复为新任务", exact: true }).click();
  await expect(restore.getByRole("button", { name: "打开恢复的任务", exact: true })).toBeVisible({
    timeout: 100000,
  });
  const receipt = await archive({
    kind: "restore_preview",
    archive_id: imported,
    project_id: targetProject,
    profile_id: source.config.profile_id,
  });
  assert(receipt.already_restored);
  assert.equal(await readFile(join(targetFolder, name), "utf8"), "目标项目的当前内容");
  assert.equal(fixture.records.length, calls);
  report.checks.push(
    "native_chinese_preview_shows_both_versions_explicit_project_and_import_preserves_current_file_without_model_calls",
  );
  await restore.getByRole("button", { name: "打开恢复的任务", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "文件与终端", exact: true }).click();
  const files = page.getByRole("dialog", { name: "文件与终端", exact: true });
  await files.getByRole("button", { name: "修改历史", exact: true }).click();
  await expect(files.locator(".file-history-row")).toHaveCount(2);
  await files.locator(".file-history-row").first().click();
  await expect(files.locator(".file-diff")).toContainText("第一版内容 42");
  await expect(files.locator(".file-diff")).toContainText("第二版内容 007");
  await expect(files.locator(".file-history-row").first()).toContainText("导入来源任务");
  await expect(files.locator(".file-history-row").first()).toContainText("任务恢复");
  await files.getByRole("button", { name: "恢复修改前版本", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "history-diff-zh.png") });
  await files.getByRole("button", { name: "恢复修改前版本", exact: true }).click();
  await expect(files.getByRole("button", { name: "确认执行", exact: true })).toBeVisible();
  assert.equal(await readFile(join(targetFolder, name), "utf8"), "目标项目的当前内容");
  await files.getByRole("button", { name: "确认执行", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "history-approval-zh.png") });
  await files.getByRole("button", { name: "确认执行", exact: true }).click();
  await until(async () => (await readFile(join(targetFolder, name), "utf8")) === "第一版内容 42");
  const rows = await history(engine, receipt.task_id);
  assert.equal(rows.length, 3);
  const preserved = await wb(engine, receipt.task_id, {
    kind: "revision",
    revision_id: rows[0].id,
  });
  assert.equal(preserved.before.text, "目标项目的当前内容");
  assert.equal(await readFile(join(sourceFolder, name), "utf8"), "第二版内容 007");
  report.checks.push(
    "native_history_diff_provenance_approved_restore_and_replaced_current_content_preserved_source_unchanged",
  );
  await files.getByRole("button", { name: "返回对话", exact: true }).click();
  await page.getByRole("button", { name: "English", exact: true }).click();
  const secondPath = join(directory, "english-history.wptask");
  await archive({ kind: "export", task_id: receipt.task_id, path: secondPath, password });
  const second = await importArchive(engine, secondPath, password);
  ({ dialog, box } = await panel(true));
  await box.getByLabel("Select archive to read", { exact: true }).selectOption(second);
  restore = box.getByRole("region", { name: "Restore task from archive", exact: true });
  await restore
    .getByLabel("Model for restoration", { exact: true })
    .selectOption(source.config.profile_id);
  await restore.getByLabel("Restore into project", { exact: true }).selectOption(targetProject);
  await restore.getByRole("button", { name: "Preview task restoration", exact: true }).click();
  const english = restore.getByRole("region", {
    name: "File history restored with tasks",
    exact: true,
  });
  await expect(english.getByRole("listitem")).toHaveCount(3, { timeout: 100000 });
  await expect(english).toContainText("without overwriting current files");
  await english.scrollIntoViewIfNeeded();
  assert(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 2));
  await page.screenshot({ path: join(output, "history-preview-en.png") });
  assert.equal(errors.length, 0, errors.join("\n"));
  report.checks.push(
    "english_second_archive_preview_has_three_versions_no_horizontal_overflow_or_javascript_errors",
  );
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
