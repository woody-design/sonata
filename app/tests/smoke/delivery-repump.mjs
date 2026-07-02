import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Deterministic regression for the delivery re-pump: a queue blocked ONLY by a
// no-event gate must deliver when the gate recovers, even though no runtime
// event fires. Two gates matter post-send-is-send: the one-shot boot latch
// (first accepts-input), and a live interactive panel (modal). A fake
// TerminalHost flips a gate false→true with NO handleRuntimeEvent call.
const require = createRequire(import.meta.url);
const { DeliveryController } = require("../../dist/runtime");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function makeHost(overrides = {}) {
  const state = {
    activeRun: false,
    approval: false,
    modal: false,
    accepts: false,
    idle: true,
    submits: [],
    ...overrides,
  };
  return {
    state,
    hasActiveRun: () => state.activeRun,
    isApprovalActive: () => state.approval,
    isModalActive: () => state.modal,
    acceptsPromptInput: () => state.accepts,
    isIdleComposerReady: () => state.idle,
    submitPrompt: (text, opts) => {
      state.submits.push({ text, opts });
      return {
        taskId: "t",
        runId: `r${state.submits.length}`,
        kind: text.startsWith("/") ? "slash" : "prompt",
        submittedAt: new Date(1700000000000).toISOString(),
      };
    },
  };
}

function makeController(host) {
  return new DeliveryController({
    taskId: "t",
    provider: "claude",
    terminalHost: host,
    eventSink: () => {},
    hasLiveTranscriptSource: () => false,
    pumpRetryIntervalMs: 20,
  });
}

// --- 1. Sanity: a ready session delivers immediately on enqueue -------------
{
  const host = makeHost({ accepts: true });
  const dc = makeController(host);
  dc.enqueue("hello");
  assert.equal(host.state.submits.length, 1, "ready session delivers on enqueue");
  dc.dispose();
}

// --- 2. THE FIX: blocked only by accepts-input, gate recovers with NO event --
{
  const host = makeHost({ accepts: false });
  const dc = makeController(host);
  dc.enqueue("hello");
  assert.equal(host.state.submits.length, 0, "must not deliver while accepts-input is false");
  await delay(60); // a few retry intervals — still blocked, must not deliver
  assert.equal(host.state.submits.length, 0, "stays queued while the gate is false");
  host.state.accepts = true; // gate recovers — NO runtime event fired
  await delay(120); // the re-pump poll must catch the rising edge
  assert.equal(host.state.submits.length, 1, "re-pump delivers when the gate recovers without an event");
  dc.dispose();
}

// --- 3. Send-is-send: human typing does NOT hold delivery --------------------
// The old gate held delivery while the human was "actively typing" — an
// inference from the PTY byte stream whose false positives (auto-replies, OSC
// echoes) wedged the queue indefinitely (the shipped stuck-Queued bugs). That
// hold is deleted: the queue delivers regardless of terminal typing. Byte-level
// integrity (a paste never splitting a human keystroke frame) is the
// TerminalHost AtomicWriter's job, verified in terminal-arbitration.mjs — not a
// delivery-gate concern. No invisible holds.
{
  const host = makeHost({ accepts: true });
  const dc = makeController(host);
  dc.enqueue("hello");
  assert.equal(
    host.state.submits.length,
    1,
    "delivers even though the human is 'typing' (send-is-send; no typing hold)",
  );
  dc.dispose();
}

// --- 4. No busy-deliver loop: an empty queue schedules nothing ---------------
{
  const host = makeHost({ accepts: false });
  const dc = makeController(host);
  // never enqueued — the retry must not arm or deliver anything
  await delay(80);
  assert.equal(host.state.submits.length, 0, "no delivery without a queued item");
  dc.dispose();
}

// --- 5. Event-backed blocker that clears with NO event still recovers --------
// The wedge class behind the fresh-session / post-restart "stuck Queued": a
// startup/resume interstitial arms an event-backed blocker (modal), then
// disarms WITHOUT any pump-triggering event. The pump must keep polling and
// deliver once it clears — not wait forever on an event that never comes.
{
  const host = makeHost({ accepts: true, modal: true });
  const dc = makeController(host);
  dc.enqueue("hello");
  await delay(700); // longer than a poll interval — the modal must hold it
  assert.equal(host.state.submits.length, 0, "does NOT deliver while a modal is up");
  // The interstitial disarms silently — NO event is fired into the controller.
  host.state.modal = false;
  await delay(700);
  assert.equal(
    host.state.submits.length,
    1,
    "polls and delivers after the event-backed blocker clears with no event",
  );
  dc.dispose();
}

console.log(JSON.stringify({ smoke: "delivery-repump", success: true }, null, 2));
