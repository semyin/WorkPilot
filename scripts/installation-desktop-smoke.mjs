import { chromium, expect as baseExpect } from "@playwright/test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { root } from "./cargo.mjs";
import { until } from "./tool-test-support.mjs";
import { browserRegistrationSnapshot } from "./browser-registration-snapshot.mjs";

const expect = baseExpect.configure({ timeout: 120000 });
const output = resolve(
  process.env.WORKPILOT_TEST_OUTPUT || join(root, ".test-results/installation-desktop"),
);
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "data-"));
const binary =
  process.env.WORKPILOT_DESKTOP_BINARY ||
  join(root, "artifacts/workpilot-p12-settings-2026-10-04/preview/workpilot-desktop.exe");
const registrationsBefore = browserRegistrationSnapshot();
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  binarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  service:
    "Actual Windows desktop; isolated test data; PATH contains System32 only; network blocked at test browser context (not an OS firewall)",
  checks: [],
};
let child, browser, page;
const errors = [];
try {
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  child = spawn(binary, [], {
    cwd: root,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      PATH: join(process.env.SystemRoot, "System32"),
      WORKPILOT_CHANNEL: "test",
      WORKPILOT_DATA_DIR: directory,
      WEBVIEW2_USER_DATA_FOLDER: join(directory, "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port} --disable-background-networking`,
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
  await page.context().setOffline(true);
  await expect(page.getByText("引擎已连接", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  let panel = page.getByRole("dialog", { name: "设置", exact: true });
  await panel.locator("summary").filter({ hasText: "Chrome / Edge 连接设置" }).click();
  const setup = panel.getByRole("region", { name: "浏览器连接安装" });
  await expect(setup.locator("[data-setup-state]")).toHaveCount(2);
  const setupReport = await page.evaluate(async () =>
    window.__TAURI_INTERNALS__.invoke("engine_command", {
      request: {
        request_id: crypto.randomUUID(),
        command: { kind: "browser_setup", action: { kind: "inspect" } },
      },
    }),
  );
  assert.equal(setupReport.kind, "browser_setup");
  assert.equal(setupReport.report.assets_ready, true);
  for (const state of setupReport.report.browsers) {
    const card = setup.locator(`[data-setup-browser=${state.browser}]`);
    await expect(card.locator("[data-setup-state]")).toHaveAttribute(
      "data-setup-state",
      state.state,
    );
    if (state.state === "conflict") {
      await expect(card.getByRole("button", { name: "配置本机连接", exact: true })).toBeDisabled();
      const refused = await page.evaluate(
        async (browser) =>
          window.__TAURI_INTERNALS__.invoke("engine_command", {
            request: {
              request_id: crypto.randomUUID(),
              command: { kind: "browser_setup", action: { kind: "register", browser } },
            },
          }),
        state.browser,
      );
      assert.equal(refused.kind, "error");
    }
  }
  await setup.getByRole("button", { name: "复制扩展文件夹位置", exact: true }).click();
  await expect(setup.getByRole("status")).toHaveText("已复制");
  await setup.getByRole("button", { name: "重新检查连接配置", exact: true }).click();
  await expect(setup.getByRole("button", { name: "重新检查连接配置", exact: true })).toBeEnabled();
  await setup.locator("[data-setup-browser=chrome]").scrollIntoViewIfNeeded();
  assert(await panel.evaluate((e) => e.scrollWidth <= e.clientWidth + 2));
  await page.screenshot({ path: join(output, "browser-setup-zh.png") });
  report.browserStates = setupReport.report.browsers.map((b) => ({
    browser: b.browser,
    state: b.state,
  }));
  report.checks.push("native_browser_setup_status_copy_folder_and_existing_registration_conflicts");
  await panel.locator("summary").filter({ hasText: "Chrome / Edge 连接设置" }).click();
  await panel.locator("summary").filter({ hasText: "环境检查与诊断" }).click();
  const quickStarted = Date.now();
  await panel.getByRole("button", { name: "检查环境", exact: true }).click();
  await expect(panel.locator("[data-runtime-id=python] summary")).toContainText("文件齐全");
  report.quickCheckMs = Date.now() - quickStarted;
  const fullStarted = Date.now();
  await panel.getByRole("button", { name: "完整核验文件", exact: true }).click();
  await expect(panel.locator("[data-runtime-id=office] summary")).toContainText("内容已核对");
  report.fullCheckMs = Date.now() - fullStarted;
  assert.equal(await panel.locator("[data-runtime-id]").count(), 7);
  assert(await panel.evaluate((e) => e.scrollWidth <= e.clientWidth + 2));
  await panel.locator("[data-runtime-id=python] summary").click();
  await panel.locator("[data-runtime-id=python]").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "environment-zh.png") });
  const download = page.waitForEvent("download");
  await panel.getByRole("button", { name: "导出环境诊断", exact: true }).click();
  const file = await download;
  await file.saveAs(join(output, "exported-environment.json"));
  const exported = JSON.parse(await readFile(join(output, "exported-environment.json"), "utf8"));
  assert(exported.components.every((c) => c.state === "verified"));
  const text = JSON.stringify(exported);
  assert(!text.includes(directory) && !text.includes(process.env.USERPROFILE));
  assert(
    !/Authorization|Bearer |sk-ws-|credential|password/i.test(JSON.stringify(exported.components)),
  );
  report.checks.push(
    "native_offline_ui_quick_full_inspection_and_real_download_without_private_paths",
  );
  await panel.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "English", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  panel = page.getByRole("dialog", { name: "Settings", exact: true });
  await panel.locator("summary").filter({ hasText: "Chrome / Edge connection setup" }).click();
  await expect(panel.locator("[data-setup-state]")).toHaveCount(2);
  await panel.locator("[data-setup-browser=edge]").scrollIntoViewIfNeeded();
  assert(await panel.evaluate((e) => e.scrollWidth <= e.clientWidth + 2));
  await page.screenshot({ path: join(output, "browser-setup-en.png") });
  await panel.locator("summary").filter({ hasText: "Chrome / Edge connection setup" }).click();
  assert.equal(browserRegistrationSnapshot(), registrationsBefore);
  report.checks.push("english_browser_setup_and_current_daily_browser_registrations_preserved");
  await panel.locator("summary").filter({ hasText: "Environment and diagnostics" }).click();
  await panel.getByRole("button", { name: "Check environment", exact: true }).click();
  await expect(panel.locator("[data-runtime-id=git] summary")).toContainText("Files present");
  await panel.locator("[data-runtime-id=git]").scrollIntoViewIfNeeded();
  assert(await panel.evaluate((e) => e.scrollWidth <= e.clientWidth + 2));
  await page.screenshot({ path: join(output, "environment-en.png") });
  report.checks.push("english_settings_render_without_horizontal_overflow");
  assert.equal(errors.length, 0, errors.join("\n"));
  const exited = once(child, "exit");
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("exit_app")).catch(() => {});
  await exited;
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
