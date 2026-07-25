import assert from "node:assert/strict";
import { createRequire } from "node:module";

// OBS S1 — the Projection primitive (D1): the one dirty-gated, time-bounded
// flush discipline every bounded persistence/notification path will flow through
// (S2 adopts it in run-index). Every case drives an INJECTED fake clock so the
// debounce cadence is deterministic — no wall-clock waits.
const require = createRequire(import.meta.url);
const { Projection } = require("../../dist/runtime/projection");

// ---------------------------------------------------------------------------
// A hand-driven clock: setTimeout/clearTimeout that fire only on advance().
// Handles are plain numbers with NO `unref` — this also exercises the
// unref-absent injected-timer path the primitive must tolerate.
// ---------------------------------------------------------------------------
function makeClock() {
  let now = 0;
  let seq = 0;
  const scheduled = new Map(); // id -> { at, fn }
  const timers = {
    setTimeout(fn, ms) {
      const id = ++seq;
      scheduled.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      scheduled.delete(id);
    },
  };
  // Fire due callbacks in chronological order up to now+ms. Re-armed timers that
  // fall inside the same window (e.g. a flush that re-marks) fire too.
  function advance(ms) {
    const target = now + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of scheduled) {
        if (t.at <= target && (next === null || t.at < next.at || (t.at === next.at && id < next.id))) {
          next = { id, at: t.at, fn: t.fn };
        }
      }
      if (!next) break;
      scheduled.delete(next.id);
      now = next.at;
      next.fn();
    }
    now = target;
  }
  return { timers, advance, pending: () => scheduled.size };
}

// ---------------------------------------------------------------------------
// 1) Storm fence — 10k marks, flush count is O(elapsed windows), not O(marks).
// ---------------------------------------------------------------------------
{
  const clock = makeClock();
  let flushes = 0;
  const p = new Projection({
    name: "storm",
    flush: () => { flushes += 1; },
    trailingMs: 100,
    timers: clock.timers,
  });

  for (let i = 0; i < 10_000; i += 1) {
    p.markDirty(); // all in the SAME window — no time advances
  }
  assert.equal(flushes, 0, "no flush before the window elapses");
  assert.equal(clock.pending(), 1, "one armed timer, not 10k");

  clock.advance(100); // window elapses once
  assert.equal(flushes, 1, "10k marks collapsed to a single flush");
  assert.equal(clock.pending(), 0, "timer disarmed after firing");
  console.log("  [1] storm fence: 10k marks -> 1 flush (O(windows)): OK");
}

// ---------------------------------------------------------------------------
// 2) Trailing-fixed non-starvation — continuous marks still flush every window.
// ---------------------------------------------------------------------------
{
  const clock = makeClock();
  let flushes = 0;
  const p = new Projection({
    name: "steady",
    flush: () => { flushes += 1; },
    trailingMs: 100,
    timers: clock.timers,
  });

  // Mark densely for 2000ms of virtual time (2ms/step). A sliding debounce would
  // push the deadline forever and NEVER flush; trailing-fixed flushes ~every 100ms.
  for (let i = 0; i < 1000; i += 1) {
    p.markDirty();
    clock.advance(2);
  }
  assert.ok(flushes > 1, `continuous marking is not starved (flushes=${flushes})`);
  assert.ok(
    flushes >= 17 && flushes <= 21,
    `flush count tracks elapsed windows ~2000/100, not marks (flushes=${flushes})`,
  );
  console.log(`  [2] trailing-fixed non-starvation: ${flushes} flushes over 20 windows: OK`);
}

// ---------------------------------------------------------------------------
// 3) markCritical flushes immediately and cancels the armed timer (no double flush).
// ---------------------------------------------------------------------------
{
  const clock = makeClock();
  let flushes = 0;
  const p = new Projection({
    name: "critical",
    flush: () => { flushes += 1; },
    trailingMs: 100,
    timers: clock.timers,
  });

  p.markDirty();               // arms a trailing timer
  assert.equal(clock.pending(), 1, "timer armed by markDirty");
  p.markCritical();            // immediate flush, cancels the armed timer
  assert.equal(flushes, 1, "critical flushed synchronously");
  assert.equal(clock.pending(), 0, "armed timer cancelled by critical");

  clock.advance(1000);         // the cancelled timer must not re-fire
  assert.equal(flushes, 1, "no double flush from the cancelled timer");
  console.log("  [3] markCritical: immediate flush, cancels timer, no double flush: OK");
}

