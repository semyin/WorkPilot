import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { root } from "./cargo.mjs";
import { launch, create, start, terminal, snapshot, setFixture } from "./tool-test-support.mjs";
import { startExecutionFixture } from "../services/execution-fixtures/server.mjs";

const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/offline-environment");
await mkdir(output, { recursive: true });
const binary = resolve(
  process.env.WORKPILOT_ENGINE_BINARY ||
    join(root, "artifacts/workpilot-p12-complete-2026-10-04/preview/workpilot-sidecar.exe"),
);
process.env.WORKPILOT_ENGINE_BINARY = binary;
const directory = await mkdtemp(join(output, "data-"));
const project = await mkdtemp(join(output, "本地资料-"));
const note = "已有本地资料：模型服务不可用时仍能读取。";
await writeFile(join(project, "本地记录.txt"), note);
const available = await startExecutionFixture();
const portReservation = createServer().listen(0, "127.0.0.1");
await once(portReservation, "listening");
const unreachable = `http://127.0.0.1:${portReservation.address().port}`;
await new Promise((done) => portReservation.close(done));
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  binarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  environment:
    "Configured model endpoints use a closed local TCP port. Another local provider remains reachable to detect fallback. This does not disconnect Windows networking or verify a clean OS.",
  failures: [],
  checks: [],
};
let engine;
async function savedContent(reference) {
  const reply = await engine.request({
    kind: "read",
    query: { kind: "content", object_id: reference.object_id, offset: 0, limit: 65536 },
  });
  assert.equal(reply.kind, "content", JSON.stringify(reply));
  return reply.page.text;
}
try {
  setFixture(available);
  engine = await launch(directory);
  const existing = await create(engine, "responses", "offline-existing-local-history");
  const configured = await engine.request({
    kind: "configure_task_tools",
    task_id: existing,
    settings: {
      root_path: project,
      permission: "request_approval",
      commands_enabled: false,
      review_profile_id: null,
      revision: 0,
    },
  });
  assert.equal(configured.kind, "receipt");
  await start(engine, existing);
  const completed = await terminal(engine, existing);
  assert.equal(completed.task.state, "completed", JSON.stringify(completed.latest_run));
  const reference = completed.steps.findLast((step) => step.output)?.output;
  assert(reference);
  const saved = await savedContent(reference);
  assert(saved.includes("样本任务完成"));
  const availableRequests = available.records.length;
  setFixture({ url: unreachable });
  const failedTasks = [];
  for (const protocol of ["chat_completions", "responses", "messages"]) {
    const task = await create(engine, protocol, "unreachable-" + protocol);
    const before = await snapshot(engine, task);
    await start(engine, task);
    const failed = await terminal(engine, task);
    assert.equal(failed.task.state, "failed", JSON.stringify(failed.latest_run));
    assert.equal(failed.latest_run.diagnostic.code, "network");
    assert.match(failed.latest_run.diagnostic.message_zh, /无法连接模型服务/);
    assert(failed.latest_run.diagnostic.message_en.length > 0);
    assert.equal(failed.latest_run.profile.id, before.config.profile_id);
    assert.equal(failed.latest_run.profile.protocol, protocol);
    assert.equal(failed.latest_run.profile.base_url.replace(/\/$/, ""), unreachable);
    assert.equal(failed.steps.filter((step) => step.kind === "model").length, 1);
    assert.equal(failed.steps.filter((step) => step.kind === "tool").length, 0);
    failedTasks.push({ task, run: failed.latest_run.run.id });
    report.failures.push({ protocol, code: failed.latest_run.diagnostic.code });
    report.checks.push(protocol + "_unreachable_endpoint_stops_once_with_explicit_network_error");
  }
  await delay(300);
  assert.equal(available.records.length, availableRequests, "Must not switch to another provider");
  await engine.close();
  engine = await launch(directory);
  for (const { task, run } of failedTasks) {
    const retained = await snapshot(engine, task);
    assert.equal(retained.task.state, "failed");
    assert.equal(retained.latest_run.run.id, run);
    assert.equal(retained.steps.filter((step) => step.kind === "model").length, 1);
  }
  const restored = await snapshot(engine, existing);
  assert.equal(restored.task.state, "completed");
  assert.equal(await savedContent(reference), saved);
  const file = await engine.request({
    kind: "workbench",
    task_id: existing,
    action: { kind: "read_file", path: "本地记录.txt" },
  });
  assert.equal(file.kind, "workbench", JSON.stringify(file));
  assert.equal(file.data.text, note);
  const tasks = await engine.request({
    kind: "read",
    query: { kind: "tasks", before: null, limit: 20 },
  });
  assert.equal(tasks.kind, "tasks");
  assert.equal(available.records.length, availableRequests);
  report.checks.push(
    "restart_reads_existing_history_and_project_file_without_retry_or_provider_fallback",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  await engine?.close().catch(() => {});
  await available.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
