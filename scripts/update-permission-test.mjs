import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, mkdtemp, open, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { launch, create, snapshot, setFixture } from "./tool-test-support.mjs";
import { startExecutionFixture } from "../services/execution-fixtures/server.mjs";
import { packageUpdate } from "./update-package.mjs";

assert.equal(process.platform, "win32", "This sample checks actual Windows file write protection");
const exec = promisify(execFile);
const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/update-permission");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "permission-"));
const preview = resolve("artifacts/workpilot-p12-complete-2026-10-04/preview");
const binaries = {
  "workpilot-desktop.exe": resolve(
    process.env.WORKPILOT_DESKTOP_BINARY || join(preview, "workpilot-desktop.exe"),
  ),
  "workpilot-sidecar.exe": resolve(
    process.env.WORKPILOT_ENGINE_BINARY || join(preview, "workpilot-sidecar.exe"),
  ),
  "workpilot-update.exe": resolve(
    process.env.WORKPILOT_UPDATE_BINARY || join(preview, "workpilot-update.exe"),
  ),
};
process.env.WORKPILOT_ENGINE_BINARY = binaries["workpilot-sidecar.exe"];
const digest = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  state: "running",
  checks: [],
  scope:
    "Only a test-created update journal receives the reversible Windows ReadOnly file attribute. No ACL, global runtime, user project, or installed application is modified. This checks initial journal replacement denial, not every possible ACL or disk failure.",
  binarySha256s: {},
};
for (const [name, file] of Object.entries(binaries))
  report.binarySha256s[name] = await digest(file);
let modelCalls = 0;
const fixture = await startExecutionFixture(() => {
  modelCalls++;
  return { text: "Unexpected model call during an offline update", calls: [] };
});
setFixture(fixture);
const helper = binaries["workpilot-update.exe"];
const run = (args) =>
  exec(helper, args, { windowsHide: true, timeout: 180000, maxBuffer: 2 * 1024 ** 2 });
