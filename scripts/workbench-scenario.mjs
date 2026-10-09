import { expect } from "@playwright/test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
export async function workbenchScenario({ page, folder, task, report, output }) {
  page.setDefaultTimeout(15000);
  await page.evaluate((task) => localStorage.setItem("workpilot.execution", task), task);
  await page.reload();
  await page.getByRole("button", { name: "工作区工具", exact: true }).click();
  await page.getByRole("menuitem", { name: "文件与终端", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "文件与终端", exact: true });
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "· notes.txt", exact: true }).click();
  await expect(panel.getByLabel("文件正文", { exact: true })).toHaveValue("original\n第二行\n");
  await panel.getByLabel("文件正文", { exact: true }).fill("saved in the actual editor\n第二行\n");
  await panel.getByRole("button", { name: "保存文件", exact: true }).click();
  await expect(panel.getByRole("button", { name: "确认执行", exact: true })).toBeVisible();
  assert.equal(await readFile(join(folder, "notes.txt"), "utf8"), "original\n第二行\n");
  await panel.getByRole("button", { name: "确认执行", exact: true }).click();
  await expect
    .poll(() => readFile(join(folder, "notes.txt"), "utf8"))
    .toBe("saved in the actual editor\n第二行\n");
  await expect(panel.locator('[data-operation-state="completed"]')).toHaveCount(1);
  await expect(panel.getByRole("heading", { name: "notes.txt", exact: true })).toBeVisible();
  report.checks.push("native_editor_approval_saves_actual_file_and_updates_version");
  await writeFile(join(folder, "notes.txt"), "external user change\n");
  await panel.getByLabel("文件正文", { exact: true }).fill("must not overwrite external change");
  await panel.getByRole("button", { name: "保存文件", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("外部修改");
  assert.equal(await readFile(join(folder, "notes.txt"), "utf8"), "external user change\n");
  await expect(panel.getByLabel("文件正文", { exact: true })).toHaveValue(
    "must not overwrite external change",
  );
  await panel.getByRole("button", { name: "关闭提示", exact: true }).click();
  await panel.getByRole("button", { name: "放弃编辑并重新读取", exact: true }).click();
  await expect(panel.getByLabel("文件正文", { exact: true })).toHaveValue("external user change\n");
  report.checks.push("conflict_preserves_external_file_and_unsaved_editor_draft");
  await panel.getByRole("button", { name: "修改历史", exact: true }).click();
  await panel.locator(".file-history-row").filter({ hasText: "notes.txt" }).first().click();
  await expect(panel.locator(".file-diff")).toContainText("+ saved in the actual editor");
  await panel.getByRole("button", { name: "恢复修改前版本", exact: true }).click();
  await panel.getByRole("button", { name: "确认执行", exact: true }).click();
  await expect.poll(() => readFile(join(folder, "notes.txt"), "utf8")).toBe("original\n第二行\n");
  await expect(panel.locator('[data-operation-state="completed"]')).toHaveCount(2);
  await panel.getByRole("button", { name: "刷新历史", exact: true }).click();
  await expect(panel.locator(".file-history-row").filter({ hasText: "notes.txt" })).toHaveCount(2);
  await panel.locator(".file-history-row").filter({ hasText: "notes.txt" }).first().click();
  await expect(panel.locator(".file-diff")).toContainText("- external user change");
  report.checks.push("history_diff_and_restore_retain_current_external_version");
  await panel.getByRole("button", { name: "文件", exact: true }).click();
  await panel.getByRole("button", { name: "放弃编辑并重新读取", exact: true }).click();
  await panel.getByRole("button", { name: "· preview.html", exact: true }).click();
  await panel.getByRole("button", { name: "静态网页预览", exact: true }).click();
  const frame = page.frameLocator('iframe[title="静态网页预览"]');
  await expect(frame.getByRole("heading", { name: "Static preview" })).toBeVisible();
  assert.equal(
    await page.locator('iframe[title="静态网页预览"]').evaluate((el) => el.getAttribute("sandbox")),
    "",
  );
  assert.equal(await frame.locator("body").evaluate(() => window.__p07UnsafeScriptRan), undefined);
  report.checks.push("static_html_renders_with_scripts_and_host_access_disabled");
  await panel.getByRole("button", { name: "终端", exact: true }).click();
  await panel
    .getByLabel("终端命令", { exact: true })
    .fill(
      "Write-Output 'P07 desktop terminal'; Set-Content -LiteralPath 'terminal-ui.txt' -Value 'created from the UI' -Encoding utf8",
    );
  await panel.getByRole("button", { name: "运行命令", exact: true }).click();
  await panel.getByRole("button", { name: "确认执行", exact: true }).click();
  await expect
    .poll(async () => {
      try {
        return await readFile(join(folder, "terminal-ui.txt"), "utf8");
      } catch {
        return "";
      }
    })
    .toContain("created from the UI");
  await expect(panel.locator('[data-operation-state="completed"]')).toHaveCount(3);
  await panel
    .locator('[data-operation-state="completed"]')
    .first()
    .getByText("查看具体操作与完整结果", { exact: true })
    .click();
  await expect(panel.locator(".file-operations")).toContainText("P07 desktop terminal");
  report.checks.push("native_terminal_runs_real_powershell_with_saved_output");
  await page.screenshot({ path: join(output, "workbench-terminal-zh.png") });
  await panel.getByRole("button", { name: "返回对话", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("combobox", { name: "界面语言", exact: true }).click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.getByRole("button", { name: "Workspace tools", exact: true }).click();
  await page.getByRole("menuitem", { name: "Files and terminal", exact: true }).click();
  const english = page.getByRole("dialog", { name: "Files and terminal", exact: true });
  await expect(
    english.getByRole("heading", { name: "Project workspace", exact: true }),
  ).toBeVisible();
  await english.getByRole("button", { name: "File history", exact: true }).click();
  await expect(english.locator(".file-history-row")).not.toHaveCount(0);
  await page.screenshot({ path: join(output, "workbench-history-en.png") });
  const bounds = await english.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1;
  });
  assert(bounds);
  report.checks.push("english_workspace_and_history_fit_native_window");
}
