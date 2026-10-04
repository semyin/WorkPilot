import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserExecutable } from "../../services/browser/executable.mjs";

test("bundled browser does not fall back to an installed personal browser", async () => {
  const root = await mkdtemp(join(tmpdir(), "workpilot-bundled-missing-"));
  await assert.rejects(browserExecutable("chromium", root), /repair installation/);
});
test("bundled browser resolves the application-local executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "workpilot-bundled-present-"));
  const folder = join(root, "chromium-runtime");
  await mkdir(folder);
  const file = join(folder, process.platform === "win32" ? "chrome.exe" : "chrome");
  await writeFile(file, "fixture");
  assert.equal(await browserExecutable("chromium", root, {}), await realpath(file));
});
test("bundled browser rejects an executable redirected outside installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "workpilot-bundled-link-"));
  const outside = await mkdtemp(join(tmpdir(), "workpilot-bundled-outside-"));
  await writeFile(join(outside, process.platform === "win32" ? "chrome.exe" : "chrome"), "fixture");
  await symlink(
    outside,
    join(root, "chromium-runtime"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(browserExecutable("chromium", root), /leaves installation/);
});
