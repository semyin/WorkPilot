import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, readdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  launch,
  create,
  until,
  profile,
  setFixture,
  start,
  terminal,
} from "./tool-test-support.mjs";
import { startToolFixture } from "../services/execution-fixtures/tools.mjs";
import { generateDocument } from "../services/documents/write.mjs";
import {
  media,
  uploadMedia,
  configureMediaTask,
  transferMedia,
} from "./media-transfer-support.mjs";

const require = createRequire(resolve("services/documents/package.json"));
const { createCanvas } = require("@napi-rs/canvas");
const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/media-transfer");
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, "session-"));
const binary = process.env.WORKPILOT_ENGINE_BINARY || resolve("target/debug/workpilot-engine.exe");
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  binarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  checks: [],
};
const password = "attachment fixture " + crypto.randomUUID(),
  canary = "MEDIA-CREDENTIAL-FIXTURE-" + crypto.randomUUID();
let source, target, privateProfile;
const fixture = await startToolFixture();
setFixture(fixture);
const raw = (engine, task, action) =>
  engine.request({ kind: "media_transfer", task_id: task, action });
const transfer = (engine, task, action) => transferMedia(engine.request, task, action);
const admin = (engine, task, action) => media(engine.request, task, action);
const wb = async (engine, task, action) => {
  const r = await engine.request({ kind: "workbench", task_id: task, action });
  assert.equal(r.kind, "workbench", JSON.stringify(r));
  return r.data;
};
const sourceData = join(root, "source-data"),
  targetData = join(root, "target-data");
