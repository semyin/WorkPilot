import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { until, create } from "./tool-test-support.mjs";
import { project, saveFile, history } from "./task-history-support.mjs";
const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/maintenance-desktop");
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
    await page?.evaluate(() => window.__TAURI_INTERNALS__.invoke("exit_app")).catch(() => {});
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 10000);
    await done;
    clearTimeout(timer);
  }
  await browser?.close();
}
async function launch() {
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
  await until(
    async () =>
      (
        await page.evaluate(() =>
          window.__TAURI_INTERNALS__.invoke("engine_snapshot", { after: 0 }),
        )
      ).alive,
  );
}
async function panel(en = false) {
  await page.getByRole("button", { name: en ? "Settings" : "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: en ? "Settings" : "设置", exact: true });
  await dialog
    .locator("summary")
    .filter({ hasText: en ? "Data maintenance and reset" : "数据清理与恢复初始状态" })
    .click();
  return dialog.getByRole("region", { name: en ? "Data maintenance" : "数据清理", exact: true });
}
try {
  await launch();
  const e = { request },
    folder = join(directory, "project");
  const pid = await project(e, "Retention UI", folder);
  const task = await create(e, "responses", "UI maintenance", { project_id: pid });
  await saveFile(e, task, "kept.txt", "first");
  await saveFile(e, task, "kept.txt", "second");
  await saveFile(e, task, "kept.txt", "current");
  let box = await panel();
  await box.getByLabel("清理范围", { exact: true }).selectOption("versions");
  const root = (await history(e, task))[0].root_identity;
  await box.getByLabel(/文件历史位置/).selectOption(root);
  await box.getByLabel("每个文件至少保留版本数").fill("1");
  await box.getByLabel("仅清理多少天前的版本").fill("0");
  await box.getByRole("button", { name: "预览清理范围", exact: true }).click();
  const confirm = box.getByRole("button", { name: "确认并停止引擎进行清理", exact: true });
  await expect(confirm).toBeDisabled();
  const backup = join(directory, "ui-history.wphistory");
  await box.getByLabel("版本备份位置", { exact: true }).fill(backup);
  await box.getByLabel(/备份口令/).fill("fixture UI passphrase 42");
  await box.getByLabel("输入确认文字", { exact: true }).fill("DELETE");
  await expect(confirm).toBeEnabled();
  await page.screenshot({ path: join(output, "retention-preview-zh.png"), fullPage: true });
  assert.equal((await history(e, task)).length, 3);
  await confirm.click();
  await expect(box.getByRole("status")).toContainText("处理完成", { timeout: 120000 });
  await expect(box.getByRole("button", { name: "重新启动 WorkPilot", exact: true })).toBeVisible();
  // Stay beyond the former overview polling interval: intentional maintenance
  // must not turn into a reconnect alert or restart the normal task workspace.
  await page.waitForTimeout(2300);
  await expect(page.locator(".workspace-connection-error")).toHaveCount(0);
  await expect(page.getByRole("main", { name: "维护状态" })).toContainText("维护流程已结束");
  assert.equal(await readFile(join(folder, "kept.txt"), "utf8"), "current");
  await page.screenshot({ path: join(output, "retention-complete-zh.png"), fullPage: true });
  report.checks.push(
    "native_retention_preview_password_confirmation_stops_engine_and_keeps_project_file",
  );
  await close();
  await launch();
  assert.equal((await history(e, task)).length, 1);
  const overview = await request({
    kind: "read",
    query: { kind: "workspace", query: { kind: "overview" } },
  });
  const saved = await request({
    kind: "workspace",
    action: {
      kind: "save_preferences",
      preferences: { ...overview.data.preferences, language: "en" },
    },
  });
  assert.notEqual(saved.kind, "error", JSON.stringify(saved));
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  box = await panel(true);
  await box.getByLabel("Cleanup scope", { exact: true }).selectOption("reset");
  await box.getByRole("button", { name: "Preview cleanup", exact: true }).click();
  await expect(
    box.getByRole("button", { name: "Confirm, stop engine and clean up", exact: true }),
  ).toBeDisabled();
  await expect(box).toContainText("Project files and other data directories remain");
  await page.screenshot({ path: join(output, "reset-preview-en.png"), fullPage: true });
  report.checks.push(
    "restart_retains_latest_history_english_reset_preview_needs_explicit_confirmation",
  );
  assert.deepEqual(errors, []);
  report.passed = true;
} catch (e) {
  report.passed = false;
  report.error = String(e.stack || e);
  process.exitCode = 1;
  await page?.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => {});
} finally {
  await close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
