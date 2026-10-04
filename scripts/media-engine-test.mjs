import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { launch, create, until } from "./tool-test-support.mjs";
import { generateDocument } from "../services/documents/write.mjs";
import { parse } from "../services/documents/worker.mjs";
import { startImageFixture } from "../services/documents/image-fixture.mjs";
const directory = ".test-results/media-engine";
await mkdir(directory, { recursive: true });
const binary =
  process.env.WORKPILOT_ENGINE_BINARY ||
  path.resolve("target/debug/workpilot-engine" + (process.platform === "win32" ? ".exe" : ""));
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  binary: {
    path: binary,
    sha256: createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
  },
  service: "Real local files and isolated document worker; synthetic Images API only",
  checks: [],
};
const absent = { exists: false, sha256: null, bytes: 0, identity: null };
let engine, service;
const fixture = await startImageFixture();
const receipts = [];
try {
  engine = await launch();
  const project = await mkdtemp(path.join(engine.directory, "document-project-"));
  const task = await create(engine, "responses", "p10-media");
  let r = await engine.request({
    kind: "configure_task_tools",
    task_id: task,
    settings: {
      root_path: project,
      permission: "request_approval",
      commands_enabled: false,
      review_profile_id: null,
      revision: 0,
    },
  });
  assert.notEqual(r.kind, "error", JSON.stringify(r));
  const rawAdmin = (action, scope = task) =>
    engine.request({ kind: "media", task_id: scope, action });
  const admin = async (action, scope = task) => {
    const r = await rawAdmin(action, scope);
    assert.equal(r.kind, "workbench", JSON.stringify(r));
    return r.data;
  };
  const rawWork = (action) => engine.request({ kind: "workbench", task_id: task, action });
  const wb = async (action) => {
    const r = await rawWork(action);
    assert.equal(r.kind, "workbench", JSON.stringify(r));
    return r.data;
  };
  const finish = async (operation, state = "completed") => {
    const op = await until(async () => {
      const r = await wb({ kind: "operation", operation_id: operation.id });
      return ["completed", "failed", "cancelled"].includes(r.operation.state) && r.operation;
    }, 100000);
    assert.equal(op.state, state, JSON.stringify(op));
    return op;
  };
  const result = async (op) => {
    assert(op.output);
    let text = "",
      offset = 0;
    while (offset < op.output.bytes) {
      const r = await engine.request({
        kind: "read",
        query: { kind: "content", object_id: op.output.object_id, offset, limit: 65536 },
      });
      text += r.page.text;
      offset = r.page.next_offset;
    }
    return JSON.parse(text);
  };
  const effect = async (effect, state = "completed") => {
    const { operation } = await wb({ kind: "media", effect });
    assert.equal(operation.state, "awaiting_approval");
    await wb({ kind: "approve", operation_id: operation.id, fingerprint: operation.fingerprint });
    return finish(operation, state);
  };
  const upload = async (name, bytes) => {
    const { upload_id } = await admin(
      { kind: "begin_upload", name, bytes: bytes.length, source: "file" },
      null,
    );
    for (let offset = 0; offset < bytes.length; offset += 512 * 1024)
      await admin(
        {
          kind: "upload_chunk",
          upload_id,
          offset,
          base64: bytes.subarray(offset, offset + 512 * 1024).toString("base64"),
        },
        null,
      );
    return rawAdmin({ kind: "finish_upload", upload_id }, null);
  };
  const initial = Buffer.from(
    "中文输入\nTotal: 42\n<script>window.__TAURI_INTERNALS__.invoke('exit_app')</script>",
  );
  r = await upload("资料.txt", initial);
  assert.equal(r.kind, "workbench", JSON.stringify(r));
  const attached = r.data.asset;
  await admin({ kind: "bind", asset_ids: [attached.id] });
  r = await admin({ kind: "read", asset_id: attached.id, start: 1, limit: 1 });
  assert.equal(r.units[0].text, "Total: 42");
  assert.match(r.units[0].locator, /2/);
  const other = await create(engine, "messages", "p10-other");
  r = await rawAdmin({ kind: "read", asset_id: attached.id, start: 0, limit: 2 }, other);
  assert.equal(r.kind, "error");
  report.checks.push("chunked_upload_exact_content_source_range_and_cross_task_denial");
  const cases = {
    docx: {
      title: "WorkPilot 中文验收",
      sections: [
        {
          heading: "实际内容",
          paragraphs: ["收入 25，其他收入 17，合计 42。"],
          table: {
            columns: ["项目", "金额"],
            rows: [
              ["收入", 25],
              ["其他", 17],
            ],
          },
        },
      ],
    },
    xlsx: {
      title: "收入",
      sheets: [
        {
          name: "收入",
          rows: [["项目", "金额"], ["收入", 25], ["其他", 17], ["合计"]],
          formulas: [{ cell: "B4", formula: "SUM(B2:B3)" }],
          chart: { title: "收入构成", labels: ["收入", "其他"], values: [25, 17] },
        },
      ],
    },
    pptx: {
      title: "工作成果",
      slides: [
        {
          title: "工作成果 42",
          body: ["真实内容", "合计 42"],
          chart: { title: "构成", labels: ["收入", "其他"], values: [25, 17] },
        },
        { title: "下一步", body: ["验证中文显示和版面。"] },
      ],
    },
    pdf: {
      title: "中文 PDF 验收",
      sections: [
        {
          heading: "核对项",
          paragraphs: [
            "实际收入 25 + 17 = 42。",
            "Portable generated output 42",
            "Invoice A00123456789Z: 1234.56 -17 25/17 100%",
            "这是重新生成的 PDF，不是 Word 转换结果。",
          ],
        },
      ],
    },
    csv: {
      rows: [
        ["项目", "金额"],
        ["收入", 42],
        ['=HYPERLINK("https://invalid")', 0],
      ],
    },
    md: { text: "# 中文成果\n\n合计 42。\n" },
  };
  for (const [format, recipe] of Object.entries(cases)) {
    const operation = await effect({
      kind: "create_document",
      path: `成果.${format}`,
      format,
      recipe,
      expected: absent,
    });
    const output = await result(operation);
    assert.equal(output.assets.length, 1);
    assert.equal(output.source.conversion, false);
    const asset = output.assets[0];
    const contents = await admin({ kind: "read", asset_id: asset.id, start: 0, limit: 32 });
    assert(
      contents.units.some((u) => u.text.includes("42")),
      JSON.stringify(contents),
    );
    const bytes = await readFile(path.join(project, `成果.${format}`));
    const independent = await parse(bytes, `成果.${format}`);
    assert(independent.units.length > 0);
    if (format === "xlsx")
      assert(contents.units.some((u) => u.text.includes("SUM(B2:B3)") && u.text.includes("42")));
    if (format === "pdf") {
      const pdfText = contents.units.map((u) => u.text).join("\n");
      assert(pdfText.includes("Portable generated output 42"));
      assert(pdfText.includes("Invoice A00123456789Z: 1234.56 -17 25/17 100%"));
      assert(!/[\uE000-\uF8FF]/u.test(pdfText));
      const preview = await admin({ kind: "preview", asset_id: asset.id, page: 1 });
      assert(preview.image.startsWith("data:image/png;base64,"));
      await writeFile(
        path.join(directory, "pdf-preview.png"),
        Buffer.from(preview.image.split(",")[1], "base64"),
      );
    }
    await copyFile(path.join(project, `成果.${format}`), path.join(directory, `sample.${format}`));
    receipts.push({ format, sha256: asset.sha256, bytes: asset.bytes, units: asset.units });
  }
  report.checks.push(
    "real_docx_xlsx_pptx_pdf_csv_markdown_generation_readback_formula_42_and_pdf_render",
  );
  r = await wb({ kind: "history", path: "成果.xlsx", before: null, limit: 20 });
  assert(r.items.length > 0);
  assert(r.items.some((i) => i.source === "media"));
  let file = await wb({ kind: "read_file", path: "成果.docx" });
  const oldVersion = file.version;
  const { operation: pending } = await wb({
    kind: "media",
    effect: {
      kind: "create_document",
      path: "成果.docx",
      format: "docx",
      recipe: cases.docx,
      expected: oldVersion,
    },
  });
  const edited = await generateDocument(
    "docx",
    { title: "外部编辑 99", sections: [{ paragraphs: ["保留我的修改。"] }] },
    path.resolve("services/documents"),
  );
  await writeFile(path.join(project, "成果.docx"), edited);
  r = await rawWork({
    kind: "approve",
    operation_id: pending.id,
    fingerprint: pending.fingerprint,
  });
  assert.equal(r.kind, "error");
  assert.deepEqual(await readFile(path.join(project, "成果.docx")), Buffer.from(edited));
  file = await wb({ kind: "read_file", path: "成果.docx" });
  r = await wb({ kind: "read_document", path: "成果.docx", expected: file.version });
  const refreshed = await admin({ kind: "read", asset_id: r.asset.id, start: 0, limit: 8 });
  assert(refreshed.units.some((u) => u.text.includes("99")));
  report.checks.push(
    "generation_uses_file_history_external_edit_blocks_old_approval_and_refresh_reads_new_bytes",
  );
  for (const [name, bytes] of [
    ["bad.docx", Buffer.from("broken zip")],
    ["encrypted.docx", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])],
    ["unknown.exe", Buffer.from("MZ")],
    ["bad.pdf", Buffer.from("not a PDF")],
    ["bad.txt", Buffer.from([0xff, 0xfe, 0])],
  ]) {
    r = await upload(name, bytes);
    assert.equal(r.kind, "error", name);
  }
  r = await rawAdmin(
    { kind: "begin_upload", name: "large.pdf", bytes: 33 * 1024 * 1024, source: "file" },
    null,
  );
  assert.equal(r.kind, "error");
  report.checks.push(
    "corrupt_password_legacy_unknown_encoding_and_oversize_inputs_are_errors_not_empty_success",
  );
  service = {
    id: crypto.randomUUID(),
    label: "Local protocol fixture",
    base_url: fixture.url,
    model: "fixture-image",
    revision: 0,
    credential: null,
    supports_edit: true,
    sizes: ["32x16"],
    qualities: ["auto"],
    formats: ["png"],
    max_count: 2,
    request_base64: false,
    auth_required: true,
  };
  const secret = `fixture-image-key-${crypto.randomUUID()}`;
  r = await admin({ kind: "save_image_service", service, secret }, null);
  service = r.service;
  const request = (prompt, paths = ["image.png"], refs = []) => ({
    service_id: service.id,
    service_revision: service.revision,
    prompt,
    size: "32x16",
    quality: "auto",
    format: "png",
    count: paths.length,
    references: refs,
    paths,
    expected: paths.map(() => absent),
  });
  let op = await effect({ kind: "generate_image", request: request("normal") });
  let output = await result(op);
  const image = output.assets[0];
  assert.deepEqual(image.image, { width: 32, height: 16 });
  assert.equal(output.source.cost, null);
  assert.equal(output.source.usage.total_tokens, 30);
  assert.equal(fixture.calls.at(-1).authorization, `Bearer ${secret}`);
  op = await effect({
    kind: "generate_image",
    request: request("edit-test", ["edited.png"], [image.id]),
  });
  assert.equal(fixture.calls.at(-1).path, "/v1/images/edits");
  assert(fixture.calls.at(-1).hasImage);
  await result(op);
  report.checks.push(
    "dedicated_image_profile_system_secret_generate_and_multipart_edit_real_bytes_dimensions_usage_cost_unknown",
  );
  for (const prompt of ["error", "disconnect", "wrong-size", "invalid", "empty"]) {
    const before = fixture.calls.length;
    op = await effect(
      { kind: "generate_image", request: request(prompt, [`${prompt}.png`]) },
      "failed",
    );
    assert.equal(fixture.calls.length, before + 1);
    assert(op.error);
  }
  r = await rawWork({
    kind: "media",
    effect: {
      kind: "generate_image",
      request: { ...request("normal"), service_id: crypto.randomUUID() },
    },
  });
  assert.equal(r.kind, "error");
  report.checks.push(
    "image_error_disconnect_wrong_format_dimensions_and_count_fail_once_missing_service_never_fakes_success",
  );
  const slow = await wb({
    kind: "media",
    effect: { kind: "generate_image", request: request("slow", ["slow.png"]) },
  });
  await wb({
    kind: "approve",
    operation_id: slow.operation.id,
    fingerprint: slow.operation.fingerprint,
  });
  await until(async () => fixture.calls.at(-1)?.prompt === "slow");
  const stopAt = performance.now();
  await wb({ kind: "stop", operation_id: slow.operation.id });
  await finish(slow.operation, "cancelled");
  report.stopMs = Math.round(performance.now() - stopAt);
  assert(report.stopMs < 2000);
  report.checks.push("image_request_cancellation_is_prompt_and_does_not_retry_or_write_a_result");
  const logs = JSON.stringify(engine.events);
  assert(!logs.includes(secret));
  await admin({ kind: "remove_image_service", service_id: service.id }, null);
  service = null;
  report.checks.push("image_credential_not_in_event_stream_and_profile_removal_cleans_credential");
  const protectedPdf = await readFile("tests/fixtures/media/password-protected.pdf");
  r = await upload("protected.pdf", protectedPdf);
  assert.equal(r.kind, "error");
  assert.match(r.message, /密码|Password/);
  const largePdf = await readFile(".test-results/media-engine/sample.pdf");
  const { upload_id: cancelId } = await admin(
    { kind: "begin_upload", name: "cancel.pdf", bytes: largePdf.length, source: "file" },
    null,
  );
  for (let offset = 0; offset < largePdf.length; offset += 512 * 1024)
    await admin(
      {
        kind: "upload_chunk",
        upload_id: cancelId,
        offset,
        base64: largePdf.subarray(offset, offset + 512 * 1024).toString("base64"),
      },
      null,
    );
  const parsing = rawAdmin({ kind: "finish_upload", upload_id: cancelId }, null);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const cancelledAt = performance.now();
  await admin({ kind: "cancel_upload", upload_id: cancelId }, null);
  const cancelled = await parsing;
  assert.equal(cancelled.kind, "error");
  report.parseStopMs = Math.round(performance.now() - cancelledAt);
  assert(report.parseStopMs < 2000);
  report.checks.push(
    "real_encrypted_pdf_is_reported_as_password_protected_and_active_parse_can_be_cancelled",
  );
  const leak = `fixture-image-secret-${crypto.randomUUID()}`;
  r = await rawAdmin(
    {
      kind: "save_image_service",
      service: {
        id: crypto.randomUUID(),
        label: leak,
        base_url: fixture.url,
        model: "fixture",
        revision: 0,
        credential: null,
        supports_edit: false,
        sizes: ["32x16"],
        qualities: [],
        formats: ["png"],
        max_count: 1,
        request_base64: false,
        auth_required: true,
      },
      secret: leak,
    },
    null,
  );
  assert.equal(r.kind, "error");
  const catalog = await admin({ kind: "image_services" }, null);
  assert(!JSON.stringify(catalog).includes(leak));
  report.checks.push("image_key_cannot_accidentally_be_saved_in_plaintext_profile_metadata");
  report.samples = receipts;
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = String(e.stack || e);
  throw e;
} finally {
  if (service && engine)
    await engine
      .request({
        kind: "media",
        task_id: null,
        action: { kind: "remove_image_service", service_id: service.id },
      })
      .catch(() => {});
  if (engine) await engine.close();
  await fixture.close();
  await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
