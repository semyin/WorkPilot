import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { saveProfile, createTask } from "./p13-engine-load.mjs";
import { start, finished, snapshot, team, eventually } from "./p13-engine-client.mjs";
import { stopSamples } from "./p13-engine-lifecycle.mjs";
export async function prepareModels(context) {
  const { engine, fixture } = context;
  const suffix = crypto.randomUUID();
  const leaf = await saveProfile(engine, fixture, "soak-leaf-" + suffix, {
    kind: "leaf",
    delay: 1000,
    text: "Fixed soak delivery, total 42.",
  });
  const cancellationModel = "soak-cancel-" + suffix;
  const cancellation = await saveProfile(engine, fixture, cancellationModel, {
    kind: "hold",
    ms: 1500,
  });
  const lead = await saveProfile(engine, fixture, "soak-lead-" + suffix, {
    kind: "main",
    members: Array.from({ length: 3 }, (_, i) => ({
      key: "member-" + i,
      role: "Stable synthetic worker",
      goal: "Return fixed delivery 42",
      profile_id: leaf,
      depends_on: [],
    })),
  });
  const seed = await createTask(engine, leaf, "P13 soak scheduler setup", context.project);
  const scheduler = (await team(engine, seed)).scheduler;
  assert.equal(
    (
      await engine.request({
        kind: "configure_scheduler",
        settings: { max_running: 8, revision: scheduler.revision },
      })
    ).kind,
    "receipt",
  );
  return { leaf, lead, cancellation, cancellationModel };
}
export async function taskCycle(context, index) {
  const { engine, profiles, project, session } = context;
  const roots = await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      createTask(engine, profiles.leaf, `P13 soak ${index} root ${i}`, project),
    ),
  );
  const title = `P13 soak ${index} team`;
  const lead = await createTask(engine, profiles.lead, title, project);
  assert.equal(
    (
      await engine.request({
        kind: "configure_team",
        task_id: lead,
        settings: {
          enabled: true,
          max_parallel: 3,
          max_members: 8,
          max_depth: 2,
          max_replacements: 0,
          revision: 0,
        },
      })
    ).kind,
    "receipt",
  );
  // Select through the normal task button; do not reload the page and hide heap growth.
  await session.page
    .getByRole("button", { name: new RegExp(title) })
    .first()
    .click();
  await Promise.all([...roots, lead].map((task) => start(engine, task)));
  await eventually(
    async () => {
      const value = await snapshot(engine, roots[0]);
      return value.steps.some((step) => step.kind === "model" && step.state === "running");
    },
    15000,
    20,
  );
  const queuedText = `Queued instruction for cycle ${index}`;
  assert.equal(
    (await engine.request({ kind: "enqueue", task_id: roots[0], text: queuedText })).kind,
    "receipt",
  );
  const before = await snapshot(engine, roots[0]);
  const queued = before.messages.filter((message) => message.state === "queued");
  assert.equal(queued.length, 1, "New request must be queued while the current model step runs");
  await Promise.all([...roots, lead].map((task) => finished(engine, task)));
  const after = await snapshot(engine, roots[0]);
  assert(
    queued.every((message) =>
      after.messages.some((current) => current.id === message.id && current.state === "delivered"),
    ),
  );
  assert.equal(
    after.steps.filter((step) => step.kind === "model" && step.state === "completed").length,
    2,
    "The queued request must be delivered once at the next safe model boundary",
  );
  const members = (await team(engine, lead)).members;
  assert.equal(members.length, 3);
  assert(members.every((member) => member.state === "completed" && member.review === "accepted"));
  return {
    roots,
    lead,
    members: members.map((member) => member.task_id),
    queuedMessageId: queued[0].id,
  };
}
export async function cancellationCycle(context, index) {
  const { engine, fixture, profiles } = context;
  const task = await createTask(engine, profiles.cancellation, `P13 soak ${index} cancellation`);
  const calls = () =>
    fixture.records.filter((row) => row.model === profiles.cancellationModel).length;
  const before = calls();
  await start(engine, task);
  await eventually(() => calls() === before + 1);
  assert.equal((await engine.request({ kind: "cancel", task_id: task })).kind, "receipt");
  await finished(engine, task, "interrupted");
  await delay(150);
  assert.equal(calls(), before + 1, "A cancelled model call must not retry itself");
  await start(engine, task);
  await finished(engine, task);
  assert.equal(calls(), before + 2);
  return { task, modelCalls: 2, explicitResume: true };
}
export async function nodeCycle(context, index) {
  const output = join(context.output, `node-cycle-${index}`);
  await mkdir(output);
  return stopSamples({
    ...context,
    output,
    collector: context.telemetry.adapter,
    options: { stopSamples: 1, toolSampleHoldMs: 2500 },
  });
}
export async function scheduledCycle(context, index) {
  const admin = async (action) => {
    const response = await context.engine.request({ kind: "schedules", action });
    assert.equal(response.kind, "schedules", JSON.stringify(response));
    return response.data;
  };
  const dueAt = Date.now() + 6000;
  const spec = {
    title: `P13 owned timer ${index}`,
    goal: "Return fixed value 42",
    project_id: null,
    profile_id: context.profiles.leaf,
    mode: "chat",
    permission: "request_approval",
    review_profile_id: null,
    commands_enabled: false,
    timezone: "UTC",
    rule: { kind: "once", local: new Date(dueAt).toISOString().slice(0, 19) },
    enabled: true,
  };
  const saved = await admin({ kind: "save", schedule_id: null, revision: 0, spec });
  const history = () =>
    admin({ kind: "history", schedule_id: saved.schedule_id, before: null, limit: 64 });
  const occurrence = await eventually(
    async () => (await history()).items.find((row) => row.task_id),
    20000,
    100,
  );
  assert.equal(occurrence.trigger, "timer");
  await finished(context.engine, occurrence.task_id);
  assert.equal((await history()).items.length, 1);
  // Completed one-shot plans remain inspectable but cannot schedule future test work.
  await admin({ kind: "set_enabled", schedule_id: saved.schedule_id, revision: 1, enabled: false });
  return {
    scheduleId: saved.schedule_id,
    task: occurrence.task_id,
    dueAtMs: dueAt,
    trigger: occurrence.trigger,
  };
}
