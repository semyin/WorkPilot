import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { until, profile } from "./tool-test-support.mjs";
const withHistory = process.argv.includes("--memory-history");
const output = resolve(
  process.env.WORKPILOT_TEST_OUTPUT ||
    (withHistory
      ? ".test-results/memory-history-transfer-desktop"
      : ".test-results/project-transfer-desktop"),
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
async function openPanel(english = false) {
  await page.getByRole("button", { name: english ? "Settings" : "设置", exact: true }).click();
  const panel = page.getByRole("dialog", { name: english ? "Settings" : "设置", exact: true });
  await panel
    .locator("summary")
    .filter({ hasText: english ? "Project settings and memory transfer" : "项目设置与记忆迁移" })
    .click();
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
  const original = join(directory, "原项目"),
    target = join(directory, "迁移项目");
  await mkdir(original);
  await mkdir(target);
  await writeFile(join(target, "keep.txt"), "keep current file");
  const model = profile("responses", "transfer-ui-model");
  model.auth = "bearer";
  assert.equal(
    (
      await request({
        kind: "save_provider",
        profile: model,
        secret: null,
        clear_credential: false,
      })
    ).kind,
    "provider_saved",
  );
  const project = (
    await request({
      kind: "workspace",
      action: {
        kind: "save_project",
        project_id: null,
        settings: {
          name: "界面原项目",
          root_path: original,
          default_profile_id: model.id,
          permission: "full_access",
          rules: "使用中文并保留用户文件",
          revision: 0,
        },
      },
    })
  ).data.project;
  const memoryIds = [];
  for (const scope of [project.id, null]) {
    const created = await request({
      kind: "memory",
      action: {
        kind: "save",
        memory_id: null,
        revision: 0,
        project_id: scope,
        text: scope ? "项目记忆测试" : "通用记忆测试",
      },
    });
    assert.equal(created.kind, "memory");
    memoryIds.push(created.data.memory_id);
  }
  if (withHistory) {
    for (const action of [
      {
        kind: "save",
        memory_id: memoryIds[0],
        revision: 1,
        project_id: project.id,
        text: "项目记忆新版",
      },
      { kind: "delete", memory_id: memoryIds[0], revision: 2 },
    ])
      assert.equal((await request({ kind: "memory", action })).kind, "memory");
  }
  let panel = await openPanel(),
    transfer = panel.locator(".project-transfer");
  await transfer.getByLabel("源项目", { exact: true }).selectOption(project.id);
  if (withHistory) {
    await expect(
      transfer.getByRole("checkbox", { name: "项目 · 已删除 · 项目记忆新版", exact: true }),
    ).toHaveCount(0);
    await transfer.getByRole("checkbox", { name: "包含记忆历史与未生效记录", exact: true }).check();
  }
  await transfer
    .getByRole("checkbox", {
      name: withHistory ? "项目 · 已删除 · 项目记忆新版" : "项目 · 项目记忆测试",
      exact: true,
    })
    .check();
  await transfer
    .getByRole("checkbox", {
      name: withHistory ? "通用 · 已确认 · 通用记忆测试" : "通用 · 通用记忆测试",
      exact: true,
    })
    .check();
  const archive = join(directory, "界面设置.wpsettings"),
    password = "native settings fixture passphrase";
  await transfer.getByLabel("设置包保存位置", { exact: true }).fill(archive);
  await transfer.getByLabel("设置迁移口令", { exact: true }).fill(password);
  await transfer.getByLabel("再次输入迁移口令", { exact: true }).fill(password);
  await transfer.getByRole("button", { name: "保存项目设置包", exact: true }).click();
  await expect(transfer.getByRole("status")).toHaveText("项目设置包已保存。");
  await expect(transfer.getByLabel("设置迁移口令", { exact: true })).toHaveValue("");
  assert(!(await readFile(archive)).includes(Buffer.from(password)));
  report.checks.push(
    "native_selects_project_models_and_memories_exports_encrypted_settings_and_clears_passphrase",
  );
  await transfer.getByLabel("项目设置包", { exact: true }).fill(archive);
  await transfer.getByLabel("输入迁移口令", { exact: true }).fill("incorrect fixture passphrase");
  await transfer.getByLabel("新项目名称", { exact: true }).fill("界面迁移项目");
  await transfer.getByLabel("目标项目文件夹", { exact: true }).fill(target);
  await transfer.getByRole("button", { name: "预览项目迁移", exact: true }).click();
  await expect(transfer.getByRole("alert")).toContainText("口令错误");
  await transfer.getByLabel("输入迁移口令", { exact: true }).fill(password);
  await transfer.getByLabel("新项目名称", { exact: true }).fill("界面原项目");
  await transfer.getByRole("button", { name: "预览项目迁移", exact: true }).click();
  await expect(
    transfer.getByRole("button", { name: "确认导入项目设置与记忆", exact: true }),
  ).toBeDisabled();
  await transfer.getByLabel("新项目名称", { exact: true }).fill("界面迁移项目");
  await transfer.getByRole("button", { name: "预览项目迁移", exact: true }).click();
  let preview = transfer.getByRole("region", { name: "项目迁移预览" });
  await expect(preview).toContainText("需要重新填写");
  await expect(preview).toContainText("通用记忆会用于所有项目");
  if (withHistory) {
    await expect(preview).toContainText("3 个历史版本");
    await expect(preview).toContainText("已删除的记录不会生效");
  }
  const before = (
    await request({ kind: "read", query: { kind: "workspace", query: { kind: "overview" } } })
  ).data.projects;
  assert.equal(before.length, 1);
  await preview.scrollIntoViewIfNeeded();
  assert(await panel.evaluate((e) => e.scrollWidth <= e.clientWidth + 2));
  await page.screenshot({ path: join(output, "project-transfer-zh.png") });
  await transfer.getByRole("button", { name: "确认导入项目设置与记忆", exact: true }).click();
  await expect(transfer.getByRole("status")).toContainText("项目设置已导入");
  await expect(transfer.getByLabel("输入迁移口令", { exact: true })).toHaveValue("");
  const after = (
    await request({ kind: "read", query: { kind: "workspace", query: { kind: "overview" } } })
  ).data.projects;
  assert.equal(after.length, 2);
  assert.equal(after.find((p) => p.id !== project.id).settings.permission, "request_approval");
  assert.equal(await readFile(join(target, "keep.txt"), "utf8"), "keep current file");
  if (withHistory) {
    const projectId = after.find((p) => p.id !== project.id).id;
    const memories = (
      await request({
        kind: "memory",
        action: {
          kind: "list",
          project_id: projectId,
          search: "",
          include_deleted: true,
          offset: 0,
          limit: 64,
        },
      })
    ).data.items;
    const imported = memories.find((m) => m.project_id === projectId);
    assert(imported.deleted);
    assert.equal(imported.revision, 4);
    const history = (
      await request({
        kind: "memory",
        action: { kind: "history", memory_id: imported.id, before_revision: null, limit: 64 },
      })
    ).data.items;
    assert.equal(history.length, 4);
    assert.equal(history.at(-1).text, "项目记忆测试");
    assert.equal(
      (
        await request({
          kind: "memory",
          action: { kind: "restore", memory_id: imported.id, revision: 4, target_revision: 1 },
        })
      ).kind,
      "memory",
    );
    report.checks.push(
      "native_full_history_selection_preview_preserves_deleted_state_and_imported_original_can_be_restored",
    );
  }
  report.checks.push(
    "wrong_passphrase_and_duplicate_name_block_import_preview_requires_confirmation_and_preserves_current_files",
  );
  await panel.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "English", exact: true }).click();
  panel = await openPanel(true);
  transfer = panel.locator(".project-transfer");
  await transfer.getByLabel("Project settings archive", { exact: true }).fill(archive);
  await transfer.getByLabel("Enter settings passphrase", { exact: true }).fill(password);
  await transfer.getByLabel("New project name", { exact: true }).fill("界面迁移项目");
  await transfer.getByLabel("Target project folder", { exact: true }).fill(target);
  await transfer.getByRole("button", { name: "Preview project transfer", exact: true }).click();
  preview = transfer.getByRole("region", { name: "Project transfer preview" });
  await expect(preview).toContainText("Already imported");
  if (withHistory) {
    await expect(preview).toContainText("3 historical revisions");
    await expect(preview).toContainText("Candidates still need confirmation");
  }
  await expect(
    transfer.getByRole("button", { name: "Confirm project and memory import", exact: true }),
  ).toHaveCount(0);
  await preview.scrollIntoViewIfNeeded();
  assert(await panel.evaluate((e) => e.scrollWidth <= e.clientWidth + 2));
  await page.screenshot({ path: join(output, "project-transfer-en.png") });
  assert.equal(errors.length, 0, errors.join("\n"));
  report.checks.push("english_preview_no_duplicate_import_and_no_horizontal_overflow");
  const exit = once(child, "exit");
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("exit_app")).catch(() => {});
  await exit;
  report.checks.push("application_exits_without_leaving_owned_work");
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
