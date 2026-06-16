import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Deterministic regression for the CLI Slice 4 re-pump gap: a queue blocked
// ONLY by the no-event `acceptsPromptInput` gate must deliver when the gate
// recovers, even though no runtime event fires (the idle-session case that
// opening the take-over floor created). A fake TerminalHost flips the gate
// false→true with NO handleRuntimeEvent call.
const require = createRequire(import.meta.url);
const { DeliveryController } = require("../../dist/runtime");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function makeHost(overrides = {}) {
  const state = {
    activeRun: false,
    approval: false,
    modal: false,
    userControl: false,
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
    isUserControlActive: () => state.userControl,
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
    wedgeCheckIntervalMs: 1000,
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

// --- 3. Event-backed blockers are NOT polled (take-over waits for hand-back) -
{
  const host = makeHost({ accepts: false, userControl: true });
  const dc = makeController(host);
  dc.enqueue("hello");
  host.state.accepts = true; // gate is fine now, but take-over still holds
  await delay(120);
  assert.equal(
    host.state.submits.length,
    0,
    "does NOT poll-deliver while take-over holds (waits for the hand-back event)",
  );
  // Hand back: the single-writer release emits an event → pump re-evaluates.
  host.state.userControl = false;
  dc.handleRuntimeEvent({
    type: "terminal:user-control",
    payload: { taskId: "t", active: false, reason: "user" },
    ts: new Date(1700000000000).toISOString(),
  });
  await delay(60);
  assert.equal(host.state.submits.length, 1, "delivers once control is handed back");
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

console.log(JSON.stringify({ smoke: "delivery-repump", success: true }, null, 2));
