import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { root } from "./cargo.mjs";
import { profile, setFixture } from "./tool-test-support.mjs";
import { startExecutionFixture } from "../services/execution-fixtures/server.mjs";
import { workspaceScenario } from "./workspace-scenario.mjs";
const output = join(root, ".test-results/workspace-desktop");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "session-"));
const folder = join(directory, "project");
await mkdir(folder);
const fixture = await startExecutionFixture((body, results) => {
  if (body.model === "workspace-test") return { text: "工作台验证完成", calls: [], delay: 7000 };
  if (body.model.startsWith("workspace-approve")) {
    const name = body.model + ".txt";
    if (results.length === 0)
      return {
        text: "",
        calls: [
          {
            name: "write_file",
            args: { path: name, text: "Approved actual file", expected_sha256: null },
          },
        ],
      };
    if (results.length === 1)
      return { text: "", calls: [{ name: "register_artifact", args: { path: name } }] };
    return { text: "Saved approved file", calls: [] };
  }
});
setFixture(fixture);
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  service: "synthetic local model; native WebView and real engine/files",
  checks: [],
};
const errors = [];
const binary =
  process.env.WORKPILOT_DESKTOP_BINARY || join(root, "target/release/workpilot-desktop.exe");
report.binarySha256 = createHash("sha256")
  .update(await readFile(binary))
  .digest("hex");
async function until(check) {
  for (let n = 0; n < 400; n++) {
    const result = await check().catch(() => false);
    if (result) return result;
    await delay(50);
  }
  throw new Error("Native launch timed out");
}
async function launch() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const child = spawn(binary, [], {
    cwd: root,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      WORKPILOT_CHANNEL: "test",
      WORKPILOT_DATA_DIR: directory,
      WEBVIEW2_USER_DATA_FOLDER: join(directory, "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
        "--remote-debugging-address=127.0.0.1 --remote-debugging-port=" + port,
    },
  });
  try {
    await until(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = await until(async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => /tauri\.localhost|tauri:/.test(p.url())),
    );
    page.setDefaultTimeout(12000);
    page.on("pageerror", (e) => errors.push(String(e)));
    await expect(page.getByText(/^(引擎已连接|Engine connected)$/)).toBeVisible();
    return { child, browser, page };
  } catch (e) {
    child.kill();
    throw e;
  }
}
const request = (page, command) =>
  page.evaluate(
    (command) =>
      window.__TAURI_INTERNALS__.invoke("engine_command", {
        request: { request_id: crypto.randomUUID(), command },
      }),
    command,
  );
