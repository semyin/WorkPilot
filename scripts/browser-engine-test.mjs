import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, create, until } from "./tool-test-support.mjs";
import { startFixtureServer } from "../services/fixtures/server.mjs";
const output = process.env.WORKPILOT_TEST_OUTPUT || ".test-results/browser-engine";
await mkdir(output, { recursive: true });
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  checks: [],
  browsers: [],
};
process.env.WORKPILOT_BROWSER_HEADLESS = "1";
const fixture = await startFixtureServer();
let engine;
try {
  engine = await launch();
  const folder = await mkdtemp(join(engine.directory, "browser-project-"));
  const task = await create(engine, "responses", "p08-browser");
  await engine.request({
    kind: "configure_task_tools",
    task_id: task,
    settings: {
      root_path: folder,
      permission: "full_access",
      commands_enabled: false,
      review_profile_id: null,
      revision: 0,
    },
  });
  const call = async (action) => {
    const r = await engine.request({ kind: "workbench", task_id: task, action });
    assert.equal(r.kind, "workbench", JSON.stringify(r));
    return r.data;
  };
  const browser = async (action) => {
    const r = await call({ kind: "browser", action });
    if (!r.operation) return r;
    const op = await until(async () => {
      const s = await call({ kind: "operations" });
      return s.items.find(
        (v) =>
          v.operation.id === r.operation.id &&
          ["completed", "failed", "cancelled"].includes(v.operation.state),
      )?.operation;
    }, 30000);
    assert.equal(op.state, "completed", JSON.stringify(op));
    return op;
  };
  for (const channel of (process.env.WORKPILOT_BROWSER_CHANNELS || "chrome,msedge").split(",")) {
    const s = await call({ kind: "browser_control", control: { kind: "start", channel } });
    report.browsers.push(s);
    assert.equal(s.state, "connected");
    const session_id = s.id,
      tab_id = s.tabs[0].id;
    let page = await browser({ kind: "snapshot", session_id, tab_id, query: null });
    await browser({
      kind: "navigate",
      session_id,
      tab_id,
      document: page.document,
      url: fixture.url + "/page",
    });
    page = await until(async () => {
      const p = await browser({ kind: "snapshot", session_id, tab_id, query: null });
      return p.frames.some((f) => f.title === "WorkPilot Browser Fixture") && p;
    });
    let input = page.frames.flatMap((f) => f.elements || []).find((e) => e.tag === "input");
    assert(input, JSON.stringify(page));
    await browser({
      kind: "fill",
      session_id,
      tab_id,
      document: page.document,
      reference: input.reference,
      text: "Browser P08",
    });
    page = await browser({ kind: "snapshot", session_id, tab_id, query: null });
    const button = page.frames.flatMap((f) => f.elements || []).find((e) => e.tag === "button");
    await browser({
      kind: "click",
      session_id,
      tab_id,
      document: page.document,
      reference: button.reference,
    });
    page = await browser({ kind: "snapshot", session_id, tab_id, query: null });
    assert(page.frames.some((f) => f.text?.includes("Hello, Browser P08")));
    const image = await browser({
      kind: "screenshot",
      session_id,
      tab_id,
      document: page.document,
    });
    assert(image.image.startsWith("data:image/png;base64,"));
    await writeFile(
      join(output, channel + "-page.png"),
      Buffer.from(image.image.split(",")[1], "base64"),
    );
    const link = page.frames
      .flatMap((f) => f.elements || [])
      .find((e) => e.name.includes("Download"));
    const path = channel + "-download.csv";
    const before = await call({ kind: "read_file", path });
    await browser({
      kind: "download",
      session_id,
      tab_id,
      document: page.document,
      reference: link.reference,
      path,
      expected: before.version,
    });
    assert.equal(await readFile(join(folder, path), "utf8"), "name,value\nWorkPilot,42\n");
    const history = await call({ kind: "history", path, before: null, limit: 10 });
    assert.equal(history.items.length, 1);
    await call({ kind: "browser_control", control: { kind: "disconnect", session_id } });
    report.checks.push(channel + "_real_dedicated_snapshot_fill_click_screenshot_download_history");
  }
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = String(e);
  process.exitCode = 1;
} finally {
  await engine?.close();
  await fixture.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
