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
//   SL-5 — the permission drive's ORIGIN comes off the SCREEN, not off the
//        caller's `from` (upstream sync 2026-09-01). The `from` is
//        `task.permissionMode`, the hook-fed mirror, and q18 arm G measured that
//        an undriven flip fires NO hook — so the mirror can be arbitrarily
//        stale, and q19 measured what a stale one then costs on the live CLI:
//        seven mode changes and needs-attention. Also: an origin the cycle
//        cannot reach is not walked toward (q18 arm E measured `dontAsk`
//        unreachable by stepping).
const require = createRequire(import.meta.url);
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const {
  ControlSwitchEngine,
  expectedPermissionLandings,
  isClaudePermissionCycleMode,
  parseClaudePermissionModeLine,
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
    // The SL-5 origin read, faked the way the real host implements it: the SAME
    // shared parser, run over the SAME fixture viewport `readScreen` serves.
    // Deliberately not a settable enum — a fake that could answer a mode the
    // fixture screen does not show would let a test pass on a screen the parser
    // cannot actually read (exactly the `don't ask on` blindness SL-5 found).
    // An empty `host.screen` therefore answers null, which is what every
    // pre-SL-5 test in this file wants: fall back to the caller's `from`.
    screenPermissionMode: () => (provider === "claude" ? parseClaudePermissionModeLine(host.screen) : null),
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

// ── SL-5: the origin comes off the SCREEN (upstream sync 2026-09-01) ─────────
//
// MEASURED footer rows, VERBATIM from claude 2.1.258 under Sonata's production
// spawn shape (spikes/upstream-sync-2026-09/claude/q17-permission-cycle.capture.txt
// arms A/C/D and q18 arm E) — byte-exact, 2-space indent included; the grid
// reader trims trailing padding, so the rows end where they end. Sonata reads
// the mode off this row on two channels — the S2 step receipt and the readiness
// needle — so the fixtures are the whole rendered row, trailing chrome
// included, not a hand-written phrase.
//
// `default`'s row is the one WITHOUT the `(shift+tab to cycle)` tail; that
// asymmetry is upstream's and is preserved here deliberately. `dontAsk` is the
// row the phrase table was blind to before this slice. `OCCLUDED` is the row
// that REPLACES the mode line for ~1–2s after a single Ctrl-C at an idle
// composer (q17 arm D) — a live composer with no readable mode; 2-space indent,
// 87 spaces, `/rc`, 118 columns.
const FOOTER = {
  default: "  ⏸ manual mode on · ← for agents",
  acceptEdits: "  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents",
  plan: "  ⏸ plan mode on (shift+tab to cycle) · ← for agents",
  auto: "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
  dontAsk: "  ⏵⏵ don't ask on (shift+tab to cycle) · ← for agents",
  OCCLUDED:
    "  Press Ctrl-C again to exit                                                                                       /rc",
};

await check("SL-5: the measured 2.1.258 footer rows all read back as their mode", () => {
  for (const [mode, row] of Object.entries(FOOTER)) {
    if (mode === "OCCLUDED") continue;
    assert.equal(
      parseClaudePermissionModeLine(row),
      mode,
      `the verbatim ${mode} footer row parses as ${mode}`,
    );
  }
  // The Ctrl-C hint frame is not a mode line — it must read as "no answer", so
  // the origin read falls back rather than inventing a mode.
  assert.equal(
    parseClaudePermissionModeLine(FOOTER.OCCLUDED),
    null,
    "the Ctrl-C hint that replaces the mode line answers null, never a mode",
  );
});

await check("SL-5: both off-cycle origins KEEP the blanket exemption (n=1 does not earn a rule)", () => {
  // q18 arm E observed `dontAsk`'s successor exactly ONCE (`default`); the seven
  // presses after it were cycle-internal and corroborate the CYCLE, not that
  // transition. A one-member expectation that is right buys nothing the
  // stale-repaint filter does not already give, while one that upstream later
  // makes wrong turns a working drive into a guaranteed failure — with no second
  // chance, since SL-5 also removed the walking recovery for non-cycle origins.
  // So the measurement is recorded in the parser's doc as knowledge and NOT
  // encoded as a rule. This pin is what makes that a decision rather than a gap.
  assert.deepEqual(
    new Set(expectedPermissionLandings("dontAsk")),
    new Set(CLAUDE_PERMISSION_CYCLE),
    "dontAsk keeps the blanket exemption (successor observed n=1)",
  );
  // bypassPermissions never paints a composer to step from (its spawn parks on
  // an unanswered consent screen), so its successor is unmeasured outright.
  assert.deepEqual(
    new Set(expectedPermissionLandings("bypassPermissions")),
    new Set(CLAUDE_PERMISSION_CYCLE),
  );
  // What IS encoded, and what the return-home early stop keys on: neither is a
  // cycle member, so neither can ever be arrived at by stepping (MEASURED).
  assert.equal(isClaudePermissionCycleMode("dontAsk"), false);
  assert.equal(isClaudePermissionCycleMode("bypassPermissions"), false);
  for (const mode of CLAUDE_PERMISSION_CYCLE) {
    assert.equal(isClaudePermissionCycleMode(mode), true, `${mode} is a cycle member`);
  }
});

// The regression this slice exists for. MEASURED pre-fix on the live CLI (q19
// arm h1, claude 2.1.258): mirror says `default`, the CLI is in `acceptEdits`,
// the user asks for `plan` → SEVEN mode changes, `needs-attention`, and the
// session left in `default` — neither the target nor where it actually started.
await check("SL-5: a STALE `from` no longer misanchors the drive — the screen wins", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    // The session is in acceptEdits (the user flipped it natively; no hook fired,
    // so the mirror still says `default` — q18 arm G).
    host.screen = FOOTER.acceptEdits;
    const res = engine.injectClaudeControlSwitch("permission", "plan", "default");
    assert.equal(res.ok, true, "the switch started");
    assert.equal(host.writes.length, 1, "one Shift+Tab for the first step");

    // acceptEdits → plan is ONE step, and it is the target.
    engine.ingest(FOOTER.plan);
    assert.equal(
      host.writes.length,
      1,
      "the real landing is accepted as this step's receipt — no fail-loud, no extra press",
    );
    assert.equal(lastEvent(host.events).phase, "settled", "and the switch settles");
    assert.equal(lastEvent(host.events).value, "plan");
    // The seven-press walk pre-fix visited every mode; a correct drive sees two.
    assert.deepEqual(
      new Set(lastEvent(host.events).observedModes),
      new Set(["acceptEdits", "plan"]),
      "observedModes names the two modes actually visited, not the whole cycle",
    );
  } finally {
    engine.clear();
  }
});

