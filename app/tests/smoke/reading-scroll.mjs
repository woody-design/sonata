import assert from "node:assert/strict";

const {
  READING_BOTTOM_THRESHOLD_PX,
  READING_OVERFLOW_TOLERANCE_PX,
  isReadingNearBottom,
  readingDistanceFromBottom,
  readingHasOverflow,
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

console.log(
  JSON.stringify({
    success: true,
    threshold: READING_BOTTOM_THRESHOLD_PX,
    overflowTolerance: READING_OVERFLOW_TOLERANCE_PX,
  }),
);