try {
  const sourceFolder = join(root, "源 项目"),
    targetFolder = join(root, "目标 项目");
  await mkdir(sourceFolder);
  await mkdir(targetFolder);
  await writeFile(join(targetFolder, "keep.txt"), "existing target project");
  source = await launch(sourceData);
  const from = await create(source, "responses", "media-transfer-source");
  await configureMediaTask(source.request, from, sourceFolder, "full_access");
  const note = await uploadMedia(
    source.request,
    from,
    "资料.txt",
    Buffer.from("迁移内容 42\noriginal snapshot\n"),
  );
  const canvas = createCanvas(32, 16);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#2266cc";
  ctx.fillRect(0, 0, 32, 16);
  const picture = await uploadMedia(source.request, from, "图片.png", canvas.toBuffer("image/png"));
  const docx = Buffer.from(
    await generateDocument(
      "docx",
      {
        title: "迁移标题",
        sections: [{ heading: "文档原内容", paragraphs: ["Original Word content 42"] }],
      },
      resolve("services/documents"),
    ),
  );
  await writeFile(join(sourceFolder, "中文 报告.docx"), docx);
  const file = await wb(source, from, { kind: "read_file", path: "中文 报告.docx" });
  const document = (
    await wb(source, from, {
      kind: "read_document",
      path: "中文 报告.docx",
      expected: file.version,
    })
  ).asset;
  const absent = { exists: false, sha256: null, bytes: 0, identity: null };
  const generated = await wb(source, from, {
    kind: "media",
    effect: {
      kind: "create_document",
      path: "成果.pdf",
      expected: absent,
      format: "pdf",
      recipe: {
        title: "迁移 PDF 成果",
        sections: [{ heading: "结果", paragraphs: ["Portable generated output 42"] }],
      },
    },
  });
  await until(async () => {
    const r = await wb(source, from, { kind: "operation", operation_id: generated.operation.id });
    assert(!["failed", "cancelled"].includes(r.operation.state), JSON.stringify(r));
    return r.operation.state === "completed";
  }, 100000);
  const pdf = (await admin(source, from, { kind: "list" })).assets.find(
    (a) => a.operation_id === generated.operation.id,
  );
  assert(pdf);
  const selected = [note, picture, document, pdf];
  const originalPdfUnits = (
    await admin(source, from, { kind: "read", asset_id: pdf.id, start: 0, limit: 16 })
  ).units;
  // The immutable original remains available when the bound project directory is offline.
  await rename(sourceFolder, sourceFolder + "-offline");
  const archive = join(root, "附件 备份.wpmedia"),
    exporting = { kind: "export", asset_ids: selected.map((a) => a.id), path: archive, password };
  assert.equal((await transfer(source, from, exporting)).assets, 4);
  assert.equal((await raw(source, from, exporting)).kind, "error");
  const encrypted = await readFile(archive);
  assert.equal(encrypted.subarray(0, 8).toString(), "WPMEDIA1");
  for (const text of [password, "original snapshot", "中文 报告.docx"])
    assert(!encrypted.includes(Buffer.from(text)));
  const foreign = await create(source, "responses", "media-transfer-foreign");
  assert.equal(
    (await raw(source, foreign, { ...exporting, path: join(root, "foreign.wpmedia") })).kind,
    "error",
  );
  const secretAsset = await uploadMedia(
    source.request,
    from,
    "secret-note.txt",
    Buffer.from(canary),
  );
  privateProfile = profile("responses", "media-credential-canary");
  privateProfile.auth = "bearer";
  assert.equal(
    (
      await source.request({
        kind: "save_provider",
        profile: privateProfile,
        secret: canary,
        clear_credential: false,
      })
    ).kind,
    "provider_saved",
  );
  assert.equal(
    (
      await raw(source, from, {
        ...exporting,
        asset_ids: [secretAsset.id],
        path: join(root, "secret.wpmedia"),
      })
    ).kind,
    "error",
  );
  await source.request({
    kind: "delete_provider",
    profile_id: privateProfile.id,
    expected_revision: privateProfile.revision,
  });
  privateProfile = null;
  await source.close();
  source = null;
  await rename(sourceData, sourceData + "-offline");
  report.checks.push(
    "encrypted_originals_include_uploaded_text_image_project_docx_generated_pdf_with_offline_source_and_no_cross_task_or_credential_export",
  );

  target = await launch(targetData);
  const task = await create(target, "responses", "media-transfer-model", {
    mode: "chat",
    controlled_tools: false,
  });
  await configureMediaTask(target.request, task, targetFolder);
  const existing = await uploadMedia(
    target.request,
    task,
    "迁入-资料.txt",
    Buffer.from("keep target attachment"),
  );
  const inspect = { kind: "inspect", path: archive, password, name_prefix: "迁入-" };
  assert.equal(
    (await raw(target, task, { ...inspect, password: "incorrect fixture passphrase" })).kind,
    "error",
  );
  const broken = Buffer.from(encrypted);
  broken[broken.length - 1] ^= 1;
  const damaged = join(root, "damaged.wpmedia");
  await writeFile(damaged, broken);
  assert.equal((await raw(target, task, { ...inspect, path: damaged })).kind, "error");
  let preview = await transfer(target, task, inspect);
  assert.equal(preview.entries.length, 4);
  assert.equal(preview.conflicts.length, 0);
  assert.deepEqual(preview.same_names, ["迁入-资料.txt"]);
  assert(preview.entries.some((e) => e.media_type === "application/pdf"));
  assert.equal(preview.entries.find((e) => e.source_id === picture.id).image.width, 32);
  assert.equal((await admin(target, task, { kind: "list" })).assets.length, 1);
  await uploadMedia(target.request, task, "later.txt", Buffer.from("new target attachment"));
  assert.equal(
    (await raw(target, task, { ...inspect, kind: "import", fingerprint: preview.fingerprint }))
      .kind,
    "error",
  );
  assert.equal((await admin(target, task, { kind: "list" })).assets.length, 2);
  report.checks.push(
    "authenticated_preview_reparses_formats_without_creating_rows_warns_same_names_and_refuses_changed_target",
  );

  preview = await transfer(target, task, inspect);
  const imported = await transfer(target, task, {
    ...inspect,
    kind: "import",
    fingerprint: preview.fingerprint,
  });
  assert.equal(imported.duplicate, false);
  assert.equal(imported.receipt.assets.length, 4);
  let assets = (await admin(target, task, { kind: "list" })).assets;
  for (const old of selected) {
    const row = assets.find((a) => a.origin?.asset_id === old.id);
    assert(row);
    assert.notEqual(row.id, old.id);
    assert.equal(row.sha256, old.sha256);
    assert.equal(row.bytes, old.bytes);
    assert.equal(row.source, "file");
    assert.equal(row.path, null);
    assert.equal(row.operation_id, null);
    assert.equal(row.version, null);
    assert.equal(row.origin.task_id, from);
    assert.equal(row.origin.source, old.source);
  }
  assert(
    (
      await admin(target, task, { kind: "read", asset_id: existing.id, start: 0, limit: 16 })
    ).units.some((u) => u.text.includes("keep target")),
  );
  const migratedNote = assets.find((a) => a.origin?.asset_id === note.id),
    migratedPicture = assets.find((a) => a.origin?.asset_id === picture.id),
    migratedDoc = assets.find((a) => a.origin?.asset_id === document.id),
    migratedPdf = assets.find((a) => a.origin?.asset_id === pdf.id);
  assert(
    (
      await admin(target, task, { kind: "read", asset_id: migratedDoc.id, start: 0, limit: 16 })
    ).units.some((u) => u.text.includes("Original Word content 42")),
  );
  const importedPdfUnits = (
    await admin(target, task, { kind: "read", asset_id: migratedPdf.id, start: 0, limit: 16 })
  ).units;
  assert.deepEqual(importedPdfUnits, originalPdfUnits);
  assert(importedPdfUnits.some((u) => u.text.includes("Portable generated output")));
  assert(importedPdfUnits.some((u) => u.text.includes("Portable generated output 42")));
  report.pdfNumericTextPreserved = true;
  for (const a of [migratedPicture, migratedPdf, migratedDoc]) {
    const p = await admin(target, task, { kind: "preview", asset_id: a.id, page: 1 });
    assert(p.image.startsWith("data:image/png;base64,"));
    assert.equal(p.source_sha256, a.sha256);
    await writeFile(
      join(
        output,
        a.id === migratedDoc.id
          ? "migrated-docx.png"
          : a.id === migratedPdf.id
            ? "migrated-pdf.png"
            : "migrated-picture.png",
      ),
      Buffer.from(p.image.split(",")[1], "base64"),
    );
  }
  assert.equal(await readFile(join(targetFolder, "keep.txt"), "utf8"), "existing target project");
  assert.deepEqual(await readdir(targetFolder), ["keep.txt"]);
  assert.equal(
    (await wb(target, task, { kind: "history", path: null, before: null, limit: 100 })).items
      .length,
    0,
  );
  report.checks.push(
    "new_ids_and_original_provenance_chat_mode_import_exact_hashes_office_pdf_image_preview_no_live_path_or_project_file_changes",
  );

  let observedWithout = false,
    observedWith = false;
  fixture.recipes.set("media-transfer-model", (results, body) => {
    const attached = JSON.stringify(body).includes(`[workpilot-file:${migratedNote.id}]`);
    if (!attached) {
      assert(!JSON.stringify(body).includes("original snapshot"));
      assert(!JSON.stringify(body).includes(migratedNote.id));
      observedWithout = true;
      return fixture.done("No attachments requested.");
    }
    observedWith = true;
    if (!results.length)
      return fixture.tool("document_read", { asset_id: migratedNote.id, start: 0, limit: 16 });
    assert(JSON.parse(results[0]).units.some((u) => u.text.includes("original snapshot")));
    return fixture.done("Explicitly attached snapshot read.");
  });
  assert.equal(fixture.records.length, 0);
  await start(target, task);
  assert.equal((await terminal(target, task)).task.state, "completed");
  assert(observedWithout);
  await target.request({
    kind: "enqueue",
    task_id: task,
    text: `Read this attachment.\n[workpilot-file:${migratedNote.id}] ${migratedNote.name}`,
  });
  await start(target, task);
  assert.equal((await terminal(target, task)).task.state, "completed");
  assert(observedWith);
  report.checks.push(
    "import_does_not_call_model_or_expose_snapshots_until_user_delivers_explicit_attachment_marker_then_document_read_works",
  );

  await admin(target, task, { kind: "remove", asset_id: migratedPicture.id });
  await target.close();
  target = await launch(targetData);
  const count = (await admin(target, task, { kind: "list" })).assets.length;
  const duplicate = await transfer(target, task, {
    ...inspect,
    kind: "import",
    fingerprint: preview.fingerprint,
    name_prefix: "another-",
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal((await admin(target, task, { kind: "list" })).assets.length, count);
  assert(
    !(await admin(target, task, { kind: "list" })).assets.some((a) => a.id === migratedPicture.id),
  );
  const reexport = join(root, "再次备份.wpmedia");
  await transfer(target, task, {
    kind: "export",
    asset_ids: [migratedNote.id],
    path: reexport,
    password,
  });
  const third = await create(target, "responses", "media-transfer-third", { mode: "chat" });
  const thirdInspect = { kind: "inspect", path: reexport, password, name_prefix: "" };
  let thirdPreview = await transfer(target, third, thirdInspect);
  await transfer(target, third, {
    ...thirdInspect,
    kind: "import",
    fingerprint: thirdPreview.fingerprint,
  });
  const thirdAsset = (await admin(target, third, { kind: "list" })).assets[0];
  assert.deepEqual(thirdAsset.origin, migratedNote.origin);
  report.checks.push(
    "restart_dedup_keeps_removed_items_removed_and_second_generation_archive_preserves_first_origin",
  );

  const cancelled = await create(target, "responses", "media-transfer-cancel");
  const cancelPreview = await transfer(target, cancelled, inspect);
  const pending = raw(target, cancelled, {
    ...inspect,
    kind: "import",
    fingerprint: cancelPreview.fingerprint,
  });
  assert.equal((await transfer(target, third, { kind: "cancel" })).cancel_requested, false);
  await until(
    async () => (await transfer(target, cancelled, { kind: "cancel" })).cancel_requested,
    5000,
  );
  const stopped = await pending;
  assert.equal(stopped.kind, "error", JSON.stringify(stopped));
  assert.equal((await admin(target, cancelled, { kind: "list" })).assets.length, 0);
  assert.equal((await transfer(target, cancelled, inspect)).entries.length, 4);
  report.checks.push(
    "owned_cancel_stops_transfer_before_commit_foreign_task_cannot_cancel_and_next_preview_works",
  );

  await target.close();
  target = null;
  async function scan(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) await scan(path);
      else {
        const bytes = await readFile(path);
        assert(!bytes.includes(Buffer.from(password)), "Passphrase persisted");
        assert(!bytes.includes(Buffer.from(canary)), "Configured credential persisted");
      }
    }
  }
  await scan(sourceData + "-offline");
  await scan(targetData);
  assert.notEqual(
    await readFile(join(sourceData + "-offline", "test/versions/key-id"), "utf8"),
    await readFile(join(targetData, "test/versions/key-id"), "utf8"),
  );
  report.checks.push(
    "separate_vault_keys_and_no_passphrase_or_test_credential_in_normal_databases_objects_logs",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  if (source && privateProfile)
    await source
      .request({
        kind: "delete_provider",
        profile_id: privateProfile.id,
        expected_revision: privateProfile.revision,
      })
      .catch(() => {});
  await source?.close();
  await target?.close();
  await fixture.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
