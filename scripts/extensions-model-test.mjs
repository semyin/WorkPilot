import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, create, setFixture, start, terminal, until } from "./tool-test-support.mjs";
import { startToolFixture } from "../services/execution-fixtures/tools.mjs";
import { startExtensionFixture } from "../services/extension-fixtures/server.mjs";
const output = ".test-results/extensions-model";
await mkdir(output, { recursive: true });
const model = await startToolFixture(),
  remote = await startExtensionFixture();
setFixture(model);
let engine;
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  model: "deterministic local provider; real Rust engine and actual MCP HTTP service",
  checks: [],
};
try {
  engine = await launch();
  const folder = await mkdtemp(join(engine.directory, "skill-project-"));
  const configure = async (task) => {
    assert.notEqual(
      (
        await engine.request({
          kind: "configure_task_tools",
          task_id: task,
          settings: {
            root_path: folder,
            permission: "request_approval",
            commands_enabled: true,
            review_profile_id: null,
            revision: 0,
          },
        })
      ).kind,
      "error",
    );
  };
  const admin = async (task, action) => {
    const r = await engine.request({ kind: "extensions", task_id: task, action });
    assert.equal(r.kind, "workbench", JSON.stringify(r));
    return r.data;
  };
  const wb = async (task, action) => {
    const r = await engine.request({ kind: "workbench", task_id: task, action });
    assert.equal(r.kind, "workbench", JSON.stringify(r));
    return r.data;
  };
  model.recipes.set("p09-create-skill", (results) => {
    if (!results.length) return model.tool("skill_search", { query: "skill-creator" });
    if (results.length === 1) {
      const i = JSON.parse(results[0]).items[0].installation;
      return model.tool("skill_read", {
        installation_id: i.id,
        revision: i.revision,
        path: "SKILL.md",
      });
    }
    if (results.length === 2) {
      assert.match(JSON.parse(results[1]).text, /skill_draft/);
    }
    if (results.length === 2)
      return model.tool("skill_draft", {
        project: true,
        files: [
          {
            path: "SKILL.md",
            text: "---\nname: user-report\ndescription: Create a reusable report.\n---\nRead references/style.md. Run scripts/report.mjs for the example.\n",
          },
          { path: "references/style.md", text: "Use a clear title and list." },
          {
            path: "scripts/report.mjs",
            text: "import{writeFileSync}from'node:fs';writeFileSync('generated-report.txt','A reusable skill produced this report.');",
          },
        ],
      });
    return model.done("Draft created; confirm in Skills and plugins.");
  });
  const draftTask = await create(engine, "responses", "p09-create-skill", {
    mode: "plan",
    controlled_tools: false,
  });
  await configure(draftTask);
  await start(engine, draftTask);
  assert.equal((await terminal(engine, draftTask)).task.state, "awaiting_input");
  const drafts = await admin(draftTask, { kind: "catalog", query: null });
  assert.equal(drafts.items.filter((i) => i.installation.id !== "builtin-skill-creator").length, 0);
  assert.equal(drafts.previews.length, 1);
  assert.equal(drafts.previews[0].draft, true);
  const p = drafts.previews[0];
  await admin(draftTask, {
    kind: "confirm",
    draft_id: p.id,
    digest: p.version.digest,
    enable: true,
  });
  report.checks.push("natural_language_model_saves_skill_draft_and_resources_cannot_enable_itself");
  report.checks.push(
    "builtin_skill_creator_is_discovered_and_read_before_the_model_writes_a_draft",
  );
  model.recipes.set("p09-use-skill", (results) => {
    const parsed = results.map((r) => JSON.parse(r));
    if (!results.length) return model.tool("skill_search", { query: "user-report" });
    const i = parsed[0].items[0].installation;
    const base = { installation_id: i.id, revision: i.revision };
    if (results.length === 1) return model.tool("skill_read", { ...base, path: "SKILL.md" });
    if (results.length === 2)
      return model.tool("skill_read", { ...base, path: "references/style.md" });
    if (results.length === 3)
      return model.tool("extension_action", {
        effect: { kind: "run_script", ...base, path: "scripts/report.mjs", args: [] },
      });
    return model.done("Confirmed skill used.");
  });
  const use = await create(engine, "responses", "p09-use-skill", { controlled_tools: false });
  await configure(use);
  await start(engine, use);
  assert.equal((await terminal(engine, use)).task.state, "awaiting_approval");
  let op = (await wb(use, { kind: "operations" })).items[0].operation;
  assert.equal(op.state, "awaiting_approval");
  await wb(use, { kind: "approve", operation_id: op.id, fingerprint: op.fingerprint });
  await until(async () =>
    ["completed", "failed"].includes(
      (await wb(use, { kind: "operation", operation_id: op.id })).operation.state,
    ),
  );
  await start(engine, use);
  let final = await terminal(engine, use);
  assert.equal(final.task.state, "completed");
  assert.equal(
    await readFile(join(folder, "generated-report.txt"), "utf8"),
    "A reusable skill produced this report.",
  );
  assert.equal((await wb(use, { kind: "operations" })).items.length, 1);
  report.checks.push(
    "enabled_skill_search_progressive_resource_loading_real_script_approval_resume_no_replay",
  );
  const directory = await mkdtemp(join(engine.directory, "remote-extension-"));
  await writeFile(
    join(directory, "workpilot-plugin.json"),
    JSON.stringify({
      format: 1,
      id: "remote-skill",
      name: "Remote fixture",
      version: "1.0.0",
      description: "New remote tool",
      skills: [],
      dependencies: [],
      servers: [
        {
          id: "remote",
          name: "Remote",
          transport: { kind: "http", url: remote.url + "/json", auth: "none" },
        },
      ],
    }),
  );
  const preview = await admin(use, { kind: "preview", source: directory, project: true });
  await admin(use, {
    kind: "confirm",
    draft_id: preview.id,
    digest: preview.version.digest,
    enable: true,
  });
  model.recipes.set("p09-use-new-tool", (results, body) => {
    const parsed = results.map((r) => JSON.parse(r));
    if (!results.length) return model.tool("skill_search", { query: "remote-skill" });
    if (results.length === 1) {
      const i = parsed[0].items[0].installation;
      return model.tool("extension_action", {
        effect: {
          kind: "discover",
          installation_id: i.id,
          revision: i.revision,
          server_id: "remote",
        },
      });
    }
    if (results.length === 2) {
      const t = body.tools.map((t) => t.function || t).find((t) => t.name?.startsWith("mcp_"));
      assert(t, "tool definition must appear dynamically after discovery");
      return model.tool(t.name, { text: "Newly installed tool works" });
    }
    assert.equal(parsed[2].mcp_result.content[0].text, "Newly installed tool works");
    return model.done("New tool called without changing model loop.");
  });
  for (const protocol of ["responses", "chat_completions", "messages"]) {
    const task = await create(engine, protocol, "p09-use-new-tool", { controlled_tools: false });
    await configure(task);
    await start(engine, task);
    let s = await terminal(engine, task),
      approvals = 0;
    while (s.task.state === "awaiting_approval") {
      op = (await wb(task, { kind: "operations" })).items.find(
        (v) => v.operation.state === "awaiting_approval",
      ).operation;
      await wb(task, { kind: "approve", operation_id: op.id, fingerprint: op.fingerprint });
      await until(async () =>
        ["completed", "failed"].includes(
          (await wb(task, { kind: "operation", operation_id: op.id })).operation.state,
        ),
      );
      approvals++;
      await start(engine, task);
      s = await terminal(engine, task);
    }
    assert.equal(s.task.state, "completed", JSON.stringify(s.latest_run));
    assert.equal(approvals, 2);
  }
  assert.equal(remote.state.calls.length, 3);
  report.checks.push(
    "three_protocol_model_tool_discovery_approval_resume_without_replaying_side_effects",
  );
  report.status = "passed";
} catch (e) {
  report.status = "failed";
  report.error = String(e);
  report.stack = e.stack;
  process.exitCode = 1;
} finally {
  await engine?.close();
  await remote.close();
  await model.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