await check("SL-5: asking for the mode the SESSION is already in presses nothing", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    // q19 arm h3: the native flip landed on the very mode the user then picked.
    // Pre-fix the no-op check compared `acceptEdits` against the stale `default`
    // and drove seven presses OFF the target.
    host.screen = FOOTER.acceptEdits;
    const res = engine.injectClaudeControlSwitch("permission", "acceptEdits", "default");
    assert.equal(res.ok, true);
    assert.equal(host.writes.length, 0, "nothing is written — the session is already there");
    assert.equal(lastEvent(host.events).phase, "settled", "and it reports settled, not pending");
  } finally {
    engine.clear();
  }
});

await check("SL-5: an origin the cycle cannot reach is not walked toward", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    // Origin `dontAsk` (read off the screen), seeking `auto` — two steps away
    // via the cycle it enters at `default`.
    host.screen = FOOTER.dontAsk;
    engine.injectClaudeControlSwitch("permission", "auto", "dontAsk");
    assert.equal(host.writes.length, 1, "one Shift+Tab for the first step");

    // Press 1 lands in the cycle. The blanket exemption accepts it (we do not
    // claim to know dontAsk's successor — see the n=1 pin above), so the seek
    // continues normally.
    engine.ingest(FOOTER.default);
    assert.equal(host.writes.length, 2, "the seek continues from the cycle member it entered on");

    // Press 2 lands on a NON-successor of `default` — an unexpected screen, so
    // the engine fails loud and flips to return-home. Home is `dontAsk`, which
    // is NOT reachable by stepping (MEASURED, q18 arm E), so the walk could
    // never arrive: pre-SL-5 it burned PERMISSION_MAX_RETURN_STEPS more mode
    // changes proving that, which is the blind-press ladder the RED LINE
    // forbids. It must now stop dead instead.
    engine.ingest(FOOTER.auto);
    assert.equal(
      host.writes.length,
      2,
      "no return-home presses toward an origin the cycle cannot reach",
    );
    assert.equal(
      lastEvent(host.events).phase,
      "needs-attention",
      "it stops where it is and says so",
    );
  } finally {
    engine.clear();
  }
});

