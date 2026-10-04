import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { launchDesktop } from "./p13-desktop-support.mjs";

const runFile = promisify(execFile);
const root = resolve(".");
const output = resolve(
  process.env.WORKPILOT_TEST_OUTPUT || ".test-results/p13-multi-instance-exit",
);
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "run-"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const expectedR3 = "69e67169b755925c389b0e618b9b69ccf80494e713af01ef247ffd06f227c41d";
const powershell = async (args) => {
  if (args[0] === "-Command")
    args = [args[0], "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " + args[1]];
  const { stdout } = await runFile("powershell.exe", ["-NoProfile", ...args], {
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 20000,
  });
  return JSON.parse(stdout.replace(/^\uFEFF/, ""));
};
const installed = await powershell([
  "-Command",
  "$r=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WorkPilot'; [pscustomobject]@{path=(Join-Path $r.InstallLocation.Trim('\"') 'workpilot-desktop.exe');version=$r.DisplayVersion}|ConvertTo-Json -Compress",
]);
const binaries = {
  r3Portable: resolve(
    "artifacts/workpilot-p13-candidate-2026-10-04-r3/preview/workpilot-desktop.exe",
  ),
  r3Installed: installed.path,
  p12Portable: resolve("artifacts/workpilot-p12-complete-2026-10-04/preview/workpilot-desktop.exe"),
};
const binaryHashes = Object.fromEntries(
  await Promise.all(
    Object.entries(binaries).map(async ([key, path]) => [key, sha256(await readFile(path))]),
  ),
);
assert.equal(binaryHashes.r3Portable, expectedR3);
assert.equal(binaryHashes.r3Installed, expectedR3);
const report = {
  at: new Date().toISOString(),
  directory,
  binaries,
  binaryHashes,
  scope:
    "New isolated desktop/data/WebView profiles only. No installer, uninstall, model service, user-instance restart, process-name kill, or product source changes.",
  testDriverPid: process.pid,
  cases: [],
};
const write = (name, value) =>
  writeFile(join(directory, name), JSON.stringify(value, null, 2) + "\n");
const identityFile = (session) => join(directory, session.label + "-identities.json");
const discover = (session) =>
  powershell([
    "-File",
    join(root, "scripts/p13-desktop-processes.ps1"),
    "-DesktopPid",
    String(session.child.pid),
    "-DesktopPath",
    session.binary,
    "-ProfilePath",
    join(session.data, "webview"),
  ]);
const verify = (session) =>
  powershell([
    "-File",
    join(root, "scripts/p13-desktop-processes.ps1"),
    "-Operation",
    "verify",
    "-ExpectedFile",
    identityFile(session),
  ]);
const bounded = async (promise, ms, text) => {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(text)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
};
const ping = async (session) =>
  bounded(
    session.page.evaluate(async () => {
      const request_id = crypto.randomUUID();
      const receipt = await window.__TAURI_INTERNALS__.invoke("engine_command", {
        request: { request_id, command: { kind: "ping" } },
      });
      const snapshot = await window.__TAURI_INTERNALS__.invoke("engine_snapshot", { after: 0 });
      return {
        receiptKind: receipt.kind,
        alive: snapshot.alive,
        pong: snapshot.events.some(
          (event) => event.kind === "pong" && event.request_id === request_id,
        ),
        ready: snapshot.events.find((event) => event.kind === "ready"),
      };
    }),
    5000,
    `${session.label}: ping did not complete`,
  );
