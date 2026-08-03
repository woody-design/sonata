import assert from "node:assert/strict";
import { createRequire } from "node:module";

// ControlSwitchEngine unit tests (consolidation S4). The engine is now
// constructable on a fake ControlSwitchHost, so its axis state machines are
// testable at the pure-logic level without a live PTY. Covers the two folded
// behaviour fixes whose edge paths the real-CLI smokes cannot reach here:
//   3a — Shift+Tab expected-landing validation (review F3): a stale pre-press
//        frame must NOT be read as the step's receipt (the double-press bug).
//   3b — parked codex-consent lifecycle against codex 0.146.0 (upstream sync
//        SL-2): the dialog is detected from the GRID while the raw stream carries
//        only the cell-diff wreckage; Cancel (row 2) exits to the composer with NO
//        extra Esc; an unrecognized screen rolls back instead of guessing a row.
const require = createRequire(import.meta.url);
const {
  ControlSwitchEngine,
  expectedPermissionLandings,
  CLAUDE_PERMISSION_CYCLE,
} = require("../../dist/runtime");

const failures = [];

/**
 * A fake ControlSwitchHost: records every pty write + emitted event, fires the
 * deferred write synchronously (deterministic), exposes mutable idle flags, and
 * serves `readScreen` from a settable fixture viewport (`host.screen`).
 *
 * `readScreen` TIMING — the real host routes it through
 * `TaskScreenModel.whenSettled`, which runs synchronously only when no write is
 * in flight. That splits the call sites in two:
 *   - the DRAWER ANSWER (`answerParkedControlConfirm` → nav) is an IPC call with
 *     nothing pending, so it reads synchronously — the default fake below.
 *   - every INGEST-driven read defers: `handlePtyData` writes the batch to the
 *     screen model BEFORE handing it to the engine, and @xterm's WriteBuffer
 *     always parses on a later turn, so the callback lands after the ingest
 *     returns (and reads the grid as of the DRAIN, not the call).
 * `{ deferReads: true }` builds the second shape (`queueMicrotask`, reading
 * `host.screen` at drain time), which the interleaving case below uses to
 * exercise concurrent in-flight reads rather than merely arguing about them.
 */
