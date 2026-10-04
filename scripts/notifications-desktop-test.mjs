import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { expect } from "@playwright/test";
import { setTimeout as delay } from "node:timers/promises";
import { startExecutionFixture } from "../services/execution-fixtures/server.mjs";
import { profile, setFixture } from "./tool-test-support.mjs";
import { project } from "./task-history-support.mjs";
import { launchDesktop, quitDesktop, request, until } from "./p13-desktop-support.mjs";
import { verifyAutomaticTeamWait } from "./notifications-team-test.mjs";

const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/p13-notifications");
const binary = resolve(
  process.env.WORKPILOT_DESKTOP_BINARY || "target/release/workpilot-desktop.exe",
);
const installed = process.argv.includes("--installed");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "session-"));
const userData = join(directory, "data");
const folder = join(directory, "project");
const privateMarker = "Synthetic private project text 9817";
const fixture = await startExecutionFixture((body, results) => {
  if (body.model.startsWith("notice-write"))
    return results.length
      ? { text: "Done", calls: [] }
      : {
          text: "",
          calls: [
            {
              name: "write_file",
              args: {
                path: body.model + ".txt",
                text: privateMarker,
                expected_sha256: null,
              },
            },
          ],
        };
  if (body.model === "notice-done") return { text: privateMarker, calls: [], delay: 300 };
});
setFixture(fixture);
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  binarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  service:
    "Real Windows desktop and sidecar; synthetic local model; only newly created data/project directories",
  systemScope: installed
    ? "Installed executable: Windows API submission checked; visible popup and activation require separate native shell evidence"
    : "Portable copy: explicit system-notification fallback only; no Windows popup claim",
  checks: [],
  screenshots: [],
};
let session, page, projectId;
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
const snapshot = () => invoke("notifications_snapshot");
const engine = { request: (command) => request(page, command) };
async function launch() {
  session = await launchDesktop(binary, userData);
  page = session.page;
  await until(async () => (await snapshot()).ready);
  assert.equal(
    (await snapshot()).system_available,
    installed,
    "--installed must match the actual executable's registered install directory",
  );
}
async function task(model, title = model, permission = "request_approval") {
  const p = profile("responses", model);
  assert.equal(
    (
      await engine.request({
        kind: "save_provider",
        profile: p,
        secret: null,
        clear_credential: false,
      })
    ).kind,
    "provider_saved",
  );
  const created = await engine.request({
    kind: "create_execution",
    config: {
      title,
      goal: "Synthetic notification acceptance",
      constraints: [],
      project_rules: "",
      project_id: projectId,
      profile_id: p.id,
      mode: "execute",
      controlled_tools: model === "runtime-ask",
      limits: {
        max_steps: 8,
        max_duration_ms: 30000,
        context_bytes: 65536,
        max_result_bytes: 32768,
      },
    },
  });
  assert.equal(created.kind, "receipt", JSON.stringify(created));
  const id = created.receipt.task_id;
  const tools = await engine.request({
    kind: "configure_task_tools",
    task_id: id,
    settings: {
      root_path: folder,
      permission,
      review_profile_id: null,
      commands_enabled: false,
      revision: 0,
    },
  });
  assert.equal(tools.kind, "receipt", JSON.stringify(tools));
  return id;
}
async function finish(id, kind, { foreground = true } = {}) {
  await invoke(foreground ? "show_window" : "hide_window");
  await delay(150);
  assert.equal((await engine.request({ kind: "start_execution", task_id: id })).kind, "receipt");
  const notice = await until(async () =>
    (await snapshot()).entries.find((n) => n.task_id === id && n.kind === kind),
  );
  await until(
    async () => (await snapshot()).entries.find((n) => n.id === notice.id)?.delivery !== "pending",
  );
  return (await snapshot()).entries.find((n) => n.id === notice.id);
}
async function center() {
  await page.getByTestId("notification-center-open").click();
  return page.getByRole("dialog", { name: /^(通知中心|Notification center)$/, exact: true });
}
async function screenshot(name) {
  await page.screenshot({ path: join(output, name) });
  report.screenshots.push(name);
}
async function clearSelection() {
  await page.evaluate(() => {
    localStorage.removeItem("workpilot.execution");
    localStorage.removeItem("workpilot.project");
  });
}
try {
  await launch();
  assert.deepEqual((await snapshot()).preferences, {
    in_app: true,
    system: true,
    tray: true,
    foreground: false,
  });
  projectId = await project(engine, privateMarker, folder, "request_approval");
  const doneTask = await task("notice-done", "Notification complete task");
  const failedTask = await task("runtime-error", "Notification failed task");
  const inputTask = await task("runtime-ask", "Notification input task");
  const approvalTask = await task("notice-write-approval", "Notification approval task");
  const kinds = ["completed", "failed", "input", "approval"];
  for (const [index, id] of [doneTask, failedTask, inputTask, approvalTask].entries()) {
    const notice = await finish(id, kinds[index]);
    assert.equal(
      notice.delivery,
      "foreground",
      "Focused windows should not send default OS popups",
    );
  }
  let state = await snapshot();
  assert.equal(state.entries.length, 4);
  assert.equal(state.unread, 4);
  assert.equal(JSON.stringify(state).includes(privateMarker), false);
  const persisted = await readFile(
    join(userData, "test", "desktop-notifications", "state.json"),
    "utf8",
  );
  assert.equal(persisted.includes(privateMarker), false);
  assert.equal(persisted.includes("Notification approval task"), false);
  report.checks.push(
    "four_real_terminal_task_events_foreground_suppression_and_metadata_only_records",
  );

  let box = await center();
  await expect(box).toContainText("Notification approval task");
  await expect(box).toContainText(privateMarker);
  await screenshot("notifications-inbox-zh.png");
  const callsBeforeOpen = fixture.records.length;
  await box
    .locator('[data-notification-kind="approval"]')
    .getByRole("button", { name: "打开任务", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Notification approval task", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("execution-status")).toHaveAttribute(
    "data-state",
    "awaiting_approval",
  );
  await expect(page.getByLabel("筛选项目", { exact: true })).toHaveValue(projectId);
  assert.equal(fixture.records.length, callsBeforeOpen);
  assert.equal(
    (await engine.request({ kind: "read", query: { kind: "execution", task_id: approvalTask } }))
      .snapshot.task.state,
    "awaiting_approval",
  );
  assert.equal((await snapshot()).unread, 3);
  report.checks.push(
    "notification_opens_exact_task_and_project_without_approval_or_resuming_execution",
  );

  const ids = (await snapshot()).entries.map((n) => n.id);
  for (let i = 0; i < 10; i++) {
    await engine.request({
      kind: "read",
      query: { kind: "events", task_id: approvalTask, after: 0, limit: 256 },
    });
    await snapshot();
  }
  await page.reload();
  await expect(page.getByTestId("notification-center-open")).toBeVisible();
  assert.deepEqual(
    (await snapshot()).entries.map((n) => n.id),
    ids,
  );
  const automaticTask = await task("notice-write-auto", "Automatic approved write", "full_access");
  await finish(automaticTask, "completed");
  assert.deepEqual(
    (await snapshot()).entries.filter((n) => n.task_id === automaticTask).map((n) => n.kind),
    ["completed"],
  );
  report.checks.push(
    "event_history_reads_and_webview_reload_do_not_duplicate_and_auto_approved_tool_does_not_request_human_attention",
  );

  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "设置", exact: true });
  await settings
    .locator("summary")
    .filter({ hasText: /^通知$/ })
    .click();
  await settings.getByLabel("Windows 系统通知", { exact: true }).click();
  await expect(settings.getByLabel("Windows 系统通知", { exact: true })).not.toBeChecked();
  await until(async () => !(await snapshot()).preferences.system);
  await expect(settings.getByRole("status")).toHaveText("通知设置已保存。");
  await settings.getByLabel("托盘红点和未读数量", { exact: true }).click();
  await expect(settings.getByLabel("托盘红点和未读数量", { exact: true })).not.toBeChecked();
  await until(async () => !(await snapshot()).preferences.tray);
  await screenshot("notification-settings-zh.png");
  await settings.getByRole("button", { name: "关闭", exact: true }).click();
  const disabledTask = await task("notice-done", "Notifications disabled");
  assert.equal((await finish(disabledTask, "completed", { foreground: false })).delivery, "off");
  await invoke("show_window");
  await invoke("notifications_save", {
    preferences: { in_app: true, system: true, tray: true, foreground: false },
  });
  const backgroundTask = await task("notice-done", "Background notification");
  const background = await finish(backgroundTask, "completed", { foreground: false });
  assert.equal(background.delivery, installed ? "submitted" : "unavailable");
  await invoke("show_window");
  assert.equal((await snapshot()).entries.length, 7);
  report.checks.push(
    installed
      ? "settings_switches_and_background_windows_api_submission"
      : "settings_switches_and_background_portable_explicit_fallback_keep_task_and_inbox",
  );

  box = await center();
  await box.getByRole("button", { name: "全部标为已读", exact: true }).click();
  await until(async () => (await snapshot()).unread === 0);
  await box.getByRole("button", { name: "关闭", exact: true }).click();
  const recordsBeforeRestart = (await snapshot()).entries;
  await clearSelection();
  assert.deepEqual(session.errors, []);
  await quitDesktop(session);
  session = null;
  await launch();
  state = await snapshot();
  assert.deepEqual(state.entries, recordsBeforeRestart);
  assert.equal(state.last_delivery, null);
  assert.equal(state.unread, 0);
  await expect(page.getByTestId("notification-center-open")).toHaveAccessibleName(
    "通知中心（0 条未读）",
  );
  const beforeDeleted = fixture.records.length;
  assert.equal(
    (await engine.request({ kind: "delete_task", task_id: backgroundTask })).kind,
    "receipt",
  );
  await assert.rejects(invoke("notifications_open", { id: background.id }), /deleted|unavailable/);
  await assert.rejects(invoke("notifications_open", { id: "not-a-local-notification" }));
  assert.equal(fixture.records.length, beforeDeleted);
  report.checks.push(
    "restart_preserves_read_state_without_resending_and_deleted_unknown_targets_do_not_run_work",
  );

  const path = join(userData, "test", "desktop-notifications", "state.json");
  const before = await readFile(path);
  await chmod(path, 0o444);
  try {
    await assert.rejects(
      invoke("notifications_save", { preferences: { ...state.preferences, system: false } }),
    );
    assert.deepEqual(await readFile(path), before);
    assert.equal((await snapshot()).preferences.system, true);
  } finally {
    await chmod(path, 0o666);
  }
  const overview = await engine.request({
    kind: "read",
    query: { kind: "workspace", query: { kind: "overview" } },
  });
  await engine.request({
    kind: "workspace",
    action: {
      kind: "save_preferences",
      preferences: { ...overview.data.preferences, language: "en" },
    },
  });
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  box = await center();
  await screenshot("notifications-inbox-en.png");
  await box.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const englishSettings = page.getByRole("dialog", { name: "Settings", exact: true });
  await englishSettings
    .locator("summary")
    .filter({ hasText: /^Notifications$/ })
    .click();
  await expect(
    englishSettings.getByLabel("Windows system notifications", { exact: true }),
  ).toBeChecked();
  await englishSettings
    .getByRole("button", { name: "Send a test notification", exact: true })
    .click();
  await expect(englishSettings.getByRole("status")).toContainText(
    installed ? "Submitted to Windows" : "unavailable",
  );
  await screenshot("notification-settings-en.png");
  assert.deepEqual(session.errors, []);
  report.checks.push(
    "real_readonly_settings_failure_preserves_bytes_and_bilingual_controls_and_test_notification_result",
  );
  await verifyAutomaticTeamWait({ page, invoke, report });
  assert.deepEqual(session.errors, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  if (page) await page.screenshot({ path: join(output, "failure.png") }).catch(() => {});
  throw error;
} finally {
  if (session)
    await quitDesktop(session).catch((e) => {
      report.shutdownError = String(e);
      report.status = "failed";
    });
  await fixture.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
