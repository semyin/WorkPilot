import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { startToolFixture } from "../services/execution-fixtures/tools.mjs";
import { launch, create, profile, start, terminal, setFixture } from "./tool-test-support.mjs";

const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/p13-permission-matrix");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "session-"));
const binary = resolve(process.env.WORKPILOT_ENGINE_BINARY || "target/debug/workpilot-engine.exe");
const report = {
  at: new Date().toISOString(),
  binarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  service: "Fixed local model deliberately requests a write; real engine and isolated files",
  rows: [],
};
const fixture = await startToolFixture();
setFixture(fixture);
let engine;
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );
try {
  engine = await launch(directory);
  for (const protocol of ["chat_completions", "responses", "messages"]) {
    const reviewer = profile(protocol, "review-approve");
    assert.equal(
      (
        await engine.request({
          kind: "save_provider",
          profile: reviewer,
          secret: null,
          clear_credential: false,
        })
      ).kind,
      "provider_saved",
    );
    for (const mode of ["chat", "plan", "execute"]) {
      for (const permission of ["request_approval", "auto_review", "full_access"]) {
        const model = `matrix-${protocol}-${mode}-${permission}`;
        const text = `Owned matrix output ${model}`;
        fixture.recipes.set(model, [
          {
            name: "write_file",
            args: {
              path: "result.txt",
              text,
              expected_sha256: null,
            },
          },
        ]);
        const task = await create(engine, protocol, model, { mode, controlled_tools: false });
        const folder = join(directory, model);
        await mkdir(folder);
        assert.equal(
          (
            await engine.request({
              kind: "configure_task_tools",
              task_id: task,
              settings: {
                root_path: folder,
                permission,
                commands_enabled: false,
                review_profile_id: reviewer.id,
                revision: 0,
              },
            })
          ).kind,
          "receipt",
        );
        await start(engine, task);
        let snapshot = await terminal(engine, task);
        const state = await engine.request({
          kind: "read",
          query: { kind: "task_tools", task_id: task },
        });
        assert.equal(state.kind, "task_tools");
        const row = { protocol, mode, permission, taskId: task, initialState: snapshot.task.state };
        const path = join(folder, "result.txt");
        if (mode !== "execute") {
          assert.equal(await exists(path), false);
          assert(!snapshot.steps.some((s) => s.name === "write_file" && s.state === "completed"));
          assert.equal(state.state.changes.length, 0);
          row.result = "no_write_despite_model_request_and_permission_setting";
        } else {
          if (permission === "request_approval") {
            assert.equal(snapshot.task.state, "awaiting_approval");
            assert.equal(await exists(path), false);
            const approval = state.state.approvals.find((a) => a.state === "pending");
            assert(approval);
            assert.equal(
              (
                await engine.request({
                  kind: "decide_tool_approval",
                  task_id: task,
                  approval_id: approval.id,
                  fingerprint: approval.fingerprint,
                  approve: true,
                })
              ).kind,
              "receipt",
            );
            await start(engine, task);
            snapshot = await terminal(engine, task);
            row.result = "waits_for_concrete_approval_then_writes_once";
          } else {
            const expected =
              permission === "auto_review"
                ? "independent_model_review"
                : "rule:user_selected_full_access";
            assert.equal(state.state.approvals[0].decided_by, expected);
            row.result =
              permission === "auto_review" ? "independent_review_approves" : "explicit_full_access";
          }
          assert.equal(snapshot.task.state, "completed");
          assert.equal(await readFile(path, "utf8"), text);
          const final = await engine.request({
            kind: "read",
            query: { kind: "task_tools", task_id: task },
          });
          assert.equal(final.state.changes.length, 1);
          row.finalState = snapshot.task.state;
        }
        report.rows.push(row);
      }
    }
  }
  assert.equal(report.rows.length, 27);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  await engine?.close();
  await fixture.close();
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(
    join(output, "latest.json"),
    JSON.stringify({ directory, status: report.status }) + "\n",
  );
}
console.log(
  JSON.stringify({
    status: report.status,
    rows: report.rows.length,
    directory,
    error: report.error,
  }),
);
