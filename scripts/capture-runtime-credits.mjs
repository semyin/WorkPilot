import { chromium } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { root } from "./cargo.mjs";

const cache = join(root, ".local/p12-runtime-downloads");
const all = JSON.parse(await readFile(join(cache, "prepared.json"), "utf8"));
const sources = JSON.parse(
  await readFile(join(root, "resources/runtimes/windows-x64.json"), "utf8"),
);
const entry = all.find((a) => a.id === "chromium");
const asset = sources.assets.find((a) => a.id === "chromium");
if (!entry || asset?.distribution || asset?.sha256 !== entry.sha256)
  throw new Error("Prepare the selected, approved Chromium archive first.");
const output = join(cache, "chromium-notices");
await mkdir(output, { recursive: true });
const digest = (data) => createHash("sha256").update(data).digest("hex");
const files = [];
async function save(path, data) {
  await writeFile(join(output, path), data);
  files.push({ path, bytes: Buffer.byteLength(data), sha256: digest(data) });
}
for (const license of asset.licenses) {
  let bytes;
  try {
    bytes = await readFile(join(output, license.file));
  } catch {}
  if (!bytes || digest(bytes) !== license.sha256) {
    const response = await fetch(license.url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error("Chromium license download failed: " + response.status);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (digest(bytes) !== license.sha256) throw new Error("Chromium root license has changed.");
  await save(license.file, bytes);
}
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
  const html = await page.content();
  if (
    html.length < 100000 ||
    html.includes("This is sample credits page") ||
    !html.includes("Abseil") ||
    !html.includes("Permission is hereby granted")
  )
    throw new Error(
      "Chromium credits are missing complete component license text; do not distribute.",
    );
  const version = browser.version();
  if (version !== asset.version.split("-")[0])
    throw new Error("Chromium version differs from the fixed asset.");
  await save("CREDITS.html", html);
  await save(
    "SOURCE.json",
    JSON.stringify(
      {
        version: asset.version,
        archive: asset.url,
        archiveSha256: asset.sha256,
        source: asset.source,
        upstreamSource: asset.upstreamSource,
        licenseSources: asset.licenses,
        creditsSource: "chrome://credits from the verified archive",
        updatePolicy:
          "Application-local, pinned browser. Updates require a new verified application package.",
      },
      null,
      2,
    ) + "\n",
  );
  const receipt = {
    at: new Date().toISOString(),
    version,
    archiveSha256: asset.sha256,
    status: "passed",
    sample: false,
    directory: output,
    files,
  };
  await writeFile(join(cache, "chromium-notices.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(
    JSON.stringify({
      version,
      creditsBytes: Buffer.byteLength(html),
      files: files.length,
      status: "passed",
    }),
  );
} finally {
  await browser.close();
}
