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

const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/migration-desktop");
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
const fixture = await startExecutionFixture((body, results) =>
  body.model === "native-migration-pending" && !results.length
    ? {
        text: "",
        calls: [
          {
            name: "write_file",
            args: { path: "pending.txt", text: "old action", expected_sha256: null },
          },
        ],
      }
    : { text: "Native migration fixture 42", calls: [] },
);
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
    targetFolder = join(directory, "新 项目");
  const sourceProject = await project(engine, "完整迁移原项目", sourceFolder);
  await mkdir(targetFolder, { recursive: true });
  const task = await create(engine, "responses", "native-migration", {
    project_id: sourceProject,
    controlled_tools: false,
  });
  await start(engine, task);
  await terminal(engine, task, ["completed"]);
  await saveFile(engine, task, "资料.txt", "Migration file before 42");
  await saveFile(engine, task, "资料.txt", "Migration file after 007");
  const pending = await create(engine, "responses", "native-migration-pending", {
    project_id: sourceProject,
    controlled_tools: false,
  });
  assert.equal(
    (
      await request({
        kind: "configure_task_tools",
        task_id: pending,
        settings: {
          permission: "request_approval",
          root_path: sourceFolder,
          commands_enabled: false,
          revision: 0,
        },
      })
    ).kind,
    "receipt",
  );
  await start(engine, pending);
  await terminal(engine, pending, ["awaiting_approval"]);
  const first = await snapshot(engine, task),
    second = await snapshot(engine, pending);
  const password = "Native full migration " + crypto.randomUUID(),
    path = join(directory, "完整备份.wpmigrate");
  const exported = await request({
    kind: "migration",
    action: {
      kind: "export",
      path,
      password,
      selections: [
        {
          project_id: sourceProject,
          profile_ids: [first.config.profile_id, second.config.profile_id],
          memory_ids: [],
          task_ids: [task, pending],
          files: ["资料.txt"],
          extensions: [],
          draft_ids: [],
        },
      ],
    },
  });
  assert.equal(exported.kind, "workbench", JSON.stringify(exported));
  const migrationId = exported.data.summary.archive_id;
  const calls = fixture.records.length;
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await dialog.locator("summary").filter({ hasText: "完整资料迁移" }).click();
  const box = dialog
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "完整资料迁移" }) })
    .first();
  await box.getByLabel("迁移包完整路径（.wpmigrate）", { exact: true }).fill(path);
  await box.getByLabel("口令（至少 12 个字符）", { exact: true }).fill(password);
  await box.getByRole("button", { name: "读取并核验迁移包", exact: true }).click();
  await expect(box.getByLabel("目标文件夹", { exact: true })).toBeVisible({ timeout: 100000 });
  await box.getByLabel("目标文件夹", { exact: true }).fill(targetFolder);
  await box.getByRole("button", { name: "预览全部导入", exact: true }).click();
  await expect(box.getByRole("button", { name: "确认导入新项目与记录", exact: true })).toBeEnabled({
    timeout: 100000,
  });
  await box
    .getByRole("button", { name: "确认导入新项目与记录", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "migration-preview-zh.png") });
  await box.getByRole("button", { name: "确认导入新项目与记录", exact: true }).click();
  await expect(box.getByText("记录已导入，文件等待审批", { exact: false })).toBeVisible({
    timeout: 100000,
  });
  assert.equal(fixture.records.length, calls);
  const result = await request({
    kind: "migration",
    action: { kind: "status", archive_id: migrationId },
  });
  assert.equal(result.kind, "workbench");
  const receipt = result.data;
  const mapped = Object.values(receipt.tasks).flatMap((t) => t.tasks);
  const nextPending = mapped.find((t) => t.source_task_id === pending).task_id;
  await page.screenshot({ path: join(output, "migration-imported-zh.png") });
  report.checks.push(
    "Native unified import previews exact project location, restores both tasks and history without model calls, leaves current files awaiting separate approval",
  );
  const openButtons = box.getByRole("button", { name: "打开恢复任务", exact: true });
  const pendingIndex = Object.values(receipt.tasks).findIndex((t) => t.task_id === nextPending);
  await openButtons.nth(pendingIndex).click();
  await expect(dialog).toHaveCount(0);
  const review = page.getByRole("region", { name: "迁入操作核对", exact: true });
  await expect(review).toBeVisible({ timeout: 30000 });
  const notes = review.locator("textarea");
  const count = await notes.count();
  assert(count >= 2);
  await expect(
    review.getByRole("button", { name: "保存核对说明；稍后手动继续", exact: true }),
  ).toBeDisabled();
  for (let i = 0; i < count; i++)
    await notes
      .nth(i)
      .fill("已检查原目录和新目录；原写入尚未执行。后续须先核对目标，再提出新的审批。");
  await review.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "migration-review-zh.png") });
  await review.getByRole("button", { name: "保存核对说明；稍后手动继续", exact: true }).click();
  await expect(review).toHaveCount(0);
  assert.equal(fixture.records.length, calls);
  report.checks.push(
    "Native unresolved-action panel lists original records, requires one explanation per item and persists user review without starting the model",
  );
  await page.getByRole("button", { name: "English", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const english = page.getByRole("dialog", { name: "Settings", exact: true });
  await english.locator("summary").filter({ hasText: "Complete data migration" }).click();
  await expect(english.getByText("Select data to migrate", { exact: true })).toBeVisible();
  await english.getByLabel("Full archive path (.wpmigrate)", { exact: true }).fill(path);
  await english.getByLabel("Passphrase (at least 12 characters)", { exact: true }).fill(password);
  await english.getByRole("button", { name: "Read and verify archive", exact: true }).click();
  await expect(english.getByLabel("Destination folder", { exact: true })).toBeVisible({
    timeout: 100000,
  });
  await english.getByLabel("Destination folder", { exact: true }).scrollIntoViewIfNeeded();
  assert(await english.evaluate((e) => e.scrollWidth <= e.clientWidth + 2));
  await page.screenshot({ path: join(output, "migration-summary-en.png") });
  assert.equal(errors.length, 0, errors.join("\n"));
  report.checks.push(
    "English unified migration renders project, model and history mapping without horizontal overflow or JavaScript errors",
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
