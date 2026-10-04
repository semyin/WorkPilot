import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { expect } from "@playwright/test";
import { startTeamFixture } from "../services/execution-fixtures/teams.mjs";
import { profile, setFixture } from "./tool-test-support.mjs";
import { eventually } from "./p13-engine-client.mjs";
import { statusHarness, responseGates } from "./p13-status-ui-support.mjs";

const native = !!process.env.WORKPILOT_DESKTOP_BINARY;
const binary = resolve(
  native
    ? process.env.WORKPILOT_DESKTOP_BINARY
    : process.env.WORKPILOT_ENGINE_BINARY ||
        "artifacts/workpilot-p13-baseline-2026-10-04/preview/workpilot-sidecar.exe",
);
const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/p13-task-state-ui");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "session-"));
const fixture = await startTeamFixture();
setFixture(fixture);
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  native,
  binarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  scope: native
    ? "Native Windows desktop and engine; synthetic local model and delayed IPC replies"
    : "Current React source in isolated Chrome; real packaged engine; synthetic local model and delayed IPC replies. Not native desktop acceptance.",
  checks: [],
  screenshots: [],
};
let harness, gates;
try {
  harness = await statusHarness(directory, binary, native);
  const { page } = harness;
  page.setDefaultTimeout(15000);
  gates = await responseGates(page);
  report.responseGateTransport = gates.transport;
  const command = async (value) => {
    const result = await harness.request(value);
    assert.notEqual(result.kind, "error", JSON.stringify(result));
    return result;
  };
  const snapshot = async (task) =>
    (await command({ kind: "read", query: { kind: "execution", task_id: task } })).snapshot;
  const team = async (task) =>
    (await command({ kind: "read", query: { kind: "team", task_id: task } })).view;
  const sidebar = (task) => page.locator(`.workspace-task-list [data-execution-id="${task}"]`);
  const title = page.getByTestId("execution-status");
  const select = async (task) => {
    await sidebar(task).click();
    await expect(title).toHaveAttribute("data-task-id", task);
  };
  const state = async (task, value) => {
    await expect(title).toHaveAttribute("data-task-id", task);
    await expect(title).toHaveAttribute("data-state", value);
    await expect(sidebar(task).locator("[data-state]")).toHaveAttribute("data-state", value);
  };
  const createProfile = async (name, definition) => {
    fixture.definitions.set(name, definition);
    const p = profile("responses", name);
    p.options.timeout_ms = 90000;
    p.options.idle_timeout_ms = 90000;
    await command({ kind: "save_provider", profile: p, secret: null, clear_credential: false });
    return p.id;
  };
  const create = async (name, definition, mode = "chat") => {
    const profile_id = await createProfile(name, definition);
    const r = await command({
      kind: "create_execution",
      config: {
        title: name,
        goal: "Observe only this isolated fixture task",
        constraints: [],
        project_rules: "",
        project_id: null,
        profile_id,
        mode,
        controlled_tools: false,
        limits: {
          max_steps: 32,
          max_duration_ms: 90000,
          context_bytes: 65536,
          max_result_bytes: 32768,
        },
      },
    });
    return r.receipt.task_id;
  };
  const start = (task) => command({ kind: "start_execution", task_id: task });
  const detailOf = (task) => (c) =>
    c.kind === "read" &&
    c.query.kind === "workspace" &&
    c.query.query.kind === "detail" &&
    c.query.query.task_id === task;
  const teamOf = (task) => (c) =>
    c.kind === "read" && c.query.kind === "team" && c.query.task_id === task;
  const shot = async (name) => {
    await page.screenshot({ path: join(directory, name), fullPage: true });
    report.screenshots.push(name);
  };

  const a = await create("同步停止 A", { kind: "hold", ms: 18000 });
  const independent = await create("独立任务 B", { kind: "hold", ms: 18000 });
  await start(a);
  await start(independent);
  await select(a);
  await state(a, "running");
  const staleList = gates.hold(
    (c) => c.kind === "read" && c.query.kind === "workspace" && c.query.query.kind === "tasks",
  );
  await staleList.captured;
  const pendingCancel = gates.hold((c) => c.kind === "cancel" && c.task_id === a, "before");
  await page.getByRole("button", { name: /^(停止任务|Stop task)$/ }).click();
  await pendingCancel.captured;
  await state(a, "stopping");
  assert.equal((await snapshot(a)).task.state, "running");
  await delay(300);
  await state(a, "stopping");
  pendingCancel.release();
  await state(a, "interrupted");
  assert.equal((await snapshot(independent)).task.state, "running");
  staleList.release();
  await delay(250);
  await state(a, "interrupted");
  await shot("stop-and-sidebar-zh.png");
  report.checks.push(
    "cancel_intent_and_actual_completion_shared_with_sidebar_late_running_list_rejected_independent_task_kept",
  );

  const overview = await command({
    kind: "read",
    query: { kind: "workspace", query: { kind: "overview" } },
  });
  await command({
    kind: "workspace",
    action: {
      kind: "save_preferences",
      preferences: { ...overview.data.preferences, language: "en" },
    },
  });
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  const complete = await create("Synchronized completion", {
    kind: "leaf",
    delay: 500,
    text: "Completed source",
  });
  await select(complete);
  await page.getByRole("button", { name: "Continue task", exact: true }).click();
  await state(complete, "completed");
  const failed = await create("Synchronized error", { kind: "error" });
  await select(failed);
  await page.getByRole("button", { name: "Continue task", exact: true }).click();
  await state(failed, "failed");
  assert.equal(fixture.starts.filter((x) => x.model === "Synchronized error").length, 1);
  await shot("failed-and-sidebar-en.png");
  report.checks.push(
    "actual_completion_and_model_error_share_task_state_english_no_automatic_retry",
  );

  await select(complete);
  const oldDetail = gates.hold(detailOf(complete));
  const oldTeam = gates.hold(teamOf(complete));
  await Promise.all([oldDetail.captured, oldTeam.captured]);
  await select(failed);
  oldDetail.release();
  oldTeam.release();
  await delay(250);
  await state(failed, "failed");
  const lateError = gates.hold(detailOf(failed), "after", {
    kind: "error",
    code: "status_test",
    message: "LATE_TASK_A_FAILURE",
  });
  await lateError.captured;
  await select(complete);
  lateError.release();
  await delay(250);
  await state(complete, "completed");
  await expect(page.getByText("LATE_TASK_A_FAILURE", { exact: true })).toHaveCount(0);
  report.checks.push(
    "switch_tasks_rejects_old_detail_team_and_error_replies_without_cross_task_content",
  );

  const queued = await create("Message read race", {
    kind: "leaf",
    delay: 700,
    text: "Queue result",
  });
  await select(queued);
  await start(queued);
  await state(queued, "running");
  const oldMessageRead = gates.hold(detailOf(queued));
  await oldMessageRead.captured;
  await page.getByLabel("Send a new instruction", { exact: true }).fill("Queued message");
  await page.getByRole("button", { name: /^(Queue message|Send)$/ }).click();
  await eventually(async () => (await snapshot(queued)).task.state === "completed");
  // A newer engine observation publishes completion while this old detail is still delayed.
  await state(queued, "completed");
  oldMessageRead.release();
  await delay(250);
  await state(queued, "completed");
  report.checks.push("message_refresh_and_poll_race_cannot_restore_running_after_completion");

  const cancelFailure = await create("Cancel failure source", { kind: "hold", ms: 18000 });
  await start(cancelFailure);
  await select(cancelFailure);
  await state(cancelFailure, "running");
  const rejectedCancel = gates.hold(
    (c) => c.kind === "cancel" && c.task_id === cancelFailure,
    "before",
    { kind: "error", code: "status_test", message: "CANCEL_REJECTED_FOR_OLD_TASK" },
  );
  await page.getByRole("button", { name: "Stop task", exact: true }).click();
  await rejectedCancel.captured;
  await state(cancelFailure, "stopping");
  await select(complete);
  rejectedCancel.release();
  await delay(250);
  await state(complete, "completed");
  await expect(page.getByText("CANCEL_REJECTED_FOR_OLD_TASK", { exact: true })).toHaveCount(0);
  await select(cancelFailure);
  await state(cancelFailure, "running");
  await command({ kind: "cancel", task_id: cancelFailure });
  report.checks.push("cancel_error_clears_only_its_own_intent_and_does_not_leak_to_new_selection");

  const heldProfile = await createProfile("held-member", { kind: "hold", ms: 18000 });
  const errorProfile = await createProfile("failed-member", { kind: "error" });
  const lead = await create(
    "Team synchronization",
    {
      kind: "main",
      members: [
        {
          key: "held",
          role: "Held child",
          goal: "Wait in a model request",
          profile_id: heldProfile,
          depends_on: [],
        },
        {
          key: "bad",
          role: "Failed child",
          goal: "Return the synthetic failure",
          profile_id: errorProfile,
          depends_on: [],
        },
      ],
    },
    "execute",
  );
  await command({
    kind: "configure_team",
    task_id: lead,
    settings: {
      enabled: true,
      max_parallel: 3,
      max_members: 8,
      max_depth: 2,
      max_replacements: 1,
      revision: 0,
    },
  });
  const folder = join(directory, "team-project");
  await mkdir(folder);
  await command({
    kind: "configure_task_tools",
    task_id: lead,
    settings: {
      root_path: folder,
      permission: "full_access",
      review_profile_id: null,
      commands_enabled: false,
      revision: 0,
    },
  });
  await start(lead);
  await select(lead);
  const view = await eventually(async () => {
    const value = await team(lead);
    return (
      value.members.some((m) => m.state === "running") &&
      value.members.some((m) => m.state === "failed") &&
      value
    );
  });
  const child = view.members.find((m) => m.state === "running").task_id;
  const bad = view.members.find((m) => m.state === "failed").task_id;
  await expect(page.locator(`[data-member-id="${child}"]`)).toHaveAttribute(
    "data-member-state",
    "running",
  );
  await expect(page.locator(`[data-member-id="${bad}"]`)).toHaveAttribute(
    "data-member-state",
    "failed",
  );
  await page.getByRole("button", { name: "Stop task", exact: true }).click();
  await state(lead, "interrupted");
  await expect(page.locator(`[data-member-id="${child}"]`)).toHaveAttribute(
    "data-member-state",
    "interrupted",
  );
  await expect(page.locator(`[data-member-id="${bad}"]`)).toHaveAttribute(
    "data-member-state",
    "failed",
  );
  await page
    .locator(`[data-member-id="${child}"]`)
    .getByRole("button", { name: "Open trace and approvals", exact: true })
    .click();
  await expect(title).toHaveAttribute("data-task-id", child);
  await expect(title).toHaveAttribute("data-state", "interrupted");
  await page.getByRole("button", { name: "Return to main task", exact: true }).click();
  await state(lead, "interrupted");
  await shot("team-stopped-en.png");
  report.checks.push(
    "parent_stop_and_failed_running_members_use_actual_states_child_navigation_stays_scoped",
  );

  report.observations = await page.evaluate(() => window.__statusObservations);
  report.mismatches = await page.evaluate(() => window.__statusMismatches);
  assert.deepEqual(report.mismatches, []);
  assert.deepEqual(harness.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  if (harness)
    await harness.page
      .screenshot({ path: join(directory, "failure.png"), fullPage: true })
      .catch(() => {});
  process.exitCode = 1;
} finally {
  gates?.releaseAll();
  await harness?.close().catch((e) => {
    report.cleanupError = String(e);
    process.exitCode = 1;
  });
  await fixture.close();
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      directory,
      status: report.status,
      checks: report.checks.length,
      error: report.error,
      cleanupError: report.cleanupError,
    }),
  );
}
