import assert from "node:assert/strict";
import { createRequire } from "node:module";

// SL-15 — WHICH KEY A STOP WRITES, and the state that decides it.
//
// THE INCIDENT (upstream sync 2026-09, codex findings C17). At codex 0.152.1
// three Esc paths — a human Esc, a raw Esc, and production `stopRun()` — each
// left a live turn running to completion with an ordinary `Stop`; only Ctrl+C
// interrupted, and only Ctrl+C fired the `Interrupt` hook. Sonata's stop button
// did not stop a codex turn.
//
// PHASE-RESOLVED (probe q34, after a control leg contradicted C17): Esc still
// interrupts BEFORE the model emits anything, and does nothing once tokens are
// streaming; Ctrl+C interrupts in both phases. C17 had pressed mid-stream all
// three times. The narrower claim leaves the consequence intact — output
// arriving is exactly why a stop gets pressed — and makes Ctrl+C the only key
// that works in every phase of a live turn.
//
// WHY IT IS NOT A BYTE SWAP. The binary calls the action
// `fixed.interrupt_or_quit`, and it means both words. MEASURED across every state
// the stop can reach (spikes/upstream-sync-2026-09/codex, probe q31):
//
//   live turn                  → interrupts; `Interrupt` at +121…141ms; no Stop
//   live turn + approval panel → denies the request AND interrupts
//   `/model` picker open       → closes the picker
//   idle composer with a draft → clears the draft
//   idle composer, EMPTY       → QUITS THE CLI. exit 0. One press. No confirmation.
//
// And an empty composer is not exotic: it is exactly what an interrupt leaves
// behind (q31 s1 — a second press 2.5s later quit), and what clearing a draft
// leaves behind (q31 s3 — the second press quit).
//
// So the fix is a key CHOICE gated on state, and this file pins the choice. The
// guard is Sonata's own run pointer and nothing else — the screen cannot help
// (the production idle-prompt detector read `ready:true` in 12/20, 12/20 and
// 14/20 samples of genuinely live turns, so a "refuse if it looks idle" belt
// would refuse most real interrupts), and `acceptsPromptInput()` is not an
// independent signal (it is false whenever `activeRun` is set).
//
// Fake pty, no real CLI — the question here is which bytes leave, and under
// which state. The live-CLI half is q31 + the SL-15 end-to-end verification.
const require = createRequire(import.meta.url);
const { TerminalHost, ESC } = require("../../dist/runtime");

const CTRL_C = "\x03";
const failures = [];

function makeHost(provider, events = []) {
  return new TerminalHost({
    taskId: `codex-stop-interrupt-key-${provider}`,
    provider,
    defaultWorkspace: process.cwd(),
    eventSink: (event) => events.push(event),
  });
}

function fakePty(writes) {
  return {
    pid: 0,
    write(data) {
      writes.push(data);
    },
    kill() {},
    resize() {},
    onData() {},
    onExit() {},
  };
}

function runWithStatus(status) {
  const now = Date.now();
  return {
    taskId: "codex-stop-interrupt-key-codex",
    id: `run-${now}-1`,
    kind: "prompt",
    prompt: "do the thing",
    title: "do the thing",
    status,
    lifecyclePhase: status === "active" ? "active" : status,
    startedAt: new Date(now - 3000).toISOString(),
    endedAt: null,
    elapsedMs: null,
    completionSource: null,
    completionConfidence: null,
  };
}

/** Run one stop and report everything the assertions below need to read. The
 *  `inspectDelayMs` is large enough that the deferred `/stop` inspection cannot
 *  fire inside a check and add writes the key assertions would then have to
 *  filter out. */
async function stopWith(provider, { run = null, approvalActive = false } = {}) {
  const events = [];
  const writes = [];
  const host = makeHost(provider, events);
  host.ptyProcess = fakePty(writes);
  if (run) host.activeRun = run;
  if (approvalActive) {
    host.approvalActive = true;
    host.lastApprovalKind = "command";
  }
  await host.stopRun({ inspectDelayMs: 60_000 });
  const result = {
    writes,
    events,
    interruptWrite: writes[0],
    stopRequested: events.find((event) => event.type === "run:stop-requested"),
    stopped: events.find((event) => event.type === "run:stopped"),
    decision: events.find((event) => event.type === "approval:decision"),
    updated: events.filter((event) => event.type === "run:updated"),
    retryArmed: host.stopEscRetry !== null,
  };
  host.dispose();
  return result;
}

