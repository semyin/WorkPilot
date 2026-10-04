import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { until, profile, create, snapshot, start, setFixture } from "./tool-test-support.mjs";
import { startTeamFixture } from "../services/execution-fixtures/teams.mjs";

const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/team-restore-desktop");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "session-"));
const binary =
  process.env.WORKPILOT_DESKTOP_BINARY || resolve("target/release/workpilot-desktop.exe");
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  binarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  service: "Native Windows WebView2 and local synthetic three-protocol models",
  checks: [],
};
const fixture = await startTeamFixture();
setFixture(fixture);
let child, browser, page;
const errors = [];
const request = (command) =>
  page.evaluate(
    (command) =>
      window.__TAURI_INTERNALS__.invoke("engine_command", {
        request: { request_id: crypto.randomUUID(), command },
      }),
    command,
  );
const archive = async (action) => {
  const r = await request({ kind: "task_archive", action });
  assert.equal(r.kind, "workbench", JSON.stringify(r));
  return r.data;
};
async function close() {
  if (child && child.exitCode === null) {
    const done = once(child, "exit");
    if (page)
      await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("exit_app")).catch(() => {});
    else child.kill();
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 10000);
    await done;
    clearTimeout(timer);
  }
  await browser?.close();
}
async function panel(english = false) {
  await page.getByRole("button", { name: english ? "Settings" : "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: english ? "Settings" : "设置", exact: true });
  await dialog
    .locator("summary")
    .filter({ hasText: english ? "Task and assistant archive transfer" : "任务与助手档案迁移" })
    .click();
  return { dialog, box: dialog.locator(".task-archive-panel") };
}
try {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  child = spawn(binary, [], {
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      WORKPILOT_CHANNEL: "test",
      WORKPILOT_DATA_DIR: join(directory, "data"),
      WEBVIEW2_USER_DATA_FOLDER: join(directory, "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`,
    },
  });
  await until(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
    } catch {
      return false;
    }
  }, 30000);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = await until(async () =>
    browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => /tauri\.localhost|tauri:/.test(p.url())),
  );
  page.on("pageerror", (e) => errors.push(String(e)));
  page.setDefaultTimeout(30000);
  await expect(page.getByText("引擎已连接", { exact: true })).toBeVisible();
  const engine = { request };
  const a = profile("chat_completions", "restore-native-research"),
    b = profile("messages", "restore-native-review");
  for (const p of [a, b]) {
    assert.equal(
      (await request({ kind: "save_provider", profile: p, secret: null, clear_credential: false }))
        .kind,
      "provider_saved",
    );
    fixture.definitions.set(p.model, {
      kind: "leaf",
      text: p === a ? "历史研究交付 42" : "历史核对结果 007",
    });
  }
  const members = [
    { key: "research", role: "研究助手", goal: "查找证据", profile_id: a.id, depends_on: [] },
    {
      key: "review",
      role: "核对助手",
      goal: "核对证据",
      profile_id: b.id,
      depends_on: ["research"],
    },
  ];
  fixture.definitions.set("restore-native-main", { kind: "main", members });
  const task = await create(engine, "responses", "restore-native-main", {
    title: "可恢复的协作团队",
    controlled_tools: false,
    limits: {
      max_steps: 64,
      max_duration_ms: 90000,
      context_bytes: 262144,
      max_result_bytes: 65536,
    },
  });
  await request({ kind: "enqueue", task_id: task, text: "团队原始要求 42" });
  await start(engine, task);
  await until(async () => (await snapshot(engine, task)).task.state === "completed", 60000);
  await request({ kind: "enqueue", task_id: task, text: "继续汇总原有交付" });
  const source = await snapshot(engine, task);
  const path = join(directory, "团队恢复.wptask"),
    password = "native team restoration " + crypto.randomUUID();
  await archive({ kind: "export", task_id: task, path, password });
  const inspected = await archive({ kind: "inspect", path, password });
  const imported = await archive({
    kind: "import",
    path,
    password,
    fingerprint: inspected.fingerprint,
  });
  let { dialog, box } = await panel();
  await box.getByLabel("选择查阅档案", { exact: true }).selectOption(imported.archive_id);
  let restore = box.getByRole("region", { name: "从档案恢复多助手任务", exact: true });
  const previewButton = restore.getByRole("button", { name: "预览团队恢复", exact: true });
  await expect(previewButton).toBeEnabled();
  await expect(restore.getByLabel("本机模型：研究助手", { exact: true })).toHaveValue(a.id);
  await expect(restore.getByLabel("本机模型：核对助手", { exact: true })).toHaveValue(b.id);
  await restore.getByLabel("本机模型：核对助手", { exact: true }).selectOption(a.id);
  await previewButton.click();
  await expect(restore.getByRole("alert")).toContainText("请选择原协议");
  await expect(restore.getByRole("button", { name: "确认恢复为新团队", exact: true })).toHaveCount(
    0,
  );
  await restore.getByLabel("本机模型：核对助手", { exact: true }).selectOption(b.id);
  await previewButton.click();
  const preview = restore.getByLabel("团队恢复预览", { exact: true });
  await expect(preview).toContainText("先等待：研究助手");
  await expect(preview).toContainText("交付已认可");
  await expect(preview).toContainText("排队消息：1");
  await preview
    .getByRole("button", { name: "确认恢复为新团队", exact: true })
    .scrollIntoViewIfNeeded();
  assert(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 2));
  await page.screenshot({ path: join(output, "team-restore-preview-zh.png") });
  report.checks.push(
    "native_per_assistant_model_matching_rejects_wrong_protocol_and_previews_dependencies_and_reviews",
  );
  const calls = fixture.records.length;
  await preview.getByRole("button", { name: "确认恢复为新团队", exact: true }).click();
  await expect(
    restore.getByRole("button", { name: "打开恢复的主任务", exact: true }),
  ).toBeVisible();
  assert.equal(fixture.records.length, calls);
  const saved = await archive({ kind: "team_restore_options", archive_id: imported.archive_id });
  assert(saved.already_restored);
  await restore.getByRole("button", { name: "打开恢复的主任务", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.locator(".conversation").getByText("团队原始要求 42", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".team-member")).toHaveCount(2);
  const card = page
    .locator(".team-member")
    .filter({ has: page.getByText("研究助手", { exact: true }) });
  await card.getByRole("button", { name: "查看交付", exact: true }).click();
  await expect(card.locator(".team-delivery")).toContainText("历史研究交付 42");
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "team-restore-delivery-zh.png") });
  const memberCalls = fixture.starts.filter((r) => r.model !== "restore-native-main").length;
  await page.getByRole("button", { name: "继续任务", exact: true }).click();
  await until(
    async () => (await snapshot(engine, saved.task_id)).task.state === "completed",
    30000,
  );
  assert.equal(fixture.starts.filter((r) => r.model !== "restore-native-main").length, memberCalls);
  assert.deepEqual(await snapshot(engine, task), source);
  report.checks.push(
    "native_confirm_opens_restored_team_history_and_deliveries_manual_continue_does_not_rerun_completed_assistants",
  );
  await page.getByRole("button", { name: "English", exact: true }).click();
  ({ dialog, box } = await panel(true));
  await box.getByLabel("Select archive to read", { exact: true }).selectOption(imported.archive_id);
  restore = box.getByRole("region", { name: "Restore a task group from archive", exact: true });
  await expect(restore).toContainText("repeating it creates no duplicate");
  await restore
    .getByRole("button", { name: "Open restored main task", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "team-restore-duplicate-en.png") });
  assert(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 2));
  assert.equal(errors.length, 0, errors.join("\n"));
  report.checks.push(
    "native_english_duplicate_receipt_no_layout_overflow_and_no_javascript_errors",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
  await page?.screenshot({ path: join(output, "failure.png") }).catch(() => {});
} finally {
  await close();
  await fixture.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
