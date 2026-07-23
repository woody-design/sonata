import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Fences the first-prompt Enter-race fix (2026-07-15,
// spikes/first-prompt-enter-race): (1) the boot-init Enter-swallow GRACE — the
// first delivery after the boot latch opens is held bootDeliveryGraceMs so its
// bytes land past claude's ~[SS+90, SS+300] swallow window; (2) the
// receipt-verified Enter RETRY — an in-flight prompt with no receipt re-sends
// the submit Enter at the configured delays, guarded so it never fires into an
// approval or over a co-present human's keystrokes. Fake host, injectable
// timings (tens of ms), no real CLI.
const require = createRequire(import.meta.url);
const { DeliveryController } = require("../../dist/runtime");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];

function fakeHost(overrides = {}) {
  const state = {
    activeRun: false,
    approval: false,
    pendingControlSwitch: false,
    accepts: false,
    humanTyping: false,
    submits: [],
    nudges: 0,
    ...overrides,
  };
  return {
    state,
    hasActiveRun: () => state.activeRun,
    isApprovalActive: () => state.approval,
    hasPendingControlSwitch: () => state.pendingControlSwitch,
    acceptsPromptInput: () => state.accepts,
    isHumanActivelyTyping: () => state.humanTyping,
    submitPrompt: (text, opts) => {
      // A superseding delivery that FAILS at the host: deliver() bumps the
      // delivery seq (composer touched) but takes the catch path, leaving any
      // prior echo ladder armed-but-stale (exercises the ownership guard).
      if (text.trim() === "BOOM") {
        state.submits.push({ text, opts, threw: true });
        throw new Error("submit boom");
      }
      state.submits.push({ text, opts });
      return {
        taskId: "t",
        runId: `r${state.submits.length}`,
        kind: text.trim().startsWith("/") ? "slash" : "prompt",
        submittedAt: new Date().toISOString(), // now → backfill window matches a fresh transcript block
      };
    },
    // Mirrors TerminalHost.nudgePromptSubmit's guard shape; records the attempt.
    nudgePromptSubmit: () => {
      if (state.approval || state.pendingControlSwitch) {
        return false;
      }
      state.nudges += 1;
      return true;
    },
  };
}

function makeController(host, options = {}) {
  return new DeliveryController({
    taskId: "t",
    provider: "claude",
    terminalHost: host,
    eventSink: () => {},
    hasLiveTranscriptSource: () => true, // no PTY-echo receipt → inFlight awaits transcript
    pumpRetryIntervalMs: 20,
    // These fixtures test ladder MECHANICS with deliberately tiny rungs and send
    // no attachments, so the attachment-margin assert does not apply here.
    attachmentWorstCaseMs: 0,
    ...options,
  });
}

// A PTY chunk that paints `text` into the composer — drives the claude
// first-message `pty-composer-echo` receipt (containsPromptEcho match).
const echoData = (text) => ({
  type: "pty:data",
  payload: { taskId: "t", data: `\r\n> ${text}` },
  ts: new Date().toISOString(),
});

const receiptFor = (text) => ({
  type: "transcript:blocks",
  payload: {
    taskId: "t",
    sourceId: "s1",
    reset: false,
    upserts: [
      {
        kind: "user-message",
        id: "s1:u1",
        taskId: "t",
        sourceId: "s1",
        provider: "claude",
        turnKey: "turn-1",
        runId: "run-1",
        ts: new Date().toISOString(),
        seq: 1,
        text,
        command: null,
        attachments: [],
      },
    ],
  },
  ts: new Date().toISOString(),
});

