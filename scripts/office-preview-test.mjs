import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { once } from "node:events";
import { launch, create } from "./tool-test-support.mjs";
import { generateDocument } from "../services/documents/write.mjs";
const folder = process.env.WORKPILOT_OFFICE_TEST_OUTPUT || ".test-results/office-preview";
await mkdir(folder, { recursive: true });
const binary = process.env.WORKPILOT_ENGINE_BINARY || resolve("target/debug/workpilot-engine.exe");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  binary: { path: binary, sha256: hash(await readFile(binary)) },
  checks: [],
  renders: [],
};
let engine;
let canary;
try {
  engine = await launch();
  const task = await create(engine, "responses", "office-preview");
  const raw = (action, scope = task) => engine.request({ kind: "media", task_id: scope, action });
  const admin = async (action, scope = task) => {
    const r = await raw(action, scope);
    assert.equal(r.kind, "workbench", JSON.stringify(r));
    return r.data;
  };
  const wb = async (action) => {
    const r = await engine.request({ kind: "workbench", task_id: task, action });
    assert.equal(r.kind, "workbench", JSON.stringify(r));
    return r.data;
  };
  const project = await mkdtemp(join(engine.directory, "office-project-"));
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
  const imported = async (name) => {
    const file = await wb({ kind: "read_file", path: name });
    return (await wb({ kind: "read_document", path: name, expected: file.version })).asset;
  };
  const snapshots = [];
  for (const format of ["docx", "xlsx", "pptx"]) {
    const bytes = await readFile(`.test-results/media-engine/sample.${format}`),
      name = `原版式 ${format}.${format}`;
    await writeFile(join(project, name), bytes);
    const asset = await imported(name);
    snapshots.push(asset);
    const begin = performance.now();
    const first = await admin({ kind: "preview", asset_id: asset.id, page: 1 });
    const firstRenderMs = Math.round(performance.now() - begin);
    assert.equal(first.conversion, true);
    assert.match(first.renderer, /LibreOfficeKit 26\.8\.0/);
    assert.equal(first.source_sha256, hash(bytes));
    assert.equal(first.pages, format === "pptx" ? 2 : 1);
    assert.equal(first.cache_hit, false);
    const png = Buffer.from(first.image.split(",")[1], "base64");
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    await writeFile(join(folder, `${format}-page-1.png`), png);
    const second = await admin({ kind: "preview", asset_id: asset.id, page: first.pages });
    assert.equal(second.cache_hit, true);
    await writeFile(
      join(folder, `${format}-page-${first.pages}.png`),
      Buffer.from(second.image.split(",")[1], "base64"),
    );
    assert.equal(hash(await readFile(join(project, name))), hash(bytes));
    assert.equal(
      (await raw({ kind: "preview", asset_id: asset.id, page: first.pages + 1 })).kind,
      "error",
    );
    report.renders.push({
      format,
      pages: first.pages,
      firstRenderMs,
      sourceSha256: hash(bytes),
      renderer: first.renderer,
    });
  }
  report.checks.push(
    "real_docx_xlsx_pptx_layout_pages_in_appcontainer_source_unchanged_and_cache_paging",
  );
  const other = await create(engine, "messages", "other-office-task");
  assert.equal(
    (await raw({ kind: "preview", asset_id: snapshots[0].id, page: 1 }, other)).kind,
    "error",
  );
  assert.equal(
    (await raw({ kind: "cancel_preview", asset_id: snapshots[0].id }, other)).kind,
    "error",
  );
  report.checks.push("preview_and_preview_cancellation_are_bound_to_attachment_owner");
  const changed = await generateDocument(
    "docx",
    {
      title: "外部修改后的版本 99",
      sections: [{ heading: "新内容", paragraphs: ["合计从 42 改成 99。"] }],
    },
    resolve("services/documents"),
  );
  await writeFile(join(project, snapshots[0].path), changed);
  const refreshed = await imported(snapshots[0].path);
  assert.notEqual(refreshed.sha256, snapshots[0].sha256);
  const pending = raw({ kind: "preview", asset_id: refreshed.id, page: 1 });
  await new Promise((r) => setTimeout(r, 120));
  const cancelAt = performance.now();
  await admin({ kind: "cancel_preview", asset_id: refreshed.id });
  report.cancelAcknowledgedMs = Math.round(performance.now() - cancelAt);
  const cancelled = await pending;
  report.cancelCompletedMs = Math.round(performance.now() - cancelAt);
  assert.equal(cancelled.kind, "error");
  const next = await admin({ kind: "preview", asset_id: refreshed.id, page: 1 });
  assert.equal(next.source_sha256, hash(changed));
  assert.equal(next.cache_hit, false);
  await writeFile(
    join(folder, "docx-refreshed.png"),
    Buffer.from(next.image.split(",")[1], "base64"),
  );
  const old = await admin({ kind: "preview", asset_id: snapshots[0].id, page: 1 });
  assert.equal(old.source_sha256, snapshots[0].sha256);
  assert.equal(old.cache_hit, true);
  assert.notEqual(old.image, next.image);
  report.checks.push(
    "cancelled_preview_returns_an_error_then_can_restart_external_refresh_uses_new_bytes_old_snapshot_stays_original",
  );
  const missingRenderer = await engine.request({
    kind: "media",
    task_id: task,
    action: { kind: "preview", asset_id: refreshed.id, page: 501 },
  });
  assert.equal(missingRenderer.kind, "error");
  report.checks.push("page_limit_is_enforced_before_rendering");
  // An external image relationship must not trigger even a loopback request.
  // The process boundary has a separate live-connect denial regression test.
  let requests = 0;
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ5kAAAAASUVORK5CYII=",
    "base64",
  );
  canary = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { "Content-Type": "image/png" });
    response.end(pixel);
  }).listen(0, "127.0.0.1");
  await once(canary, "listening");
  const require = createRequire(new URL("../services/documents/package.json", import.meta.url));
  const { Document, Paragraph, ImageRun, Packer } = require("docx");
  const { unzipSync, zipSync, strFromU8, strToU8 } = require("fflate");
  const linked = unzipSync(
    await Packer.toBuffer(
      new Document({
        sections: [
          {
            children: [
              new Paragraph("External image must remain offline"),
              new Paragraph({
                children: [
                  new ImageRun({
                    type: "png",
                    data: pixel,
                    transformation: { width: 32, height: 32 },
                  }),
                ],
              }),
            ],
          },
        ],
      }),
    ),
  );
  const relationships = "word/_rels/document.xml.rels";
  let replacements = 0;
  linked[relationships] = strToU8(
    strFromU8(linked[relationships]).replace(/<Relationship\b[^>]*\/>/g, (tag) => {
      if (!tag.includes('/image"')) return tag;
      replacements++;
      return tag.replace(
        /Target="[^"]*"/,
        `Target="http://127.0.0.1:${canary.address().port}/office-canary.png" TargetMode="External"`,
      );
    }),
  );
  assert.equal(replacements, 1);
  await writeFile(join(project, "external-image.docx"), zipSync(linked));
  const external = await imported("external-image.docx");
  const externalPreview = await admin({ kind: "preview", asset_id: external.id, page: 1 });
  assert.equal(externalPreview.conversion, true);
  assert.equal(requests, 0);
  report.externalImageRequests = requests;
  report.checks.push("office_external_image_relationship_does_not_contact_live_http_canary");
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = String(e.stack || e);
  process.exitCode = 1;
} finally {
  if (canary) await new Promise((resolve) => canary.close(resolve));
  await engine?.close();
  await writeFile(join(folder, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
