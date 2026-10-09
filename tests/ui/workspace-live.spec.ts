import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, profile, setFixture } from "../../scripts/tool-test-support.mjs";
import { startExecutionFixture } from "../../services/execution-fixtures/server.mjs";
import { workspaceScenario } from "../../scripts/workspace-scenario.mjs";
test("P06 real engine: project, conversation, queue, records, archive and preferences", async ({
  page,
}) => {
  test.setTimeout(120000);
  const output = ".test-results/workspace-ui";
  await mkdir(output, { recursive: true });
  const fixture = await startExecutionFixture(() => ({
    text: "工作台验证完成",
    calls: [],
    delay: 7000,
  }));
  setFixture(fixture);
  const engine = await launch();
  const p = profile("responses", "workspace-test");
  const report = { at: new Date().toISOString(), platform: process.platform, checks: [] };
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await engine.request({
      kind: "save_provider",
      profile: p,
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
    await workspaceScenario({
      page,
      request: engine.request,
      folder: engine.directory,
      report,
      output,
      profile: p,
    });
    const current = await engine.request({
      kind: "read",
      query: { kind: "workspace", query: { kind: "overview" } },
    });
    await engine.request({
      kind: "workspace",
      action: {
        kind: "save_preferences",
        preferences: { ...current.data.preferences, sidebar_width: 400, inspector_width: 700 },
      },
    });
    await page.setViewportSize({ width: 1000, height: 820 });
    await expect(page.getByRole("separator", { name: "Resize details panel" })).toHaveAttribute(
      "aria-valuenow",
      "700",
    );
    const fit = await page.evaluate(() => {
      const box = document.querySelector(".wb-work-panel")!.getBoundingClientRect();
      return box.right <= innerWidth + 1 && box.width > 260;
    });
    expect(fit).toBe(true);
    report.checks.push("narrow_window_keeps_large_saved_panels_in_view");
    expect(errors).toEqual([]);
    await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  } finally {
    await page.close();
    await engine.close();
    await fixture.close();
  }
});
