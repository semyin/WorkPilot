import { test, expect } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, create } from "../../scripts/tool-test-support.mjs";
import { workbenchScenario } from "../../scripts/workbench-scenario.mjs";
test("P07 real engine: edit, approval, conflicts, history, static preview and terminal", async ({
  page,
}) => {
  test.setTimeout(180000);
  const output = ".test-results/workbench-ui";
  await mkdir(output, { recursive: true });
  const engine = await launch();
  const folder = await mkdtemp(join(engine.directory, "project-"));
  const report = { at: new Date().toISOString(), platform: process.platform, checks: [] };
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await writeFile(join(folder, "notes.txt"), "original\n第二行\n");
    await writeFile(
      join(folder, "preview.html"),
      "<h1>Static preview</h1><script>window.__p07UnsafeScriptRan=true</script>",
    );
    const task = await create(engine, "responses", "P07 UI");
    const configured = await engine.request({
      kind: "configure_task_tools",
      task_id: task,
      settings: {
        root_path: folder,
        permission: "request_approval",
        commands_enabled: true,
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
        if (command === "set_desktop_locale" || command === "project_preview_close") return;
        throw new Error("Unexpected desktop action: " + command);
      },
    );
    await page.addInitScript(() => {
      (window as any).__TAURI_INTERNALS__ = {
        invoke: (command: string, args: unknown) =>
          (window as any).workpilotTestInvoke({ command, args }),
      };
    });
    await page.goto("/");
    await workbenchScenario({ page, folder, task, report, output });
    expect(errors).toEqual([]);
    await writeFile(
      join(output, "report.json"),
      JSON.stringify({ ...report, status: "passed" }, null, 2) + "\n",
    );
  } finally {
    await engine.close();
  }
});
