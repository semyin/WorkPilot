import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, readFile, writeFile, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { root } from "./cargo.mjs";
import { launch, create, snapshot } from "./tool-test-support.mjs";
import { packageUpdate } from "./update-package.mjs";

const exec = promisify(execFile);
const output = resolve(
  process.env.WORKPILOT_UPDATE_EVIDENCE || join(root, ".test-results/update-engine"),
);
await mkdir(output, { recursive: true });
const helper = resolve(
  process.env.WORKPILOT_UPDATE_BINARY || join(root, "target/p12-update/debug/workpilot-update.exe"),
);
const engineBinary = resolve(
  process.env.WORKPILOT_ENGINE_BINARY || join(root, "target/p12-update/debug/workpilot-engine.exe"),
);
process.env.WORKPILOT_ENGINE_BINARY = engineBinary;
const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
const oldVersion = "0.1.0-alpha.12.14";
const privateKey =
  process.env.WORKPILOT_UPDATE_SIGNING_KEY ||
  join(root, ".local/update-signing/development-private.pem");
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  boundary:
    "Isolated local directories, actual signed updater and actual engine; original running user app untouched",
  checks: [],
};
const hash = (b) => createHash("sha256").update(b).digest("hex");
let completed;
const base = await mkdtemp(join(output, "安装 与数据-"));
const source = join(base, "new-program");
await mkdir(source);
await copyFile(engineBinary, join(source, "workpilot-sidecar.exe"));
await copyFile(helper, join(source, "workpilot-update.exe"));
await writeFile(join(source, "update-notes.txt"), "signed release note");
await copyFile(
  process.env.WORKPILOT_DESKTOP_BINARY || helper,
  join(source, "workpilot-desktop.exe"),
);
report.desktop_launch_tested = false;
const updateFile = join(base, "valid.wpupdate");
await packageUpdate({
  source,
  output: updateFile,
  privateKey,
  version,
  notes: "P12 local signed update test",
});
async function run(args, executable = helper) {
  return exec(executable, args, { windowsHide: true, timeout: 200000, maxBuffer: 4 * 1024 ** 2 });
}
async function check(name, action) {
  const at = performance.now();
  await action();
  report.checks.push({ name, state: "passed", ms: performance.now() - at });
  console.log(name + ": passed");
}
async function fixture(name, packageFile = updateFile) {
  const folder = join(base, name);
  await mkdir(folder);
  const install = join(folder, "安装 空格");
  await mkdir(install);
  await writeFile(join(install, "original.txt"), "original installation");
  await writeFile(join(install, "uninstall.exe"), "retained local uninstall entry");
  const dataRoot = join(folder, "data");
  const engine = await launch(dataRoot);
  const task = await create(engine, "chat_completions", "retained conversation");
  await engine.close();
  const data = join(dataRoot, "test");
  const original = hash(await readFile(join(data, "workpilot.sqlite3")));
  const spec = join(folder, "prepare.json");
  const input = { install, data, source: packageFile, current_version: oldVersion };
  await writeFile(spec, JSON.stringify(input));
  const preview = JSON.parse((await run(["--inspect", spec])).stdout);
  input.fingerprint = preview.fingerprint;
  await writeFile(spec, JSON.stringify(input));
  return { folder, install, data, dataRoot, task, original, spec };
}
async function prepare(f) {
  return JSON.parse((await run(["--prepare", f.spec])).stdout);
}
async function unchanged(f) {
  assert.equal(await readFile(join(f.install, "original.txt"), "utf8"), "original installation");
  assert.equal(hash(await readFile(join(f.data, "workpilot.sqlite3"))), f.original);
}
try {
  await check("签名检查拒绝内容篡改和不安全地址，断网保留原数据", async () => {
    const f = await fixture("bad-signature");
    const bytes = await readFile(updateFile);
    const index = bytes.indexOf(Buffer.from("P12 local signed update test"));
    assert.ok(index > 0);
    bytes[index] ^= 1;
    const bad = join(f.folder, "bad.wpupdate");
    await writeFile(bad, bytes);
    for (const source of [bad, "http://127.0.0.1/update", "https://127.0.0.1:1/update"]) {
      await writeFile(
        f.spec,
        JSON.stringify({ install: f.install, data: f.data, source, current_version: oldVersion }),
      );
      await assert.rejects(run(["--inspect", f.spec]));
    }
    await unchanged(f);
  });
  await check("下载截断与文件损坏在准备阶段拒绝", async () => {
    const f = await fixture("truncated");
    const bytes = await readFile(updateFile);
    const broken = join(f.folder, "short.wpupdate");
    await writeFile(broken, bytes.subarray(0, bytes.length - 3));
    const input = JSON.parse(await readFile(f.spec, "utf8"));
    input.source = broken;
    await writeFile(f.spec, JSON.stringify(input));
    await assert.rejects(prepare(f));
    await unchanged(f);
  });
  await check("运行中的数据锁阻止安装，不擅自关闭其它实例", async () => {
    const f = await fixture("active-engine"),
      prepared = await prepare(f),
      engine = await launch(f.dataRoot);
    try {
      await assert.rejects(
        run(["--apply", join(prepared.job, "prepared.json"), "--wait", "4294967294"]),
      );
      const reply = await snapshot(engine, f.task);
      assert.equal(reply.task.id, f.task);
    } finally {
      await engine.close();
    }
    assert.equal(await readFile(join(f.install, "original.txt"), "utf8"), "original installation");
  });
  await check("真实新版数据版本不匹配时保留原程序与原数据", async () => {
    const invalid = join(base, "incompatible.wpupdate");
    await packageUpdate({
      source,
      output: invalid,
      privateKey,
      version,
      databaseTarget: 12,
      notes: "Deliberately incompatible data target",
    });
    const f = await fixture("migration-failure", invalid),
      prepared = await prepare(f);
    await assert.rejects(
      run(["--apply", join(prepared.job, "prepared.json"), "--wait", "4294967294"]),
      /新版实际数据版本与签名清单不一致/,
    );
    await unchanged(f);
    const result = JSON.parse(await readFile(join(prepared.job, "update-result.json"), "utf8"));
    assert.equal(result.state, "failed");
  });
  await check("真实签名助手成功切换安装与数据，保存旧副本且禁止重放", async () => {
    const f = await fixture("successful"),
      prepared = await prepare(f);
    await run(["--apply", join(prepared.job, "prepared.json"), "--wait", "4294967294"]);
    const result = JSON.parse(await readFile(join(prepared.job, "update-result.json"), "utf8"));
    assert.equal(result.state, "committed");
    assert.equal(
      hash(await readFile(join(f.install, "workpilot-sidecar.exe"))),
      hash(await readFile(engineBinary)),
    );
    assert.equal(hash(await readFile(join(result.previous_data, "workpilot.sqlite3"))), f.original);
    assert.equal(
      await readFile(join(result.previous_install, "original.txt"), "utf8"),
      "original installation",
    );
    const resumed = await launch(f.dataRoot);
    try {
      const current = await snapshot(resumed, f.task);
      assert.equal(current.task.id, f.task);
      assert.notEqual(current.task.state, "running");
    } finally {
      await resumed.close();
    }
    const after = hash(await readFile(join(f.data, "workpilot.sqlite3")));
    await assert.rejects(
      run(["--apply", join(prepared.job, "prepared.json"), "--wait", "4294967294"]),
    );
    assert.equal(hash(await readFile(join(f.data, "workpilot.sqlite3"))), after);
    assert.equal(
      await readFile(join(f.install, "uninstall.exe"), "utf8"),
      "retained local uninstall entry",
    );
    completed = f;
  });
  await check("更新卸载按签名清单清理，保留额外文件、修改后的内容和本机卸载入口", async () => {
    const f = completed;
    await writeFile(join(f.install, "user-created.txt"), "user file remains");
    await writeFile(join(f.install, "update-notes.txt"), "user edited release note");
    await run(["--uninstall-updated", f.install], join(f.install, "workpilot-update.exe"));
    await assert.rejects(readFile(join(f.install, "workpilot-sidecar.exe")), /ENOENT/);
    await assert.rejects(readFile(join(f.install, "workpilot-desktop.exe")), /ENOENT/);
    assert.equal(await readFile(join(f.install, "user-created.txt"), "utf8"), "user file remains");
    assert.equal(
      await readFile(join(f.install, "update-notes.txt"), "utf8"),
      "user edited release note",
    );
    assert.equal(
      await readFile(join(f.install, "uninstall.exe"), "utf8"),
      "retained local uninstall entry",
    );
  });
  report.state = "passed";
} catch (error) {
  report.state = "failed";
  report.error = String(error);
  process.exitCode = 1;
}
await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
if (report.state !== "passed") throw new Error(report.error);
