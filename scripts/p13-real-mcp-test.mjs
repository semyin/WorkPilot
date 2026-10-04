import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launch, create, setFixture, start, snapshot, until } from "./tool-test-support.mjs";
import { startToolFixture } from "../services/execution-fixtures/tools.mjs";
import {
  startConnectAudit,
  sha256,
  readContent,
  summarizeResult,
} from "./p13-real-mcp-support.mjs";

const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/p13-real-mcp");
const binary = resolve(
  process.env.WORKPILOT_ENGINE_BINARY ||
    "artifacts/workpilot-p13-candidate-2026-10-04-r3/preview/workpilot-sidecar.exe",
);
const expectedHash =
  process.env.WORKPILOT_EXPECTED_ENGINE_SHA256 ||
  "a0388178665c1f8a81aa4b2cd4997b6926b51ad419354afae2f11a64b1526efb";
const endpoint = "https://learn.microsoft.com/api/mcp";
const topic = "Windows App SDK app notifications registration and activation";
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "run-"));
const report = {
  at: new Date().toISOString(),
  version: "0.1.0-alpha.13.4",
  binary,
  binarySha256: sha256(await readFile(binary)),
  directory,
  model: "Fixed local Responses model; not a real LLM and no paid model calls",
  service: "Real public Microsoft Learn MCP over certificate-validated HTTPS, no authentication",
  endpoint,
  topic,
  sources: [
    "https://learn.microsoft.com/en-us/training/support/mcp-developer-reference",
    "https://learn.microsoft.com/en-us/training/support/mcp",
  ],
  checks: [],
  approvals: [],
  managementActions: [],
  limitations: [
    "One public stateless Streamable HTTP service only; no OAuth or commercial-server acceptance claim",
    "Fixed model drives actual WorkPilot extension tools; this is not real-model reasoning or human UX acceptance",
    "A private CONNECT counting tunnel passes TLS bytes unchanged; it does not inspect or rewrite MCP messages",
    "The test runs alongside a separate stability run and is not a formal performance measurement",
    "Remote failures are recorded without automatic tool retries or schema guessing",
  ],
};
const writeJson = (name, value) =>
  writeFile(join(directory, name), JSON.stringify(value, null, 2) + "\n");