// --- GRACE 1: latch opens LATE (scrape rising edge) — grace holds the send ---
await check("boot grace: item queued before the latch opens waits out the grace, then delivers", async () => {
  const host = fakeHost({ accepts: false });
  const dc = makeController(host, { bootDeliveryGraceMs: 120, enterRetryDelaysMs: [] });
  dc.enqueue("first prompt");
  assert.equal(host.state.submits.length, 0, "not delivered before the latch opens");
  await delay(60);
  assert.equal(host.state.submits.length, 0, "still queued while the latch is closed");

  host.state.accepts = true; // scrape/hook rising edge — latch opens on the next poll
  await delay(50); // latch now open, but < grace since it opened → must still hold
  assert.equal(host.state.submits.length, 0, "held by the grace right after the latch opens");

  await delay(220); // grace elapsed + a poll → delivers promptly
  assert.equal(host.state.submits.length, 1, "delivers once the grace elapses after latch-open");
  dc.dispose();
});

// --- GRACE 2: latch already open at enqueue (hook-first) — grace STILL delays -
await check("boot grace: even an already-ready host holds the FIRST send for the grace", async () => {
  const host = fakeHost({ accepts: true });
  const dc = makeController(host, { bootDeliveryGraceMs: 120, enterRetryDelaysMs: [] });
  dc.enqueue("first prompt");
  assert.equal(host.state.submits.length, 0, "first send held by the grace even when accepts-input is already true");
  await delay(220);
  assert.equal(host.state.submits.length, 1, "delivers after the grace");
  dc.handleRuntimeEvent(receiptFor("first prompt")); // complete it so the queue is free

  // A LATER send (grace already long-elapsed, no in-flight) goes out with no delay.
  dc.enqueue("second prompt");
  assert.equal(host.state.submits.length, 2, "post-boot send delivers immediately — grace costs nothing later");
  dc.dispose();
});

// --- RETRY 1: no receipt → nudge fires; a later receipt completes normally ----
await check("enter retry: unreceipted in-flight prompt nudges at the first delay; a receipt then completes it", async () => {
  const host = fakeHost({ accepts: true });
  const dc = makeController(host, {
    bootDeliveryGraceMs: 0,
    enterRetryDelaysMs: [60, 240],
    receiptTimeoutMs: 5000,
  });
  const item = dc.enqueue("nudge me");
  assert.equal(host.state.submits.length, 1, "delivered once (bytes written)");

  await delay(120); // past the first rung, before the second
  assert.equal(host.state.nudges, 1, "one submit-Enter re-sent");
  assert.equal(host.state.submits.length, 1, "the nudge is an Enter re-send, NOT a re-paste");

  dc.handleRuntimeEvent(receiptFor("nudge me"));
  assert.equal(dc.state().queue.length, 0, "receipt after the nudge completes delivery");

  await delay(200); // past the second rung — must NOT fire after completion
  assert.equal(host.state.nudges, 1, "no further nudge once delivered");
  dc.dispose();
});

// --- RETRY GUARD: pending approval key → skipped (never Enter into an ask) -----
// The two guard tests use a TWO-rung ladder [60, 240] with the guard held only
// across rung 1, cleared by ~120ms. This falsifies more than a one-rung skip:
// it fails a skip-cancels-ladder impl (would give 0 nudges) AND a
// rung-1-rescheduling impl (would nudge early / more than once). Correct
// skip-not-reschedule ⇒ exactly ONE nudge, at rung 2, none before 120ms.
await check("enter retry: a pending approval key skips rung 1 (skip, not reschedule) — rung 2 nudges once", async () => {
  const host = fakeHost({ accepts: true });
  const dc = makeController(host, {
    bootDeliveryGraceMs: 0,
    enterRetryDelaysMs: [60, 240],
    receiptTimeoutMs: 5000,
  });
  dc.enqueue("guarded by approval");
  dc.handleRuntimeEvent({
    type: "approval:detected",
    payload: { taskId: "t", runId: null, kind: "command", source: "hook-broker", approvalId: "ask-1" },
    ts: "",
  });
  await delay(120); // rung 1 (60ms) has fired while the ask is pending
  assert.equal(host.state.nudges, 0, "no nudge before 120ms — rung 1 skipped");
  dc.handleRuntimeEvent({
    type: "approval:decision",
    payload: { taskId: "t", runId: null, decision: "approve", encodedAs: "reply-file", previousKind: "command", approvalId: "ask-1" },
    ts: "",
  });
  // t≈220ms: gate open, but before rung 2 (240). A cancel-and-reschedule-rung-1
  // impl would have fired its replacement by ~120-180ms — assert it did NOT.
  await delay(100);
  assert.equal(host.state.nudges, 0, "still no nudge at ~220ms — the skipped rung was NOT rescheduled");
  await delay(120); // t≈340ms — past rung 2 (240)
  assert.equal(host.state.nudges, 1, "exactly one nudge total, and only at rung 2 (≥240ms)");
  dc.dispose();
});

