import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startTeamFixture } from "../services/execution-fixtures/teams.mjs";
import { startFixtureServer } from "../services/fixtures/server.mjs";
import { saveProfile } from "./p13-engine-load.mjs";
import { machine } from "./p13-benchmark-metrics.mjs";
import { browserCycle, officeCycle, digest } from "./p13-soak-workbench.mjs";
import { launchKitEngine } from "./p13-acceptance-kit-engine.mjs";
import {
  verifyInstallation,
  verifyTools,
  verifyUnavailableModels,
} from "./p13-acceptance-kit-checks.mjs";
import { writeKitReport } from "./p13-acceptance-kit-report.mjs";
const option = (name) => {
  const i = process.argv.indexOf("--" + name);
  return i < 0 ? null : process.argv[i + 1];
};
assert(option("installation") && option("output"), "必须指定安装目录和全新结果目录");
const installation = resolve(option("installation")),
  output = resolve(option("output"));
const binary = join(installation, "workpilot-sidecar.exe");
const directory = join(output, "测试资料"),
  project = join(output, "测试项目");
await mkdir(directory, { recursive: true });
await mkdir(project, { recursive: true });
const report = {
  startedAt: new Date().toISOString(),
  selfTest: process.argv.includes("--self-test"),
  installation,
  output,
  checks: [],
  deliveries: [],
  engineExits: [],
  harness: { entry: import.meta.url, node: process.execPath, workingDirectory: process.cwd() },
};
const identity = async () =>
  Object.fromEntries(
    await Promise.all(
      [
        "workpilot-desktop.exe",
        "workpilot-sidecar.exe",
        "browser-runtime/node.exe",
        "runtime-catalog.json",
      ].map(async (file) => [file, digest(await readFile(join(installation, file)))]),
    ),
  );
const fixture = await startTeamFixture(),
  browserFixture = await startFixtureServer();
const engines = [];
let context;
const check = async (name, work) => {
  const began = performance.now();
  console.log("正在检查：" + name);
  try {
    const detail = await work();
    report.checks.push({ name, status: "passed", elapsedMs: performance.now() - began, detail });
    return detail;
  } catch (error) {
    report.checks.push({
      name,
      status: "failed",
      elapsedMs: performance.now() - began,
      error: String(error),
    });
    throw error;
  } finally {
    await writeFile(join(output, "progress.json"), JSON.stringify(report, null, 2));
  }
};
const reopen = async () => {
  const engine = await launchKitEngine(binary, directory);
  engines.push(engine);
  return engine;
};
const runFile = promisify(execFile);
const processIdentity = async (operation, rows) => {
  const path = join(output, `process-${operation}-${crypto.randomUUID()}.json`);
  await writeFile(path, JSON.stringify(rows));
  const result = await runFile(
    join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      resolve(import.meta.dirname, "p13-process-identities.ps1"),
      "-Targets",
      path,
      "-Operation",
      operation,
    ],
    { windowsHide: true, encoding: "utf8", timeout: 10000 },
  );
  return JSON.parse(result.stdout);
};
try {
  report.entryVerification = JSON.parse(
    (await readFile(join(output, "entry-verification.json"), "utf8")).replace(/^\uFEFF/, ""),
  );
  assert.equal(report.entryVerification.status, "passed");
  assert.equal(report.entryVerification.selfTest, report.selfTest);
  process.env.WORKPILOT_BROWSER_HEADLESS = "1";
  // This process and its children only; the OS/user PATH is never modified.
  process.env.PATH = join(process.env.SystemRoot, "System32");
  report.identity = await identity();
  report.machine = machine();
  context = {
    engine: await reopen(),
    fixture,
    browserFixture,
    directory,
    project,
    output,
    installation,
  };
  context.profiles = {
    leaf: await saveProfile(context.engine, fixture, "acceptance-local-leaf", {
      kind: "leaf",
      text: "Local acceptance reference 42",
    }),
  };
  await check("软件自带的 9 类组件完整性", () => verifyInstallation(context));
  await check("受限 Python、Node 和 Git 操作测试文件", () => verifyTools(context));
  await check("三种模型接口不可达时停止，并保留本地资料", () =>
    verifyUnavailableModels(context, reopen),
  );
  context.closeBrowser = async ({ workbench, session }) => {
    const observed = await processIdentity("identify", [
      {
        pid: session.owned_pid,
        path: join(installation, "chromium-runtime/chrome.exe"),
        notBeforeMs: Date.parse(report.startedAt),
      },
    ]);
    const state = await workbench.wb({
      kind: "browser_control",
      control: { kind: "disconnect", session_id: session.id },
    });
    const verification = await processIdentity("verify", observed);
    assert(verification.every((row) => ["exited", "pid_reused"].includes(row.status)));
    return { state, identities: observed, verification };
  };
  report.deliveries.push(
    await check("随包专用浏览器、真实下载和截图", () => browserCycle(context, 0)),
  );
  for (const [index, format] of ["docx", "xlsx", "pptx"].entries())
    report.deliveries.push(
      await check(`${format.toUpperCase()} 生成、读取与原版式预览`, () =>
        officeCycle(context, index, format),
      ),
    );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  for (const engine of engines) {
    try {
      report.engineExits.push(await engine.close());
    } catch (error) {
      report.status = "failed";
      report.shutdownError = String(error);
      process.exitCode = 1;
    }
  }
  await fixture.close();
  await browserFixture.close();
  try {
    report.finalIdentity = await identity();
    assert.deepEqual(report.finalIdentity, report.identity);
  } catch (error) {
    report.status = "failed";
    report.identityError = String(error);
    process.exitCode = 1;
  }
  report.endedAt = new Date().toISOString();
  report.scope =
    "Windows 自动检查；本机固定响应模型及不可达端点。没有修改系统 PATH、网络、电源或浏览器注册。未认定干净系统、物理换机、整机断网或完整桌面体验已验收。";
  await writeKitReport(output, report);
  console.log(`检查结束：${report.status}；结果：${join(output, "验收结果.html")}`);
}
