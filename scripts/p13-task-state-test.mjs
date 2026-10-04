import assert from "node:assert/strict";
import test from "node:test";
import { TaskReadStore } from "../apps/desktop/src/task-workspace/taskReadStore.ts";

const task = (id, state, sequence = 1, stamp = sequence) => ({
  id,
  project_id: null,
  title: id,
  state,
  mode: "execute",
  permission: "request_approval",
  profile_id: null,
  created_at_ms: 1,
  updated_at_ms: stamp,
  last_sequence: sequence,
});

test("late list replies cannot replace a newer detail, including equal millisecond timestamps", () => {
  const reads = new TaskReadStore();
  const old = reads.beginRead();
  const fresh = reads.beginRead();
  const running = task("A", "running", 10, 1000);
  const ended = task("A", "interrupted", 12, 1000);
  reads.observe([ended], fresh);
  reads.observe([running], old);
  assert.equal(reads.state(running), "interrupted");
  assert.deepEqual(reads.task(running), ended);
});

test("completed and failed observations propagate; a newer manual continuation may run again", () => {
  const reads = new TaskReadStore();
  for (const [state, seq] of [
    ["completed", 3],
    ["running", 5],
    ["failed", 6],
  ]) {
    reads.observe([task("A", state, seq)], reads.beginRead());
    assert.equal(reads.state(task("A", "queued")), state);
  }
});

test("read order protects equal-version metadata and queued team transitions", () => {
  const reads = new TaskReadStore();
  const before = reads.beginRead();
  const after = reads.beginRead();
  reads.observe([task("child", "queued", 9)], after);
  reads.observe([task("child", "interrupted", 9)], before);
  assert.equal(reads.state(task("child", "interrupted", 9)), "queued");
});

test("cancel shows intent until an actual terminal read started after acknowledgement", () => {
  const reads = new TaskReadStore();
  const current = task("A", "running", 3);
  reads.observe([current], reads.beginRead());
  const token = reads.requestStop("A");
  assert.equal(reads.state(current), "stopping");
  const inFlight = reads.beginRead();
  reads.acknowledgeStop("A", token);
  reads.observe([task("A", "interrupted", 4)], inFlight);
  assert.equal(reads.state(current), "stopping");
  reads.observe([task("A", "interrupted", 4)], reads.beginRead());
  assert.equal(reads.state(current), "interrupted");
});

test("a rejected cancel keeps the engine state and cannot remove another cancel intent", () => {
  const reads = new TaskReadStore();
  const current = task("A", "running");
  const first = reads.requestStop("A");
  const second = reads.requestStop("A");
  reads.rejectStop("A", first);
  assert.equal(reads.state(current), "stopping");
  reads.rejectStop("A", second);
  assert.equal(reads.state(current), "running");
});

test("selection changes do not transfer state or cancel intents to another task or member", () => {
  const reads = new TaskReadStore();
  const a = task("A", "running", 10);
  const b = task("B", "running", 10);
  const child = task("child", "running", 10);
  reads.observe([a, b, child], reads.beginRead());
  const token = reads.requestStop("A");
  assert.equal(reads.state(a), "stopping");
  assert.equal(reads.state(b), "running");
  assert.equal(reads.state(child), "running");
  reads.acknowledgeStop("A", token);
  reads.observe([task("A", "interrupted", 12)], reads.beginRead());
  assert.equal(reads.state(b), "running");
  assert.equal(reads.state(child), "running");
  reads.observe([task("child", "interrupted", 14)], reads.beginRead());
  assert.equal(reads.state(child), "interrupted");
});

test("unchanged polling does not publish new renders and cache size remains bounded", () => {
  const reads = new TaskReadStore();
  let renders = 0;
  const unsubscribe = reads.subscribe(() => renders++);
  const current = task("A", "running");
  reads.observe([current], reads.beginRead());
  reads.observe([{ ...current }], reads.beginRead());
  assert.equal(renders, 1);
  const token = reads.requestStop("A");
  reads.observe(
    Array.from({ length: 1500 }, (_, i) => task("task-" + i, "completed")),
    reads.beginRead(),
  );
  assert.equal(reads.tasks.size, 1024);
  assert.equal(reads.state(current), "stopping");
  reads.rejectStop("A", token);
  unsubscribe();
});