const sessions = [];
async function launch(label, binary) {
  const data = join(directory, label);
  const startedAt = new Date().toISOString();
  const session = await launchDesktop(binary, data);
  Object.assign(session, { label, binary, data, startedAt });
  sessions.push(session);
  session.exitEvents = [];
  session.child.on("exit", (code, signal) =>
    session.exitEvents.push({ at: new Date().toISOString(), code, signal }),
  );
  session.identities = await discover(session);
  assert(
    session.identities.some((item) => item.pid === session.child.pid && item.role === "desktop"),
  );
  assert(session.identities.some((item) => item.role === "engine"));
  await write(label + "-identities.json", session.identities);
  const reply = await ping(session);
  assert(reply.alive && reply.pong);
  session.ready = reply.ready;
  assert.equal(reply.ready.data_dir.toLowerCase(), join(data, "test").toLowerCase());
  return session;
}
async function observe(session, stage) {
  const observation = {
    stage,
    at: new Date().toISOString(),
    label: session.label,
    desktopPid: session.child.pid,
    exitCode: session.child.exitCode,
    signalCode: session.child.signalCode,
    identities: await verify(session),
  };
  try {
    observation.ping = await ping(session);
  } catch (error) {
    observation.pingError = String(error);
  }
  observation.healthy =
    observation.identities
      .filter((item, index) => ["desktop", "engine"].includes(session.identities[index].role))
      .every((item) => item.status === "alive") &&
    observation.ping?.alive &&
    observation.ping?.pong;
  return observation;
}
async function exitApp(session) {
  if (session.child.exitCode !== null || session.child.signalCode !== null)
    return { at: new Date().toISOString(), alreadyExited: true, exitCode: session.child.exitCode };
  const result = {
    at: new Date().toISOString(),
    kind: "exit_app",
    label: session.label,
    pid: session.child.pid,
  };
  const exited = once(session.child, "exit");
  // Deliberately do not close the CDP client until survivor checks have finished.
  result.invoke = await bounded(
    session.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("exit_app")),
    8000,
    "exit_app response timed out",
  ).then(
    () => "resolved",
    (error) => String(error),
  );
  await bounded(exited, 8000, "Own desktop did not exit after exit_app");
  result.finishedAt = new Date().toISOString();
  result.exitCode = session.child.exitCode;
  result.signalCode = session.child.signalCode;
  return result;
}
async function runCase(name, definitions, targetIndex = 0) {
  const result = { name, at: new Date().toISOString(), instances: [], observations: [] };
  report.cases.push(result);
  const own = [];
  try {
    for (const [label, key] of definitions) {
      const session = await launch(name + "-" + label, binaries[key]);
      own.push(session);
      result.instances.push({
        label: session.label,
        binary: key,
        path: session.binary,
        data: session.data,
        pid: session.child.pid,
        startedAt: session.startedAt,
        ready: session.ready,
        identities: session.identities,
      });
    }
    for (const session of own) {
      const state = await observe(session, "before-exit");
      result.observations.push(state);
      assert(state.healthy, "All exact instances must be healthy before exit");
    }
    const target = own[targetIndex],
      survivors = own.filter((session) => session !== target);
    result.exitAction = await exitApp(target);
    await delay(500);
    result.targetAfterExit = await verify(target);
    for (const session of survivors) {
      const state = await observe(session, "after-exit-app-before-cdp-close");
      result.observations.push(state);
      assert(state.healthy, `Exiting ${target.label} also affected ${session.label}`);
    }
    await target.browser.close().catch(() => {});
    await delay(300);
    for (const session of survivors) {
      const state = await observe(session, "after-target-cdp-close");
      result.observations.push(state);
      assert(state.healthy, `Closing CDP for ${target.label} also affected ${session.label}`);
    }
    result.status = "passed";
  } catch (error) {
    result.status = "failed";
    result.error = String(error.stack || error);
    process.exitCode = 1;
  } finally {
    result.cleanup = [];
    for (const session of own) {
      const cleanup = { label: session.label };
      try {
        cleanup.exit = await exitApp(session);
      } catch (error) {
        cleanup.error = String(error);
        result.status = "failed";
        process.exitCode = 1;
      }
      await session.browser.close().catch(() => {});
      cleanup.identities = await verify(session).catch((error) => ({ error: String(error) }));
      cleanup.exitEvents = session.exitEvents;
      result.cleanup.push(cleanup);
    }
    result.finishedAt = new Date().toISOString();
    await write(name + ".json", result);
    await write("report.json", report);
    console.log(
      JSON.stringify({
        case: name,
        status: result.status,
        error: result.error || null,
        pids: result.instances.map((item) => item.pid),
      }),
    );
  }
}
await runCase("portable-pair", [
  ["exit", "r3Portable"],
  ["survive", "r3Portable"],
]);
await runCase("installed-exits", [
  ["exit", "r3Installed"],
  ["survive", "r3Portable"],
]);
await runCase("portable-exits", [
  ["exit", "r3Portable"],
  ["survive", "r3Installed"],
]);
await runCase("three-generations", [
  ["exit", "r3Installed"],
  ["survive-r3", "r3Portable"],
  ["survive-p12", "p12Portable"],
]);
report.status = report.cases.every((item) => item.status === "passed") ? "passed" : "failed";
report.finishedAt = new Date().toISOString();
report.ownedProcesses = sessions.map((session) => ({
  label: session.label,
  pid: session.child.pid,
  exitCode: session.child.exitCode,
  signalCode: session.child.signalCode,
  exitEvents: session.exitEvents,
}));
await write("report.json", report);
console.log(
  JSON.stringify(
    {
      status: report.status,
      cases: report.cases.length,
      directory,
      report: join(directory, "report.json"),
    },
    null,
    2,
  ),
);