const attributeScript = join(directory, "journal-attribute.ps1");
await writeFile(
  attributeScript,
  `param([string]$OwnedRoot,[string]$Journal,[ValidateSet('inspect','readonly','restore')][string]$Mode)
$ErrorActionPreference='Stop'
$rootPath=[IO.Path]::GetFullPath($OwnedRoot)
$filePath=[IO.Path]::GetFullPath($Journal)
if($rootPath.StartsWith('\\\\?\\')) { $rootPath=$rootPath.Substring(4) }
if($filePath.StartsWith('\\\\?\\')) { $filePath=$filePath.Substring(4) }
$prefix=$rootPath.TrimEnd('\\')+'\\'
if(-not $filePath.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($filePath) -ne 'prepared.json') { throw 'Refusing an attribute change outside the owned test journal' }
$item=Get-Item -LiteralPath $filePath -Force
if($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'The journal must be a regular file' }
if($Mode -eq 'readonly') { $item.IsReadOnly=$true }
if($Mode -eq 'restore') { $item.IsReadOnly=$false }
$item.Refresh()
@{readOnly=[bool]$item.IsReadOnly;path=$item.FullName}|ConvertTo-Json -Compress
`,
);
let journal;
let currentEngine;
let attributesTouched = false;
async function attribute(mode) {
  const result = await exec(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      attributeScript,
      "-OwnedRoot",
      directory,
      "-Journal",
      journal,
      "-Mode",
      mode,
    ],
    { windowsHide: true, timeout: 15000 },
  );
  return JSON.parse(result.stdout);
}
try {
  const source = join(directory, "candidate"),
    install = join(directory, "original-program"),
    dataRoot = join(directory, "data");
  await mkdir(source);
  await mkdir(install);
  for (const [name, file] of Object.entries(binaries)) {
    await copyFile(file, join(source, name));
    await copyFile(file, join(install, name));
  }
  await writeFile(join(install, "original-marker.txt"), "Keep the complete original installation");
  const programBefore = {};
  for (const name of [...Object.keys(binaries), "original-marker.txt"])
    programBefore[name] = await digest(join(install, name));
  currentEngine = await launch(dataRoot);
  const task = await create(currentEngine, "responses", "permission-denial-must-not-run");
  const taskBefore = await snapshot(currentEngine, task);
  await currentEngine.close();
  currentEngine = null;
  const data = join(dataRoot, "test"),
    database = join(data, "workpilot.sqlite3");
  const databaseBefore = await digest(database);
  const packageFile = join(directory, "signed.wpupdate");
  const version = JSON.parse(await readFile("package.json", "utf8")).version;
  await packageUpdate({
    source,
    output: packageFile,
    privateKey: resolve(".local/update-signing/development-private.pem"),
    version,
    notes: "Isolated Windows journal write-protection check",
  });
  const request = join(directory, "prepare-input.json");
  const input = { install, data, source: packageFile, current_version: "0.1.0-alpha.12.14" };
  await writeFile(request, JSON.stringify(input));
  input.fingerprint = JSON.parse((await run(["--inspect", request])).stdout).fingerprint;
  await writeFile(request, JSON.stringify(input));
  const prepared = JSON.parse((await run(["--prepare", request])).stdout);
  journal = join(prepared.job, "prepared.json");
  const journalBefore = await digest(journal);
  assert.equal((await attribute("inspect")).readOnly, false);
  attributesTouched = true;
  assert.equal((await attribute("readonly")).readOnly, true);
  let denied;
  try {
    const handle = await open(journal, "r+");
    await handle.close();
  } catch (error) {
    denied = { code: error.code, errno: error.errno, syscall: error.syscall };
  }
  assert(
    denied && ["EACCES", "EPERM"].includes(denied.code),
    "Windows must actually deny write access to the test journal",
  );
  assert.equal(await digest(journal), journalBefore);
  let failure;
  try {
    await run(["--apply", journal, "--wait", "4294967294"]);
  } catch (error) {
    failure = { exitCode: error.code, stderr: error.stderr?.trim() };
  }
  assert.equal(failure?.exitCode, 1);
  assert.match(failure.stderr, /无法原子保存升级记录/);
  const result = JSON.parse(await readFile(join(prepared.job, "update-result.json"), "utf8"));
  assert.equal(result.state, "failed");
  assert.equal(await digest(journal), journalBefore);
  assert.equal(JSON.parse(await readFile(journal, "utf8")).phase, "prepared");
  for (const [name, expected] of Object.entries(programBefore))
    assert.equal(await digest(join(install, name)), expected);
  assert.equal(await digest(database), databaseBefore);
  await assert.rejects(stat(prepared.data_job), { code: "ENOENT" });
  assert.equal(modelCalls, 0);
  currentEngine = await launch(dataRoot);
  const reopened = await snapshot(currentEngine, task);
  assert.equal(reopened.task.id, taskBefore.task.id);
  assert.equal(reopened.task.state, taskBefore.task.state);
  assert.notEqual(reopened.task.state, "running");
  assert.equal(modelCalls, 0);
  await currentEngine.close();
  currentEngine = null;
  report.checks.push({
    name: "real_windows_journal_write_denial_preserves_original_program_and_database_without_starting_tasks",
    state: "passed",
  });
  report.denial = denied;
  report.updaterFailure = failure;
  report.originalProgramSha256 = programBefore;
  report.originalDatabaseSha256 = databaseBefore;
  report.taskState = reopened.task.state;
  report.modelCalls = modelCalls;
  report.dataMigrationStarted = false;
  report.state = "passed";
} catch (error) {
  report.state = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  if (currentEngine) await currentEngine.close().catch(() => {});
  if (attributesTouched) {
    try {
      report.attributeAfter = await attribute("restore");
      assert.equal(report.attributeAfter.readOnly, false);
    } catch (error) {
      report.state = "failed";
      report.restoreError = String(error.stack || error);
      process.exitCode = 1;
    }
  }
  await fixture.close();
  for (const [name, file] of Object.entries(binaries))
    assert.equal(await digest(file), report.binarySha256s[name]);
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
