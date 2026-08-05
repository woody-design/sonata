// CLI readiness S1 — the controller: what it holds, when it re-probes, and when
// it stays quiet.
//
// Three properties are load-bearing and each is asserted as a COUNT, not a
// state, because "it eventually agrees" is not the claim:
//   • the changed event fires exactly ONCE per actual change (L6),
//   • a window focus costs exactly ZERO probes once nothing is actionable (D4),
//   • a `reprobe({bustPathCache})` never inherits a probe that resolved its PATH
//     before the bust (L7) — the stale-`absent`-after-install bug.
//
// Every effect is injected, so this drives the real controller with no
// subprocesses and no Electron.

import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const distRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../dist");

const { CliReadiness } = require(path.join(distRoot, "main/cli-readiness/cli-readiness"));
const { UNKNOWN_CLI_READINESS_FACTS } = require(
  path.join(distRoot, "shared/types/cli-readiness"),
);

const results = {};

const fact = (install, auth) => ({ install, auth });
const facts = (claude, codex) => ({ claude, codex });
const HEALTHY = facts(fact("present", "signedIn"), fact("present", "signedIn"));
const CLAUDE_ABSENT = facts(fact("absent", "unknown"), fact("present", "signedIn"));
const CLAUDE_SIGNED_OUT = facts(fact("present", "signedOut"), fact("present", "signedIn"));
const ALL_UNKNOWN = facts(fact("unknown", "unknown"), fact("unknown", "unknown"));

/** A controller over a scripted probe. `next` is what the following probe learns. */
function harness(initial) {
  const state = { next: initial, probes: 0, broadcasts: [], busts: 0, logs: [] };
  const readiness = new CliReadiness({
    broadcast: (value) => state.broadcasts.push(value),
    probe: async () => {
      state.probes += 1;
      return state.next;
    },
    bustPathCache: () => {
      state.busts += 1;
    },
    log: (message) => state.logs.push(message),
  });
  return { readiness, state };
}

// 1) Before any probe the facts are all-unknown — the permissive pre-probe state,
//    which is what a window created before the launch trigger hydrates to.
{
  const { readiness, state } = harness(HEALTHY);
  assert.deepEqual(readiness.read(), UNKNOWN_CLI_READINESS_FACTS);
  assert.equal(state.probes, 0, "constructing the controller probes nothing");
  assert.deepEqual(state.broadcasts, [], "and broadcasts nothing");
  readiness.dispose();
  results.preProbe = "all unknown, zero effects";
}

// 2) The changed event fires exactly once per change, and never for a re-probe
//    that learns the same thing.
{
  const { readiness, state } = harness(CLAUDE_ABSENT);

  await readiness.probe("launch");
  assert.equal(state.probes, 1);
  assert.deepEqual(readiness.read(), CLAUDE_ABSENT);
  assert.equal(state.broadcasts.length, 1, "the first real fact is a change");
  assert.deepEqual(state.broadcasts[0], CLAUDE_ABSENT);

  await readiness.probe("reprobe");
  await readiness.probe("reprobe");
  assert.equal(state.probes, 3, "both re-probes ran");
  assert.equal(state.broadcasts.length, 1, "…and neither said anything new");
  assert.ok(
    state.logs.filter((line) => line.includes("(unchanged)")).length === 2,
    `an unchanged probe still narrates (${JSON.stringify(state.logs)})`,
  );

  state.next = CLAUDE_SIGNED_OUT;
  await readiness.probe("reprobe");
  assert.equal(state.broadcasts.length, 2, "EXACTLY once for one change");
  assert.deepEqual(state.broadcasts[1], CLAUDE_SIGNED_OUT);
  assert.deepEqual(readiness.read(), CLAUDE_SIGNED_OUT);

  // A change back is a change too — the card has to be able to disappear.
  state.next = HEALTHY;
  await readiness.probe("reprobe");
  assert.equal(state.broadcasts.length, 3);
  assert.deepEqual(state.broadcasts[2], HEALTHY);

  readiness.dispose();
  results.changeEvent = { probes: state.probes, broadcasts: state.broadcasts.length };
}