// --- RETRY GUARD: human actively typing → skipped, not rescheduled -----------
await check("enter retry: human typing skips rung 1 (skip, not reschedule) — rung 2 nudges once", async () => {
  const host = fakeHost({ accepts: true, humanTyping: true });
  const dc = makeController(host, {
    bootDeliveryGraceMs: 0,
    enterRetryDelaysMs: [60, 240],
    receiptTimeoutMs: 5000,
  });
  dc.enqueue("do not clobber the human");
  await delay(120); // rung 1 fired while the human is "typing"
  assert.equal(host.state.nudges, 0, "no nudge before 120ms — rung 1 skipped");
  host.state.humanTyping = false; // the human stopped
  await delay(100); // t≈220ms — before rung 2 (240); a rescheduled rung would have nudged by ~180ms
  assert.equal(host.state.nudges, 0, "still no nudge at ~220ms — the skipped rung was NOT rescheduled");
  await delay(120); // t≈340ms — past rung 2
  assert.equal(host.state.nudges, 1, "exactly one nudge total, and only at rung 2 (≥240ms)");
  dc.dispose();
});

// --- RETRY GUARD: completed before the timer → no late nudge -----------------
await check("enter retry: completing before the delay clears the ladder (no late nudge)", async () => {
  const host = fakeHost({ accepts: true });
  const dc = makeController(host, {
    bootDeliveryGraceMs: 0,
    enterRetryDelaysMs: [80],
    receiptTimeoutMs: 5000,
  });
  dc.enqueue("quick receipt");
  dc.handleRuntimeEvent(receiptFor("quick receipt")); // receipt before the 80ms rung
  assert.equal(dc.state().queue.length, 0, "delivered immediately");
  await delay(140);
  assert.equal(host.state.nudges, 0, "the cleared ladder never fired");
  dc.dispose();
});

// --- RETRY REPORT: the receipt-timeout failureReason carries the retry count --
await check("enter retry: receipt-timeout failureReason reports the number of retries attempted", async () => {
  const host = fakeHost({ accepts: true });
  const dc = makeController(host, {
    bootDeliveryGraceMs: 0,
    enterRetryDelaysMs: [40, 90], // both fire before the 250ms receipt timeout
    receiptTimeoutMs: 250,
  });
  const item = dc.enqueue("never receipts");
  await delay(360); // past both rungs and the receipt timeout
  assert.equal(host.state.nudges, 2, "both ladder rungs fired");
  const stuck = dc.state().queue.find((entry) => entry.id === item.id);
  assert.ok(stuck, "the unreceipted item remains, reported (not head-blocking)");
  assert.equal(stuck.status, "undelivered");
  assert.match(
    stuck.failureReason ?? "",
    /2 submit-Enter retries attempted/,
    `failureReason must carry the retry count, got: ${stuck.failureReason}`,
  );
  dc.dispose();
});

// --- ECHO×RETRY (i): echo-completed + uncorroborated → rung 1 nudges ----------
// The pty-composer-echo receipt completes the item on composer PAINT — which is
// present even when the Enter was swallowed. The heal net must survive it.
await check("echo×retry: an echo-completed but uncorroborated item still nudges at rung 1", async () => {
  const host = fakeHost({ accepts: true });
  const dc = makeController(host, {
    hasLiveTranscriptSource: () => false, // claude first message → pty-echo receipt armed
    bootDeliveryGraceMs: 0,
    enterRetryDelaysMs: [60, 240],
    receiptTimeoutMs: 5000,
  });
  dc.enqueue("echo me");
  dc.handleRuntimeEvent(echoData("echo me")); // pty-echo receipt completes the item
  assert.equal(dc.state().queue.length, 0, "echo receipt completed (item left the queue)");
  await delay(120); // past rung 1 (60), before rung 2 (240)
  assert.equal(host.state.nudges, 1, "rung 1 reconciles the (unproven) echo completion with a nudge");
  dc.dispose();
});