let engine, model, audit, task, installation;
const observations = [];
const previousEnv = Object.fromEntries(
  ["WORKPILOT_ENGINE_BINARY", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"].map((key) => [
    key,
    process.env[key],
  ]),
);
let currentCatalog;
let expectedResultRef;
let modelResultRef;
try {
  assert.equal(report.binarySha256, expectedHash, "Use only the expected frozen engine");
  model = await startToolFixture();
  setFixture(model);
  audit = await startConnectAudit();
  process.env.WORKPILOT_ENGINE_BINARY = binary;
  process.env.HTTPS_PROXY = audit.url;
  process.env.HTTP_PROXY = audit.url;
  process.env.ALL_PROXY = audit.url;
  process.env.NO_PROXY = "localhost,127.0.0.1,::1";
  engine = await launch(join(directory, "data"));
  report.enginePid = engine.child.pid;
  const ready = engine.events.find((event) => event.kind === "ready");
  assert.equal(ready.version, report.version);
  const project = join(directory, "project");
  const packageDirectory = join(directory, "microsoft-learn-package");
  await mkdir(project);
  await mkdir(packageDirectory);
  task = await create(engine, "responses", "p13-real-microsoft-learn", {
    goal: `Query public Microsoft Learn documentation about ${topic}; use one search call only.`,
    controlled_tools: false,
    limits: {
      max_steps: 8,
      max_duration_ms: 180000,
      context_bytes: 131072,
      max_result_bytes: 65536,
    },
  });
  report.taskId = task;
  assert.equal(
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
    "receipt",
  );
  const admin = async (action) => {
    const response = await engine.request({ kind: "extensions", task_id: task, action });
    assert.equal(response.kind, "workbench", JSON.stringify(response));
    return response.data;
  };
  const work = async (action) => {
    const response = await engine.request({ kind: "workbench", task_id: task, action });
    assert.equal(response.kind, "workbench", JSON.stringify(response));
    return response.data;
  };
  const manifest = {
    format: 1,
    id: "p13-microsoft-learn",
    name: "P13 Microsoft Learn public MCP",
    version: "1.0.0",
    description: "Isolated acceptance of public Microsoft documentation",
    skills: [],
    dependencies: [],
    servers: [
      {
        id: "microsoft-learn",
        name: "Microsoft Learn",
        transport: { kind: "http", url: endpoint, auth: "none" },
      },
    ],
  };
  await writeFile(join(packageDirectory, "workpilot-plugin.json"), JSON.stringify(manifest));
  const preview = await admin({ kind: "preview", source: packageDirectory, project: true });
  await writeJson("plugin-preview.json", preview);
  assert.equal((await admin({ kind: "catalog", query: manifest.id })).items.length, 0);
  assert.equal(audit.records.length, 0);
  installation = await admin({
    kind: "confirm",
    draft_id: preview.id,
    digest: preview.version.digest,
    enable: true,
  });
  assert.equal(installation.enabled, true);
  assert.equal(audit.records.length, 0);
  report.managementActions.push({
    kind: "confirm_plugin",
    actor: "independent test driver",
    at: new Date().toISOString(),
    draftId: preview.id,
    digest: preview.version.digest,
    installationId: installation.id,
    enabled: true,
  });
  report.checks.push({
    name: "local_preview_and_explicit_enable_without_remote_connection",
    status: "passed",
  });
  model.recipes.set("p13-real-microsoft-learn", (results, body) => {
    const parsed = results.map((text) => JSON.parse(text));
    const tools = body.tools.map((tool) => tool.function || tool);
    observations.push({
      at: new Date().toISOString(),
      resultCount: results.length,
      toolNames: tools.map((tool) => tool.name),
      resultHashes: results.map(sha256),
    });
    if (results.length === 0) return model.tool("skill_search", { query: manifest.id });
    if (results.length === 1) {
      const found = parsed[0].items.find((item) => item.installation.id === installation.id);
      assert(found, "Enabled project extension should be found");
      assert(
        !tools.some((tool) => tool.name.startsWith("mcp_")),
        "No remote tools before discovery",
      );
      return model.tool("extension_action", {
        effect: {
          kind: "discover",
          installation_id: installation.id,
          revision: installation.revision,
          server_id: "microsoft-learn",
        },
      });
    }
    if (results.length === 2) {
      const advertised = tools.find((tool) =>
        tool.description?.startsWith("External MCP tool microsoft-learn/microsoft_docs_search."),
      );
      assert(advertised, "Search definition must be added from the discovered Microsoft tool");
      const actual = currentCatalog.tools.find((tool) => tool.name === "microsoft_docs_search");
      assert.deepEqual(advertised.parameters, actual.inputSchema);
      const schema = actual.inputSchema;
      assert.equal(schema.properties.query?.type, "string", "Use the actual returned query schema");
      assert(
        (schema.required || []).every((key) => key === "query"),
        "Do not guess additional required fields",
      );
      observations.at(-1).dynamicTool = advertised;
      return model.tool(advertised.name, { query: topic });
    }
    assert.equal(results.length, 3, "No replay or additional tool calls");
    if (parsed[2].record) {
      assert.match(parsed[2].record.object_id, /^[a-f0-9]{64}$/);
      assert.equal(parsed[2].record.media_type, "application/json");
      assert(parsed[2].record.bytes > 24000);
      modelResultRef = parsed[2].record;
      observations.at(-1).largeResultReceipt = parsed[2];
      return model.done(
        "Microsoft Learn search completed. The large result is saved in the task trace; this fixed model received its record reference, not the full article excerpts.",
      );
    }
    const summary = summarizeResult(parsed[2]);
    return model.done(
      `Microsoft Learn returned ${summary.citationUrls.length} public documentation references. Fixed test driver verified the structured result.`,
    );
  });
  const waitTask = () =>
    until(async () => {
      const value = await snapshot(engine, task);
      return (
        ["awaiting_approval", "failed", "completed", "interrupted"].includes(value.task.state) &&
        value
      );
    }, 30000);
  const pendingOperation = async () => {
    const operations = await work({ kind: "operations" });
    const pending = operations.items.filter((item) => item.operation.state === "awaiting_approval");
    assert.equal(pending.length, 1);
    return pending[0].operation;
  };
  const approveAndFinish = async (operation, kind) => {
    audit.gate(kind, true);
    const approval = {
      actor: "independent test driver, not the model",
      kind,
      operationId: operation.id,
      fingerprint: operation.fingerprint,
      at: new Date().toISOString(),
      connectionsBefore: audit.records.length,
    };
    report.approvals.push(approval);
    await work({ kind: "approve", operation_id: operation.id, fingerprint: operation.fingerprint });
    const result = await until(async () => {
      const { operation: current } = await work({ kind: "operation", operation_id: operation.id });
      return ["completed", "failed", "cancelled"].includes(current.state) && current;
    }, 130000);
    approval.finishedAt = new Date().toISOString();
    approval.state = result.state;
    approval.connectionsAfter = audit.records.length;
    await writeJson(`${kind}-operation.json`, result);
    audit.gate(`${kind}-finished`, false);
    assert.equal(result.state, "completed", JSON.stringify(result));
    assert(
      audit.records.length > approval.connectionsBefore,
      "Real TLS connection must use the audited route",
    );
    return result;
  };
  await start(engine, task);
  let state = await waitTask();
  assert.equal(state.task.state, "awaiting_approval", JSON.stringify(state.latest_run));
  let operation = await pendingOperation();
  await delay(750);
  assert.equal(audit.records.length, 0, "No remote connection before discovery approval");
  await writeJson("discovery-before-approval.json", { operation, state, connections: 0 });
  operation = await approveAndFinish(operation, "discover");
  currentCatalog = await readContent(engine, operation.output);
  assert(Array.isArray(currentCatalog.tools) && currentCatalog.tools.length);
  assert(currentCatalog.tools.some((tool) => tool.name === "microsoft_docs_search"));
  assert(currentCatalog.tools.some((tool) => tool.name === "microsoft_docs_fetch"));
  await writeJson("remote-tool-catalog.json", currentCatalog);
  report.negotiatedProtocol = currentCatalog.protocol_version;
  report.serverInfo = currentCatalog.server_info;
  report.toolNames = currentCatalog.tools.map((tool) => tool.name);
  report.checks.push({
    name: "first_approval_opens_real_tls_initializes_and_discovers_current_tools",
    status: "passed",
  });
  const connectionsAfterDiscovery = audit.records.length;
  await start(engine, task);
  state = await waitTask();
  assert.equal(state.task.state, "awaiting_approval", JSON.stringify(state.latest_run));
  operation = await pendingOperation();
  assert.notEqual(operation.id, report.approvals[0].operationId);
  await delay(750);
  assert.equal(
    audit.records.length,
    connectionsAfterDiscovery,
    "No new connection before query approval",
  );
  await writeJson("query-before-approval.json", {
    operation,
    state,
    connectionsBefore: connectionsAfterDiscovery,
    connectionsAfter: audit.records.length,
  });
  report.checks.push({
    name: "actual_schema_becomes_dynamic_model_tool_and_query_waits_for_separate_approval",
    status: "passed",
  });
  operation = await approveAndFinish(operation, "search");
  expectedResultRef = operation.output;
  const value = await readContent(engine, operation.output);
  const summary = summarizeResult(value);
  await writeJson("remote-result-summary.json", summary);
  report.result = summary;
  report.resultRecord = expectedResultRef;
  report.resultInspection =
    "The independent test driver read the complete persisted operation output. Model-facing results larger than 24,000 bytes use a record reference; this is not evidence that the fixed model read the full body.";
  await start(engine, task);
  state = await waitTask();
  assert.equal(state.task.state, "completed", JSON.stringify(state.latest_run));
  if (modelResultRef) {
    assert.deepEqual(await readContent(engine, modelResultRef), value);
    report.modelResultRecord = modelResultRef;
    report.modelRecordMatchesCompleteOperationJson = true;
  }
  const operations = await work({ kind: "operations" });
  assert.equal(operations.items.length, 2, "Exactly two approved MCP operations");
  assert(operations.items.every((item) => item.operation.state === "completed"));
  assert.equal(report.approvals.length, 2);
  assert(
    audit.records.every(
      (record) => record.allowed && record.sentBytes > 0 && record.receivedBytes > 0,
    ),
  );
  assert(model.records.every((record) => record.correlationValid));
  await writeJson("final-task.json", state);
  report.checks.push({
    name: "second_approval_real_search_returns_citations_and_text_and_task_completes_without_replay",
    status: "passed",
  });
  installation = await admin({
    kind: "uninstall",
    installation_id: installation.id,
    revision: installation.revision,
  });
  report.managementActions.push({
    kind: "uninstall_test_plugin",
    at: new Date().toISOString(),
    actor: "independent test driver",
  });
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  if (engine && task) {
    const state = await snapshot(engine, task).catch(() => null);
    if (state && ["running", "queued", "stopping", "awaiting_approval"].includes(state.task.state))
      await engine.request({ kind: "cancel_execution", task_id: task }).catch(() => {});
  }
  await engine?.close().catch((error) => {
    report.cleanupError = String(error);
    report.status = "failed";
  });
  await model?.close();
  await audit?.close();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  report.finishedAt = new Date().toISOString();
  report.credentials =
    "No model, MCP/OAuth or user account credentials supplied, read by the test driver, configured or sent. The product may create its own local encrypted-content key for this isolated data directory.";
  report.engineExitCode = engine?.child.exitCode ?? null;
  await writeJson("connect-audit.json", audit?.records || []);
  await writeJson("fixed-model-observations.json", observations);
  await writeJson("model-transport-records.json", model?.records || []);
  await writeJson("events.json", engine?.events || []);
  await writeJson("report.json", report);
  console.log(
    JSON.stringify(
      {
        status: report.status,
        checks: report.checks.length,
        directory,
        report: join(directory, "report.json"),
        error: report.error || null,
      },
      null,
      2,
    ),
  );
}
