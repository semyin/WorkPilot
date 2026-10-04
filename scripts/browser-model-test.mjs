import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, setFixture, start, terminal, until, snapshot } from "./tool-test-support.mjs";
import { browserTask, element } from "./browser-test-support.mjs";
import { startToolFixture } from "../services/execution-fixtures/tools.mjs";
import { startBrowserFixture } from "../services/browser-fixtures/server.mjs";
const output = process.env.WORKPILOT_TEST_OUTPUT || ".test-results/browser-model";
const channel = process.env.WORKPILOT_BROWSER_CHANNEL || "chrome";
await mkdir(output, { recursive: true });
process.env.WORKPILOT_BROWSER_HEADLESS = "1";
const site = await startBrowserFixture(),
  model = await startToolFixture();
setFixture(model);
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  channel,
  model: "local deterministic model fixture; no paid provider",
  checks: [],
};
let engine;
try {
  engine = await launch();
  const folder = await mkdtemp(join(engine.directory, "model-browser-"));
  model.recipes.set("p08-start-browser", (results) => {
    if (!results.length)
      return model.tool("browser", { action: { kind: "start_dedicated", channel } });
    return model.done("Dedicated browser started by model with approval");
  });
  const launching = await browserTask(engine, folder, {
    permission: "request_approval",
    model: "p08-start-browser",
    controlled: false,
  });
  await start(engine, launching.task);
  const waiting = await terminal(engine, launching.task);
  assert.equal(waiting.task.state, "awaiting_approval");
  assert.equal(
    (await launching.control({ kind: "sessions" })).sessions.length,
    0,
    "starting browser must wait for approval",
  );
  const opening = (await launching.wb({ kind: "operations" })).items.find(
    (v) => v.operation.state === "awaiting_approval",
  ).operation;
  await launching.approve(opening);
  await start(engine, launching.task);
  assert.equal((await terminal(engine, launching.task)).task.state, "completed");
  const opened = (await launching.control({ kind: "sessions" })).sessions;
  assert.equal(opened.length, 1, "resuming must not launch a second browser");
  assert.equal(opened[0].channel, channel);
  await launching.control({ kind: "disconnect", session_id: opened[0].id });
  report.checks.push(
    "model_starts_dedicated_browser_only_after_approval_and_does_not_replay_on_resume",
  );
  for (const permission of ["full_access", "request_approval"]) {
    const name = "p08-model-" + permission;
    let imageSeen = false;
    model.recipes.set(name, (results, body) => {
      const parsed = results.map((r) => JSON.parse(r));
      if (!results.length) return model.tool("browser_sessions", {});
      const s = parsed[0].sessions.find((s) => s.state === "connected"),
        session_id = s.id,
        tab_id = s.tabs[0].id;
      const action = (a) => model.tool("browser", { action: { session_id, tab_id, ...a } });
      if (results.length === 1) return action({ kind: "snapshot", query: "Name" });
      if (results.length === 2)
        return action({
          kind: "fill",
          document: parsed[1].document,
          reference: element(parsed[1], (e) => e.name === "Name").reference,
          text: "model-" + permission,
        });
      if (results.length === 3) return action({ kind: "snapshot", query: "Greet" });
      if (results.length === 4)
        return action({
          kind: "click",
          document: parsed[3].document,
          reference: element(parsed[3], (e) => e.name === "Greet").reference,
        });
      if (results.length === 5) return action({ kind: "snapshot", query: null });
      if (results.length === 6) return action({ kind: "screenshot", document: parsed[5].document });
      if (permission === "request_approval")
        assert.match(parsed[6].error, /not been confirmed to accept images/);
      imageSeen = JSON.stringify(body).includes("input_image");
      return model.done("Browser model flow complete");
    });
    const b = await browserTask(engine, folder, { permission, model: name, controlled: false });
    if (permission === "full_access") {
      const catalog = await engine.request({ kind: "read", query: { kind: "profiles" } });
      const profile = catalog.catalog.profiles.find((p) => p.profile.model === name).profile;
      profile.supports_images = true;
      profile.capabilities.images = { supported: true, source: "user", checked_at_ms: null };
      assert.equal(
        (
          await engine.request({
            kind: "save_provider",
            profile,
            secret: null,
            clear_credential: false,
          })
        ).kind,
        "provider_saved",
      );
    }
    const s = await b.control({ kind: "start", channel });
    await b.navigate(s.id, s.tabs[0].id, site.url + "/page");
    await start(engine, b.task);
    let state = await terminal(engine, b.task);
    let approvals = 0;
    while (state.task.state === "awaiting_approval") {
      const op = (await b.wb({ kind: "operations" })).items.find(
        (v) => v.operation.kind === "browser" && v.operation.state === "awaiting_approval",
      )?.operation;
      assert(op);
      await b.approve(op);
      approvals++;
      await start(engine, b.task);
      state = await terminal(engine, b.task);
    }
    assert.equal(state.task.state, "completed", JSON.stringify(state.latest_run));
    const page = await b.snapshot(s.id, s.tabs[0].id);
    assert(page.frames.some((f) => f.text?.includes("Hello, model-" + permission)));
    if (permission === "full_access")
      assert(imageSeen, "confirmed image-capable model must receive the real screenshot");
    else {
      assert.equal(approvals, 2);
      assert(!imageSeen, "unconfirmed model must not receive an image");
    }
    const steps = state.steps.filter((s) => s.name === "browser");
    assert(
      steps.every(
        (s) =>
          s.state === "completed" || (permission === "request_approval" && s.state === "failed"),
      ),
    );
    await b.control({ kind: "disconnect", session_id: s.id });
    report.checks.push(
      permission + "_model_drives_real_browser_results_and_approval_resume_without_replay",
    );
  }
  report.checks.push("screenshot_attached_only_to_explicitly_image_capable_model");
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = String(e);
  process.exitCode = 1;
} finally {
  await engine?.close();
  await model.close();
  await site.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
