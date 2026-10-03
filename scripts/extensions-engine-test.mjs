import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { launch, create, until } from "./tool-test-support.mjs";
import { startExtensionFixture } from "../services/extension-fixtures/server.mjs";
const output = ".test-results/extensions-engine";
await mkdir(output, { recursive: true });
const report = { at: new Date().toISOString(), platform: process.platform, checks: [] };
let engine;
const fixture = await startExtensionFixture();
try {
  engine = await launch();
  const folder = await mkdtemp(join(engine.directory, "extension-project-"));
  const task = await create(engine, "responses", "p09-extensions");
  const configure = async (permission) => {
    const r = await engine.request({
      kind: "configure_task_tools",
      task_id: task,
      settings: {
        root_path: folder,
        permission,
        commands_enabled: true,
        review_profile_id: null,
        revision: 0,
      },
    });
    assert.notEqual(r.kind, "error", JSON.stringify(r));
  };
  await configure("request_approval");
  const request = async (action) => engine.request({ kind: "extensions", task_id: task, action });
  const admin = async (action) => {
    const r = await request(action);
    assert.equal(r.kind, "workbench", JSON.stringify(r));
    return r.data;
  };
  const wb = async (action) => {
    const r = await engine.request({ kind: "workbench", task_id: task, action });
    assert.equal(r.kind, "workbench", JSON.stringify(r));
    return r.data;
  };
  const finish = async (op, expected = "completed") => {
    op = await until(async () => {
      const v = await wb({ kind: "operation", operation_id: op.id });
      return ["completed", "failed", "cancelled"].includes(v.operation.state) && v.operation;
    }, 20000);
    assert.equal(op.state, expected, JSON.stringify(op));
    return op;
  };
  const approve = async (op) => {
    if (op.state === "awaiting_approval")
      await wb({ kind: "approve", operation_id: op.id, fingerprint: op.fingerprint });
  };
  const effect = async (e, expected = "completed") => {
    const { operation } = await wb({ kind: "extension", effect: e });
    await approve(operation);
    return finish(operation, expected);
  };
  const content = async (op) => {
    assert(op.output);
    let text = "",
      offset = 0;
    while (offset < op.output.bytes) {
      const r = await engine.request({
        kind: "read",
        query: { kind: "content", object_id: op.output.object_id, offset, limit: 65536 },
      });
      assert.equal(r.kind, "content");
      text += r.page.text;
      offset = r.page.next_offset;
    }
    return JSON.parse(text);
  };
  const directory = await mkdtemp(join(engine.directory, "package-"));
  await mkdir(join(directory, "scripts"));
  await mkdir(join(directory, "references"));
  await writeFile(
    join(directory, "SKILL.md"),
    "---\nname: local-notes\ndescription: Create a note from a reusable template.\nallowed-tools: everything\n---\nRead references/checklist.md and use scripts/note.mjs when asked.\n",
  );
  await writeFile(join(directory, "references/checklist.md"), "Keep the user's wording.\n");
  await writeFile(
    join(directory, "scripts/note.mjs"),
    "import{writeFileSync}from'node:fs';writeFileSync('skill-note.txt','Created by confirmed skill');console.log('skill done');",
  );
  await writeFile(
    join(directory, "server.mjs"),
    await readFile("services/extension-fixtures/local.mjs"),
  );
  let manifest = {
    format: 1,
    id: "local-notes",
    name: "Local notes",
    description: "Reusable skill and actual MCP protocol fixtures",
    version: "1.0.0",
    skills: ["."],
    dependencies: [],
    servers: [
      {
        id: "local",
        name: "Local stdio",
        transport: {
          kind: "stdio",
          runtime: "node",
          entry: "server.mjs",
          args: [],
          secret_env: [],
        },
      },
      {
        id: "json",
        name: "HTTP JSON",
        transport: { kind: "http", url: fixture.url + "/json", auth: "none" },
      },
      {
        id: "sse",
        name: "HTTP SSE",
        transport: { kind: "http", url: fixture.url + "/sse", auth: "none" },
      },
      {
        id: "login",
        name: "OAuth",
        transport: { kind: "http", url: fixture.url + "/oauth", auth: "oauth" },
      },
      {
        id: "bearer",
        name: "Bearer",
        transport: { kind: "http", url: fixture.url + "/bearer", auth: "bearer" },
      },
    ],
  };
  await writeFile(join(directory, "workpilot-plugin.json"), JSON.stringify(manifest));
  let preview = await admin({ kind: "preview", source: directory, project: true });
  assert.equal(
    (await admin({ kind: "catalog", query: null })).items.filter(
      (i) => i.installation.id !== "builtin-skill-creator",
    ).length,
    0,
  );
  assert(preview.version.warnings.some((v) => v.includes("allowed-tools")));
  assert.match(
    (await admin({ kind: "preview_resource", draft_id: preview.id, path: "SKILL.md" })).text,
    /name: local-notes/,
  );
  assert.equal(
    (await request({ kind: "confirm", draft_id: preview.id, digest: "bad", enable: true })).kind,
    "error",
  );
  let installed = await admin({
    kind: "confirm",
    draft_id: preview.id,
    digest: preview.version.digest,
    enable: true,
  });
  const current = async () => {
    const c = await admin({ kind: "catalog", query: null });
    return c.items.find((v) => v.installation.id === installed.id);
  };
  const base = () => ({ installation_id: installed.id, revision: installed.revision });
  report.checks.push("preview_files_permissions_digest_confirmation_global_project_scope");
  const other = await create(engine, "responses", "other-project");
  const invisible = await engine.request({
    kind: "extensions",
    task_id: other,
    action: { kind: "catalog", query: null },
  });
  assert.equal(
    invisible.data.items.filter((i) => i.installation.id !== "builtin-skill-creator").length,
    0,
  );
  let op = (
    await wb({ kind: "extension", effect: { kind: "discover", ...base(), server_id: "local" } })
  ).operation;
  assert.equal(op.state, "awaiting_approval");
  assert.equal((await current()).servers.find((s) => s.spec.id === "local").catalog, null);
  await approve(op);
  await finish(op);
  const call = async (server, name, args, expected = "completed") => {
    const s = (await current()).servers.find((s) => s.spec.id === server);
    return effect(
      {
        kind: "call",
        ...base(),
        server_id: server,
        tool: name,
        tool_digest: s.catalog.tool_digests[name],
        arguments: args,
      },
      expected,
    );
  };
  await call("local", "write_note", { text: "Hello, extension" });
  assert.equal(await readFile(join(folder, "extension-note.txt"), "utf8"), "Hello, extension");
  const history = await wb({
    kind: "history",
    path: "extension-note.txt",
    before: null,
    limit: 10,
  });
  assert.equal(history.items.length, 1);
  const outside = join(engine.directory, "private-sibling.txt");
  await writeFile(outside, "outside");
  assert.match(
    JSON.stringify(await content(await call("local", "check_boundary", { path: outside }))),
    /ACCESS_DENIED/,
  );
  await call("local", "failure", {}, "failed");
  await effect({ kind: "run_script", ...base(), path: "scripts/note.mjs", args: [] });
  assert.equal(
    await readFile(join(folder, "skill-note.txt"), "utf8"),
    "Created by confirmed skill",
  );
  report.checks.push(
    "real_stdio_approval_appcontainer_write_history_outside_denied_tool_error_skill_script",
  );
  const destination = "copied-checklist.md";
  const before = (await wb({ kind: "read_file", path: destination })).version;
  await effect({
    kind: "copy_resource",
    ...base(),
    path: "references/checklist.md",
    destination,
    expected: before,
  });
  assert.equal(await readFile(join(folder, destination), "utf8"), "Keep the user's wording.\n");
  assert.equal(
    (await wb({ kind: "history", path: destination, before: null, limit: 10 })).items.length,
    1,
  );
  report.checks.push("skill_template_copy_uses_project_file_version_and_history");
  const s = (await current()).servers.find((s) => s.spec.id === "local");
  op = (
    await wb({
      kind: "extension",
      effect: {
        kind: "call",
        ...base(),
        server_id: "local",
        tool: "wait",
        tool_digest: s.catalog.tool_digests.wait,
        arguments: {},
      },
    })
  ).operation;
  await approve(op);
  const pid = await until(async () => {
    try {
      return Number(await readFile(join(folder, "extension-wait.pid"), "utf8"));
    } catch {
      return false;
    }
  }, 20000);
  await wb({ kind: "stop", operation_id: op.id });
  await finish(op, "cancelled");
  await until(async () => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  report.checks.push("cancel_terminates_actual_stdio_process_and_closes_owned_job");
  await writeFile(join(folder, "extension-wait.pid"), "");
  const waiting = (
    await wb({
      kind: "extension",
      effect: {
        kind: "call",
        ...base(),
        server_id: "local",
        tool: "wait",
        tool_digest: s.catalog.tool_digests.wait,
        arguments: {},
      },
    })
  ).operation;
  await approve(waiting);
  const disabledPid = await until(
    async () => Number(await readFile(join(folder, "extension-wait.pid"), "utf8")),
    20000,
  );
  installed = await admin({ kind: "set_enabled", ...base(), enabled: false });
  await finish(waiting, "cancelled");
  await until(async () => {
    try {
      process.kill(disabledPid, 0);
      return false;
    } catch {
      return true;
    }
  });
  installed = await admin({ kind: "set_enabled", ...base(), enabled: true });
  report.checks.push("disable_installed_extension_cancels_its_running_process_before_reenable");
  for (const server_id of ["json", "sse"]) {
    await effect({ kind: "discover", ...base(), server_id });
    const result = await content(
      await call(server_id, "remote_echo", { text: "remote " + server_id }),
    );
    assert.equal(result.mcp_result.content[0].text, "remote " + server_id);
  }
  assert.equal(fixture.state.pings, 1);
  await call("sse", "remote_echo", { text: "changed notification", behavior: "change" });
  assert.equal(
    (await current()).servers.find((s) => s.spec.id === "sse").catalog.state,
    "needs_refresh",
  );
  fixture.state.changed = false;
  await call("json", "remote_echo", { text: "error", behavior: "error" }, "failed");
  await call("json", "remote_echo", { text: "drop", behavior: "drop" }, "failed");
  assert.equal(fixture.state.drop, 1);
  const stale = (await current()).servers.find((s) => s.spec.id === "json").catalog.tool_digests
    .remote_echo;
  fixture.state.changed = true;
  const count = fixture.state.calls.length;
  await effect(
    {
      kind: "call",
      ...base(),
      server_id: "json",
      tool: "remote_echo",
      tool_digest: stale,
      arguments: { text: "stale" },
    },
    "failed",
  );
  assert.equal(fixture.state.calls.length, count);
  report.checks.push(
    "http_json_sse_chunking_session_version_server_ping_drop_no_replay_dynamic_schema_invalidates_old_approval",
  );
  const jsonServer = (await current()).servers.find((s) => s.spec.id === "json");
  op = (
    await wb({
      kind: "extension",
      effect: {
        kind: "call",
        ...base(),
        server_id: "json",
        tool: "remote_echo",
        tool_digest: jsonServer.catalog.tool_digests.remote_echo,
        arguments: { text: "waiting", behavior: "wait" },
      },
    })
  ).operation;
  await approve(op);
  await until(async () => fixture.state.calls.some((c) => c.arguments.text === "waiting"));
  await wb({ kind: "stop", operation_id: op.id });
  await finish(op, "cancelled");
  assert(fixture.state.cancelled.length > 0);
  report.checks.push("http_cancel_notification_without_replaying_side_effect");
  const auth = await admin({
    kind: "oauth_start",
    ...base(),
    server_id: "login",
    client_id: null,
    scopes: ["tools"],
  });
  const callback = new URL(new URL(auth.authorization_url).searchParams.get("redirect_uri"));
  callback.searchParams.set("state", "wrong");
  callback.searchParams.set("code", "wrong");
  assert.equal((await fetch(callback)).status, 400);
  const login = await fetch(auth.authorization_url, { redirect: "follow" });
  assert.equal(login.status, 200);
  await until(async () => {
    const r = await admin({ kind: "oauth_status", flow_id: auth.flow_id });
    if (r.state === "failed") throw new Error(JSON.stringify(r));
    return r.state === "authorized";
  });
  installed = (await current()).installation;
  assert.equal(fixture.state.oauthExchanges, 1);
  await effect({ kind: "discover", ...base(), server_id: "login" });
  assert(!JSON.stringify(await admin({ kind: "catalog", query: null })).includes(fixture.token));
  report.checks.push(
    "real_oauth_discovery_dynamic_registration_pkce_state_issuer_resource_binding_system_credential",
  );
  fixture.state.bearer = "fixture-only-bearer-" + crypto.randomUUID();
  installed = await admin({
    kind: "save_credential",
    ...base(),
    server_id: "bearer",
    key: "authorization",
    secret: fixture.state.bearer,
  });
  await effect({ kind: "discover", ...base(), server_id: "bearer" });
  assert(
    !JSON.stringify(
      await content(await call("bearer", "remote_echo", { text: fixture.state.bearer })),
    ).includes(fixture.state.bearer),
  );
  const zip = join(engine.directory, "export.zip");
  await admin({ kind: "export", ...base(), destination: zip });
  fixture.state.archive = await readFile(zip);
  assert(!fixture.state.archive.includes(Buffer.from(fixture.state.bearer)));
  assert(!fixture.state.archive.includes(Buffer.from(fixture.token)));
  const online = await admin({
    kind: "preview",
    source: fixture.url + "/package.zip",
    project: false,
  });
  assert.equal(online.version.digest, preview.version.digest);
  await admin({ kind: "discard_preview", draft_id: online.id });
  report.checks.push("bearer_secret_redaction_export_without_credentials_online_zip_preview");
  await writeFile(join(directory, "references/private-value.txt"), fixture.state.bearer);
  assert.equal(
    (await request({ kind: "preview", source: directory, project: true })).kind,
    "error",
  );
  await unlink(join(directory, "references/private-value.txt"));
  report.checks.push("installed_credential_cannot_be_imported_as_skill_resource");
  // Updating must reject a missing dependency without disturbing the active version.
  manifest = {
    ...manifest,
    version: "2.0.0",
    dependencies: [{ id: "missing-extension", version: "^1.0.0" }],
  };
  await writeFile(join(directory, "workpilot-plugin.json"), JSON.stringify(manifest));
  let update = await admin({ kind: "preview", source: directory, project: true });
  assert.equal(
    (
      await request({
        kind: "confirm",
        draft_id: update.id,
        digest: update.version.digest,
        enable: true,
      })
    ).kind,
    "error",
  );
  assert.equal((await current()).version.manifest.version, "1.0.0");
  await admin({ kind: "discard_preview", draft_id: update.id });
  manifest.dependencies = [];
  await writeFile(join(directory, "workpilot-plugin.json"), JSON.stringify(manifest));
  update = await admin({ kind: "preview", source: directory, project: true });
  installed = await admin({
    kind: "confirm",
    draft_id: update.id,
    digest: update.version.digest,
    enable: true,
  });
  assert.equal((await current()).version.manifest.version, "2.0.0");
  installed = await admin({ kind: "rollback", ...base(), digest: preview.version.digest });
  assert.equal((await current()).version.manifest.version, "1.0.0");
  op = (await wb({ kind: "extension", effect: { kind: "discover", ...base(), server_id: "json" } }))
    .operation;
  installed = await admin({ kind: "set_enabled", ...base(), enabled: false });
  assert.equal(
    (
      await engine.request({
        kind: "workbench",
        task_id: task,
        action: { kind: "approve", operation_id: op.id, fingerprint: op.fingerprint },
      })
    ).kind,
    "error",
  );
  await finish(op, "failed");
  await admin({ kind: "uninstall", ...base() });
  assert.equal(
    (await admin({ kind: "catalog", query: null })).items.filter(
      (i) => i.installation.id !== "builtin-skill-creator",
    ).length,
    0,
  );
  assert.equal(await readFile(join(folder, "extension-note.txt"), "utf8"), "Hello, extension");
  report.checks.push(
    "dependency_failure_preserves_old_version_update_rollback_disable_invalidates_approval_uninstall_preserves_user_files",
  );
  const builtin = (await admin({ kind: "catalog", query: null })).items.find(
    (i) => i.installation.id === "builtin-skill-creator",
  ).installation;
  await admin({
    kind: "set_enabled",
    installation_id: builtin.id,
    revision: builtin.revision,
    enabled: false,
  });
  const savedDirectory = engine.directory;
  await engine.close();
  engine = await launch(savedDirectory);
  const resumed = (await admin({ kind: "catalog", query: null })).items.find(
    (i) => i.installation.id === builtin.id,
  ).installation;
  assert.equal(resumed.enabled, false);
  await admin({ kind: "uninstall", installation_id: resumed.id, revision: resumed.revision });
  await engine.close();
  engine = await launch(savedDirectory);
  assert.equal(
    (await admin({ kind: "catalog", query: null })).items.some(
      (i) => i.installation.id === builtin.id,
    ),
    false,
  );
  report.checks.push("builtin_skill_creator_disable_and_uninstall_choices_survive_engine_restart");
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = String(e);
  report.stack = e.stack;
  process.exitCode = 1;
} finally {
  await engine?.close();
  await fixture.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
