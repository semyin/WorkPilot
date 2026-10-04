import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { create, until } from "./tool-test-support.mjs";

const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/file-transfer-desktop");
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
const exists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};
async function taskAt(folder, name) {
  const task = await create({ request }, "responses", name);
  const r = await request({
    kind: "configure_task_tools",
    task_id: task,
    settings: {
      root_path: folder,
      permission: "request_approval",
      commands_enabled: false,
      review_profile_id: null,
      revision: 0,
    },
  });
  assert.equal(r.kind, "receipt", JSON.stringify(r));
  return task;
}
async function panel(task, english = false) {
  await page.evaluate((task) => localStorage.setItem("workpilot.execution", task), task);
  await page.reload();
  await page
    .getByRole("button", { name: english ? "Files and terminal" : "文件与终端", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: english ? "Files and terminal" : "文件与终端",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: english ? "File transfer" : "文件迁移", exact: true })
    .click();
  return {
    dialog,
    box: dialog.getByRole("region", {
      name: english ? "Project file transfer" : "项目文件迁移",
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
  page.setDefaultTimeout(20000);
  await expect(page.getByText("引擎已连接", { exact: true })).toBeVisible();
  const source = join(directory, "源目录"),
    target = join(directory, "目标目录");
  await mkdir(join(source, "资料"), { recursive: true });
  await mkdir(target);
  await writeFile(join(source, "hello.txt"), "native desktop file bytes");
  const binaryBytes = Buffer.from([0, 255, 3, 4]);
  await writeFile(join(source, "资料/图片.bin"), binaryBytes);
  const from = await taskAt(source, "files-ui-source"),
    to = await taskAt(target, "files-ui-target");
  const archive = join(directory, "文件.wpfiles"),
    password = "desktop files fixture passphrase";
  let view = await panel(from),
    box = view.box;
  await box.getByLabel("备份文件: hello.txt", { exact: true }).check();
  await box.getByRole("button", { name: "打开文件夹：资料", exact: true }).click();
  await box.getByLabel("备份文件: 资料/图片.bin", { exact: true }).check();
  await box.getByLabel("文件备份保存位置", { exact: true }).fill(archive);
  await box.getByLabel("设置文件备份口令", { exact: true }).fill(password);
  await expect(box.getByRole("button", { name: "加密导出文件", exact: true })).toBeDisabled();
  await box.getByLabel("再次输入文件备份口令", { exact: true }).fill(password);
  await box.getByRole("button", { name: "加密导出文件", exact: true }).click();
  await expect(box.getByText("文件备份已保存。", { exact: true })).toBeVisible();
  await expect(box.getByLabel("设置文件备份口令", { exact: true })).toHaveValue("");
  assert.equal((await readFile(archive)).subarray(0, 8).toString(), "WPFILE01");
  report.checks.push("native_cross_folder_selection_export_password_confirmation_and_clear");

  view = await panel(to);
  box = view.box;
  await box.getByLabel("文件备份来源", { exact: true }).fill(archive);
  await box.getByLabel("解密文件备份口令", { exact: true }).fill("wrong desktop passphrase");
  await box.getByRole("button", { name: "预览文件导入", exact: true }).click();
  await expect(box.getByRole("alert")).toContainText("口令错误");
  await box.getByLabel("解密文件备份口令", { exact: true }).fill(password);
  await box.getByRole("button", { name: "预览文件导入", exact: true }).click();
  const preview = box.getByLabel("文件导入预览", { exact: true });
  await expect(preview).toContainText("hello.txt → 迁入文件/hello.txt");
  await expect(preview).toContainText("资料/图片.bin → 迁入文件/资料/图片.bin");
  await preview.scrollIntoViewIfNeeded();
  assert(await view.dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 2));
  await page.screenshot({ path: join(output, "file-transfer-zh.png") });
  await box.getByRole("button", { name: "提交文件导入", exact: true }).click();
  await expect(
    box.getByText("已加入下方操作记录，请查看审批或执行结果。", { exact: true }),
  ).toBeVisible();
  await expect(box.getByLabel("解密文件备份口令", { exact: true })).toHaveValue("");
  const operation = view.dialog.locator('[data-operation-state="awaiting_approval"]');
  await expect(operation).toContainText("导入项目文件");
  assert.equal(await exists(join(target, "迁入文件/hello.txt")), false);
  await operation.getByRole("button", { name: "确认执行", exact: true }).click();
  await expect(view.dialog.locator('[data-operation-state="completed"]')).toHaveCount(1);
  assert.equal(
    await readFile(join(target, "迁入文件/hello.txt"), "utf8"),
    "native desktop file bytes",
  );
  assert.deepEqual(await readFile(join(target, "迁入文件/资料/图片.bin")), binaryBytes);
  await view.dialog.getByRole("button", { name: "修改历史", exact: true }).click();
  const versions = await request({
    kind: "workbench",
    task_id: to,
    action: { kind: "history", path: null, before: null, limit: 100 },
  });
  assert.equal(versions.data.items.length, 2);
  await expect(view.dialog.locator(".file-history")).toContainText("迁入文件/hello.txt");
  report.checks.push(
    "native_wrong_password_mapping_preview_pending_approval_then_exact_binary_files_and_history",
  );

  view = await panel(from);
  box = view.box;
  await box.getByLabel("文件备份来源", { exact: true }).fill(archive);
  await box.getByLabel("解密文件备份口令", { exact: true }).fill(password);
  await box.getByLabel("目标子文件夹（留空为项目根目录）", { exact: true }).fill("");
  await box.getByRole("button", { name: "预览文件导入", exact: true }).click();
  await expect(box.getByRole("alert")).toContainText("存在冲突");
  await expect(box.getByRole("button", { name: "提交文件导入", exact: true })).toBeDisabled();
  await view.dialog.getByRole("button", { name: "返回对话", exact: true }).click();
  await page.getByRole("button", { name: "English", exact: true }).click();
  view = await panel(to, true);
  box = view.box;
  await box.getByLabel("File backup source", { exact: true }).fill(archive);
  await box.getByLabel("Decrypt file backup passphrase", { exact: true }).fill(password);
  await box.getByRole("button", { name: "Preview file import", exact: true }).click();
  await expect(
    box.getByText(
      "An import record already exists for this destination; view the original operation.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(box.getByRole("alert")).toHaveCount(0);
  await box
    .getByRole("button", { name: "View original import", exact: true })
    .scrollIntoViewIfNeeded();
  assert(await view.dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 2));
  await page.screenshot({ path: join(output, "file-transfer-en.png") });
  await box.getByRole("button", { name: "View original import", exact: true }).click();
  await expect(
    box.getByText("Added to operations below. Check approval or execution results.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(view.dialog.locator('[data-operation-state="completed"]')).toHaveCount(1);
  report.checks.push(
    "existing_file_conflict_blocks_import_english_duplicate_views_one_operation_no_horizontal_overflow",
  );
  assert.equal(errors.length, 0, errors.join("\n"));
  await close();
  report.checks.push("native_application_clean_exit_without_javascript_errors");
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