// --- ECHO×RETRY (ii): corroborated echo completion → no nudge ----------------
await check("echo×retry: a transcript-corroborated echo completion disarms the nudge", async () => {
  const host = fakeHost({ accepts: true });
  const dc = makeController(host, {
    hasLiveTranscriptSource: () => false,
    bootDeliveryGraceMs: 0,
    enterRetryDelaysMs: [60, 240],
    receiptTimeoutMs: 5000,
  });
  dc.enqueue("echo me");
  dc.handleRuntimeEvent(echoData("echo me")); // echo completes (uncorroborated backfill)
  dc.handleRuntimeEvent(receiptFor("echo me")); // transcript corroborates a REAL submission
  await delay(120);
  assert.equal(host.state.nudges, 0, "no nudge — a real submission is on record");
  dc.dispose();
});

// --- ECHO×RETRY (iii): a superseding delivery (seq moved) → no stale nudge ----
await check("echo×retry: a superseding delivery cancels the stale echo ladder (ownership)", async () => {
  const host = fakeHost({ accepts: true });
  const dc = makeController(host, {
    hasLiveTranscriptSource: () => false,
    bootDeliveryGraceMs: 0,
    enterRetryDelaysMs: [60, 240],
    receiptTimeoutMs: 5000,
  });
  dc.enqueue("first");
  dc.handleRuntimeEvent(echoData("first")); // echo completes item A; ladder A left armed
  dc.enqueue("BOOM"); // deliver() bumps the seq then throws → ladder A is now stale
  await delay(120); // rung 1 of ladder A fires — but its captured seq is stale
  assert.equal(host.state.nudges, 0, "the stale ladder does not Enter into the superseding delivery");
  dc.dispose();
});

// --- ECHO×RETRY (iv): rung 2 never takes the echo branch ----------------------
await check("echo×retry: only the first rung takes the echo branch (rung 2 does not)", async () => {
  const host = fakeHost({ accepts: true });
  const dc = makeController(host, {
    hasLiveTranscriptSource: () => false,
    bootDeliveryGraceMs: 0,
    enterRetryDelaysMs: [60, 180],
    receiptTimeoutMs: 5000,
  });
  dc.enqueue("echo me");
  dc.handleRuntimeEvent(echoData("echo me"));
  await delay(260); // past BOTH rungs
  assert.equal(host.state.nudges, 1, "only rung 1 nudged; rung 2 did not take the echo branch");
  dc.dispose();
});

// --- ECHO×RETRY (v): UPS corroboration before rung 0 suppresses the nudge -----
// The authoritative submission proof (UserPromptSubmit) corroborates the echo
// backfill faster than the transcript chain, killing the wasteful no-op Enter
// (H2) and — the real risk — an Enter into an option-prompt the model raced onto
// the screen after a genuine submit (H1).
await check("echo×retry: notePromptSubmittedByCli before rung 0 suppresses the nudge (H1/H2)", async () => {
  const host = fakeHost({ accepts: true });
  const dc = makeController(host, {
    hasLiveTranscriptSource: () => false,
    bootDeliveryGraceMs: 0,
    enterRetryDelaysMs: [60, 240],
    receiptTimeoutMs: 5000,
  });
  dc.enqueue("echo me");
  dc.handleRuntimeEvent(echoData("echo me")); // echo completes (uncorroborated)
  dc.notePromptSubmittedByCli("echo me"); // UPS: a real submission is on record
  await delay(120); // past rung 1 (60)
  assert.equal(host.state.nudges, 0, "no nudge — UPS corroborated the backfill before rung 0");
  dc.dispose();
});

