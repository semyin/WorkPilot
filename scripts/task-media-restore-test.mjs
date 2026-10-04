import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, access, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  launch,
  create,
  profile,
  setFixture,
  start,
  terminal,
  snapshot,
  until,
} from "./tool-test-support.mjs";
import { startToolFixture } from "../services/execution-fixtures/tools.mjs";
import { generateDocument } from "../services/documents/write.mjs";
import { media, uploadMedia } from "./media-transfer-support.mjs";

const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/task-media-restore");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "session-"));
const binary = process.env.WORKPILOT_ENGINE_BINARY || resolve("target/debug/workpilot-engine.exe");
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  binarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  service: "Real attachment workers and separate engines; synthetic local three-protocol models",
  checks: [],
};
const fixture = await startToolFixture();
setFixture(fixture);
const password = "task attachment fixture " + crypto.randomUUID();
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xkAAAAASUVORK5CYII=",
  "base64",
);
const docx = Buffer.from(
  await generateDocument(
    "docx",
    {
      title: "Portable Word 42",
      sections: [{ heading: "Evidence", paragraphs: ["Original Word evidence 007"] }],
    },
    resolve("services/documents"),
  ),
);
const admin = (e, t, a) => media(e.request, t, a);
const action = async (e, a) => {
  const r = await e.request({ kind: "task_archive", action: a });
  assert.equal(r.kind, "workbench", JSON.stringify(r));
  return r.data;
};
const refused = (r) => assert(["error", "model_error"].includes(r.kind), JSON.stringify(r));
const exists = (p) =>
  access(p).then(
    () => true,
    () => false,
  );
