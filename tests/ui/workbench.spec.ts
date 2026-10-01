import { test, expect } from "@playwright/test";

test("preview is honest about absent engine and switches both UI and file preview language", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("引擎未连接", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "开始验证" })).toBeDisabled();
  await expect(
    page.frameLocator("iframe").getByRole("heading", { name: "欢迎使用 WorkPilot" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "English", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Turn ideas into action." })).toBeVisible();
  await expect(
    page.frameLocator("iframe").getByRole("heading", { name: "Welcome to WorkPilot" }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "简体中文", exact: true })).toBeVisible();
  await page.screenshot({ path: ".test-results/ui/english-preview.png" });
});

test("remote preview never fakes a native browser in web-only mode", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "网页", exact: true }).click();
  await expect(page.getByRole("button", { name: "打开网页样本" })).toBeDisabled();
  await page.screenshot({ path: ".test-results/ui/chinese-preview.png" });
});
