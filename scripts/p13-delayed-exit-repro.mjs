import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, appendFile, copyFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { launchDesktop } from "./p13-desktop-support.mjs";
import {
  root,
  json,
  atomicJson,
  powershell,
  identify,
  discover,
  bounded,
  ping,
  normalExit,
  loggedChild,
} from "./p13-delayed-exit-support.mjs";

const plan = {
  status: "prepared_not_run",
  command: "node scripts/p13-delayed-exit-repro.mjs --run",
  scope:
    "Two newly created P12/r3 observer instances; protected installation, original complete installation-desktop-smoke, at least 90 seconds after smoke exit, protected uninstall, then normal observer exits",
  installationScript: "scripts/p13-installation.ps1",
  smokeScript: "scripts/installation-desktop-smoke.mjs",
  processSamplingMs: 1000,
  enginePingMs: 5000,
  postSmokeObservationMs: 90000,
  productSourceChanges: false,
};
if (!process.argv.includes("--run")) {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}
assert.equal(process.platform, "win32");
const shell = process.env.WORKPILOT_TEST_POWERSHELL || "pwsh.exe";
const delivery = resolve("artifacts/workpilot-p13-candidate-2026-10-04-r3");
const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/p13-delayed-exit");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "run-"));
const report = {
  ...plan,
  status: "running",
  at: new Date().toISOString(),
  directory,
  testDriverPid: process.pid,
  stages: [],
  observers: [],
  issues: [],
  cleanup: [],
};
const reportPath = join(directory, "report.json");
const specificationPath = join(directory, "watch-specification.json");
const watchOutput = join(directory, "process-samples.jsonl");
const stopFile = join(directory, "watcher.stop");
const spec = {
  phase: "preparing",
  requireObserversAlive: true,
  observers: [],
  smokeRunner: null,
  installedDesktop: null,
};
const sessions = [];
const exitWrites = [];
let install,
  watcher,
  pingLoop,
  stopPings = false;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const save = () => atomicJson(reportPath, report);
