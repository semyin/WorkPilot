import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { expect } from "@playwright/test";
import { profile, setFixture } from "./tool-test-support.mjs";
import { startExecutionFixture } from "../services/execution-fixtures/server.mjs";
import { launchDesktop, quitDesktop, request, distribution } from "./p13-desktop-support.mjs";
import { watchVisibleMarker } from "./p13-visible-event-observer.mjs";

const selfCheck = process.argv.includes("--self-check");
const sampleCount = selfCheck ? 3 : 20;
const binary = resolve(
  process.env.WORKPILOT_DESKTOP_BINARY ||
    "artifacts/workpilot-p13-candidate-2026-10-04-r3/preview/workpilot-desktop.exe",
);
const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/p13-visible-event");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "session-"));
const fixture = await startExecutionFixture((body) => ({
  text: body.model,
  calls: [],
  delay: 750,
}));
setFixture(fixture);
const report = {
  at: new Date().toISOString(),
  kind: selfCheck ? "short_script_self_check_not_p95" : "twenty_sample_visible_event_benchmark",
  binarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  conditions:
    "Separate short tasks. The normal output panel is scrolled into the viewport before the delayed fixed model returns. Measures an unoccluded complete text range across two renderer animation frames, not physical monitor scan-out. No historical scroll-follow claim.",
  samples: [],
  checks: [],
};
let session;
try {
  session = await launchDesktop(binary, join(directory, "data"));
  const { page } = session;
  for (let i = 0; i < sampleCount; i++) {
    const marker = "P13_VISIBLE_" + String(i).padStart(4, "0");
    const p = profile("responses", marker);
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
    const made = await request(page, {
      kind: "create_execution",
      config: {
        title: marker,
        goal: "Return a short fixed timing marker",
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
    assert.equal(made.kind, "receipt");
    const task = made.receipt.task_id;
    await page.evaluate((task) => localStorage.setItem("workpilot.execution", task), task);
    await page.reload();
    await expect(page.getByRole("heading", { name: marker, exact: true })).toBeVisible();
    await page.evaluate(watchVisibleMarker, marker);
    await page.getByRole("button", { name: /^(继续任务|Continue task)$/, exact: true }).click();
    await page.getByTestId("execution-answer").scrollIntoViewIfNeeded();
    await page.waitForFunction(() => window.p13Visible.presentedAtMs !== null);
    const observed = await page.evaluate(() => window.p13Visible);
    assert(observed.focused, "Do not count an unfocused renderer as the foreground sample");
    await expect(page.getByTestId("execution-status")).toHaveAttribute("data-state", "completed");
    const r = await request(page, {
      kind: "read",
      query: { kind: "events", task_id: task, after: 0, limit: 256 },
    });
    assert.equal(r.kind, "events");
    const event = r.page.events.find((e) => e.kind === "execution_text" && !e.reasoning);
    assert(event);
    const sample = {
      marker,
      taskId: task,
      eventId: event.event_id,
      eventAtMs: event.at_ms,
      ...observed,
    };
    sample.elapsedMs = observed.presentedAtMs - event.at_ms;
    assert(sample.elapsedMs >= 0);
    report.samples.push(sample);
    if (i === 0 || i === sampleCount - 1)
      await page.screenshot({ path: join(directory, "visible-" + i + ".png") });
  }
  assert.deepEqual(session.errors, []);
  assert.equal(fixture.records.length, sampleCount);
  if (!selfCheck)
    report.measurement = distribution(
      report.samples.map((s) => s.elapsedMs),
      250,
      "Engine saved text event to complete unoccluded foreground viewport text over two animation frames",
    );
  report.checks.push("real_native_renderer_visible_text_samples_correlated_to_saved_engine_events");
  report.status = selfCheck
    ? "self_check_passed_not_twenty_samples"
    : report.measurement.withinTarget
      ? "passed"
      : "passed_with_performance_gaps";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
  await session?.page.screenshot({ path: join(directory, "failure.png") }).catch(() => {});
} finally {
  await quitDesktop(session);
  await fixture.close();
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
}
console.log(
  JSON.stringify({
    status: report.status,
    directory,
    measurement: report.measurement,
    error: report.error,
  }),
);
