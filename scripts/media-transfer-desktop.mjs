import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { create, until } from "./tool-test-support.mjs";
import { media, uploadMedia } from "./media-transfer-support.mjs";

const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/media-transfer-desktop");
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
const errors = [];
let child, browser, page;
const request = (command) =>
  page.evaluate(
    (command) =>
      window.__TAURI_INTERNALS__.invoke("engine_command", {
        request: { request_id: crypto.randomUUID(), command },
      }),
    command,
  );
async function panel(task, english = false) {
  await page.evaluate((task) => localStorage.setItem("workpilot.execution", task), task);
  await page.reload();
  await page
    .getByRole("button", { name: english ? "Files and images" : "文件成果与图片", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: english ? "Files and images" : "文件成果与图片",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: english ? "Attachment transfer" : "附件迁移", exact: true })
    .click();
  return {
    dialog,
    box: dialog.getByRole("region", {
      name: english ? "Attachment and output transfer" : "附件与成果迁移",
      exact: true,
    }),
  };
}
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
try {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((done) => server.close(done));
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
  const from = await create({ request }, "responses", "attachments-ui-source", { mode: "chat" }),
    target = await create({ request }, "responses", "attachments-ui-target", { mode: "chat" });
  const note = await uploadMedia(request, from, "笔记.txt", Buffer.from("桌面迁移的原内容 42。\n"));
  const require = createRequire(resolve("services/documents/package.json"));
  const { createCanvas } = require("@napi-rs/canvas");
  const canvas = createCanvas(32, 16);
  canvas.getContext("2d").fillRect(0, 0, 32, 16);
  const picture = await uploadMedia(request, from, "图片.png", canvas.toBuffer("image/png"));
  await uploadMedia(request, target, "迁入-笔记.txt", Buffer.from("原来已有的目标资料"));
  const archive = join(directory, "桌面 附件.wpmedia"),
    password = "desktop media fixture passphrase";
  let view = await panel(from),
    box = view.box;
  await box.getByLabel(`备份附件: 笔记.txt · ${note.id.slice(0, 8)}`, { exact: true }).check();
  await box.getByLabel(`备份附件: 图片.png · ${picture.id.slice(0, 8)}`, { exact: true }).check();
  await box.getByLabel("附件备份保存位置", { exact: true }).fill(archive);
  await box.getByLabel("设置附件备份口令", { exact: true }).fill(password);
  await expect(box.getByRole("button", { name: "加密导出附件", exact: true })).toBeDisabled();
  await box.getByLabel("再次输入附件备份口令", { exact: true }).fill(password);
  await box.getByRole("button", { name: "加密导出附件", exact: true }).click();
  await expect(box.getByText("附件备份已保存。", { exact: true })).toBeVisible();
  await expect(box.getByLabel("设置附件备份口令", { exact: true })).toHaveValue("");
  assert.equal((await readFile(archive)).subarray(0, 8).toString(), "WPMEDIA1");
  report.checks.push(
    "native_selected_attachments_encrypted_export_requires_repeated_passphrase_and_clears_it",
  );

  view = await panel(target);
  box = view.box;
  await box.getByLabel("附件备份来源", { exact: true }).fill(archive);
  await box.getByLabel("解密附件备份口令", { exact: true }).fill("incorrect fixture passphrase");
  await box.getByRole("button", { name: "预览附件导入", exact: true }).click();
  await expect(box.getByRole("alert")).toContainText("口令错误");
  await box.getByLabel("解密附件备份口令", { exact: true }).fill(password);
  await box.getByLabel("名称前缀（可留空）", { exact: true }).fill("迁入-");
  await box.getByRole("button", { name: "预览附件导入", exact: true }).click();
  const preview = box.getByRole("region", { name: "附件导入预览", exact: true });
  await expect(preview).toContainText("笔记.txt → 迁入-笔记.txt");
  await expect(preview).toContainText("会作为独立资料保留");
  assert.equal((await media(request, target, { kind: "list" })).assets.length, 1);
  await preview.scrollIntoViewIfNeeded();
  assert(await view.dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 2));
  await page.screenshot({ path: join(output, "media-transfer-zh.png") });
  await box.getByRole("button", { name: "确认导入附件", exact: true }).click();
  await expect(box.getByText("附件已导入，可在“附件与成果”查看。", { exact: true })).toBeVisible();
  await expect(box.getByLabel("解密附件备份口令", { exact: true })).toHaveValue("");
  const rows = (await media(request, target, { kind: "list" })).assets;
  assert.equal(rows.length, 3);
  const imported = rows.find((a) => a.origin?.asset_id === note.id);
  assert(imported);
  await view.dialog.getByRole("button", { name: "附件与成果", exact: true }).click();
  let card = view.dialog.locator(`[data-media-asset="${imported.id}"]`);
  await card.getByRole("button", { name: "迁入-笔记.txt", exact: true }).click();
  await expect(view.dialog.locator(".media-detail")).toContainText("桌面迁移的原内容 42");
  await expect(card).toContainText("迁入来源：");
  report.checks.push(
    "native_wrong_password_and_mapping_preview_same_name_keeps_original_then_imported_content_and_origin_are_readable",
  );

  await card.getByRole("button", { name: "加入下一条消息", exact: true }).click();
  await expect(view.dialog).toHaveCount(0);
  await expect(
    page.locator(".attachment-chips").getByText("迁入-笔记.txt", { exact: true }),
  ).toBeVisible();
  let snapshot = (await request({ kind: "read", query: { kind: "execution", task_id: target } }))
    .snapshot;
  assert.equal(snapshot.latest_run, null);
  assert.equal(snapshot.messages.length, 0);
  await page.getByLabel("发送新的要求", { exact: true }).fill("请查看迁入的资料。");
  await page.getByRole("button", { name: "保存消息", exact: true }).click();
  await expect(page.locator(".execution-messages")).toContainText(imported.id);
  snapshot = (await request({ kind: "read", query: { kind: "execution", task_id: target } }))
    .snapshot;
  assert.equal(snapshot.latest_run, null);
  assert.equal(snapshot.messages.length, 1);
  report.checks.push(
    "add_to_next_message_returns_attachment_chip_without_sending_then_explicit_save_queues_new_asset_id",
  );

  await page.getByRole("button", { name: "English", exact: true }).click();
  view = await panel(target, true);
  box = view.box;
  await box.getByLabel("Attachment backup source", { exact: true }).fill(archive);
  await box.getByLabel("Decrypt attachment backup passphrase", { exact: true }).fill(password);
  await box.getByLabel("Name prefix (optional)", { exact: true }).fill("unused-");
  await box.getByRole("button", { name: "Preview attachment import", exact: true }).click();
  await expect(
    box.getByText(
      "This archive was already imported. The names above are from the original import. The current name prefix will not apply, and subsequently removed items stay removed.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(box.getByRole("alert")).toHaveCount(0);
  const originalReceipt = box.getByRole("region", {
    name: "Attachment import preview",
    exact: true,
  });
  await expect(originalReceipt).toContainText("迁入-笔记.txt");
  await expect(originalReceipt).not.toContainText("unused-笔记.txt");
  await box
    .getByRole("button", { name: "Check import status", exact: true })
    .scrollIntoViewIfNeeded();
  assert(await view.dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 2));
  await page.screenshot({ path: join(output, "media-transfer-en.png") });
  await box.getByRole("button", { name: "Check import status", exact: true }).click();
  await expect(
    box.getByText("Already imported; no duplicates added.", { exact: true }),
  ).toBeVisible();
  assert.equal((await media(request, target, { kind: "list" })).assets.length, 3);
  assert.equal(errors.length, 0, errors.join("\n"));
  report.checks.push(
    "english_duplicate_import_shows_original_names_ignores_new_prefix_keeps_three_snapshots_without_overflow_or_javascript_errors",
  );
  await close();
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
