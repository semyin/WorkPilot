import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { launch, profile } from "./tool-test-support.mjs";
const output = resolve(
  process.env.WORKPILOT_TEST_OUTPUT || ".test-results/project-transfer-engine",
);
await mkdir(output, { recursive: true });
const base = await mkdtemp(join(output, "中文 项目-"));
const binary = process.env.WORKPILOT_ENGINE_BINARY || resolve("target/debug/workpilot-engine.exe");
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  binarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  checks: [],
};
const passphrase = "fixture settings migration passphrase",
  key = "SYNTHETIC-MODEL-CREDENTIAL-SETTINGS-P12";
let source, target;
const ownedProfiles = [];
async function request(e, command) {
  const r = await e.request(command);
  assert.notEqual(r.kind, "error", JSON.stringify(r));
  return r;
}
async function project(e, folder, name, model = null) {
  return (
    await request(e, {
      kind: "workspace",
      action: {
        kind: "save_project",
        project_id: null,
        settings: {
          name,
          root_path: folder,
          default_profile_id: model,
          permission: "full_access",
          rules: "保留原项目规则",
          revision: 0,
        },
      },
    })
  ).data.project;
}
async function memory(e, project_id, text) {
  return (
    await request(e, {
      kind: "memory",
      action: { kind: "save", memory_id: null, revision: 0, project_id, text },
    })
  ).data.memory_id;
}
const transfer = (e, action) => e.request({ kind: "project_transfer", action });
const ok = async (e, action) => (await request(e, { kind: "project_transfer", action })).data;
const overview = async (e) =>
  (await request(e, { kind: "read", query: { kind: "workspace", query: { kind: "overview" } } }))
    .data;
const models = async (e) =>
  (await request(e, { kind: "read", query: { kind: "profiles" } })).catalog;
const sourceData = join(base, "source-data"),
  targetData = join(base, "target-data");
