// Explicit real-service acceptance only. Never run by CI; all credentials arrive on stdin.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { launchEngine } from "./p13-engine-client.mjs";
import {
  inputConfiguration,
  plannedModels,
  provider,
  redactor,
  saveEvidence,
  scanPlaintext,
  traceTask,
} from "./p13-real-model-support.mjs";
import { probe } from "./p13-real-model-probes.mjs";
import { singleFile, distinctModelTeam } from "./p13-real-model-files.mjs";
import { skillsMemory } from "./p13-real-model-skills.mjs";

const args = process.argv.slice(2);
const teamOnlyIndex = args.indexOf("--team-only-from");
const teamOnlyFrom = teamOnlyIndex >= 0 ? args[teamOnlyIndex + 1] : null;
const skillsIndex = args.indexOf("--skills-memory-from");
const skillsFrom = skillsIndex >= 0 ? args[skillsIndex + 1] : null;
const glmIndex = args.indexOf("--glm-proposal-followup-from");
const glmFrom = glmIndex >= 0 ? args[glmIndex + 1] : null;
const evidenceFrom = skillsFrom || glmFrom || teamOnlyFrom;
const teamAlpha = args.includes("--two-families") ? "p13-qwen-chat" : "p13-glm-chat";
const alphaExisting = args.includes("--existing-alpha");
const focusedFormatValidation = args.includes("--format-validation");
assert(!teamOnlyFrom?.startsWith("--"), "Specify the original real-model report path");
assert(teamOnlyIndex < 0 || teamOnlyFrom, "Missing original real-model report path");
assert(
  skillsIndex < 0 || (skillsFrom && !skillsFrom.startsWith("--")),
  "Missing successful format-validation report",
);
assert(
  !skillsFrom || (!teamOnlyFrom && !focusedFormatValidation),
  "Keep the independent workflow run separate",
);
assert(
  glmIndex < 0 || (glmFrom && !glmFrom.startsWith("--")),
  "Missing current-engine format report",
);
assert(
  !glmFrom || (!skillsFrom && !teamOnlyFrom && !focusedFormatValidation),
  "Only one explicit follow-up mode is allowed",
);
assert(!args.includes("--two-families") || teamOnlyFrom, "Use an explicit new team-only run");
assert(!alphaExisting || teamOnlyFrom, "Existing-file validation is a separate team-only run");
assert(!alphaExisting || !args.includes("--two-families"), "Keep the distinct scenarios separate");
assert(!focusedFormatValidation || !teamOnlyFrom, "New-engine validation must run its own probes");
const knownArguments = new Set([
  "--plan",
  "--team-only-from",
  "--two-families",
  "--existing-alpha",
  "--format-validation",
  "--skills-memory-from",
  "--glm-proposal-followup-from",
  teamOnlyFrom,
  skillsFrom,
  glmFrom,
]);
assert(
  args.every((arg) => knownArguments.has(arg)),
  "Unknown real-model test option",
);
const expectedChecks = skillsFrom
  ? 7
  : glmFrom
    ? 2
    : teamOnlyFrom
      ? 1
      : focusedFormatValidation
        ? 9
        : 15;
const selectedModels = skillsFrom
  ? plannedModels.filter((p) => p.id === "p13-qwen-responses")
  : plannedModels;
