import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Delivery RED LINE (consolidation S2): a queued item must NEVER paste text +
// Enter while a mid-session control switch is in flight. A parked codex Full
// Access consent dialog (`waiting-user`, no timeout by design) sits open with
// its default row on "Yes, continue anyway" — a delivery into it silently
// grants full access. "Never auto-answer a consent" is the program's hard red
// line, so ALL THREE backend write paths refuse while a switch is pending:
//   Part A (delivery layer): canDeliver() gates on hasPendingControlSwitch and
//     a blocked item re-pumps the instant the switch clears — via the settled
//     `control-switch:state` event AND via the 500ms poll backstop.
//   Part B (terminal-host): submitPrompt() throws and nudgePromptSubmit()
//     refuses while a REAL driven switch is pending.
const require = createRequire(import.meta.url);
const { DeliveryController, TerminalHost } = require("../../dist/runtime");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];

// --- Part A: the delivery gate + re-pump ------------------------------------

function makeHost(overrides = {}) {
  const state = {
    activeRun: false,
    approval: false,
    pendingControlSwitch: false,
    accepts: true,
    submits: [],
    ...overrides,
  };
  return {
    state,
    hasActiveRun: () => state.activeRun,
    isApprovalActive: () => state.approval,
    hasPendingControlSwitch: () => state.pendingControlSwitch,
    isRewindPanelOpen: () => state.rewindPanelOpen ?? false,
    acceptsPromptInput: () => state.accepts,
    submitPrompt: (text, opts) => {
      state.submits.push({ text, opts });
      return {
        taskId: "t",
        runId: `r${state.submits.length}`,
        kind: text.trim().startsWith("/") ? "slash" : "prompt",
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
    // The gate is under test, not the boot-init grace or the Enter-retry ladder.
    bootDeliveryGraceMs: 0,
    enterRetryDelaysMs: [],
  });
}

// A.1 — a pending/parked switch holds the queue, across retry intervals.
await check("parked control switch blocks delivery (never into the consent dialog)", async () => {
  const host = makeHost({ pendingControlSwitch: true });
  const dc = makeController(host);
  try {
    dc.enqueue("this must not answer the parked consent");
    assert.equal(host.state.submits.length, 0, "no delivery while a switch is pending");
    await delay(80); // several retry intervals — still parked, still nothing
    assert.equal(host.state.submits.length, 0, "stays queued while the switch is parked");
  } finally {
    dc.dispose();
  }
});

// A.2 — the poll backstop: the switch clears with NO runtime event.
await check("blocked item re-pumps via the 500ms poll when the switch clears without an event", async () => {
  const host = makeHost({ pendingControlSwitch: true });
  const dc = makeController(host);
  try {
    dc.enqueue("deliver me once the switch clears");
    assert.equal(host.state.submits.length, 0, "blocked while pending");
    host.state.pendingControlSwitch = false; // switch resolved — NO event fired
    await delay(120); // the re-pump poll must catch the rising edge
    assert.equal(host.state.submits.length, 1, "poll re-pump delivers after the switch clears");
  } finally {
    dc.dispose();
  }
});

// A.3 — the event path: resolution emits a settled `control-switch:state` after
// clearing the pointer, exactly as the terminal-host does; it re-pumps at once
// (mirrors the approval:decision re-pump), no poll interval waited.
await check("settled control-switch:state event re-pumps immediately (mirrors approval:decision)", async () => {
  const host = makeHost({ pendingControlSwitch: true });
  const dc = makeController(host);
  try {
    dc.enqueue("deliver on the settle event");
    assert.equal(host.state.submits.length, 0, "blocked while pending");
    // Resolution order matches the host: clear the pointer, THEN emit the event.
    host.state.pendingControlSwitch = false;
    dc.handleRuntimeEvent({
      type: "control-switch:state",
      payload: { taskId: "t", kind: "codex-permission", value: "full-access", phase: "settled" },
      ts: new Date().toISOString(),
    });
    assert.equal(host.state.submits.length, 1, "settled event re-pumps synchronously (no poll wait)");
  } finally {
    dc.dispose();
  }
});

// A.4 — a needs-attention resolution (the RED-LINE outcome: switch surfaced to
// the user, nothing auto-answered) also releases the gate.
await check("needs-attention control-switch:state event releases the gate", async () => {
  const host = makeHost({ pendingControlSwitch: true });
  const dc = makeController(host);
  try {
    dc.enqueue("deliver after the switch bailed to needs-attention");
    host.state.pendingControlSwitch = false;
    dc.handleRuntimeEvent({
      type: "control-switch:state",
      payload: { taskId: "t", kind: "permission", value: "plan", phase: "needs-attention", reason: "consent" },
      ts: new Date().toISOString(),
    });
    assert.equal(host.state.submits.length, 1, "the gate reopens once the switch is no longer pending");
  } finally {
    dc.dispose();
  }
});

// A.5 — the SAME gate shape for claude's Rewind panel (upstream sync
// 2026-08-03, claude ≥2.1.216). An Esc pair at an idle composer opens a restore
// picker whose `Enter to continue` REWRITES the conversation (and possibly the
// code) back to the highlighted row, so a delivery into it is the same class of
// red line as the parked consent: pasted text plus Enter answers a modal nobody
// meant to answer. It is a deliberate, narrow exception to S3 decision A (a
// user-opened panel does not hold delivery) — that decision rests on the paste
// being recoverable, which a restore is not — and the exception is paid for by
// surfacing the hold (`rewindPanelOpen` → the composer status line).
await check("an open claude Rewind panel blocks delivery (its Enter is a RESTORE)", async () => {
  const host = makeHost({ rewindPanelOpen: true });
  const dc = makeController(host);
  try {
    dc.enqueue("this must not land on the rewind picker");
    await delay(80); // several retry intervals — still open, still nothing
    assert.equal(host.state.submits.length, 0, "stays queued while the panel is open");

    // No event announces the dismissal (one Esc in the co-visible terminal just
    // repaints the composer), so the 500ms poll backstop is the ONLY way out —
    // exactly the wedge risk decision A warns about, and why it must be proven.
    host.state.rewindPanelOpen = false;
    await delay(120);
    assert.equal(host.state.submits.length, 1, "poll re-pump delivers once the panel closes");
  } finally {
    dc.dispose();
  }
});

// --- Part B: the terminal-host write-path backstops -------------------------
// Drive a REAL claude model switch against a fake pty (the stop-interrupt seam)
// so pendingControlSwitch is set by the production path, then prove both
// remaining write paths refuse.

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

await check("real pending switch: submitPrompt throws and nudgePromptSubmit refuses", async () => {
  const writes = [];
  const host = new TerminalHost({
    taskId: "delivery-control-switch-gate-smoke",
    provider: "claude",
    defaultWorkspace: process.cwd(),
    eventSink: () => {},
  });
  try {
    host.ptyProcess = fakePty(writes);
    const response = host.injectClaudeControlSwitch("model", "opus");
    assert.equal(response.ok, true, "the model switch started");
    assert.equal(host.hasPendingControlSwitch(), true, "a switch is now pending");

    // Let the deferred command `\r` fire so sonataWriting clears — after this the
    // ONLY thing gating the write paths is pendingControlSwitch.
    await delay(160);
    assert.equal(host.hasPendingControlSwitch(), true, "switch still pending (no receipt arrived)");

    assert.throws(
      () => host.submitPrompt("must not submit over a pending switch"),
      /control switch is pending/,
      "submitPrompt refuses while a switch is pending",
    );
    assert.equal(
      host.nudgePromptSubmit(),
      false,
      "the Enter-retry nudge refuses while a switch is pending",
    );
  } finally {
    host.dispose();
  }
});

// --- Part C: the LITERAL red-line surface — a parked codex Full Access consent
// (S2 review OPTIONAL). Drive a REAL codex-permission switch through the picker to
// the PARKED consent dialog (`waiting-user`, NO timeout by design — its default
// row is "Yes, continue anyway"), then prove BOTH the delivery gate and the
// submitPrompt backstop refuse there: a paste + Enter into it would silently grant
// unrestricted access.

const PICKER_FOOTER = "Press enter to confirm or esc to go back";
const pickerFrame = (cursorRow) => {
  const rows = ["1. Ask for approval (current)", "2. Approve for me", "3. Full Access"];
  rows[cursorRow - 1] = `› ${rows[cursorRow - 1]}`;
  return `Update Model Permissions ${rows.join(" ")} ${PICKER_FOOTER}`;
};
// Two measured rows at codex 0.146.0 (`Yes, and don't ask again` deleted
// upstream). The relay detects this dialog on the reconstructed SCREEN, not the
// pty tail, so the frame below is fed to BOTH channels via the stub screen model.
const CONSENT_FRAME = "Enable full access? › 1. Yes, continue anyway   2. Cancel";

/** A stand-in for the per-task `TaskScreenModel` (the real one is an @xterm grid;
 *  this test drives a FAKE pty, so `startTask` never built one). The engine's
 *  spatial queries only need the frame just written to be readable back, which is
 *  exactly what the real grid gives them for a whole-frame write. */
function stubScreenModel() {
  let screen = "";
  return {
    write: (data) => {
      screen = data;
    },
    whenSettled: (fn) => fn(),
    viewportText: () => screen,
    resize: () => {},
    dispose: () => {},
  };
}

await check("real parked codex consent blocks delivery AND submitPrompt (the red-line surface)", async () => {
  const writes = [];
  const switchEvents = [];
  const host = new TerminalHost({
    taskId: "delivery-control-switch-gate-codex",
    provider: "codex",
    defaultWorkspace: process.cwd(),
    eventSink: (event) => {
      if (event.type === "control-switch:state") {
        switchEvents.push(event.payload);
      }
    },
  });
  try {
    host.ptyProcess = fakePty(writes);
    host.screenModel = stubScreenModel();
    const response = host.injectClaudeControlSwitch(
      "codex-permission",
      "full-access",
      "ask-for-approval",
    );
    assert.equal(response.ok, true, "the codex permission switch started");
    await delay(160); // let the deferred `/permissions` Enter fire

    // Drive the picker → Full Access → the consent dialog through the real pty path.
    host.handlePtyData(pickerFrame(1));
    host.handlePtyData(pickerFrame(2));
    host.handlePtyData(pickerFrame(3));
    host.handlePtyData(CONSENT_FRAME);
    assert.equal(
      switchEvents.at(-1)?.phase,
      "parked",
      "the relay really PARKED on the consent (not merely pending) — the gate's premise",
    );
    assert.equal(host.hasPendingControlSwitch(), true, "the switch is PARKED on the consent");

    // The delivery gate: a queued item must NOT paste into the parked consent. Use
    // a proxy that forces readiness so the ONLY possible blocker is the parked
    // switch (isolating the gate under test from the boot latch).
    const submits = [];
    const proxy = {
      hasActiveRun: () => false,
      isApprovalActive: () => false,
      hasPendingControlSwitch: () => host.hasPendingControlSwitch(),
      isRewindPanelOpen: () => false,
      acceptsPromptInput: () => true,
      submitPrompt: (text, opts) => {
        submits.push({ text, opts });
        return {
          taskId: "t",
          runId: `r${submits.length}`,
          kind: "prompt",
          submittedAt: new Date(1700000000000).toISOString(),
        };
      },
    };
    const dc = makeController(proxy);
    try {
      dc.enqueue("this must not answer the parked Full Access consent");
      await delay(80); // several retry intervals
      assert.equal(submits.length, 0, "delivery stays blocked while the consent is parked");
    } finally {
      dc.dispose();
    }

    // The submitPrompt + nudge backstops refuse at the parked surface too.
    assert.throws(
      () => host.submitPrompt("must not submit over the parked consent"),
      /control switch is pending/,
      "submitPrompt refuses at the parked consent",
    );
    assert.equal(host.nudgePromptSubmit(), false, "the Enter-retry nudge refuses at the parked consent");
  } finally {
    host.dispose();
  }
});

if (failures.length > 0) {
  process.exitCode = 1;
}

console.log(JSON.stringify({ smoke: "delivery-control-switch-gate", success: failures.length === 0 }, null, 2));

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
