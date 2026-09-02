import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
//   B5 — the parked claude cache-miss cursor read falls back to the park snapshot
//        on a PARSE MISS, not on a byte-empty scan (ask-flows Phase 0 S4): a
//        chunk-split dialog paint leaves the cursor row only in the snapshot while
//        cursor-less trailing bytes occupy the freshly reset scan.
//   SL-4 — a value-axis switch must not be FAILED by a repaint of an earlier
//        switch's rejection (upstream sync 2026-09-01), driven off the verbatim
//        pty window that produced the wrong verdict against a live 2.1.258.
const require = createRequire(import.meta.url);
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
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
const ARROW_UP = "\x1b[A";
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

// ── B5: a chunk-split cache-miss paint still navigates (parse-miss fallback) ──
//
// Fixture provenance: ADAPTED. The dialog lines are the MEASURED claude 2.1.214
// cache-miss frame (spikes/midsession-switch-probe/findings.md §"S7 cache-miss
// probe" — the same text midsession-receipt.mjs pins at the parser level). The
// ADAPTATION is the CHUNK SPLIT: the one measured frame is cut where a pty chunk
// boundary can fall, so the recognizer completes (→ PARK, which snapshots the
// frame and RESETS the scan) on a chunk that arrives AFTER the cursor row, and
// the paint's cursor-less trailing bytes then land in the fresh scan. The trailing
// chunk is the same measured No row wrapped in the cursor-hide/show escapes a
// repaint emits — non-empty and cursor-less, which is the shape the old
// `scan || parkedFrame` read got wrong (a non-empty scan shadowed the snapshot →
// parse null → the static dialog never repaints → 2.5s nav timeout → failParked
// Escs the dialog the user just answered, dropping the staged effort leg).
const CACHE_MISS_CHUNK_HEAD =
  "Switch model?\n" +
  "Your next response will be slower and use more tokens\n" +
  "This conversation is cached for the current model. Switching to Sonnet 5 means " +
  "the full history gets re-read on your next message.\n" +
  "❯ 1. Yes, switch to Sonnet 5\n";
const CACHE_MISS_CHUNK_NO_ROW = "  2. No, go back\n";
const CACHE_MISS_TRAILING_BYTES = "\x1b[?25l\x1b[2m  2. No, go back\x1b[0m\x1b[?25h";
const CLAUDE_MODEL_RECEIPT = "⎿ Set model to Sonnet 5 and saved as your default for new sessions";

await check("B5: a chunk-split park reads its cursor from the snapshot, not from the scan", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    // A staged Save (model + effort): the effort leg rides as the model switch's
    // queued `next`, so a bogus failParked here would silently drop it too.
    assert.equal(engine.startClaudeStagedSwitch("sonnet", "low").ok, true, "the staged Save started");
    assert.deepEqual(host.writes, ["/model sonnet", "\r"], "the model leg is injected first");

    // The dialog paints across chunks. The cursor row is in the FIRST chunk, which
    // does not yet complete the forge-resistant recognizer (body + No row)…
    engine.ingest(CACHE_MISS_CHUNK_HEAD);
    assert.ok(!phasesOf(host.events).includes("parked"), "the half-painted dialog has not parked yet");
    // …so the park — and with it the frame snapshot + scan reset — happens on the
    // chunk that completes it. The cursor row is now ONLY in the snapshot.
    engine.ingest(CACHE_MISS_CHUNK_NO_ROW);
    const parked = lastEvent(host.events);
    assert.equal(parked.phase, "parked", "the completed dialog parks the relay");
    assert.equal(parked.dialog, "claude-cachemiss", "…as the claude cache-miss dialog");
    // The paint's tail lands post-park: the fresh scan is NON-EMPTY and carries no
    // cursor row. This is the whole defect — the old read preferred it blindly.
    engine.ingest(CACHE_MISS_TRAILING_BYTES);

    const writesBefore = host.writes.length;
    engine.answerParkedControlConfirm(1); // the user chose `Yes, switch to Sonnet 5`
    assert.deepEqual(
      host.writes.slice(writesBefore),
      ["\r"],
      "the snapshot's cursor is already on the chosen row → confirm now (never strand the answer)",
    );

    engine.ingest(CLAUDE_MODEL_RECEIPT);
    assert.deepEqual(
      host.writes.slice(writesBefore),
      ["\r", "/effort low", "\r"],
      "the Yes settles the model leg and the staged effort leg runs — nothing was dropped",
    );
    assert.ok(!host.writes.includes(ESC), "no rollback Esc — the dialog was answered, not abandoned");
    assert.ok(
      !phasesOf(host.events).includes("needs-attention"),
      "and the relay never times out into needs-attention",
    );
  } finally {
    engine.clear();
  }
});