// 3) The focus gate (D4). Focus re-probes while something is ACTIONABLE and costs
//    nothing otherwise — including on a machine we could not read at all, which
//    is the permissive rule doing its job rather than an oversight.
{
  const { readiness, state } = harness(HEALTHY);

  // Pre-probe (all unknown): focus must be free.
  readiness.noteMainWindowFocus();
  await settle();
  assert.equal(state.probes, 0, "unknown is not unhealthy — focus probes nothing");

  await readiness.probe("launch");
  assert.equal(state.probes, 1);

  // Healthy: focus is free.
  for (let i = 0; i < 5; i += 1) {
    readiness.noteMainWindowFocus();
  }
  await settle();
  assert.equal(state.probes, 1, "a healthy machine spends NOTHING on focus");

  // Now break it through a non-focus trigger, and focus starts earning its keep.
  state.next = CLAUDE_ABSENT;
  await readiness.probe("reprobe");
  assert.equal(state.probes, 2);
  readiness.noteMainWindowFocus();
  await settle();
  assert.equal(state.probes, 3, "focus re-probes while absent");

  // signedOut is equally actionable.
  state.next = CLAUDE_SIGNED_OUT;
  await readiness.probe("reprobe");
  const beforeSignedOutFocus = state.probes;
  readiness.noteMainWindowFocus();
  await settle();
  assert.equal(state.probes, beforeSignedOutFocus + 1, "focus re-probes while signed out");

  // Heal it, and focus goes quiet again — the gate is not one-way.
  state.next = HEALTHY;
  await readiness.probe("reprobe");
  const beforeHealedFocus = state.probes;
  readiness.noteMainWindowFocus();
  readiness.noteMainWindowFocus();
  await settle();
  assert.equal(state.probes, beforeHealedFocus, "healed → focus is free again");

  // An all-unknown reading is not a licence to poll on focus either.
  state.next = ALL_UNKNOWN;
  await readiness.probe("reprobe");
  const beforeUnknownFocus = state.probes;
  readiness.noteMainWindowFocus();
  await settle();
  assert.equal(state.probes, beforeUnknownFocus, "unknown → focus is free");

  readiness.dispose();
  results.focusGate = "probes only while actionable";
}

// 4) `reprobe` is the L7 entry point: it busts the login-shell PATH cache only
//    when asked, and it is the same orchestration as any other trigger.
{
  const { readiness, state } = harness(CLAUDE_ABSENT);

  await readiness.reprobe();
  assert.equal(state.busts, 0, "an ordinary re-probe leaves the cache alone");

  state.next = HEALTHY;
  await readiness.reprobe({ bustPathCache: true });
  assert.equal(state.busts, 1, "…and busts it when asked");
  assert.deepEqual(readiness.read(), HEALTHY, "the post-install read sees the new binary");

  readiness.dispose();
  results.bust = { busts: state.busts };
}

// 5) Concurrency has two shapes, and the difference is the L7 bug.
{
  // (a) An ordinary caller arriving mid-probe JOINS: one probe, one broadcast,
  //     and every awaited promise means "a probe has completed".
  const gate = deferred();
  const state = { probes: 0, broadcasts: [] };
  const readiness = new CliReadiness({
    broadcast: (value) => state.broadcasts.push(value),
    probe: async () => {
      state.probes += 1;
      await gate.promise;
      return CLAUDE_ABSENT;
    },
    log: () => {},
  });

  const first = readiness.probe("launch");
  const second = readiness.probe("focus");
  const third = readiness.reprobe();
  gate.resolve();
  await Promise.all([first, second, third]);
  assert.equal(state.probes, 1, "three concurrent callers, ONE probe");
  assert.equal(state.broadcasts.length, 1);
  assert.deepEqual(readiness.read(), CLAUDE_ABSENT);
  readiness.dispose();

  // (b) A bust-requesting caller must NOT join: it is asking about a machine that
  //     changed since the in-flight probe resolved its PATH. Joining would hand
  //     it that probe's stale `absent` — exactly the "installed fine, card says
  //     failed" bug L7 exists to prevent. So it queues, and its answer is the one
  //     computed AFTER the bust.
  const slow = deferred();
  const order = [];
  const scripted = [CLAUDE_ABSENT, HEALTHY];
  let index = 0;
  let busts = 0;
  const queued = new CliReadiness({
    broadcast: () => {},
    probe: async () => {
      const answer = scripted[index] ?? HEALTHY;
      index += 1;
      order.push(`probe:${index}`);
      if (index === 1) {
        await slow.promise;
      }
      return answer;
    },
    bustPathCache: () => {
      busts += 1;
      order.push("bust");
    },
    log: () => {},
  });

  // "launch", not "focus": a focus trigger over pre-probe (all-unknown) facts is
  // correctly DECLINED by the gate, and then there would be no in-flight probe
  // for the bust to have to wait for — the scenario would evaporate.
  const inFlight = queued.probe("launch");
  const afterInstall = queued.reprobe({ bustPathCache: true });
  // Let the first probe actually start (the chain hops a microtask), then check
  // that the second one has NOT — a bust that ran while a probe was still in
  // flight would be busting the cache the running probe already read.
  await settle();
  assert.deepEqual(order, ["probe:1"], "the bust is queued behind the in-flight probe");
  slow.resolve();
  await Promise.all([inFlight, afterInstall]);
  assert.deepEqual(
    order,
    ["probe:1", "bust", "probe:2"],
    "the bust runs BETWEEN the two probes, never before the first",
  );
  assert.equal(busts, 1);
  assert.deepEqual(queued.read(), HEALTHY, "the post-install fact wins, not the stale one");
  queued.dispose();
  results.concurrency = { joined: 1, queued: order };
}