if (process.argv.includes("--plan")) {
  console.log(
    JSON.stringify(
      {
        models: selectedModels,
        probes: glmFrom ? 1 : evidenceFrom ? 0 : focusedFormatValidation ? 5 : 11,
        actualFileCases: evidenceFrom ? 0 : 3,
        differentModelTeam: skillsFrom ? 0 : 1,
        skillMemoryWorkflowChecks: skillsFrom ? 7 : 0,
        skillsFrom,
        glmFrom,
        teamOnlyFrom,
        teamAlpha,
        alphaExisting,
        promptRevision: teamOnlyFrom ? "json-null-v2" : "original-v1",
        retries: 0,
        commandsEnabled: false,
        credentials: "stdin and isolated system credential references; removed in finally",
        scope:
          "New test directory only. Model response fields are preserved as returned, including errors; no report replacement.",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
if (!process.env.WORKPILOT_ENGINE_BINARY)
  throw new Error("Specify the frozen candidate engine through WORKPILOT_ENGINE_BINARY");
const binary = resolve(process.env.WORKPILOT_ENGINE_BINARY);
const binarySha256 = createHash("sha256")
  .update(await readFile(binary))
  .digest("hex");
let previousEvidence;
let previousReport;
if (evidenceFrom) {
  const bytes = await readFile(resolve(evidenceFrom));
  previousReport = JSON.parse(bytes.toString("utf8"));
  assert.equal(previousReport.synthetic, false, "Previous evidence must use the real service");
  assert.equal(previousReport.binarySha256, binarySha256, "Do not mix different engines");
  assert(previousReport.cleanup?.credentialsRemoved, "Finish the original run cleanup first");
  assert.equal(previousReport.credentialScan?.plaintextCredentialFound, false);
  if (skillsFrom) {
    assert.equal(previousReport.mode, "new_engine_format_validation");
    for (const id of ["probe:p13-qwen-responses:tools", "files:responses"])
      assert(
        previousReport.checks.some((c) => c.id === id && c.state === "passed"),
        "The selected Qwen model must pass its current-engine prerequisites",
      );
  }
  if (glmFrom) {
    assert.equal(previousReport.mode, "new_engine_format_validation");
    for (const id of [
      "probe:p13-qwen-chat:tools",
      "probe:p13-qwen-responses:tools",
      "probe:p13-qwen-messages:tools",
      "probe:p13-deepseek-chat:tools",
      "files:chat_completions",
      "files:responses",
      "files:messages",
    ])
      assert(
        previousReport.checks.some((c) => c.id === id && c.state === "passed"),
        "Do not repeat the passing protocol and file cases",
      );
  }
  previousEvidence = {
    report: resolve(evidenceFrom),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    originalStatus: previousReport.status,
    note: "Prior probe evidence only. This new workflow has new tasks, files and credentials; its result is not merged with the earlier sample.",
    capabilityConfiguration:
      "Tool capability is explicitly set with source=user based on the earlier recorded real probe. No probe timestamp or successful probe is fabricated in the new directory.",
  };
}
const setup = await inputConfiguration();
const redact = redactor(setup.key);
const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/p13-real-models");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "run-"));
const report = {
  at: new Date().toISOString(),
  synthetic: false,
  platform: process.platform,
  binarySha256,
  service: "User-authorized Alibaba Cloud workspace",
  servicePaths: {
    chat_completions: "/compatible-mode/v1/chat/completions",
    responses: "/compatible-mode/v1/responses",
    messages: "/apps/anthropic/v1/messages",
  },
  models: selectedModels,
  mode: skillsFrom
    ? "explicit_skill_memory_workflow"
    : glmFrom
      ? "explicit_glm_proposal_followup"
      : teamOnlyFrom
        ? "explicit_team_only_retest"
        : focusedFormatValidation
          ? "new_engine_format_validation"
          : "original_full_suite",
  expectedChecks,
  previousEvidence: previousEvidence || null,
  checks: [],
  boundaries: [
    "Different families are identified from model names actually returned by the service, not inferred from profile labels.",
    "Image input uses the built-in 64x64 blue probe only, not image generation.",
    "Every scenario starts explicitly once. No model fallback or automatic retry.",
    "Real service calls use synthetic test data; no personal browser, user project, business document or production account operation.",
  ],
  scripts: Object.fromEntries(
    await Promise.all(
      ["check", "files", "support", "probes", "launch", "skills"].map(async (name) => {
        const file = `scripts/p13-real-model-${name}.mjs`;
        return [
          file,
          createHash("sha256")
            .update(await readFile(file))
            .digest("hex"),
        ];
      }),
    ),
  ),
};
const ctx = { directory, redact, report, roots: new Set(), traces: {}, events: [] };
let engine;
async function flush() {
  await saveEvidence(ctx, "report.json", report);
  await saveEvidence(ctx, "task-traces.json", ctx.traces);
  await saveEvidence(ctx, "events.json", ctx.events);
}
async function clearCredentials(owner, cleanup) {
  const catalog = await owner.request({ kind: "read", query: { kind: "profiles" } });
  assert.equal(catalog.kind, "profiles");
  for (const { profile } of catalog.catalog.profiles) {
    try {
      assert(
        selectedModels.some((p) => p.id === profile.id),
        "Refuse to clear a credential not created by this test",
      );
      const cleared = await owner.request({
        kind: "save_provider",
        profile,
        secret: null,
        clear_credential: true,
      });
      assert.equal(cleared.kind, "provider_saved");
      cleanup.profilesCleared++;
    } catch (e) {
      cleanup.errors.push("Profile cleanup: " + redact(String(e)));
    }
  }
  const clean = await owner.request({ kind: "read", query: { kind: "profiles" } });
  cleanup.credentialsRemoved =
    clean.kind === "profiles" &&
    clean.catalog.profiles.every((p) => !p.credential_saved && !p.profile.credential);
  cleanup.scope =
    "Only this fresh data directory's test model credentials were removed. No image-service credential was created. The isolated database, file-version key and original test files remain available for fault review.";
}
async function scenario(id, work) {
  const result = { id, at: new Date().toISOString(), state: "running" };
  report.checks.push(result);
  console.log(JSON.stringify({ begin: id }));
  try {
    await work(result);
    result.state = "passed";
  } catch (e) {
    result.state = "failed";
    result.error = redact(String(e.stack || e));
  }
  result.finishedAt = new Date().toISOString();
  await flush();
  console.log(
    redact({
      end: id,
      state: result.state,
      actualModel: result.actualReportedModel || null,
    }),
  );
  return result.state === "passed";
}
try {
  engine = await launchEngine(binary, join(directory, "data"), (event) => ctx.events.push(event));
  ctx.request = async (command) => {
    const response = await engine.request(command);
    if (response.kind === "error") throw new Error(redact(response));
    return response;
  };
  const ready = ctx.events.find((e) => e.kind === "ready");
  report.appVersion = ready?.version;
  assert.equal(
    ready?.version,
    process.env.WORKPILOT_EXPECTED_VERSION || "0.1.0-alpha.13.2",
    "Use the agreed current candidate, not an older executable",
  );
  const available = JSON.parse(await readFile(".local/p13-available-models.json", "utf8"));
  for (const spec of selectedModels) {
    assert(
      available.models.includes(spec.model),
      "The selected model was not present in the user-authorized service list",
    );
    const profile = provider(spec);
    if (
      previousReport?.checks.some((c) => c.id === `probe:${spec.id}:tools` && c.state === "passed")
    ) {
      // This fresh profile is explicitly configured from the recorded real probe.
      // Do not pretend a probe ran in this new directory or copy an old credential.
      profile.supports_tools = true;
      profile.capabilities.tools = { supported: true, source: "user", checked_at_ms: null };
    }
    const saved = await ctx.request({
      kind: "save_provider",
      profile,
      secret: setup.key,
      clear_credential: false,
    });
    assert.equal(saved.kind, "provider_saved");
  }
  if (skillsFrom) {
    await skillsMemory(ctx, selectedModels[0], scenario);
  } else {
    const toolPassed = new Set();
    if (previousReport) {
      for (const spec of plannedModels)
        if (
          previousReport.checks.some(
            (c) => c.id === `probe:${spec.id}:tools` && c.state === "passed",
          )
        )
          toolPassed.add(spec.id);
    } else {
      for (const spec of plannedModels) {
        for (const mode of focusedFormatValidation ? ["tools"] : spec.modes) {
          const passed = await scenario(`probe:${spec.id}:${mode}`, (result) =>
            probe(ctx, spec, mode, result),
          );
          if (passed && mode === "tools") toolPassed.add(spec.id);
        }
      }
      for (const spec of plannedModels.filter((p) => p.family === "Qwen")) {
        await scenario(`files:${spec.protocol}`, async (result) => {
          assert(
            toolPassed.has(spec.id),
            "This profile did not pass its tool probe; no file task was started",
          );
          await singleFile(ctx, spec, result);
        });
      }
    }
    if (glmFrom) {
      const spec = plannedModels.find((p) => p.id === "p13-glm-chat");
      const passed = await scenario("probe:p13-glm-chat:tools", (result) =>
        probe(
          ctx,
          spec,
          "tools",
          result,
          'This is a diagnostic proposal test. Generate exactly one structured tool call to workpilot_echo with arguments {"message":"WorkPilot"}. You are only proposing the call; the host will not execute it in this diagnostic phase. The phrase "this phase never executes it" describes the host behavior, not a prohibition on producing a tool-call proposal. Return the structured tool call, not an explanation or simulated tool output.',
        ),
      );
      if (passed) toolPassed.add(spec.id);
    }
    await scenario("team:three_members_distinct_model_families", async (result) => {
      for (const id of ["p13-qwen-responses", teamAlpha, "p13-deepseek-chat"])
        assert(
          toolPassed.has(id),
          `Required model tool probe did not pass: ${id}; no substitute selected`,
        );
      await distinctModelTeam(ctx, plannedModels, result, {
        alphaProfile: teamAlpha,
        clarifyNull: !!teamOnlyFrom,
        alphaExisting,
      });
    });
  }
} catch (e) {
  report.fatalError = redact(String(e.stack || e));
} finally {
  const cleanup = { profilesCleared: 0, credentialsRemoved: false, errors: [] };
  report.cleanup = cleanup;
  if (engine) {
    try {
      const calls = await engine.request({
        kind: "read",
        query: { kind: "model_calls", limit: 64 },
      });
      for (const call of calls.calls || [])
        if (call.state === "running")
          await engine.request({ kind: "cancel_model_probe", call_id: call.id });
      for (const task_id of ctx.roots) {
        const r = await engine.request({ kind: "read", query: { kind: "execution", task_id } });
        if (
          r.kind === "execution" &&
          ["queued", "running", "awaiting_input", "awaiting_approval"].includes(
            r.snapshot.task.state,
          )
        )
          await engine.request({ kind: "cancel", task_id });
      }
      await delay(150);
      for (const task of ctx.roots) {
        try {
          await traceTask(ctx, task);
          const team = await engine.request({
            kind: "read",
            query: { kind: "team", task_id: task },
          });
          for (const member of team.view?.members || []) await traceTask(ctx, member.task_id);
        } catch (e) {
          cleanup.errors.push("Final trace: " + redact(String(e)));
        }
      }
    } catch (e) {
      cleanup.errors.push("Stop test work: " + redact(String(e)));
    }
    try {
      await clearCredentials(engine, cleanup);
    } catch (e) {
      cleanup.errors.push("Credential verification: " + redact(String(e)));
    }
    try {
      await engine.close();
      cleanup.engineExited = true;
    } catch (e) {
      cleanup.errors.push("Engine exit: " + redact(String(e)));
    }
    if (!cleanup.credentialsRemoved) {
      let cleaner;
      try {
        cleaner = await launchEngine(binary, join(directory, "data"));
        cleanup.reopenedOnlyForCredentialCleanup = true;
        await clearCredentials(cleaner, cleanup);
      } catch (e) {
        cleanup.errors.push("Isolated credential cleanup retry: " + redact(String(e)));
      } finally {
        await cleaner
          ?.close()
          .catch((e) => cleanup.errors.push("Cleanup engine exit: " + redact(String(e))));
      }
    }
  }
  report.finishedAt = new Date().toISOString();
  report.status =
    !report.fatalError &&
    report.checks.length === expectedChecks &&
    report.checks.every((c) => c.state === "passed") &&
    cleanup.credentialsRemoved &&
    !cleanup.errors.length
      ? "passed"
      : "failed";
  await flush();
  report.credentialScan = await scanPlaintext(directory, setup.key);
  if (report.credentialScan.plaintextCredentialFound) report.status = "failed";
  setup.key = "";
  await saveEvidence(ctx, "report.json", report);
  console.log(
    JSON.stringify({
      directory,
      status: report.status,
      passed: report.checks.filter((c) => c.state === "passed").length,
      checks: report.checks.length,
      credentialsRemoved: cleanup.credentialsRemoved,
      plaintextCredentialFound: report.credentialScan.plaintextCredentialFound,
    }),
  );
  if (report.status !== "passed") process.exitCode = 1;
}
