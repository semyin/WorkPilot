import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";

const execute = promisify(execFile);
export const root = resolve(".");
export const json = (value) => JSON.stringify(value, null, 2) + "\n";
export async function atomicJson(path, value) {
  const temporary = path + "." + crypto.randomUUID() + ".tmp";
  await writeFile(temporary, json(value));
  await rename(temporary, path);
}
export async function powershell(executable, args) {
  const { stdout } = await execute(executable, ["-NoProfile", ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
    timeout: 20000,
  });
  return JSON.parse(stdout.replace(/^\uFEFF/, ""));
}
export async function identify(executable, directory, pid, path) {
  const target = join(directory, `identify-${pid}.json`);
  await writeFile(target, json([{ pid, path }]));
  const entries = await powershell(executable, [
    "-File",
    join(root, "scripts/p13-process-identities.ps1"),
    "-Targets",
    target,
  ]);
  assert.equal(entries.length, 1);
  return entries[0];
}
export async function discover(executable, session) {
  return powershell(executable, [
    "-File",
    join(root, "scripts/p13-desktop-processes.ps1"),
    "-DesktopPid",
    String(session.child.pid),
    "-DesktopPath",
    session.binary,
    "-ProfilePath",
    join(session.data, "webview"),
  ]);
}
export async function bounded(value, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      value,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function ping(session) {
  const value = await bounded(
    session.page.evaluate(async (after) => {
      const request_id = crypto.randomUUID();
      const receipt = await window.__TAURI_INTERNALS__.invoke("engine_command", {
        request: { request_id, command: { kind: "ping" } },
      });
      const snapshot = await window.__TAURI_INTERNALS__.invoke("engine_snapshot", { after });
      return {
        receiptKind: receipt.kind,
        alive: snapshot.alive,
        nextAfter: snapshot.next_after,
        pong: snapshot.events.some((e) => e.kind === "pong" && e.request_id === request_id),
        ready: snapshot.events.find((e) => e.kind === "ready"),
      };
    }, session.after || 0),
    6000,
    `${session.label}: engine ping timed out`,
  );
  session.after = value.nextAfter;
  return value;
}
export async function normalExit(session) {
  const result = { at: new Date().toISOString(), label: session.label, pid: session.child.pid };
  if (session.child.exitCode === null && session.child.signalCode === null) {
    const exited = once(session.child, "exit");
    result.invoke = await bounded(
      session.page.evaluate(() => window.__TAURI_INTERNALS__.invoke("exit_app")),
      8000,
      "exit_app did not return",
    ).then(
      () => "resolved",
      (error) => String(error),
    );
    await bounded(exited, 8000, "Owned observer did not exit normally");
  } else result.alreadyExited = true;
  result.exitCode = session.child.exitCode;
  result.signalCode = session.child.signalCode;
  result.finishedAt = new Date().toISOString();
  await session.browser.close().catch(() => {});
  return result;
}
export function loggedChild(directory, label, program, args, environment = process.env) {
  const stdoutFile = join(directory, label + ".stdout.txt"),
    stderrFile = join(directory, label + ".stderr.txt");
  const stdout = createWriteStream(stdoutFile),
    stderr = createWriteStream(stderrFile);
  const child = spawn(program, args, {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: environment,
  });
  const startedAt = new Date().toISOString();
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  let text = "",
    truncated = false;
  child.stdout.on("data", (chunk) => {
    if (text.length + chunk.length <= 2 * 1024 * 1024) text += chunk.toString();
    else truncated = true;
  });
  const completed = new Promise((resolve) => {
    child.once("error", (error) =>
      resolve({
        label,
        pid: child.pid,
        startedAt,
        finishedAt: new Date().toISOString(),
        spawnError: String(error),
        stdoutFile,
        stderrFile,
      }),
    );
    child.once("close", (code, signal) =>
      resolve({
        label,
        pid: child.pid,
        startedAt,
        finishedAt: new Date().toISOString(),
        code,
        signal,
        stdout: text,
        stdoutTruncated: truncated,
        stdoutFile,
        stderrFile,
      }),
    );
  });
  return { child, completed };
}
