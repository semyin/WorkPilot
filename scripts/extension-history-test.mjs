import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rename, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { launch, create, start, terminal, setFixture } from "./tool-test-support.mjs";
import { installExtension, extensionAdmin } from "./extension-transfer-fixtures.mjs";
import { skillFiles, writeSkillPackage } from "./extension-history-fixtures.mjs";
import { startToolFixture } from "../services/execution-fixtures/tools.mjs";

const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/extension-history");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "版本 草稿-"));
const sourceData = join(directory, "source-data"),
  targetData = join(directory, "target-data");
const binary = process.env.WORKPILOT_ENGINE_BINARY || resolve("target/debug/workpilot-engine.exe");
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  binarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  checks: [],
};
const fixture = await startToolFixture();
setFixture(fixture);
const password = "retained versions fixture passphrase";
let source, target, third;
const admin = (engine, action) => extensionAdmin(engine.request, null, action);
const raw = (engine, action) =>
  engine.request({ kind: "extension_transfer", task_id: null, action });
const transfer = async (engine, action) => {
  const response = await raw(engine, action);
  assert.equal(response.kind, "workbench", JSON.stringify(response));
  return response.data;
};
const selection = (item) => ({ installation_id: item.id, revision: item.revision });
async function draft(engine, name, files) {
  fixture.recipes.set(name, [{ name: "skill_draft", args: { project: false, files } }]);
  const task = await create(engine, "responses", name, { mode: "plan", controlled_tools: false });
  await start(engine, task);
  assert.equal((await terminal(engine, task)).task.state, "awaiting_input");
  const previews = (await admin(engine, { kind: "catalog", query: null })).previews;
  const text = JSON.parse(files.find((file) => file.path === "workpilot-plugin.json").text);
  const result = previews.find(
    (p) => p.version.manifest.id === text.id && p.version.manifest.version === text.version,
  );
  assert(result?.draft);
  return result;
}
async function current(engine, id) {
  return (await transfer(engine, { kind: "catalog" })).items.find(
    (item) => item.installation.id === id,
  ).installation;
}
try {
  source = await launch(sourceData);
  const folder = join(directory, "source-packages/history");
  let latest, first;
  for (let n = 0; n < 70; n++) {
    await writeSkillPackage(folder, "migration-history", `1.${n}.0`, "Saved version " + n);
    latest = await installExtension(source.request, null, folder, false, false);
    first ||= latest;
  }
  const removedFolder = join(directory, "source-packages/removed");
  await writeSkillPackage(removedFolder, "migration-removed", "1.0.0", "Keep uninstalled.");
  const installed = await installExtension(source.request, null, removedFolder, false, false);
  const removed = (
    await admin(source, {
      kind: "uninstall",
      installation_id: installed.id,
      revision: installed.revision,
    })
  ).installation;
  const pending = await draft(
    source,
    "source-draft",
    skillFiles("migration-history", "2.0.0", "Pending draft text."),
  );
  const sourceCatalog = await transfer(source, { kind: "catalog" });
  assert(
    sourceCatalog.items.some(
      (item) => item.installation.id === removed.id && !item.installation.installed,
    ),
  );
  assert(sourceCatalog.drafts.some((item) => item.id === pending.id));
  const archive = join(directory, "complete.wpextensions");
  const exporting = {
    kind: "export",
    selections: [selection(latest), selection(removed)],
    include_history: true,
    draft_ids: [pending.id],
    path: archive,
    password,
  };
  assert.equal((await transfer(source, exporting)).extensions, 3);
  const bytes = await readFile(archive);
  assert(!bytes.includes(Buffer.from(password)));
  assert(!bytes.includes(Buffer.from("Pending draft text.")));
  const originalFiles = await Promise.all(
    skillFiles("migration-history", "1.0.0", "Saved version 0").map(async (file) => ({
      path: file.path,
      text: await readFile(
        join(sourceData, "test/extensions/versions", first.active_digest, file.path),
      ),
    })),
  );
  const oldFile = join(sourceData, "test/extensions/versions", first.active_digest, "SKILL.md");
  const original = await readFile(oldFile);
  await writeFile(oldFile, "damaged old version");
  try {
    assert.equal(
      (await raw(source, { ...exporting, path: join(directory, "bad-source.wpextensions") })).kind,
      "error",
    );
    await assert.rejects(access(join(directory, "bad-source.wpextensions")));
    const currentOnly = join(directory, "current-only.wpextensions");
    await transfer(source, { ...exporting, include_history: false, path: currentOnly });
    const preview = await transfer(source, { kind: "inspect", path: currentOnly, password });
    assert(preview.entries.every((entry) => entry.versions.length === 0));
  } finally {
    await writeFile(oldFile, original);
  }
  await source.close();
  source = null;
  await rename(sourceData, sourceData + "-offline");
  await rename(join(directory, "source-packages"), join(directory, "source-packages-offline"));
  report.checks.push(
    "all_70_versions_and_pending_draft_and_uninstalled_state_export_encrypted_bad_old_source_refused_current_only_remains_available",
  );

  target = await launch(targetData);
  const inspecting = { kind: "inspect", path: archive, password };
  let preview = await transfer(target, inspecting);
  assert.equal(preview.entries.length, 3);
  assert.equal(preview.entries.find((entry) => entry.source_id === latest.id).versions.length, 69);
  assert.equal(preview.entries.find((entry) => entry.source_id === removed.id).installed, false);
  assert.equal(preview.entries.find((entry) => entry.source_id === pending.id).draft, true);
  const oldTarget = join(targetData, "test/extensions/versions", first.active_digest);
  await mkdir(oldTarget, { recursive: true });
  for (const file of originalFiles) await writeFile(join(oldTarget, file.path), file.text);
  await writeFile(join(oldTarget, "SKILL.md"), "damaged retained destination");
  assert.equal(
    (await raw(target, { ...inspecting, kind: "import", fingerprint: preview.fingerprint })).kind,
    "error",
  );
  assert.equal((await admin(target, { kind: "catalog", query: "migration" })).items.length, 0);
  assert.equal((await transfer(target, { kind: "catalog" })).drafts.length, 0);
  await writeFile(join(oldTarget, "SKILL.md"), original);
  preview = await transfer(target, inspecting);
  const imported = await transfer(target, {
    ...inspecting,
    kind: "import",
    fingerprint: preview.fingerprint,
  });
  const mappings = imported.receipt.installations;
  const id = mappings.find((entry) => entry.source_id === latest.id).installation_id;
  const removedId = mappings.find((entry) => entry.source_id === removed.id).installation_id;
  const draftId = imported.receipt.drafts[0].preview_id;
  assert.notEqual(id, latest.id);
  assert.notEqual(draftId, pending.id);
  assert.equal((await current(target, id)).enabled, false);
  assert.equal((await current(target, removedId)).installed, false);
  const versions = await admin(target, { kind: "versions", installation_id: id });
  assert.equal(new Set(versions.history.map((item) => item.data.active_digest)).size, 70);
  report.checks.push(
    "bad_old_destination_rolls_back_all_visible_installations_and_drafts_then_retry_restores_all_70_versions",
  );

  let active = await current(target, id);
  active = await admin(target, {
    kind: "rollback",
    installation_id: id,
    revision: active.revision,
    digest: first.active_digest,
  });
  assert.equal(active.enabled, false);
  const oldResource = await admin(target, {
    kind: "read_resource",
    installation_id: id,
    revision: active.revision,
    path: "SKILL.md",
  });
  assert.match(oldResource.text, /Saved version 0/);
  const foreignDigest = (await current(target, removedId)).active_digest;
  assert.equal(
    (
      await target.request({
        kind: "extensions",
        task_id: null,
        action: {
          kind: "rollback",
          installation_id: id,
          revision: active.revision,
          digest: foreignDigest,
        },
      })
    ).kind,
    "error",
  );
  report.checks.push(
    "oldest_version_beyond_64_row_history_page_can_roll_back_without_enabling_and_other_package_version_is_refused",
  );

  const savedDraft = await admin(target, { kind: "preview_draft", draft_id: draftId });
  assert.equal(savedDraft.installed_id, id);
  const resources = [];
  for (const file of savedDraft.version.files) {
    const resource = await admin(target, {
      kind: "preview_resource",
      draft_id: draftId,
      path: file.path,
    });
    assert(resource.text);
    resources.push({ path: file.path, text: resource.text });
  }
  const draftText = resources.find((file) => file.path === "SKILL.md");
  assert.match(draftText.text, /Pending draft text/);
  draftText.text += "User requested revision after migration.\n";
  const manifest = resources.find((file) => file.path === "workpilot-plugin.json");
  manifest.text = JSON.stringify({ ...JSON.parse(manifest.text), version: "2.1.0" });
  const revised = await draft(target, "revise-migrated-draft", resources);
  assert.notEqual(revised.id, draftId);
  assert.equal(revised.expected_revision, active.revision);
  active = await admin(target, {
    kind: "confirm",
    draft_id: revised.id,
    digest: revised.version.digest,
    enable: false,
  });
  assert.equal(active.id, id);
  assert.equal(active.enabled, false);
  assert.match(
    (
      await admin(target, {
        kind: "read_resource",
        installation_id: id,
        revision: active.revision,
        path: "SKILL.md",
      })
    ).text,
    /User requested revision/,
  );
  await admin(target, { kind: "preview_draft", draft_id: draftId });
  report.checks.push(
    "migrated_draft_resources_remain_readable_AI_can_create_a_revised_draft_and_explicit_confirmation_installs_it_without_deleting_original_draft",
  );

  active = (
    await admin(target, { kind: "uninstall", installation_id: id, revision: active.revision })
  ).installation;
  preview = await transfer(target, inspecting);
  assert.equal(preview.already_imported, true);
  assert.equal(
    (await transfer(target, { ...inspecting, kind: "import", fingerprint: preview.fingerprint }))
      .duplicate,
    true,
  );
  assert.equal((await current(target, id)).installed, false);
  const again = join(directory, "roundtrip.wpextensions");
  await transfer(target, {
    kind: "export",
    selections: [selection(active), selection(await current(target, removedId))],
    include_history: true,
    draft_ids: [draftId],
    path: again,
    password,
  });
  await target.close();
  target = await launch(targetData);
  preview = await transfer(target, inspecting);
  assert.equal(
    (await transfer(target, { ...inspecting, kind: "import", fingerprint: preview.fingerprint }))
      .duplicate,
    true,
  );
  assert.equal((await current(target, id)).installed, false);
  third = await launch(join(directory, "third-data"));
  const roundtrip = { kind: "inspect", path: again, password };
  preview = await transfer(third, roundtrip);
  assert.equal(
    preview.entries.filter((entry) => !entry.draft).every((entry) => !entry.installed),
    true,
  );
  const latestHistory = preview.entries.find((entry) => entry.source_id === id);
  assert.equal(latestHistory.versions.length, 70);
  await transfer(third, { ...roundtrip, kind: "import", fingerprint: preview.fingerprint });
  assert.equal((await transfer(third, { kind: "catalog" })).drafts.length, 1);
  report.checks.push(
    "reexport_and_restart_keep_earlier_versions_pending_draft_and_uninstalled_state_duplicate_import_never_reinstalls",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  await source?.close().catch(() => {});
  await target?.close().catch(() => {});
  await third?.close().catch(() => {});
  await fixture.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
