import assert from "node:assert/strict";

const {
  READING_BOTTOM_THRESHOLD_PX,
  READING_OVERFLOW_TOLERANCE_PX,
  isReadingNearBottom,
  readingDistanceFromBottom,
  readingHasOverflow,
  createReadingBottomIntentStore,
  createReadingScrollMemoryStore,
  readingBottomIntentTakenOver,
  planTaskSwitchScroll,
  planReadingFinalizeScroll,
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
  store.activate(1000, 200);
  assert.deepEqual(store.current(), { aimedHeight: 1000, ridePeak: 200 }, "activate records aim + start peak");
  store.advance(650);
  assert.deepEqual(store.current(), { aimedHeight: 1000, ridePeak: 650 }, "advance extends the ride peak");
  store.advance(400);
  assert.deepEqual(store.current(), { aimedHeight: 1000, ridePeak: 650 }, "advance never lowers the peak");
  store.reaim(1400);
  assert.deepEqual(store.current(), { aimedHeight: 1400, ridePeak: 650 }, "reaim updates the aim, keeps the peak");
  store.clear();
  assert.equal(store.current(), null, "clear drops the intent");
  store.reaim(2000);
  assert.equal(store.current(), null, "reaim never resurrects a cleared intent");
  store.advance(3000);
  assert.equal(store.current(), null, "advance never resurrects a cleared intent");
}

// ——— Takeover detection ————————————————————————————————————————————————————
// A retreat past the ride's furthest point (beyond the margin) is the reader
// steering via a scroll that emits no wheel/touch event.
assert.equal(
  readingBottomIntentTakenOver(300, { aimedHeight: 5000, ridePeak: 1200 }),
  true,
  "a large retreat from the ride peak is takeover",
);
assert.equal(
  readingBottomIntentTakenOver(1160, { aimedHeight: 5000, ridePeak: 1200 }),
  false,
  "a sub-margin dip (jitter) is not takeover",
);
assert.equal(
  readingBottomIntentTakenOver(1400, { aimedHeight: 5000, ridePeak: 1200 }),
  false,
  "advancing past the peak is never takeover",
);
assert.equal(
  readingBottomIntentTakenOver(1200 - 64, { aimedHeight: 5000, ridePeak: 1200 }),
  false,
  "exactly the margin boundary is not takeover",
);
assert.equal(
  readingBottomIntentTakenOver(1200 - 64 - 0.5, { aimedHeight: 5000, ridePeak: 1200 }),
  true,
  "just past the margin boundary is takeover",
);

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

// ——— Per-session scroll memory (S3 D3) ————————————————————————————————————
{
  const memory = createReadingScrollMemoryStore();
  assert.equal(memory.take("a"), null, "an unvisited session has no remembered place");
  memory.remember("a", { scrollTop: 820, nearBottom: false });
  memory.remember("b", { scrollTop: 40, nearBottom: true });
  assert.deepEqual(memory.take("a"), { scrollTop: 820, nearBottom: false });
  assert.equal(memory.take("a"), null, "a snapshot answers exactly one return");
  assert.deepEqual(memory.take("b"), { scrollTop: 40, nearBottom: true }, "sessions are independent");
  memory.remember("c", { scrollTop: 10, nearBottom: false });
  memory.forget("c");
  assert.equal(memory.take("c"), null, "a closed session's place is dropped");
  assert.equal(memory.take(null), null, "no task, nothing to restore");
}

// nearBottom wins over the raw offset: the reader left at the live edge, and
// the live edge has moved on.
assert.equal(
  planTaskSwitchScroll(
    { scrollTop: 400, nearBottom: true },
    { scrollHeight: 9000, clientHeight: 800 },
  ),
  9000,
  "a session left at the bottom returns to the NEW bottom",
);
assert.equal(
  planTaskSwitchScroll(
    { scrollTop: 400, nearBottom: false },
    { scrollHeight: 9000, clientHeight: 800 },
  ),
  400,
  "a session left mid-history returns to that offset",
);
assert.equal(
  planTaskSwitchScroll(null, { scrollHeight: 9000, clientHeight: 800 }),
  9000,
  "no snapshot opens at the bottom",
);
assert.equal(
  planTaskSwitchScroll(
    { scrollTop: 8000, nearBottom: false },
    { scrollHeight: 3000, clientHeight: 800 },
  ),
  2200,
  "a remembered offset is clamped into the incoming transcript's range",
);
assert.equal(
  planTaskSwitchScroll(
    { scrollTop: 120, nearBottom: false },
    { scrollHeight: 500, clientHeight: 800 },
  ),
  0,
  "a transcript shorter than the viewport clamps to the top, never negative",
);

// ——— The finalize decision: precedence ————————————————————————————————————
{
  const base = {
    taskSwitch: false,
    switchSnapshot: null,
    hasBottomIntent: false,
    nearBottom: false,
    previousScrollTop: 300,
    scrollTop: 300,
    scrollHeight: 9000,
    clientHeight: 800,
  };

  // 1. A task switch owns the position — over a live ride, over a new segment,
  //    and over the outgoing DOM's tail-follow inputs.
  assert.deepEqual(
    planReadingFinalizeScroll({
      ...base,
      taskSwitch: true,
      switchSnapshot: { scrollTop: 1500, nearBottom: false },
      hasBottomIntent: true,
      nearBottom: true,
    }),
    { kind: "top", top: 1500 },
    "a switch restores the incoming session's place, whatever else is in flight",
  );
  assert.deepEqual(
    planReadingFinalizeScroll({ ...base, taskSwitch: true, switchSnapshot: null }),
    { kind: "top", top: 9000 },
    "a switch with nothing remembered opens at the bottom",
  );
  assert.deepEqual(
    planReadingFinalizeScroll({
      ...base,
      taskSwitch: true,
      switchSnapshot: { scrollTop: 300, nearBottom: false },
    }),
    { kind: "none" },
    "a restore that changes nothing is not written (a write aborts a smooth scroll)",
  );

  // 2. A live ride owns scrollTop.
  assert.deepEqual(
    planReadingFinalizeScroll({ ...base, nearBottom: true, hasBottomIntent: true }),
    { kind: "none" },
    "a live scroll-to-bottom ride is never interrupted",
  );

  // 4. Tail-follow otherwise, unchanged.
  assert.deepEqual(
    planReadingFinalizeScroll({ ...base, nearBottom: true }),
    { kind: "top", top: 9000 },
    "no anchor pending: the near-bottom pin still stands",
  );
  assert.deepEqual(
    planReadingFinalizeScroll({ ...base, previousScrollTop: 300, scrollTop: 400 }),
    { kind: "top", top: 300 },
    "no anchor pending: a scrolled-away view still holds its place",
  );
  assert.deepEqual(
    planReadingFinalizeScroll({ ...base, previousScrollTop: 1960, scrollTop: 1960 }),
    { kind: "none" },
    "a held position is not rewritten",
  );
}

console.log(
  JSON.stringify({
    success: true,
    threshold: READING_BOTTOM_THRESHOLD_PX,
    overflowTolerance: READING_OVERFLOW_TOLERANCE_PX,
  }),
);
