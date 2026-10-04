import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { distribution } from "./p13-benchmark-metrics.mjs";
import { start, snapshot, team, finished, eventually } from "./p13-engine-client.mjs";

export async function saveProfile(engine, fixture, model, definition) {
  fixture.definitions.set(model, definition);
  const capability = { supported: true, source: "user", checked_at_ms: null };
  const profile = {
    id: crypto.randomUUID(),
    label: model,
    model,
    protocol: "responses",
    base_url: fixture.url,
    auth: "none",
    credential: null,
    supports_tools: true,
    supports_images: false,
    revision: 1,
    capabilities: {
      text: capability,
      streaming: capability,
      tools: capability,
      images: { ...capability, supported: false },
      usage: capability,
    },
    options: {
      max_output_tokens: 1024,
      temperature: null,
      reasoning_effort: null,
      chat_token_parameter: "max_completion_tokens",
      timeout_ms: 20000,
      idle_timeout_ms: 15000,
      anthropic_version: "2023-06-01",
    },
    pricing: null,
  };
  const saved = await engine.request({
    kind: "save_provider",
    profile,
    secret: null,
    clear_credential: false,
  });
  assert.equal(saved.kind, "provider_saved", JSON.stringify(saved));
  return profile.id;
}
export async function createTask(engine, profileId, title, project) {
  const created = await engine.request({
    kind: "create_execution",
    config: {
      title,
      goal: "P13 isolated benchmark: " + title,
      constraints: ["Only synthetic local data"],
      project_rules: "",
      project_id: null,
      profile_id: profileId,
      mode: "execute",
      controlled_tools: false,
      limits: {
        max_steps: 96,
        max_duration_ms: 90000,
        context_bytes: 262144,
        max_result_bytes: 65536,
      },
    },
  });
  assert.equal(created.kind, "receipt", JSON.stringify(created));
  const task = created.receipt.task_id;
  if (project) {
    const configured = await engine.request({
      kind: "configure_task_tools",
      task_id: task,
      settings: {
        root_path: project,
        permission: "full_access",
        commands_enabled: true,
        review_profile_id: null,
        revision: 0,
      },
    });
    assert.equal(configured.kind, "receipt", JSON.stringify(configured));
  }
  return task;
}
export async function timedRequest(engine, command, expected, samples) {
  const began = performance.now();
  const reply = await engine.request(command);
  samples.push(performance.now() - began);
  assert.equal(reply.kind, expected, JSON.stringify(reply));
  return reply;
}