await check("SL-5: an OCCLUDED mode line falls back to the caller's `from`", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    // The ~1–2s Ctrl-C hint window: the screen has no readable mode, so the
    // origin read must decline rather than guess, leaving pre-SL-5 behaviour.
    host.screen = FOOTER.OCCLUDED;
    engine.injectClaudeControlSwitch("permission", "plan", "default");
    assert.equal(host.writes.length, 1, "the switch still starts");
    engine.ingest(FOOTER.acceptEdits);
    assert.equal(
      host.writes.length,
      2,
      "and validates against `from` exactly as it did before — default → acceptEdits advances",
    );
    engine.ingest(FOOTER.plan);
    assert.equal(lastEvent(host.events).phase, "settled", "reaching the target normally");
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
/** Comfortably past `PARKED_CONFIRM_CANCEL_VERIFY_MS` (900ms) — the bounded beat
 *  the model-axis cancel now waits out so a `PostModelSwitch` in flight can win
 *  it. Real time, not a fake clock: the engine arms real `setTimeout`s and the
 *  rest of this file already drives them that way. */
const PARKED_CANCEL_VERIFY_WAIT_MS = 1200;

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

    // The Yes lands. Since D2 U3 the settle comes from `PostModelSwitch`, not from
    // the receipt — the receipt is ingested first here anyway, precisely to assert
    // that it does NOT resolve the relay on its own any more.
    engine.ingest(CLAUDE_MODEL_RECEIPT);
    assert.deepEqual(
      host.writes.slice(writesBefore),
      ["\r"],
      "the receipt alone does not settle the model leg (U3: the hook is the confirm)",
    );
    engine.noteModelSwitchConfirmed("sonnet");
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

await check("B5: a native cursor move during the park outranks the snapshot", async () => {
  const { host, engine } = driveToParkedCacheMiss();
  try {
    // The dialog is gone from the grid by the time the `Kept …` line prints —
    // required since D2 U3, where the model-axis cancel needs that second witness
    // before it is believed at all (and then waits out its bounded beat).
    host.screen = "❯ ";
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
    await delay(PARKED_CANCEL_VERIFY_WAIT_MS);
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
    // The native answer's receipt still settles the relay honestly — now with the
    // grid confirming the dialog is gone, and after its bounded beat (D2 U3).
    host.screen = "❯ ";
    engine.ingest(CLAUDE_MODEL_CANCEL);
    await delay(PARKED_CANCEL_VERIFY_WAIT_MS);
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
// receipt for the switch that actually succeeded is not in the slice.
//
// Until D2 U3 this window produced `settled` — on a REPLAYED success naming a
// DIFFERENT model, which is the residual the model-axis success needle carried.
// The needle is now retired (the `PostModelSwitch` hook settles this axis), so
// the same bytes produce NO verdict at all: the rejection still does not win, and
// nothing else in the window is allowed to speak for a switch it does not name.
await check("SL-4/U3: a repainted OLD rejection does not FAIL the switch in flight", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    assert.equal(engine.injectClaudeControlSwitch("model", "haiku").ok, true, "the switch started");
    engine.ingest(STALE_FAILURE_WINDOW);
    const last = lastEvent(host.events);
    assert.equal(last.phase, "pending", "not `failed` — the replayed rejection names another value");
    assert.equal(host.events.length, 1, "…and the poisoned window produces no verdict of any kind");
    assert.equal(last.value, "haiku", "…the pending event still reports the value this switch asked for");
  } finally {
    engine.clear();
  }
});

await check("U3: the KNOWN RESIDUAL is CLOSED — a replayed success settles nothing", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    // `fable` was never switched to in the session this window came from, so no
    // `Set model to Fable 5.1` line exists anywhere in it. The engine USED TO
    // settle anyway, on a replayed `Set model to Opus 5` — the residual pinned
    // here for two slices because the success needle could not be value-anchored
    // (the receipt names the model's DISPLAY name, not the alias). It now settles
    // nothing: `PostModelSwitch.requested_model` carries the alias, so the confirm
    // moved to the channel that can be anchored, and the needle was removed rather
    // than left unread.
    assert.equal(engine.injectClaudeControlSwitch("model", "fable").ok, true, "the switch started");
    engine.ingest(STALE_FAILURE_WINDOW);
    assert.equal(
      lastEvent(host.events).phase,
      "pending",
      "CLOSED: a replayed success line for ANOTHER model no longer settles this switch",
    );
    // And the honest degradation is intact: with no hook and no receipt, the
    // switch stays pending for its timeout rather than inventing an outcome.
    assert.equal(engine.hasPending(), true, "…the switch is still in flight, awaiting its hook");
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

// ===========================================================================
// D2 U3 — `PostModelSwitch` is the model axis's confirm.
//
// The hook reaches the engine as `noteModelSwitchConfirmed(requested_model)`,
// routed by `RuntimeController.applyHookToTask` → `TerminalHost`. Everything
// below is the contract that method owes: it settles the axis in BOTH phases a
// model switch can be waiting in, and it is inert in every other situation
// WITHOUT keeping any remembered state to be inert with.
//
// The alias strings are the MEASURED ones — h4 recorded `requested_model` equal
// to the alias Sonata types, verbatim, across the whole `MODEL_OPTIONS` set
// including the bracketed `opus[1m]` (spikes/upstream-sync-2026-09/claude/
// h4-model-switch-hooks.capture.txt).

await check("U3: a PostModelSwitch for the pending alias settles the VALUE phase", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    assert.equal(engine.injectClaudeControlSwitch("model", "haiku").ok, true, "the switch started");
    assert.deepEqual(host.writes, ["/model haiku", "\r"], "the command was injected");
    engine.noteModelSwitchConfirmed("haiku");
    const last = lastEvent(host.events);
    assert.equal(last.phase, "settled", "the hook settles the switch");
    assert.equal(last.kind, "model", "…on the model axis");
    assert.equal(last.value, "haiku", "…naming the alias that was asked for");
    assert.equal(engine.hasPending(), false, "…and nothing is left in flight");
  } finally {
    engine.clear();
  }
});

await check("U3: the bracketed `opus[1m]` alias round-trips through the hook match", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    // MEASURED (h4 arm h leg1): `requested_model` came back as `opus[1m]`,
    // brackets intact. The match is string equality, so — unlike the failure
    // needle, which has to escape this value into a regex — the brackets are inert
    // here. Pinned so a future "match with a RegExp instead" cannot regress it.
    assert.equal(engine.injectClaudeControlSwitch("model", "opus[1m]").ok, true, "the switch started");
    engine.noteModelSwitchConfirmed("opus[1m]");
    assert.equal(lastEvent(host.events).phase, "settled", "the bracketed alias settles");
    engine.clear();

    // …and it is not being treated as a character class: `opus1m` must NOT match.
    assert.equal(engine.injectClaudeControlSwitch("model", "opus[1m]").ok, true, "a second switch started");
    engine.noteModelSwitchConfirmed("opus1m");
    assert.equal(lastEvent(host.events).phase, "pending", "a bracket-stripped alias does not match");
  } finally {
    engine.clear();
  }
});

