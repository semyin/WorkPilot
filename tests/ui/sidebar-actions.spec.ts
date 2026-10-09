import { test, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, profile, setFixture, create } from "../../scripts/tool-test-support.mjs";
import { startExecutionFixture } from "../../services/execution-fixtures/server.mjs";

test.use({ deviceScaleFactor: 1.75 });

test("sidebar folder creation, direct project task, focus return and persistent deletion", async ({
  page,
}) => {
  test.setTimeout(120000);
  const output = ".test-results/sidebar-actions";
  await mkdir(output, { recursive: true });
  const fixture = await startExecutionFixture(() => ({
    text: "已完成侧栏测试。",
    calls: [],
    delay: 300,
  }));
  setFixture(fixture);
  const engine = await launch();
  const folder = join(engine.directory, "侧栏 项目");
  const errors: string[] = [],
    checks: string[] = [];
  const deletions: string[] = [];
  let folderChoice: string | null = null,
    picks = 0;
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await mkdir(folder);
    await writeFile(join(folder, "保留的文件.txt"), "实际项目文件必须保留");
    const model = profile("responses", "sidebar-model");
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
        if (command === "engine_command") {
          if (args.request.command.kind === "delete_task")
            deletions.push(args.request.command.task_id);
          return engine.request(args.request.command, args.request.request_id);
        }
        if (command === "pick_project_folder") {
          picks++;
          return folderChoice;
        }
        if (command === "set_desktop_locale") return;
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
    const addProject = page.getByRole("button", { name: "新建项目", exact: true });
    await addProject.click();
    await expect(addProject).toBeEnabled();
    expect(picks).toBe(1);
    await expect(page.locator(".wb-project-heading")).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    folderChoice = folder;
    await addProject.click();
    const project = page.locator(".wb-project-heading");
    await expect(project).toContainText("侧栏 项目");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const overview = await engine.request({
      kind: "read",
      query: { kind: "workspace", query: { kind: "overview" } },
    });
    expect(overview.data.projects).toHaveLength(1);
    const saved = overview.data.projects[0];
    expect(saved.settings).toMatchObject({
      name: "侧栏 项目",
      root_path: folder,
      default_profile_id: null,
      permission: "request_approval",
      rules: "",
    });
    checks.push(
      "native-folder-command-only; cancel-is-inert; automatic-folder-name-and-defaults-persist",
    );

    await project.click({ button: "right" });
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(project).toBeFocused();
    await expect(project).toHaveCSS("outline-style", "none");
    await project.click({ button: "right" });
    await page.getByRole("menuitem", { name: "项目设置", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "项目设置" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(project).toBeFocused();
    await expect(project).toHaveCSS("outline-style", "none");
    // Keyboard navigation keeps a visible, usable return target.
    await page.keyboard.press("Tab");
    const newTask = page.getByRole("button", { name: "在 侧栏 项目 中新建任务", exact: true });
    await expect(newTask).toBeFocused();
    await expect(newTask).toHaveCSS("outline-style", "solid");
    await page.keyboard.press("Shift+Tab");
    await expect(project).toHaveCSS("outline-style", "solid");
    await page.keyboard.press("Shift+F10");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(project).toBeFocused();
    await expect(project).toHaveCSS("outline-style", "solid");
    checks.push(
      "mouse-context-menu-and-dialog-Escape-have-no-leftover-ring; keyboard-focus-preserved",
    );

    await newTask.click();
    await expect(page.locator(".wb-composer-hint")).toContainText("侧栏 项目");
    await page.getByLabel("你想完成什么？", { exact: true }).fill("这个项目的新任务");
    await page.locator('input[type="file"]').setInputFiles({
      name: "附件.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("需要随任务删除的附件记录"),
    });
    await page.getByRole("button", { name: "创建并开始", exact: true }).click();
    await expect(page.getByTestId("execution-status")).toHaveAttribute("data-state", "completed");
    const first = (await page.evaluate(() => localStorage.getItem("workpilot.execution")))!;
    const firstDetail = await engine.request({
      kind: "read",
      query: { kind: "execution", task_id: first },
    });
    expect(firstDetail.snapshot.task.project_id).toBe(saved.id);
    expect(firstDetail.snapshot.task.profile_id).toBeNull();
    expect(firstDetail.snapshot.latest_run.profile.id).toBe(model.id);
    checks.push("project-compose-icon-binds-task-and-global-model; real-attachment-upload");
    await page.screenshot({ path: output + "/sidebar.png", animations: "disabled" });

    const second = await create(engine, "responses", "保留的另一个任务", {
      title: "保留的另一个任务",
      project_id: saved.id,
    });
    const row = (id: string) => page.locator(`[data-execution-id="${id}"]`);
    await expect(row(second)).toBeVisible();
    await row(second).click();
    await expect(page.getByTestId("execution-status")).toHaveAttribute("data-task-id", second);
    await row(first).click({ button: "right" });
    await page.getByRole("menuitem", { name: /^删除任务/ }).click();
    const dialog = page.getByRole("dialog", { name: "删除任务", exact: true });
    await expect(dialog).toContainText("这个项目的新任务");
    await expect(dialog).toContainText("实际文件会保留");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(deletions).toEqual([]);
    await expect(row(first)).toBeVisible();
    await row(first).click({ button: "right" });
    await page.getByRole("menuitem", { name: /^删除任务/ }).click();
    await expect(dialog.getByRole("button", { name: "删除任务", exact: true })).toBeEnabled();
    await page.screenshot({ path: output + "/delete-confirmation.png", animations: "disabled" });
    await dialog.getByRole("button", { name: "删除任务", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row(first)).toHaveCount(0);
    await expect(page.getByTestId("execution-status")).toHaveAttribute("data-task-id", second);
    expect(deletions).toEqual([first]);
    const deleted = await engine.request({
      kind: "read",
      query: { kind: "execution", task_id: first },
    });
    expect(deleted.kind).toBe("error");
    // The second task remains readable and untouched, including its selection.
    expect(
      (await engine.request({ kind: "read", query: { kind: "execution", task_id: second } })).kind,
    ).toBe("execution");
    expect(await readFile(join(folder, "保留的文件.txt"), "utf8")).toBe("实际项目文件必须保留");
    checks.push(
      "delete-cancel-is-inert; background-target-with-attachment-deleted; current-task-and-project-file-kept",
    );

    // A genuine team is removed as a whole when its main task is currently open.
    await engine.request({
      kind: "configure_team",
      task_id: second,
      settings: {
        enabled: true,
        max_parallel: 2,
        max_members: 4,
        max_depth: 2,
        max_replacements: 2,
        revision: 0,
      },
    });
    await engine.request({
      kind: "add_team_members",
      task_id: second,
      members: [
        { key: "research", role: "查资料", goal: "核对资料", profile_id: null, depends_on: [] },
      ],
    });
    await row(second).click({ button: "right" });
    await page.getByRole("menuitem", { name: /^删除任务/ }).click();
    await expect(dialog).toContainText("1 个协作助手记录");
    await dialog.getByRole("button", { name: "删除任务", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row(second)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "开始一项新工作", exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("workpilot.execution"))).toBeNull();
    await page.reload();
    await expect(page.getByRole("heading", { name: "开始一项新工作", exact: true })).toBeVisible();
    await expect(page.locator("[data-execution-id]")).toHaveCount(0);
    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: "搜索任务", exact: true }).fill("这个项目的新任务");
    await expect(page.getByRole("option")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    checks.push(
      "delete-current-root-with-members-clears-selection-and-remains-deleted-after-reload-and-search",
    );
    expect(errors).toEqual([]);
    await writeFile(
      output + "/report.json",
      JSON.stringify(
        {
          at: new Date().toISOString(),
          platform: process.platform,
          engine: "real isolated Rust engine",
          model: "local synthetic HTTP",
          folderPicker:
            "native command stub returns a real test folder; native OS dialog not driven",
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
