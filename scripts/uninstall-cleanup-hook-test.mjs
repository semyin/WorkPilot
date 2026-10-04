import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { launch, create, until } from "./tool-test-support.mjs";
import { root } from "./cargo.mjs";

const exec = promisify(execFile);
const output = resolve(
  process.env.WORKPILOT_TEST_OUTPUT || ".test-results/uninstall-cleanup-hooks",
);
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "nsis-"));
const compiler = join(process.env.LOCALAPPDATA, "tauri/NSIS/makensis.exe");
const binary = resolve(
  process.env.WORKPILOT_ENGINE_BINARY || "target/p12-update/debug/workpilot-engine.exe",
);
process.env.WORKPILOT_ENGINE_BINARY = binary;
const hook = join(root, "resources/windows/browser-companion-hooks.nsh");
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  scope:
    "Actual production NSIS pre-uninstall hook, actual offline reset engine and isolated data; opt-in state supplied by test harness, native checkbox user experience remains separate",
  checks: [],
};
const hash = (b) => createHash("sha256").update(b).digest("hex");
try {
  for (const scenario of [
    "default-keeps",
    "opt-in-clears",
    "silent-keeps",
    "update-keeps",
    "busy-refuses",
  ]) {
    const folder = join(directory, scenario);
    await mkdir(folder);
    const app = join(folder, "安装目录"),
      data = join(folder, "data"),
      project = join(folder, "user-project.txt");
    await writeFile(project, "keep this project file");
    const sourceEngine = await launch(data);
    const task = await create(sourceEngine, "chat_completions", "uninstall-local-data");
    await sourceEngine.close();
    const database = join(data, "test/workpilot.sqlite3"),
      before = hash(await readFile(database));
    const setup = join(folder, "harness.exe"),
      nsi = join(folder, "harness.nsi");
    const selected = scenario === "default-keeps" ? 0 : 1;
    const text = `Unicode true
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall ${scenario === "silent-keeps" ? "silent" : "normal"}
AutoCloseWindow true
!include LogicLib.nsh
!include FileFunc.nsh
Var UpdateMode
Var PassiveMode
Var DeleteWorkPilotHistoryCheckboxState
!define WP_NATIVE_ROOT "Software\\WorkPilot\\CleanupHookTests\\${crypto.randomUUID()}"
!include "${hook}"
OutFile "${setup}"
Section
  SetOutPath "$INSTDIR"
  File /oname=workpilot-sidecar.exe "${binary}"
  FileOpen $0 "$INSTDIR\\keep-program.txt" w
  FileWrite $0 "application is intact"
  FileClose $0
  WriteUninstaller "$INSTDIR\\uninstall.exe"
SectionEnd
Section Uninstall
  StrCpy $DeleteWorkPilotHistoryCheckboxState ${selected}
  StrCpy $UpdateMode ${scenario === "update-keeps" ? 1 : 0}
  StrCpy $PassiveMode 0
  !insertmacro NSIS_HOOK_PREUNINSTALL
  Delete "$INSTDIR\\keep-program.txt"
  Delete "$INSTDIR\\workpilot-sidecar.exe"
  Delete "$INSTDIR\\uninstall.exe"
  !insertmacro NSIS_HOOK_POSTUNINSTALL
SectionEnd
`;
    await writeFile(nsi, text);
    await exec(compiler, ["/V2", nsi], { windowsHide: true, timeout: 60000 });
    await exec(setup, ["/S", "/D=" + app], { windowsHide: true, timeout: 30000 });
    const live = scenario === "busy-refuses" ? await launch(data) : null;
    const child = spawn(join(app, "uninstall.exe"), scenario === "silent-keeps" ? ["/S"] : [], {
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, WORKPILOT_CHANNEL: "test", WORKPILOT_DATA_DIR: data },
    });
    const done = once(child, "exit");
    if (scenario === "busy-refuses") {
      // Verify failure before closing only this temporary install's native dialog/processes.
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(await readFile(join(app, "keep-program.txt"), "utf8"), "application is intact");
      const cleanupScript = join(folder, "close-owned-test-uninstaller.ps1");
      const literal = app.replaceAll("'", "''");
      await writeFile(
        cleanupScript,
        "\ufeff$ErrorActionPreference='Stop'\n$owned='" +
          literal +
          "'\nGet-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($owned) -and ($_.Name -like 'Un*.exe' -or $_.Name -eq 'uninstall.exe') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }\n",
      );
      await exec(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", cleanupScript],
        { windowsHide: true, timeout: 15000 },
      );
      await done;
    } else await done;
    if (live) {
      const r = await live.request({ kind: "read", query: { kind: "execution", task_id: task } });
      assert.equal(r.kind, "execution");
      assert.equal(await readFile(join(app, "keep-program.txt"), "utf8"), "application is intact");
      await live.close();
    } else {
      await until(async () => {
        try {
          await readFile(join(app, "keep-program.txt"));
          return false;
        } catch {
          return true;
        }
      }, 30000);
      if (scenario === "opt-in-clears") {
        const restored = await launch(data);
        try {
          const r = await restored.request({
            kind: "read",
            query: { kind: "execution", task_id: task },
          });
          assert.equal(r.kind, "error");
        } finally {
          await restored.close();
        }
      } else assert.equal(hash(await readFile(database)), before);
    }
    assert.equal(await readFile(project, "utf8"), "keep this project file");
    const finalCleanup = join(folder, "close-finished-test-uninstaller.ps1");
    await writeFile(
      finalCleanup,
      "\ufeff$owned='" +
        app.replaceAll("'", "''") +
        "'\nGet-CimInstance Win32_Process | Where-Object { $_.Name -like 'Un*.exe' -and $_.CommandLine -and $_.CommandLine.Contains($owned) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }\n",
    );
    await exec(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", finalCleanup],
      { windowsHide: true, timeout: 15000 },
    );
    report.checks.push({ name: scenario, state: "passed" });
    console.log(scenario + ": passed");
  }
  report.state = "passed";
} catch (error) {
  report.state = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
}
await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
if (report.state !== "passed") throw Error(report.error);
