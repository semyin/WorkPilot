import assert from "node:assert/strict";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { profile, setFixture } from "./tool-test-support.mjs";
import { request, until, distribution } from "./p13-desktop-support.mjs";
import { installObservers } from "./p13-desktop-observers.mjs";
import { verifyFullExport } from "./p13-long-history-data.mjs";

export async function prepareTasks(page, fixture) {
  setFixture(fixture);
  const tasks = [];
  for (let i = 0; i < 4; i++) {
    const model = `p13-long-stream-${i}`;
    const provider = profile("responses", model);
    provider.options.timeout_ms = 180000;
    provider.options.idle_timeout_ms = 15000;
    assert.equal(
      (
        await request(page, {
          kind: "save_provider",
          profile: provider,
          secret: null,
          clear_credential: false,
        })
      ).kind,
      "provider_saved",
    );
    const title = i === 0 ? "P13 100000-event history" : `P13 independent stream ${i}`;
    const created = await request(page, {
      kind: "create_execution",
      config: {
        title,
        goal: "Return the bounded local streaming sample",
        constraints: [],
        project_rules: "",
        project_id: null,
        profile_id: provider.id,
        mode: "chat",
        controlled_tools: false,
        limits: {
          max_steps: 8,
          max_duration_ms: 180000,
          context_bytes: 65536,
          max_result_bytes: 32768,
        },
      },
    });
    assert.equal(created.kind, "receipt");
    tasks.push({ id: created.receipt.task_id, title, model });
  }
  const team = await request(page, { kind: "read", query: { kind: "team", task_id: tasks[0].id } });
  assert.equal(team.kind, "team");
  assert.equal(
    (
      await request(page, {
        kind: "configure_scheduler",
        settings: { max_running: 4, revision: team.view.scheduler.revision },
      })
    ).kind,
    "receipt",
  );
  const overview = await request(page, {
    kind: "read",
    query: { kind: "workspace", query: { kind: "overview" } },
  });
  const saved = await request(page, {
    kind: "workspace",
    action: {
      kind: "save_preferences",
      preferences: { ...overview.data.preferences, language: "en", theme: "light" },
    },
  });
  assert.notEqual(saved.kind, "error");
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  assert.equal(fixture.records.length, 0);
  return tasks;
}

export async function taskStates(page, tasks) {
  return Promise.all(
    tasks.map(async ({ id, model }) => {
      const result = await request(page, {
        kind: "read",
        query: { kind: "execution", task_id: id },
      });
      assert.equal(result.kind, "execution");
      return { taskId: id, model, state: result.snapshot.task.state };
    }),
  );
}
export async function showHistory(page, task) {
  await page.evaluate((id) => localStorage.setItem("workpilot.execution", id), task.id);
  await page.reload();
  await expect(page.getByRole("heading", { name: task.title, exact: true })).toBeVisible();
  await page.evaluate(installObservers);
}
export async function startFour(page, tasks, fixture) {
  const atMs = Date.now();
  const replies = await Promise.all(
    tasks.map((task) => request(page, { kind: "start_execution", task_id: task.id })),
  );
  assert(replies.every((reply) => reply.kind === "receipt"));
  await until(
    async () =>
      fixture.records.length === 4 && fixture.records.every((row) => row.chunks > 0 && !row.ended),
  );
  const states = await taskStates(page, tasks);
  assert(states.every((row) => row.state === "running"));
  await expect(page.getByTestId("execution-status")).toHaveAttribute("data-state", "running");
  return {
    atMs,
    observedAtMs: Date.now(),
    states,
    openStreams: fixture.records.filter((row) => !row.ended).length,
  };
}