// 6) A probe never rejects, and a failing probe leaves the LAST KNOWN facts
//    intact rather than degrading them. That direction matters: forgetting a
//    `present/signedIn` reading would turn a transient hiccup into a card the
//    user has to dismiss, and the machine has not changed just because we
//    momentarily failed to look at it.
{
  const logs = [];
  let broadcasts = 0;
  let failNext = false;
  const readiness = new CliReadiness({
    broadcast: () => {
      broadcasts += 1;
    },
    probe: async () => {
      if (failNext) {
        throw new Error("probe blew up");
      }
      return CLAUDE_ABSENT;
    },
    log: (message) => logs.push(message),
  });

  await readiness.probe("launch");
  assert.deepEqual(readiness.read(), CLAUDE_ABSENT);
  assert.equal(broadcasts, 1);

  failNext = true;
  await readiness.probe("reprobe"); // must not reject
  assert.deepEqual(readiness.read(), CLAUDE_ABSENT, "the last known facts survive");
  assert.equal(broadcasts, 1, "a failed probe broadcasts nothing");
  assert.ok(
    logs.some((line) => line.includes("failed") && line.includes("probe blew up")),
    `the failure is narrated (${JSON.stringify(logs)})`,
  );
  readiness.dispose();
  results.failure = "logged, facts preserved, no broadcast";
}

// 7) Dispose (app quit). Two moments, because a probe is asynchronous at both
//    ends: one that has not started yet must never start, and one already talking
//    to a subprocess must finish without broadcasting into a window set that is
//    being torn down.
{
  const gate = deferred();
  let probes = 0;
  const readiness = new CliReadiness({
    broadcast: () => assert.fail("a disposed controller must not broadcast"),
    probe: async () => {
      probes += 1;
      await gate.promise;
      return CLAUDE_ABSENT;
    },
    log: () => {},
  });

  // (a) Quit arrives in the same tick as the trigger — the probe never runs at
  //     all, so a quit racing the launch trigger costs zero subprocesses.
  const raced = readiness.probe("launch");
  readiness.dispose();
  await raced;
  assert.equal(probes, 0, "a probe disposed before it started never starts");

  // (b) A probe that WAS running when dispose landed. Fresh controller: start it,
  //     let it reach its await, then dispose.
  const running = new CliReadiness({
    broadcast: () => assert.fail("a disposed controller must not broadcast"),
    probe: async () => {
      probes += 1;
      await gate.promise;
      return CLAUDE_ABSENT;
    },
    log: () => {},
  });
  const inFlight = running.probe("launch");
  await settle();
  assert.equal(probes, 1, "the probe is genuinely in flight");
  running.dispose();
  gate.resolve();
  await inFlight;
  assert.deepEqual(running.read(), UNKNOWN_CLI_READINESS_FACTS, "its result was dropped");

  // …and no later trigger revives either of them.
  for (const disposed of [readiness, running]) {
    await disposed.probe("launch");
    disposed.noteMainWindowFocus();
    await disposed.reprobe({ bustPathCache: true });
  }
  await settle();
  assert.equal(probes, 1, "no trigger after dispose starts a probe");
  results.dispose = "inert";
}

console.log(JSON.stringify({ success: true, results }, null, 2));

/**
 * Flush a fire-and-forget trigger. `noteMainWindowFocus` discards its promise on
 * purpose (a window activation must never await a subprocess), so the assertion
 * has to let the controller's microtask chain run — two macrotask turns drain it
 * whatever order the `.then`/`.finally` links settle in. Deliberately NOT another
 * `probe()` call, which would perturb the very counts under test.
 */
function settle() {
  return new Promise((resolve) => {
    setImmediate(() => setImmediate(resolve));
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
