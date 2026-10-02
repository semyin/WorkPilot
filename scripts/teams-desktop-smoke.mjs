import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { root } from "./cargo.mjs";
import { startTeamFixture } from "../services/execution-fixtures/teams.mjs";
const output = join(root, ".test-results/teams-desktop");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "session-"));
const fixture = await startTeamFixture();
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  service: "synthetic model; native desktop and actual files",
  checks: [],
};
const errors = [];
async function until(check, timeout = 20000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    const value = await check().catch(() => false);
    if (value) return value;
    await delay(50);
  }
  throw new Error("Native execution assertion timed out");
}
async function launch() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const child = spawn(
    process.env.WORKPILOT_DESKTOP_BINARY || join(root, "target/release/workpilot-desktop.exe"),
    [],
    {
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
    },
  );
  try {
    await until(async () => (await fetch("http://127.0.0.1:" + port + "/json/version")).ok);
    const browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
    const page = await until(async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => /tauri\.localhost|tauri:/.test(p.url())),
    );
    page.on("pageerror", (e) => errors.push(String(e)));
    await expect(page.getByText("引擎已连接", { exact: true })).toBeVisible();
    return { child, browser, page };
  } catch (e) {
    child.kill();
    throw e;
  }
}
async function command(page, command) {
  return page.evaluate(
    (command) =>
      window.__TAURI_INTERNALS__.invoke("engine_command", {
        request: { request_id: crypto.randomUUID(), command },
      }),
    command,
  );
}
async function snapshot(page) {
  const task = await page.evaluate(() => localStorage.getItem("workpilot.execution"));
  const r = await command(page, { kind: "read", query: { kind: "execution", task_id: task } });
  assert.equal(r.kind, "execution");
  return r.snapshot;
}
async function quit(session) {
  const exit = once(session.child, "exit");
  await session.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("exit_app")).catch(() => {});
  await exit;
  await session.browser.close().catch(() => {});
}
async function addProfile(page, model) {
  const empty = { supported: null, source: "unknown", checked_at_ms: null };
  const p = {
    id: crypto.randomUUID(),
    label: model,
    protocol: "responses",
    model,
    base_url: fixture.url,
    credential: null,
    auth: "none",
    supports_tools: true,
    supports_images: null,
    revision: 1,
    capabilities: {
      text: empty,
      streaming: empty,
      tools: { supported: true, source: "user", checked_at_ms: null },
      images: empty,
      usage: empty,
    },
    options: {
      max_output_tokens: 1024,
      temperature: null,
      reasoning_effort: null,
      chat_token_parameter: "max_completion_tokens",
      timeout_ms: 20000,
      idle_timeout_ms: 10000,
      anthropic_version: "2023-06-01",
    },
    pricing: null,
  };
  assert.equal(
    (
      await command(page, {
        kind: "save_provider",
        profile: p,
        secret: null,
        clear_credential: false,
      })
    ).kind,
    "provider_saved",
  );
  return p.id;
}
async function create(page, profile, title, permission = "request_approval") {
  await page.getByRole("button", { name: "+ 新建任务", exact: true }).click();
  await page.getByLabel("任务名称（可留空）", { exact: true }).fill(title);
  await page.getByLabel("你想完成什么？", { exact: true }).fill("验证 " + title);
  await page.getByLabel("工作模式", { exact: true }).selectOption("execute");
  await page.getByLabel("任务模型", { exact: true }).selectOption(profile);
  await page.getByLabel("允许操作的文件夹", { exact: true }).fill(folder);
  await page.getByLabel("任务权限", { exact: true }).selectOption(permission);
  await page.getByRole("button", { name: "创建并开始", exact: true }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
}
const state = (page, value) =>
  expect(page.getByTestId("execution-status")).toHaveAttribute("data-state", value, {
    timeout: 20000,
  });
const folder = join(directory, "authorized-project");
await mkdir(folder);
const write = (path, text) => ({ name: "write_file", args: { path, text, expected_sha256: null } });
const artifact = (path) => ({ name: "register_artifact", args: { path } });
const member = (key, profile_id, depends_on = []) => ({
  key,
  role: "助手 " + key,
  goal: "完成测试分工 " + key,
  profile_id,
  depends_on,
});
let session;
try {
  session = await launch();
  let page = session.page;
  const profiles = {};
  for (const name of [
    "team-native-main",
    "team-native-a",
    "team-native-b",
    "team-native-join",
    "team-native-manual",
    "team-native-edit",
    "team-native-error",
    "team-native-recovery",
    "team-native-resume",
    "team-native-slow",
  ])
    profiles[name] = await addProfile(page, name);
  fixture.definitions.set("team-native-a", {
    kind: "leaf",
    actions: [write("a.txt", "A evidence"), artifact("a.txt")],
    text: "A 的独立交付",
  });
  fixture.definitions.set("team-native-b", {
    kind: "leaf",
    actions: [write("b.txt", "B evidence"), artifact("b.txt")],
    text: "B 的独立交付",
  });
  fixture.definitions.set("team-native-join", {
    kind: "leaf",
    actions: [write("joined.txt", "A + B"), artifact("joined.txt")],
    text: "汇总成员已完成",
  });
  fixture.definitions.set("team-native-main", {
    kind: "main",
    members: [
      member("A", profiles["team-native-a"]),
      member("B", profiles["team-native-b"]),
      member("汇总", profiles["team-native-join"], ["A", "B"]),
    ],
  });
  await create(page, profiles["team-native-main"], "三个助手协作", "full_access");
  await state(page, "completed");
  await expect(page.locator(".team-member")).toHaveCount(3);
  await expect(page.locator(".team-member").filter({ hasText: "成果已检查并接受" })).toHaveCount(3);
  assert.equal(await readFile(join(folder, "joined.txt"), "utf8"), "A + B");
  await page.screenshot({ path: join(output, "team-overview.png") });
  report.checks.push("native_three_members_dependencies_models_reviewed_artifacts");
  const card = page.locator(".team-member").filter({ hasText: "A 的独立交付" });
  const aCard = page
    .locator(".team-member")
    .filter({ has: page.getByText("助手 A", { exact: true }) });
  await aCard.getByRole("button", { name: "查看交付", exact: true }).click();
  await expect(aCard.locator(".team-delivery")).toContainText("A 的独立交付");
  await expect(aCard).toContainText("输入 / 输出用量");
  await aCard.locator("summary").filter({ hasText: "成果：a.txt" }).click();
  await expect(aCard).toContainText("A evidence");
  await page.screenshot({ path: join(output, "team-delivery.png") });
  await aCard.getByRole("button", { name: "打开过程与审批", exact: true }).click();
  await expect(page.getByRole("heading", { name: "助手 A", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回主任务", exact: true }).click();
  await expect(page.getByRole("heading", { name: "三个助手协作", exact: true })).toBeVisible();
  report.checks.push("native_delivery_usage_source_files_and_member_navigation");

  fixture.definitions.set("team-native-manual", { kind: "main", members: [] });
  fixture.definitions.set("team-native-edit", {
    kind: "leaf",
    actions: [write("manual.txt", "user-selected member")],
    text: "手动分工完成",
  });
  await page.getByRole("button", { name: "+ 新建任务", exact: true }).click();
  await page.getByLabel("任务名称（可留空）", { exact: true }).fill("手动分工与模型覆盖");
  await page.getByLabel("你想完成什么？", { exact: true }).fill("验证手动设置成员");
  await page.getByLabel("工作模式", { exact: true }).selectOption("execute");
  await page.getByLabel("任务模型", { exact: true }).selectOption(profiles["team-native-manual"]);
  await page.getByLabel("允许操作的文件夹", { exact: true }).fill(folder);
  await page.getByLabel("任务权限", { exact: true }).selectOption("full_access");
  await page.getByRole("button", { name: "先创建并设置分工", exact: true }).click();
  const panel = page.locator(".team-panel");
  await panel.getByText("手动添加分工", { exact: true }).click();
  await panel.getByLabel("成员标识（简短且不重复）", { exact: true }).fill("manual");
  await panel.getByLabel("职责名称", { exact: true }).fill("用户安排的成员");
  await panel.getByLabel("具体目标", { exact: true }).fill("最初目标");
  await panel.getByLabel("成员模型", { exact: true }).selectOption(profiles["team-native-a"]);
  await panel.getByRole("button", { name: "添加成员", exact: true }).click();
  await expect(panel.locator(".team-member")).toHaveCount(1);
  const manualCard = panel.locator(".team-member");
  await manualCard.getByText("调整分工和模型", { exact: true }).click();
  await manualCard.getByLabel("具体目标", { exact: true }).fill("用户覆盖后的目标");
  await manualCard
    .getByLabel("成员模型", { exact: true })
    .selectOption(profiles["team-native-edit"]);
  await manualCard.getByRole("button", { name: "保存分工", exact: true }).click();
  await expect(manualCard.locator("p").first()).toHaveText("用户覆盖后的目标");
  await page.getByRole("button", { name: "继续任务", exact: true }).click();
  await state(page, "completed");
  assert.equal(await readFile(join(folder, "manual.txt"), "utf8"), "user-selected member");
  report.checks.push("native_draft_manual_member_override_model_and_goal");

  fixture.definitions.set("team-native-error", { kind: "error" });
  fixture.definitions.set("team-native-edit", {
    kind: "leaf",
    actions: [write("replacement.txt", "explicit replacement completed")],
    text: "接替成员完成",
  });
  fixture.definitions.set("team-native-recovery", {
    kind: "main",
    members: [member("失败成员", profiles["team-native-error"])],
    replacement: profiles["team-native-edit"],
  });
  await create(page, profiles["team-native-recovery"], "失败与接替", "full_access");
  await state(page, "completed");
  await expect(page.locator('.team-member[data-member-state="failed"]')).toHaveCount(1);
  await expect(page.locator(".team-panel")).toContainText("后续由以下成员接手");
  assert.equal(
    await readFile(join(folder, "replacement.txt"), "utf8"),
    "explicit replacement completed",
  );
  await page.screenshot({ path: join(output, "team-replacement.png") });
  report.checks.push("native_failure_remains_visible_beside_replacement");

  fixture.definitions.set("team-native-resume", {
    kind: "main",
    members: [member("慢速成员", profiles["team-native-slow"])],
  });
  fixture.definitions.set("team-native-slow", {
    kind: "leaf",
    delay: 5000,
    actions: [write("resumed.txt", "continued after restart")],
  });
  await create(page, profiles["team-native-resume"], "整组停止与继续", "full_access");
  await expect(page.locator('.team-member[data-member-state="running"]')).toHaveCount(1, {
    timeout: 20000,
  });
  await page.getByRole("button", { name: "停止任务", exact: true }).click();
  await state(page, "interrupted");
  await quit(session);
  session = await launch();
  page = session.page;
  await state(page, "interrupted");
  const before = fixture.starts.length;
  await delay(350);
  assert.equal(fixture.starts.length, before);
  fixture.definitions.set("team-native-slow", {
    kind: "leaf",
    actions: [write("resumed.txt", "continued after restart")],
  });
  await page.getByRole("button", { name: "继续任务", exact: true }).click();
  await state(page, "completed");
  assert.equal(await readFile(join(folder, "resumed.txt"), "utf8"), "continued after restart");
  report.checks.push("native_parent_stop_exit_manual_continue");
  assert.deepEqual(errors, []);
  report.result = "passed";
} catch (e) {
  report.result = "failed";
  report.error = e.stack;
  process.exitCode = 1;
} finally {
  if (session)
    await quit(session).catch(() => {
      session.child.kill();
    });
  await fixture.close();
  report.pageErrors = errors;
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
