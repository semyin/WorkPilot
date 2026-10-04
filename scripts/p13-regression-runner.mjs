import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile, copyFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

const mode = process.argv[2];
const groups = {
  engine: [
    ["execution", "execution-engine-test.mjs", ".test-results/execution-engine/report.json"],
    ["tools", "tools-engine-test.mjs", ".test-results/tools-engine/report.json"],
    ["teams", "teams-engine-test.mjs", ".test-results/tools-engine/team-report.json"],
    ["browser-model", "browser-model-test.mjs"],
    ["extensions", "extensions-engine-test.mjs", ".test-results/extensions-engine/report.json"],
    ["extensions-model", "extensions-model-test.mjs", ".test-results/extensions-model/report.json"],
    ["media", "media-engine-test.mjs", ".test-results/media-engine/report.json"],
    ["media-model", "media-model-test.mjs", ".test-results/media-model/report.json"],
    ["memory", "memory-engine-test.mjs"],
    ["schedules", "schedules-engine-test.mjs"],
    ["migration", "migration-test.mjs"],
    ["maintenance", "maintenance-engine-test.mjs"],
    ["update", "update-engine-test.mjs"],
  ],
  desktop: [
    ["workspace", "workspace-desktop-smoke.mjs", ".test-results/workspace-desktop/report.json"],
    ["team-restore", "team-restore-desktop.mjs"],
    ["migration", "migration-desktop.mjs"],
    ["maintenance", "maintenance-desktop-test.mjs"],
    ["update", "update-desktop-test.mjs"],
  ],
  environment: [
    ["installation", "installation-engine-test.mjs"],
    ["offline", "offline-environment-test.mjs"],
    ["git-sandbox", "git-sandbox-test.mjs"],
    ["bundled-browser", "bundled-browser-test.mjs"],
    ["browser-engine", "browser-engine-test.mjs"],
    ["browser-safety", "browser-safety-test.mjs", ".test-results/browser-safety/report.json"],
    [
      "browser-lifecycle",
      "browser-lifecycle-test.mjs",
      ".test-results/browser-lifecycle/report.json",
    ],
    ["extension-history", "extension-history-test.mjs"],
  ],
};
assert(groups[mode], "Select engine, desktop or environment");
const preview = resolve(
  process.env.WORKPILOT_PREVIEW || "artifacts/workpilot-p13-candidate-2026-10-04-r3/preview",
);
const output = resolve(process.env.WORKPILOT_SUITE_OUTPUT || ".test-results/p13-regression");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, mode + "-"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const engine = join(preview, "workpilot-sidecar.exe"),
  desktop = join(preview, "workpilot-desktop.exe"),
  updater = join(preview, "workpilot-update.exe");
const identities = {
  engine: hash(await readFile(engine)),
  desktop: hash(await readFile(desktop)),
  updater: hash(await readFile(updater)),
};
const report = { at: new Date().toISOString(), mode, preview, identities, suites: [] };
const selected = process.env.WORKPILOT_SUITE_FILTER?.split(",");
const cases = selected ? groups[mode].filter(([name]) => selected.includes(name)) : groups[mode];
assert(cases.length && (!selected || cases.length === selected.length), "Unknown suite name");
for (const [name, script, legacy] of cases) {
  const folder = join(directory, name);
  await mkdir(folder);
  const log = createWriteStream(join(folder, "output.txt"));
  const sourceReport = legacy ? resolve(legacy) : join(folder, "report.json");
  if (legacy) await copyFile(sourceReport, join(folder, "previous-report.json")).catch(() => {});
  const began = Date.now();
  console.log(JSON.stringify({ stage: "suite-start", mode, name, directory }));
  const row = { name, command: "node scripts/" + script, began: new Date(began).toISOString() };
  try {
    row.exitCode = await new Promise((done, reject) => {
      const child = spawn(process.execPath, [join("scripts", script)], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          WORKPILOT_ENGINE_BINARY: engine,
          WORKPILOT_DESKTOP_BINARY: desktop,
          WORKPILOT_UPDATE_BINARY: updater,
          WORKPILOT_UPDATE_EVIDENCE: folder,
          WORKPILOT_TEST_OUTPUT: folder,
          WORKPILOT_BROWSER_BUNDLE: preview,
          WORKPILOT_BROWSER_CHANNEL: "chromium",
          WORKPILOT_BROWSER_CHANNELS: "chromium",
          WORKPILOT_BROWSER_HEADLESS: "1",
        },
      });
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      child.once("error", reject);
      child.once("close", done);
    });
    await new Promise((done) => log.end(done));
    const result = JSON.parse(await readFile(sourceReport, "utf8"));
    assert((await stat(sourceReport)).mtimeMs >= began - 2000, "Stale report");
    if (legacy) await copyFile(sourceReport, join(folder, "report.json"));
    const testHash = result.binarySha256 || result.binary?.sha256;
    if (typeof testHash === "string") {
      assert.equal(testHash, mode === "desktop" ? identities.desktop : identities.engine);
    }
    assert.equal(row.exitCode, 0, "Suite process failed");
    assert(
      result.status === "passed" ||
        result.result === "passed" ||
        result.state === "passed" ||
        result.passed === true,
      "Suite did not declare success",
    );
    row.status = "passed";
    row.checks = result.checks?.length || 0;
  } catch (error) {
    log.end();
    row.status = "failed";
    row.error = String(error);
    process.exitCode = 1;
  }
  row.elapsedSeconds = Math.round((Date.now() - began) / 10) / 100;
  row.report = join(folder, "report.json");
  report.suites.push(row);
  report.status = report.suites.some((r) => r.status !== "passed") ? "failed" : "running";
  await writeFile(join(directory, "summary.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(row));
}
assert.equal(
  hash(await readFile(engine)),
  identities.engine,
  "Engine package changed during tests",
);
assert.equal(
  hash(await readFile(desktop)),
  identities.desktop,
  "Desktop package changed during tests",
);
report.status = process.exitCode ? "failed" : "passed";
report.finishedAt = new Date().toISOString();
await writeFile(join(directory, "summary.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ status: report.status, directory, suites: report.suites.length }));
