import assert from "node:assert/strict";
import { createRequire } from "node:module";

// ControlSwitchEngine unit tests (consolidation S4). The engine is now
// constructable on a fake ControlSwitchHost, so its axis state machines are
// testable at the pure-logic level without a live PTY. Covers the two folded
// behaviour fixes whose edge paths the real-CLI smokes cannot reach here:
//   3a — Shift+Tab expected-landing validation (review F3): a stale pre-press
//        frame must NOT be read as the step's receipt (the double-press bug).
//   3b — parked codex-consent scan lifecycle (review F2): a native Esc must be
//        detectable post-park, and the drawer answer drives off the parked frame.
const require = createRequire(import.meta.url);
const {
  ControlSwitchEngine,
  expectedPermissionLandings,
  CLAUDE_PERMISSION_CYCLE,
} = require("../../dist/runtime");

const failures = [];

/** A fake ControlSwitchHost: records every pty write + emitted event, fires the
 *  deferred write synchronously (deterministic), and exposes mutable idle flags. */
function makeHost(provider) {
  const writes = [];
  const events = [];
  const flags = { pty: true, approval: false, activeRun: false, sonataWriting: false };
  const host = {
    writes,
    events,
    flags,
    taskId: "engine-smoke",
    provider,
    hasPty: () => flags.pty,
    writePty: (data) => writes.push(data),
    isApprovalActive: () => flags.approval,
    hasActiveRun: () => flags.activeRun,
    isSonataWriting: () => flags.sonataWriting,
    beginSonataWrite: () => {},
    endSonataWrite: () => {},
    deferSonataWrite: (_ms, fn) => fn(),
    clearComposerBeforeTypedCommand: () => {},
    emitControlSwitchEvent: (payload) => events.push(payload),
  };
  return host;
}

const phasesOf = (events) => events.map((e) => e.phase);
const lastEvent = (events) => events[events.length - 1];

// ── 3a pure logic: the cycle-successor table ────────────────────────────────
await check("expectedPermissionLandings: each cycle step maps to its successor", () => {
  assert.deepEqual([...expectedPermissionLandings("default")], ["acceptEdits"]);
  assert.deepEqual([...expectedPermissionLandings("acceptEdits")], ["plan"]);
  // plan may land on auto OR wrap to default when account-gated auto is absent.
  assert.deepEqual(new Set(expectedPermissionLandings("plan")), new Set(["auto", "default"]));
  assert.deepEqual([...expectedPermissionLandings("auto")], ["default"]);
  // Off-cycle origins (bypassPermissions/dontAsk) accept any cycle member.
  assert.deepEqual(
    new Set(expectedPermissionLandings("bypassPermissions")),
    new Set(CLAUDE_PERMISSION_CYCLE),
  );
});

// ── 3a engine: a stale pre-press frame must not double-press ────────────────
const MODE = {
  default: "⏸ manual mode on",
  acceptEdits: "⏵⏵ accept edits on",
  plan: "⏸ plan mode on",
  auto: "⏵⏵ auto mode on",
};

await check("3a: a stale pre-press mode line is ignored (no double-press)", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    const res = engine.injectClaudeControlSwitch("permission", "plan", "default");
    assert.equal(res.ok, true, "the permission switch started");
    assert.equal(host.writes.length, 1, "exactly one Shift+Tab written for the first step");

    // A STALE pre-press repaint of the mode we pressed FROM (default). The old
    // engine read this as 'landed on default', decided default != plan, and
    // pressed AGAIN — the double-press. The fix waits for a real landing.
    engine.ingest(MODE.default);
    assert.equal(host.writes.length, 1, "stale pre-press frame does NOT press again");
    assert.equal(host.events.length, 1, "no settle/attention yet (still one pending event)");

    // The real landing of the first press: accept edits (the cycle successor).
    engine.ingest(MODE.acceptEdits);
    assert.equal(host.writes.length, 2, "the validated landing advances one step");

    // Land on plan (the target) — settle.
    engine.ingest(MODE.plan);
    assert.equal(host.writes.length, 2, "no further press once the target lands");
    assert.equal(lastEvent(host.events).phase, "settled", "the switch settles on the target");
    assert.equal(lastEvent(host.events).value, "plan");
  } finally {
    engine.clear();
  }
});

