import assert from "node:assert/strict";

const {
  READING_BOTTOM_THRESHOLD_PX,
  READING_OVERFLOW_TOLERANCE_PX,
  READING_ANCHOR_TOP_INSET_PX,
  READING_ANCHOR_HOLD_TOLERANCE_PX,
  isReadingNearBottom,
  readingDistanceFromBottom,
  readingHasOverflow,
  createReadingBottomIntentStore,
  createReadingScrollMemoryStore,
  readingBottomIntentTakenOver,
  readingReaderIsAttending,
  planTaskSwitchScroll,
  planReadingAnchorTarget,
  planReadingBlockAnchor,
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

// ——— Attending (S3 D4) ————————————————————————————————————————————————————
assert.equal(READING_ANCHOR_HOLD_TOLERANCE_PX, 4);
assert.equal(READING_ANCHOR_TOP_INSET_PX, 40);
assert.equal(
  readingReaderIsAttending({ scrollTop: 1200, nearBottom: false, lastAnchorTop: 1200 }),
  true,
  "sitting exactly where the last anchor put it is attending",
);
assert.equal(
  readingReaderIsAttending({ scrollTop: 1203.5, nearBottom: false, lastAnchorTop: 1200 }),
  true,
  "sub-pixel drift is not a reader",
);
assert.equal(
  readingReaderIsAttending({ scrollTop: 1160, nearBottom: false, lastAnchorTop: 1200 }),
  false,
  "a scroll away from the anchor ends attending — one wheel notch is enough",
);
assert.equal(
  readingReaderIsAttending({ scrollTop: 40, nearBottom: true, lastAnchorTop: 1200 }),
  true,
  "near the bottom is attending regardless of the anchor reference",
);
assert.equal(
  readingReaderIsAttending({ scrollTop: 900, nearBottom: false, lastAnchorTop: null }),
  false,
  "before any anchor, only the bottom counts as attending",
);

// ——— Which segment anchors ————————————————————————————————————————————————
{
  // The first reply into an empty session: nothing seen, so the one segment
  // there is anchors. (Entering a session with content never reaches here — the
  // view seeds the seen set on a task switch; fenced by the reading-session-
  // scroll-memory e2e.)
  assert.deepEqual(
    planReadingAnchorTarget(["a"], new Set()),
    { anchorKey: "a", seen: new Set(["a"]) },
    "the first segment of an empty session anchors",
  );
  assert.equal(planReadingAnchorTarget([], new Set()).anchorKey, null, "nothing to anchor");

  const seeded = { seen: new Set(["a", "b"]) };
  // The ordinary append.
  const appended = planReadingAnchorTarget(["a", "b", "c"], seeded.seen);
  assert.equal(appended.anchorKey, "c", "the segment after the last seen one anchors");
  assert.deepEqual([...appended.seen], ["a", "b", "c"]);

  // Nothing new.
  assert.equal(
    planReadingAnchorTarget(["a", "b", "c"], appended.seen).anchorKey,
    null,
    "growth inside a seen segment never re-anchors",
  );

  // A multi-segment turn re-anchors per segment, one render at a time.
  assert.equal(
    planReadingAnchorTarget(["a", "b", "c", "d"], appended.seen).anchorKey,
    "d",
    "each further segment of the same turn anchors in its own turn",
  );

  // Two at once: the FIRST new one is the read/unread boundary, and the second
  // is marked seen behind it rather than anchoring in a cascade.
  const burst = planReadingAnchorTarget(["a", "b", "c", "d", "e"], appended.seen);
  assert.equal(burst.anchorKey, "d", "a burst anchors at the boundary, not at its end");
  assert.deepEqual([...burst.seen], ["a", "b", "c", "d", "e"]);

  // A wholesale replacement (a re-located provider source replays the history
  // under fresh ids) re-seeds instead of anchoring the reader to the top of
  // their own history.
  const replaced = planReadingAnchorTarget(["x", "y", "z"], appended.seen);
  assert.equal(replaced.anchorKey, null, "a transcript that turned over entirely re-seeds");
  assert.deepEqual([...replaced.seen], ["x", "y", "z"]);

  // The seen set is exactly what is present — a removed segment cannot linger.
  assert.deepEqual([...planReadingAnchorTarget(["a"], appended.seen).seen], ["a"]);
  assert.deepEqual(
    [...planReadingAnchorTarget([], appended.seen).seen],
    [],
    "an emptied transcript leaves nothing seen",
  );
}

// ——— Where an anchored segment lands ——————————————————————————————————————
assert.deepEqual(
  planReadingBlockAnchor({ blockTop: 2000, scrollHeight: 9000, clientHeight: 800 }),
  { top: 1960, satisfied: true },
  "the segment's top edge lands at the reading line, one inset below the top edge",
);
assert.deepEqual(
  planReadingBlockAnchor({ blockTop: 10, scrollHeight: 9000, clientHeight: 800 }),
  { top: 0, satisfied: true },
  "the first segment of a transcript cannot scroll above the top",
);
// The ordinary birth of a reply: it appears at the bottom of a scroller with no
// room below it yet, so the anchor is CLAMPED, not achieved. `satisfied: false`
// is what keeps the same anchor alive until the reply grows enough to carry its
// own top edge up to the reading line.
assert.deepEqual(
  planReadingBlockAnchor({ blockTop: 8900, scrollHeight: 9000, clientHeight: 800 }),
  { top: 8200, satisfied: false },
  "a segment born at the live edge clamps to the bottom and stays unsatisfied",
);
assert.deepEqual(
  planReadingBlockAnchor({ blockTop: 8240, scrollHeight: 9000, clientHeight: 800 }),
  { top: 8200, satisfied: true },
  "the exact boundary counts as landed",
);

// ——— The finalize decision: precedence ————————————————————————————————————
{
  // `pendingAnchorKey` reaches the planner already gated on attending — the
  // caller retires it when readingReaderIsAttending says the reader moved (the
  // predicate is fenced above, and the composed behavior in
  // tests/e2e/reading-reply-anchor.mjs).
  const base = {
    taskSwitch: false,
    switchSnapshot: null,
    pendingAnchorKey: null,
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
      pendingAnchorKey: "new",
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

  // 2. An explicit ride beats an automatic anchor.
  assert.deepEqual(
    planReadingFinalizeScroll({
      ...base,
      pendingAnchorKey: "new",
      nearBottom: true,
      hasBottomIntent: true,
    }),
    { kind: "none" },
    "a live scroll-to-bottom ride is never interrupted by an anchor",
  );

  // 3. A segment awaiting its anchor gets it — from the live edge, or from
  //    wherever the previous anchor left the reader.
  assert.deepEqual(
    planReadingFinalizeScroll({ ...base, pendingAnchorKey: "new", nearBottom: true }),
    { kind: "anchor", blockKey: "new" },
    "a new segment anchors from the live edge",
  );
  assert.deepEqual(
    planReadingFinalizeScroll({
      ...base,
      pendingAnchorKey: "new",
      previousScrollTop: 1960,
      scrollTop: 1960,
    }),
    { kind: "anchor", blockKey: "new" },
    "a new segment anchors from where the last anchor left the reader",
  );
  // The anchor beats tail-follow inside the same render: a segment can arrive
  // while the view is still pinned to the bottom (that is the ordinary case),
  // and pinning first would leave the anchor fighting the pin every batch.
  assert.deepEqual(
    planReadingFinalizeScroll({ ...base, pendingAnchorKey: "new", nearBottom: true }).kind,
    "anchor",
    "a new segment outranks the near-bottom pin",
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
  // The anchored steady state: the reader sits at the reading line, no longer
  // near the bottom, so tail-follow has nothing to pin — it retires exactly
  // when the anchor lands, with no separate switch to throw.
  assert.deepEqual(
    planReadingFinalizeScroll({ ...base, previousScrollTop: 1960, scrollTop: 1960 }),
    { kind: "none" },
    "an anchored view is left alone while the reply grows below it",
  );
}

console.log(
  JSON.stringify({
    success: true,
    threshold: READING_BOTTOM_THRESHOLD_PX,
    overflowTolerance: READING_OVERFLOW_TOLERANCE_PX,
    anchorInset: READING_ANCHOR_TOP_INSET_PX,
    anchorHoldTolerance: READING_ANCHOR_HOLD_TOLERANCE_PX,
  }),
);
