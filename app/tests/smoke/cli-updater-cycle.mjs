// Codex CLI auto-update S1 — the single orchestration point and its schedule.
//
// Three triggers (60s post-launch, every 12h, last codex pty exit) call ONE
// `runCycle`. The design's claim is that triggers carry zero logic: every
// condition, including the zero-live-pty gate, is evaluated inside the cycle, so
// a trigger can only ever say "now may be a good time". This file holds that
// claim, plus the re-entrancy guard, the schedule, and `spawnDecision`.

import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const distRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../dist");
const { CliUpdater } = require(path.join(distRoot, "main/cli-updater/cli-updater"));
const { FIRST_CHECK_DELAY_MS, CHECK_INTERVAL_MS } = require(
  path.join(distRoot, "main/update-cadence"),
);

const results = {};
const AT = "2026-08-05T12:00:00.000Z";

// COMPOSED check facts. The versions echo the real 0.146.0 → 0.147.0 line.
const PENDING = { at: AT, ok: true, installed: "0.146.0", latest: "0.147.0" };
const FRESH = { at: AT, ok: true, installed: "0.147.0", latest: "0.147.0" };
const UNREACHABLE = { at: AT, ok: false, installed: "0.146.0", latest: null };

function fakeStore(initial = { lastCheck: null, lastAttempt: null }) {
  let doc = initial;
  return {
    read: () => doc,
    write: (next) => {
      doc = next;
      return next;
    },
    current: () => doc,
    set: (next) => {
      doc = next;
    },
  };
}

/** A CliUpdater whose effects are all recorded rather than performed. */
function harness({ check = PENDING, livePtys = 0, enabled = true, store = fakeStore(), ...rest } = {}) {
  const calls = { checks: 0, executes: [] };
  const cli = new CliUpdater({
    livePtyCount: () => (typeof livePtys === "function" ? livePtys() : livePtys),
    isEnabled: () => (typeof enabled === "function" ? enabled() : enabled),
    store,
    check: async () => {
      calls.checks += 1;
      return typeof check === "function" ? await check() : check;
    },
    execute: (forVersion) => {
      calls.executes.push(forVersion);
      const attempt = {
        forVersion,
        startedAt: new Date().toISOString(),
        pid: 9100 + calls.executes.length,
        exitCode: null,
        logFile: "/tmp/codex-update.log",
      };
      store.write({ ...store.read(), lastAttempt: attempt });
      return attempt;
    },
    isPidAlive: () => false,
    log: () => {},
    ...rest,
  });
  return { cli, calls, store };
}

// 1) One cycle: check → persist → policy → execute.
{
  const { cli, calls, store } = harness();
  await cli.runCycle("manual");
  assert.equal(calls.checks, 1, "checked once");
  assert.deepEqual(store.current().lastCheck, PENDING, "the check fact is persisted");
  assert.deepEqual(calls.executes, ["0.147.0"], "executed for the pending latest");
  assert.equal(store.current().lastAttempt.pid, 9101, "the attempt is recorded");
  results.happyPath = "checked, persisted, executed";
}

// 2) Nothing pending → the facts are still refreshed, but nothing is launched.
{
  const { cli, calls, store } = harness({ check: FRESH });
  await cli.runCycle("interval");
  assert.deepEqual(store.current().lastCheck, FRESH, "facts refresh regardless");
  assert.deepEqual(calls.executes, [], "nothing to do");
  results.upToDate = "no execute";
}

// 3) The zero-live-pty gate lives in the cycle, not in the trigger. Codex
//    re-execs itself through arg0 symlinks to current_exe(), so swapping the
//    binary under a live session dangles them or silently mixes versions (G1).
{
  let ptys = 1;
  const { cli, calls } = harness({ livePtys: () => ptys });
  await cli.runCycle("pty-exit");
  assert.deepEqual(calls.executes, [], "a live codex session blocks the update");
  ptys = 0;
  await cli.runCycle("pty-exit");
  assert.deepEqual(calls.executes, ["0.147.0"], "the same trigger updates once the last one exits");
  results.ptyGate = "evaluated inside the cycle";
}

