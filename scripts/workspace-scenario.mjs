import { expect } from "@playwright/test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
export async function workspaceScenario({ page, request, folder, report, output, profile }) {
  page.setDefaultTimeout(12000);
  const command = async (command) => {
    const r = await request(command);
    assert.notEqual(r.kind, "error", JSON.stringify(r));
    return r;
  };
  await expect(page.getByRole("heading", { name: "开始一项新工作" })).toBeVisible();
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await expect(page.locator(".wb-project-heading")).toHaveCount(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.locator(".wb-project-heading").click({ button: "right" });
  await page.getByRole("menuitem", { name: "项目设置", exact: true }).click();
  await page.getByLabel("项目名称", { exact: true }).fill("我的测试项目");
  await page.getByLabel("项目文件夹", { exact: true }).fill(folder);
  await page.getByRole("combobox", { name: "默认模型", exact: true }).click();
  await page.getByRole("option", { name: new RegExp(profile.label) }).click();
  await page.getByLabel("项目规则", { exact: true }).fill("回答简洁，保留原始记录。");
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "项目设置", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "+ 新建任务", exact: true }).click();
  await page.getByRole("button", { name: "任务选项", exact: true }).click();
  await page.getByLabel("任务名称（可留空）", { exact: true }).fill("P06 工作台验证");
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await page
    .getByLabel("你想完成什么？", { exact: true })
    .fill("请读取这段附件，并解释 workbench-needle。");
  await page.locator('input[type="file"]').setInputFiles({
    name: "说明.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("workbench-needle：这是实际传给模型的附件文本。"),
  });
  await page.getByRole("button", { name: "创建并开始", exact: true }).click();
  await expect(page.getByTestId("execution-status")).toHaveAttribute("data-state", "running", {
    timeout: 15000,
  });
  const task = await page.evaluate(() => localStorage.getItem("workpilot.execution"));
  const snap = async () =>
    (await command({ kind: "read", query: { kind: "execution", task_id: task } })).snapshot;
  const s = await snap();
  assert(s.task.project_id);
  assert.equal(s.task.profile_id, profile.id);
  assert(s.context.goal.includes("说明.txt"));
  assert(s.context.project_rules.includes("保留原始记录"));
  report.checks.push("project_folder_defaults_real_text_attachment");
  await page.getByLabel("发送新的要求", { exact: true }).fill("原始排队要求");
  await expect(page.getByRole("button", { name: "停止任务", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "加入队列", exact: true }).click();
  const queued = page.locator(".execution-messages article").filter({ hasText: "原始排队要求" });
  await queued.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByLabel("编辑排队消息", { exact: true }).fill("改过的排队要求");
  await queued.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.locator(".execution-messages")).toContainText("改过的排队要求");
  await page.getByLabel("发送新的要求", { exact: true }).fill("需要取消的要求");
  await page.getByRole("button", { name: "加入队列", exact: true }).click();
  await page
    .locator(".execution-messages article")
    .filter({ hasText: "需要取消的要求" })
    .getByRole("button", { name: "取消消息", exact: true })
    .click();
  await expect(
    page.locator('.execution-messages article[data-message-state="cancelled"]'),
  ).toContainText("需要取消的要求");
  await page.getByRole("button", { name: "停止任务", exact: true }).click();
  await expect(page.getByTestId("execution-status")).toHaveAttribute("data-state", "interrupted", {
    timeout: 15000,
  });
  await page.reload();
  await expect(page.getByTestId("execution-status")).toHaveAttribute("data-state", "interrupted");
  assert.equal((await snap()).messages.filter((m) => m.state === "queued").length, 1);
  assert.equal((await snap()).messages.filter((m) => m.state === "cancelled").length, 1);
  report.checks.push("queue_edit_cancel_stop_reload_preserves_receipts_no_resubmit");
  await page.getByRole("button", { name: "继续任务", exact: true }).click();
  await expect(page.getByTestId("execution-status")).toHaveAttribute("data-state", "completed", {
    timeout: 45000,
  });
  await expect(page.getByRole("region", { name: "对话记录" })).toContainText("工作台验证完成");
  assert.equal((await snap()).messages.filter((m) => m.state === "delivered").length, 1);
  report.checks.push("real_conversation_uses_delivered_edited_message_once");
  await page.getByRole("button", { name: "过程", exact: true }).click();
  await page.getByRole("button", { name: "查找与导出完整记录", exact: true }).click();
  await page.getByLabel("搜索完整记录", { exact: true }).fill("workbench-needle");
  await page.getByRole("button", { name: "搜索记录", exact: true }).click();
  await expect(page.locator(".record-panel details")).not.toHaveCount(0, { timeout: 15000 });
  await page.getByRole("button", { name: "导出完整记录", exact: true }).click();
  await expect(page.getByText("完整记录已导出", { exact: true })).toBeVisible({ timeout: 30000 });
  const ex = await command({
    kind: "workspace",
    action: { kind: "export_records", task_id: task },
  });
  assert.equal(ex.data.kind, "exported");
  const files = await readdir(join(ex.data.path, "objects"));
  assert(files.length > 3);
  for (const name of files) {
    const body = await readFile(join(ex.data.path, "objects", name));
    assert.equal(createHash("sha256").update(body).digest("hex"), name);
  }
  const lines = (await readFile(join(ex.data.path, "events.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length - 1, ex.data.events);
  report.checks.push("full_body_search_complete_export_hashes_match");
  await page.locator(`[data-execution-id="${task}"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
  await page.getByLabel("新的任务名称", { exact: true }).fill("归档验证任务");
  await page.getByRole("button", { name: "保存名称", exact: true }).click();
  await expect(page.getByRole("heading", { name: "归档验证任务", exact: true })).toBeVisible();
  await page.locator(`[data-execution-id="${task}"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: /归档任务/ }).click();
  await expect(page.locator(`[data-execution-id="${task}"]`)).toHaveCount(0);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "搜索任务", exact: true }).fill("归档验证");
  await page.getByLabel("已归档", { exact: true }).check();
  await expect(page.getByRole("option", { name: /归档验证任务/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "搜索任务" })).toHaveCount(0);
  await page.locator(`[data-execution-id="${task}"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: /恢复任务/ }).click();
  await page.getByRole("button", { name: "任务", exact: true }).click();
  await expect(page.locator(`[data-execution-id="${task}"]`)).toBeVisible();
  report.checks.push("rename_archive_search_restore_persisted");
  await expect
    .poll(async () => Math.round((await page.locator(".wb-sidebar").boundingBox()).width))
    .toBe(228);
  await page.getByRole("button", { name: "详情面板", exact: true }).click();
  await expect(page.locator(".wb-work-panel")).toBeHidden();
  await page.getByRole("button", { name: "详情面板", exact: true }).click();
  await expect(page.locator(".wb-work-panel")).toBeVisible();
  await page.screenshot({ path: join(output, "workbench-zh.png") });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("combobox", { name: "外观", exact: true }).click();
  await page.getByRole("option", { name: "深色", exact: true }).click();
  await page.getByRole("combobox", { name: "界面语言", exact: true }).click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect
    .poll(async () => Math.round((await page.locator(".wb-sidebar").boundingBox()).width))
    .toBe(228);
  const requests = (await snap()).messages.filter((m) => m.state === "delivered");
  assert.equal(requests.length, 1);
  await page.screenshot({ path: join(output, "workbench-en-dark.png") });
  const overflow = await page.evaluate(() => ({
    screen: document.documentElement.clientWidth,
    width: document.documentElement.scrollWidth,
    nodes: document.querySelectorAll("*").length,
  }));
  assert(overflow.width <= overflow.screen + 1);
  report.checks.push("panel_resize_collapse_english_dark_and_reload_persist_without_duplication");
  report.layout = overflow;
  return task;
}
