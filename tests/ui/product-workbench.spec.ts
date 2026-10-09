import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { launch, profile, setFixture } from "../../scripts/tool-test-support.mjs";
import { startExecutionFixture } from "../../services/execution-fixtures/server.mjs";

test("product workbench uses real task data, menus, drafts and bounded layout", async ({
  page,
}) => {
  test.setTimeout(120000);
  const output = ".test-results/product-workbench";
  await mkdir(output, { recursive: true });
  const fixture = await startExecutionFixture(() => ({
    text: "已完成工作台真实链路验证。",
    calls: [],
    delay: 1500,
  }));
  setFixture(fixture);
  const engine = await launch(),
    model = profile("responses", "workbench-model");
  const errors: string[] = [],
    checks: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await engine.request({
      kind: "save_provider",
      profile: model,
      secret: null,
      clear_credential: false,
    });
    await page.exposeBinding(
      "workpilotTestInvoke",
      async (_, { command, args }: { command: string; args: any }) => {
        if (command === "engine_command")
          return engine.request(args.request.command, args.request.request_id);
        if (command === "pick_project_folder") return engine.directory;
        if (command === "set_desktop_locale" || command === "hide_window") return;
        throw new Error("Unexpected IPC " + command);
      },
    );
    await page.addInitScript(() => {
      (window as any).__TAURI_INTERNALS__ = {
        invoke: (command: string, args: unknown) =>
          (window as any).workpilotTestInvoke({ command, args }),
      };
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "开始一项新工作" })).toBeVisible();
    await page.getByRole("button", { name: "新建项目", exact: true }).click();
    await page.getByLabel("项目名称", { exact: true }).fill("WorkPilot 界面重做");
    await page.getByLabel("项目文件夹", { exact: true }).fill(engine.directory);
    await page.getByRole("combobox", { name: "默认模型", exact: true }).click();
    await page.getByRole("option", { name: /workbench-model/ }).click();
    await page.getByRole("button", { name: "保存项目", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "项目设置" })).toHaveCount(0);
    await page.getByRole("button", { name: "+ 新建任务", exact: true }).click();
    await page
      .getByLabel("你想完成什么？", { exact: true })
      .fill("整理工作台的页面结构，并说明需要处理的事项。");
    await page.screenshot({ animations: "disabled", path: output + "/new-task.png" });
    await expect(page.locator(".execution-create select")).toHaveCount(0);
    await page.getByRole("button", { name: "创建并开始", exact: true }).click();
    await expect(page.getByTestId("execution-status")).toHaveAttribute("data-state", "completed", {
      timeout: 30000,
    });
    const first = await page.evaluate(() => localStorage.getItem("workpilot.execution"));
    await expect(page.getByRole("region", { name: "对话记录" })).toContainText("真实链路验证");
    checks.push("project-default-model-and-real-engine-conversation");
    await page.getByLabel("发送新的要求", { exact: true }).fill("这段草稿应在任务切换后保留。");
    await page.keyboard.press("Control+n");
    await page.getByLabel("你想完成什么？", { exact: true }).fill("第二个独立的工作任务");
    await page.locator(`[data-execution-id="${first}"]`).click();
    await page.keyboard.press("Control+n");
    await expect(page.getByLabel("你想完成什么？", { exact: true })).toHaveValue(
      "第二个独立的工作任务",
    );
    await page.getByRole("button", { name: "创建并开始", exact: true }).click();
    await expect(page.getByTestId("execution-status")).toHaveAttribute("data-state", "completed", {
      timeout: 30000,
    });
    const second = await page.evaluate(() => localStorage.getItem("workpilot.execution"));
    await page.locator(`[data-execution-id="${first}"]`).click();
    await expect(page.getByLabel("发送新的要求", { exact: true })).toHaveValue(
      "这段草稿应在任务切换后保留。",
    );
    checks.push("per-task-unsent-draft-survives-switch");
    await page.locator(`[data-execution-id="${second}"]`).click({ button: "right" });
    await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
    await page.getByLabel("新的任务名称", { exact: true }).fill("待归档的第二个任务");
    await page.getByRole("button", { name: "保存名称", exact: true }).click();
    await expect(page.locator(`[data-execution-id="${second}"]`)).toContainText(
      "待归档的第二个任务",
    );
    await expect(page.getByTestId("execution-status")).toHaveAttribute("data-task-id", first!);
    await page.locator(`[data-execution-id="${second}"]`).click({ button: "right" });
    await page.getByRole("menuitem", { name: /归档任务/ }).click();
    await expect(page.locator(`[data-execution-id="${second}"]`)).toHaveCount(0);
    checks.push("right-click-mutates-target-task-without-changing-selection");
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "搜索任务", exact: true }).fill("第二个任务");
    await page.getByLabel("已归档", { exact: true }).check();
    await expect(page.getByRole("option", { name: /待归档的第二个任务/ })).toBeVisible();
    await expect(page.getByRole("option", { name: /待归档的第二个任务/ })).toContainText(
      "WorkPilot 界面重做",
    );
    await page.screenshot({ animations: "disabled", path: output + "/search.png" });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "搜索任务" })).toHaveCount(0);
    checks.push("search-dialog-finds-persisted-archived-task");
    await page.getByLabel("发送新的要求", { exact: true }).fill("");
    await page.getByRole("button", { name: "工作区工具", exact: true }).click();
    await page.getByRole("menuitem", { name: "运行设置", exact: true }).click();
    await expect(page.getByRole("heading", { name: "运行设置", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "过程", exact: true }).click();
    await page.screenshot({ animations: "disabled", path: output + "/task.png" });
    await page.getByRole("separator", { name: "调整详情栏宽度" }).focus();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("separator", { name: "调整详情栏宽度" })).toHaveAttribute(
      "aria-valuenow",
      "368",
    );
    await expect
      .poll(async () => Math.round((await page.locator(".wb-inspector").boundingBox())!.width))
      .toBe(368);
    const handle = await page.getByRole("separator", { name: "调整详情栏宽度" }).boundingBox();
    await page.mouse.move(handle!.x + handle!.width / 2, 250);
    await page.mouse.down();
    await page.mouse.move(handle!.x + handle!.width / 2 - 32, 250, { steps: 6 });
    await page.mouse.up();
    await expect(page.getByRole("separator", { name: "调整详情栏宽度" })).toHaveAttribute(
      "aria-valuenow",
      "400",
    );
    await page.getByRole("button", { name: "详情面板", exact: true }).click();
    await expect(page.locator(".wb-inspector")).toHaveAttribute("aria-hidden", "true");
    await page.getByRole("button", { name: "详情面板", exact: true }).click();
    await page.setViewportSize({ width: 1000, height: 740 });
    await expect
      .poll(async () => {
        const box = await page.locator(".wb-inspector").boundingBox();
        return box!.x + box!.width;
      })
      .toBeLessThanOrEqual(1001);
    await page.screenshot({ animations: "disabled", path: output + "/narrow.png" });
    const bounds = await page.locator(".wb-inspector").boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1001);
    checks.push("persisted-pointer-and-keyboard-panel-resize-collapse-and-narrow-window");
    await page.setViewportSize({ width: 1240, height: 820 });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("combobox", { name: "外观", exact: true }).click();
    await page.getByRole("option", { name: "深色", exact: true }).click();
    await page.getByRole("button", { name: "任务与权限", exact: true }).click();
    await page.getByRole("button", { name: "通用与外观", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "外观", exact: true })).toContainText("深色");
    await page.screenshot({ animations: "disabled", path: output + "/settings.png" });
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ animations: "disabled", path: output + "/dark.png" });
    checks.push("settings-navigation-keeps-draft-and-saves-real-theme");
    await page.reload();
    await expect(page.getByTestId("execution-status")).toHaveAttribute("data-task-id", first!);
    const detail = await engine.request({
      kind: "read",
      query: { kind: "execution", task_id: first },
    });
    expect(detail.snapshot.messages).toHaveLength(0);
    expect(errors).toEqual([]);
    checks.push("reload-does-not-submit-unsent-draft-no-browser-errors");
    await writeFile(
      output + "/report.json",
      JSON.stringify(
        {
          at: new Date().toISOString(),
          platform: process.platform,
          engine: "real isolated data directory",
          model: "local synthetic HTTP",
          checks,
          errors,
        },
        null,
        2,
      ),
    );
  } finally {
    await page.close();
    await engine.close();
    await fixture.close();
  }
});
