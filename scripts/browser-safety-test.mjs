import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, until } from "./tool-test-support.mjs";
import { browserTask, element } from "./browser-test-support.mjs";
import { startBrowserFixture } from "../services/browser-fixtures/server.mjs";
const output = ".test-results/browser-safety";
await mkdir(output, { recursive: true });
process.env.WORKPILOT_BROWSER_HEADLESS = "1";
const report = { at: new Date().toISOString(), platform: process.platform, checks: [] };
const fixture = await startBrowserFixture();
let engine;
try {
  engine = await launch();
  const folder = await mkdtemp(join(engine.directory, "browser-files-"));
  for (const channel of ["chrome", "msedge"]) {
    const b = await browserTask(engine, folder, { permission: "request_approval" });
    let s = await b.control({ kind: "start", channel });
    let session_id = s.id,
      tab_id = s.tabs[0].id;
    let p = await b.navigate(session_id, tab_id, fixture.url + "/page");
    p = await until(async () => {
      const r = await b.snapshot(session_id, tab_id);
      return r.frames.filter((f) => f.title === "WorkPilot Frame").length >= 2 && r;
    });
    const frame = element(p, (e) => e.name === "Frame button");
    await b.browser({
      kind: "click",
      session_id,
      tab_id,
      document: p.document,
      reference: frame.reference,
    });
    p = await b.snapshot(session_id, tab_id);
    assert(p.frames.some((f) => f.text?.includes("frame clicked")));
    report.checks.push(channel + "_same_and_cross_origin_frames_use_explicit_references");
    const path = channel + "-upload.bin",
      bytes = Buffer.alloc(65536, 0xa3);
    await writeFile(join(folder, path), bytes);
    const file = await b.wb({ kind: "read_file", path });
    p = await b.snapshot(session_id, tab_id);
    const upload = element(p, (e) => e.type === "file");
    const count = fixture.uploads.length;
    const pending = await b.wb({
      kind: "browser",
      action: {
        kind: "upload",
        session_id,
        tab_id,
        document: p.document,
        reference: upload.reference,
        path,
        expected: file.version,
      },
    });
    assert.equal(pending.operation.state, "awaiting_approval");
    assert.equal(fixture.uploads.length, count);
    await b.approve(pending.operation);
    await until(() => fixture.uploads.length === count + 1);
    assert.deepEqual(fixture.uploads.at(-1), bytes);
    report.checks.push(channel + "_upload_waits_for_bound_approval_and_sends_exact_project_bytes");
    p = await b.snapshot(session_id, tab_id);
    const button = element(p, (e) => e.name === "Greet");
    const stale = await b.wb({
      kind: "browser",
      action: {
        kind: "click",
        session_id,
        tab_id,
        document: p.document,
        reference: button.reference,
      },
    });
    await b.snapshot(session_id, tab_id);
    const denied = await b.raw({
      kind: "approve",
      operation_id: stale.operation.id,
      fingerprint: stale.operation.fingerprint,
    });
    assert.equal(denied.kind, "error");
    await b.wb({ kind: "stop", operation_id: stale.operation.id });
    // Reconnect after Stop intentionally revokes this task's browser connection.
    await until(
      async () =>
        (await b.control({ kind: "sessions" })).sessions.find((x) => x.id === session_id)?.state ===
        "disconnected",
    );
    s = await b.control({ kind: "start", channel });
    session_id = s.id;
    tab_id = s.tabs[0].id;
    p = await b.navigate(session_id, tab_id, fixture.url + "/page");
    report.checks.push(channel + "_stale_page_approval_rejected_and_stop_revokes_connection");
    const other = await browserTask(engine, folder);
    assert.equal(
      (
        await other.raw({
          kind: "browser",
          action: { kind: "snapshot", session_id, tab_id, query: null },
        })
      ).kind,
      "error",
    );
    p = await b.snapshot(session_id, tab_id);
    const up = element(p, (e) => e.type === "file");
    assert.equal(
      (
        await b.raw({
          kind: "browser",
          action: {
            kind: "upload",
            session_id,
            tab_id,
            document: p.document,
            reference: up.reference,
            path: "../private.txt",
            expected: { exists: false, sha256: null, bytes: 0, identity: null },
          },
        })
      ).kind,
      "error",
    );
    assert.equal(
      (
        await b.raw({
          kind: "browser",
          action: {
            kind: "navigate",
            session_id,
            tab_id,
            document: p.document,
            url: "file:///C:/Windows/win.ini",
          },
        })
      ).kind,
      "error",
    );
    report.checks.push(
      channel + "_cross_task_and_project_escape_rejected_web_text_cannot_grant_access",
    );
    p = await b.snapshot(session_id, tab_id);
    const popup = element(p, (e) => e.name === "Open popup");
    await b.browser({
      kind: "click",
      session_id,
      tab_id,
      document: p.document,
      reference: popup.reference,
    });
    await until(async () => (await b.browser({ kind: "tabs", session_id })).tabs.length >= 2);
    const added = await b.browser({ kind: "new_tab", session_id, url: fixture.url + "/frame" });
    const addedPage = await until(async () => {
      const view = await b.snapshot(session_id, added.tab_id);
      return view.frames.some((f) => f.title === "WorkPilot Frame") && view;
    });
    await b.browser({
      kind: "close_tab",
      session_id,
      tab_id: added.tab_id,
      document: addedPage.document,
    });
    assert(
      !(await b.browser({ kind: "tabs", session_id })).tabs.some((t) => t.id === added.tab_id),
    );
    assert.equal(
      (
        await b.raw({
          kind: "browser",
          action: { kind: "snapshot", session_id, tab_id: added.tab_id, query: null },
        })
      ).kind,
      "error",
    );
    p = await b.snapshot(session_id, tab_id);
    const dialog = element(p, (e) => e.name === "Open dialog");
    await b.browser({
      kind: "click",
      session_id,
      tab_id,
      document: p.document,
      reference: dialog.reference,
    });
    const dialogPage = await b.snapshot(session_id, tab_id);
    assert.equal(dialogPage.dialog.message, "P08 dialog");
    await b.browser({
      kind: "dialog",
      session_id,
      tab_id,
      document: dialogPage.document,
      accept: true,
      text: null,
    });
    report.checks.push(
      channel + "_popup_new_close_tabs_and_javascript_dialog_handled_in_owned_browser",
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
    await b.navigate(session_id, tab_id, fixture.url + "/session?value=" + channel);
    await b.control({ kind: "disconnect", session_id });
    s = await b.control({ kind: "start", channel });
    session_id = s.id;
    tab_id = s.tabs[0].id;
    p = await b.navigate(session_id, tab_id, fixture.url + "/who");
    assert(p.frames.some((f) => f.text?.includes("p08_session=" + channel)));
    await b.control({ kind: "disconnect", session_id });
    report.checks.push(channel + "_manual_takeover_and_profile_login_marker_persist_without_copy");
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