async function quit(session) {
  const exited = once(session.child, "exit");
  await session.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("exit_app")).catch(() => {});
  await exited;
  await session.browser.close().catch(() => {});
}
async function newEnglishTask(page, title, model, mode = "execute") {
  await page.getByRole("button", { name: "+ New task", exact: true }).click();
  await page.getByLabel("Task title (optional)", { exact: true }).fill(title);
  await page
    .getByLabel("What would you like to do?", { exact: true })
    .fill("Run this isolated test.");
  await page.getByLabel("Work mode", { exact: true }).selectOption(mode);
  await page.getByLabel("Task model", { exact: true }).selectOption(model);
  await page.getByRole("button", { name: "Create and start", exact: true }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  return page.evaluate(() => localStorage.getItem("workpilot.execution"));
}
let session;
try {
  session = await launch();
  let page = session.page;
  const p = profile("responses", "workspace-test");
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
  const task = await workspaceScenario({
    page,
    request: (c) => request(page, c),
    folder,
    report,
    output,
    profile: p,
  });
  await page.getByLabel("Search tasks", { exact: true }).fill("");
  const profiles = {};
  for (const name of [
    "workspace-approve-a",
    "workspace-approve-b",
    "runtime-error",
    "runtime-hold",
  ]) {
    const p = profile("responses", name);
    await request(page, {
      kind: "save_provider",
      profile: p,
      secret: null,
      clear_credential: false,
    });
    profiles[name] = p.id;
  }
  const a = await newEnglishTask(page, "Approval A", profiles["workspace-approve-a"]);
  await expect(page.getByTestId("execution-status")).toHaveAttribute(
    "data-state",
    "awaiting_approval",
  );
  const b = await newEnglishTask(page, "Approval B", profiles["workspace-approve-b"]);
  await expect(page.getByTestId("execution-status")).toHaveAttribute(
    "data-state",
    "awaiting_approval",
  );
  await expect(page.locator(".approval-card")).toContainText("workspace-approve-b.txt");
  await page.getByRole("button", { name: "Approve and continue", exact: true }).click();
  await expect(page.getByTestId("execution-status")).toHaveAttribute("data-state", "completed");
  assert.equal(
    await readFile(join(folder, "workspace-approve-b.txt"), "utf8"),
    "Approved actual file",
  );
  assert.equal(
    (await request(page, { kind: "read", query: { kind: "execution", task_id: a } })).snapshot.task
      .state,
    "awaiting_approval",
  );
  await page.locator(`[data-execution-id="${a}"]`).click();
  await page.getByRole("button", { name: "Reject action", exact: true }).click();
  await expect(page.getByTestId("execution-status")).toHaveAttribute("data-state", "interrupted");
  report.checks.push("english_approval_task_switch_only_changes_bound_task_rejection_preserved");
  await newEnglishTask(page, "Model failure", profiles["runtime-error"], "chat");
  await expect(page.getByTestId("execution-status")).toHaveAttribute("data-state", "failed");
  await expect(page.locator('.execution-main [role="alert"]')).toBeVisible();
  report.checks.push("english_model_error_and_manual_continue_visible");
  const held = await newEnglishTask(page, "Background task", profiles["runtime-hold"], "chat");
  await expect(page.getByTestId("execution-status")).toHaveAttribute("data-state", "running");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Appearance", { exact: true }).selectOption("light");
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  assert.equal(
    (await request(page, { kind: "read", query: { kind: "execution", task_id: held } })).snapshot
      .task.state,
    "running",
  );
  await page.getByRole("button", { name: "Hide window", exact: true }).click();
  await delay(5500);
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("show_window"));
  await expect(page.getByTestId("execution-status")).toHaveAttribute("data-state", "completed");
  report.checks.push("appearance_does_not_stop_work_hide_keeps_task_running_restore_no_resubmit");
  await page.locator(`[data-execution-id="${task}"]`).click();
  await quit(session);
  session = null;
  // Synthetic stress records are seeded only into this test-owned, closed database.
  const db = new DatabaseSync(join(directory, "test/workpilot.sqlite3"));
  db.exec("PRAGMA foreign_keys=ON; BEGIN");
  let seq = db
    .prepare("SELECT COALESCE(MAX(task_sequence),0) n FROM events WHERE task_id=?")
    .get(task).n;
  const insert = db.prepare(
    "INSERT INTO events(event_id,task_id,task_sequence,source,at_ms,payload_json) VALUES(?,?,?,'engine',?,?)",
  );
  for (let n = 0; n < 100000; n++)
    insert.run(
      crypto.randomUUID(),
      task,
      ++seq,
      Date.now(),
      JSON.stringify({ kind: "progress", current: n, total: 100000 }),
    );
  const long = Buffer.from("LONG_RECORD_BEGIN\n" + "文".repeat(700000) + "\nLONG_RECORD_END");
  const object = createHash("sha256").update(long).digest("hex");
  await writeFile(join(directory, "test/objects", object), long);
  db.prepare(
    "INSERT INTO objects(id,bytes,media_type) VALUES(?,?,'text/plain; charset=utf-8')",
  ).run(object, long.length);
  const row = insert.run(
    crypto.randomUUID(),
    task,
    ++seq,
    Date.now(),
    JSON.stringify({
      kind: "text_delta",
      content: { object_id: object, bytes: long.length, media_type: "text/plain; charset=utf-8" },
    }),
  );
  db.prepare("INSERT INTO event_objects(event_sequence,object_id) VALUES(?,?)").run(
    row.lastInsertRowid,
    object,
  );
  db.prepare("UPDATE tasks SET last_sequence=? WHERE id=?").run(Number(row.lastInsertRowid), task);
  db.exec("COMMIT");
  db.close();
  const started = performance.now();
  session = await launch();
  page = session.page;
  await expect(page.getByRole("heading", { name: "归档验证任务", exact: true })).toBeVisible();
  report.stressOpenMs = Math.round(performance.now() - started);
  const editStart = performance.now();
  await page
    .getByLabel("Send a new instruction", { exact: true })
    .fill("Still responsive with 100000 events");
  report.stressInputMs = Math.round(performance.now() - editStart);
  await page.getByRole("button", { name: "Send and continue", exact: true }).click();
  await expect(page.getByTestId("execution-status")).toHaveAttribute("data-state", "running");
  await page.getByRole("button", { name: "Records", exact: true }).click();
  await page.getByLabel("Search complete records", { exact: true }).fill("LONG_RECORD_END");
  const searchStart = performance.now();
  await page.getByRole("button", { name: "Search records", exact: true }).click();
  const stopStart = performance.now();
  await page.getByRole("button", { name: "Stop task", exact: true }).click();
  await expect(page.getByTestId("execution-status")).not.toHaveAttribute("data-state", "running");
  report.stressStopFeedbackMs = Math.round(performance.now() - stopStart);
  await expect(page.locator(".record-panel details")).not.toHaveCount(0, { timeout: 60000 });
  report.stressSearchMs = Math.round(performance.now() - searchStart);
  await page.locator(".record-panel details").last().locator("summary").first().click();
  await expect(page.locator(".record-panel .saved-content pre").first()).toContainText(
    "LONG_RECORD_BEGIN",
  );
  await expect(page.locator(".record-panel .saved-content pre").first()).not.toContainText(
    "LONG_RECORD_END",
  );
  // Observe the complete copy payload in this isolated test webview. Do not
  // read or replace the user's OS clipboard (which may contain non-text data).
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: async (text) => {
        window.__testCopy = {
          bytes: new TextEncoder().encode(text).length,
          ends: text.endsWith("LONG_RECORD_END"),
        };
      },
    });
  });
  await page
    .locator(".record-panel .saved-content")
    .first()
    .getByRole("button", { name: "Copy full content", exact: true })
    .click();
  await expect(page.getByText("Full content copied", { exact: true })).toBeVisible();
  const copy = await page.evaluate(() => window.__testCopy);
  assert.equal(copy.bytes, long.length);
  assert(copy.ends);
  await page.screenshot({
    path: join(output, "hundred-thousand-events.png"),
    animations: "disabled",
  });
  report.checks.push("native_100000_events_input_search_2mb_paging_and_full_copy");
  assert.deepEqual(errors, []);
  report.result = "passed";
} catch (e) {
  report.result = "failed";
  report.error = e.stack;
  process.exitCode = 1;
  if (session) await session.page.screenshot({ path: join(output, "failure.png") }).catch(() => {});
} finally {
  if (session && session.child.exitCode === null)
    await quit(session).catch(() => session.child.kill());
  await fixture.close();
  report.pageErrors = errors;
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
