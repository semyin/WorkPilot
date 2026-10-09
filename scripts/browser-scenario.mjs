import { expect as baseExpect } from "@playwright/test";
import assert from "node:assert/strict";
import { join } from "node:path";
const expect = baseExpect.configure({ timeout: 15000 });

export async function browserScenario({ page, task, url, report, output, channel = "chrome" }) {
  const label = { chrome: "Chrome", msedge: "Edge", chromium: "随包浏览器" }[channel];
  assert(label, "Unsupported desktop test browser channel");
  page.setDefaultTimeout(15000);
  await page.evaluate((task) => localStorage.setItem("workpilot.execution", task), task);
  await page.reload();
  await page.getByRole("button", { name: "工作区工具", exact: true }).click();
  await page.getByRole("menuitem", { name: "浏览器", exact: true }).click();
  const panel = page.locator("#inspector-browser");
  await panel.getByRole("button", { name: "启动专用 " + label, exact: true }).click();
  await expect(panel.getByLabel("已授权标签页", { exact: true })).not.toHaveValue("");
  await expect(panel.getByRole("button", { name: "查看截图", exact: true })).toBeEnabled();
  report.checks.push("browser_panel_starts_real_dedicated_" + channel + "_and_identifies_tab");
  const approved = async (click) => {
    await click();
    const pending = panel.locator('[data-operation-state="awaiting_approval"]').first();
    await expect(pending).toBeVisible();
    const id = await pending.getAttribute("data-browser-operation");
    await pending.getByRole("button", { name: "确认执行", exact: true }).click();
    await expect(panel.locator(`[data-browser-operation="${id}"]`)).toHaveAttribute(
      "data-operation-state",
      "completed",
    );
  };
  await panel.getByLabel("网页地址", { exact: true }).fill(url + "/page");
  await approved(() => panel.getByRole("button", { name: "访问地址", exact: true }).click());
  await expect(panel.locator(".browser-url")).toContainText("/page");
  const select = async (query, label) => {
    await panel.getByLabel("查找页面元素", { exact: true }).fill(query);
    await panel.getByRole("button", { name: "读取当前页面", exact: true }).click();
    await expect(
      panel
        .getByLabel("选择已读取的元素", { exact: true })
        .locator("option")
        .filter({ hasText: label }),
    ).toHaveCount(1);
    await panel.getByLabel("选择已读取的元素", { exact: true }).selectOption({ label });
  };
  await select("Name", "[input] Name");
  await panel.getByLabel("要填写的内容", { exact: true }).fill("desktop-browser");
  await approved(() => panel.getByRole("button", { name: "填写元素", exact: true }).click());
  await select("Greet", "[button] Greet");
  await approved(() => panel.getByRole("button", { name: "点击元素", exact: true }).click());
  await panel.getByLabel("查找页面元素", { exact: true }).fill("");
  await panel.getByRole("button", { name: "读取当前页面", exact: true }).click();
  await panel.getByText("页面结构与正文（外部资料）", { exact: true }).click();
  await expect(panel.locator("pre").first()).toContainText("Hello, desktop-browser");
  report.checks.push("navigate_fill_click_approved_in_ui_and_actual_dom_result_read_back");
  await panel.getByRole("button", { name: "查看截图", exact: true }).click();
  await expect(panel.getByRole("img", { name: "当前连接标签页的截图" })).toBeVisible();
  assert(await panel.locator(".browser-image").evaluate((el) => el.naturalWidth > 0));
  await page.screenshot({ path: join(output, "browser-workspace-zh.png") });
  report.checks.push("real_browser_screenshot_shown_in_task_inspector");
  await panel.getByRole("button", { name: "手动接管", exact: true }).click();
  await expect(panel.getByRole("button", { name: "恢复自动操作", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "读取当前页面", exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: "恢复自动操作", exact: true }).click();
  await expect(panel.getByRole("button", { name: "读取当前页面", exact: true })).toBeEnabled();
  await expect(panel.getByRole("button", { name: "查看截图", exact: true })).toBeDisabled();
  report.checks.push("takeover_blocks_automation_resume_requires_fresh_page_read");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("combobox", { name: "界面语言", exact: true }).click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await panel.getByText("Connect daily Chrome / Edge", { exact: true }).click();
  await panel.getByRole("button", { name: "Pair Edge", exact: true }).click();
  await expect(
    panel.getByLabel("Paste only into your WorkPilot extension", { exact: true }),
  ).toHaveValue(/^\d+-[a-f0-9]{48}$/);
  // Pairing codes are local credentials: remove from the view before saving screenshots.
  await panel.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(
    panel.getByLabel("Paste only into your WorkPilot extension", { exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: join(output, "browser-connection-en.png") });
  assert(
    await panel.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth + 1;
    }),
  );
  report.checks.push("english_connection_instructions_one_use_code_and_explicit_revocation");
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
  await expect
    .poll(() =>
      panel
        .getByLabel("Page URL", { exact: true })
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    )
    .not.toBe("rgb(255, 255, 255)");
  const contrast = await panel.getByLabel("Page URL", { exact: true }).evaluate((el) => {
    const s = getComputedStyle(el);
    return { background: s.backgroundColor, color: s.color };
  });
  assert.notEqual(contrast.background, "rgb(255, 255, 255)");
  assert.notEqual(contrast.background, contrast.color);
  await panel.locator("summary").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "browser-dark-en.png") });
  report.checks.push("browser_controls_follow_dark_theme_without_white_input_background");
}