// The user arrowed the parked dialog NATIVELY in the co-visible Terminal after
// the park. ADAPTED from the MEASURED partial arrow-move repaint (claude 2.1.214,
// pinned in tui-parsers-claude.ts and midsession-receipt.mjs): claude DROPS the
// row digit in that repaint — `❯No, go back`, no `2.` — so the label anchors it.
const NATIVE_MOVE_TO_NO = "  Yes, switch to Sonnet 5\n❯No, go back";
// The dialog CLOSING: a native answer/Esc repaints the composer, and that chunk
// carries no cursor row (the `❯` composer prompt is not followed by a row label,
// which is exactly why the parser rejects it) and not yet the `Kept …` line.
const CLOSE_REPAINT = "\x1b[2K\x1b[G❯ ";
const CLAUDE_MODEL_CANCEL = "⎿ Kept model as Opus 4.6";

/** Park a claude cache-miss model switch (cursor on row 1, in the SNAPSHOT only —
 *  the chunk-split shape above), returning { host, engine }. */
function driveToParkedCacheMiss() {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  assert.equal(engine.injectClaudeControlSwitch("model", "sonnet").ok, true, "the model switch started");
  engine.ingest(CACHE_MISS_CHUNK_HEAD);
  engine.ingest(CACHE_MISS_CHUNK_NO_ROW);
  assert.equal(lastEvent(host.events).phase, "parked", "the cache-miss dialog parks the relay");
  return { host, engine };
}

await check("B5: a native cursor move during the park outranks the snapshot", () => {
  const { host, engine } = driveToParkedCacheMiss();
  try {
    // The snapshot's cursor is on row 1, but the user has since moved it to row 2
    // in the Terminal. The scan is POST-PARK truth; the snapshot is a retained
    // frame. Reading the snapshot first would press an arrow the screen does not
    // need — and validate that press against a cursor that is already there.
    engine.ingest(NATIVE_MOVE_TO_NO);
    const writesBefore = host.writes.length;
    engine.answerParkedControlConfirm(2); // the drawer's `No, go back`
    assert.deepEqual(
      host.writes.slice(writesBefore),
      ["\r"],
      "the cursor is ALREADY on the chosen row per the scan — confirm, never arrow off the snapshot",
    );
    engine.ingest(CLAUDE_MODEL_CANCEL);
    const settled = lastEvent(host.events);
    assert.equal(settled.phase, "settled", "the `Kept …` receipt settles the relay");
    assert.equal(settled.cancelled, true, "…as cancelled — the user chose No");
  } finally {
    engine.clear();
  }
});

await check("B5: after a press, a cursor-less frame WAITS — the snapshot never validates a landing", async () => {
  const { host, engine } = driveToParkedCacheMiss();
  try {
    // The hazard the snapshot fallback must not reopen. Native move to row 2, then
    // the user picks row 1 in the drawer: the relay presses ↑ AWAY from the row the
    // snapshot still shows, so the stale snapshot cursor now equals `awaitingCursor`
    // — it would be read as the landing by an ungated fallback.
    engine.ingest(NATIVE_MOVE_TO_NO);
    const writesBefore = host.writes.length;
    engine.answerParkedControlConfirm(1); // `Yes, switch to Sonnet 5`
    assert.deepEqual(
      host.writes.slice(writesBefore),
      [ARROW_UP],
      "one arrow toward row 1, validated before any Enter",
    );
    // …and the next frame is the dialog CLOSING (the user answered natively in the
    // gap): cursor-less, and the `Kept …` line has not printed yet. A blind Enter
    // here lands on the COMPOSER and submits whatever the user typed into it.
    engine.ingest(CLOSE_REPAINT);
    assert.deepEqual(
      host.writes.slice(writesBefore),
      [ARROW_UP],
      "a cursor-less post-press frame presses NOTHING — post-press positions need post-press evidence",
    );
    // The native answer's receipt still settles the relay honestly.
    engine.ingest(CLAUDE_MODEL_CANCEL);
    const settled = lastEvent(host.events);
    assert.equal(settled.phase, "settled", "the native `Kept …` settles the relay");
    assert.equal(settled.cancelled, true, "…as cancelled — nothing was applied");
    assert.deepEqual(
      host.writes.slice(writesBefore),
      [ARROW_UP],
      "the arrow is the ONLY byte the relay put on the wire — no blind Enter into the composer",
    );
  } finally {
    engine.clear();
  }
});

