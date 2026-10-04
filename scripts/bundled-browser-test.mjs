import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { root } from "./cargo.mjs";
import { until } from "./tool-test-support.mjs";

const bundle = resolve(
  process.env.WORKPILOT_BROWSER_BUNDLE ||
    join(root, "artifacts/workpilot-p12-complete-2026-10-04/preview"),
);
const output = resolve(
  process.env.WORKPILOT_TEST_OUTPUT || join(root, ".test-results/bundled-browser"),
);
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "browser-"));
const task = crypto.randomUUID();
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><html><head><title>Bundled browser fixture</title></head><body>
    <label>Name<input aria-label="Name"></label><button id="save">Save</button><p id="result"></p>
    <script>result.textContent=localStorage.getItem('saved')||'Nothing saved';
    save.onclick=()=>{const value=document.querySelector('input').value;localStorage.setItem('saved',value);result.textContent=value;};</script>
    </body></html>`);
}).listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}/`;
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  environment:
    "Windows developer machine; bundled Node/browser only; personal browser locations replaced by empty test directories, PATH System32 only. Not a clean OS.",
  browserSha256: createHash("sha256")
    .update(await readFile(join(bundle, "chromium-runtime/chrome.exe")))
    .digest("hex"),
  checks: [],
};
let worker;
function start() {
  const process = spawn(
    join(bundle, "browser-runtime/node.exe"),
    [join(bundle, "browser-runtime/services/browser/driver.mjs")],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        SystemRoot: globalThis.process.env.SystemRoot,
        WINDIR: globalThis.process.env.SystemRoot,
        PATH: join(globalThis.process.env.SystemRoot, "System32"),
        PROGRAMFILES: directory,
        "PROGRAMFILES(X86)": directory,
        LOCALAPPDATA: directory,
        TEMP: directory,
        TMP: directory,
      },
    },
  );
  const pending = new Map();
  const lines = createInterface({ input: process.stdout });
  lines.on("line", (line) => {
    const value = JSON.parse(line),
      p = pending.get(value.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(value.id);
    value.error ? p.reject(Error(value.error)) : p.resolve(value.result);
  });
  const request = (message) =>
    new Promise((resolve, reject) => {
      const id = crypto.randomUUID(),
        timer = setTimeout(() => {
          pending.delete(id);
          reject(Error("Browser reply timed out"));
        }, 25000);
      pending.set(id, { resolve, reject, timer });
      process.stdin.write(JSON.stringify({ id, ...message }) + "\n");
    });
  return {
    process,
    request,
    close: async () => {
      if (process.exitCode === null) {
        const exited = once(process, "exit");
        await request({ kind: "shutdown" });
        await exited;
      }
      lines.close();
    },
  };
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function initialize(location = bundle) {
  worker = start();
  await worker.request({
    kind: "init",
    data: directory,
    installation_root: location,
    headless: true,
  });
}
async function connect() {
  const session = await worker.request({
    kind: "control",
    task,
    control: { kind: "start", channel: "chromium" },
  });
  assert.equal(session.channel, "chromium");
  assert.equal(session.state, "connected");
  const call = (action, owner = task) =>
    worker.request({
      kind: "perform",
      task: owner,
      action: { session_id: session.id, tab_id: session.tabs[0].id, ...action },
    });
  const snapshot = () => call({ kind: "snapshot", query: null });
  const first = await snapshot();
  await call({ kind: "navigate", document: first.document, url });
  const page = await until(async () => {
    try {
      const p = await snapshot();
      return p.frames.some((f) => f.title === "Bundled browser fixture") && p;
    } catch {
      return false;
    }
  }, 20000);
  return { session, call, snapshot, page };
}
try {
  await initialize();
  let current = await connect();
  const executable = execFileSync(
    join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "(Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:WORKPILOT_BROWSER_PID)).ExecutablePath",
    ],
    {
      windowsHide: true,
      encoding: "utf8",
      env: { ...process.env, WORKPILOT_BROWSER_PID: String(current.session.owned_pid) },
    },
  ).trim();
  assert.equal(
    resolve(executable).toLowerCase(),
    join(bundle, "chromium-runtime/chrome.exe").toLowerCase(),
  );
  report.version = current.session.version;
  report.checks.push(
    "actual_browser_process_comes_from_verified_bundle_without_personal_browser_locations_or_developer_path",
  );
  await assert.rejects(
    current.call({ kind: "snapshot", query: null }, "another-task"),
    /does not belong/,
  );
  await assert.rejects(
    worker.request({ kind: "control", task, control: { kind: "pair", channel: "chromium" } }),
    /Unsupported browser/,
  );
  const element = (page, tag) =>
    page.frames.flatMap((frame) => frame.elements || []).find((item) => item.tag === tag);
  await current.call({
    kind: "fill",
    document: current.page.document,
    reference: element(current.page, "input").reference,
    text: "独立浏览器保存成功",
  });
  const fresh = await current.snapshot();
  await current.call({
    kind: "click",
    document: fresh.document,
    reference: element(fresh, "button").reference,
  });
  assert(JSON.stringify(await current.snapshot()).includes("独立浏览器保存成功"));
  report.checks.push("read_fill_click_use_existing_document_guards_and_task_ownership");
  const firstPid = current.session.owned_pid;
  await worker.close();
  worker = null;
  await until(async () => !alive(firstPid));
  await initialize();
  current = await connect();
  assert(JSON.stringify(current.page).includes("独立浏览器保存成功"));
  await worker.request({ kind: "cancel_all" });
  await until(async () => !alive(current.session.owned_pid));
  await worker.close();
  worker = null;
  report.checks.push(
    "dedicated_profile_persists_after_restart_and_shutdown_or_cancel_ends_owned_browser",
  );
  const missing = await mkdtemp(join(directory, "missing-bundle-"));
  await initialize(missing);
  await assert.rejects(
    worker.request({ kind: "control", task, control: { kind: "start", channel: "chromium" } }),
    /repair installation/,
  );
  report.checks.push("missing_bundled_browser_fails_without_personal_browser_fallback");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  await worker?.close().catch(() => worker.process.kill());
  await new Promise((resolve) => server.close(resolve));
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