await check("codex + a LIVE turn: the stop writes Ctrl+C, and records that it did", async () => {
  const stop = await stopWith("codex", { run: runWithStatus("active") });

  assert.equal(stop.interruptWrite, CTRL_C, "the first byte a codex stop writes on a live turn is Ctrl+C");
  assert.equal(stop.stopRequested?.payload.encodedAs, "Ctrl+C");
  assert.equal(stop.stopRequested?.payload.phase, "interrupt");
  assert.match(
    stop.stopped?.payload.slashStopReason ?? "",
    /^Ctrl\+C sent immediately/,
    "the durable stop record must name the key that was actually written",
  );
  assert.equal(
    stop.updated.at(-1)?.payload.statusReason,
    "Ctrl+C interrupt sent",
    "and so must the run's own status reason",
  );
});

await check("codex + a live turn: the one-shot resend is NOT armed behind a Ctrl+C", async () => {
  const stop = await stopWith("codex", { run: runWithStatus("active") });
  assert.equal(
    stop.retryArmed,
    false,
    // The retry's only guard is a PreToolUse hook after the stop; it cannot gate
    // on the run pointer, because stopRun has already closed the run (its own
    // guard reads `!this.activeRun`). A resent Ctrl+C that lands on an idle
    // composer quits the CLI, so nothing may arm one.
    "a Ctrl+C stop must leave no armed resend — a blind second Ctrl+C is quit-capable",
  );
});

await check("codex + NO live run: the stop writes Esc, exactly as before the fix", async () => {
  const stop = await stopWith("codex", { run: null });

  assert.equal(stop.interruptWrite, ESC, "with no turn to interrupt the key is unchanged");
  assert.ok(
    !stop.writes.includes(CTRL_C),
    "THE RED LINE: no quit-capable byte may reach a composer Sonata does not believe is mid-turn",
  );
  assert.equal(stop.stopRequested?.payload.encodedAs, "Esc");
  assert.equal(stop.retryArmed, true, "the Esc path keeps its one-shot resend");
});

// The pointer is not merely non-null — a run in a terminal status is a turn that
// is already over, and writing the interrupt into one is the same mistake as
// writing it at an idle composer.
for (const status of ["stopping", "stopped", "completed", "failed", "approval-denied", "pty-exited"]) {
  await check(`codex + a run already in "${status}": the stop writes Esc, not Ctrl+C`, async () => {
    const stop = await stopWith("codex", { run: runWithStatus(status) });
    assert.equal(stop.interruptWrite, ESC);
    assert.ok(!stop.writes.includes(CTRL_C));
  });
}

// The three statuses that ARE a live turn, each named rather than covered by the
// "active" case alone: an approval-parked turn is still in flight, and stopping
// it is one of the commonest reasons to press stop at all.
for (const status of ["active", "waiting-for-approval", "resumed-after-approval"]) {
  await check(`codex + a run in "${status}": the stop writes Ctrl+C`, async () => {
    const stop = await stopWith("codex", { run: runWithStatus(status) });
    assert.equal(stop.interruptWrite, CTRL_C);
  });
}

await check("codex + a live turn under an approval panel: the deny is recorded as Ctrl+C", async () => {
  const stop = await stopWith("codex", {
    run: runWithStatus("waiting-for-approval"),
    approvalActive: true,
  });

  assert.equal(stop.interruptWrite, CTRL_C);
  assert.ok(stop.decision, "a stop over a live panel must still settle the approval");
  assert.equal(stop.decision.payload.decision, "deny");
  assert.equal(
    stop.decision.payload.encodedAs,
    "Ctrl+C",
    // MEASURED (q31 s8): Ctrl+C on a real codex command-approval panel printed
    // `✗ You canceled the request to run …` alongside `■ Conversation
    // interrupted`. The deny is honest; only the label had to follow the key.
    "the decision names the key that denied the panel",
  );
});

await check("claude is untouched: Esc, an armed resend, and an Esc-labelled record", async () => {
  const live = await stopWith("claude", { run: runWithStatus("active") });
  assert.equal(live.interruptWrite, ESC);
  assert.equal(live.stopRequested?.payload.encodedAs, "Esc");
  assert.equal(live.retryArmed, true);
  assert.match(live.stopped?.payload.slashStopReason ?? "", /^Esc sent immediately/);
  assert.ok(!live.writes.includes(CTRL_C), "Ctrl+C is codex vocabulary and must never reach a claude PTY");

  const idle = await stopWith("claude", { run: null });
  assert.equal(idle.interruptWrite, ESC, "claude's key does not depend on the run pointer");
  assert.equal(idle.retryArmed, true);
});

report();

async function check(name, body) {
  try {
    await body();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push({ name, message: error.message });
    console.log(`not ok - ${name}: ${error.message}`);
  }
}

function report() {
  if (failures.length > 0) {
    console.error(JSON.stringify({ success: false, failures }, null, 2));
    process.exit(1);
  }
  console.log("codex-stop-interrupt-key smoke passed");
}
