import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Delivery gate, question shape #2 (ask-flows S3 / B4): an open claude
// `AskUserQuestion` form owns the composer exactly as an approval panel does —
// a queued send delivered into it pastes text and presses Enter onto its option
// rows (the digit/enter-swallow class, H1). The gate's own reachability is
// claude's mid-turn write-through: a queued item does NOT wait for the run to
// end, so it goes out at precisely the moment the model is most likely to have
// a question on screen.
//
// This fence is the DeliveryController half — the gate's semantics on the
// events. The other half (those events actually REACHING this controller, which
// is the defect: main synthesizes them from the hook sink and only ever handed
// them to the renderer) is fenced on the real RuntimeController in
// option-prompt-delivery-wiring.mjs. Neither file substitutes for the other:
// this one would pass against a controller nothing ever calls.
//
// Pinned here:
//   A. a queued item HOLDS while a prompt is pending;
//   B. it flows on resolve-with-answers (the PostToolUse shape);
//   C. it flows on resolve-with-NULL too — the Stop / dismiss-timeout /
//      pty-exit shape, three of the four resolution paths;
//   D. a superseding detect (same task, new toolUseId) replaces the key rather
//      than leaking the old one, and a resolution mirrors main's single slot;
//   E. the Enter-retry ladder refuses a nudge while a prompt is pending —
//      the ONE guard that has to hold even with no queued item at all.
//
// Fixture provenance: the `questions` payload is ADAPTED from
// option-prompt-parse.mjs (the measured claude 2.1.178 PreToolUse `tool_input`
// shape), trimmed to one question; the `answers` object is COMPOSED to the
// documented PostToolUse `tool_response.answers` shape. The controller reads
// only `toolUseId` from either, so they are shape-honesty, not inputs.
const require = createRequire(import.meta.url);
const { DeliveryController } = require("../../dist/runtime");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];

function makeHost(overrides = {}) {
  const state = {
    activeRun: false,
    approval: false,
    accepts: true,
    submits: [],
    nudges: 0,
    ...overrides,
  };
  return {
    state,
    hasActiveRun: () => state.activeRun,
    activeRunId: () => (state.activeRun ? "run-stub" : null),
    isApprovalActive: () => state.approval,
    hasPendingControlSwitch: () => false,
    isRewindPanelOpen: () => false,
    acceptsPromptInput: () => state.accepts,
    // `acceptsFirstPrompt` is the BOOT-LATCH question (SL-6) — stricter than
    // `acceptsPromptInput` for codex, identical for claude and for any host whose
    // readiness is what the test is varying. Mirroring it here keeps this stub a
    // faithful stand-in instead of a host that latches on rules the real one
    // dropped.
    acceptsFirstPrompt: () => state.accepts,
    isHumanActivelyTyping: () => false,
    submitPrompt: (text, opts) => {
      state.submits.push({ text, opts });
      return {
        taskId: "t",
        runId: `r${state.submits.length}`,
        kind: "prompt",
        submittedAt: new Date().toISOString(),
      };
    },
    // Mirrors TerminalHost.nudgePromptSubmit; records the attempt so a refusal
    // is distinguishable from a nudge that merely failed at the host.
    nudgePromptSubmit: () => {
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
    // No PTY-echo receipt: a delivered item stays in flight awaiting a
    // transcript block, which is what keeps the Enter-retry ladder live in E.
    hasLiveTranscriptSource: () => true,
    pumpRetryIntervalMs: 20,
    // The gate is under test, not the boot-init grace or the ladder's timings.
    bootDeliveryGraceMs: 0,
    enterRetryDelaysMs: [],
    ...options,
  });
}

const detected = (toolUseId) => ({
  type: "option-prompt:detected",
  payload: {
    taskId: "t",
    toolUseId,
    questions: [
      {
        question: "Which fruit?",
        header: "Fruit",
        multiSelect: false,
        options: [
          { label: "Banana", description: "a tropical fruit" },
          { label: "Cherry", description: "a stone fruit" },
        ],
      },
    ],
  },
  ts: new Date().toISOString(),
});
const resolved = (toolUseId, answers) => ({
  type: "option-prompt:resolved",
  payload: { taskId: "t", toolUseId, answers },
  ts: new Date().toISOString(),
});
const ANSWERS = { "Which fruit?": ["Banana"] };

// A — the hold. Across several retry intervals: the poll must not walk the item
// past a gate that is still shut.
await check("a pending option-prompt holds the queue (never a paste into the form)", async () => {
  const host = makeHost();
  const dc = makeController(host);
  try {
    dc.handleRuntimeEvent(detected("toolu_01hold"));
    dc.enqueue("this must not answer the open question");
    assert.equal(host.state.submits.length, 0, "no delivery while a prompt is pending");
    assert.equal(dc.state().deliverable, false, "canDeliver() reads false under the form");
    await delay(80); // several pump-retry intervals — still open, still nothing
    assert.equal(host.state.submits.length, 0, "stays queued while the form is open");
    assert.equal(dc.state().queue[0]?.status, "queued", "and stays visibly queued, not undelivered");
  } finally {
    dc.dispose();
  }
});

