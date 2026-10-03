import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { create, until } from "./tool-test-support.mjs";
const output = resolve(
  process.env.WORKPILOT_TEST_OUTPUT || ".test-results/history-transfer-desktop",
);
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "session-")),
  folder = join(directory, "原项目"),
  target = join(directory, "新项目");
await mkdir(folder);
await mkdir(target);
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
const wb = async (task, action) => {
  const r = await request({ kind: "workbench", task_id: task, action });
  assert.equal(r.kind, "workbench", JSON.stringify(r));
  return r.data;
};
import assert from "node:assert/strict";
async function taskAt(folder, name) {
  const task = await create({ request }, "responses", name);
  assert.equal(
    (
      await request({
        kind: "configure_task_tools",
        task_id: task,
        settings: {
          root_path: folder,
          permission: "request_approval",
          commands_enabled: false,
          review_profile_id: null,
          revision: 0,
        },
      })
    ).kind,
    "receipt",
  );
  return task;
}
async function selectTask(task, english = false) {
  await page.evaluate((task) => localStorage.setItem("workpilot.execution", task), task);
  await page.reload();
  await page
    .getByRole("button", { name: english ? "Files and terminal" : "文件与终端", exact: true })
    .click();
  const panel = page.getByRole("dialog", {
    name: english ? "Files and terminal" : "文件与终端",
    exact: true,
  });
  await panel
    .getByRole("button", { name: english ? "File history" : "修改历史", exact: true })
    .click();
  await panel.locator(".history-transfer summary").click();
  return panel;
}
try {
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  child = spawn(binary, [], {
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
  page.on("pageerror", (e) => errors.push(String(e)));
  page.setDefaultTimeout(30000);
  await expect(page.getByText("引擎已连接", { exact: true })).toBeVisible();
  const sourceTask = await taskAt(folder, "history-export-ui");
  await writeFile(join(folder, "notes.txt"), "original UI content\n");
  const initial = await wb(sourceTask, { kind: "read_file", path: "notes.txt" });
  const change = await wb(sourceTask, {
    kind: "edit",
    edit: {
      kind: "save",
      path: "notes.txt",
      expected: initial.version,
      text: "changed UI content\n",
    },
  });
  await wb(sourceTask, {
    kind: "approve",
    operation_id: change.operation.id,
    fingerprint: change.operation.fingerprint,
  });
  await until(async () =>
    (await wb(sourceTask, { kind: "operations" })).items.some(
      (r) => r.operation.id === change.operation.id && r.operation.state === "completed",
    ),
  );
  let panel = await selectTask(sourceTask);
  const transfer = panel.locator(".history-transfer");
  await transfer.getByRole("checkbox").first().check();
  const archive = join(directory, "界面 备份.wphistory"),
    password = "native fixture passphrase";
  await transfer.getByLabel("备份保存位置", { exact: true }).fill(archive);
  await transfer.getByLabel("设置备份口令", { exact: true }).fill(password);
  await transfer.getByLabel("再次输入备份口令", { exact: true }).fill(password);
  await transfer.getByRole("button", { name: "保存加密备份", exact: true }).click();
  await expect(transfer.getByRole("status")).toHaveText("加密历史备份已保存。");
  await expect(transfer.getByLabel("设置备份口令", { exact: true })).toHaveValue("");
  assert(!(await readFile(archive)).includes(Buffer.from(password)));
  report.checks.push("native_ui_selects_revisions_exports_encrypted_file_and_clears_passphrase");
  await panel.getByRole("button", { name: "返回对话", exact: true }).click();
  const targetTask = await taskAt(target, "history-import-ui");
  await writeFile(join(target, "notes.txt"), "keep current user file\n");
  panel = await selectTask(targetTask);
  let importer = panel.locator(".history-transfer");
  await importer.getByLabel("历史备份文件", { exact: true }).fill(archive);
  await importer.getByLabel("输入备份口令", { exact: true }).fill("wrong fixture passphrase");
  await importer.getByRole("button", { name: "预览备份", exact: true }).click();
  await expect(importer.getByRole("alert")).toContainText("口令错误");
  await importer.getByLabel("输入备份口令", { exact: true }).fill(password);
  await importer.getByRole("button", { name: "预览备份", exact: true }).click();
  await expect(importer.getByRole("region", { name: "历史导入预览" })).toContainText(
    "已有同名文件，将保留",
  );
  assert.equal(
    (await wb(targetTask, { kind: "history", path: null, before: null, limit: 100 })).items.length,
    0,
  );
  await importer.getByRole("region", { name: "历史导入预览" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "history-import-zh.png") });
  await importer.getByRole("button", { name: "确认导入历史", exact: true }).click();
  await expect(importer.getByRole("status")).toContainText("历史已导入");
  await expect(importer.getByLabel("输入备份口令", { exact: true })).toHaveValue("");
  assert.equal(await readFile(join(target, "notes.txt"), "utf8"), "keep current user file\n");
  await expect(panel.locator(".file-history-row")).toHaveCount(1);
  await panel.locator(".file-history-row").first().click();
  await panel.getByRole("button", { name: "恢复修改前版本", exact: true }).click();
  await expect(panel.getByRole("button", { name: "确认执行", exact: true })).toBeVisible();
  assert.equal(await readFile(join(target, "notes.txt"), "utf8"), "keep current user file\n");
  await panel.getByRole("button", { name: "确认执行", exact: true }).click();
  await expect
    .poll(() => readFile(join(target, "notes.txt"), "utf8"))
    .toBe("original UI content\n");
  report.checks.push(
    "wrong_password_rejected_preview_precedes_import_existing_file_preserved_restore_requires_approval",
  );
  await panel.getByRole("button", { name: "返回对话", exact: true }).click();
  await page.getByRole("button", { name: "English", exact: true }).click();
  panel = await selectTask(targetTask, true);
  importer = panel.locator(".history-transfer");
  await importer.getByLabel("History backup file", { exact: true }).fill(archive);
  await importer.getByLabel("Enter backup passphrase", { exact: true }).fill(password);
  await importer.getByRole("button", { name: "Preview backup", exact: true }).click();
  await expect(importer.getByRole("region", { name: "History import preview" })).toContainText(
    "Already imported",
  );
  await expect(
    importer.getByRole("button", { name: "Confirm history import", exact: true }),
  ).toHaveCount(0);
  assert(await panel.evaluate((e) => e.scrollWidth <= e.clientWidth + 2));
  await importer.getByRole("region", { name: "History import preview" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "history-import-en.png") });
  assert.equal(errors.length, 0, errors.join("\n"));
  report.checks.push("english_preview_no_duplicate_import_and_no_horizontal_overflow");
  const exit = once(child, "exit");
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("exit_app")).catch(() => {});
  await exit;
  report.checks.push("native_application_exits_cleanly");
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = String(e.stack || e);
  process.exitCode = 1;
  await page?.screenshot({ path: join(output, "failure.png") }).catch(() => {});
} finally {
  if (child && child.exitCode === null) {
    const exit = once(child, "exit");
    await page?.evaluate(() => window.__TAURI_INTERNALS__.invoke("exit_app")).catch(() => {});
    if (child.exitCode === null) child.kill();
    await exit;
  }
  await browser?.close().catch(() => {});
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
