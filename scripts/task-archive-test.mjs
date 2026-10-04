import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  launch,
  profile,
  create,
  snapshot,
  start,
  until,
  setFixture,
} from "./tool-test-support.mjs";
import { startTeamFixture } from "../services/execution-fixtures/teams.mjs";

const output = resolve(process.env.WORKPILOT_TEST_OUTPUT || ".test-results/task-archive");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, "session-"));
const binary = process.env.WORKPILOT_ENGINE_BINARY || resolve("target/debug/workpilot-engine.exe");
const report = {
  at: new Date().toISOString(),
  platform: process.platform,
  binarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  service: "Local synthetic model; real engines, encrypted files and separate data roots",
  checks: [],
};
const fixture = await startTeamFixture();
setFixture(fixture);
const passphrase = "task archive fixture " + crypto.randomUUID();
const sourceDirectory = join(directory, "source"),
  targetDirectory = join(directory, "target");
const archive = join(directory, "主任务与助手.wptask"),
  copied = join(directory, "重新备份.wptask");
let source, target;
const raw = (engine, action) => engine.request({ kind: "task_archive", action });
const call = async (engine, action) => {
  const response = await raw(engine, action);
  assert.equal(response.kind, "workbench", JSON.stringify(response));
  return response.data;
};
async function content(engine, reference) {
  let text = "",
    offset = 0;
  while (offset < reference.bytes) {
    const r = await engine.request({
      kind: "read",
      query: { kind: "content", object_id: reference.object_id, offset, limit: 65536 },
    });
    assert.equal(r.kind, "content");
    assert(r.page.next_offset > offset);
    text += r.page.text;
    offset = r.page.next_offset;
  }
  return text;
}
try {
  source = await launch(sourceDirectory);
  const first = profile("responses", "archive-research"),
    second = profile("messages", "archive-review");
  const long = "中文研究资料 42 preserved\n".repeat(400);
  for (const [p, text] of [
    [first, long],
    [second, "核对完成 007"],
  ]) {
    fixture.definitions.set(p.model, { kind: "leaf", text });
    assert.equal(
      (
        await source.request({
          kind: "save_provider",
          profile: p,
          secret: null,
          clear_credential: false,
        })
      ).kind,
      "provider_saved",
    );
  }
  const model = "archive-main";
  fixture.definitions.set(model, {
    kind: "main",
    members: [
      {
        key: "research",
        role: "研究助手",
        goal: "保存完整研究正文",
        profile_id: first.id,
        depends_on: [],
      },
      {
        key: "review",
        role: "核对助手",
        goal: "核对研究结论",
        profile_id: second.id,
        depends_on: ["research"],
      },
    ],
  });
  const root = await create(source, "responses", model, {
    title: "任务档案验收",
    controlled_tools: false,
    limits: {
      max_steps: 64,
      max_duration_ms: 90000,
      context_bytes: 262144,
      max_result_bytes: 65536,
    },
  });
  await start(source, root);
  const finished = await until(async () => {
    const current = await snapshot(source, root);
    return ["completed", "failed", "interrupted"].includes(current.task.state) && current;
  }, 90000);
  assert.equal(finished.task.state, "completed", JSON.stringify(finished.latest_run?.diagnostic));
  const team = await source.request({ kind: "read", query: { kind: "team", task_id: root } });
  assert.equal(team.view.members.length, 2);
  assert(team.view.members.every((m) => m.state === "completed" && m.review === "accepted"));
  await source.request({ kind: "enqueue", task_id: root, text: "以后继续时保留的排队要求" });
  const before = await snapshot(source, root);
  const exporting = { kind: "export", task_id: root, path: archive, password: passphrase };
  const exported = await call(source, exporting);
  assert.equal(exported.summary.tasks.length, 3);
  assert(exported.summary.counts.execution_steps > 8);
  assert.equal((await raw(source, exporting)).kind, "error");
  assert.equal(
    (await raw(source, { ...exporting, task_id: team.view.members[0].task_id, path: copied })).kind,
    "error",
  );
  assert.deepEqual(await snapshot(source, root), before);
  const encrypted = await readFile(archive);
  assert.equal(encrypted.subarray(0, 8).toString(), "WPTASK01");
  for (const privateText of [passphrase, "任务档案验收", "中文研究资料", "以后继续时"])
    assert(!encrypted.includes(Buffer.from(privateText)));
  report.checks.push({
    name: "stopped_root_and_two_real_assistants_with_full_records_encrypted_source_unchanged",
    passed: true,
    tasks: 3,
    steps: exported.summary.counts.execution_steps,
  });

  target = await launch(targetDirectory);
  const live = await create(target, "responses", "keep-live-task");
  const liveBefore = await snapshot(target, live);
  const inspecting = { kind: "inspect", path: archive, password: passphrase };
  assert.equal(
    (await raw(target, { ...inspecting, password: "wrong archive passphrase" })).kind,
    "error",
  );
  const bad = join(directory, "damaged.wptask");
  const corrupt = Buffer.from(encrypted);
  corrupt[corrupt.length - 1] ^= 1;
  await writeFile(bad, corrupt);
  assert.equal((await raw(target, { ...inspecting, path: bad })).kind, "error");
  await writeFile(bad, Buffer.concat([encrypted, Buffer.from("trailing")]));
  assert.equal((await raw(target, { ...inspecting, path: bad })).kind, "error");
  assert.equal((await call(target, { kind: "list" })).archives.length, 0);
  const preview = await call(target, inspecting);
  assert.equal(preview.already_imported, false);
  const importing = { ...inspecting, kind: "import", fingerprint: preview.fingerprint };
  assert.equal((await raw(target, { ...importing, fingerprint: "0".repeat(64) })).kind, "error");
  const result = await call(target, importing);
  assert.equal(result.duplicate, false);
  assert.equal((await call(target, importing)).duplicate, true);
  assert.deepEqual(await snapshot(target, live), liveBefore);
  const tasks = await target.request({ kind: "read", query: { kind: "executions", limit: 64 } });
  assert.equal(tasks.kind, "executions", JSON.stringify(tasks));
  assert.equal(tasks.tasks.length, 1);
  report.checks.push({
    name: "wrong_passphrase_corruption_trailing_data_stale_preview_rejected_atomic_idempotent_import_no_execution",
    passed: true,
  });

  const id = result.archive_id;
  for (const [table, expected] of Object.entries(exported.summary.counts)) {
    let offset = 0,
      count = 0;
    do {
      const page = await call(target, { kind: "records", archive_id: id, table, offset, limit: 7 });
      assert.equal(page.total, expected);
      for (const record of page.records) {
        const value = JSON.parse(await content(target, record.content));
        assert.equal(typeof value, "object");
        count++;
      }
      offset = page.next_offset;
    } while (offset < expected);
    assert.equal(count, expected);
  }
  let offset = 0,
    foundLong = false;
  do {
    const page = await call(target, {
      kind: "records",
      archive_id: id,
      table: "contents",
      offset,
      limit: 32,
    });
    for (const r of page.records) {
      const text = await content(target, r.content);
      if (text === long) foundLong = true;
      if (r.content.media_type === "application/json") {
        const value = JSON.parse(text);
        if (value.text === long) foundLong = true;
      }
    }
    offset = page.next_offset;
    if (offset >= page.total) break;
  } while (true);
  assert(foundLong, "full assistant body was not retained");
  assert.equal(
    (
      await raw(target, {
        kind: "records",
        archive_id: id,
        table: "settings",
        offset: 0,
        limit: 16,
      })
    ).kind,
    "error",
  );
  report.checks.push({
    name: "all_29_record_categories_paged_full_assistant_body_and_original_task_links_readable",
    passed: true,
    fullBodyBytes: Buffer.byteLength(long),
  });

  await call(target, { kind: "export_saved", archive_id: id, path: copied, password: passphrase });
  assert.equal((await raw(target, { ...importing, path: copied })).kind, "error");
  await target.close();
  target = await launch(targetDirectory);
  const rePreview = await call(target, { ...inspecting, path: copied });
  assert.equal(rePreview.already_imported, true);
  assert.equal(
    (
      await call(target, {
        kind: "import",
        path: copied,
        password: passphrase,
        fingerprint: rePreview.fingerprint,
      })
    ).duplicate,
    true,
  );
  assert.equal((await call(target, { kind: "list" })).archives.length, 1);
  assert.deepEqual(await snapshot(target, live), liveBefore);
  report.checks.push({
    name: "restart_reexport_different_ciphertext_same_archive_deduplicated",
    passed: true,
  });

  const activeModel = "archive-active";
  fixture.definitions.set(activeModel, { kind: "hold", ms: 3000 });
  const activeTask = await create(source, "responses", activeModel);
  await start(source, activeTask);
  assert.equal(
    (
      await raw(source, {
        ...exporting,
        task_id: activeTask,
        path: join(directory, "active.wptask"),
      })
    ).kind,
    "error",
  );
  await source.request({ kind: "cancel", task_id: activeTask });
  const credential = "TASK-ARCHIVE-CREDENTIAL-CANARY-" + crypto.randomUUID();
  const secretTask = await create(source, "responses", "secret-fixture", { goal: credential });
  const p = profile("responses", "registered-archive-secret");
  p.auth = "bearer";
  assert.equal(
    (
      await source.request({
        kind: "save_provider",
        profile: p,
        secret: credential,
        clear_credential: false,
      })
    ).kind,
    "provider_saved",
  );
  try {
    assert.equal(
      (
        await raw(source, {
          ...exporting,
          task_id: secretTask,
          path: join(directory, "secret.wptask"),
        })
      ).kind,
      "error",
    );
  } finally {
    await source.request({
      kind: "delete_provider",
      profile_id: p.id,
      expected_revision: p.revision,
    });
  }
  await source.close();
  source = null;
  await target.close();
  target = null;
  for (const location of [join(sourceDirectory, "test"), join(targetDirectory, "test")]) {
    for (const name of await readdir(location)) {
      if (name.endsWith(".jsonl"))
        assert(
          !(await readFile(join(location, name))).includes(Buffer.from(passphrase)),
          "passphrase entered diagnostics",
        );
    }
    assert(
      !(await readFile(join(location, "workpilot.sqlite3"))).includes(Buffer.from(passphrase)),
      "passphrase entered database",
    );
  }
  report.checks.push({
    name: "active_work_registered_secret_and_child_selection_rejected_passphrase_absent_from_records",
    passed: true,
  });
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  throw error;
} finally {
  await source?.close();
  await target?.close();
  await fixture.close();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