await check("U3: a PostModelSwitch settles a PARKED cache-miss dialog (a native Yes)", () => {
  const { host, engine } = driveToParkedCacheMiss();
  try {
    // The relay is parked in `waiting-user` and Sonata has pressed nothing. The
    // user answered Yes in the co-visible Terminal; the CLI's own hook is what
    // tells us, and it must settle honestly rather than sit until the drawer is
    // touched. MEASURED: a parked `Post` lands 66–92ms after the dialog is
    // answered, whoever answered it (h4 arms a1/a2/a3/f/g/h).
    const writesBefore = host.writes.length;
    engine.noteModelSwitchConfirmed("sonnet");
    const last = lastEvent(host.events);
    assert.equal(last.phase, "settled", "the parked relay settles on the hook");
    assert.equal(last.value, "sonnet", "…naming the pending alias");
    assert.ok(!last.cancelled, "…as an APPLY, not a cancel");
    assert.deepEqual(host.writes.slice(writesBefore), [], "and Sonata wrote nothing — the user answered");
  } finally {
    engine.clear();
  }
});

await check("U3: a parked Yes carries the staged effort leg through the hook", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    // The staged Save's second axis rides as the model switch's queued `next`. It
    // must survive the confirm channel changing under it — a hook-settled Yes runs
    // the effort leg exactly as a receipt-settled one did.
    assert.equal(engine.startClaudeStagedSwitch("sonnet", "low").ok, true, "the staged Save started");
    engine.ingest(CACHE_MISS_CHUNK_HEAD);
    engine.ingest(CACHE_MISS_CHUNK_NO_ROW);
    assert.equal(lastEvent(host.events).phase, "parked", "the dialog parks the relay");
    const writesBefore = host.writes.length;
    engine.noteModelSwitchConfirmed("sonnet");
    assert.deepEqual(
      host.writes.slice(writesBefore),
      ["/effort low", "\r"],
      "the hook settles the model leg and the queued effort leg runs",
    );
    assert.equal(engine.hasPending(), true, "…as ONE logical switch — the effort leg is now pending");
  } finally {
    engine.clear();
  }
});