// 3b) O1 through the facade: session churn opens ONE attempt per version, the
//     scheduled ticks keep retrying. Without this, brew-cask lag (exit 0, the
//     version never moves — G3) plus a user who opens and closes sessions all
//     afternoon would mean a package-manager run per close.
{
  const { cli, calls, store } = harness();
  await cli.runCycle("pty-exit");
  assert.deepEqual(calls.executes, ["0.147.0"], "the first close launches the attempt");
  assert.equal(store.current().lastAttempt.forVersion, "0.147.0", "recorded against this latest");

  // Simulate the brew-lag outcome: exit 0, version unchanged, still pending.
  store.set({
    ...store.current(),
    lastAttempt: { ...store.current().lastAttempt, exitCode: 0 },
  });
  for (let close = 0; close < 5; close += 1) {
    await cli.runCycle("pty-exit");
  }
  assert.deepEqual(calls.executes, ["0.147.0"], "five more closes launch nothing");
  assert.equal(calls.checks, 6, "…though every cycle still refreshed the facts");

  // The scheduled ticks are a different kind of trigger and DO retry.
  await cli.runCycle("interval");
  assert.deepEqual(calls.executes, ["0.147.0", "0.147.0"], "the 12h tick retries");
  results.o1ChurnGate = `${calls.executes.length} runs across 6 closes + 1 tick`;
}

// 3c) …and a NEW release reopens the churn trigger, with no reclaim code — the
//     recorded forVersion simply stops matching latest.
{
  const store = fakeStore({
    lastCheck: PENDING,
    lastAttempt: {
      forVersion: "0.147.0",
      startedAt: new Date().toISOString(),
      pid: 4242,
      exitCode: 0,
      logFile: "/tmp/codex-update.log",
    },
  });
  const NEWER = { at: AT, ok: true, installed: "0.146.0", latest: "0.148.0" };
  let check = PENDING;
  const { cli, calls } = harness({ store, check: () => check });

  await cli.runCycle("pty-exit");
  assert.deepEqual(calls.executes, [], "already tried 0.147.0; churn stays quiet");
  check = NEWER;
  await cli.runCycle("pty-exit");
  assert.deepEqual(calls.executes, ["0.148.0"], "0.148.0 ships → churn may try again");
  results.o1NewVersion = "reopened by the version, not by a timer";
}

// 4) Trigger-agnostic: identical facts, identical outcome, whatever the reason.
//    (Scoped to the frequency-bounded triggers — pty-exit is a different KIND
//    of trigger by design, which is exactly what 3b/3c pin.)
{
  const outcomes = [];
  for (const reason of ["first-check", "interval", "manual"]) {
    const { cli, calls, store } = harness();
    await cli.runCycle(reason);
    outcomes.push({ reason, checks: calls.checks, executes: calls.executes, lastCheck: store.current().lastCheck });
  }
  const [first, ...rest] = outcomes;
  for (const outcome of rest) {
    assert.equal(outcome.checks, first.checks, `${outcome.reason}: same check count`);
    assert.deepEqual(outcome.executes, first.executes, `${outcome.reason}: same execution`);
    assert.deepEqual(outcome.lastCheck, first.lastCheck, `${outcome.reason}: same persisted facts`);
  }
  results.triggerAgnostic = outcomes.map((o) => o.reason);
}

// 5) Re-entrancy: concurrent callers JOIN the in-flight cycle rather than
//    starting a second one — and rather than being dropped, so `await
//    runCycle(...)` always means "a cycle has completed".
{
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { cli, calls } = harness({
    check: async () => {
      await gate;
      return PENDING;
    },
  });

  const a = cli.runCycle("first-check");
  const b = cli.runCycle("pty-exit");
  const c = cli.runCycle("interval");
  assert.equal(a, b, "a concurrent caller receives the in-flight promise");
  assert.equal(b, c, "…and so does a third");
  release();
  await Promise.all([a, b, c]);
  assert.equal(calls.checks, 1, "three triggers, one check");
  assert.deepEqual(calls.executes, ["0.147.0"], "and one execution");

  // The guard releases: a later cycle runs normally.
  await cli.runCycle("interval");
  assert.equal(calls.checks, 2, "the guard is not sticky");
  results.reentrancy = "3 concurrent triggers → 1 cycle";
}

