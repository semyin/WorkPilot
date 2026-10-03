import { chromium, expect as baseExpect } from "@playwright/test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { root } from "./cargo.mjs";
import { until, create, setFixture, start, terminal } from "./tool-test-support.mjs";
import { startToolFixture } from "../services/execution-fixtures/tools.mjs";

const expect = baseExpect.configure({ timeout: 20000 });
const output = process.env.WORKPILOT_TEST_OUTPUT || join(root, ".test-results/memory-desktop");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "session-")),
  fixture = await startToolFixture();
setFixture(fixture);
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
  service:
    "Actual Windows desktop WebView and engine. Local deterministic model for AI candidate only.",
  checks: [],
};
const ports = createServer().listen(0, "127.0.0.1");
await once(ports, "listening");
const port = ports.address().port;
await new Promise((r) => ports.close(r));
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
async function admin(action) {
  const r = await request({ kind: "memory", action });
  assert.equal(r.kind, "memory", JSON.stringify(r));
  return r.data;
}
const list = (project_id = null, include_deleted = false) =>
  admin({ kind: "list", project_id, search: "", include_deleted, offset: 0, limit: 64 });
async function project(name) {
  const path = join(directory, name);
  await mkdir(path);
  const r = await request({
    kind: "workspace",
    action: {
      kind: "save_project",
      project_id: null,
      settings: {
        name,
        root_path: path,
        default_profile_id: null,
        permission: "request_approval",
        rules: "",
        revision: 0,
      },
    },
  });
  assert.equal(r.kind, "workspace", JSON.stringify(r));
  return r.data.project.id;
}
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
  page.setDefaultTimeout(20000);
  page.on("pageerror", (e) => errors.push(String(e)));
  await expect(page.getByText("引擎已连接", { exact: true })).toBeVisible();
  const p1 = await project("写作项目"),
    p2 = await project("隔离项目");
  await admin({
    kind: "save",
    memory_id: null,
    revision: 0,
    project_id: p2,
    text: "不应出现在另一个项目里的秘密偏好",
  });
  fixture.recipes.set("p11-native-memory", [
    {
      name: "memory_propose",
      args: {
        text: "写作时先给结论，再给例子。",
        scope: "project",
        evidence_quote: "我希望先给结论再给例子",
      },
    },
  ]);
  const task = await create({ request }, "responses", "p11-native-memory", {
    goal: "我希望先给结论再给例子，请为我的写作项目提出记忆候选。",
    mode: "chat",
    project_id: p1,
    controlled_tools: false,
  });
  await start({ request }, task);
  assert.equal((await terminal({ request }, task)).task.state, "completed");
  await page.evaluate((t) => localStorage.setItem("workpilot.execution", t), task);
  await page.reload();
  await expect(page.getByLabel("发送新的要求", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "记忆", exact: true }).click();
  let panel = page.getByRole("dialog", { name: "记忆", exact: true });
  await expect(panel.getByLabel("查看记忆范围", { exact: true })).toHaveValue(p1);
  const candidate = panel.locator(".memory-card").filter({ hasText: "写作时先给结论，再给例子。" });
  await expect(candidate.getByText("待你确认 · 不生效", { exact: true })).toBeVisible();
  await expect(candidate.getByText("我希望先给结论再给例子", { exact: true })).toBeVisible();
  await expect(panel.getByText("不应出现在另一个项目里的秘密偏好", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: join(output, "candidate-zh.png") });
  await candidate.getByRole("button", { name: "确认记住", exact: true }).click();
  await expect(candidate.getByText("已确认 · 生效中", { exact: true })).toBeVisible();
  assert.equal((await list(p1)).items.find((i) => i.source_task_id === task).state, "confirmed");
  report.checks.push(
    "native_project_scope_candidate_source_and_confirmation_no_other_project_leak",
  );
  await panel.getByRole("button", { name: "添加记忆", exact: true }).click();
  await panel.getByLabel("记忆适用范围", { exact: true }).selectOption("");
  await panel.getByLabel("记忆内容", { exact: true }).fill("我喜欢清楚、简短的说明。");
  await panel.getByRole("button", { name: "保存并确认", exact: true }).click();
  let manual = panel.locator(".memory-card").filter({ hasText: "我喜欢清楚、简短的说明。" });
  await expect(manual).toBeVisible();
  await manual.getByRole("button", { name: "修改", exact: true }).click();
  await panel.getByLabel("记忆内容", { exact: true }).fill("我喜欢说明中附一个简单例子。");
  await panel.getByRole("button", { name: "保存并确认", exact: true }).click();
  manual = panel.locator(".memory-card").filter({ hasText: "我喜欢说明中附一个简单例子。" });
  await expect(manual).toBeVisible();
  await manual.getByRole("button", { name: "删除", exact: true }).click();
  await expect(manual).toHaveCount(0);
  await panel.getByLabel("显示已删除", { exact: true }).check();
  await expect(manual).toBeVisible();
  await manual.getByRole("button", { name: "历史与撤销", exact: true }).click();
  let history = panel.getByRole("region", { name: "记忆历史", exact: true });
  await history
    .locator(".memory-revision")
    .filter({ hasText: "我喜欢清楚、简短的说明。" })
    .getByRole("button", { name: "恢复此版本", exact: true })
    .click();
  manual = panel.locator(".memory-card").filter({ hasText: "我喜欢清楚、简短的说明。" });
  await expect(manual.getByText("已确认 · 生效中", { exact: true })).toBeVisible();
  await panel.getByLabel("搜索记忆", { exact: true }).fill("简单例子");
  await expect(panel.locator(".memory-card")).toHaveCount(0);
  await panel.getByLabel("搜索记忆", { exact: true }).fill("简短");
  await expect(panel.locator(".memory-card")).toHaveCount(1);
  await panel.getByLabel("搜索记忆", { exact: true }).fill("");
  await expect(panel.locator(".memory-card")).toHaveCount(2);
  report.checks.push("native_add_edit_delete_search_and_restore_original_version");
  const current = (await list()).items.find((i) => i.text === "我喜欢清楚、简短的说明。");
  await manual.getByRole("button", { name: "修改", exact: true }).click();
  await panel.getByLabel("记忆内容", { exact: true }).fill("过时编辑，不应覆盖");
  await admin({
    kind: "save",
    memory_id: current.id,
    revision: current.revision,
    project_id: null,
    text: "另一个窗口已经更新的内容",
  });
  await panel.getByRole("button", { name: "保存并确认", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("内容或状态已变化");
  assert.equal(
    (await list()).items.find((i) => i.id === current.id).text,
    "另一个窗口已经更新的内容",
  );
  await panel.getByRole("button", { name: "取消编辑", exact: true }).click();
  report.checks.push("native_stale_editor_cannot_overwrite_concurrent_edit");
  const downloaded = page.waitForEvent("download");
  await panel.getByRole("button", { name: "导出已确认记忆", exact: true }).click();
  const file = await downloaded;
  await file.saveAs(join(output, "downloaded-memories.json"));
  const exported = JSON.parse(await readFile(join(output, "downloaded-memories.json"), "utf8"));
  assert.equal(exported.items.length, 2);
  assert(!JSON.stringify(exported).includes("秘密偏好"));
  report.checks.push("native_export_download_has_current_confirmed_scope_only");
  await panel.getByRole("button", { name: "关闭记忆", exact: true }).click();
  await page.getByRole("button", { name: "English", exact: true }).click();
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  panel = page.getByRole("dialog", { name: "Memory", exact: true });
  await expect(panel.getByRole("button", { name: "Add memory", exact: true })).toBeVisible();
  await expect(panel.locator(".memory-card")).toHaveCount(2);
  await page.screenshot({ path: join(output, "memory-en.png") });
  assert(await panel.evaluate((e) => e.scrollWidth <= e.clientWidth + 2));
  await panel.getByLabel("Memory scope", { exact: true }).selectOption("");
  await expect(panel.locator(".memory-card")).toHaveCount(1);
  await panel.getByLabel("Memory scope", { exact: true }).selectOption(p1);
  await expect(panel.locator(".memory-card")).toHaveCount(2);
  await panel.getByRole("button", { name: "Close memory", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  panel = page.getByRole("dialog", { name: "Memory", exact: true });
  await expect(panel.locator(".memory-card")).toHaveCount(2);
  report.checks.push(
    "english_layout_no_horizontal_overflow_scope_switch_and_reload_preserve_records",
  );
  const attack =
    '<script>window.__P11_UNSAFE=true</script><img src=x onerror="window.__P11_UNSAFE=true">';
  await admin({ kind: "save", memory_id: null, revision: 0, project_id: null, text: attack });
  await expect(panel.getByText(attack, { exact: true })).toBeVisible();
  assert.equal(await page.evaluate(() => window.__P11_UNSAFE), undefined);
  assert.equal(await panel.locator("script,img").count(), 0);
  await panel.getByRole("button", { name: "Open source task", exact: true }).click();
  await expect(panel).toHaveCount(0);
  assert.equal(await page.evaluate(() => localStorage.getItem("workpilot.execution")), task);
  report.checks.push("memory_text_is_not_executed_as_html_and_source_navigation_works");
  assert.equal(errors.length, 0, errors.join("\n"));
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
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
