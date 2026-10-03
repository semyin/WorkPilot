import { chromium } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { root } from "./cargo.mjs";
const cache = join(root, ".local/p12-runtime-downloads"),
  all = JSON.parse(await readFile(join(cache, "prepared.json"), "utf8"));
const entry =
  all.find((a) => a.id === "chromium") ||
  JSON.parse(await readFile(join(cache, "chromium-extracted.json"), "utf8"));
const browser = await chromium.launch({
  executablePath: join(entry.directory, entry.entry),
  headless: true,
  args: [
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--no-first-run",
  ],
});
try {
  const page = await browser.newPage();
  await page.goto("chrome://credits");
  await page.waitForLoadState("domcontentloaded");
  const html = await page.content();
  if (html.length < 50000 || html.includes("This is sample credits page")) {
    await writeFile(
      join(cache, "chromium-license-check.json"),
      JSON.stringify(
        {
          version: browser.version(),
          revision: 1710726,
          status: "blocked",
          reason:
            "Official snapshot has sample chrome://credits, not full third-party licenses. Excluded from distribution.",
          creditsBytes: Buffer.byteLength(html),
        },
        null,
        2,
      ) + "\n",
    );
    throw new Error(
      "Chromium component licenses are incomplete; do not distribute this candidate.",
    );
  }
  await writeFile(join(cache, "chromium-CREDITS.html"), html);
  const source =
    "https://raw.githubusercontent.com/chromium/chromium/cf098eeefcd5aca3361bba7216c1f704592acfd8/LICENSE";
  const response = await fetch(source);
  if (!response.ok) throw new Error("Chromium license download failed");
  await writeFile(join(cache, "chromium-LICENSE.txt"), await response.text());
  const version = browser.version();
  await writeFile(
    join(cache, "chromium-version.json"),
    JSON.stringify(
      { version, revision: 1710726, source, creditsBytes: Buffer.byteLength(html) },
      null,
      2,
    ) + "\n",
  );
  console.log(JSON.stringify({ version, creditsBytes: Buffer.byteLength(html), status: "passed" }));
} finally {
  await browser.close();
}
