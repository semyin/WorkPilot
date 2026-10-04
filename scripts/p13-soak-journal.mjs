import assert from "node:assert/strict";
import { appendFile, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

export const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
export class ContinuousClock {
  constructor(monotonic, wall, maxGapMs = 15000) {
    this.lastMonotonic = monotonic;
    this.lastWall = wall;
    this.activeMs = 0;
    this.maxGapMs = maxGapMs;
    this.valid = true;
  }
  pulse(monotonic, wall) {
    const delta = monotonic - this.lastMonotonic;
    const wallDelta = wall - this.lastWall;
    this.lastMonotonic = monotonic;
    this.lastWall = wall;
    if (delta < 0 || delta > this.maxGapMs || Math.abs(wallDelta - delta) > 5000) {
      this.valid = false;
      throw new Error(
        `Unobserved pause or clock discontinuity: monotonic=${delta} wall=${wallDelta}`,
      );
    }
    assert(this.valid, "An interrupted span cannot be counted as continuous");
    this.activeMs += delta;
    return this.activeMs;
  }
  get passedFourHours() {
    return this.valid && this.activeMs >= FOUR_HOURS_MS;
  }
}
export async function journal(directory, identity, resume = false) {
  const checkpoint = join(directory, "checkpoint.json");
  let state = { schema: 1, identity, segments: [], cycles: [], status: "new" };
  if (resume) {
    state = JSON.parse(await readFile(checkpoint, "utf8"));
    assert.deepEqual(
      state.identity,
      identity,
      "Resume requires the identical product binary hashes",
    );
    assert.notEqual(
      state.status,
      "running",
      "A running/orphaned test must be inspected before resume",
    );
  }
  const segment = {
    id: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    activeMs: 0,
    status: "running",
    events: 0,
    previousSegmentsDoNotCountTowardContinuousGate: true,
  };
  state.segments.push(segment);
  state.status = "running";
  let writes = Promise.resolve();
  const persist = () => {
    writes = writes.then(async () => {
      const temporary = checkpoint + ".pending";
      await writeFile(temporary, JSON.stringify(state, null, 2) + "\n");
      await rename(temporary, checkpoint);
    });
    return writes;
  };
  const record = async (kind, data) => {
    await appendFile(
      join(directory, "journal.jsonl"),
      JSON.stringify({
        at: new Date().toISOString(),
        segment: segment.id,
        kind,
        data,
      }) + "\n",
    );
    segment.events++;
  };
  await record("segment_started", { identity, resumed: resume });
  await persist();
  return {
    state,
    segment,
    persist,
    record,
    async heartbeat(clock, data) {
      segment.activeMs = Math.floor(clock.activeMs);
      segment.lastHeartbeat = { at: new Date().toISOString(), ...data };
      await record("heartbeat", { continuousMs: segment.activeMs, ...data });
      await persist();
    },
    async finish(status, details) {
      state.status = status;
      segment.status = status;
      segment.endedAt = new Date().toISOString();
      await record("segment_finished", { status, ...details });
      await persist();
    },
  };
}