// --- ECHO×RETRY (vi): one UPS suppresses ALL same-text ladders (twins) --------
// Text attribution between identical twins is unreliable, so a same-text UPS
// corroborates EVERY same-text ladder. This makes an H1 nudge (into a raced
// option-prompt) impossible by construction; the cost is that a genuinely-stuck
// twin loses its heal and falls to the honest 45s undelivered report.
await check("echo×retry: one UPS suppresses ALL same-text ladders (twins) — zero nudges", async () => {
  const host = fakeHost({ accepts: true });
  const dc = makeController(host, {
    hasLiveTranscriptSource: () => false,
    bootDeliveryGraceMs: 0,
    enterRetryDelaysMs: [80, 300],
    receiptTimeoutMs: 5000,
  });
  dc.enqueue("twin");
  dc.handleRuntimeEvent(echoData("twin")); // echo-complete A (older backfill)
  await delay(10);
  dc.enqueue("twin");
  dc.handleRuntimeEvent(echoData("twin")); // echo-complete B (younger backfill), ladder B armed
  dc.notePromptSubmittedByCli("twin"); // marks EVERY matching backfill corroborated
  await delay(160); // past rung 0 (80) of ladder B
  assert.equal(host.state.nudges, 0, "one same-text UPS suppresses every same-text ladder (H1 impossible by construction)");
  dc.dispose();
});

// --- ECHO×RETRY (vii): UPS suppresses the STRICT in-flight ladder too ---------
// The H1 class also reaches the strict branch: a live-transcript delivery earns
// NO echo backfill, the Enter genuinely submits, UPS fires, but the transcript
// user-block lags past rung 0 → the item is still strictly inFlight. Without
// this, rung 0 (only approval/human guards) could Enter into a raced option-prompt.
await check("echo×retry: UPS suppresses the strict in-flight nudge (no echo backfill)", async () => {
  const host = fakeHost({ accepts: true });
  const dc = makeController(host, {
    hasLiveTranscriptSource: () => true, // live transcript → NO echo backfill; strict in-flight
    bootDeliveryGraceMs: 0,
    enterRetryDelaysMs: [60, 240],
    receiptTimeoutMs: 5000,
  });
  dc.enqueue("submitted for real");
  dc.notePromptSubmittedByCli("submitted for real"); // UPS proves it submitted; receipt still lagging
  await delay(120); // past rung 1 (60)
  assert.equal(host.state.nudges, 0, "strict in-flight nudge suppressed once UPS corroborates the submission");
  dc.dispose();
});

// --- SESSION BOUNDARY (F1): noteSessionBoundary re-arms the grace -------------
// A /clear long after boot completes as a native-queue write-through (no
// Enter-retry armed), and its SessionStart never refreshed the grace — leaving
// a following prompt unprotected against the post-/clear repaint. The re-arm is
// its protection.
await check("session boundary: noteSessionBoundary re-arms the boot grace for the next send", async () => {
  const host = fakeHost({ accepts: true });
  const dc = makeController(host, {
    bootDeliveryGraceMs: 100,
    enterRetryDelaysMs: [],
    pumpRetryIntervalMs: 20,
  });
  // Boot: the first send waits out the initial grace, then delivers. Complete it
  // so the queue is free and the latch is long past its grace.
  dc.enqueue("first");
  await delay(200);
  assert.equal(host.state.submits.length, 1, "first delivered after the initial grace");
  dc.handleRuntimeEvent(receiptFor("first")); // free the queue

  dc.noteSessionBoundary(); // a /clear-class boundary
  dc.enqueue("post-clear");
  assert.equal(
    host.state.submits.length,
    1,
    "next send HELD by the re-armed grace (grace was long-elapsed → would deliver immediately without the re-arm)",
  );
  await delay(200); // re-armed grace elapsed + a poll
  assert.equal(host.state.submits.length, 2, "delivers once the re-armed grace elapses");
  dc.dispose();
});

if (failures.length > 0) {
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ smoke: "delivery-enter-retry", success: true }, null, 2));
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}
