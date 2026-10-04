import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { cpus, totalmem, release } from "node:os";
import { expect } from "@playwright/test";
import { startExecutionFixture } from "../services/execution-fixtures/server.mjs";
import { profile, setFixture } from "./tool-test-support.mjs";
import {
  launchDesktop,
  quitDesktop,
  request,
  until,
  distribution,
} from "./p13-desktop-support.mjs";
import { installObservers } from "./p13-desktop-observers.mjs";

const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/p13-desktop");
const binary = resolve(
  process.env.WORKPILOT_DESKTOP_BINARY ||
    "artifacts/workpilot-p13-candidate-2026-10-04-r3/preview/workpilot-desktop.exe",
);
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "session-"));
let sent = 0;
const fixture = await startExecutionFixture((body) =>
  body.model === "p13-ui-hold"
    ? { text: "Held request ended", calls: [], delay: 5000 }
    : { text: "P13_EVENT_" + String(++sent).padStart(4, "0"), calls: [], delay: 350 },
);
setFixture(fixture);
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  os: release(),
  cpu: cpus()[0]?.model,
  logicalProcessors: cpus().length,
  memoryBytes: totalmem(),
  binarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  service:
    "Synthetic local Responses model, real Windows desktop and engine; no external model or personal data",
  conditions:
    "Fresh app and WebView data for each startup. OS file cache is not cleared. UI tests run in the normal workbench, not P00 diagnostics. Observer timestamps are DOM updates, not physical screen pixels.",
  checks: [],
  measurements: {},
  eventSamples: [],
  startupSamples: [],
};
let session;
async function createTask(page, model) {
  const p = profile("responses", model);
  assert.equal(
    (
      await request(page, {
        kind: "save_provider",
        profile: p,
        secret: null,
        clear_credential: false,
      })
    ).kind,
    "provider_saved",
  );
  const r = await request(page, {
    kind: "create_execution",
    config: {
      title: "P13 desktop timing",
      goal: "Measure this local synthetic reply",
      constraints: [],
      project_rules: "",
      project_id: null,
      profile_id: p.id,
      mode: "chat",
      controlled_tools: false,
      limits: {
        max_steps: 8,
        max_duration_ms: 30000,
        context_bytes: 65536,
        max_result_bytes: 32768,
      },
    },
  });
  assert.equal(r.kind, "receipt");
  const task = r.receipt.task_id;
  await page.evaluate((id) => localStorage.setItem("workpilot.execution", id), task);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "P13 desktop timing", exact: true }),
  ).toBeVisible();
  await page.evaluate(installObservers);
  return task;
}
const state = (page) => page.getByTestId("execution-status");
try {
  console.log("START normal workbench timing");
  session = await launchDesktop(binary, join(directory, "workbench"));
  const { page } = session;
  const task = await createTask(page, "p13-ui-text");
  const sidebar = page.getByRole("button", {
    name: /^(项目与任务|Projects & tasks)$/,
    exact: true,
  });
  await sidebar.evaluate((b) => {
    b.dataset.p13Button = "sidebar";
  });
  for (let i = 0; i < 20; i++) {
    const pressed = await sidebar.getAttribute("aria-pressed");
    await sidebar.click();
    await expect(sidebar).not.toHaveAttribute("aria-pressed", pressed);
  }
  const input = page.getByLabel(/^(发送新的要求|Send a new instruction)$/, { exact: true });
  for (let i = 0; i < 20; i++) {
    await input.fill("");
    await expect(page.locator(".execution-composer button.primary")).toBeDisabled();
    await input.fill("P13 synthetic input " + i);
    await expect(page.locator(".execution-composer button.primary")).toBeEnabled();
  }
  await input.fill("");
  for (let i = 0; i < 20; i++) {
    if (i > 0) {
      const queued = await request(page, {
        kind: "enqueue",
        task_id: task,
        text: "Provide the next local timing reply " + i,
      });
      assert.equal(queued.kind, "receipt");
    }
    await page.getByRole("button", { name: /^(继续任务|Continue task)$/, exact: true }).click();
    const marker = "P13_EVENT_" + String(i + 1).padStart(4, "0");
    await page.waitForFunction((marker) => !!window.p13Metrics.text[marker], marker);
    await expect(state(page)).toHaveAttribute("data-state", "completed");
    await expect(
      page.getByRole("button", { name: /^(继续任务|Continue task)$/, exact: true }),
    ).toBeDisabled();
    const detail = await request(page, {
      kind: "read",
      query: { kind: "execution", task_id: task },
    });
    let after = 0,
      textEvent;
    do {
      const r = await request(page, {
        kind: "read",
        query: { kind: "events", task_id: task, after, limit: 256 },
      });
      assert.equal(r.kind, "events");
      textEvent = r.page.events.find(
        (e) =>
          e.kind === "execution_text" &&
          !e.reasoning &&
          e.run_id === detail.snapshot.latest_run.run.id,
      );
      after = r.page.next_after;
      if (textEvent || !r.page.has_more) break;
    } while (true);
    assert(textEvent, "A stored engine text event must back every observed result");
    const visibleAtMs = await page.evaluate((m) => window.p13Metrics.text[m], marker);
    report.eventSamples.push({
      marker,
      eventId: textEvent.event_id,
      eventAtMs: textEvent.at_ms,
      visibleAtMs,
      elapsedMs: visibleAtMs - textEvent.at_ms,
    });
    assert.equal(fixture.records.filter((r) => r.model === "p13-ui-text").length, i + 1);
  }
  const first = await page.evaluate(() => window.p13Metrics);
  report.measurements.sidebar = distribution(
    first.button,
    150,
    "Native click event to saved sidebar aria-pressed change",
  );
  report.measurements.input = distribution(
    first.input,
    150,
    "Native textarea input event to enabled message button",
  );
  report.measurements.eventDisplay = distribution(
    report.eventSamples.map((s) => s.elapsedMs),
    250,
    "Persisted execution_text engine timestamp to first corresponding DOM text; same OS clock",
  );
  report.checks.push("20_button_input_and_correlated_engine_text_samples_in_normal_workbench");
  report.checks.push("completed_task_requires_new_instruction_and_queued_messages_can_continue");
  await page.screenshot({ path: join(output, "workbench-timing-zh.png") });
  await createTask(page, "p13-ui-hold");
  const stop = page.getByRole("button", { name: /^(停止任务|Stop task)$/, exact: true });
  await stop.evaluate((b) => {
    b.dataset.p13Button = "stop";
  });
  for (let i = 0; i < 20; i++) {
    await page.getByRole("button", { name: /^(继续任务|Continue task)$/, exact: true }).click();
    await expect(state(page)).toHaveAttribute("data-state", "running");
    await until(
      async () => fixture.records.filter((r) => r.model === "p13-ui-hold").length === i + 1,
    );
    await stop.click();
    await expect(state(page)).toHaveAttribute("data-state", "interrupted");
    await until(async () =>
      fixture.records.filter((r) => r.model === "p13-ui-hold").every((r) => r.ended),
    );
  }
  const stops = await page.evaluate(() => window.p13Metrics);
  report.measurements.stopFeedback = distribution(
    stops.stopFeedback,
    200,
    "Native Stop click to stopping or interrupted DOM status",
  );
  report.measurements.stopFinished = distribution(
    stops.stopFinished,
    null,
    "Native Stop click to actual interrupted task displayed; HTTP model wait, no local tool",
  );
  report.checks.push("20_stop_samples_and_actual_model_connections_closed_without_retry");
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(state(page)).toHaveText("Interrupted");
  await page.screenshot({ path: join(output, "workbench-timing-en.png") });
  assert.deepEqual(session.errors, []);
  await quitDesktop(session);
  session = null;
  console.log("START 20 fresh-profile app startups; OS cache retained");
  for (let i = 0; i < 20; i++) {
    session = await launchDesktop(binary, join(directory, "startup-" + i));
    report.startupSamples.push(session.startupObservedMs);
    assert.deepEqual(session.errors, []);
    await quitDesktop(session);
    session = null;
  }
  report.measurements.startup = distribution(
    report.startupSamples,
    null,
    "Fresh app/WebView profiles, process creation to automation observing connected engine and enabled input; includes CDP connection overhead and is not a true cold-start claim",
  );
  report.checks.push("20_fresh_profile_startups_normal_shutdown_and_no_browser_console_errors");
  report.httpCalls = fixture.records.length;
  report.targetMisses = Object.entries(report.measurements)
    .filter(([, m]) => m.withinTarget === false)
    .map(([name]) => name);
  report.status = report.targetMisses.length ? "passed_with_performance_gaps" : "passed";
} catch (e) {
  report.status = "failed";
  report.error = String(e);
  if (session) await session.page.screenshot({ path: join(output, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  try {
    await quitDesktop(session);
  } catch (e) {
    report.cleanupError = String(e);
    report.status = "failed";
    process.exitCode = 1;
  }
  await fixture.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify(report, null, 2));