// ---------------------------------------------------------------------------
// 4) seal flushes a dirty projection exactly once, then permanently inert.
// ---------------------------------------------------------------------------
{
  const clock = makeClock();
  let flushes = 0;
  const p = new Projection({
    name: "seal-dirty",
    flush: () => { flushes += 1; },
    trailingMs: 100,
    timers: clock.timers,
  });

  p.markDirty();
  p.seal();
  assert.equal(flushes, 1, "seal flushed the dirty projection once");
  assert.equal(clock.pending(), 0, "seal cleared the armed timer");

  // Post-seal everything is inert.
  p.markDirty();
  p.markCritical();
  p.flushNow();
  clock.advance(1000);
  assert.equal(flushes, 1, "post-seal marks/flushNow/timer-fire all no-op");

  p.seal(); // idempotent
  assert.equal(flushes, 1, "second seal is a no-op");
  console.log("  [4] seal: flush-once then permanently inert (idempotent): OK");
}

// ---------------------------------------------------------------------------
// 5) seal on a clean projection does not flush.
// ---------------------------------------------------------------------------
{
  let flushes = 0;
  const p = new Projection({
    name: "seal-clean",
    flush: () => { flushes += 1; },
    trailingMs: 100,
    timers: makeClock().timers,
  });
  p.seal();
  assert.equal(flushes, 0, "sealing a clean projection flushes nothing");
  console.log("  [5] seal on clean projection: no flush: OK");
}

// ---------------------------------------------------------------------------
// 6) Throwing flush — state stays coherent; error propagates for caller-driven
//    flush, routes to onError for the timer-driven flush.
// ---------------------------------------------------------------------------
{
  const clock = makeClock();
  let flushes = 0;
  let shouldThrow = false;
  const errors = [];
  const p = new Projection({
    name: "throwing",
    flush: () => {
      flushes += 1;
      if (shouldThrow) throw new Error("flush boom");
    },
    trailingMs: 100,
    timers: clock.timers,
    onError: (err) => errors.push(err),
  });

  // Caller-driven throw (markCritical) PROPAGATES.
  shouldThrow = true;
  p.markDirty();
  assert.throws(() => p.markCritical(), /flush boom/, "critical flush throw propagates to caller");
  assert.equal(flushes, 1, "flush ran once");
  assert.equal(errors.length, 0, "onError not used for caller-driven flush");

  // State stays coherent: dirty was cleared before the throw, timer disarmed.
  // A fresh mark still arms and flushes normally once the closure stops throwing.
  shouldThrow = false;
  p.markDirty();
  clock.advance(100);
  assert.equal(flushes, 2, "projection not wedged by the earlier throw");

  // Timer-driven throw is caught into onError, never an unhandled crash.
  shouldThrow = true;
  p.markDirty();
  clock.advance(100); // timer fires -> flush throws -> onError
  assert.equal(flushes, 3, "timer-driven flush ran");
  assert.equal(errors.length, 1, "timer-driven throw routed to onError");
  assert.match(String(errors[0].message), /flush boom/, "the thrown error reached onError");
  console.log("  [6] throwing flush: coherent state, propagate vs onError: OK");
}

// ---------------------------------------------------------------------------
// 7) Reentrancy — markDirty() from inside flush re-arms (mark not lost, no recurse).
// ---------------------------------------------------------------------------
{
  const clock = makeClock();
  let flushes = 0;
  let remarkOnce = false;
  const p = new Projection({
    name: "reentrant",
    flush: () => {
      flushes += 1;
      if (remarkOnce) {
        remarkOnce = false;
        p.markDirty(); // dirty the same state from inside the flush
      }
    },
    trailingMs: 100,
    timers: clock.timers,
  });

  remarkOnce = true;
  p.markDirty();
  p.flushNow();                 // flush #1; its markDirty must re-arm, not recurse/lose
  assert.equal(flushes, 1, "flush ran once — the reentrant markDirty did not recurse");
  assert.equal(clock.pending(), 1, "the reentrant markDirty re-armed a fresh window");

  clock.advance(100);           // the re-armed window fires
  assert.equal(flushes, 2, "the reentrant mark was preserved and flushed next tick");
  assert.equal(clock.pending(), 0, "settled — no further work armed");
  console.log("  [7] reentrancy: markDirty inside flush re-arms, never lost/recursed: OK");
}

console.log("projection smoke: OK");
