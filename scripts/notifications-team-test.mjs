import assert from "node:assert/strict";
import { startTeamFixture } from "../services/execution-fixtures/teams.mjs";
import { saveProfile, createTask } from "./p13-engine-load.mjs";
import { request, until } from "./p13-desktop-support.mjs";

// Exercises the actual runtime parent-wait / automatic-resume path. Reading
// history alone cannot prove that the live notification worker filtered it.
export async function verifyAutomaticTeamWait({ page, invoke, report }) {
  const fixture = await startTeamFixture();
  const engine = { request: (command) => request(page, command) };
  try {
    const memberProfile = await saveProfile(engine, fixture, "notice-team-member", {
      kind: "leaf",
      delay: 3000,
      text: "Synthetic independent team result",
    });
    const leadProfile = await saveProfile(engine, fixture, "notice-team-lead", {
      kind: "main",
      members: [
        {
          key: "member",
          role: "Independent member",
          goal: "Return the synthetic result",
          profile_id: memberProfile,
          depends_on: [],
        },
      ],
    });
    const taskId = await createTask(engine, leadProfile, "Notification automatic team wait");
    assert.equal(
      (
        await engine.request({
          kind: "configure_team",
          task_id: taskId,
          settings: {
            enabled: true,
            max_parallel: 1,
            max_members: 2,
            max_depth: 1,
            max_replacements: 0,
            revision: 0,
          },
        })
      ).kind,
      "receipt",
    );
    assert.equal(
      (await engine.request({ kind: "start_execution", task_id: taskId })).kind,
      "receipt",
    );
    const detail = async () => {
      const result = await engine.request({
        kind: "read",
        query: { kind: "execution", task_id: taskId },
      });
      assert.equal(result.kind, "execution");
      assert.notEqual(result.snapshot.task.state, "failed", "Synthetic notification team failed");
      return result.snapshot;
    };
    await until(async () => {
      const state = await detail();
      return state.task.state === "awaiting_input" && state.latest_run?.reason === "team_waiting";
    });
    await until(async () => (await detail()).task.state === "completed");
    const snapshot = await until(async () => {
      const value = await invoke("notifications_snapshot");
      return (
        value.entries.some((notice) => notice.task_id === taskId && notice.kind === "completed") &&
        value
      );
    });
    const notices = snapshot.entries.filter((notice) => notice.task_id === taskId);
    // The completion notice fences the earlier wait event in the same worker.
    assert.deepEqual(
      notices.map((notice) => notice.kind),
      ["completed"],
    );
    const events = await engine.request({
      kind: "read",
      query: { kind: "events", task_id: taskId, after: 0, limit: 256 },
    });
    assert.equal(events.kind, "events");
    assert.equal(events.page.has_more, false);
    const waits = events.page.events.filter(
      (event) =>
        event.kind === "task_state_changed" &&
        event.state === "awaiting_input" &&
        event.reason === "team_waiting",
    );
    assert(waits.length > 0, "A real saved team_waiting transition must exist");
    const team = await engine.request({ kind: "read", query: { kind: "team", task_id: taskId } });
    assert.equal(team.kind, "team");
    assert.equal(team.view.members.length, 1);
    assert(
      team.view.members.every(
        (member) => member.state === "completed" && member.review === "accepted",
      ),
    );
    report.teamNotificationRegression = {
      taskId,
      waitingEvents: waits.map(({ event_id, sequence, reason }) => ({
        event_id,
        sequence,
        reason,
      })),
      notifications: notices.map(({ id, kind }) => ({ id, kind })),
      modelRequests: fixture.records.length,
      automaticallyCompleted: true,
      humanInputNotifications: 0,
    };
    report.checks.push(
      "real_team_wait_automatically_resumes_without_spurious_human_input_notification",
    );
  } finally {
    await fixture.close();
  }
}
