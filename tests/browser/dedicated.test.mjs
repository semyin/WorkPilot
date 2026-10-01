import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFixtureServer } from "../../services/fixtures/server.mjs";

for (const channel of ["chrome", "msedge"]) {
  test(
    channel + " isolated profile: navigation, read, fill, click, download, persistence",
    { timeout: 60000 },
    async (t) => {
      const fixture = await startFixtureServer();
      t.after(fixture.close);
      const directory = await mkdtemp(join(tmpdir(), "workpilot-browser-" + channel + "-"));
      const context = await chromium.launchPersistentContext(directory, {
        channel,
        headless: true,
        acceptDownloads: true,
      });
      try {
        const page = await context.newPage();
        await page.goto(fixture.url + "/page");
        assert.equal(await page.title(), "WorkPilot Browser Fixture");
        await page.getByRole("textbox", { name: "Name" }).fill("WorkPilot");
        await page.getByRole("button", { name: "Greet" }).click();
        assert.equal(await page.locator("#result").textContent(), "Hello, WorkPilot");
        const downloadPromise = page.waitForEvent("download");
        await page.getByRole("link", { name: "Download sample" }).click();
        const download = await downloadPromise;
        const path = join(directory, "sample.csv");
        await download.saveAs(path);
        assert.equal(await readFile(path, "utf8"), "name,value\nWorkPilot,42\n");
        await page.evaluate(() => localStorage.setItem("workpilot-probe", "persisted"));
      } finally {
        await context.close();
      }
      const reopened = await chromium.launchPersistentContext(directory, {
        channel,
        headless: true,
      });
      try {
        const page = await reopened.newPage();
        await page.goto(fixture.url + "/page");
        assert.equal(
          await page.evaluate(() => localStorage.getItem("workpilot-probe")),
          "persisted",
        );
      } finally {
        await reopened.close();
      }
    },
  );
}
