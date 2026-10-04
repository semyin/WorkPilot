import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { launch, create } from "./tool-test-support.mjs";
import { uploadMedia, media } from "./media-transfer-support.mjs";
import { generateDocument } from "../services/documents/write.mjs";

if (process.platform !== "win32") throw new Error("This Office regression requires Windows");
const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/office-path");
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, "session-"));
const binary =
  process.env.WORKPILOT_ENGINE_BINARY || resolve("target/release/workpilot-engine.exe");
process.env.WORKPILOT_ENGINE_BINARY = binary;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const recipes = {
  docx: {
    title: "迁移标题",
    sections: [{ heading: "文档原内容", paragraphs: ["Original Word content 42"] }],
  },
  xlsx: {
    sheets: [
      {
        name: "收入",
        rows: [
          ["项目", "金额"],
          ["收入", 25],
          ["其他", 17],
          ["合计", 42],
        ],
      },
    ],
  },
  pptx: {
    title: "长目录预览",
    slides: [{ title: "合计 42", body: ["同一份文件，完整保留原版式。"] }],
  },
};
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  binarySha256: hash(await readFile(binary)),
  checks: [],
  renders: [],
};
const files = new Map(),
  images = new Map();
let engine;
try {
  for (const [format, recipe] of Object.entries(recipes)) {
    const bytes = Buffer.from(
      await generateDocument(format, recipe, resolve("services/documents")),
    );
    files.set(format, bytes);
    await writeFile(join(root, `source.${format}`), bytes);
  }
  for (const target of [null, 165, 205]) {
    const prefix = "中文 空格 ";
    const name =
      target === null ? "short" : prefix + "x".repeat(target - join(root, prefix, "test").length);
    const directory = join(root, name);
    const pathCharacters = join(directory, "test").length;
    if (target !== null) assert.equal(pathCharacters, target);
    engine = await launch(directory);
    const task = await create(engine, "responses", "same-files-long-path");
    let doc;
    for (const [format, bytes] of files) {
      report.current = { phase: "upload", format, pathCharacters };
      const uploadAt = performance.now();
      const asset = await uploadMedia(engine.request, task, `中文 原件.${format}`, bytes);
      const uploadMs = Math.round(performance.now() - uploadAt);
      if (format === "docx") doc = asset;
      report.current.phase = "preview";
      const begin = performance.now();
      const first = await media(engine.request, task, {
        kind: "preview",
        asset_id: asset.id,
        page: 1,
      });
      const elapsedMs = Math.round(performance.now() - begin);
      assert.equal(first.conversion, true);
      assert.equal(first.source_sha256, hash(bytes));
      assert.equal(first.cache_hit, false);
      assert.equal(first.pages, 1);
      const png = Buffer.from(first.image.split(",")[1], "base64");
      assert.equal(png.subarray(1, 4).toString(), "PNG");
      if (images.has(format)) assert.equal(hash(png), images.get(format));
      else images.set(format, hash(png));
      await writeFile(join(output, `${target || "short"}-${format}.png`), png);
      const cached = await media(engine.request, task, {
        kind: "preview",
        asset_id: asset.id,
        page: 1,
      });
      assert.equal(cached.cache_hit, true);
      assert.equal(cached.image, first.image);
      assert.equal(hash(await readFile(join(root, `source.${format}`))), hash(bytes));
      report.renders.push({
        format,
        pathCharacters,
        uploadMs,
        elapsedMs,
        sha256: asset.sha256,
        imageSha256: hash(png),
      });
    }
    report.checks.push(
      `same_docx_xlsx_pptx_original_bytes_and_identical_layout_at_${pathCharacters}_characters`,
    );
    if (target === 205) {
      const runtime = join(directory, "test/media/runtime");
      const entries = await readdir(runtime);
      const program = join(
        runtime,
        entries.find((v) => /^[a-f0-9]{64}$/.test(v)),
        "node.exe",
      );
      assert(program.length > 260);
      assert((await readFile(program)).subarray(0, 2).equals(Buffer.from("MZ")));
      report.runtimePathCharacters = program.length;
      report.checks.push("document_runtime_cache_above_260_characters_installs_and_runs");
      const changed = Buffer.from(
        await generateDocument(
          "docx",
          {
            title: "取消后可以继续预览 99",
            sections: [{ paragraphs: ["Independent restart sample."] }],
          },
          resolve("services/documents"),
        ),
      );
      const fresh = await uploadMedia(engine.request, task, "重新预览.docx", changed);
      const pending = engine.request({
        kind: "media",
        task_id: task,
        action: { kind: "preview", asset_id: fresh.id, page: 1 },
      });
      await new Promise((r) => setTimeout(r, 150));
      const stopAt = performance.now();
      await media(engine.request, task, { kind: "cancel_preview", asset_id: fresh.id });
      report.cancelAcknowledgedMs = Math.round(performance.now() - stopAt);
      assert.equal((await pending).kind, "error");
      report.cancelCompletedMs = Math.round(performance.now() - stopAt);
      const next = await media(engine.request, task, {
        kind: "preview",
        asset_id: fresh.id,
        page: 1,
      });
      assert.equal(next.source_sha256, hash(changed));
      report.checks.push("long_path_cancellation_finishes_and_a_new_preview_succeeds");
      await engine.close();
      engine = await launch(directory);
      const restarted = await media(engine.request, task, {
        kind: "preview",
        asset_id: doc.id,
        page: 1,
      });
      assert.equal(restarted.cache_hit, false);
      assert.equal(restarted.source_sha256, hash(files.get("docx")));
      assert.equal(hash(Buffer.from(restarted.image.split(",")[1], "base64")), images.get("docx"));
      report.checks.push(
        "restart_reopens_original_encrypted_snapshot_and_renders_without_old_cache",
      );
    }
    await engine.close();
    engine = null;
  }
  report.status = "passed";
  delete report.current;
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  await engine?.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
