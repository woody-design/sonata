import assert from "node:assert/strict";

const {
  READING_BOTTOM_THRESHOLD_PX,
  READING_OVERFLOW_TOLERANCE_PX,
  isReadingNearBottom,
  readingDistanceFromBottom,
  readingHasOverflow,
  createReadingBottomIntentStore,
  resolveReadingFinalizeScrollTop,
  stepReadingBottomIntent,
} = await import("../../dist/reading-core/reading-scroll.js");

const atDistance = (distance, { scrollHeight = 500, clientHeight = 200 } = {}) => ({
  scrollHeight,
  clientHeight,
  scrollTop: scrollHeight - clientHeight - distance,
});

assert.equal(READING_BOTTOM_THRESHOLD_PX, 64);
assert.equal(READING_OVERFLOW_TOLERANCE_PX, 1);

assert.equal(readingDistanceFromBottom(atDistance(63)), 63);
assert.equal(readingDistanceFromBottom(atDistance(64)), 64);
assert.equal(readingDistanceFromBottom(atDistance(63.75)), 63.75);
assert.equal(readingDistanceFromBottom(atDistance(-12)), 0, "overscroll clamps to zero");

assert.equal(isReadingNearBottom(atDistance(63)), true, "63px is near bottom");
assert.equal(isReadingNearBottom(atDistance(64)), true, "64px boundary is near bottom");
assert.equal(isReadingNearBottom(atDistance(64.001)), false, "fraction beyond boundary is away");
assert.equal(isReadingNearBottom(atDistance(63.999)), true, "fraction inside boundary is near");
assert.equal(isReadingNearBottom(atDistance(0)), true);

assert.equal(readingHasOverflow({ scrollHeight: 200, clientHeight: 200, scrollTop: 0 }), false);
assert.equal(readingHasOverflow({ scrollHeight: 201, clientHeight: 200, scrollTop: 0 }), false);
assert.equal(
  readingHasOverflow({ scrollHeight: 201.001, clientHeight: 200, scrollTop: 0 }),
  true,
);
assert.equal(readingHasOverflow(atDistance(64)), true);

// ——— Bottom intent store ——————————————————————————————————————————————————
{
  const store = createReadingBottomIntentStore();
  assert.equal(store.current(), null, "store starts with no intent");
  store.activate(1000);
  assert.deepEqual(store.current(), { aimedHeight: 1000 }, "activate records the aim");
  store.reaim(1400);
  assert.deepEqual(store.current(), { aimedHeight: 1400 }, "reaim updates a live aim");
  store.clear();
  assert.equal(store.current(), null, "clear drops the intent");
  store.reaim(2000);
  assert.equal(store.current(), null, "reaim never resurrects a cleared intent");
}

// ——— finalize scrollTop resolution ————————————————————————————————————————
// A live intent suppresses every finalize write — the animation owns scrollTop.
assert.equal(
  resolveReadingFinalizeScrollTop({
    nearBottom: false,
    previousScrollTop: 40,
    scrollTop: 300,
    scrollHeight: 5000,
    hasBottomIntent: true,
  }),
  null,
  "intent suppresses the mid-animation pin-back",
);
assert.equal(
  resolveReadingFinalizeScrollTop({
    nearBottom: true,
    previousScrollTop: 40,
    scrollTop: 300,
    scrollHeight: 5000,
    hasBottomIntent: true,
  }),
  null,
  "intent suppresses even a near-bottom pin",
);
// Without intent, tail-follow stands: pin to bottom near it, hold otherwise.
assert.equal(
  resolveReadingFinalizeScrollTop({
    nearBottom: true,
    previousScrollTop: 40,
    scrollTop: 300,
    scrollHeight: 5000,
    hasBottomIntent: false,
  }),
  5000,
  "near bottom pins to scrollHeight",
);
assert.equal(
  resolveReadingFinalizeScrollTop({
    nearBottom: false,
    previousScrollTop: 40,
    scrollTop: 300,
    scrollHeight: 5000,
    hasBottomIntent: false,
  }),
  40,
  "away from bottom restores the prior position",
);
// A same-value write still aborts a smooth scroll, so no-ops are skipped.
assert.equal(
  resolveReadingFinalizeScrollTop({
    nearBottom: false,
    previousScrollTop: 300,
    scrollTop: 300,
    scrollHeight: 5000,
    hasBottomIntent: false,
  }),
  null,
  "no-op restore write is skipped",
);
assert.equal(
  resolveReadingFinalizeScrollTop({
    nearBottom: true,
    previousScrollTop: 40,
    scrollTop: 4800,
    scrollHeight: 4800,
    hasBottomIntent: false,
  }),
  null,
  "no-op bottom pin is skipped",
);

// ——— Bottom intent stepping ———————————————————————————————————————————————
const metricsAt = (scrollTop, scrollHeight, clientHeight = 800) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});
// Near the bottom → arrival ends the intent (tail-follow takes over).
assert.deepEqual(
  stepReadingBottomIntent(metricsAt(4200, 5000), { aimedHeight: 5000 }),
  { kind: "arrived" },
  "reaching the threshold arrives",
);
// Content grew past the aim → re-aim at the new bottom.
assert.deepEqual(
  stepReadingBottomIntent(metricsAt(1000, 6000), { aimedHeight: 5000 }),
  { kind: "reaim", top: 6000 },
  "growth past the aim re-aims at the new height",
);
// Same target, still mid-flight → hold so the animation is never restarted.
assert.deepEqual(
  stepReadingBottomIntent(metricsAt(1000, 5000), { aimedHeight: 5000 }),
  { kind: "hold" },
  "an unchanged target holds",
);
// Arrival wins over growth when both could apply.
assert.deepEqual(
  stepReadingBottomIntent(metricsAt(5150, 6000), { aimedHeight: 5000 }),
  { kind: "arrived" },
  "arrival is checked before growth",
);

console.log(
  JSON.stringify({
    success: true,
    threshold: READING_BOTTOM_THRESHOLD_PX,
    overflowTolerance: READING_OVERFLOW_TOLERANCE_PX,
  }),
);