// 6) A failing check never rejects and never poisons the guard. A cycle is
//    background maintenance; the next trigger tries again.
{
  let mode = "throw";
  const { cli, calls, store } = harness({
    check: async () => {
      if (mode === "throw") {
        throw new Error("registry unreachable");
      }
      return PENDING;
    },
  });
  await cli.runCycle("interval"); // must not reject
  assert.equal(store.current().lastCheck, null, "no fact is fabricated from a failure");
  assert.deepEqual(calls.executes, [], "and nothing is launched");
  mode = "ok";
  await cli.runCycle("interval");
  assert.deepEqual(calls.executes, ["0.147.0"], "the next cycle recovers");
  results.checkFailure = "logged, not thrown";
}

// 7) An unreachable registry produces a clean `ok: false` fact and no action.
{
  const { cli, calls, store } = harness({ check: UNREACHABLE });
  await cli.runCycle("interval");
  assert.equal(store.current().lastCheck.ok, false, "the fact records that nothing is known");
  assert.deepEqual(calls.executes, [], "an unknown latest is never pending");
  results.unreachable = "no execute";
}

// 8) The setting takes Sonata out of the codex-update business entirely — no
//    execution, no ownership, and no background effects either. A user who
//    turned this off should not have Sonata running `codex --version` and
//    querying npm on their behalf every twelve hours.
{
  let enabled = false;
  const { cli, calls, store } = harness({ enabled: () => enabled });
  await cli.runCycle("interval");
  assert.deepEqual(calls.executes, [], "setting off → never launches an update");
  assert.equal(calls.checks, 0, "setting off → no check is performed at all");
  assert.equal(store.current().lastCheck, null, "…so no facts are gathered");
  assert.equal(cli.spawnDecision().suppressNativePrompt, false, "…and codex keeps its own prompt");

  // Re-enabling needs no restart: the accessor is read on every evaluation.
  enabled = true;
  await cli.runCycle("interval");
  assert.equal(calls.checks, 1, "re-enabling resumes checking on the next cycle");
  assert.deepEqual(calls.executes, ["0.147.0"], "and catches up immediately");
  results.settingOff = "no effects at all";
}

// 9) The cycle re-reads the store after awaiting the check — the detached
//    child's exit listener writes behind the controller's back, and a pre-check
//    snapshot would silently discard that patch.
{
  const store = fakeStore();
  const attempt = {
    forVersion: "0.147.0",
    startedAt: new Date().toISOString(),
    pid: 4242,
    exitCode: null,
    logFile: "/tmp/codex-update.log",
  };
  store.set({ lastCheck: null, lastAttempt: attempt });
  // A live codex session, so the cycle persists but launches nothing — isolating
  // the write from the silent retry that would otherwise replace the record.
  const { cli, calls } = harness({
    store,
    livePtys: 1,
    check: async () => {
      // The exit listener lands mid-cycle.
      store.set({ ...store.read(), lastAttempt: { ...attempt, exitCode: 1 } });
      return PENDING;
    },
  });
  await cli.runCycle("interval");
  assert.deepEqual(calls.executes, [], "a live pty means nothing is launched this cycle");
  assert.equal(store.current().lastAttempt.exitCode, 1, "the mid-cycle exit patch survives");
  assert.deepEqual(store.current().lastCheck, PENDING, "and the new check fact is written");
  results.midCycleWrite = "preserved";
}

// 9b) …and the very next idle cycle retries anyway. A hard failure does NOT
//     stop execution — retrying silently is exactly how Sonata re-earns the
//     prompt it just handed back.
{
  const store = fakeStore({
    lastCheck: PENDING,
    lastAttempt: {
      forVersion: "0.147.0",
      startedAt: new Date().toISOString(),
      pid: 4242,
      exitCode: 1,
      logFile: "/tmp/codex-update.log",
    },
  });
  const { cli, calls } = harness({ store });
  assert.equal(cli.spawnDecision().suppressNativePrompt, false, "handed back before the cycle");
  await cli.runCycle("interval");
  assert.deepEqual(calls.executes, ["0.147.0"], "hard failure retries silently");
  assert.equal(cli.attemptState(), "unknown", "the fresh attempt supersedes the failure");
  assert.equal(
    cli.spawnDecision().suppressNativePrompt,
    true,
    "and ownership returns the moment the failure is no longer the record",
  );
  results.silentRetry = "hard-failed → retried → owned";
}