export async function loadScenario(context, kind, count) {
  const { engine, fixture, project, options, observer, collector } = context;
  const name = `${kind}-${count}`;
  const roots = new Set();
  const phase = { roots, peakRunning: 0, peakAssistants: 0 };
  observer.phase(phase);
  await collector.targets([{ ...engine.identity, role: "engine", phase: name }]);
  const leaf = await saveProfile(engine, fixture, "p13-" + name + "-leaf", {
    kind: "leaf",
    delay: options.modelDelayMs,
    text: "P13 fixed local response. ".repeat(16),
  });
  const profile =
    kind === "tasks"
      ? leaf
      : await saveProfile(engine, fixture, "p13-" + name + "-lead", {
          kind: "main",
          members: Array.from({ length: count }, (_, i) => ({
            key: "member-" + i,
            role: "Benchmark member",
            goal: "Return the fixed synthetic result",
            profile_id: leaf,
            depends_on: [],
          })),
        });
  const samples = { ping: [], taskList: [], executionRead: [], teamRead: [], waveCompletion: [] };
  const raw = [];
  let activeTasks = [],
    waves = 0,
    completedRoots = 0,
    completedMembers = 0,
    modelRequests = 0;
  let done = false,
    abort = false,
    waveError;
  const began = performance.now();
  const work = (async () => {
    try {
      do {
        activeTasks = await Promise.all(
          Array.from({ length: kind === "tasks" ? count : 1 }, (_, i) =>
            createTask(engine, profile, `${name} wave ${waves} root ${i}`, project),
          ),
        );
        activeTasks.forEach((task) => roots.add(task));
        if (kind === "assistants") {
          const configured = await engine.request({
            kind: "configure_team",
            task_id: activeTasks[0],
            settings: {
              enabled: true,
              max_parallel: count,
              max_members: 16,
              max_depth: 2,
              max_replacements: 0,
              revision: 0,
            },
          });
          assert.equal(configured.kind, "receipt", JSON.stringify(configured));
        }
        const started = performance.now();
        await Promise.all(activeTasks.map((task) => start(engine, task)));
        await Promise.all(activeTasks.map((task) => finished(engine, task)));
        samples.waveCompletion.push(performance.now() - started);
        completedRoots += activeTasks.length;
        if (kind === "assistants") {
          const view = await team(engine, activeTasks[0]);
          assert.equal(view.members.length, count);
          assert(
            view.members.every(
              (member) => member.state === "completed" && member.review === "accepted",
            ),
          );
          completedMembers += view.members.length;
        }
        // Keep the fixture's retained request history bounded on longer runs.
        modelRequests += fixture.records.length;
        fixture.records.length = 0;
        fixture.starts.length = 0;
        waves++;
      } while (!abort && performance.now() - began < options.windowMs);
    } catch (error) {
      waveError = error;
    } finally {
      done = true;
    }
  })();
  let controlError;
  try {
    await eventually(() => activeTasks.length || waveError);
    for (let index = 0; index < options.samples; index++) {
      if (waveError) throw waveError;
      const target = began + (index * options.windowMs) / options.samples;
      if (target > performance.now()) await delay(target - performance.now());
      await eventually(() => observer.running.size > 0 || done || waveError);
      if (waveError) throw waveError;
      const task = activeTasks[0];
      const running = observer.running.size;
      await timedRequest(engine, { kind: "ping" }, "receipt", samples.ping);
      await timedRequest(
        engine,
        { kind: "read", query: { kind: "tasks", before: null, limit: 20 } },
        "tasks",
        samples.taskList,
      );
      const value = await timedRequest(
        engine,
        { kind: "read", query: { kind: "execution", task_id: task } },
        "execution",
        samples.executionRead,
      );
      if (kind === "assistants")
        await timedRequest(
          engine,
          { kind: "read", query: { kind: "team", task_id: task } },
          "team",
          samples.teamRead,
        );
      raw.push({
        sample: index,
        atMs: Math.round(performance.now() - began),
        running,
        state: value.snapshot.task.state,
        workFinished: done,
      });
    }
  } catch (error) {
    controlError = error;
    abort = true;
  }
  await work;
  if (controlError || waveError) observer.phase(null);
  if (controlError) throw controlError;
  if (waveError) throw waveError;
  await eventually(() => observer.running.size === 0);
  assert(phase.peakRunning <= 8);
  if (kind === "assistants") assert(phase.peakAssistants <= count);
  observer.phase(null);
  return {
    name,
    kind,
    requested: count,
    configuredGlobalLimit: 8,
    configuredTeamLimit: kind === "assistants" ? count : null,
    elapsedMs: Math.round(performance.now() - began),
    waves,
    completedRoots,
    completedMembers,
    modelRequests,
    observedPeakRunning: phase.peakRunning,
    observedPeakAssistants: phase.peakAssistants,
    samplesObservedDuringActiveWork: raw.filter((sample) => sample.running > 0).length,
    metricsMs: Object.fromEntries(
      Object.entries(samples).map(([metric, values]) => [metric, distribution(values)]),
    ),
    rawMs: samples,
    observations: raw,
    timingBoundary:
      "Host IPC round-trip; wave completion includes configured fixture wait and is not Rust-only execution time. No DOM measurement.",
  };
}