await check("U3: a DUPLICATE PostModelSwitch is a no-op", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    assert.equal(engine.injectClaudeControlSwitch("model", "haiku").ok, true, "the switch started");
    engine.noteModelSwitchConfirmed("haiku");
    const afterFirst = host.events.length;
    engine.noteModelSwitchConfirmed("haiku");
    engine.noteModelSwitchConfirmed("haiku");
    assert.equal(
      host.events.length,
      afterFirst,
      "idempotent by construction: the settle cleared the pending, so repeats find nothing",
    );
  } finally {
    engine.clear();
  }
});

await check("U3: a PostModelSwitch for ANOTHER alias is ignored", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    assert.equal(engine.injectClaudeControlSwitch("model", "haiku").ok, true, "the switch started");
    engine.noteModelSwitchConfirmed("sonnet");
    assert.equal(lastEvent(host.events).phase, "pending", "a foreign alias does not settle this switch");
    assert.equal(engine.hasPending(), true, "…and the switch stays in flight for its own hook");
    // The point of anchoring: the switch that DID ask for it still settles.
    engine.noteModelSwitchConfirmed("haiku");
    assert.equal(lastEvent(host.events).phase, "settled", "…while the matching alias settles it");
  } finally {
    engine.clear();
  }
});

await check("U3: a PostModelSwitch with NO pending switch is a no-op", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    // The ordinary case for a user who switches models natively in the Terminal
    // while Sonata has nothing staged. The hook arrives for every switch, ours or
    // theirs, so "no pending" must be silence rather than an event.
    engine.noteModelSwitchConfirmed("haiku");
    assert.deepEqual(host.events, [], "no event is emitted");
    assert.deepEqual(host.writes, [], "and nothing is written to the pty");
  } finally {
    engine.clear();
  }
});