await check("3a: an unexpected landing fails loud (never read as the receipt)", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    engine.injectClaudeControlSwitch("permission", "acceptEdits", "default");
    assert.equal(host.writes.length, 1, "first Shift+Tab written");
    // From default, a single press can only reach acceptEdits — a frame showing
    // `auto` is an unexpected screen (a skipped step / stale far frame). It must
    // NOT settle even though... it is not the target here anyway; the point is it
    // is not read as this step's landing. The engine flips to return-home.
    engine.ingest(MODE.auto);
    assert.ok(
      !phasesOf(host.events).includes("settled"),
      "an unexpected landing never settles the switch",
    );
    assert.equal(host.writes.length, 2, "fail-loud return-home presses toward origin (never blind-settle)");
  } finally {
    engine.clear();
  }
});

// ── 3b: parked codex-consent lifecycle ──────────────────────────────────────
const PICKER_FOOTER = "Press enter to confirm or esc to go back";
const pickerFrame = (cursorRow) => {
  const rows = ["1. Ask for approval (current)", "2. Approve for me", "3. Full Access"];
  rows[cursorRow - 1] = `› ${rows[cursorRow - 1]}`;
  return `Update Model Permissions ${rows.join(" ")} ${PICKER_FOOTER}`;
};
const CONSENT_FRAME =
  "Enable full access? › 1. Yes, continue anyway 2. Yes, and don't ask again 3. Cancel";
const GRANT_RECEIPT = "• Permissions updated to Full Access";
const COMPOSER_FRAME = "❯ ready for input";

/** Drive a fresh codex-permission switch through the picker to the PARKED
 *  Full Access consent, returning { host, engine }. */
function driveToParkedConsent() {
  const host = makeHost("codex");
  const engine = new ControlSwitchEngine(host);
  const res = engine.injectClaudeControlSwitch("codex-permission", "full-access", "ask-for-approval");
  assert.equal(res.ok, true, "codex permission switch started");
  engine.ingest(pickerFrame(1)); // picker opens, cursor on Ask
  engine.ingest(pickerFrame(2)); // arrow landed on Approve
  engine.ingest(pickerFrame(3)); // arrow landed on Full Access → Enter → confirming
  engine.ingest(CONSENT_FRAME); // Full Access consent → PARK
  assert.equal(lastEvent(host.events).phase, "parked", "the consent dialog parks the relay");
  return { host, engine };
}

await check("3b: a native Esc after park is detected (relay does not park forever)", () => {
  const { host, engine } = driveToParkedConsent();
  try {
    const escBefore = host.writes.filter((w) => w === "").length;
    // The user natively Esc'd the consent in the terminal: the consent is gone and
    // the /permissions picker is back. With the retained-scan bug the stale consent
    // text lingered in the rolling window, so `!consentOpen` never held and the
    // relay parked forever. The park-time scan reset lets this fresh frame register.
    engine.ingest(pickerFrame(3)); // consent gone, picker footer back
    const escAfter = host.writes.filter((w) => w === "").length;
    assert.ok(escAfter > escBefore, "native-cancel detection fires an Esc to exit the picker");

    // The composer returns → the relay settles CANCELLED (nothing granted).
    engine.ingest(COMPOSER_FRAME);
    const settled = lastEvent(host.events);
    assert.equal(settled.phase, "settled", "the relay settles after a native cancel");
    assert.equal(settled.cancelled, true, "a native cancel grants nothing (cancelled flag set)");
  } finally {
    engine.clear();
  }
});

await check("3b: the drawer answer reads the cursor from the parked frame", () => {
  const { host, engine } = driveToParkedConsent();
  try {
    const writesBefore = host.writes.length;
    // The user chose row 1 (Yes, continue anyway) in the drawer. The parked dialog
    // is static — no fresh frame exists — so the first nav read MUST come from the
    // frame snapshotted at park time (its cursor is already on row 1 = the target),
    // and the engine confirms with Enter straightaway.
    engine.answerParkedControlConfirm(1);
    assert.ok(
      host.writes.slice(writesBefore).includes("\r"),
      "the confirm Enter is driven off the parked-frame cursor",
    );
    // The grant receipt lands on a fresh frame → the relay settles (not cancelled).
    engine.ingest(GRANT_RECEIPT);
    const settled = lastEvent(host.events);
    assert.equal(settled.phase, "settled", "the grant receipt settles the relay");
    assert.notEqual(settled.cancelled, true, "a granted Full Access is not cancelled");
  } finally {
    engine.clear();
  }
});

if (failures.length > 0) {
  process.exitCode = 1;
}
console.log(
  JSON.stringify({ smoke: "control-switch-engine", success: failures.length === 0 }, null, 2),
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
