import assert from "node:assert/strict";
import { ContinuousClock, FOUR_HOURS_MS } from "./p13-soak-journal.mjs";
const clock = new ContinuousClock(0, 1000);
for (let ms = 5000; ms <= FOUR_HOURS_MS; ms += 5000) clock.pulse(ms, ms + 1000);
assert(clock.passedFourHours);
const paused = new ContinuousClock(0, 1000);
assert.throws(() => paused.pulse(60000, 61000), /Unobserved pause/);
assert.equal(paused.activeMs, 0);
assert.equal(paused.passedFourHours, false);
const skewed = new ContinuousClock(0, 1000);
assert.throws(() => skewed.pulse(5000, 16000), /discontinuity/);
const restarted = new ContinuousClock(0, 1000);
assert.equal(restarted.activeMs, 0);
assert.equal(restarted.passedFourHours, false);
console.log(
  "Clock accounting checks passed; synthetic clock inputs only, NOT a four-hour product run.",
);