await check("U3: a PostModelSwitch cannot settle a pending EFFORT switch", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    // Reachable in the staged sequence: the model leg settles, the effort leg is
    // armed, and a late/duplicate model hook arrives while it is pending. The axis
    // test — not a timer, not a flag — is what makes that inert.
    assert.equal(engine.injectClaudeControlSwitch("effort", "low").ok, true, "the effort switch started");
    engine.noteModelSwitchConfirmed("low");
    assert.equal(lastEvent(host.events).phase, "pending", "the effort leg is untouched by a model hook");
    assert.equal(engine.hasPending(), true, "…and still waiting for its own receipt");
    // …which still arrives on the stream, because the effort axis has no hook.
    engine.ingest("⎿ Set effort level to low (saved as your default for new sessions)");
    assert.equal(lastEvent(host.events).phase, "settled", "the effort axis is still stream-confirmed");
  } finally {
    engine.clear();
  }
});

await check("U3: the model axis no longer settles on its OWN success receipt", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    // The receipt that used to be the confirm. It is not a near-miss or a replay —
    // it is the real, correct receipt for this exact switch, and it settles
    // nothing, because "the CLI printed a line naming a display label" is not
    // evidence about WHICH switch completed. Only the hook is.
    assert.equal(engine.injectClaudeControlSwitch("model", "sonnet").ok, true, "the switch started");
    engine.ingest(CLAUDE_MODEL_RECEIPT);
    assert.equal(lastEvent(host.events).phase, "pending", "the receipt does not settle the model axis");
    engine.noteModelSwitchConfirmed("sonnet");
    assert.equal(lastEvent(host.events).phase, "settled", "…the hook does");
  } finally {
    engine.clear();
  }
});

// ── The cancel axis: F22, narrowed by a GRID term ──────────────────────────
/** The parked dialog as the GRID shows it — body + the `No, go back` row, which
 *  is what `claudeCacheMissDialogOpen` requires. Same text the park was driven
 *  from, because it is the same screen. */
const CACHE_MISS_ON_GRID = CACHE_MISS_CHUNK_HEAD + CACHE_MISS_CHUNK_NO_ROW;

await check("U3: a `Kept model as …` line does NOT cancel while the dialog is still on the grid", async () => {
  const { host, engine } = driveToParkedCacheMiss();
  try {
    // F22's exposure, reproduced and then refused. The park resets the scan, so a
    // post-park window is exactly the fresh slice a replayed `Kept …` needs — and
    // with the model success needle retired there is no competing receipt to beat
    // it. The grid is the second witness: the dialog is plainly still displayed.
    host.screen = CACHE_MISS_ON_GRID;
    engine.ingest(CLAUDE_MODEL_CANCEL);
    await delay(PARKED_CANCEL_VERIFY_WAIT_MS);
    assert.equal(
      lastEvent(host.events).phase,
      "parked",
      "the relay stays parked — the dialog the user has not answered is still up",
    );
    assert.equal(engine.hasPending(), true, "…and the staged switch is not dropped");

    // The user then really does cancel: the dialog leaves the screen, and the next
    // frame carrying the phrase now finds the grid agreeing with it.
    host.screen = "❯ ";
    engine.ingest(CLAUDE_MODEL_CANCEL);
    await delay(PARKED_CANCEL_VERIFY_WAIT_MS);
    const last = lastEvent(host.events);
    assert.equal(last.phase, "settled", "…and once the dialog is gone, the cancel is believed");
    assert.equal(last.cancelled, true, "…as a CANCEL (nothing changed CLI-side)");
  } finally {
    engine.clear();
  }
});

