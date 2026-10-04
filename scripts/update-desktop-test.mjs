import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, copyFile, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { until, create, snapshot, start, setFixture } from "./tool-test-support.mjs";
import { startExecutionFixture } from "../services/execution-fixtures/server.mjs";
import { packageUpdate } from "./update-package.mjs";

const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/update-desktop");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "signed-update-"));
const supplied = resolve(
  process.env.WORKPILOT_DESKTOP_BINARY || "target/release/workpilot-desktop.exe",
);
const engineBinary = resolve(
  process.env.WORKPILOT_ENGINE_BINARY || join(dirname(supplied), "workpilot-sidecar.exe"),
);
const helper = resolve(
  process.env.WORKPILOT_UPDATE_BINARY || join(dirname(supplied), "workpilot-update.exe"),
);
const current = JSON.parse(await readFile("package.json", "utf8")).version;
const future = current + ".1";
const appDir = join(directory, "app");
await mkdir(appDir);
for (const [source, name] of [
  [supplied, "workpilot-desktop.exe"],
  [engineBinary, "workpilot-sidecar.exe"],
  [helper, "workpilot-update.exe"],
])
  await copyFile(source, join(appDir, name));
const binary = join(appDir, "workpilot-desktop.exe");
const file = join(directory, "next.wpupdate");
await packageUpdate({
  source: appDir,
  output: file,
  privateKey:
    process.env.WORKPILOT_UPDATE_SIGNING_KEY ||
    resolve(".local/update-signing/development-private.pem"),
  version: future,
  notes: "测试更新：签名正确，故意设置与实际引擎不同的版本，验证失败保护。",
  tools: ["No external plugin replacement"],
});
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  binarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  boundary:
    "Real native desktop, isolated install/data, genuine signed future-version package deliberately incompatible with actual engine; shutdown targets only the spawned test child, not user app processes",
  checks: [],
};
let calls = 0;
const fixture = await startExecutionFixture(() => {
  calls++;
  return { text: "should be interrupted", calls: [], delay: 60000 };
});
setFixture(fixture);
let child, browser, page;
const errors = [];
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
  }, 45000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = await until(async () =>
    browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => /tauri\.localhost|tauri:/.test(p.url())),
  );
  page.setDefaultTimeout(30000);
  page.on("pageerror", (e) => errors.push(String(e)));
  await expect(page.getByText(/^(引擎已连接|Engine connected)$/)).toBeVisible();
}
const request = (command) =>
  page.evaluate(
    (command) =>
      window.__TAURI_INTERNALS__.invoke("engine_command", {
        request: { request_id: crypto.randomUUID(), command },
      }),
    command,
  );
