import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { launch, create, setFixture, start, terminal, until } from "./tool-test-support.mjs";
import { startToolFixture } from "../services/execution-fixtures/tools.mjs";
import { startImageFixture } from "../services/documents/image-fixture.mjs";
const output = ".test-results/media-model";
await mkdir(output, { recursive: true });
const model = await startToolFixture(),
  images = await startImageFixture();
setFixture(model);
let engine;
const binary =
  process.env.WORKPILOT_ENGINE_BINARY ||
  resolve("target/debug/workpilot-engine" + (process.platform === "win32" ? ".exe" : ""));
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  binary: {
    path: binary,
    sha256: createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
  },
  model:
    "Deterministic local responses/chat_completions/messages; actual files and Images HTTP fixture",
  checks: [],
};
try {
  engine = await launch();
  const project = await mkdtemp(join(engine.directory, "media-model-project-"));
  const admin = async (task, action) => {
    const r = await engine.request({ kind: "media", task_id: task, action });
    assert.equal(r.kind, "workbench", JSON.stringify(r));
    return r.data;
  };
  const wb = async (task, action) => {
    const r = await engine.request({ kind: "workbench", task_id: task, action });
    assert.equal(r.kind, "workbench", JSON.stringify(r));
    return r.data;
  };
  const configure = async (task) => {
    assert.notEqual(
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
      "error",
    );
  };
  const upload = async (name, bytes) => {
    const { upload_id } = await admin(null, {
      kind: "begin_upload",
      name,
      bytes: bytes.length,
      source: "file",
    });
    for (let offset = 0; offset < bytes.length; offset += 512 * 1024)
      await admin(null, {
        kind: "upload_chunk",
        upload_id,
        offset,
        base64: bytes.subarray(offset, offset + 512 * 1024).toString("base64"),
      });
    return (await admin(null, { kind: "finish_upload", upload_id })).asset;
  };
  const approve = async (task) => {
    const { items } = await wb(task, { kind: "operations" });
    const op = items
      .map((i) => i.operation)
      .find((o) => o.kind === "media" && o.state === "awaiting_approval");
    assert(op);
    await wb(task, { kind: "approve", operation_id: op.id, fingerprint: op.fingerprint });
    await until(async () => {
      const v = await wb(task, { kind: "operation", operation_id: op.id });
      assert.notEqual(v.operation.state, "failed", JSON.stringify(v));
      return v.operation.state === "completed";
    }, 100000);
    return op;
  };
  for (const protocol of ["responses", "chat_completions", "messages"]) {
    const source = await upload(
      "数据.txt",
      Buffer.from("来源数据\n收入 25\n其他收入 17\n合计 42\n"),
    );
    const name = `p10-doc-${protocol}`;
    let seen = false;
    model.recipes.set(name, (results, body) => {
      if (!results.length) {
        assert(JSON.stringify(body).includes(source.id));
        seen = true;
        return model.tool("document_read", { asset_id: source.id, start: 1, limit: 3 });
      }
      if (results.length === 1) {
        const data = JSON.parse(results[0]);
        assert(data.units.some((u) => u.text.includes("42")));
        return model.tool("document_create", {
          path: `model-${protocol}.docx`,
          expected_sha256: null,
          format: "docx",
          recipe: {
            title: "模型生成文档",
            sections: [
              { heading: "数据与来源", paragraphs: ["合计 42。来源：数据.txt，第 2–4 行。"] },
            ],
          },
        });
      }
      return model.done("已生成实际 Word 文件，合计 42，来源已标明。");
    });
    const task = await create(engine, protocol, name, {
      goal: `读取此附件并生成报告。 [workpilot-file:${source.id}]`,
      controlled_tools: false,
    });
    await admin(task, { kind: "bind", asset_ids: [source.id] });
    await configure(task);
    await start(engine, task);
    let state = await terminal(engine, task);
    assert.equal(state.task.state, "awaiting_approval", JSON.stringify(state.latest_run));
    assert(seen);
    await approve(task);
    await start(engine, task);
    state = await terminal(engine, task);
    assert.equal(state.task.state, "completed", JSON.stringify(state.latest_run));
    const assets = (await admin(task, { kind: "list" })).assets;
    assert.equal(assets.filter((a) => a.operation_id).length, 1);
    assert((await readFile(join(project, `model-${protocol}.docx`))).length > 0);
  }
  report.checks.push(
    "three_protocols_receive_attachment_content_read_citations_generate_docx_and_resume_approval_without_duplicate_files",
  );
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xkAAAAASUVORK5CYII=",
    "base64",
  );
  for (const protocol of ["responses", "chat_completions", "messages"]) {
    const asset = await upload("用户图片.png", png);
    const name = `p10-vision-${protocol}`;
    let saw = false;
    model.recipes.set(name, (_results, body) => {
      const encoded = JSON.stringify(body);
      assert(encoded.includes("image/png"));
      assert(encoded.includes("base64"));
      saw = true;
      return model.done("接收到了实际图片输入。");
    });
    const task = await create(engine, protocol, name, {
      goal: `请查看图片。 [workpilot-file:${asset.id}]`,
      controlled_tools: false,
      mode: "chat",
    });
    await admin(task, { kind: "bind", asset_ids: [asset.id] });
    const profiles = await engine.request({ kind: "read", query: { kind: "profiles" } });
    const view = profiles.catalog.profiles.find((v) => v.profile.model === name);
    const profile = view.profile;
    profile.capabilities.images = { supported: true, source: "user", checked_at_ms: null };
    profile.supports_images = true;
    const saved = await engine.request({
      kind: "save_provider",
      profile,
      secret: null,
      clear_credential: false,
    });
    assert.notEqual(saved.kind, "error", JSON.stringify(saved));
    await start(engine, task);
    const state = await terminal(engine, task);
    assert.equal(state.task.state, "completed", JSON.stringify(state.latest_run));
    assert(saw);
  }
  report.checks.push("actual_image_bytes_reach_each_protocol_with_explicit_vision_capability");
  const picture = await upload("unsupported.png", png);
  const noVision = await create(engine, "responses", "p10-no-vision", {
    goal: `查看图片 [workpilot-file:${picture.id}]`,
    controlled_tools: false,
    mode: "chat",
  });
  await admin(noVision, { kind: "bind", asset_ids: [picture.id] });
  await start(engine, noVision);
  assert.equal((await terminal(engine, noVision)).task.state, "failed");
  assert(!model.records.some((r) => r.model === "p10-no-vision"));
  report.checks.push(
    "unknown_vision_capability_blocks_image_request_before_network_without_switching_model",
  );
  const pending = await upload(
    "尚未交付的排队资料.txt",
    Buffer.from("Do not read before delivery"),
  );
  model.recipes.set("p10-undelivered", (results) =>
    !results.length
      ? model.tool("document_list", {})
      : (assert.equal(JSON.parse(results[0]).assets.length, 0), model.done("没有已交付附件。")),
  );
  const hidden = await create(engine, "responses", "p10-undelivered", { controlled_tools: false });
  await admin(hidden, { kind: "bind", asset_ids: [pending.id] });
  await start(engine, hidden);
  assert.equal((await terminal(engine, hidden)).task.state, "completed");
  report.checks.push(
    "attachment_bound_to_task_but_not_in_delivered_message_is_hidden_from_model_tools",
  );
  const service = (
    await admin(null, {
      kind: "save_image_service",
      service: {
        id: crypto.randomUUID(),
        label: "Image fixture",
        base_url: images.url,
        model: "fixture",
        revision: 0,
        credential: null,
        supports_edit: true,
        sizes: ["32x16"],
        qualities: ["auto"],
        formats: ["png"],
        max_count: 1,
        request_base64: false,
        auth_required: false,
      },
      secret: null,
    })
  ).service;
  for (const scenario of ["normal", "error"]) {
    const name = `p10-image-${scenario}`;
    model.recipes.set(name, (results) =>
      results.length
        ? model.done("图片已生成；没有声称看过图片。")
        : model.tool("image_generate", {
            service_id: service.id,
            service_revision: service.revision,
            prompt: scenario,
            size: "32x16",
            quality: "auto",
            format: "png",
            references: [],
            paths: [`${name}.png`],
          }),
    );
    const task = await create(engine, "responses", name, { controlled_tools: false });
    await configure(task);
    await start(engine, task);
    assert.equal((await terminal(engine, task)).task.state, "awaiting_approval");
    const { items } = await wb(task, { kind: "operations" });
    const op = items.find((v) => v.operation.state === "awaiting_approval").operation;
    await wb(task, { kind: "approve", operation_id: op.id, fingerprint: op.fingerprint });
    await until(async () => {
      const s = await wb(task, { kind: "operation", operation_id: op.id });
      return ["completed", "failed"].includes(s.operation.state);
    }, 100000);
    await start(engine, task);
    const state = await terminal(engine, task);
    assert.equal(
      state.task.state,
      scenario === "normal" ? "completed" : "failed",
      JSON.stringify(state.latest_run),
    );
    assert.equal(images.calls.filter((c) => c.prompt === scenario).length, 1);
    if (scenario === "error") assert.equal(model.records.filter((c) => c.model === name).length, 1);
  }
  report.checks.push(
    "text_only_model_can_generate_images_without_claiming_vision_image_error_stops_task_without_retry",
  );
  await admin(null, { kind: "remove_image_service", service_id: service.id });
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = String(e.stack || e);
  throw e;
} finally {
  if (engine) await engine.close();
  await model.close();
  await images.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
