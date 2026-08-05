// Codex CLI auto-update S1 — startup reconcile, orphan adoption, and the mutex.
//
// `codex update` is spawned detached so it can outlive Sonata (killing a package
// manager mid-write can corrupt a global install). The consequence is orphans: a
// restart can find an update still running, or one whose outcome nobody
// observed. F2 says the ONE attempt record is also the cross-restart lock.
//
// The claim under test is that adoption needs no code. Reconcile writes nothing;
// "a live orphan holds the mutex" and "a dead unreaped attempt is UNKNOWN" are
// re-derived from the record plus a pid probe on every read, so an adopted
// orphan becomes UNKNOWN the instant its pid stops answering.
//
// Real processes do this end-to-end in cli-updater-detached-spawn.mjs (G4).

import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const distRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../dist");
const { CliUpdater } = require(path.join(distRoot, "main/cli-updater/cli-updater"));
const { ATTEMPT_LIVENESS_WINDOW_MS } = require(path.join(distRoot, "main/cli-updater/policy"));

const results = {};
const NOW = Date.parse("2026-08-05T12:00:00.000Z");
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

// COMPOSED — the record a previous run left behind.
const orphan = (overrides = {}) => ({
  forVersion: "0.147.0",
  startedAt: iso(-5_000),
  pid: 4242,
  exitCode: null,
  logFile: "/tmp/codex-update.log",
  ...overrides,
});

function fakeStore(lastAttempt, lastCheck = null) {
  let doc = { lastCheck, lastAttempt };
  const writes = [];
  return {
    read: () => doc,
    write: (next) => {
      writes.push(next);
      doc = next;
      return next;
    },
    writes,
  };
}

/** A CliUpdater with every effect stubbed — no network, no child processes. */
function updater({ store, alive = false, now = () => NOW, logs = [], ...rest }) {
  return new CliUpdater({
    livePtyCount: () => 0,
    isEnabled: () => true,
    store,
    check: async () => ({ at: iso(0), ok: false, installed: null, latest: null }),
    execute: () => null,
    isPidAlive: () => (typeof alive === "function" ? alive() : alive),
    now,
    log: (message) => logs.push(message),
    ...rest,
  });
}

// 1) A live orphan is adopted as RUNNING — and the adoption is written NOWHERE.
{
  const store = fakeStore(orphan());
  const logs = [];
  const cli = updater({ store, alive: true, logs });

  assert.equal(cli.reconcile(), "running", "live pid within the window → RUNNING");
  assert.deepEqual(store.writes, [], "reconcile persists nothing — adoption is derived");
  assert.ok(
    logs.some((line) => line.includes("adopted a running codex update") && line.includes("4242")),
    "the adoption is announced",
  );
  results.liveOrphan = "running (0 writes)";
}

// 2) …and it becomes UNKNOWN the moment the pid stops answering. No transition
//    fires, no cleanup runs: the same read simply classifies differently.
{
  let alive = true;
  const store = fakeStore(orphan());
  const cli = updater({ store, alive: () => alive });

  assert.equal(cli.attemptState(), "running", "held while the orphan lives");
  alive = false; // the orphan exits
  assert.equal(cli.attemptState(), "unknown", "released the instant the pid is gone");
  assert.deepEqual(store.writes, [], "still nothing persisted");
  results.pollToDeath = "running → unknown";
}

// 3) A dead pid on an unreaped record is UNKNOWN, not a failure. The app died
//    mid-update; that says nothing about whether codex can be updated.
{
  const store = fakeStore(orphan());
  const logs = [];
  const cli = updater({ store, alive: false, logs });
  assert.equal(cli.reconcile(), "unknown", "dead pid → UNKNOWN");
  assert.ok(
    logs.some((line) => line.includes("left no outcome")),
    "reported as an unknown outcome, never as a failure",
  );
  results.deadOrphan = "unknown";
}

// 4) The pid-reuse sanity window. A week-old record naming pid 4242 must not let
//    some unrelated process hold the update mutex forever.
{
  const cases = [
    ["fresh record, live pid", iso(-1_000), "running"],
    ["just inside the window", iso(-ATTEMPT_LIVENESS_WINDOW_MS + 1_000), "running"],
    ["just outside the window", iso(-ATTEMPT_LIVENESS_WINDOW_MS - 1_000), "unknown"],
    ["a week old (pid certainly recycled)", iso(-7 * 24 * 60 * 60 * 1000), "unknown"],
    ["started in the future (clock skew)", iso(60_000), "unknown"],
  ];
  for (const [label, startedAt, expected] of cases) {
    const cli = updater({ store: fakeStore(orphan({ startedAt })), alive: true });
    assert.equal(cli.attemptState(), expected, `sanity window: ${label}`);
  }
  results.sanityWindow = cases.length;
}

// 5) A reaped record never consults the pid at all — an exit code is the truth
//    even if the pid has since been recycled onto a live process.
{
  let probes = 0;
  const cli = updater({
    store: fakeStore(orphan({ exitCode: 0 })),
    alive: () => {
      probes += 1;
      return true;
    },
  });
  assert.equal(cli.attemptState(), "completed", "exit 0 → completed");
  assert.equal(probes, 0, "no liveness syscall spent on a reaped record");

  const failed = updater({ store: fakeStore(orphan({ exitCode: 1 })), alive: true });
  assert.equal(failed.attemptState(), "hard-failed", "non-zero exit → hard-failed");

  const none = updater({ store: fakeStore(null), alive: true });
  assert.equal(none.reconcile(), "none", "no record → none");
  results.reapedRecords = "ok";
}

// 6) `whenIdle` — the mutex a codex spawn takes (D5). Bounded, with
//    fall-through: an unbounded await would let one hung `brew upgrade` block
//    every codex session the user tries to start.
{
  // Nothing running → resolves immediately, without waiting a poll interval.
  const idle = updater({ store: fakeStore(null), alive: false, now: () => Date.now() });
  const startedAt = Date.now();
  assert.equal(await idle.whenIdle(5_000), "idle", "no attempt → idle at once");
  assert.ok(Date.now() - startedAt < 200, "and it did not sleep");

  // Running and staying running → the bound expires and the caller proceeds.
  const stuck = updater({
    store: fakeStore(orphan({ startedAt: new Date().toISOString() })),
    alive: true,
    now: () => Date.now(),
    pollIntervalMs: 10,
  });
  const before = Date.now();
  assert.equal(await stuck.whenIdle(120), "timeout", "a wedged update times out");
  const waited = Date.now() - before;
  assert.ok(waited >= 100, `waited for the bound (${waited}ms)`);
  assert.ok(waited < 3_000, `but only the bound (${waited}ms)`);

  // Running, then the update finishes → resolves idle as soon as the pid dies.
  let alive = true;
  const finishing = updater({
    store: fakeStore(orphan({ startedAt: new Date().toISOString() })),
    alive: () => alive,
    now: () => Date.now(),
    pollIntervalMs: 10,
  });
  setTimeout(() => {
    alive = false;
  }, 50);
  const waitStart = Date.now();
  assert.equal(await finishing.whenIdle(5_000), "idle", "resolves when the update exits");
  assert.ok(Date.now() - waitStart < 3_000, "without waiting out the full bound");
  results.whenIdle = "immediate / timeout / released";
}

console.log(JSON.stringify({ success: true, results }, null, 2));
process.exitCode = 0;
