import { chromium, expect } from "@playwright/test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { startFixtureServer } from "../services/fixtures/server.mjs";
import { root } from "./cargo.mjs";
const output = join(root, ".test-results/extension");
await mkdir(output, { recursive: true });
const id = (await readFile(join(root, ".local/browser-host/extension-id.txt"), "utf8")).trim();
const directory = await mkdtemp(join(output, "profile-"));
const extension = join(root, "extensions/browser");
const fixture = await startFixtureServer();
const report = {
  at: new Date().toISOString(),
  browser: "Playwright Chrome for Testing (isolated profile)",
  dailyChromeVerified: false,
  dailyEdgeVerified: false,
  checks: [],
};
let context;
try {
  context = await chromium.launchPersistentContext(directory, {
    channel: "chromium",
    headless: true,
    args: ["--disable-extensions-except=" + extension, "--load-extension=" + extension],
  });
  const page = await context.newPage();
  await page.goto(fixture.url + "/page");
  const popup = await context.newPage();
  await popup.goto("chrome-extension://" + id + "/popup.html");
  const result = await popup.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({ url: url + "/*" });
    const tab = tabs.find((tab) => tab.url.endsWith("/page"));
    return chrome.runtime.sendMessage({ kind: "probe", tabId: tab.id });
  }, fixture.url);
  assert.equal(result.state, "passed", JSON.stringify(result));
  assert.equal(result.result.text, "Hello, WorkPilot");
  await expect(page.locator("#result")).toHaveText("Hello, WorkPilot");
  report.checks.push(
    "extension_native_rust_handshake",
    "debugger_fill_click_read",
    "automatic_disconnect_after_probe",
  );
  await page.screenshot({ path: join(output, "fixture-after-probe.png") });
  await popup.reload();
  await popup.screenshot({ path: join(output, "extension-result.png") });
  await page.goto(fixture.url + "/health");
  const denied = await popup.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({ url: url + "/*" });
    return chrome.runtime.sendMessage({ kind: "probe", tabId: tabs[0].id });
  }, fixture.url);
  assert.equal(denied.state, "error");
  report.checks.push("rejects_non_fixture_page");
  report.result = result;
  for (let i = 0; i < 20; i++) {
    let live = false;
    try {
      process.kill(result.nativeHostPid, 0);
      live = true;
    } catch {}
    if (!live) {
      report.checks.push("native_host_exits_after_disconnect");
      break;
    }
    await delay(100);
  }
  assert.ok(report.checks.includes("native_host_exits_after_disconnect"));
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  process.exitCode = 1;
} finally {
  await context?.close();
  await fixture.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
