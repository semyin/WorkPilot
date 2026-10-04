// Explicit manual acceptance against the user's configured image service.
// A one-use JSON setup comes through stdin; credentials are never report fields.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { launch, create, until } from "./tool-test-support.mjs";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const setup = JSON.parse(input);
input = "";
assert.equal(new URL(setup.origin).protocol, "https:");
const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/p13-real-images");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "session-"));
const project = join(directory, "project");
await mkdir(project);
const binary = resolve(process.env.WORKPILOT_ENGINE_BINARY || "target/debug/workpilot-engine.exe");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = {
  at: new Date().toISOString(),
  directory,
  synthetic: false,
  service: "User-provided Alibaba Cloud workspace",
  origin: setup.origin,
  protocol: "aliyun_images",
  model: setup.model || "qwen-image-3.0",
  binarySha256: hash(await readFile(binary)),
  images: [],
  checks: [],
};
let engine, service;
const sanitize = (value) =>
  String(value)
    .replaceAll(setup.key || "NO_SECRET", "[REDACTED]")
    .replace(/https?:\/\/[^\s"<>]+\?[^\s"<>]+/g, "[signed URL omitted]");
try {
  engine = await launch(directory);
  const task = await create(engine, "responses", "manual-real-image-acceptance");
  report.taskId = task;
  assert.equal(
    (
      await engine.request({
        kind: "configure_task_tools",
        task_id: task,
        settings: {
          root_path: project,
          permission: "request_approval",
          commands_enabled: false,
          review_profile_id: null,
          revision: 0,
        },
      })
    ).kind,
    "receipt",
  );
  const admin = async (action) => {
    const r = await engine.request({ kind: "media", task_id: task, action });
    assert.equal(r.kind, "workbench", sanitize(JSON.stringify(r)));
    return r.data;
  };
  const work = async (action) => {
    const r = await engine.request({ kind: "workbench", task_id: task, action });
    assert.equal(r.kind, "workbench", sanitize(JSON.stringify(r)));
    return r.data;
  };
  service = (
    await admin({
      kind: "save_image_service",
      service: {
        id: crypto.randomUUID(),
        label: "P13 real image acceptance",
        base_url: setup.origin + "/compatible-mode/v1",
        model: report.model,
        revision: 0,
        credential: null,
        supports_edit: true,
        sizes: ["1024x1024"],
        qualities: [],
        formats: ["png"],
        max_count: 1,
        request_base64: false,
        auth_required: true,
        protocol: "aliyun_images",
      },
      secret: setup.key,
    })
  ).service;
  const generate = async (name, prompt, references = []) => {
    const prepared = await work({
      kind: "media",
      effect: {
        kind: "generate_image",
        request: {
          service_id: service.id,
          service_revision: service.revision,
          prompt,
          size: "1024x1024",
          quality: null,
          format: "png",
          count: 1,
          references,
          paths: [name],
          expected: [{ exists: false, sha256: null, bytes: 0, identity: null }],
        },
      },
    });
    assert.equal(prepared.operation.state, "awaiting_approval");
    const start = performance.now();
    await work({
      kind: "approve",
      operation_id: prepared.operation.id,
      fingerprint: prepared.operation.fingerprint,
    });
    console.log(JSON.stringify({ stage: "real-image-request-started", name, model: report.model }));
    const operation = await until(async () => {
      const { operation: op } = await work({
        kind: "operation",
        operation_id: prepared.operation.id,
      });
      return ["completed", "failed", "cancelled"].includes(op.state) && op;
    }, 650000);
    assert.equal(operation.state, "completed", sanitize(JSON.stringify(operation)));
    const asset = (await admin({ kind: "list" })).assets.find((a) => a.name === name);
    assert(asset, "Generated image is a registered asset");
    const bytes = await readFile(join(project, name));
    assert.equal(bytes.subarray(1, 4).toString(), "PNG");
    assert.equal(bytes.readUInt32BE(16), 1024);
    assert.equal(bytes.readUInt32BE(20), 1024);
    report.images.push({
      name,
      file: join(project, name),
      sha256: hash(bytes),
      bytes: bytes.length,
      dimensions: [1024, 1024],
      elapsedMs: Math.round(performance.now() - start),
      operationId: operation.id,
      assetId: asset.id,
      referenceAssetIds: references,
      prompt,
    });
    await writeFile(join(directory, "progress.json"), sanitize(JSON.stringify(report, null, 2)));
    return { asset, bytes };
  };
  const first = await generate(
    "blue-cup.png",
    "一张清晰的简洁产品照片：一只纯蓝色陶瓷马克杯，杯把在右侧，放在浅木色桌面上，背景纯白，柔和自然光。只有一只杯子，没有文字、人物或商标，正方形构图。",
  );
  report.checks.push("real_generation_after_approval_produces_decodable_1024px_png_asset");
  const second = await generate(
    "green-cup.png",
    "编辑参考图：仅把蓝色马克杯的杯身和把手改为鲜明的绿色，保持杯子形状、右侧把手、位置、浅木色桌面、白色背景和光照不变，不增加文字或其它物体。",
    [first.asset.id],
  );
  assert.notEqual(hash(first.bytes), hash(second.bytes));
  assert.equal(hash(await readFile(join(project, "blue-cup.png"))), hash(first.bytes));
  report.checks.push("real_reference_edit_new_file_preserves_original_and_has_distinct_bytes");
  report.visualReview =
    "Pending separate human/agent image inspection; file checks alone do not prove prompt quality";
  report.status = "passed_file_checks";
} catch (error) {
  report.status = "failed";
  report.error = sanitize(error.stack || error);
  process.exitCode = 1;
} finally {
  if (engine && service) {
    try {
      const removed = await engine.request({
        kind: "media",
        task_id: null,
        action: { kind: "remove_image_service", service_id: service.id },
      });
      report.credentialRemoved = removed.kind === "workbench";
    } catch {
      report.credentialRemoved = false;
    }
    if (!report.credentialRemoved) process.exitCode = 1;
  }
  setup.key = "";
  await engine?.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(
    join(output, "latest.json"),
    JSON.stringify({ directory, status: report.status }) + "\n",
  );
}
console.log(
  JSON.stringify({ status: report.status, directory, checks: report.checks, error: report.error }),
);
