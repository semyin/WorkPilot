import { chromium, expect as baseExpect } from "@playwright/test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { until } from "./tool-test-support.mjs";
import {
  makeExtensionFixtures,
  installExtension,
  extensionAdmin,
} from "./extension-transfer-fixtures.mjs";
import { makeHistoryFixture } from "./extension-history-fixtures.mjs";
const expect = baseExpect.configure({ timeout: 60000 });

const output = resolve(
  process.env.WORKPILOT_TEST_OUTPUT || ".test-results/extension-transfer-desktop",
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
async function boot(name) {
  const data = join(directory, name);
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  child = spawn(binary, [], {
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      WORKPILOT_CHANNEL: "test",
      WORKPILOT_DATA_DIR: data,
      WEBVIEW2_USER_DATA_FOLDER: join(data, "webview"),
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
  page.setDefaultTimeout(120000);
  await expect(page.getByText("引擎已连接", { exact: true })).toBeVisible();
}
async function close() {
  if (child && child.exitCode === null) {
    const done = once(child, "exit");
    if (page)
      await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("exit_app")).catch(() => {});
    else child.kill();
    const timeout = setTimeout(() => {
      if (child && child.exitCode === null) child.kill();
    }, 10000);
    await done;
    clearTimeout(timeout);
  }
  await browser?.close();
  child = browser = page = null;
}
async function panel(english = false) {
  await page
    .getByRole("button", { name: english ? "Skills & plugins" : "技能与插件", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: english ? "Skills & plugins" : "技能与插件",
    exact: true,
  });
  const transfer = dialog.locator("details.history-transfer");
  await transfer.locator(":scope > summary").click();
  return { dialog, transfer };
}
try {
  const fixtures = await makeExtensionFixtures(join(directory, "fixtures"));
  const archive = join(directory, "桌面 扩展.wpextensions");
  const password = "desktop extension fixture passphrase";
  await boot("source");
  await installExtension(request, null, fixtures.base, false);
  await installExtension(request, null, fixtures.tool, false);
  await makeHistoryFixture(request, null, join(directory, "history-fixtures"));
  let view = await panel();
  const box = view.transfer;
  await box.getByLabel(/migration-base ·/).check();
  await box.getByLabel(/迁移插件 \/ Portable plugin ·/).check();
  const earlier = box.getByLabel("包含所选扩展的历史版本", { exact: true });
  await expect(earlier).toBeChecked();
  await earlier.uncheck();
  await earlier.check();
  await box.getByLabel(/migration-history · 2\.0\.0 ·/).check();
  await box.getByLabel(/migration-history · 3\.0\.0 · 待安装草稿/).check();
  await box.getByLabel(/migration-removed · 1\.0\.0 ·/).check();
  await box.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "extension-history-selection-zh.png") });
  await box.getByLabel("扩展备份保存位置", { exact: true }).fill(archive);
  await box.getByLabel("扩展备份口令（至少 12 个字符）", { exact: true }).fill(password);
  const save = box.getByRole("button", { name: "保存扩展备份 (5)", exact: true });
  await expect(save).toBeDisabled();
  await box.getByLabel("再次输入扩展备份口令", { exact: true }).fill(password);
  await save.click();
  await expect(box.getByText("扩展备份已保存。", { exact: true })).toBeVisible();
  await expect(box.getByLabel("扩展备份口令（至少 12 个字符）", { exact: true })).toHaveValue("");
  assert.equal((await readFile(archive)).subarray(0, 8).toString(), "WPEXT001");
  await box.getByLabel("扩展备份来源文件", { exact: true }).fill(archive);
  await box.getByLabel("扩展导入口令", { exact: true }).fill(password);
  await box.getByRole("button", { name: "预览扩展迁移", exact: true }).click();
  await expect(box.getByRole("region", { name: "扩展迁移预览" })).toContainText(
    "目标范围已有同名记录",
  );
  await expect(box.getByRole("button", { name: "确认导入并保持停用", exact: true })).toBeDisabled();
  report.checks.push(
    "native_multi_selection_encrypted_export_repeated_password_clear_and_same_scope_conflicts_block_import",
  );
  await close();

  await boot("target");
  view = await panel();
  let transfer = view.transfer;
  await transfer.getByLabel("扩展备份来源文件", { exact: true }).fill(archive);
  await transfer.getByLabel("扩展导入口令", { exact: true }).fill("wrong desktop passphrase");
  await transfer.getByRole("button", { name: "预览扩展迁移", exact: true }).click();
  await expect(transfer.getByRole("alert")).toContainText("口令错误");
  await expect(transfer.getByRole("region", { name: "扩展迁移预览" })).toHaveCount(0);
  await transfer.getByLabel("扩展导入口令", { exact: true }).fill(password);
  await transfer.getByRole("button", { name: "预览扩展迁移", exact: true }).click();
  let preview = transfer.getByRole("region", { name: "扩展迁移预览" });
  await expect(preview).toContainText("导入后不会自动启用");
  await expect(preview).toContainText("待安装草稿");
  await expect(preview).toContainText("已卸载");
  await preview.locator("summary").filter({ hasText: "一并保留的旧版本" }).click();
  await expect(preview).toContainText("1.0.0 · 2 个文件");
  await expect(preview).toContainText("migration-base ^1.0.0");
  await preview.locator("summary").filter({ hasText: "查看所含文件" }).nth(1).click();
  await expect(preview).toContainText("assets/template.bin");
  await preview.scrollIntoViewIfNeeded();
  assert(await view.dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 2));
  await page.screenshot({ path: join(output, "extension-transfer-zh.png") });
  const before = await extensionAdmin(request, null, { kind: "catalog", query: "migration" });
  assert.equal(before.items.length, 0);
  await transfer.getByRole("button", { name: "确认导入并保持停用", exact: true }).click();
  await expect(transfer.getByRole("status").filter({ hasText: "已导入并保持停用" })).toBeVisible();
  await expect(transfer.getByText("正在处理扩展备份…", { exact: true })).toHaveCount(0);
  await expect(transfer.getByLabel("扩展导入口令", { exact: true })).toHaveValue("");
  const catalog = await extensionAdmin(request, null, { kind: "catalog", query: "migration" });
  assert.equal(catalog.items.length, 3);
  assert.equal(catalog.previews.length, 1);
  const migrated = await request({
    kind: "extension_transfer",
    task_id: null,
    action: { kind: "catalog" },
  });
  assert.equal(migrated.kind, "workbench");
  assert(
    migrated.data.items.some(
      (item) => item.installation.slug === "migration-removed" && !item.installation.installed,
    ),
  );
  const retained = catalog.items.find((item) => item.installation.slug === "migration-history");
  const versions = await extensionAdmin(request, null, {
    kind: "versions",
    installation_id: retained.installation.id,
  });
  assert.equal(new Set(versions.history.map((item) => item.data.active_digest)).size, 2);
  assert(catalog.items.every((i) => !i.installation.enabled));
  assert(
    catalog.items
      .flatMap((i) => i.servers)
      .every((s) => !s.credential_configured && s.catalog === null),
  );
  report.checks.push(
    "native_wrong_password_preview_files_permissions_dependencies_explicit_import_keeps_packages_disabled_without_credentials",
  );
  report.checks.push(
    "native_history_checkbox_and_draft_uninstalled_selection_preview_preserve_both_versions_and_pending_state",
  );

  await view.dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "English", exact: true }).click();
  view = await panel(true);
  transfer = view.transfer;
  await transfer.getByLabel("Extension archive source file", { exact: true }).fill(archive);
  await transfer.getByLabel("Extension import passphrase", { exact: true }).fill(password);
  await transfer.getByRole("button", { name: "Preview extension transfer", exact: true }).click();
  preview = transfer.getByRole("region", { name: "Extension transfer preview" });
  await expect(preview).toContainText("This archive was already imported");
  await expect(preview).toContainText("Pending draft");
  await expect(preview).toContainText("Uninstalled");
  await expect(preview).toContainText("Earlier versions preserved");
  await preview.scrollIntoViewIfNeeded();
  assert(await view.dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 2));
  await page.screenshot({ path: join(output, "extension-transfer-en.png") });
  await transfer.getByRole("button", { name: "Import and keep disabled", exact: true }).click();
  await expect(
    transfer.getByText("Already imported; no duplicates added.", { exact: true }),
  ).toBeVisible();
  await expect(transfer.getByText("Processing extension archive…", { exact: true })).toHaveCount(0);
  assert.equal(
    (await extensionAdmin(request, null, { kind: "catalog", query: "migration" })).items.length,
    3,
  );
  report.checks.push(
    "english_preview_duplicate_import_no_new_installations_and_no_horizontal_overflow",
  );
  assert.equal(errors.length, 0, errors.join("\n"));
  await close();
  report.checks.push("source_and_target_applications_exit_without_leaving_owned_work");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
  await page?.screenshot({ path: join(output, "failure.png") }).catch(() => {});
} finally {
  await close().catch(() => {
    if (child && child.exitCode === null) child.kill();
  });
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
