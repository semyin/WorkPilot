import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, readdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { launch, create, until } from "./tool-test-support.mjs";
import {
  makeExtensionFixtures,
  installExtension,
  extensionAdmin,
  templateBytes,
} from "./extension-transfer-fixtures.mjs";
import { startExtensionFixture } from "../services/extension-fixtures/server.mjs";

const output = resolve(
  process.env.WORKPILOT_TEST_OUTPUT || ".test-results/extension-transfer-engine",
);
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(output, "session-"));
const sourceData = join(root, "source-data"),
  targetData = join(root, "target-data");
const binary =
  process.env.WORKPILOT_ENGINE_BINARY ||
  resolve("target/debug/workpilot-engine" + (process.platform === "win32" ? ".exe" : ""));
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  binarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  checks: [],
};
const password = "extension backup fixture " + crypto.randomUUID();
const fixture = await startExtensionFixture();
fixture.state.bearer = "portable-fixture-credential-" + crypto.randomUUID();
let source, target, sourceTask, targetTask, sourceTool, targetTool;
const transfer = (engine, task, action) =>
  engine.request({ kind: "extension_transfer", task_id: task, action });
const ok = async (engine, task, action) => {
  const result = await transfer(engine, task, action);
  assert.equal(result.kind, "workbench", JSON.stringify(result));
  return result.data;
};
const admin = (engine, task, action) => extensionAdmin(engine.request, task, action);
const configure = async (engine, task, folder) => {
  const result = await engine.request({
    kind: "configure_task_tools",
    task_id: task,
    settings: {
      root_path: folder,
      permission: "request_approval",
      commands_enabled: true,
      review_profile_id: null,
      revision: 0,
    },
  });
  assert.notEqual(result.kind, "error", JSON.stringify(result));
};
const secret = (installation, value) => ({
  kind: "save_credential",
  installation_id: installation.id,
  revision: installation.revision,
  server_id: "remote",
  key: "authorization",
  secret: value,
});
const selected = (installation) => ({
  installation_id: installation.id,
  revision: installation.revision,
});
try {
  const folders = await makeExtensionFixtures(join(root, "source-resources"), fixture.url);
  const sourceFolder = join(root, "源 项目"),
    targetFolder = join(root, "目标 项目");
  await mkdir(sourceFolder);
  await mkdir(targetFolder);
  await writeFile(join(targetFolder, "keep.txt"), "existing target bytes");
  source = await launch(sourceData);
  sourceTask = await create(source, "responses", "extension-transfer-source");
  await configure(source, sourceTask, sourceFolder);
  const sourceBase = await installExtension(source.request, sourceTask, folders.base, false);
  sourceTool = await installExtension(source.request, sourceTask, folders.tool, true);
  sourceTool = await admin(source, sourceTask, secret(sourceTool, fixture.state.bearer));
  const archive = join(root, "技能 备份.wpextensions");
  const exporting = {
    kind: "export",
    selections: [selected(sourceBase), selected(sourceTool)],
    path: archive,
    password,
  };
  assert.equal((await ok(source, sourceTask, exporting)).extensions, 2);
  assert.equal((await transfer(source, sourceTask, exporting)).kind, "error");
  const bytes = await readFile(archive);
  assert.equal(bytes.subarray(0, 8).toString(), "WPEXT001");
  for (const raw of [fixture.state.bearer, password, "Preserve the user's files."])
    assert(!bytes.includes(Buffer.from(raw)));
  assert.equal(
    (await transfer(source, null, { ...exporting, path: join(root, "wrong-scope") })).kind,
    "error",
  );
  assert.equal(
    (
      await transfer(source, sourceTask, {
        ...exporting,
        path: join(root, "stale"),
        selections: [{ ...selected(sourceTool), revision: 1 }],
      })
    ).kind,
    "error",
  );
  sourceTool = await admin(source, sourceTask, secret(sourceTool, null));
  await source.close();
  source = null;
  await rename(sourceFolder, sourceFolder + "-offline");
  await rename(join(root, "source-resources"), join(root, "source-resources-offline"));
  report.checks.push(
    "selected_current_packages_encrypted_without_credentials_no_overwrite_stale_or_foreign_scope_export_rejected",
  );

  target = await launch(targetData);
  targetTask = await create(target, "responses", "extension-transfer-target");
  await configure(target, targetTask, targetFolder);
  const inspect = { kind: "inspect", path: archive, password };
  assert.equal((await transfer(target, null, inspect)).kind, "error");
  assert.equal(
    (await transfer(target, targetTask, { ...inspect, password: "incorrect fixture passphrase" }))
      .kind,
    "error",
  );
  const damaged = join(root, "damaged.wpextensions");
  const badBytes = Buffer.from(bytes);
  badBytes[badBytes.length - 1] ^= 1;
  await writeFile(damaged, badBytes);
  assert.equal((await transfer(target, targetTask, { ...inspect, path: damaged })).kind, "error");
  let preview = await ok(target, targetTask, inspect);
  assert.equal(preview.entries.length, 2);
  assert.equal(preview.conflicts.length, 0);
  assert.deepEqual(
    preview.entries.map((e) => e.project_scoped),
    [false, true],
  );
  assert(preview.entries[1].warnings.some((s) => s.includes("migration-base")));
  assert.equal(preview.enabled, false);
  assert.equal(preview.credentials_included, false);
  const stale = preview.fingerprint;
  const extra = join(root, "extra-package");
  await mkdir(extra);
  await writeFile(
    join(extra, "SKILL.md"),
    "---\nname: unrelated-fixture\ndescription: Existing unrelated package\n---\nKeep me.\n",
  );
  const unrelated = await installExtension(target.request, targetTask, extra, false);
  assert.equal(
    (await transfer(target, targetTask, { ...inspect, kind: "import", fingerprint: stale })).kind,
    "error",
  );
  assert.equal(
    (await admin(target, targetTask, { kind: "catalog", query: "migration" })).items.length,
    0,
  );
  report.checks.push(
    "preview_maps_project_scope_shows_dependencies_wrong_password_damage_missing_target_and_stale_destination_refused",
  );

  preview = await ok(target, targetTask, inspect);
  const imported = await ok(target, targetTask, {
    ...inspect,
    kind: "import",
    fingerprint: preview.fingerprint,
  });
  assert.equal(imported.duplicate, false);
  let catalog = await admin(target, targetTask, { kind: "catalog", query: "migration" });
  assert.equal(catalog.items.length, 2);
  assert(
    catalog.items.every((item) => !item.installation.enabled && item.installation.revision === 1),
  );
  const baseItem = catalog.items.find((item) => item.installation.slug === "migration-base");
  const toolItem = catalog.items.find((item) => item.installation.slug === "migration-tool");
  targetTool = toolItem.installation;
  assert.equal(baseItem.installation.scope, null);
  assert.notEqual(targetTool.scope, sourceTool.scope);
  assert.notEqual(targetTool.id, sourceTool.id);
  assert.equal(toolItem.servers[0].credential_configured, false);
  assert.equal(toolItem.servers[0].catalog, null);
  assert.deepEqual(
    await readFile(
      join(targetData, "test/extensions/versions", toolItem.version.digest, "assets/template.bin"),
    ),
    templateBytes,
  );
  assert.equal(await readFile(join(targetFolder, "keep.txt"), "utf8"), "existing target bytes");
  assert.equal(
    (await admin(target, null, { kind: "catalog", query: "migration" })).items.length,
    1,
  );
  assert.equal(
    (await admin(target, targetTask, { kind: "catalog", query: "unrelated" })).items[0].installation
      .id,
    unrelated.id,
  );
  assert.equal(fixture.state.calls.length, 0);
  report.checks.push(
    "whole_batch_imports_inactive_new_ids_binary_resources_preserved_global_project_mapping_no_credentials_catalog_or_service_start",
  );

  const enable = (i) => ({
    kind: "set_enabled",
    installation_id: i.id,
    revision: i.revision,
    enabled: true,
  });
  assert.equal(
    (await target.request({ kind: "extensions", task_id: targetTask, action: enable(targetTool) }))
      .kind,
    "error",
  );
  await admin(target, targetTask, enable(baseItem.installation));
  targetTool = await admin(target, targetTask, enable(targetTool));
  const wb = async (action) => {
    const r = await target.request({ kind: "workbench", task_id: targetTask, action });
    assert.equal(r.kind, "workbench", JSON.stringify(r));
    return r.data;
  };
  const finish = async (operation, expected) => {
    assert.equal(operation.state, "awaiting_approval");
    await wb({ kind: "approve", operation_id: operation.id, fingerprint: operation.fingerprint });
    const result = await until(async () => {
      const item = (await wb({ kind: "operation", operation_id: operation.id })).operation;
      return ["completed", "failed", "cancelled"].includes(item.state) && item;
    }, 30000);
    assert.equal(result.state, expected, JSON.stringify(result));
    return result;
  };
  let operation = (
    await wb({
      kind: "extension",
      effect: { kind: "run_script", ...selected(targetTool), path: "scripts/run.mjs", args: [] },
    })
  ).operation;
  await assert.rejects(readFile(join(targetFolder, "migration-output.txt")));
  await finish(operation, "completed");
  assert.equal(
    await readFile(join(targetFolder, "migration-output.txt"), "utf8"),
    "Portable skill ran",
  );
  operation = (
    await wb({
      kind: "extension",
      effect: { kind: "discover", ...selected(targetTool), server_id: "remote" },
    })
  ).operation;
  await finish(operation, "failed");
  targetTool = await admin(target, targetTask, secret(targetTool, fixture.state.bearer));
  operation = (
    await wb({
      kind: "extension",
      effect: { kind: "discover", ...selected(targetTool), server_id: "remote" },
    })
  ).operation;
  await finish(operation, "completed");
  targetTool = await admin(target, targetTask, secret(targetTool, null));
  report.checks.push(
    "missing_dependency_blocks_activation_explicit_enable_and_approval_run_actual_script_remote_auth_requires_fresh_credential",
  );

  const same = await ok(target, targetTask, {
    ...inspect,
    kind: "import",
    fingerprint: preview.fingerprint,
  });
  assert.equal(same.duplicate, true);
  await target.close();
  target = await launch(targetData);
  preview = await ok(target, targetTask, inspect);
  assert.equal(preview.already_imported, true);
  assert.equal(
    (await ok(target, targetTask, { ...inspect, kind: "import", fingerprint: preview.fingerprint }))
      .duplicate,
    true,
  );
  catalog = await admin(target, targetTask, { kind: "catalog", query: "migration" });
  assert.equal(catalog.items.length, 2);
  assert(catalog.items.every((i) => i.installation.enabled));
  const otherFolder = join(root, "另一 项目");
  await mkdir(otherFolder);
  const otherTask = await create(target, "responses", "extension-transfer-other-target");
  await configure(target, otherTask, otherFolder);
  const conflict = await ok(target, otherTask, inspect);
  assert(conflict.conflicts.length > 0);
  assert.equal(
    (
      await transfer(target, otherTask, {
        ...inspect,
        kind: "import",
        fingerprint: conflict.fingerprint,
      })
    ).kind,
    "error",
  );
  report.checks.push(
    "restart_and_retry_are_idempotent_preserve_user_activation_global_conflict_prevents_partial_project_import",
  );
  await target.close();
  target = null;
  async function scan(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await scan(path);
      else {
        const content = await readFile(path);
        assert(!content.includes(Buffer.from(password)), "Passphrase persisted in local data");
        assert(
          !content.includes(Buffer.from(fixture.state.bearer)),
          "Credential persisted in normal data",
        );
      }
    }
  }
  await scan(sourceData);
  await scan(targetData);
  report.checks.push(
    "passphrase_and_test_credential_absent_from_normal_database_objects_logs_and_installed_resources",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  for (const [engine, task, installation] of [
    [source, sourceTask, sourceTool],
    [target, targetTask, targetTool],
  ]) {
    if (engine && installation)
      await admin(engine, task, secret(installation, null)).catch(() => {});
    await engine?.close();
  }
  await fixture.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