export async function exerciseHistory(context) {
  const { page, output, directory, seed, tasks, fixture, selfTest } = context;
  const samples = selfTest ? 4 : 20;
  const beganAtMs = Date.now();
  const sidebar = page.getByRole("button", { name: "Projects & tasks", exact: true });
  await sidebar.evaluate((button) => {
    button.dataset.p13Button = "sidebar";
  });
  for (let index = 0; index < samples; index++) {
    const before = await sidebar.getAttribute("aria-pressed");
    await sidebar.click();
    await expect(sidebar).not.toHaveAttribute("aria-pressed", before);
  }
  const input = page.getByLabel("Send a new instruction", { exact: true });
  const send = page.locator(".execution-composer button.primary");
  for (let index = 0; index < samples; index++) {
    await input.fill("");
    await expect(send).toBeDisabled();
    await input.fill(`Unsent long-history input ${index}`);
    await expect(send).toBeEnabled();
  }
  await input.fill("");
  const metric = await page.evaluate(() => window.p13Metrics);
  assert.equal(metric.button.length, samples);
  assert.equal(metric.input.length, samples);
  const timing = (values, label) =>
    selfTest
      ? {
          count: values.length,
          samples: values,
          scope: label,
          diagnosticOnly: true,
          formalPercentiles: "not calculated in short self-test",
        }
      : distribution(values, 150, label);
  const measurements = {
    button: timing(
      metric.button,
      "Click event to sidebar aria-pressed DOM update, with four active streams and preseeded 100000 events",
    ),
    input: timing(
      metric.input,
      "Textarea input event to enabled queue button DOM update; no user message is submitted",
    ),
  };
  await page.screenshot({ path: join(output, "history-four-streams.png") });
  await page.getByRole("button", { name: "Records", exact: true }).click();
  const panel = page.locator(".record-panel");
  await panel.getByRole("button", { name: "Read from start", exact: true }).click();
  await expect(panel.locator("details")).toHaveCount(64);
  const firstPage = await panel.locator("details summary").allTextContents();
  await panel.getByRole("button", { name: "Next record page", exact: true }).click();
  await expect(panel.locator("details")).toHaveCount(64);
  await expect(panel.locator("details summary").first()).not.toHaveText(firstPage[0]);
  const secondPage = await panel.locator("details summary").allTextContents();
  assert(
    secondPage.every((value) => !firstPage.includes(value)),
    "Event pages must advance without duplicates",
  );
  await page.getByLabel("Search complete records", { exact: true }).fill("LONG_RECORD_END");
  const searchBegan = performance.now();
  await panel.getByRole("button", { name: "Search records", exact: true }).click();
  await expect(panel.locator("details")).toHaveCount(1, { timeout: 60000 });
  await expect(panel.getByRole("button", { name: "Search records", exact: true })).toBeEnabled({
    timeout: 60000,
  });
  const searchMs = performance.now() - searchBegan;
  await expect(panel.locator("details summary")).toContainText(`#${seed.textEventSequence}`);
  await panel.locator("details summary").click();
  const saved = panel.locator(".saved-content").first();
  await expect(saved.locator("pre")).toContainText("LONG_RECORD_BEGIN");
  await expect(saved.locator("pre")).not.toContainText("LONG_RECORD_END");
  const offset = await saved.locator(".model-actions small").textContent();
  await saved.getByRole("button", { name: "Next", exact: true }).click();
  await expect(saved.locator(".model-actions small")).not.toHaveText(offset);
  await expect(saved.locator("pre")).not.toContainText("LONG_RECORD_BEGIN");
  const secondBodyPage = await saved.locator(".model-actions small").textContent();
  // Intercept only this isolated WebView's write call; never read/replace OS clipboard.
  await page.evaluate(() => {
    window.p13LongClipboardOriginal = Object.getOwnPropertyDescriptor(
      navigator.clipboard,
      "writeText",
    );
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async (text) => {
        const bytes = new TextEncoder().encode(text);
        const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        window.p13LongCopied = {
          bytes: bytes.length,
          sha256: [...hash].map((b) => b.toString(16).padStart(2, "0")).join(""),
        };
      },
    });
  });
  await saved.getByRole("button", { name: "Copy full content", exact: true }).click();
  await expect(saved.getByText("Full content copied", { exact: true })).toBeVisible();
  const copied = await page.evaluate(() => {
    const original = window.p13LongClipboardOriginal;
    if (original) Object.defineProperty(navigator.clipboard, "writeText", original);
    else delete navigator.clipboard.writeText;
    return window.p13LongCopied;
  });
  assert.equal(copied.bytes, seed.bodyBytes);
  assert.equal(copied.sha256, seed.objectId);
  await page.screenshot({ path: join(output, "history-long-body-page.png") });
  const exportBegan = performance.now();
  await panel.getByRole("button", { name: "Export complete records", exact: true }).click();
  await expect(panel.getByText("Complete records exported", { exact: true })).toBeVisible({
    timeout: 60000,
  });
  const exportMs = performance.now() - exportBegan;
  const exportedText = await panel.locator(".execution-notice pre").textContent();
  const exported = await verifyFullExport({ path: exportedText.split("\n")[0], directory, seed });
  assert(exported.events >= seed.previousEventCount + 100001);
  const states = await taskStates(page, tasks);
  assert(states.every((row) => row.state === "running"));
  assert.equal(fixture.records.length, 4);
  assert(fixture.records.every((row) => !row.ended));
  return {
    beganAtMs,
    endedAtMs: Date.now(),
    measurements,
    searchMs,
    exportMs,
    eventPages: [firstPage, secondPage],
    bodyPages: [offset, secondBodyPage],
    copied,
    exported,
    afterStates: states,
  };
}

export async function stopOne(page, tasks, fixture) {
  const stop = page.getByRole("button", { name: "Stop task", exact: true });
  await stop.evaluate((button) => {
    button.dataset.p13Button = "stop";
  });
  const before = fixture.records.map((row) => ({ model: row.model, chunks: row.chunks }));
  const atMs = Date.now();
  await stop.click();
  await expect(page.getByTestId("execution-status")).toHaveAttribute("data-state", "interrupted");
  await until(async () => fixture.records.find((row) => row.model === tasks[0].model)?.ended);
  const states = await taskStates(page, tasks);
  assert.equal(states[0].state, "interrupted");
  assert(states.slice(1).every((row) => row.state === "running"));
  assert(fixture.records.filter((row) => row.model !== tasks[0].model).every((row) => !row.ended));
  const metrics = await page.evaluate(() => window.p13Metrics);
  assert.equal(metrics.stopFeedback.length, 1);
  assert.equal(metrics.stopFinished.length, 1);
  return {
    atMs,
    observedAtMs: Date.now(),
    before,
    states,
    feedbackMs: metrics.stopFeedback[0],
    interruptedDomMs: metrics.stopFinished[0],
    scope: "One cancellation sample, not a stop p95 or local-tool-tree measurement",
  };
}