// ── SL-4: a transcript repaint must not fail the switch in flight ───────────
//
// MEASURED, and this is the whole point of driving it through the ENGINE rather
// than the parser alone: the fixture is the VERBATIM 4096-char window
// `detectControlSwitchReceipt` was holding when a live claude 2.1.258 answered a
// `/model haiku` that SUCCEEDED — and the engine emitted `failed`, because the
// alternate-screen full-transcript redraw that the switch itself provoked
// replayed an earlier arm's `Model 'bogus-model-xyz' not found` into the window
// (spikes/upstream-sync-2026-09/claude, q13 arm B4). The user would have been
// told Claude rejected a model it had just accepted.
const STALE_FAILURE_WINDOW = readFileSync(
  resolve(FIXTURES, "claude-midsession/stale-failure-repaint-2.1.258.txt"),
  "utf8",
);

// WHAT THIS FIXTURE DOES AND DOES NOT PROVE — read before editing the messages.
// The window carries the earlier arm's rejection AND replayed success lines for
// `Opus 5` / `Opus 5 (1M context)`. It carries NO `Set model to Haiku`: the
// receipt for the switch that actually succeeded is not in the slice. So the
// `settled` below is produced by a REPLAYED success line naming a DIFFERENT
// model — it is the value-anchored FAILURE needle doing its job (the rejection
// no longer wins) sitting on top of the un-anchored SUCCESS needle's known
// residual. Claiming this settles "on its own receipt" would describe the
// exposure as if it were correct attribution, so the assertions say what is
// actually true and the residual is pinned separately, below.
await check("SL-4: a repainted OLD rejection does not FAIL the switch in flight", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    assert.equal(engine.injectClaudeControlSwitch("model", "haiku").ok, true, "the switch started");
    engine.ingest(STALE_FAILURE_WINDOW);
    const last = lastEvent(host.events);
    assert.equal(
      last.phase,
      "settled",
      "not `failed` — the replayed rejection names another value (it settles on a REPLAYED success: see the residual pin)",
    );
    assert.equal(last.value, "haiku", "…and the event still reports the value this switch asked for");
  } finally {
    engine.clear();
  }
});

await check("SL-4 KNOWN RESIDUAL: a replayed success settles a switch whose receipt is absent", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    // `fable` was never switched to in the session this window came from, so no
    // `Set model to Fable 5.1` line exists anywhere in it. The engine settles
    // anyway, on a replayed `Set model to Opus 5`. This is the documented
    // trade-off, pinned as what it IS rather than left for a future reader to
    // discover: the success needle cannot be value-anchored (the receipt names
    // the model's DISPLAY name, not the alias — anchoring it would fail CLOSED
    // into needs-attention on every upstream rename), the switch does complete,
    // and the statusline mirror — not this scrape — is the state SSOT. The
    // structural fix is mirror-based confirmation (D-1), registered not taken.
    assert.equal(engine.injectClaudeControlSwitch("model", "fable").ok, true, "the switch started");
    engine.ingest(STALE_FAILURE_WINDOW);
    assert.equal(
      lastEvent(host.events).phase,
      "settled",
      "EXPOSURE, pinned deliberately: a replayed success line for ANOTHER model settles this switch",
    );
  } finally {
    engine.clear();
  }
});

await check("SL-4: …while the switch that WAS rejected still fails, on the same bytes", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    assert.equal(
      engine.injectClaudeControlSwitch("model", "bogus-model-xyz").ok,
      true,
      "the switch started",
    );
    engine.ingest(STALE_FAILURE_WINDOW);
    const last = lastEvent(host.events);
    assert.equal(last.phase, "failed", "the rejection is still recognized");
    assert.match(last.error, /bogus-model-xyz/, "…and names the value Claude rejected");
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
