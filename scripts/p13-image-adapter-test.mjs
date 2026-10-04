import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { launch, create, until } from "./tool-test-support.mjs";
import { startBailianFixture } from "../services/documents/bailian-fixture.mjs";

const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/p13-images");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "run-"));
const binary = process.env.WORKPILOT_ENGINE_BINARY || resolve("target/debug/workpilot-engine.exe");
const report = {
  at: new Date().toISOString(),
  binarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  service: "Local synthetic Bailian JSON + same-origin result download; not a real image service",
  checks: [],
};
const fixture = await startBailianFixture();
const absent = { exists: false, sha256: null, bytes: 0, identity: null };
let engine, service;
try {
  engine = await launch(directory);
  const project = join(directory, "project");
  await mkdir(project);
  const task = await create(engine, "responses", "p13-image-adapter");
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
    assert.equal(r.kind, "workbench", JSON.stringify(r));
    return r.data;
  };
  const work = async (action) => {
    const r = await engine.request({ kind: "workbench", task_id: task, action });
    assert.equal(r.kind, "workbench", JSON.stringify(r));
    return r.data;
  };
  service = (
    await admin({
      kind: "save_image_service",
      service: {
        id: crypto.randomUUID(),
        label: "P13 local images",
        base_url: fixture.url,
        model: "qwen-image-3.0",
        revision: 0,
        credential: null,
        supports_edit: true,
        sizes: ["32x16"],
        qualities: [],
        formats: ["png"],
        max_count: 1,
        request_base64: false,
        auth_required: true,
        protocol: "aliyun_images",
      },
      secret: "p13-synthetic-image-credential",
    })
  ).service;
  const request = (prompt, references = []) => ({
    service_id: service.id,
    service_revision: service.revision,
    prompt,
    size: "32x16",
    quality: null,
    format: "png",
    count: 1,
    references,
    paths: [prompt + ".png"],
    expected: [absent],
  });
  const finish = async (operation, expected = "completed") => {
    const value = await until(async () => {
      const r = await work({ kind: "operation", operation_id: operation.id });
      return ["completed", "failed", "cancelled"].includes(r.operation.state) && r.operation;
    }, 30000);
    assert.equal(value.state, expected, JSON.stringify(value));
    return value;
  };
  const prepare = async (prompt, references = []) => {
    const { operation } = await work({
      kind: "media",
      effect: { kind: "generate_image", request: request(prompt, references) },
    });
    assert.equal(operation.state, "awaiting_approval");
    return operation;
  };
  const approve = async (operation) =>
    work({ kind: "approve", operation_id: operation.id, fingerprint: operation.fingerprint });
  const original = await prepare("generated");
  assert.equal(fixture.calls.length, 0, "No request before the concrete operation is approved");
  await approve(original);
  await finish(original);
  const assets = (await admin({ kind: "list" })).assets;
  const generated = assets.find(
    (a) => a.path?.endsWith("generated.png") || a.name === "generated.png",
  );
  assert(generated, "Generated asset must be recorded");
  const originalBytes = await readFile(join(project, "generated.png"));
  const edited = await prepare("edited", [generated.id]);
  await approve(edited);
  await finish(edited);
  assert.deepEqual(await readFile(join(project, "generated.png")), originalBytes);
  assert.notDeepEqual(await readFile(join(project, "edited.png")), originalBytes);
  const posts = fixture.calls.filter((c) => c.method === "POST");
  assert(posts.every((c) => c.path === "/v1/images/generations" && c.authenticated));
  assert.equal(posts[0].body.image, undefined);
  assert.match(posts[1].body.image[0], /^data:image\/png;base64,/);
  assert.deepEqual(Buffer.from(posts[1].body.image[0].split(",")[1], "base64"), originalBytes);
  assert(fixture.calls.filter((c) => c.method === "GET").every((c) => !c.authenticated));
  report.checks.push(
    "approved_json_generation_and_reference_edit_download_without_forwarding_key_preserve_original",
  );
  for (const prompt of [
    "quota",
    "cross-origin",
    "redirect",
    "oversized",
    "corrupt",
    "partial",
    "wrong-size",
  ]) {
    const before = fixture.calls.length;
    const operation = await prepare(prompt);
    await approve(operation);
    await finish(operation, "failed");
    assert.equal(fixture.calls.slice(before).filter((c) => c.method === "POST").length, 1);
    assert(
      !(await stat(join(project, prompt + ".png")).then(
        () => true,
        () => false,
      )),
    );
    if (["quota", "cross-origin"].includes(prompt)) assert.equal(fixture.calls.length - before, 1);
    if (prompt === "redirect") assert.equal(fixture.calls.length - before, 2);
  }
  assert(!fixture.calls.some((c) => c.path === "/redirect-must-not-follow"));
  report.checks.push(
    "quota_foreign_url_redirect_oversize_corruption_disconnect_wrong_dimensions_fail_without_retry_or_file",
  );
  const slow = await prepare("slow");
  await approve(slow);
  await until(async () => fixture.calls.some((c) => c.path === "/image/slow"));
  await work({ kind: "stop", operation_id: slow.id });
  await finish(slow, "cancelled");
  await until(async () => fixture.calls.find((c) => c.path === "/image/slow").closed);
  assert(
    !(await stat(join(project, "slow.png")).then(
      () => true,
      () => false,
    )),
  );
  report.checks.push("cancel_result_download_closes_connection_and_writes_no_output");
  const old = { ...service };
  delete old.protocol;
  service = (await admin({ kind: "save_image_service", service: old, secret: null })).service;
  assert.equal(service.protocol, "openai_images");
  const legacy = await prepare("legacy-url-only");
  await approve(legacy);
  await finish(legacy, "failed");
  assert.equal(fixture.calls.filter((c) => c.path === "/image/legacy-url-only").length, 0);
  report.checks.push("old_profiles_default_to_standard_images_and_keep_url_only_rejection");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  if (engine && service)
    await engine
      .request({
        kind: "media",
        task_id: null,
        action: { kind: "remove_image_service", service_id: service.id },
      })
      .catch(() => {});
  await engine?.close();
  await fixture.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify(report, null, 2));