try {
  const sourceFolder = join(base, "原项目"),
    otherFolder = join(base, "另一个源项目"),
    targetFolder = join(base, "目标项目"),
    existingFolder = join(base, "保留项目");
  for (const p of [sourceData, targetData, sourceFolder, otherFolder, targetFolder, existingFolder])
    await mkdir(p);
  source = await launch(sourceData);
  const p = profile("messages", "source-fixture");
  p.auth = "api_key";
  const saved = await request(source, {
    kind: "save_provider",
    profile: p,
    secret: key,
    clear_credential: false,
  });
  ownedProfiles.push(saved.profile.profile);
  const src = await project(source, sourceFolder, "原项目", p.id),
    other = await project(source, otherFolder, "其他项目");
  const local = await memory(source, src.id, "按项目约定使用中文"),
    global = await memory(source, null, "回答应简洁"),
    foreign = await memory(source, other.id, "不能导入其它项目的这条记忆");
  const archive = join(base, "项目 设置.wpsettings");
  const exp = {
    kind: "export",
    project_id: src.id,
    profile_ids: [p.id],
    memory_ids: [local, global],
    path: archive,
    password: passphrase,
  };
  assert.equal((await transfer(source, { ...exp, memory_ids: [foreign] })).kind, "error");
  // Only move the fixture directory allocated by this test, never a user project.
  assert(resolve(sourceFolder).startsWith(base + sep));
  assert(resolve(sourceFolder + "-offline").startsWith(base + sep));
  await rename(sourceFolder, sourceFolder + "-offline");
  await ok(source, exp);
  const bytes = await readFile(archive);
  assert(!bytes.includes(Buffer.from(key)));
  assert(!bytes.includes(Buffer.from(passphrase)));
  assert(!bytes.includes(Buffer.from("保留原项目规则")));
  assert.equal((await transfer(source, exp)).kind, "error");
  assert.deepEqual(await readFile(archive), bytes);
  report.checks.push(
    "offline_source_metadata_exports_selected_scope_without_plaintext_credentials_and_never_overwrites_archive",
  );
  for (const p of ownedProfiles)
    await request(source, {
      kind: "delete_provider",
      profile_id: p.id,
      expected_revision: p.revision,
    });
  ownedProfiles.length = 0;
  await source.close();
  source = null;
  target = await launch(targetData);
  const existingModel = profile("responses", "existing-fixture");
  await request(target, {
    kind: "save_provider",
    profile: existingModel,
    secret: null,
    clear_credential: false,
  });
  await request(target, {
    kind: "set_default_profile",
    scope: { kind: "global" },
    profile_id: existingModel.id,
  });
  const existing = await project(target, existingFolder, "保留项目", existingModel.id);
  const before = await models(target),
    beforeProjects = (await overview(target)).projects;
  await writeFile(join(targetFolder, "keep.txt"), "keep user content");
  const inspect = {
    kind: "inspect",
    path: archive,
    password: passphrase,
    root_path: targetFolder,
    name: "迁移项目",
  };
  assert.equal(
    (await transfer(target, { ...inspect, password: "incorrect fixture passphrase" })).kind,
    "error",
  );
  const damaged = join(base, "damaged.wpsettings"),
    bad = Buffer.from(bytes);
  bad[bad.length - 1] ^= 1;
  await writeFile(damaged, bad);
  assert.equal((await transfer(target, { ...inspect, path: damaged })).kind, "error");
  assert.deepEqual((await overview(target)).projects, beforeProjects);
  const blocked = await ok(target, {
    ...inspect,
    root_path: existingFolder,
    name: existing.settings.name,
  });
  assert(blocked.conflicts.length >= 2);
  assert.equal(
    (
      await transfer(target, {
        ...inspect,
        kind: "import",
        root_path: existingFolder,
        name: existing.settings.name,
        fingerprint: blocked.fingerprint,
      })
    ).kind,
    "error",
  );
  const preview = await ok(target, inspect);
  assert.equal(preview.memories.length, 2);
  assert.equal(preview.profiles.length, 1);
  assert.equal(preview.profiles[0].credential, null);
  assert.equal(preview.permission, "request_approval");
  assert(preview.credentials_required);
  const imp = { ...inspect, kind: "import", fingerprint: preview.fingerprint };
  assert.equal((await transfer(target, { ...imp, name: "不同目标名称" })).kind, "error");
  assert.deepEqual(await models(target), before);
  report.checks.push(
    "wrong_password_damage_foreign_scope_conflicts_and_stale_preview_cannot_modify_existing_projects_or_models",
  );
  const result = await ok(target, imp),
    projectId = result.receipt.project_id;
  const imported = (await overview(target)).projects.find((p) => p.id === projectId);
  assert.equal(imported.settings.permission, "request_approval");
  assert.equal(imported.settings.rules, "保留原项目规则");
  assert.notEqual(imported.settings.default_profile_id, p.id);
  const after = await models(target);
  assert.equal(after.global_default, before.global_default);
  assert.deepEqual(
    after.profiles.find((p) => p.profile.id === existingModel.id),
    before.profiles[0],
  );
  const copy = after.profiles.find((p) => p.profile.id === imported.settings.default_profile_id);
  assert.equal(copy.credential_saved, false);
  assert.equal(copy.profile.credential, null);
  assert.equal(copy.profile.auth, "api_key");
  const mem = (
    await request(target, {
      kind: "memory",
      action: {
        kind: "list",
        project_id: projectId,
        search: "",
        include_deleted: false,
        offset: 0,
        limit: 64,
      },
    })
  ).data.items;
  assert.equal(mem.length, 2);
  assert.equal(mem.filter((m) => m.project_id === projectId).length, 1);
  assert(mem.every((m) => m.source_task_id === null && m.change === "imported_and_confirmed"));
  assert.equal(await readFile(join(targetFolder, "keep.txt"), "utf8"), "keep user content");
  assert.equal(
    (await overview(target)).projects.find((p) => p.id === existing.id).settings.permission,
    "full_access",
  );
  report.checks.push(
    "atomic_import_preserves_existing_models_default_project_files_and_maps_memory_scope_with_credentials_missing",
  );
  assert.equal((await ok(target, imp)).duplicate, true);
  assert.deepEqual(await models(target), after);
  await target.close();
  target = null;
  target = await launch(targetData);
  assert.equal((await ok(target, inspect)).already_imported, true);
  assert.equal((await ok(target, imp)).duplicate, true);
  assert.equal((await overview(target)).projects.length, 2);
  await target.close();
  target = null;
  async function scan(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) await scan(path);
      else
        assert(!(await readFile(path)).includes(Buffer.from(passphrase)), "passphrase persisted");
    }
  }
  await scan(sourceData);
  await scan(targetData);
  report.checks.push("repeat_and_restart_do_not_duplicate_data_and_passphrase_is_not_persisted");
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = String(e.stack || e);
  process.exitCode = 1;
} finally {
  if (source)
    for (const p of ownedProfiles)
      await source
        .request({ kind: "delete_provider", profile_id: p.id, expected_revision: p.revision })
        .catch(() => {});
  await source?.close();
  await target?.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
