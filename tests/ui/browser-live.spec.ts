import { test, expect } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launch } from "../../scripts/tool-test-support.mjs";
import { browserTask } from "../../scripts/browser-test-support.mjs";
import { browserScenario } from "../../scripts/browser-scenario.mjs";
import { startBrowserFixture } from "../../services/browser-fixtures/server.mjs";

test("P08 real engine and browser: approvals, DOM, screenshot, takeover and connection UI", async ({
  page,
}) => {
  test.setTimeout(180000);
  const output = ".test-results/browser-ui";
  await mkdir(output, { recursive: true });
  process.env.WORKPILOT_BROWSER_HEADLESS = "1";
  const engine = await launch(),
    site = await startBrowserFixture();
  const report = { at: new Date().toISOString(), platform: process.platform, checks: [] };
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    const folder = await mkdtemp(join(engine.directory, "browser-ui-"));
    const b = await browserTask(engine, folder, { permission: "request_approval" });
    await page.exposeBinding(
      "workpilotTestInvoke",
      async (_, { command, args }: { command: string; args: any }) => {
        if (command === "engine_command")
          return engine.request(args.request.command, args.request.request_id);
        if (command === "set_desktop_locale") return;
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
    await browserScenario({ page, task: b.task, url: site.url, report, output });
    expect(errors).toEqual([]);
    await writeFile(
      join(output, "report.json"),
      JSON.stringify({ ...report, status: "passed" }, null, 2) + "\n",
    );
  } finally {
    await page.close();
    await engine.close();
    await site.close();
  }
});
