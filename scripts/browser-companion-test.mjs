import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { launch, until } from "./tool-test-support.mjs";
import { browserTask, element } from "./browser-test-support.mjs";
import { startBrowserFixture } from "../services/browser-fixtures/server.mjs";
import { root } from "./cargo.mjs";
try {
  await access(join(root, ".local/p08-browser-test-runtime"));
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(root, ".local/p08-browser-test-runtime");
} catch {}
const { chromium } = await import("@playwright/test");
const output = join(root, ".test-results/browser-companion");
await mkdir(output, { recursive: true });
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  browser: "Official Playwright Chromium / Chrome for Testing, isolated existing session",
  dailyChromeVerified: false,
  dailyEdgeVerified: false,
  checks: [],
};
const fixture = await startBrowserFixture();
let engine, context;
try {
  engine = await launch();
  const folder = await mkdtemp(join(engine.directory, "extension-project-"));
  const b = await browserTask(engine, folder, { permission: "request_approval" });
  const userData = await mkdtemp(join(output, "profile-")),
    extension = join(root, "extensions/companion"),
    id = (await readFile(join(extension, "extension-id.txt"), "utf8")).trim();
  context = await chromium.launchPersistentContext(userData, {
    channel: "chromium",
    headless: true,
    args: ["--disable-extensions-except=" + extension, "--load-extension=" + extension],
  });
  const original = await context.newPage();
  await original.goto(fixture.url + "/session?value=existing-browser");
  await original.goto(fixture.url + "/page");
  const unrelated = await context.newPage();
  await unrelated.goto(fixture.url + "/frame");
  const popup = await context.newPage();
  await popup.goto("chrome-extension://" + id + "/popup.html");
  const originalTab = await popup.evaluate(async () => {
    const targets = await chrome.debugger.getTargets();
    return targets.find((t) => t.url?.endsWith("/page")).tabId;
  });
  const pair = await b.control({ kind: "pair", channel: "chrome" });
  const paired = await popup.evaluate(
    ({ code, tab_id }) => chrome.runtime.sendMessage({ kind: "connect", code, tab_id }),
    { code: pair.pairing_code, tab_id: originalTab },
  );
  assert.equal(paired.state, "connected", JSON.stringify(paired));
  const session_id = pair.session.id,
    tab_id = String(originalTab);
  await until(
    async () =>
      (await b.control({ kind: "sessions" })).sessions.find((s) => s.id === session_id)?.tabs
        .length === 1,
  );
  let p = await b.snapshot(session_id, tab_id);
  assert(p.frames.some((f) => f.title === "P08 Browser Fixture"));
  report.checks.push("actual_extension_native_host_one_use_pairing_to_selected_existing_tab");
  const name = element(p, (e) => e.name === "Name");
  await b.browser({
    kind: "fill",
    session_id,
    tab_id,
    document: p.document,
    reference: name.reference,
    text: "Companion P08",
  });
  p = await b.snapshot(session_id, tab_id);
  await b.browser({
    kind: "click",
    session_id,
    tab_id,
    document: p.document,
    reference: element(p, (e) => e.name === "Greet").reference,
  });
  assert.equal(await original.locator("#result").textContent(), "Hello, Companion P08");
  p = await b.snapshot(session_id, tab_id);
  const screenshot = await b.browser({
    kind: "screenshot",
    session_id,
    tab_id,
    document: p.document,
  });
  await writeFile(
    join(output, "connected-page.png"),
    Buffer.from(screenshot.image.split(",")[1], "base64"),
  );
  assert(p.frames.filter((f) => f.title === "WorkPilot Frame").length >= 2);
  report.checks.push("connected_dom_fill_click_screenshot_and_multiple_frames");
  const uploadPath = "from-project.txt",
    data = "upload through authorized extension\n";
  await writeFile(join(folder, uploadPath), data);
  const upload = await b.wb({ kind: "read_file", path: uploadPath });
  p = await b.snapshot(session_id, tab_id);
  await b.browser({
    kind: "upload",
    session_id,
    tab_id,
    document: p.document,
    reference: element(p, (e) => e.type === "file").reference,
    path: uploadPath,
    expected: upload.version,
  });
  await until(() => fixture.uploads.length > 0);
  assert.equal(fixture.uploads.at(-1).toString(), data);
  p = await b.snapshot(session_id, tab_id);
  const downloadPath = "from-browser.bin",
    missing = (await b.wb({ kind: "read_file", path: downloadPath })).version;
  await b.browser({
    kind: "download",
    session_id,
    tab_id,
    document: p.document,
    reference: element(p, (e) => e.name === "Download binary").reference,
    path: downloadPath,
    expected: missing,
  });
  assert.deepEqual(await readFile(join(folder, downloadPath)), Buffer.from([0, 255, 42, 10, 128]));
  assert(
    (await b.wb({ kind: "history", path: downloadPath, before: null, limit: 10 })).items.length ===
      1,
  );
  report.checks.push("approved_upload_and_binary_download_use_project_versions");
  const unknown = await popup.evaluate(async () => {
    const targets = await chrome.debugger.getTargets();
    return targets.find((t) => t.url?.endsWith("/frame") && t.type === "page").tabId;
  });
  assert.equal(
    (
      await b.raw({
        kind: "browser",
        action: { kind: "snapshot", session_id, tab_id: String(unknown), query: null },
      })
    ).kind,
    "error",
  );
  await b.control({ kind: "takeover", session_id });
  assert.equal(
    (
      await b.raw({
        kind: "browser",
        action: { kind: "snapshot", session_id, tab_id, query: null },
      })
    ).kind,
    "error",
  );
  await b.control({ kind: "resume", session_id });
  p = await b.snapshot(session_id, tab_id);
  await original.reload();
  assert.equal(
    (
      await b.raw({
        kind: "browser",
        action: {
          kind: "click",
          session_id,
          tab_id,
          document: p.document,
          reference: element(p, (e) => e.name === "Greet").reference,
        },
      })
    ).kind,
    "error",
  );
  report.checks.push("unconnected_tab_rejected_manual_takeover_and_reload_invalidate_old_target");
  await b.navigate(session_id, tab_id, fixture.url + "/who");
  assert((await original.locator("h1").textContent()).includes("existing-browser"));
  await popup.screenshot({ path: join(output, "companion-popup.png") });
  await engine.close();
  engine = null;
  await until(
    async () =>
      (await popup.evaluate(() => chrome.runtime.sendMessage({ kind: "status" }))).state ===
      "disconnected",
  );
  assert(!original.isClosed());
  assert(!unrelated.isClosed());
  report.checks.push(
    "existing_login_marker_retained_application_exit_detaches_without_closing_daily_tabs",
  );
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = String(e);
  process.exitCode = 1;
} finally {
  await engine?.close();
  await context?.close();
  await fixture.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
