import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Keyed approval gate (S6 review P1): the delivery gate tracks pending asks
// PER KEY — broker asks by approvalId, the scraped native panel by a
// sentinel. Locks the two failure shapes the boolean allowed:
//  A. Two concurrent broker asks — deciding the FIRST must NOT reopen the
//     gate while the second is still pending (the old gate delivered a
//     queued prompt in the decision→resurface window).
//  B. An EXPIRED ask keeps gating through the expiry→scrape gap even when a
//     DIFFERENT ask is decided meanwhile (the severe variant: the expired
//     ask's native panel is RENDERED — a reopened gate pastes into it,
//     digit-swallow). Ownership transfers to the scrape side: the panel's
//     own no-id decision releases it.
const require = createRequire(import.meta.url);
const { DeliveryController } = require("../../dist/runtime");

function makeHost() {
  const state = { activeRun: false, approval: false, accepts: true, submits: [] };
  return {
    state,
    hasActiveRun: () => state.activeRun,
    isApprovalActive: () => state.approval,
    acceptsPromptInput: () => state.accepts,
    submitPrompt: (text, opts) => {
      state.submits.push({ text, opts });
      return {
        taskId: "t",
        runId: `r${state.submits.length}`,
        kind: "prompt",
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

const detected = (approvalId) => ({
  type: "approval:detected",
  payload: { taskId: "t", runId: null, kind: "command", source: "hook-broker", approvalId },
  ts: "",
});
const decision = (approvalId) => ({
  type: "approval:decision",
  payload: {
    taskId: "t",
    runId: null,
    decision: "approve",
    encodedAs: approvalId ? "reply-file" : "native-keys",
    previousKind: "command",
    ...(approvalId ? { approvalId } : {}),
  },
  ts: "",
});
const expired = (approvalId) => ({
  type: "approval:expired",
  payload: { taskId: "t", approvalId },
  ts: "",
});

// --- A. concurrent broker asks: first decision must not reopen the gate ----
{
  const host = makeHost();
  const dc = makeController(host);
  dc.handleRuntimeEvent(detected("ask-1"));
  dc.handleRuntimeEvent(detected("ask-2"));
  dc.enqueue("queued while two asks pending");
  assert.equal(host.state.submits.length, 0, "gate closed under two asks");

  dc.handleRuntimeEvent(decision("ask-1"));
  assert.equal(host.state.submits.length, 0, "deciding ask-1 must NOT release ask-2's gate");

  dc.handleRuntimeEvent(decision("ask-2"));
  assert.equal(host.state.submits.length, 1, "gate opens once BOTH asks are decided");
  dc.dispose();
}

// --- B. expired ask gates through the gap; scrape decision transfers it ----
{
  const host = makeHost();
  const dc = makeController(host);
  dc.handleRuntimeEvent(detected("ask-1"));
  dc.handleRuntimeEvent(detected("ask-2"));
  dc.handleRuntimeEvent(expired("ask-2")); // broker gave up; native panel incoming
  dc.enqueue("queued during the expiry gap");
  assert.equal(host.state.submits.length, 0, "expired ask still gates");

  dc.handleRuntimeEvent(decision("ask-1"));
  assert.equal(
    host.state.submits.length,
    0,
    "deciding ask-1 must NOT release the expired ask-2 (rendered-panel paste = digit-swallow)",
  );

  // The native panel renders (scrape detects, no id) and the human answers
  // it natively (scrape decision, no id) — that panel IS the expired ask.
  dc.handleRuntimeEvent(detected(undefined));
  assert.equal(host.state.submits.length, 0, "rendered panel gates");
  dc.handleRuntimeEvent(decision(undefined));
  assert.equal(host.state.submits.length, 1, "the panel's own answer releases the expired ask");
  dc.dispose();
}

// --- C. scrape-only lifecycle unchanged (sentinel key) ----------------------
{
  const host = makeHost();
  const dc = makeController(host);
  dc.handleRuntimeEvent(detected(undefined));
  dc.enqueue("queued during a scrape panel");
  assert.equal(host.state.submits.length, 0, "scrape panel gates");
  dc.handleRuntimeEvent(decision(undefined));
  assert.equal(host.state.submits.length, 1, "scrape decision releases");
  dc.dispose();
}

console.log("approval-gate-keyed smoke: OK");
