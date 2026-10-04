import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, relative, resolve } from "node:path";

export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function seedClosedHistory({ directory, taskId, ownerToken, closedProcess }) {
  assert(closedProcess.exitCode !== null || closedProcess.signalCode !== null);
  assert.equal(await readFile(join(directory, ".long-history-owner"), "utf8"), ownerToken);
  const absolute = resolve(directory);
  assert.equal((await realpath(directory)).toLowerCase(), absolute.toLowerCase());
  for (const target of [directory, join(directory, "test"), join(directory, "test/objects")])
    assert(!(await lstat(target)).isSymbolicLink(), "Test data must not traverse links");
  const database = join(directory, "test/workpilot.sqlite3");
  assert(!(await lstat(database)).isSymbolicLink());
  const body = Buffer.from("LONG_RECORD_BEGIN\n" + "文".repeat(700000) + "\nLONG_RECORD_END");
  const objectId = digest(body);
  const db = new DatabaseSync(database);
  const startedAtMs = Date.now();
  try {
    db.exec("PRAGMA foreign_keys=ON; BEGIN EXCLUSIVE");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM tasks WHERE id=?").get(taskId).n, 1);
    const before = db.prepare("SELECT COUNT(*) n FROM events WHERE task_id=?").get(taskId).n;
    let sequence = db
      .prepare("SELECT COALESCE(MAX(task_sequence),0) n FROM events WHERE task_id=?")
      .get(taskId).n;
    const insert = db.prepare(
      "INSERT INTO events(event_id,task_id,task_sequence,source,at_ms,payload_json) VALUES(?,?,?,'engine',?,?)",
    );
    for (let current = 0; current < 100000; current++)
      insert.run(
        randomUUID(),
        taskId,
        ++sequence,
        startedAtMs,
        JSON.stringify({ kind: "progress", current, total: 100000 }),
      );
    await writeFile(join(directory, "test/objects", objectId), body, { flag: "wx" });
    db.prepare(
      "INSERT INTO objects(id,bytes,media_type) VALUES(?,?,'text/plain; charset=utf-8')",
    ).run(objectId, body.length);
    const textEventId = randomUUID();
    const row = insert.run(
      textEventId,
      taskId,
      ++sequence,
      startedAtMs,
      JSON.stringify({
        kind: "text_delta",
        content: {
          object_id: objectId,
          bytes: body.length,
          media_type: "text/plain; charset=utf-8",
        },
      }),
    );
    db.prepare("INSERT INTO event_objects(event_sequence,object_id) VALUES(?,?)").run(
      row.lastInsertRowid,
      objectId,
    );
    db.prepare("UPDATE tasks SET last_sequence=? WHERE id=?").run(
      Number(row.lastInsertRowid),
      taskId,
    );
    db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM events WHERE task_id=?").get(taskId).n,
      before + 100001,
    );
    return {
      taskId,
      previousEventCount: before,
      seededProgressEvents: 100000,
      seededBodyEvents: 1,
      objectId,
      bodyBytes: body.length,
      bodyCharacters: body.toString("utf8").length,
      textEventId,
      textEventSequence: Number(row.lastInsertRowid),
      startedAtMs,
      endedAtMs: Date.now(),
      closedDatabaseOnly: true,
    };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* Preserve the original failure. */
    }
    throw error;
  } finally {
    db.close();
  }
}

export async function verifyFullExport({ path, directory, seed }) {
  const root = await realpath(join(directory, "test/exports"));
  const actual = await realpath(path);
  const offset = relative(root, actual);
  assert(
    offset && !offset.startsWith("..") && !offset.includes(":"),
    "Export outside own test data",
  );
  const ids = new Set();
  const progress = new Uint8Array(seed.seededProgressEvents);
  let header,
    count = 0,
    previousSequence = 0,
    foundBody = false;
  const lines = createInterface({
    input: createReadStream(join(actual, "events.jsonl")),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    const value = JSON.parse(line);
    if (!header) {
      header = value;
      assert.equal(header.format, "workpilot.complete-records");
      assert.equal(header.root_task_id, seed.taskId);
      assert.equal(header.credentials_included, false);
      continue;
    }
    count++;
    assert.equal(value.task_id, seed.taskId);
    assert(!ids.has(value.event_id), "Export contains a duplicate event");
    ids.add(value.event_id);
    assert(value.sequence > previousSequence);
    previousSequence = value.sequence;
    if (value.kind === "progress" && value.total === seed.seededProgressEvents) {
      assert.equal(progress[value.current], 0);
      progress[value.current] = 1;
    }
    if (value.event_id === seed.textEventId) {
      assert.equal(value.content.object_id, seed.objectId);
      foundBody = true;
    }
  }
  assert.equal(
    progress.reduce((total, n) => total + n, 0),
    seed.seededProgressEvents,
  );
  assert(foundBody);
  const objects = await readdir(join(actual, "objects"));
  for (const name of objects) {
    assert.match(name, /^[a-f0-9]{64}$/);
    assert.equal(digest(await readFile(join(actual, "objects", name))), name);
  }
  const body = await readFile(join(actual, "objects", seed.objectId));
  assert.equal(body.length, seed.bodyBytes);
  assert.equal(digest(body), seed.objectId);
  assert(body.toString("utf8").startsWith("LONG_RECORD_BEGIN\n"));
  assert(body.toString("utf8").endsWith("\nLONG_RECORD_END"));
  return {
    events: count,
    seededProgressVerified: progress.length,
    objects: objects.length,
    bodyBytes: body.length,
    bodySha256: digest(body),
    uniqueOrderedEvents: true,
  };
}