await check("U3: a real cancel concludes after the bounded beat, with no Esc", async () => {
  const { host, engine } = driveToParkedCacheMiss();
  try {
    // The ordinary shape: the answering keystroke closes the dialog and prints the
    // `Kept …` line, so by the time the engine reads the grid the dialog has left
    // it. Both terms are true — and the relay still waits out the exit beat before
    // concluding, so a Post in flight can win it (the next case).
    host.screen = "❯ ";
    engine.ingest(CLOSE_REPAINT + CLAUDE_MODEL_CANCEL);
    assert.equal(lastEvent(host.events).phase, "parked", "nothing is concluded inside the beat");
    await delay(PARKED_CANCEL_VERIFY_WAIT_MS);
    const last = lastEvent(host.events);
    assert.equal(last.phase, "settled", "the beat elapses with no settle signal → cancelled");
    assert.equal(last.cancelled, true, "…as a cancel");
    assert.ok(!host.writes.includes(ESC), "…with no rollback Esc (the user answered; nothing to close)");
  } finally {
    engine.clear();
  }
});

await check("U3: a Yes whose repaint REPLAYS an old `Kept …` is not reported as a cancel", async () => {
  const { host, engine } = driveToParkedCacheMiss();
  try {
    // THE RACE the exit beat exists for, and it is this slice's own doing. A Yes
    // reshapes the banner, which is F19's full-transcript redraw, which replays
    // this session's older receipts into the freshly-reset post-park scan — so a
    // `Kept model as …` from an earlier cancel (or from a plain `/model` picker
    // Esc, F15) can land in the window at the exact moment the dialog leaves the
    // screen FOR A YES. Before the retirement the success receipt was checked
    // first and beat it; now nothing in the stream can, and the hook is 66–92ms
    // behind. Concluding inside that window would report a cancel that did not
    // happen AND drop the staged effort leg.
    assert.equal(engine.hasPending(), true, "parked, staged switch in flight");
    host.screen = "❯ ";
    engine.ingest(CLOSE_REPAINT + CLAUDE_MODEL_CANCEL);
    assert.equal(lastEvent(host.events).phase, "parked", "the beat is open, nothing concluded");

    // The hook arrives inside the beat, as measured (66–92ms after the answer).
    engine.noteModelSwitchConfirmed("sonnet");
    const settled = lastEvent(host.events);
    assert.equal(settled.phase, "settled", "the hook settles it");
    assert.ok(!settled.cancelled, "…as an APPLY, not the cancel the stream was arguing for");

    // …and the verify timer, which is still armed, must not then fire a second
    // event over the top of it.
    const afterSettle = host.events.length;
    await delay(PARKED_CANCEL_VERIFY_WAIT_MS);
    assert.equal(host.events.length, afterSettle, "the elapsed beat emits nothing after a settle");
  } finally {
    engine.clear();
  }
});

await check("U3: the EFFORT axis keeps the bare cancel needle (no grid term, no hook)", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    // Effort has no hook of any kind (h4 arm d), so it has no second witness to
    // pair a grid term with — gating it would only make an effort cancel harder to
    // see. Pinned so the asymmetry is deliberate and visible rather than an
    // oversight in a shared code path.
    assert.equal(engine.injectClaudeControlSwitch("effort", "low").ok, true, "the effort switch started");
    engine.ingest(
      "Change effort level?\nThis conversation is cached for the current effort. Switching to low means " +
        "the full history gets re-read on your next message.\n❯ 1. Yes, switch to low\n  2. No, go back\n",
    );
    assert.equal(lastEvent(host.events).phase, "parked", "the effort dialog parks the relay");
    // The grid still shows the dialog — and the effort axis settles anyway, which
    // is exactly the difference being pinned.
    host.screen = CACHE_MISS_ON_GRID;
    engine.ingest("⎿ Kept effort level as medium");
    const last = lastEvent(host.events);
    assert.equal(last.phase, "settled", "the effort cancel needle still fires on its own");
    assert.equal(last.cancelled, true, "…as a cancel");
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
