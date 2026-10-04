// Installed-app companion to the separate Computer Use observation/click checks.
// This harness controls only its own test data through IPC. It never clicks Windows UI.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { startExecutionFixture } from "../services/execution-fixtures/server.mjs";
import { profile, setFixture } from "./tool-test-support.mjs";
import { project } from "./task-history-support.mjs";
import { launchDesktop, quitDesktop, request, until } from "./p13-desktop-support.mjs";

if (!process.env.WORKPILOT_DESKTOP_BINARY)
  throw new Error("Supply the actual isolated installed executable");
const binary = resolve(process.env.WORKPILOT_DESKTOP_BINARY);
const output = resolve(
  process.env.WORKPILOT_TEST_OUTPUT || ".test-results/p13-notifications-native",
);
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "native-"));
const folder = join(directory, "project");
const fixture = await startExecutionFixture((body) => {
  if (body.model === "native-notice-complete")
    return { text: "Local notification acceptance completed", calls: [], delay: 200 };
  if (body.model === "native-notice-approval")
    return {
      text: "",
      calls: [
        {
          name: "write_file",
          args: {
            path: "must-remain-unapproved.txt",
            text: "Synthetic test only",
            expected_sha256: null,
          },
        },
      ],
    };
});
setFixture(fixture);
const report = {
  at: new Date().toISOString(),
  binary,
  binarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  scope:
    "Own installed test process and fresh data only; GUI observations/clicks are recorded separately",
  operations: [],
};
let session;
try {
  session = await launchDesktop(binary, directory);
  report.processId = session.child.pid;
  const page = session.page;
  const invoke = (command, args = {}) =>
    page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
      command,
      args,
    });
  const state = () => invoke("notifications_snapshot");
  await until(async () => (await state()).ready);
  assert.equal(
    (await state()).system_available,
    true,
    "Only a registered installed executable may exercise Windows notifications",
  );
  const engine = { request: (command) => request(page, command) };
  const projectId = await project(
    engine,
    "Native notification test project",
    folder,
    "request_approval",
  );
  const profiles = {};
  for (const model of [
    "native-notice-complete",
    "native-notice-approval",
    "runtime-error",
    "runtime-ask",
  ]) {
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
    profiles[model] = p.id;
  }
  console.log(
    JSON.stringify({
      state: "ready",
      binary,
      processId: report.processId,
      directory,
      commands: "complete, approval, input, failed, test, snapshot, stop",
    }),
  );
  const input = createInterface({ input: process.stdin, terminal: false });
  for await (const line of input) {
    const operation = line.trim();
    if (!operation) continue;
    if (operation === "stop") break;
    const row = { operation, at: new Date().toISOString() };
    if (operation === "snapshot") {
      row.notifications = await state();
      row.selected = await page.evaluate(() => ({
        task: localStorage.getItem("workpilot.execution"),
        project: localStorage.getItem("workpilot.project"),
      }));
      row.modelCalls = fixture.records.length;
    } else if (operation === "test") row.result = await invoke("notifications_test");
    else {
      const models = {
        complete: "native-notice-complete",
        approval: "native-notice-approval",
        input: "runtime-ask",
        failed: "runtime-error",
      };
      const model = models[operation];
      if (!model) {
        console.log(JSON.stringify({ error: "Unknown test command" }));
        continue;
      }
      const title = `Native notification ${operation} ${report.operations.length + 1}`;
      const created = await engine.request({
        kind: "create_execution",
        config: {
          title,
          goal: "Synthetic local notification test",
          constraints: [],
          project_rules: "",
          project_id: projectId,
          profile_id: profiles[model],
          mode: "execute",
          controlled_tools: operation === "input",
          limits: {
            max_steps: 8,
            max_duration_ms: 30000,
            context_bytes: 65536,
            max_result_bytes: 32768,
          },
        },
      });
      assert.equal(created.kind, "receipt");
      const taskId = created.receipt.task_id;
      await engine.request({
        kind: "configure_task_tools",
        task_id: taskId,
        settings: {
          root_path: folder,
          permission: "request_approval",
          review_profile_id: null,
          commands_enabled: false,
          revision: 0,
        },
      });
      assert.equal(
        (await engine.request({ kind: "start_execution", task_id: taskId })).kind,
        "receipt",
      );
      const notification = await until(async () =>
        (await state()).entries.find((n) => n.task_id === taskId && n.delivery !== "pending"),
      );
      Object.assign(row, {
        title,
        taskId,
        projectId,
        notification,
        modelCalls: fixture.records.length,
      });
    }
    report.operations.push(row);
    await writeFile(join(output, "native-session.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(row));
  }
  input.close();
  report.status = "stopped";
} catch (error) {
  report.error = String(error);
  report.status = "failed";
  throw error;
} finally {
  if (session)
    await quitDesktop(session).catch((error) => {
      report.shutdownError = String(error);
      report.status = "failed";
    });
  await fixture.close();
  await writeFile(join(output, "native-session.json"), JSON.stringify(report, null, 2));
}
