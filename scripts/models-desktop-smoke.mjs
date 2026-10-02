import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { root } from "./cargo.mjs";
import { startFixture } from "../services/provider-fixtures/server.mjs";
const output = join(root, ".test-results/models-desktop");
await mkdir(output, { recursive: true });
const fixture = await startFixture();
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  service: "synthetic local HTTP fixture, not a real model",
  checks: [],
};
const directory = await mkdtemp(join(output, "session-"));
const key = "workpilot-synthetic-key-only";
async function until(check, timeout = 20000) {
  const start = performance.now();
  while (performance.now() - start < timeout) {
    const value = await check().catch(() => false);
    if (value) return value;
    await delay(50);
  }
  throw new Error("Native model test timed out");
}
async function launch() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const child = spawn(
    process.env.WORKPILOT_DESKTOP_BINARY || join(root, "target/release/workpilot-desktop.exe"),
    [],
    {
      cwd: root,
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        WORKPILOT_CHANNEL: "test",
        WORKPILOT_DATA_DIR: directory,
        WEBVIEW2_USER_DATA_FOLDER: join(directory, "webview"),
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
          "--remote-debugging-address=127.0.0.1 --remote-debugging-port=" + port,
      },
    },
  );
  try {
    await until(async () => (await fetch("http://127.0.0.1:" + port + "/json/version")).ok);
    const browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
    const page = await until(async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => /tauri\.localhost|tauri:/.test(p.url())),
    );
    await expect(page.getByText("引擎已连接", { exact: true })).toBeVisible();
    return { child, browser, page };
  } catch (e) {
    child.kill();
    throw e;
  }
}
async function command(page, command, id = crypto.randomUUID()) {
  return page.evaluate(
    ({ command, id }) =>
      window.__TAURI_INTERNALS__.invoke("engine_command", { request: { request_id: id, command } }),
    { command, id },
  );
}
async function quit(session) {
  const exited = once(session.child, "exit");
  await session.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("exit_app")).catch(() => {});
  await exited;
  await session.browser.close().catch(() => {});
}
let session;
try {
  session = await launch();
  let page = session.page;
  await page.getByRole("button", { name: "模型服务", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  for (const protocol of ["chat_completions", "responses", "messages"]) {
    await page.getByRole("button", { name: "+ 添加服务", exact: true }).click();
    await page.getByLabel("显示名称", { exact: true }).fill("本地验证 " + protocol);
    await page.getByLabel("接口类型", { exact: true }).selectOption(protocol);
    await page.getByLabel("服务地址", { exact: true }).fill(fixture.url + "/v1");
    await page.getByLabel("模型名称", { exact: true }).fill("fixture-text");
    await page.getByLabel("服务密钥", { exact: true }).fill(key);
    await page.getByRole("button", { name: "保存配置", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("配置已保存");
    await expect(page.getByLabel("服务密钥", { exact: true })).toHaveValue("");
    await page.getByRole("button", { name: "读取模型列表", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("5 个模型");
    await page.getByRole("button", { name: "测试文字", exact: true }).click();
    await expect(page.locator(".model-call-status")).toHaveAttribute("data-state", "completed");
    await expect(page.getByTestId("model-response")).toHaveText("你好，WorkPilot");
    await expect(page.locator(".model-usage")).toContainText("输入词元：12");
    await page.getByRole("button", { name: "测试工具请求", exact: true }).click();
    await expect(page.getByTestId("model-tools")).toContainText("你好 WorkPilot");
    await page.getByRole("button", { name: "测试图片输入", exact: true }).click();
    await expect(page.locator(".model-call-status")).toHaveAttribute("data-state", "completed");
    report.checks.push(protocol + "_native_save_key_list_text_tools_image");
  }
  await page.getByRole("button", { name: "设为全局默认", exact: true }).click();
  await page.getByRole("button", { name: "导出配置", exact: true }).click();
  const exported = await page.getByLabel("导出内容", { exact: true }).inputValue();
  assert(!exported.includes(key));
  assert(JSON.parse(exported).profiles.every((p) => p.credential === null));
  report.checks.push("export_excludes_secret_and_reference");
  await page.screenshot({ path: join(output, "native-model-settings.png") });
  await page.getByLabel("模型名称", { exact: true }).fill("fixture-401");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("配置已保存");
  const beforeError = fixture.records.length;
  await page.getByRole("button", { name: "测试文字", exact: true }).click();
  await expect(page.locator(".model-call-status")).toHaveAttribute("data-state", "failed");
  await expect(page.locator(".model-results")).toContainText("密钥未配置或未被服务接受");
  assert.equal(fixture.records.length, beforeError + 1);
  assert(!(await page.locator(".model-results").innerText()).includes(key));
  report.checks.push("authentication_error_no_retry_sanitized");
  await page.getByLabel("模型名称", { exact: true }).fill("fixture-slow");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("配置已保存");
  const beforeStop = fixture.records.length;
  await page.getByRole("button", { name: "测试文字", exact: true }).click();
  await until(async () => fixture.records.length === beforeStop + 1);
  await page.getByRole("button", { name: "停止调用", exact: true }).click();
  await expect(page.locator(".model-call-status")).toHaveAttribute("data-state", "cancelled");
  await delay(2100);
  await expect(page.locator(".model-call-status")).toHaveAttribute("data-state", "cancelled");
  assert.equal(fixture.records.length, beforeStop + 1);
  report.checks.push("cancel_closes_request_and_rejects_late_success");
  await page.getByRole("button", { name: "返回工作台", exact: true }).click();
  await page.getByRole("button", { name: "English", exact: true }).click();
  await page.getByRole("button", { name: "Model services", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveAttribute("aria-label", "Model services");
  await page.screenshot({ path: join(output, "native-model-settings-english.png") });
  await page.getByRole("button", { name: "Back to workspace", exact: true }).click();
  await page.getByRole("button", { name: "简体中文", exact: true }).click();
  const beforeRestart = fixture.records.length;
  await quit(session);
  session = await launch();
  page = session.page;
  assert.equal(fixture.records.length, beforeRestart);
  await page.getByRole("button", { name: "模型服务", exact: true }).click();
  await expect(page.getByLabel("服务密钥", { exact: true })).toHaveAttribute(
    "placeholder",
    "已保存；留空保持原密钥",
  );
  const catalog = await command(page, { kind: "read", query: { kind: "profiles" } });
  assert.equal(catalog.catalog.profiles.length, 3);
  assert(
    catalog.catalog.profiles.every((p) => p.credential_saved && p.profile.credential === null),
  );
  const calls = await command(page, { kind: "read", query: { kind: "model_calls", limit: 64 } });
  assert.equal(calls.calls.length, 11);
  const cancelled = calls.calls.find((c) => c.state === "cancelled");
  assert(cancelled && !cancelled.output);
  report.checks.push("restart_restores_settings_and_history_without_http_replay");
  // Idempotent command should make exactly one request, including after completion.
  const p = catalog.catalog.profiles.find((p) => p.profile.protocol === "responses").profile;
  const start = {
    kind: "start_model_probe",
    profile_id: p.id,
    task_id: null,
    agent_id: null,
    mode: "text",
    prompt: "",
  };
  const id = crypto.randomUUID();
  const beforeDedup = fixture.records.length;
  const first = await command(page, start, id);
  const duplicate = await command(page, start, id);
  assert.equal(first.call.id, duplicate.call.id);
  assert(duplicate.duplicate);
  await until(async () => {
    const r = await command(page, { kind: "read", query: { kind: "model_calls", limit: 64 } });
    return r.calls.find((c) => c.id === first.call.id)?.state === "completed";
  });
  await command(page, start, id);
  assert.equal(fixture.records.length, beforeDedup + 1);
  report.checks.push("native_command_dedup_issues_one_http_request");
  // Four independent calls may run; a fifth receives a clear limit, without HTTP.
  const slow = catalog.catalog.profiles.find((p) => p.profile.model === "fixture-slow").profile;
  const slowCommand = { ...start, profile_id: slow.id };
  const active = [];
  for (let i = 0; i < 4; i++) {
    const r = await command(page, slowCommand);
    assert.equal(r.kind, "model_started");
    active.push(r.call.id);
  }
  const limited = await command(page, slowCommand);
  assert.equal(limited.kind, "model_error");
  assert.equal(limited.diagnostic.code, "limit");
  for (const call_id of active) await command(page, { kind: "cancel_model_probe", call_id });
  const stopped = await command(page, { kind: "read", query: { kind: "model_calls", limit: 64 } });
  assert(stopped.calls.filter((c) => active.includes(c.id)).every((c) => c.state === "cancelled"));
  report.checks.push("four_independent_calls_fifth_rejected_and_cancellation_isolated");
  await page
    .getByRole("dialog")
    .locator('input[type="file"]')
    .setInputFiles({
      name: "settings.json",
      mimeType: "application/json",
      buffer: Buffer.from(exported),
    });
  await expect(page.getByRole("status")).toContainText("已导入为新的服务");
  const imported = await command(page, { kind: "read", query: { kind: "profiles" } });
  assert.equal(imported.catalog.profiles.length, 6);
  assert.equal(imported.catalog.profiles.filter((p) => p.credential_saved).length, 3);
  assert.equal(imported.catalog.global_default, catalog.catalog.global_default);
  report.checks.push("native_import_creates_new_profiles_without_keys_or_overwrite");
  assert.equal(fixture.records.filter((r) => r.imageValid === true).length, 3);
  report.requests = fixture.records;
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.error = String(error);
  if (session) await session.page.screenshot({ path: join(output, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (session && session.child.exitCode === null) {
    // Remove only the synthetic keys created by this isolated test session.
    const result = await command(session.page, { kind: "read", query: { kind: "profiles" } }).catch(
      () => null,
    );
    if (result?.kind === "profiles") {
      for (const { profile } of result.catalog.profiles) {
        const cleared = await command(session.page, {
          kind: "save_provider",
          profile,
          secret: null,
          clear_credential: true,
        });
        assert.equal(cleared.kind, "provider_saved", "Synthetic credential cleanup failed");
      }
    }
    await quit(session).catch(() => session.child.kill());
  }
  // Check only this test's persisted database and objects, not user directories.
  const paths = [join(directory, "test", "workpilot.sqlite3")];
  async function files(dir) {
    for (const item of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, item.name);
      if (item.isDirectory()) await files(path);
      else paths.push(path);
    }
  }
  await files(join(directory, "test", "objects"));
  for (const path of paths)
    assert(
      !(await readFile(path)).includes(Buffer.from(key)),
      "Synthetic key leaked to persisted data",
    );
  report.checks.push("persisted_records_contain_no_plaintext_key");
  await fixture.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