const mark = (a) => `[workpilot-file:${a.id}]`;
const check = (name) => report.checks.push({ name, passed: true });
let source, target;
const privateProfiles = [];
async function saveProfile(engine, p) {
  const r = await engine.request({
    kind: "save_provider",
    profile: p,
    secret: null,
    clear_credential: false,
  });
  assert.equal(r.kind, "provider_saved", JSON.stringify(r));
  return r.profile || p;
}
async function importArchive(engine, path) {
  const p = await action(engine, { kind: "inspect", path, password });
  const r = await action(engine, { kind: "import", path, password, fingerprint: p.fingerprint });
  return { id: r.archive_id, preview: p };
}
try {
  source = await launch(join(directory, "source"));
  target = await launch(join(directory, "target"));
  const stranger = await create(source, "responses", "foreign-media");
  const foreign = await uploadMedia(
    source.request,
    stranger,
    "foreign.txt",
    Buffer.from("FOREIGN_ONLY_900"),
  );
  for (const protocol of ["chat_completions", "responses", "messages"]) {
    const name = "media-restore-" + protocol;
    const task = await create(source, protocol, name, { controlled_tools: false });
    const live = await uploadMedia(
      source.request,
      task,
      "原始资料.txt",
      Buffer.from("Attachment source evidence 42\nSecond line 007"),
    );
    const hidden = await uploadMedia(
      source.request,
      task,
      "尚未发送.txt",
      Buffer.from("UNSUBMITTED_ONLY_551"),
    );
    const removed = await uploadMedia(
      source.request,
      task,
      "已移除.txt",
      Buffer.from("REMOVED_ONLY_229"),
    );
    const word = await uploadMedia(source.request, task, "中文 报告.docx", docx);
    const picture = await uploadMedia(source.request, task, "图片.png", png);
    const original = (await snapshot(source, task)).config.profile_id;
    const catalog = await source.request({ kind: "read", query: { kind: "profiles" } });
    const originalProfile = catalog.catalog.profiles.find((p) => p.profile.id === original).profile;
    const local = profile(protocol, name);
    for (const p of [originalProfile, local]) {
      p.supports_images = true;
      p.capabilities.images = { supported: true, source: "user", checked_at_ms: null };
    }
    await saveProfile(source, originalProfile);
    await saveProfile(target, local);
    let phase = "source",
      baseline = null;
    const seen = [];
    fixture.recipes.set(name, (results, body) => {
      if (phase === "source")
        return results.length
          ? fixture.done("Source attachment read 42")
          : fixture.tool("document_read", { asset_id: live.id, start: 0, limit: 3 });
      baseline ??= results.length;
      const delta = results.length - baseline;
      if (delta === 0) {
        const encoded = JSON.stringify(body);
        assert(encoded.includes("image/png") && encoded.includes("base64"));
        assert(!encoded.includes("UNSUBMITTED_ONLY_551"));
        assert(!encoded.includes("REMOVED_ONLY_229"));
      } else seen.push(JSON.parse(results.at(-1)));
      return (
        [
          () => fixture.tool("document_list", {}),
          () => fixture.tool("document_read", { asset_id: live.id, start: 0, limit: 3 }),
          () => fixture.tool("document_read", { asset_id: hidden.id, start: 0, limit: 1 }),
          () => fixture.tool("document_read", { asset_id: removed.id, start: 0, limit: 1 }),
          () => fixture.tool("document_read", { asset_id: foreign.id, start: 0, limit: 1 }),
          () => fixture.tool("document_read", { asset_id: word.id, start: 0, limit: 10 }),
        ][delta]?.() || fixture.done("Restored attachments read 007")
      );
    });
    await source.request({ kind: "enqueue", task_id: task, text: "Read first " + mark(live) });
    await start(source, task);
    assert.equal((await terminal(source, task)).task.state, "completed");
    await admin(source, task, { kind: "remove", asset_id: removed.id });
    await source.request({
      kind: "enqueue",
      task_id: task,
      text: "Read next " + mark(word) + mark(picture),
    });
    const before = await snapshot(source, task);
    const path = join(directory, protocol + ".wptask");
    const exported = await action(source, { kind: "export", task_id: task, path, password });
    assert.equal(exported.summary.included_media, 5);
    assert.equal(exported.summary.excluded_media, 0);
    const raw = await readFile(path);
    assert(!raw.includes(Buffer.from("Attachment source evidence 42")));
    assert(!raw.includes(docx));
    const imported = await importArchive(target, path);
    assert.equal(imported.preview.summary.included_media, 5);
    const options = { archive_id: imported.id, project_id: null, profile_id: local.id };
    if (protocol === "chat_completions") {
      refused(
        await target.request({
          kind: "task_archive",
          action: { kind: "inspect", path, password: password + "wrong" },
        }),
      );
      const damaged = Buffer.from(raw);
      damaged[damaged.length - 1] ^= 1;
      const broken = join(directory, "tampered.wptask");
      await writeFile(broken, damaged);
      refused(
        await target.request({
          kind: "task_archive",
          action: { kind: "inspect", path: broken, password },
        }),
      );
      const pending = target.request({
        kind: "task_archive",
        action: { kind: "restore_preview", ...options },
      });
      await until(async () => (await action(target, { kind: "cancel" })).cancel_requested, 5000);
      refused(await pending);
      assert.equal((await action(target, { kind: "cancel" })).cancel_requested, false);
      check("wrong_passphrase_tamper_and_worker_cancellation_leave_archive_readable");
    }
    let plan = await action(target, { kind: "restore_preview", ...options });
    assert.equal(plan.attachments.length, 5);
    assert.equal(plan.attachments.filter((a) => a.removed).length, 1);
    const beforeCalls = fixture.records.length;
    const restored = await action(target, {
      kind: "restore",
      ...options,
      fingerprint: plan.fingerprint,
    });
    assert.equal(fixture.records.length, beforeCalls);
    const next = restored.task_id;
    const assets = (await admin(target, next, { kind: "list" })).assets;
    assert.equal(assets.length, 4);
    for (const a of assets) {
      assert.equal(a.task_id, next);
      assert.equal(a.path, null);
      assert.equal(a.operation_id, null);
      assert.notEqual(a.id, a.origin.asset_id);
    }
    const note = assets.find((a) => a.name === live.name);
    assert.equal(note.sha256, live.sha256);
    assert(
      JSON.stringify(
        await admin(target, next, { kind: "read", asset_id: note.id, start: 0, limit: 3 }),
      ).includes("evidence 42"),
    );
    refused(
      await target.request({
        kind: "media",
        task_id: next,
        action: { kind: "remove", asset_id: live.id },
      }),
    );
    const after = await snapshot(target, next);
    assert.equal(after.latest_run, null);
    assert.deepEqual(after.context.history, before.context.history);
    assert.equal(after.messages[1].state, "queued");
    const originalVault = join(directory, "target/test/versions", live.sha256);
    assert(await exists(originalVault));
    assert(!(await readFile(originalVault)).includes(Buffer.from("Attachment source evidence 42")));
    phase = "restored";
    await start(target, next);
    assert.equal((await terminal(target, next)).task.state, "completed");
    assert.equal(seen.length, 6);
    assert.deepEqual(
      seen[0].assets.map((a) => a.name).sort(),
      [live.name, word.name, picture.name].sort(),
    );
    assert(JSON.stringify(seen[1]).includes("Attachment source evidence 42"));
    for (const i of [2, 3, 4]) assert(seen[i].error, JSON.stringify(seen[i]));
    assert(JSON.stringify(seen[5]).includes("Original Word evidence 007"));
    assert.deepEqual(await snapshot(source, task), before);
    check(
      protocol +
        "_encrypted_originals_reparsed_old_ids_read_actual_images_sent_and_undelivered_removed_foreign_assets_denied",
    );
    // Re-export the restored task, remove the old vault object briefly, and verify
    // it fails explicitly rather than inventing an empty replacement attachment.
    const second = join(directory, protocol + "-again.wptask");
    await action(target, { kind: "export", task_id: next, path: second, password });
    const again = await importArchive(target, second);
    const secondOptions = { ...options, archive_id: again.id };
    if (protocol === "chat_completions") {
      await rename(originalVault, originalVault + ".held");
      try {
        refused(
          await target.request({
            kind: "task_archive",
            action: { kind: "restore_preview", ...secondOptions },
          }),
        );
      } finally {
        await rename(originalVault + ".held", originalVault);
      }
    }
    plan = await action(target, { kind: "restore_preview", ...secondOptions });
    const secondRestore = await action(target, {
      kind: "restore",
      ...secondOptions,
      fingerprint: plan.fingerprint,
    });
    await target.close();
    target = await launch(join(directory, "target"));
    const duplicate = await action(target, {
      kind: "restore",
      ...secondOptions,
      fingerprint: plan.fingerprint,
    });
    assert.equal(duplicate.task_id, secondRestore.task_id);
    assert.equal(duplicate.duplicate, true);
    baseline = null;
    seen.length = 0;
    await target.request({
      kind: "enqueue",
      task_id: duplicate.task_id,
      text: "Read again from old citations",
    });
    await start(target, duplicate.task_id);
    assert.equal((await terminal(target, duplicate.task_id)).task.state, "completed");
    assert(JSON.stringify(seen[1]).includes("Attachment source evidence 42"));
    const copy = join(directory, protocol + "-saved.wptask");
    await action(target, { kind: "export_saved", archive_id: imported.id, path: copy, password });
    assert.equal(
      (await action(target, { kind: "inspect", path: copy, password })).summary.included_media,
      5,
    );
    check(
      protocol + "_second_migration_old_citations_restart_duplicate_and_saved_archive_reexport",
    );
  }
  const credentialTask = await create(source, "responses", "archive-credential-check");
  const canary = "ARCHIVE-ATTACHMENT-CREDENTIAL-" + crypto.randomUUID();
  await uploadMedia(source.request, credentialTask, "registered-later.txt", Buffer.from(canary));
  const sensitive = join(directory, "credential-fixture.wptask");
  await action(source, { kind: "export", task_id: credentialTask, path: sensitive, password });
  const savedSensitive = await importArchive(target, sensitive);
  for (const engine of [source, target]) {
    const p = { ...profile("responses", "registered-credential"), auth: "bearer" };
    const r = await engine.request({
      kind: "save_provider",
      profile: p,
      secret: canary,
      clear_credential: false,
    });
    assert.equal(r.kind, "provider_saved", JSON.stringify(r));
    privateProfiles.push({ engine, profile: p });
  }
  refused(
    await source.request({
      kind: "task_archive",
      action: {
        kind: "export",
        task_id: credentialTask,
        path: join(directory, "must-not-export.wptask"),
        password,
      },
    }),
  );
  refused(
    await target.request({
      kind: "task_archive",
      action: { kind: "inspect", path: sensitive, password },
    }),
  );
  refused(
    await target.request({
      kind: "task_archive",
      action: {
        kind: "export_saved",
        archive_id: savedSensitive.id,
        path: join(directory, "must-not-reexport.wptask"),
        password,
      },
    }),
  );
  assert.equal(await exists(join(directory, "must-not-export.wptask")), false);
  assert.equal(await exists(join(directory, "must-not-reexport.wptask")), false);
  check("credentials_registered_after_upload_block_export_import_and_saved_archive_reexport");
  assert(fixture.records.every((r) => r.correlationValid));
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  for (const { engine, profile: p } of privateProfiles) {
    await engine
      .request({ kind: "delete_provider", profile_id: p.id, expected_revision: p.revision })
      .catch(() => {});
  }
  await source?.close();
  await target?.close();
  await fixture.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