// B — the answered resolution (PostToolUse). Synchronous on the event, like
// approval:decision: the held item must not wait out a poll interval.
await check("resolve-with-answers releases the gate immediately", async () => {
  const host = makeHost();
  const dc = makeController(host);
  try {
    dc.handleRuntimeEvent(detected("toolu_01answered"));
    dc.enqueue("deliver me once the question is answered");
    assert.equal(host.state.submits.length, 0, "blocked while pending");
    dc.handleRuntimeEvent(resolved("toolu_01answered", ANSWERS));
    assert.equal(host.state.submits.length, 1, "the resolution re-pumps synchronously (no poll wait)");
  } finally {
    dc.dispose();
  }
});

// C — the OTHER three resolution paths all carry `answers: null` (a Stop with
// the form still open, the dismiss window's local clear, PTY death). A gate that
// released only on a real answer would wedge the queue on every one of them —
// and two of the three are the ordinary way a question ends unanswered.
await check("resolve-with-null releases the gate too (Stop / dismiss / pty-exit)", async () => {
  const host = makeHost();
  const dc = makeController(host);
  try {
    dc.handleRuntimeEvent(detected("toolu_01cleared"));
    dc.enqueue("deliver me once the question is cleared unanswered");
    assert.equal(host.state.submits.length, 0, "blocked while pending");
    dc.handleRuntimeEvent(resolved("toolu_01cleared", null));
    assert.equal(host.state.submits.length, 1, "a null resolution is still a resolution");
  } finally {
    dc.dispose();
  }
});

// D — supersede. The model can raise a second question while the first is on
// screen; main's `pendingOptionPrompt` is a single slot a newer PreToolUse
// overwrites, and NO resolution is guaranteed for the one it displaced. Keyed
// per toolUseId, that displaced key would gate forever — an invisible hold with
// no event left that could ever clear it.
await check("a superseding detect replaces the key instead of leaking it", async () => {
  const host = makeHost();
  const dc = makeController(host);
  try {
    dc.handleRuntimeEvent(detected("toolu_01first"));
    dc.handleRuntimeEvent(detected("toolu_02second")); // supersedes; the first never resolves
    dc.enqueue("deliver me once the SECOND question resolves");
    assert.equal(host.state.submits.length, 0, "the live (second) form still gates");
    dc.handleRuntimeEvent(resolved("toolu_02second", ANSWERS));
    assert.equal(host.state.submits.length, 1, "resolving the live form releases — nothing left behind");
  } finally {
    dc.dispose();
  }
});

// D2 — the deliberate mirror, pinned so it can only change on purpose: a
// resolution clears the slot whatever toolUseId it names. Every emitter of
// `option-prompt:resolved` nulls main's `pendingOptionPrompt` in the same breath
// (RuntimeController.resolveOptionPrompt is the single funnel), so after ANY
// resolution main believes no form is open — and a gate held past that point
// would be held over a form nothing can resolve, report, or answer.
await check("a resolution mirrors main's slot exactly (no id-guarded hold)", async () => {
  const host = makeHost();
  const dc = makeController(host);
  try {
    dc.handleRuntimeEvent(detected("toolu_01first"));
    dc.handleRuntimeEvent(detected("toolu_02second"));
    dc.enqueue("deliver me when main says no form is open");
    dc.handleRuntimeEvent(resolved("toolu_01first", null)); // names the displaced id
    assert.equal(
      host.state.submits.length,
      1,
      "the gate follows main's single slot rather than out-living it",
    );
  } finally {
    dc.dispose();
  }
});

// E — the Enter-retry ladder. This is the guard that matters with an EMPTY
// queue: a rung fires for an already-delivered item whose receipt is late, and
// its Enter would land on whatever owns the composer now. If the model raced a
// question onto the screen after the submit, that Enter picks its highlighted
// option row. Rung 0 must refuse; a later rung must still heal once the form is
// gone (the guard is a skip, never a cancellation).
await check("the Enter-retry ladder refuses a nudge while a prompt is pending", async () => {
  const host = makeHost();
  const dc = makeController(host, { enterRetryDelaysMs: [40, 120], attachmentWorstCaseMs: 0 });
  try {
    dc.enqueue("a send whose receipt is late");
    assert.equal(host.state.submits.length, 1, "the send went out before the question appeared");
    dc.handleRuntimeEvent(detected("toolu_01raced")); // the model races a form onto the screen
    await delay(80); // rung 0 has fired by now
    assert.equal(host.state.nudges, 0, "rung 0 refused: an Enter here would answer the question");
    dc.handleRuntimeEvent(resolved("toolu_01raced", ANSWERS));
    await delay(100); // rung 1 fires with the screen clear again
    assert.equal(host.state.nudges, 1, "the ladder still heals once the form is gone");
  } finally {
    dc.dispose();
  }
});

if (failures.length > 0) {
  process.exitCode = 1;
}

console.log(
  JSON.stringify({ smoke: "delivery-option-prompt-gate", failures, success: failures.length === 0 }, null, 2),
);

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