// 10) `spawnDecision` — the only thing the spawn path asks for. Derived on every
//     call, so a hard failure recorded seconds ago is visible immediately rather
//     than at the next cycle.
{
  const store = fakeStore();
  const { cli } = harness({ store });
  assert.equal(cli.spawnDecision().suppressNativePrompt, true, "nothing known → Sonata owns");

  store.set({ lastCheck: PENDING, lastAttempt: null });
  assert.equal(cli.spawnDecision().suppressNativePrompt, true, "pending → Sonata still owns");

  store.set({
    lastCheck: PENDING,
    lastAttempt: {
      forVersion: "0.147.0",
      startedAt: new Date().toISOString(),
      pid: 4242,
      exitCode: 1,
      logFile: "/tmp/codex-update.log",
    },
  });
  assert.equal(
    cli.spawnDecision().suppressNativePrompt,
    false,
    "hard failure against the pending latest → hand the prompt back to codex",
  );

  store.set({ lastCheck: FRESH, lastAttempt: store.current().lastAttempt });
  assert.equal(
    cli.spawnDecision().suppressNativePrompt,
    true,
    "the user updated by hand → reclaimed, with no reclaim code",
  );
  results.spawnDecision = "derived per call";
}

// 11) `spawnDecision` sits on the codex spawn path, so it must not be able to
//     take a session down. A broken store degrades to codex's own prompt — the
//     behaviour that existed before this controller did.
{
  const { cli } = harness({
    store: {
      read: () => {
        throw new Error("disk on fire");
      },
      write: (next) => next,
    },
  });
  assert.equal(
    cli.spawnDecision().suppressNativePrompt,
    false,
    "a throwing store degrades to codex's native prompt",
  );
  results.spawnDecisionSafety = "degrades, never throws";
}

// 12) The schedule: first check, then the interval, on this controller's own
//     timers (the app updater is packaged-gated and inert in dev; CLI updates
//     must run in dev too — D1).
{
  const { cli, calls } = harness({ cadence: { firstCheckDelayMs: 20, checkIntervalMs: 25 } });
  cli.start();
  cli.start(); // idempotent
  await new Promise((resolve) => setTimeout(resolve, 130));
  cli.dispose();
  const afterDispose = calls.checks;
  assert.ok(afterDispose >= 3, `first check plus intervals ran (${afterDispose})`);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls.checks, afterDispose, "dispose stops the schedule");
  assert.equal(await cli.runCycle("manual"), undefined, "a disposed controller runs no cycle");
  assert.equal(calls.checks, afterDispose, "…and really does not check");
  results.schedule = `${afterDispose} cycles, then stopped`;
}

// 13) Both schedule timers are unref'd — a pending update check must never be
//     the reason a process stays alive.
{
  const captured = [];
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  globalThis.setTimeout = (...args) => {
    const timer = realSetTimeout(...args);
    captured.push(timer);
    return timer;
  };
  globalThis.setInterval = (...args) => {
    const timer = realSetInterval(...args);
    captured.push(timer);
    return timer;
  };
  let cli;
  try {
    ({ cli } = harness());
    cli.start();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.setInterval = realSetInterval;
  }
  assert.equal(captured.length, 2, "one timeout + one interval");
  for (const timer of captured) {
    assert.equal(timer.hasRef(), false, "schedule timer is unref'd");
  }
  cli.dispose();
  results.unrefdTimers = captured.length;
}

// 14) The cadence itself is shared with the app updater so the two can never
//     drift apart (D1).
{
  assert.equal(FIRST_CHECK_DELAY_MS, 60_000, "first check 60s after start");
  assert.equal(CHECK_INTERVAL_MS, 12 * 60 * 60 * 1000, "then every 12h");
  const updaterSource = require("node:fs").readFileSync(
    path.join(distRoot, "main/updater/updater-controller.js"),
    "utf8",
  );
  assert.match(
    updaterSource,
    /require\("\.\.\/update-cadence"\)/,
    "the app updater imports the shared cadence rather than redeclaring it",
  );
  results.sharedCadence = { FIRST_CHECK_DELAY_MS, CHECK_INTERVAL_MS };
}

console.log(JSON.stringify({ success: true, results }, null, 2));
process.exitCode = 0;