function makeHost(provider, { deferReads = false } = {}) {
  const writes = [];
  const events = [];
  const flags = { pty: true, approval: false, activeRun: false, sonataWriting: false };
  const host = {
    writes,
    events,
    flags,
    /** The reconstructed viewport the engine's SPATIAL queries read. */
    screen: "",
    /** How many `readScreen` calls the engine has made (interleaving evidence). */
    reads: 0,
    taskId: "engine-smoke",
    provider,
    hasPty: () => flags.pty,
    writePty: (data) => writes.push(data),
    isApprovalActive: () => flags.approval,
    // Claude's Rewind panel is the second screen-owner refusal at the two switch
    // entry points (upstream sync 2026-08-03): a claude switch ends in a deferred
    // `\r`, which on that panel is `Enter to continue` — a RESTORE.
    isRewindPanelOpen: () => flags.rewindPanel ?? false,
    hasActiveRun: () => flags.activeRun,
    isSonataWriting: () => flags.sonataWriting,
    beginSonataWrite: () => {},
    endSonataWrite: () => {},
    deferSonataWrite: (_ms, fn) => fn(),
    clearComposerBeforeTypedCommand: () => {},
    readScreen: (fn) => {
      host.reads += 1;
      if (deferReads) {
        queueMicrotask(() => fn(host.screen));
        return;
      }
      fn(host.screen);
    },
    emitControlSwitchEvent: (payload) => events.push(payload),
  };
  return host;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// Screen-owner refusal at the switch ENTRY points (upstream sync 2026-08-03).
// Both claude entry points end in a deferred `\r`; on the Rewind panel that IS
// `Enter to continue`, a RESTORE. The panel is reachable independently of Sonata
// — the user presses Esc Esc in the CLI — so hitting Save on the model chip with
// it up must refuse, exactly as it does for a live approval screen.
await check("a claude switch refuses to start while the Rewind panel is open", () => {
  for (const start of [
    (engine) => engine.injectClaudeControlSwitch("permission", "plan", "default"),
    (engine) => engine.startClaudeStagedSwitch("opus", "high"),
  ]) {
    const host = makeHost("claude");
    const engine = new ControlSwitchEngine(host);
    try {
      host.flags.rewindPanel = true;
      const refused = start(engine);
      assert.equal(refused.ok, false, "the switch must not start");
      assert.equal(refused.reason, "panel-open", "same refusal class as a live approval screen");
      assert.equal(host.writes.length, 0, "and nothing was written into the panel");

      // Not a latch: dismissing the panel restores the entry point.
      host.flags.rewindPanel = false;
      assert.equal(start(engine).ok, true, "the switch starts once the panel closes");
    } finally {
      engine.clear();
    }
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

// ── 3b: parked codex-consent lifecycle (codex 0.146.0) ──────────────────────
//
// Frames are the MEASURED ones (spikes/upstream-sync-2026-08/codex,
// `out-q1-consent.frames.log`): the consent GRID has two rows, and at the very
// same instant the raw STREAM carries only the cell-diff wreckage — the picker
// already held those cells, so the `e` of "Enable", the `›` cursor and the row
// dot were never transmitted. The whole point of SL-2 is that the first is what
// the engine now reads and the second is what it used to read.
const ESC = "\x1b";
const ARROW_DOWN = "\x1b[B";
const PICKER_FOOTER = "Press enter to confirm or esc to go back";
const pickerFrame = (cursorRow) => {
  const rows = ["1. Ask for approval (current)", "2. Approve for me", "3. Full Access"];
  rows[cursorRow - 1] = `› ${rows[cursorRow - 1]}`;
  return `Update Model Permissions ${rows.join(" ")} ${PICKER_FOOTER}`;
};
const consentGrid = (cursorRow) =>
  "  Enable full access?\n" +
  "  When Codex runs with full access, it can edit any file on your computer and run commands with network.\n" +
  `${cursorRow === 1 ? "›" : " "} 1. Yes, continue anyway  Apply full access for this session\n` +
  `${cursorRow === 2 ? "›" : " "} 2. Cancel                Go back without enabling full access\n` +
  "\n" +
  `  ${PICKER_FOOTER}`;
// The SAME dialog as codex actually put on the wire (measured): unrecognizable.
const CONSENT_STREAM_CELL_DIFF =
  "Enablfull access?  When Codex runs with full access, it can edit any file on your computer" +
  "1Yes,continueanywayApplyfull acess for thiseson  2. Cancel                Go back without enabling full access";
// The grid after an ESC from the consent (measured): the IDLE COMPOSER.
const COMPOSER_GRID = "› Improve documentation in @filename\n\n  gpt-5.6-sol high · /tmp/ws";
// The grid after ENTER on the consent's Cancel row (measured @ after-cancel-enter):
// the /permissions picker is BACK and still open — the other exit, and the reason
// the relay identifies which one it got. Note the header renders intact HERE while
// the same instant's stream reads `UpdatModelPermissions` (the `e` elided).
const PICKER_GRID = `  ${pickerFrame(1).split(PICKER_FOOTER)[0].trim()}\n\n  ${PICKER_FOOTER}`;
const GRANT_RECEIPT = "• Permissions updated to Full Access";
/** A screen the choreography does not recognize at all (a foreign modal). */
const UNRECOGNIZED_GRID = "  Something else entirely?\n› 1. Sure\n  2. Nope\n\n  Press enter";

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
  // The consent paints: the GRID shows it, the STREAM shows the cell-diff mess.
  host.screen = consentGrid(1);
  engine.ingest(CONSENT_STREAM_CELL_DIFF); // → PARK
  assert.equal(lastEvent(host.events).phase, "parked", "the consent dialog parks the relay");
  return { host, engine };
}

await check("3b: the consent is detected from the GRID, never from the elided stream", () => {
  const host = makeHost("codex");
  const engine = new ControlSwitchEngine(host);
  try {
    engine.injectClaudeControlSwitch("codex-permission", "full-access", "ask-for-approval");
    engine.ingest(pickerFrame(1));
    engine.ingest(pickerFrame(2));
    engine.ingest(pickerFrame(3)); // Enter on Full Access → confirming
    // CONTROL: the same cell-diff bytes with NO consent on the grid must not park —
    // proving the park is driven by the screen, not by the stream text.
    host.screen = pickerFrame(3);
    engine.ingest(CONSENT_STREAM_CELL_DIFF);
    assert.ok(
      !phasesOf(host.events).includes("parked"),
      "the raw cell-diff stream alone never parks (it is unrecognizable — the 0.146.0 red line)",
    );
    // Now the grid shows the dialog: the SAME bytes park it.
    host.screen = consentGrid(1);
    engine.ingest(CONSENT_STREAM_CELL_DIFF);
    const parked = lastEvent(host.events);
    assert.equal(parked.phase, "parked", "the grid read parks the relay on the consent");
    assert.equal(parked.dialog, "codex-consent", "…as the codex-consent dialog");
    assert.ok(!host.writes.includes(ESC), "parking never Escs the dialog away (S7 red line)");
  } finally {
    engine.clear();
  }
});

await check("3b: a native answer after park is detected off the grid's ABSENCE", async () => {
  const { host, engine } = driveToParkedConsent();
  try {
    const writesBefore = host.writes.length;
    // The user natively Esc'd the consent in the terminal: 0.146.0 drops straight
    // to the idle composer. The STREAM still carries the consent's bytes forever,
    // so only the grid can see it go.
    host.screen = COMPOSER_GRID;
    engine.ingest("some repaint bytes");
    assert.deepEqual(
      host.writes.slice(writesBefore),
      [],
      "a native exit injects NOTHING — the human drove it and Sonata never Escs an unidentified screen",
    );
    await delay(1200); // the bounded exit beat (no grant receipt lands)
    const settled = lastEvent(host.events);
    assert.equal(settled.phase, "settled", "the relay settles after a native cancel");
    assert.equal(settled.cancelled, true, "a native cancel grants nothing (cancelled flag set)");
  } finally {
    engine.clear();
  }
});

await check("3b: a native Cancel leaves the picker open — the relay closes it (exactly one Esc)", async () => {
  const { host, engine } = driveToParkedConsent();
  try {
    const writesBefore = host.writes.length;
    // The user natively Enter'd `2. Cancel` in the terminal. MEASURED (0.146.0):
    // that does NOT reach the composer — it returns to the /permissions picker,
    // which stays OPEN and swallows whatever is typed next (a queued prompt would
    // paste into it and its Enter would confirm the highlighted row). Nothing else
    // closes it: clearPendingControlSwitch's Esc only covers the picker AXES, and
    // parking discarded the pending that carried `pickerOpen`.
    host.screen = PICKER_GRID;
    engine.ingest("picker repaint bytes");
    assert.deepEqual(
      host.writes.slice(writesBefore),
      [ESC],
      "exactly one Esc closes the picker the relay's own choreography opened",
    );
    // A second frame of the same screen must not press again (the phase moved on).
    engine.ingest("more picker bytes");
    assert.deepEqual(host.writes.slice(writesBefore), [ESC], "…and only once");
    await delay(1200);
    const settled = lastEvent(host.events);
    assert.equal(settled.phase, "settled", "the relay still settles cancelled after closing it");
    assert.equal(settled.cancelled, true, "nothing was granted");
  } finally {
    engine.clear();
  }
});

await check("3b: a native Esc (composer, no picker) writes NOTHING — the control case", async () => {
  const { host, engine } = driveToParkedConsent();
  try {
    const writesBefore = host.writes.length;
    // The consent's OTHER exit lands on the idle composer: there is nothing to
    // close, so the relay must stay off the keyboard entirely.
    host.screen = COMPOSER_GRID;
    engine.ingest("composer repaint bytes");
    assert.deepEqual(
      host.writes.slice(writesBefore),
      [],
      "no picker on the grid → no Esc (the Esc is keyed on a POSITIVE identification)",
    );
    await delay(1200);
    assert.equal(lastEvent(host.events).cancelled, true, "still settles cancelled");
  } finally {
    engine.clear();
  }
});

await check("3b: a native YES still settles as a grant (the receipt beats the exit beat)", () => {
  const { host, engine } = driveToParkedConsent();
  try {
    // The user chose Yes in the terminal: the dialog leaves the screen a beat
    // BEFORE `• Permissions updated to Full Access` prints. Concluding "cancelled"
    // from the absence alone would be a lie — the bounded exit beat buys the truth.
    host.screen = COMPOSER_GRID;
    engine.ingest("some repaint bytes");
    engine.ingest(GRANT_RECEIPT);
    const settled = lastEvent(host.events);
    assert.equal(settled.phase, "settled", "the grant receipt settles the relay");
    assert.notEqual(settled.cancelled, true, "a granted Full Access is not cancelled");
  } finally {
    engine.clear();
  }
});

await check("3b: the drawer answer drives the cursor off the parked grid", () => {
  const { host, engine } = driveToParkedConsent();
  try {
    const writesBefore = host.writes.length;
    // The user chose row 1 (Yes, continue anyway). The parked dialog is static — no
    // fresh frame is coming — so the first nav read comes from the grid, whose
    // cursor is already on row 1 = the target: confirm with Enter straightaway.
    engine.answerParkedControlConfirm(1);
    assert.deepEqual(
      host.writes.slice(writesBefore),
      ["\r"],
      "only the confirm Enter is injected — the chosen row and nothing else",
    );
    engine.ingest(GRANT_RECEIPT);
    const settled = lastEvent(host.events);
    assert.equal(settled.phase, "settled", "the grant receipt settles the relay");
    assert.notEqual(settled.cancelled, true, "a granted Full Access is not cancelled");
  } finally {
    engine.clear();
  }
});

await check("3b: Cancel (row 2) is one arrow, one Enter, one picker-closing Esc", async () => {
  const { host, engine } = driveToParkedConsent();
  try {
    const writesBefore = host.writes.length;
    engine.answerParkedControlConfirm(2); // the drawer's Cancel / dismiss
    assert.deepEqual(
      host.writes.slice(writesBefore),
      [ARROW_DOWN],
      "one arrow toward row 2 — the press is validated before any Enter",
    );
    // A pre-move repaint (the cursor still on the row we pressed FROM) must WAIT,
    // never be read as the landing.
    engine.ingest("pre-move repaint");
    assert.deepEqual(
      host.writes.slice(writesBefore),
      [ARROW_DOWN],
      "a pre-move repaint presses nothing further",
    );
    // The validated landing on row 2 → Enter, trailed by the ONE Esc that closes
    // the /permissions picker codex returns to on a Cancel confirm (measured — the
    // fake host fires the deferred write synchronously).
    host.screen = consentGrid(2);
    engine.ingest("cursor moved");
    assert.deepEqual(
      host.writes.slice(writesBefore),
      [ARROW_DOWN, "\r", ESC],
      "Cancel is one arrow + one Enter + one picker-closing Esc — nothing else",
    );
    host.screen = COMPOSER_GRID;
    await delay(1200);
    const settled = lastEvent(host.events);
    assert.equal(settled.phase, "settled", "a user-chosen Cancel settles (never needs-attention)");
    assert.equal(settled.cancelled, true, "…as cancelled — nothing was granted");
  } finally {
    engine.clear();
  }
});

await check("3b: the deleted third row is refused (0.146.0 has two rows)", () => {
  const { host, engine } = driveToParkedConsent();
  try {
    const writesBefore = host.writes.length;
    engine.answerParkedControlConfirm(3); // the old `Yes, and don't ask again`
    assert.deepEqual(host.writes.slice(writesBefore), [], "an out-of-range row injects nothing");
    assert.equal(lastEvent(host.events).phase, "parked", "…and the relay stays parked for the user");
  } finally {
    engine.clear();
  }
});

await check("3b: DEFERRED grid reads (production's real ingest shape) park exactly once", async () => {
  // Every ingest-driven readScreen defers in production (the batch is written to
  // the screen model BEFORE the engine sees it, and @xterm parses on a later
  // turn), so consecutive batches can leave TWO reads in flight at once — both
  // landing on the post-drain grid, both seeing the consent. Only the first may
  // act; the rest are no-ops through the phase re-guard.
  const host = makeHost("codex", { deferReads: true });
  const engine = new ControlSwitchEngine(host);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    engine.injectClaudeControlSwitch("codex-permission", "full-access", "ask-for-approval");
    engine.ingest(pickerFrame(1));
    engine.ingest(pickerFrame(2));
    engine.ingest(pickerFrame(3)); // Enter on Full Access → confirming
    // Two batches back to back: the first read is scheduled while the grid still
    // shows the picker, the second after the consent painted — and BOTH resolve
    // against the grid as of the drain, which is the consent.
    const readsBefore = host.reads;
    host.screen = pickerFrame(3);
    engine.ingest(CONSENT_STREAM_CELL_DIFF);
    host.screen = consentGrid(1);
    engine.ingest("second batch of the same repaint");
    assert.equal(
      host.reads - readsBefore,
      2,
      "both batches issued a read — they really are concurrently in flight",
    );
    assert.ok(
      !phasesOf(host.events).includes("parked"),
      "nothing parked synchronously — the reads are still in flight",
    );
    await tick();
    assert.equal(
      phasesOf(host.events).filter((p) => p === "parked").length,
      1,
      "two in-flight reads park the relay exactly ONCE — the later callback RE-READS " +
        "the pending and guards out (closing over the captured one would double-park)",
    );
    // The drawer answer's own read is deferred here too — it must still complete.
    const writesBefore = host.writes.length;
    engine.answerParkedControlConfirm(1);
    await tick();
    assert.deepEqual(
      host.writes.slice(writesBefore),
      ["\r"],
      "the deferred nav read still confirms the user's row, and only that",
    );
    engine.ingest(GRANT_RECEIPT);
    const settled = lastEvent(host.events);
    assert.equal(settled.phase, "settled", "the grant receipt settles the relay");
    assert.notEqual(settled.cancelled, true, "a granted Full Access is not cancelled");
  } finally {
    engine.clear();
  }
});

await check("3b: an unrecognized screen rolls back instead of guessing a row", async () => {
  const { host, engine } = driveToParkedConsent();
  try {
    const writesBefore = host.writes.length; // everything before this is the picker
    engine.answerParkedControlConfirm(1);
    // The consent's cursor is already on row 1, so the relay Enters immediately and
    // waits for the receipt. Instead the screen becomes something the choreography
    // does not recognize: no receipt, no consent. RED LINE — never guess, never
    // retry: Esc once, then needs-attention for the human to resolve.
    host.screen = UNRECOGNIZED_GRID;
    engine.ingest("foreign modal bytes");
    await delay(5200); // settle timeout (4s) → Esc → close-verify (0.9s)
    const terminal = lastEvent(host.events);
    assert.equal(terminal.phase, "needs-attention", "an unrecognized screen surfaces needs-attention");
    assert.equal(terminal.reason, "consent", "…named as the consent gate");
    const relayWrites = host.writes.slice(writesBefore);
    assert.deepEqual(
      relayWrites,
      ["\r", ESC],
      "the relay wrote exactly the user's chosen row, then ONE rollback Esc — no retry, no guess",
    );
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
