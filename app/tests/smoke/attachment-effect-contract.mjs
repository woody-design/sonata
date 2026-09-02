import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Fences the attachment timing contract (consolidation S5): an attachment send
// returns from submitPrompt synchronously, but its submit Enter fires up to
// ~1.65s later inside the effect-verified paste sequence. Two guarantees:
//   1. The startup margin assert — the first Enter-retry rung MUST stay above
//      the attachment worst case, or a heal nudge could fire mid-paste. A
//      violating config throws loud at construction.
//   2. The effect epoch re-stamp — delivery re-arms the receipt timeout AND the
//      heal ladder from the real Enter (the PromptSubmission.effect signal), not
//      the lying write time.
// Fake host, injected timings (tens of ms), no real CLI.
const require = createRequire(import.meta.url);
const { DeliveryController } = require("../../dist/runtime");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];

const imageAttachment = {
  id: "effect-contract-img-1",
  path: "/tmp/sonata-effect-contract/shot.png",
  originalName: "shot.png",
  mediaType: "image/png",
  size: 42,
  provenance: "referenced",
  kind: "image",
};

function fakeHost() {
  const host = {
    // ms from submitPrompt() to the attachment sequence's Enter (the effect).
    effectDelayMs: 0,
    nudges: 0,
    submissions: [],
    hasActiveRun: () => false,
    activeRunId: () => null,
    isApprovalActive: () => false,
    hasPendingControlSwitch: () => false,
    isRewindPanelOpen: () => false,
    acceptsPromptInput: () => true,
    // `acceptsFirstPrompt` is the BOOT-LATCH question (SL-6) — stricter than
    // `acceptsPromptInput` for codex, identical for claude and for any host whose
    // readiness is what the test is varying. Mirroring it here keeps this stub a
    // faithful stand-in instead of a host that latches on rules the real one
    // dropped.
    acceptsFirstPrompt: () => true,
    isHumanActivelyTyping: () => false,
    nudgePromptSubmit: () => {
      host.nudges += 1;
      return true;
    },
    submitPrompt: (text, opts = {}) => {
      host.submissions.push({ text, opts });
      const submission = {
        taskId: "t",
        runId: `r${host.submissions.length}`,
        kind: "prompt",
        submittedAt: new Date().toISOString(),
      };
      // Only an attachment send carries an effect signal — mirrors TerminalHost.
      if ((opts.attachments ?? []).length > 0) {
        submission.effect = new Promise((resolve) => {
          setTimeout(() => resolve(new Date().toISOString()), host.effectDelayMs);
        });
      }
      return submission;
    },
  };
  return host;
}

const statusOf = (dc, itemId) => dc.state().queue.find((entry) => entry.id === itemId)?.status;

// --- MARGIN 1: a sub-worst-case first rung throws loud at construction --------
await check("margin assert: a first Enter-retry rung below the real attachment worst-case throws", () => {
  // No attachmentWorstCaseMs override → the assert uses the real
  // ATTACHMENT_SUBMIT_WORST_CASE_MS (~1645ms). A 1000ms first rung violates it.
  assert.throws(
    () =>
      new DeliveryController({
        taskId: "t",
        provider: "claude",
        terminalHost: fakeHost(),
        eventSink: () => {},
        hasLiveTranscriptSource: () => true,
        enterRetryDelaysMs: [1000],
      }),
    /Attachment submit worst-case/,
    "a first rung below the attachment worst-case must fail loud at construction",
  );

  // The production default ladder ([2500, 6000]) constructs cleanly.
  const compliant = new DeliveryController({
    taskId: "t",
    provider: "claude",
    terminalHost: fakeHost(),
    eventSink: () => {},
    hasLiveTranscriptSource: () => true,
    enterRetryDelaysMs: [2500, 6000],
  });
  compliant.dispose();

  // A disabled ladder ([]) has no first rung → the margin is vacuously satisfied.
  const disabled = new DeliveryController({
    taskId: "t",
    provider: "claude",
    terminalHost: fakeHost(),
    eventSink: () => {},
    hasLiveTranscriptSource: () => true,
    enterRetryDelaysMs: [],
  });
  disabled.dispose();
});

// --- EFFECT 1: the receipt timeout is re-armed from the Enter, not the write --
await check("effect epoch: the receipt timeout runs from the attachment Enter, not the write time", async () => {
  const host = fakeHost();
  host.effectDelayMs = 200; // Enter fires 200ms after submitPrompt returned
  const dc = new DeliveryController({
    taskId: "t",
    provider: "claude",
    terminalHost: host,
    eventSink: () => {},
    hasLiveTranscriptSource: () => true, // attachment send → no PTY echo; awaits receipt
    bootDeliveryGraceMs: 0,
    enterRetryDelaysMs: [], // ladder off → margin assert vacuous, isolate the receipt timer
    receiptTimeoutMs: 300,
  });
  const item = dc.enqueue("look at this", [imageAttachment]);
  assert.equal(host.submissions.length, 1, "the attachment send reached the host");

  // Armed from WRITE, the 300ms timeout would undeliver at ~300ms. The effect at
  // 200ms re-arms it → undelivered only at 200+300 = ~500ms.
  await delay(380);
  assert.equal(
    statusOf(dc, item.id),
    "delivering",
    "still delivering at 380ms — the receipt timer was re-armed from the effect epoch, not write time",
  );
  await delay(220); // ~600ms total, past the effect-epoch timeout (200+300)
  assert.equal(
    statusOf(dc, item.id),
    "undelivered",
    "undelivered once the effect-epoch receipt timeout elapses",
  );
  dc.dispose();
});

// --- EFFECT 2: the Enter-retry ladder is re-armed from the Enter, not write ----
await check("effect epoch: the Enter-retry ladder runs from the attachment Enter, not the write time", async () => {
  const host = fakeHost();
  host.effectDelayMs = 100; // Enter fires 100ms after submitPrompt returned
  const dc = new DeliveryController({
    taskId: "t",
    provider: "claude",
    terminalHost: host,
    eventSink: () => {},
    hasLiveTranscriptSource: () => true,
    bootDeliveryGraceMs: 0,
    enterRetryDelaysMs: [200],
    receiptTimeoutMs: 5000,
    // In-test worst case (no attachments modelled beyond the effect timing) so a
    // small ladder is admissible; the margin math is proven separately above.
    attachmentWorstCaseMs: 50,
  });
  dc.enqueue("look at this too", [imageAttachment]);

  // Armed from WRITE, rung 0 (200ms) would nudge at ~200ms. The effect at 100ms
  // clears that stale rung and re-arms → the rung fires at 100+200 = ~300ms.
  await delay(250);
  assert.equal(
    host.nudges,
    0,
    "no nudge at 250ms — the write-time rung was cleared and re-armed from the effect (100+200=300)",
  );
  await delay(130); // ~380ms, past the effect-epoch rung
  assert.equal(host.nudges, 1, "exactly one nudge, at the effect-epoch rung (~300ms)");
  dc.dispose();
});

if (failures.length > 0) {
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ smoke: "attachment-effect-contract", success: true }, null, 2));
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