async function panel(english = false) {
  await page.getByRole("button", { name: english ? "Settings" : "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: english ? "Settings" : "设置", exact: true });
  await dialog
    .locator("summary")
    .filter({ hasText: english ? "Software update" : "软件更新" })
    .click();
  return {
    dialog,
    box: dialog.getByRole("region", {
      name: english ? "Check and install updates" : "检查与安装更新",
      exact: true,
    }),
  };
}
async function close() {
  if (child?.exitCode === null) {
    const done = once(child, "exit");
    await page?.evaluate(() => window.__TAURI_INTERNALS__.invoke("exit_app")).catch(() => {});
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 10000);
    await done;
    clearTimeout(timer);
  }
  await browser?.close().catch(() => {});
}
try {
  await launch();
  const engine = { request };
  const task = await create(engine, "responses", "update-stop-fixture");
  let { dialog, box } = await panel();
  await box.getByLabel("更新源或本机更新包", { exact: true }).fill(file);
  await box.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(box.getByText(`${current} → ${future}`, { exact: true })).toBeVisible({
    timeout: 60000,
  });
  await expect(box.getByText("签名已核验：", { exact: false })).toBeVisible();
  await box.getByRole("button", { name: "下载并核验完整更新", exact: true }).click();
  await expect(box.getByRole("button", { name: "退出并安装更新", exact: true })).toBeVisible({
    timeout: 120000,
  });
  await expect(box.getByRole("button", { name: "退出并安装更新", exact: true })).toBeDisabled();
  const recoveryEntry = box.locator(".update-recovery-entry");
  await expect(recoveryEntry).toContainText("打不开软件时的恢复入口");
  const recoveryExecutable = await recoveryEntry.locator("p").last().innerText();
  assert.equal(
    createHash("sha256")
      .update(await readFile(recoveryExecutable))
      .digest("hex"),
    createHash("sha256")
      .update(await readFile(helper))
      .digest("hex"),
  );
  assert(await recoveryEntry.evaluate((e) => e.scrollWidth <= e.clientWidth + 2));
  await recoveryEntry.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "update-confirmation-zh.png") });
  report.checks.push("native_signed_preview_full_prepare_requires_separate_explicit_confirmation");
  await request({ kind: "enqueue", task_id: task, text: "保持任务运行以验证更新协调" });
  await start(engine, task);
  await until(async () => (await snapshot(engine, task)).task.state === "running");
  await until(async () => calls === 1);
  await box.getByLabel("我确认停止任务、备份数据并立即安装", { exact: true }).check();
  const exiting = once(child, "exit");
  await box
    .getByRole("button", { name: "退出并安装更新", exact: true })
    .click()
    .catch(() => {});
  await exiting;
  await browser.close().catch(() => {});
  browser = null;
  const job = await until(async () =>
    (await readdir(directory)).find((name) => /^\.workpilot-update-[0-9a-f-]{36}$/.test(name)),
  );
  const result = await until(async () => {
    try {
      return JSON.parse(await readFile(join(directory, job, "update-result.json"), "utf8"));
    } catch {
      return false;
    }
  }, 120000);
  assert.equal(result.state, "failed");
  assert.equal(
    createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
    report.binarySha256,
  );
  await launch();
  const recovered = await snapshot(engine, task);
  assert.equal(recovered.task.state, "interrupted");
  assert.equal(calls, 1);
  ({ dialog, box } = await panel());
  await box.locator("summary").filter({ hasText: "上次更新与保留副本" }).click();
  await expect(box).toContainText("上次更新没有完成，已恢复原程序与原数据");
  await box.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "update-failure-recovered-zh.png") });
  report.checks.push(
    "confirmed_update_stops_real_active_task_and_failed_migration_restores_original_install_data_without_auto_resume",
  );
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "English", exact: true }).click();
  ({ dialog, box } = await panel(true));
  await expect(box.getByRole("button", { name: "Check update", exact: true })).toBeVisible();
  assert(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 2));
  await box.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "update-en.png") });
  assert.equal(errors.length, 0, errors.join("\n"));
  report.checks.push("english_update_controls_recovery_result_and_no_horizontal_overflow");
  if (!process.env.WORKPILOT_UPDATE_SKIP_BACKUP_UI) {
    const backups = box.getByRole("region", { name: "Update recovery copies", exact: true });
    await backups.getByRole("button", { name: "Preview recovery cleanup", exact: true }).click();
    const confirmDelete = backups.getByLabel("Confirm recovery copy deletion", { exact: true });
    await expect(confirmDelete).toBeVisible({ timeout: 120000 });
    await expect(
      backups.getByRole("button", { name: "Stop tasks and delete these copies", exact: true }),
    ).toBeDisabled();
    const kept = join(directory, "data/test/user-added-marker.txt");
    await writeFile(kept, "current data remains");
    await confirmDelete.fill("DELETE");
    assert(await backups.evaluate((e) => e.scrollWidth <= e.clientWidth + 2));
    await backups.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(output, "update-backup-cleanup-preview-en.png") });
    await backups
      .getByRole("button", { name: "Stop tasks and delete these copies", exact: true })
      .click();
    await expect(backups).toContainText("Recovery copies removed.", { timeout: 120000 });
    assert.equal(await readFile(kept, "utf8"), "current data remains");
    assert.equal(
      createHash("sha256")
        .update(await readFile(binary))
        .digest("hex"),
      report.binarySha256,
    );
    await expect(page.locator(".maintenance-status")).toContainText("Maintenance has finished");
    // Wait past the normal overview poll interval: intentional shutdown must not show a connection error.
    await new Promise((resolve) => setTimeout(resolve, 2200));
    await expect(page.locator(".workspace-connection-error")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Restart WorkPilot", exact: true }),
    ).toBeEnabled();
    await page.screenshot({ path: join(output, "update-backup-cleanup-complete-en.png") });
    await close();
    await launch();
    const afterCleanup = await snapshot(engine, task);
    assert.equal(afterCleanup.task.state, "interrupted");
    assert.equal(calls, 1);
    report.checks.push(
      "explicit_backup_cleanup_stops_engine_removes_only_old_copies_pauses_polling_offers_restart_and_current_task_data_still_opens_without_auto_resume",
    );
  } else {
    report.backup_cleanup_ui = "not run: intermediate desktop predates this component";
  }
  report.state = "passed";
} catch (error) {
  report.state = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
  await page?.screenshot({ path: join(output, "failure.png") }).catch(() => {});
} finally {
  await close();
  await fixture.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