const stage = async (name, details = {}) => {
  spec.phase = name;
  const entry = { name, at: new Date().toISOString(), ...details };
  report.stages.push(entry);
  await appendFile(join(directory, "stages.jsonl"), JSON.stringify(entry) + "\n");
  await atomicJson(specificationPath, spec);
  await save();
  console.log(JSON.stringify({ stage: name, at: entry.at }));
};
const pingAll = async (phase) => {
  for (const session of sessions) {
    const entry = {
      at: new Date().toISOString(),
      phase,
      label: session.label,
      pid: session.child.pid,
    };
    try {
      entry.reply = await ping(session);
      entry.healthy = entry.reply.alive && entry.reply.pong;
    } catch (error) {
      entry.healthy = false;
      entry.error = String(error);
    }
    await appendFile(join(directory, "engine-pings.jsonl"), JSON.stringify(entry) + "\n");
    if (!entry.healthy) report.issues.push({ kind: "observer_ping_failed", ...entry });
  }
};
const runLifecycle = async (action, extra) => {
  const run = loggedChild(directory, action.toLowerCase(), shell, [
    "-NoProfile",
    "-File",
    join(root, "scripts/p13-installation.ps1"),
    "-Action",
    action,
    ...extra,
  ]);
  await stage(action.toLowerCase() + "-started", { runnerPid: run.child.pid });
  const result = await run.completed;
  report.stages.push({
    name: action.toLowerCase() + "-process-ended",
    ...result,
    stdout: undefined,
  });
  await save();
  return result;
};
try {
  const installer = JSON.parse(await readFile(join(delivery, "installer-manifest.json"), "utf8"));
  assert.equal(installer.version, "0.1.0-alpha.13.4");
  const binary = join(delivery, "preview/workpilot-desktop.exe");
  const old = resolve("artifacts/workpilot-p12-complete-2026-10-04/preview/workpilot-desktop.exe");
  assert.equal(sha(await readFile(binary)), installer.packagedBuild.desktopSha256);
  report.binaryHashes = {
    r3: installer.packagedBuild.desktopSha256,
    p12: sha(await readFile(old)),
    installer: installer.sha256,
  };
  // This is read-only. The existing install script performs the authoritative
  // registration, shortcut, data-path and frozen-installer ownership checks.
  const preflight = await powershell(shell, [
    "-Command",
    "[pscustomobject]@{uninstallKey=(Test-Path -LiteralPath 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall/WorkPilot');productKey=(Test-Path -LiteralPath 'HKCU:/Software/workpilot/WorkPilot')}|ConvertTo-Json -Compress",
  ]);
  assert(
    !preflight.uninstallKey && !preflight.productKey,
    "An existing installation must be preserved",
  );
  for (const [label, path] of [
    ["p12-observer", old],
    ["r3-observer", binary],
  ]) {
    const data = join(directory, label),
      startedAt = new Date().toISOString();
    const session = await launchDesktop(path, data);
    Object.assign(session, { label, binary: path, data, after: 0 });
    sessions.push(session);
    session.child.on("exit", (code, signal) => {
      const event = {
        kind: "observer_desktop_exit",
        at: new Date().toISOString(),
        phase: spec.phase,
        label,
        pid: session.child.pid,
        code,
        signal,
      };
      exitWrites.push(
        appendFile(join(directory, "observer-exits.jsonl"), JSON.stringify(event) + "\n").catch(
          (error) => {
            report.issues.push({ kind: "exit_record_write_failed", error: String(error) });
          },
        ),
      );
    });
    session.identities = await discover(shell, session);
    await writeFile(join(directory, label + "-identities.json"), json(session.identities));
    const initial = await ping(session);
    assert(initial.alive && initial.pong);
    assert.equal(initial.ready.data_dir.toLowerCase(), join(data, "test").toLowerCase());
    const monitored = session.identities
      .filter((i) => ["desktop", "engine"].includes(i.role))
      .map((i) => ({ ...i, label, role: "observer-" + i.role }));
    assert.equal(monitored.length, 2);
    spec.observers.push(...monitored);
    report.observers.push({
      label,
      path,
      data,
      startedAt,
      desktopPid: session.child.pid,
      ready: initial.ready,
      identities: session.identities,
    });
  }
  await stage("observers-ready");
  watcher = loggedChild(directory, "watcher", shell, [
    "-NoProfile",
    "-File",
    join(root, "scripts/p13-delayed-exit-watch.ps1"),
    "-Specification",
    specificationPath,
    "-Output",
    watchOutput,
    "-StopFile",
    stopFile,
  ]);
  report.watcherPid = watcher.child.pid;
  pingLoop = (async () => {
    while (!stopPings) {
      await pingAll(spec.phase);
      if (!stopPings) await delay(5000);
    }
  })().catch((error) => report.issues.push({ kind: "ping_loop_error", error: String(error) }));
  await delay(1500);
  assert(
    (await readFile(watchOutput, "utf8")).includes('"kind":"sample"'),
    "Identity watcher must be running before installation",
  );
  const installation = await runLifecycle("Install", [
    "-Installer",
    join(delivery, installer.file),
  ]);
  assert.equal(installation.code, 0, "Protected install failed; preserve the full logs");
  assert(!installation.stdoutTruncated);
  const installOutput = JSON.parse(installation.stdout.replace(/^\uFEFF/, ""));
  const relativeInstall = relative(
    resolve(".test-results/p13-installation"),
    resolve(installOutput.session),
  );
  assert(relativeInstall && !relativeInstall.startsWith("..") && !isAbsolute(relativeInstall));
  // The original lifecycle script persists UTF-8 before emitting its terminal
  // receipt. A legacy console may replace Chinese path characters with '?'.
  // Read the authoritative owned receipt; never repair or guess a path string.
  const installReceipt = JSON.parse(
    await readFile(join(installOutput.session, "lifecycle.json"), "utf8"),
  );
  assert.equal(installReceipt.session, installOutput.session);
  assert.equal(installReceipt.version, installer.version);
  install = {
    session: installReceipt.session,
    installRoot: installReceipt.installRoot,
    status: installReceipt.status,
  };
  report.installationConsolePathMatchesReceipt = installOutput.installRoot === install.installRoot;
  assert.equal(resolve(install.session), resolve(install.installRoot, ".."));
  spec.installedDesktop = join(install.installRoot, "workpilot-desktop.exe");
  assert.equal(sha(await readFile(spec.installedDesktop)), installer.packagedBuild.desktopSha256);
  report.installation = install;
  await copyFile(
    join(install.session, "lifecycle.json"),
    join(directory, "installation-before-smoke.json"),
  );
  await stage("installed-before-smoke", { installRoot: install.installRoot });
  await pingAll("installed-before-smoke");
  const smokeOutput = join(directory, "installed-smoke");
  const smoke = loggedChild(
    directory,
    "installed-smoke",
    process.execPath,
    [join(root, "scripts/installation-desktop-smoke.mjs")],
    {
      ...process.env,
      WORKPILOT_DESKTOP_BINARY: spec.installedDesktop,
      WORKPILOT_TEST_OUTPUT: smokeOutput,
    },
  );
  spec.smokeRunner = await identify(shell, directory, smoke.child.pid, process.execPath);
  await stage("installed-smoke-running", { runner: spec.smokeRunner });
  const smokeResult = await smoke.completed;
  report.smokeProcess = { ...smokeResult, stdout: undefined };
  try {
    report.smoke = JSON.parse(await readFile(join(smokeOutput, "report.json"), "utf8"));
  } catch (error) {
    report.smoke = { status: "failed", error: "Smoke report unavailable: " + String(error) };
  }
  if (smokeResult.code !== 0 || report.smoke.status !== "passed")
    report.issues.push({
      kind: "original_installed_smoke_failed",
      code: smokeResult.code,
      report: join(smokeOutput, "report.json"),
    });
  const observationStarted = performance.now();
  await stage("post-smoke-observation-started", {
    minimumMilliseconds: 90000,
    smokeExitAt: smokeResult.finishedAt,
  });
  while (performance.now() - observationStarted < 90000) {
    await delay(Math.min(1000, 90000 - (performance.now() - observationStarted)));
  }
  report.postSmokeObservationMs = performance.now() - observationStarted;
  await stage("post-smoke-observation-ended", { observedMs: report.postSmokeObservationMs });
  await pingAll("before-uninstall");
  const uninstall = await runLifecycle("Uninstall", ["-Session", install.session]);
  report.uninstall = { ...uninstall, stdout: undefined };
  assert.equal(uninstall.code, 0, "Protected uninstall failed; ownership checks remain enabled");
  await copyFile(
    join(install.session, "lifecycle.json"),
    join(directory, "installation-after-uninstall.json"),
  );
  await stage("post-uninstall-observation");
  await pingAll("after-uninstall");
  await delay(5000);
  await pingAll("five-seconds-after-uninstall");
  report.status = report.issues.length ? "failed" : "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  stopPings = true;
  await pingLoop?.catch((error) =>
    report.issues.push({ kind: "ping_loop_error", error: String(error) }),
  );
  spec.requireObserversAlive = false;
  await stage("normal-observer-cleanup");
  for (const session of sessions) {
    try {
      const cleanup = await normalExit(session);
      cleanup.identities = await powershell(shell, [
        "-File",
        join(root, "scripts/p13-desktop-processes.ps1"),
        "-Operation",
        "verify",
        "-ExpectedFile",
        join(directory, session.label + "-identities.json"),
      ]);
      report.cleanup.push(cleanup);
      if (
        cleanup.exitCode !== 0 ||
        cleanup.identities.some((identity) => identity.status !== "exited")
      )
        report.status = "failed";
    } catch (error) {
      report.cleanup.push({ label: session.label, error: String(error), pid: session.child.pid });
      session.child.unref();
      report.status = "failed";
    }
  }
  await delay(1200);
  if (watcher) {
    await writeFile(stopFile, "stop only this watcher\n");
    report.watcherExit = await bounded(
      watcher.completed,
      5000,
      "Identity watcher did not stop",
    ).catch((error) => ({ error: String(error) }));
    if (report.watcherExit.code !== 0) report.status = "failed";
    const lines = (await readFile(watchOutput, "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map(JSON.parse);
    const samples = lines.filter((line) => line.kind === "sample");
    const unexpected = samples.filter((line) => line.requiredAlive && line.status !== "alive");
    report.unexpectedIdentitySamples = unexpected;
    report.watcherSummary = {
      samples: samples.length,
      ticks: lines.filter((line) => line.kind === "tick_finished").length,
      identities: lines
        .filter((line) => line.kind === "identity_discovered")
        .map((line) => line.identity),
      unexpected: unexpected.length,
    };
    if (unexpected.length) report.status = "failed";
  }
  if (install && !report.uninstall) {
    report.issues.push({
      kind: "owned_installation_may_need_review",
      session: install.session,
      note: "No blind retry or uninstaller invocation after a failed install/smoke stage. Use the preserved protected lifecycle entry to inspect ownership first.",
    });
    report.status = "failed";
  }
  report.finishedAt = new Date().toISOString();
  await Promise.all(exitWrites);
  if (report.issues.length) report.status = "failed";
  if (report.status !== "passed") process.exitCode = 1;
  await save();
  console.log(
    JSON.stringify(
      { status: report.status, report: reportPath, issues: report.issues.length },
      null,
      2,
    ),
  );
}
