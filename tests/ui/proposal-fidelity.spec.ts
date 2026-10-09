import { test, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { launch, profile, setFixture, create } from "../../scripts/tool-test-support.mjs";
import { startExecutionFixture } from "../../services/execution-fixtures/server.mjs";

test.use({ deviceScaleFactor: 1.75 });

test("proposal approval and artifact surfaces act on real files", async ({ page }) => {
  test.setTimeout(60000);
  const output = ".test-results/proposal-fidelity";
  await mkdir(output, { recursive: true });
  const file = "工作台结构.md";
  const body =
    "# 把当前任务放在中心\n\n项目帮助你组织工作。对话承载目标与反馈。\n\n## 清晰的层级\n\n1. 优先呈现当前工作。\n2. 需要时再出现具体操作。\n3. 过程可追溯，成果可继续使用。";
  const fixture = await startExecutionFixture((_: unknown, results: unknown[]) =>
    results.length === 0
      ? {
          text: "准备保存工作台结构。",
          calls: [{ name: "write_file", args: { path: file, text: body, expected_sha256: null } }],
        }
      : results.length === 1
        ? { text: "", calls: [{ name: "register_artifact", args: { path: file } }] }
        : { text: "已保存工作台结构，可以在右侧查看。", calls: [] },
  );
  setFixture(fixture);
  const engine = await launch();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    const folder = engine.directory + "/project";
    await mkdir(folder);
    const task = await create(engine, "responses", "proposal-artifact", {
      title: "重做产品工作台",
      controlled_tools: false,
    });
    const configured = await engine.request({
      kind: "configure_task_tools",
      task_id: task,
      settings: {
        root_path: folder,
        permission: "request_approval",
        commands_enabled: false,
        review_profile_id: null,
        revision: 0,
      },
    });
    expect(configured.kind).not.toBe("error");
    await page.exposeBinding(
      "workpilotTestInvoke",
      async (_, { command, args }: { command: string; args: any }) => {
        if (command === "engine_command")
          return engine.request(args.request.command, args.request.request_id);
        if (command === "set_desktop_locale") return;
        throw new Error("Unexpected IPC " + command);
      },
    );
    await page.addInitScript((task) => {
      localStorage.setItem("workpilot.execution", task);
      (window as any).__TAURI_INTERNALS__ = {
        invoke: (command: string, args: unknown) =>
          (window as any).workpilotTestInvoke({ command, args }),
      };
    }, task);
    await engine.request({ kind: "start_execution", task_id: task });
    await page.goto("/");
    await expect(page.getByTestId("execution-status")).toHaveAttribute(
      "data-state",
      "awaiting_approval",
    );
    const approval = page.locator(".wb-conversation .wb-approval");
    await expect(approval).toContainText(file);
    await expect(page.locator(".wb-conversation .execution-notice")).toHaveCount(0);
    await expect(readFile(folder + "/" + file)).rejects.toThrow();
    await page.screenshot({ path: output + "/approval.png", animations: "disabled" });
    await approval.getByRole("button", { name: "批准并继续", exact: true }).click();
    await expect(page.getByTestId("execution-status")).toHaveAttribute("data-state", "completed");
    expect(await readFile(folder + "/" + file, "utf8")).toBe(body);
    await page.getByRole("button", { name: "成果", exact: true }).click();
    await expect(page.locator(".wb-artifact-document")).toContainText("把当前任务放在中心");
    await page.screenshot({ path: output + "/artifact.png", animations: "disabled" });
    await page.getByRole("button", { name: "文件", exact: true }).click();
    await page.locator(".wb-tree-row").filter({ hasText: file }).click();
    await expect(page.locator(".wb-artifact-document")).toContainText("过程可追溯");
    await page.getByRole("button", { name: "资料库", exact: true }).click();
    await page.locator(".wb-result-list .wb-result-row").filter({ hasText: file }).click();
    await expect(page.getByTestId("execution-status")).toHaveAttribute("data-task-id", task);
    await expect(page.locator(".wb-artifact-document")).toContainText("把当前任务放在中心");
    expect(errors).toEqual([]);
    await writeFile(
      output + "/artifact-report.json",
      JSON.stringify(
        {
          at: new Date().toISOString(),
          engine: "real isolated Rust engine",
          model: "synthetic local HTTP",
          checks: [
            "inline approval does not write before confirmation",
            "approval preserves target and fingerprint",
            "real file and registered artifact match",
            "project tree reads the actual file",
            "library opens the originating task and artifact",
          ],
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

test("approved proposal geometry, real conversation layout and navigation remain aligned", async ({
  page,
}) => {
  test.setTimeout(120000);
  const output = ".test-results/proposal-fidelity";
  await mkdir(output, { recursive: true });
  const proposal = "artifacts/workpilot-product-design-2026-10-09/";
  const source = Object.fromEntries(
    await Promise.all(
      ["workbench", "workspace", "settings", "search", "menus", "workspace-controls"].map(
        async (name) => [name, await readFile(proposal + name + ".css", "utf8")],
      ),
    ),
  );
  const declaration = (file: string, selector: string, property: string) => {
    const block = source[file].split(selector + " {")[1]?.split("}")[0];
    return new RegExp(`(?:^|[;\\n])\\s*${property}:\\s*([^;]+);`).exec(block || "")?.[1].trim();
  };
  const fixture = await startExecutionFixture(() => ({
    text: "我会先理清工作台的结构，再梳理从开始到交付的关键操作。\n\n当前的问题主要在于：功能入口与正在进行的工作争抢注意力，操作之间也缺少清晰的先后关系。\n\n## 把工作台分成三个有明确分工的区域\n\n1. **左侧，找到工作。** 按项目组织任务，快速切换和搜索。\n2. **中间，推进工作。** 对话、进度和需要你处理的事项都在这里。\n3. **右侧，查看结果。** 按需展开文件、成果和完整过程。\n\n你可以继续补充要求，或打开任一文档讨论具体修改。",
    calls: [],
    delay: 200,
  }));
  setFixture(fixture);
  const engine = await launch();
  const model = profile("responses", "fidelity-model");
  model.label = "Qwen";
  const errors: string[] = [],
    checks: unknown[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await engine.request({
      kind: "save_provider",
      profile: model,
      secret: null,
      clear_credential: false,
    });
    await engine.request({
      kind: "set_default_profile",
      scope: { kind: "global" },
      profile_id: model.id,
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
    await expect(page.locator(".wb-work-panel")).toBeHidden();
    const geometry = () =>
      page.evaluate(() => {
        const css = (selector: string) => getComputedStyle(document.querySelector(selector)!);
        const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        return {
          sidebar: box(".wb-sidebar").width,
          header: box(".wb-workspace-header").height,
          headerPadding: css(".wb-workspace-header").paddingInline,
          conversationPadding: css(".wb-conversation").padding,
          conversationMaxWidth: css(".wb-conversation").maxWidth,
          composerPadding: css(".wb-composer").padding,
          composerRadius: css(".wb-composer").borderRadius,
          composerBorder: css(".wb-composer").borderTopColor,
          inputHeight: box(".wb-composer textarea").height,
          inputResize: css(".wb-composer textarea").resize,
          inputFontSize: css(".wb-composer textarea").fontSize,
          icon: box(".wb-brand img").width,
          overflow: document.documentElement.scrollWidth - innerWidth,
        };
      });
    const base = await geometry();
    expect(base).toMatchObject({
      sidebar: parseFloat(declaration("workbench", ".sidebar", "width")!),
      header: parseFloat(declaration("workbench", ".workspace-header", "height")!),
      headerPadding: "32px",
      conversationPadding: declaration("workspace", ".conversation", "padding"),
      conversationMaxWidth: declaration("workspace", ".conversation", "max-width"),
      composerPadding: "12px 12px 9px",
      composerRadius: declaration("workspace", ".composer", "border-radius"),
      inputHeight: parseFloat(declaration("workspace", ".composer textarea", "min-height")!),
      inputResize: "none",
      inputFontSize: "13px",
      icon: 27,
      overflow: 0,
    });
    checks.push({ viewport: "1240x820 CSS pixels", scale: 1.75, actual: base });
    await page.screenshot({ path: output + "/new-task.png", animations: "disabled" });
    await page
      .getByLabel("你想完成什么？", { exact: true })
      .fill(
        "重新梳理 WorkPilot 的界面和操作流程。以当前任务为中心，让开始工作、查看进度和处理成果都更自然。",
      );
    await page.getByRole("button", { name: "创建并开始", exact: true }).click();
    await expect(page.getByTestId("execution-status")).toHaveAttribute("data-state", "completed");
    await expect(page.locator(".wb-conversation-log .wb-assistant-message h2")).toHaveText(
      "把工作台分成三个有明确分工的区域",
    );
    await page.getByRole("button", { name: "详情面板", exact: true }).click();
    await expect(page.locator(".wb-work-panel")).toBeHidden();
    const message = await page.evaluate(() => {
      const user = document.querySelector(".wb-user-message")!,
        assistant = document.querySelector(".wb-assistant-header")!;
      const style = getComputedStyle(user);
      return {
        top: user.getBoundingClientRect().top,
        gap: assistant.getBoundingClientRect().top - user.getBoundingClientRect().bottom,
        radius: style.borderRadius,
        padding: style.padding,
        font: style.fontSize,
      };
    });
    expect(message).toMatchObject({
      top: 112,
      gap: 30,
      radius: "13px 13px 4px",
      padding: "12px 17px",
      font: "13px",
    });
    expect(
      await page
        .locator(".wb-composer textarea")
        .evaluate((el) => el.getBoundingClientRect().height),
    ).toBe(51);
    await expect(page.locator(".wb-conversation-log .model-actions")).toHaveCount(0);
    await expect(page.locator(".wb-composer select")).toHaveCount(0);
    await page.screenshot({ path: output + "/conversation.png", animations: "disabled" });
    checks.push({
      conversation: message,
      regression: "no empty toolbar spacer, no inherited message margins, markdown rendered",
    });

    await page.getByRole("combobox", { name: "工作模式", exact: true }).click();
    const menu = await page.getByRole("listbox", { name: "工作模式" }).evaluate((el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        radius: s.borderRadius,
        minWidth: s.minWidth,
        withinViewport:
          r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
      };
    });
    expect(menu).toMatchObject({
      radius: declaration("menus", ".popover", "border-radius"),
      minWidth: "218px",
      withinViewport: true,
    });
    await page.screenshot({ path: output + "/mode-menu.png", animations: "disabled" });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "上下文使用情况", exact: true }).click();
    await expect(page.locator(".wb-context-card")).toBeVisible();
    await page.screenshot({ path: output + "/context.png", animations: "disabled" });
    await page.keyboard.press("Escape");

    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "搜索任务", exact: true }).fill("WorkPilot");
    await expect(page.locator(".wb-search-result mark")).toHaveText("WorkPilot");
    const search = await page
      .getByRole("dialog", { name: "搜索任务", exact: true })
      .evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          width: el.getBoundingClientRect().width,
          padding: s.padding,
          border: s.borderTopWidth,
        };
      });
    expect(search).toEqual({
      width: parseFloat(declaration("search", ".command-dialog", "width")!),
      padding: "0px",
      border: "1px",
    });
    await page.screenshot({ path: output + "/search.png", animations: "disabled" });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "搜索任务" })).toHaveCount(0);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = await page.locator(".wb-settings-dialog").evaluate((el) => {
      const layout = el.querySelector(".wb-settings-layout")!;
      return {
        width: el.getBoundingClientRect().width,
        border: getComputedStyle(el).borderTopWidth,
        padding: getComputedStyle(el).padding,
        columns: getComputedStyle(layout).gridTemplateColumns,
        height: layout.getBoundingClientRect().height,
      };
    });
    expect(settings.width).toBe(parseFloat(declaration("settings", ".settings-dialog", "width")!));
    expect(settings).toMatchObject({ padding: "0px", border: "1px", height: 620 });
    expect(settings.columns.split(" ")[0]).toBe("190px");
    await page.screenshot({ path: output + "/settings.png", animations: "disabled" });
    checks.push({ menu, search, settings });
    await page.getByRole("switch", { name: "界面动画", exact: true }).click();
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-motion", "off");

    for (const [name, heading] of [
      ["资料库", "最近的成果"],
      ["技能与连接", "我的技能"],
      ["定时任务", "我的计划"],
    ]) {
      await page.getByRole("button", { name, exact: true }).click();
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      await expect(page.locator(".wb-composer-area")).toHaveCount(0);
      await expect(page.locator(".wb-conversation .wb-working-line")).toHaveCount(0);
      await expect(page.locator(".wb-conversation [role=alert]")).toHaveCount(0);
      await page.screenshot({ path: output + `/${name}.png`, animations: "disabled" });
    }
    await page.getByRole("button", { name: "任务", exact: true }).click();
    for (const viewport of [
      { width: 1600, height: 1000 },
      { width: 1000, height: 740 },
    ]) {
      await page.setViewportSize(viewport);
      const dimensions = await geometry();
      expect(dimensions.sidebar).toBe(viewport.width === 1600 ? 246 : 228);
      expect(dimensions.overflow).toBe(0);
      await page.screenshot({
        path: output + `/conversation-${viewport.width}.png`,
        animations: "disabled",
      });
      checks.push({ viewport, actual: dimensions });
    }
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("combobox", { name: "外观", exact: true }).click();
    await page.getByRole("option", { name: "深色", exact: true }).click();
    await page.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect
      .poll(() =>
        page.locator(".wb-workspace").evaluate((el) => getComputedStyle(el).backgroundColor),
      )
      .toBe("rgb(36, 38, 43)");
    await page.screenshot({ path: output + "/dark.png", animations: "disabled" });
    expect(errors).toEqual([]);
    await writeFile(
      output + "/report.json",
      JSON.stringify(
        {
          at: new Date().toISOString(),
          platform: process.platform,
          verification:
            "Production React page with isolated real Rust engine; synthetic model; source CSS comparison, not a rendered proposal pixel diff or native WebView acceptance",
          proposal: Object.fromEntries(
            Object.entries(source).map(([name, content]) => [
              name,
              createHash("sha256").update(content).digest("hex"),
            ]),
          ),
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
