import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { root } from "./cargo.mjs";
import { until, create, setFixture } from "./tool-test-support.mjs";
import { startToolFixture } from "../services/execution-fixtures/tools.mjs";
import { startExtensionFixture } from "../services/extension-fixtures/server.mjs";
const output = process.env.WORKPILOT_TEST_OUTPUT || join(root, ".test-results/extensions-desktop");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "session-")),
  project = join(directory, "project"),
  source = join(directory, "skill");
await mkdir(project);
await mkdir(source);
const fixture = await startExtensionFixture();
const model = await startToolFixture();
setFixture(model);
await writeFile(
  join(source, "SKILL.md"),
  "---\nname: report-checklist\ndescription: Reusable report checklist\n---\nCheck the title, numbers and next steps.\n",
);
await writeFile(
  join(source, "workpilot-plugin.json"),
  JSON.stringify({
    format: 1,
    id: "report-checklist",
    name: "报告检查助手",
    description: "检查说明、按需调用工具并保留结果。",
    version: "1.0.0",
    skills: ["."],
    servers: [
      {
        id: "test",
        name: "Local HTTP fixture",
        transport: { kind: "http", url: fixture.url + "/json", auth: "none" },
      },
    ],
    dependencies: [],
  }),
);
const binary =
  process.env.WORKPILOT_DESKTOP_BINARY || join(root, "target/release/workpilot-desktop.exe");
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  binary: {
    path: binary,
    sha256: createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
  },
  service: "Actual Windows WebView + Rust engine + local MCP HTTP protocol server",
  checks: [],
};
const portServer = createServer().listen(0, "127.0.0.1");
await once(portServer, "listening");
const port = portServer.address().port;
await new Promise((r) => portServer.close(r));
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
try {
  child = spawn(binary, [], {
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
  await until(async () => {
    try {
      return (await fetch("http://127.0.0.1:" + port + "/json/version")).ok;
    } catch {
      return false;
    }
  }, 30000);
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
  page = await until(async () =>
    browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => /tauri\.localhost|tauri:/.test(p.url())),
  );
  page.on("pageerror", (e) => errors.push(String(e)));
  page.setDefaultTimeout(15000);
  await expect(page.getByText("引擎已连接", { exact: true })).toBeVisible({ timeout: 20000 });
  const task = await create({ request }, "responses", "p09-desktop", { controlled_tools: false });
  assertResponse(
    await request({
      kind: "configure_task_tools",
      task_id: task,
      settings: {
        root_path: project,
        permission: "request_approval",
        commands_enabled: true,
        review_profile_id: null,
        revision: 0,
      },
    }),
  );
  await page.evaluate((task) => localStorage.setItem("workpilot.execution", task), task);
  await page.reload();
  await page.getByRole("button", { name: "技能与插件", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "技能与插件", exact: true });
  await panel.getByLabel("本地目录、ZIP 完整路径或下载地址", { exact: true }).fill(source);
  await panel.getByLabel("仅用于当前项目", { exact: true }).check();
  await panel.getByRole("button", { name: "检查安装包", exact: true }).click();
  await expect(panel.getByRole("button", { name: "确认安装并启用", exact: true })).toBeVisible();
  let catalog = await request({
    kind: "extensions",
    task_id: task,
    action: { kind: "catalog", query: null },
  });
  if (catalog.data.items.some((i) => i.installation.id !== "builtin-skill-creator"))
    throw Error("Preview must not activate a plugin");
  await panel.getByText("查看文件与内容摘要", { exact: false }).click();
  await panel.getByRole("button", { name: /^SKILL.md ·/ }).click();
  await expect(panel.locator(".extension-resource")).toContainText("Check the title");
  await page.screenshot({ path: join(output, "extension-review-zh.png") });
  await panel.getByRole("button", { name: "确认安装并启用", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "检查连接并发现工具", exact: true }),
  ).toBeVisible();
  report.checks.push("native_import_preview_read_skill_file_confirm_enable_project_scope");
  const approved = async (click) => {
    await click();
    const pending = panel.locator('[data-operation-state="awaiting_approval"]').first();
    await expect(pending).toBeVisible();
    const id = await pending.getAttribute("data-extension-operation");
    await pending.getByRole("button", { name: "批准这一次", exact: true }).click();
    await expect(panel.locator(`[data-extension-operation="${id}"]`)).toHaveAttribute(
      "data-operation-state",
      "completed",
    );
  };
  await approved(() =>
    panel.getByRole("button", { name: "检查连接并发现工具", exact: true }).click(),
  );
  await panel.getByRole("button", { name: "remote_echo", exact: true }).click();
  await panel
    .getByLabel("工具参数（JSON）", { exact: true })
    .fill(JSON.stringify({ text: "桌面扩展调用成功" }));
  await approved(() => panel.getByRole("button", { name: "提交测试调用", exact: true }).click());
  await panel
    .locator(".extension-operation")
    .first()
    .getByText("查看完整输入与结果", { exact: true })
    .click();
  await expect(panel.locator(".extension-operation").first()).toContainText("桌面扩展调用成功");
  await page.screenshot({ path: join(output, "extension-call-zh.png") });
  report.checks.push("native_mcp_discovery_approval_call_and_complete_saved_input_output");
  await panel.getByRole("button", { name: "停用", exact: true }).click();
  await expect(
    panel.getByRole("button", { name: "检查连接并发现工具", exact: true }),
  ).toBeDisabled();
  await panel.getByRole("button", { name: "启用", exact: true }).click();
  await expect(panel.getByText("尚未检查工具", { exact: true })).toBeVisible();
  report.checks.push("disable_removes_tool_cache_and_requires_fresh_discovery");
  catalog = await request({
    kind: "extensions",
    task_id: task,
    action: { kind: "catalog", query: null },
  });
  const installed = catalog.data.items.find(
    (i) => i.installation.slug === "report-checklist",
  ).installation;
  model.recipes.set("p09-desktop", (results) =>
    results.length
      ? model.done("Desktop model approval route checked")
      : model.tool("extension_action", {
          effect: {
            kind: "discover",
            installation_id: installed.id,
            revision: installed.revision,
            server_id: "test",
          },
        }),
  );
  await panel.getByRole("button", { name: "关闭", exact: true }).click();
  assertResponse(await request({ kind: "start_execution", task_id: task }));
  await page.getByRole("button", { name: "查看扩展待批准操作", exact: true }).click();
  await expect(panel).toBeVisible();
  const modelPending = panel.locator('[data-operation-state="awaiting_approval"]').first();
  await expect(modelPending).toBeVisible();
  const modelOperation = await modelPending.getAttribute("data-extension-operation");
  await modelPending.getByRole("button", { name: "批准这一次", exact: true }).click();
  await expect(panel.locator(`[data-extension-operation="${modelOperation}"]`)).toHaveAttribute(
    "data-operation-state",
    "completed",
  );
  assertResponse(await request({ kind: "start_execution", task_id: task }));
  await until(async () => {
    const r = await request({ kind: "read", query: { kind: "execution", task_id: task } });
    return r.snapshot.task.state === "completed";
  });
  report.checks.push("model_approval_has_a_clear_task_button_opening_the_correct_extension_review");
  await panel
    .getByLabel("描述希望反复使用的方法", { exact: true })
    .fill("按我的模板生成周报并附检查清单");
  await panel.getByRole("button", { name: "准备创建任务", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "技能与插件", exact: true })).toHaveCount(0);
  await expect(page.getByText("skill_draft", { exact: false })).toHaveCount(0); // Prompt is editable task input, not rendered implementation help.
  report.checks.push("natural_language_skill_creation_prepares_a_real_model_task_for_user_start");
  await page.getByRole("button", { name: "English", exact: true }).click();
  await page.getByRole("button", { name: "Skills & plugins", exact: true }).click();
  const en = page.getByRole("dialog", { name: "Skills & plugins", exact: true });
  await expect(en.getByRole("button", { name: "Inspect package", exact: true })).toBeVisible();
  await page.screenshot({ path: join(output, "extension-manager-en.png") });
  const fit = await en.evaluate((el) => ({ width: el.scrollWidth, view: el.clientWidth }));
  if (fit.width > fit.view + 2) throw Error("Extension manager horizontally overflows");
  if (errors.length) throw Error(errors.join("\n"));
  report.checks.push("english_interface_no_horizontal_overflow_or_javascript_errors");
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = String(e);
  report.stack = e.stack;
  process.exitCode = 1;
  await page?.screenshot({ path: join(output, "failure.png") }).catch(() => {});
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    if (page)
      await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("exit_app")).catch(() => {});
    else child.kill();
    await exited;
  }
  await browser?.close().catch(() => {});
  await fixture.close();
  await model.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
function assertResponse(r) {
  if (r.kind === "error") throw Error(r.message);
}
