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

// ===========================================================================
// D2 U4 — the claude model/effort switch is the session-scoped PICKER drive.
//
// The slash form (`/model X`) wrote the user's durable default (F68, 3/3); the
// picker's `s` does not (F89, m2). The engine now types the bare `/model` /
// `/effort`, waits for the picker on the GRID, walks to the target row / tick with
// grid-verified arrows, presses `s`, and settles on the `PostModelSwitch` hook
// (model) or the `Set effort level to … (this session only)` receipt (effort).
// Frames below are MEASURED at claude 2.1.259 (probe `m2-session-scoped-switch`,
// fixtures `claude-midsession/model-picker-2.1.259.txt`,
// `effort-slider-2.1.259.txt`, `effort-slider-after-right-2.1.259.txt`); the
// focus-moved variants are ADAPTED from them by relocating the `❯` / `▲` glyph.
const MODEL_PICKER_MEASURED = readFileSync(
  resolve(FIXTURES, "claude-midsession/model-picker-2.1.259.txt"),
  "utf8",
);
const EFFORT_SLIDER_MEASURED = readFileSync(
  resolve(FIXTURES, "claude-midsession/effort-slider-2.1.259.txt"),
  "utf8",
);
const EFFORT_SLIDER_HIGH_MEASURED = readFileSync(
  resolve(FIXTURES, "claude-midsession/effort-slider-after-right-2.1.259.txt"),
  "utf8",
);
/** The picker order at 2.1.259 (row 1..5). */
const PICKER_ORDER = ["Default (recommended)", "Opus (1M context)", "Fable", "Sonnet", "Haiku"];
/** ADAPTED: the MEASURED frame with the `❯` moved onto `label` (the current ✔ stays
 *  on Fable — that is the session the frame came from). */
function modelPickerFocused(label) {
  return MODEL_PICKER_MEASURED.split("\n")
    .map((line) => {
      const row = /^(\s*)(❯)?(\s*)(\d)\.\s+(.+)$/.exec(line);
      if (!row) return line;
      const isTarget = row[5].split(/\s✔|\s{2,}/)[0].trim() === label;
      return `   ${isTarget ? "❯" : " "} ${row[4]}. ${row[5]}`;
    })
    .join("\n");
}
/** ADAPTED: the MEASURED slider with the `▲` moved to tick `index` (10 columns
 *  per tick, as the two MEASURED frames show: medium at +10, high at +20). */
function effortSliderAt(index) {
  return EFFORT_SLIDER_MEASURED.split("\n")
    .map((line) => {
      const at = line.indexOf("▲");
      if (at < 0) return line;
      const start = line.indexOf("─");
      const body = line.slice(start).replace("▲", "─");
      const target = index * 10;
      return line.slice(0, start) + body.slice(0, target) + "▲" + body.slice(target + 1);
    })
    .join("\n");
}
const COMPOSER_IDLE_GRID = "❯ \n\n⏸ manual mode on · ← for agents";
// The user arrowed the parked dialog NATIVELY. ADAPTED from the MEASURED partial
// arrow-move repaint (claude 2.1.214): the row digit is DROPPED — `❯No, go back`.
const NATIVE_MOVE_TO_NO = "  Yes, switch to Sonnet 5\n❯No, go back";
// The dialog CLOSING: a cursor-less repaint before the `Kept …` line prints.
const CLOSE_REPAINT = "\x1b[2K\x1b[G❯ ";
const CLAUDE_MODEL_CANCEL = "⎿ Kept model as Opus 4.6";
const ARROW_LEFT = "\x1b[D";
const ARROW_RIGHT = "\x1b[C";
const APPLY = "s";

/** Drive a claude MODEL switch through the picker to the point where `s` has been
 *  pressed (phase applying). `startFocus` = the row the picker opens on (the
 *  CURRENT model, F89). Returns the writes made. */
function driveModelPickerToApply(host, engine, alias, { start = (e) => e.injectClaudeControlSwitch("model", alias), startFocus = "Fable" } = {}) {
  assert.equal(start(engine).ok, true, "the switch started");
  assert.deepEqual(host.writes, ["/model", "\r"], "the BARE picker command is typed — no alias, no persisted default");
  host.screen = modelPickerFocused(startFocus);
  engine.ingest("(picker paint)");
  let focus = startFocus;
  for (let i = 0; i < 8 && host.writes[host.writes.length - 1] !== APPLY; i++) {
    const last = host.writes[host.writes.length - 1];
    assert.ok(last === ARROW_DOWN || last === ARROW_UP, `a validated arrow is written (got ${JSON.stringify(last)})`);
    focus = PICKER_ORDER[PICKER_ORDER.indexOf(focus) + (last === ARROW_DOWN ? 1 : -1)];
    host.screen = modelPickerFocused(focus);
    engine.ingest("(post-arrow repaint)");
  }
  assert.equal(host.writes[host.writes.length - 1], APPLY, "`s` is pressed on the target row — session only");
  // `s` closes the picker (MEASURED); the grid shows the composer again.
  host.screen = COMPOSER_IDLE_GRID;
  return host.writes.slice();
}

/** Park a picker-driven claude cache-miss (target Sonnet, dialog painted across
 *  chunks — the B5 shape), returning { host, engine }. */
function driveToParkedCacheMiss(start) {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  driveModelPickerToApply(host, engine, "sonnet", start ? { start } : {});
  engine.ingest(CACHE_MISS_CHUNK_HEAD);
  engine.ingest(CACHE_MISS_CHUNK_NO_ROW);
  assert.equal(lastEvent(host.events).phase, "parked", "the cache-miss dialog parks the relay");
  // While parked the GRID shows the dialog (it is static until a key is pressed);
  // since the review round the relay's Enter is gated on exactly that (M5), so the
  // fake viewport must say what the real one would.
  host.screen = CACHE_MISS_CHUNK_HEAD + CACHE_MISS_CHUNK_NO_ROW;
  return { host, engine };
}

await check("U4: the model drive types the bare `/model`, waits for the GRID, walks by label, presses `s`", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    assert.equal(engine.injectClaudeControlSwitch("model", "haiku").ok, true, "the switch started");
    assert.deepEqual(host.writes, ["/model", "\r"], "bare command + Enter");
    host.screen = COMPOSER_IDLE_GRID;
    engine.ingest("(a frame before the picker paints)");
    assert.deepEqual(host.writes, ["/model", "\r"], "nothing is pressed until the picker is on the grid");
    host.screen = modelPickerFocused("Fable"); // opens on the CURRENT model (F89)
    engine.ingest("(picker paint)");
    assert.deepEqual(host.writes.slice(2), [ARROW_DOWN], "Fable → Haiku is downward; ONE arrow, then re-read");
    host.screen = modelPickerFocused("Fable");
    engine.ingest("(pre-move repaint)");
    assert.deepEqual(host.writes.slice(2), [ARROW_DOWN], "a pre-move repaint waits — no second press");
    host.screen = modelPickerFocused("Sonnet");
    engine.ingest("(landed on Sonnet)");
    assert.deepEqual(host.writes.slice(2), [ARROW_DOWN, ARROW_DOWN], "validated landing → the next arrow");
    host.screen = modelPickerFocused("Haiku");
    engine.ingest("(landed on Haiku)");
    assert.deepEqual(host.writes.slice(2), [ARROW_DOWN, ARROW_DOWN, APPLY], "on the target row: `s`, never Enter");
    assert.equal(lastEvent(host.events).phase, "pending", "still pending — the settle is the hook's");
  } finally {
    engine.clear();
  }
});

await check("U4: an unexpected cursor jump rolls back with ONE grid-verified Esc and needs-attention", async () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    engine.injectClaudeControlSwitch("model", "haiku");
    host.screen = modelPickerFocused("Fable");
    engine.ingest("(picker paint)");
    assert.equal(host.writes[host.writes.length - 1], ARROW_DOWN, "one arrow toward Haiku");
    host.screen = modelPickerFocused("Default (recommended)"); // the cursor went the WRONG way
    engine.ingest("(unexpected landing)");
    assert.equal(host.writes[host.writes.length - 1], ESC, "roll back: Esc the IDENTIFIED picker");
    host.screen = COMPOSER_IDLE_GRID;
    await delay(900);
    const last = lastEvent(host.events);
    assert.equal(last.phase, "needs-attention", "…and conclude needs-attention, never guess a row");
    assert.equal(host.writes.filter((w) => w === ESC).length, 1, "exactly one Esc");
  } finally {
    engine.clear();
  }
});

await check("U4: a native Esc mid-walk (picker already gone) writes NO rollback Esc", async () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    engine.injectClaudeControlSwitch("model", "haiku");
    host.screen = modelPickerFocused("Fable");
    engine.ingest("(picker paint)");
    // The user Esc'd the picker in the co-visible Terminal; our arrow's landing
    // never comes. The nav timeout fires → rollback → the grid says NO picker.
    host.screen = COMPOSER_IDLE_GRID;
    await delay(2800);
    assert.equal(lastEvent(host.events).phase, "needs-attention", "the timeout concludes needs-attention");
    assert.ok(!host.writes.includes(ESC), "…without a blind Esc into the composer");
  } finally {
    engine.clear();
  }
});

await check("U4: plain `opus` has NO picker row — fails loud by name, Esc, no walk", async () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    assert.equal(engine.injectClaudeControlSwitch("model", "opus").ok, true, "the switch starts (the menu still offers it)");
    host.screen = modelPickerFocused("Fable");
    engine.ingest("(picker paint)");
    assert.deepEqual(host.writes.slice(2), [ESC], "no arrow is ever pressed — the picker is Esc'd");
    host.screen = COMPOSER_IDLE_GRID;
    await delay(900);
    const last = lastEvent(host.events);
    assert.equal(last.phase, "failed", "a NAMED failure, not a generic needs-attention");
    assert.match(last.error, /Opus 5/, "…that names the model and points at a new chat");
  } finally {
    engine.clear();
  }
});

await check("U4: a target already marked ✔ current is a no-op — Esc, settled, no `s`", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    engine.injectClaudeControlSwitch("model", "fable"); // the frame's current model IS Fable
    host.screen = modelPickerFocused("Fable");
    engine.ingest("(picker paint)");
    assert.deepEqual(host.writes.slice(2), [ESC], "the identified picker is closed");
    const last = lastEvent(host.events);
    assert.equal(last.phase, "settled", "…and the switch settles (m2 arm c: `s` here fires nothing)");
    assert.ok(!last.cancelled, "…as a plain settle — the SSOT already says Fable");
  } finally {
    engine.clear();
  }
});

await check("U4: a row-table drift (target label absent from the live picker) rolls back as drift", async () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    engine.injectClaudeControlSwitch("model", "haiku");
    // ADAPTED: the live picker lost its Haiku row.
    host.screen = modelPickerFocused("Fable").split("\n").filter((l) => !/5\. Haiku/.test(l)).join("\n");
    engine.ingest("(picker paint)");
    assert.deepEqual(host.writes.slice(2), [ESC], "Esc the picker");
    host.screen = COMPOSER_IDLE_GRID;
    await delay(900);
    const last = lastEvent(host.events);
    assert.equal(last.phase, "needs-attention", "needs-attention…");
    assert.equal(last.reason, "drift", "…named as drift (the row table vs the live picker)");
  } finally {
    engine.clear();
  }
});

await check("U4: the EFFORT drive is a slider — one ←/→ per tick, then `s`, settled by the session-only receipt", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    assert.equal(engine.injectClaudeControlSwitch("effort", "high").ok, true, "the effort switch started");
    assert.deepEqual(host.writes, ["/effort", "\r"], "bare `/effort` + Enter");
    host.screen = EFFORT_SLIDER_MEASURED; // ▲ on medium (MEASURED)
    engine.ingest("(slider paint)");
    assert.deepEqual(host.writes.slice(2), [ARROW_RIGHT], "medium → high is one tick to the right");
    host.screen = EFFORT_SLIDER_HIGH_MEASURED; // ▲ on high (MEASURED after →)
    engine.ingest("(post-arrow repaint)");
    assert.deepEqual(host.writes.slice(2), [ARROW_RIGHT, APPLY], "on the tick: `s` (session only), never Enter");
    engine.noteModelSwitchConfirmed("high");
    assert.equal(lastEvent(host.events).phase, "pending", "a model hook cannot settle the effort axis");
    engine.ingest("⎿  Set effort level to high (this session only): Comprehensive implementation with extensive testing and documentation");
    const last = lastEvent(host.events);
    assert.equal(last.phase, "settled", "the MEASURED session-only receipt settles it (m2 arm e1)");
    assert.equal(last.kind, "effort");
    assert.equal(last.value, "high");
  } finally {
    engine.clear();
  }
});

await check("U4: effort two ticks left (medium → low) walks tick by tick with validation", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    engine.injectClaudeControlSwitch("effort", "low");
    host.screen = EFFORT_SLIDER_MEASURED;
    engine.ingest("(slider paint)");
    assert.deepEqual(host.writes.slice(2), [ARROW_LEFT], "one tick left");
    host.screen = effortSliderAt(0); // ADAPTED: ▲ on low
    engine.ingest("(landed on low)");
    assert.deepEqual(host.writes.slice(2), [ARROW_LEFT, APPLY], "`s` on low");
  } finally {
    engine.clear();
  }
});

await check("U4: a staged Save runs model then effort as ONE logical switch, both session-scoped", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    driveModelPickerToApply(host, engine, "sonnet", { start: (e) => e.startClaudeStagedSwitch("sonnet", "low") });
    const before = host.writes.length;
    engine.noteModelSwitchConfirmed("sonnet", "claude-sonnet-5");
    assert.deepEqual(host.writes.slice(before), ["/effort", "\r"], "the hook settles the model leg; the effort PICKER opens next");
    assert.equal(engine.hasPending(), true, "…as one logical switch — the effort leg is pending");
    host.screen = EFFORT_SLIDER_MEASURED;
    engine.ingest("(slider paint)");
    assert.equal(host.writes[host.writes.length - 1], ARROW_LEFT, "medium → low starts with one tick left");
  } finally {
    engine.clear();
  }
});

// ── the hook settle, on the picker drive ─────────────────────────────────────

await check("U3/U4: a PostModelSwitch for the pending alias settles the APPLYING phase", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    driveModelPickerToApply(host, engine, "haiku");
    engine.noteModelSwitchConfirmed("haiku", "claude-haiku-4-5-20251001");
    const last = lastEvent(host.events);
    assert.equal(last.phase, "settled", "the hook settles the switch");
    assert.equal(last.kind, "model");
    assert.equal(last.value, "haiku");
    assert.equal(engine.hasPending(), false, "nothing left in flight");
  } finally {
    engine.clear();
  }
});

await check("U4: the Fable row reports `requested_model` as `claude-fable-5-1[1m]` — the id match settles it", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    // MEASURED (m2 arm a, 2/2 runs): choosing the Fable row through the picker
    // reports `requested_model:"claude-fable-5-1[1m]"`, `to_model:"claude-fable-5-1"`.
    // The frame's current model is Fable, so use an ADAPTED frame with Haiku current.
    engine.injectClaudeControlSwitch("model", "fable");
    host.screen = modelPickerFocused("Haiku").replace("3. Fable ✔ ", "3. Fable   ").replace("5. Haiku ", "5. Haiku ✔ ");
    engine.ingest("(picker paint)");
    host.screen = modelPickerFocused("Sonnet").replace("3. Fable ✔ ", "3. Fable   ");
    engine.ingest("(landed Sonnet)");
    host.screen = modelPickerFocused("Fable").replace("3. Fable ✔ ", "3. Fable   ");
    engine.ingest("(landed Fable)");
    assert.equal(host.writes[host.writes.length - 1], APPLY, "`s` on Fable");
    engine.noteModelSwitchConfirmed("claude-fable-5-1[1m]", "claude-fable-5-1");
    assert.equal(lastEvent(host.events).phase, "settled", "the canonical id settles the alias `fable`");
  } finally {
    engine.clear();
  }
});

await check("U3: the bracketed `opus[1m]` alias round-trips; a bracket-stripped one does not", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    driveModelPickerToApply(host, engine, "opus[1m]");
    engine.noteModelSwitchConfirmed("opus[1m]", "claude-opus-5[1m]");
    assert.equal(lastEvent(host.events).phase, "settled", "the bracketed alias settles");
    engine.clear();
    host.writes.length = 0;
    driveModelPickerToApply(host, engine, "opus[1m]");
    engine.noteModelSwitchConfirmed("opus1m", null);
    assert.equal(lastEvent(host.events).phase, "pending", "a bracket-stripped alias with no id does not match");
  } finally {
    engine.clear();
  }
});

await check("U3: a PostModelSwitch settles a PARKED cache-miss dialog (a native Yes)", () => {
  const { host, engine } = driveToParkedCacheMiss();
  try {
    const writesBefore = host.writes.length;
    engine.noteModelSwitchConfirmed("sonnet", "claude-sonnet-5");
    const last = lastEvent(host.events);
    assert.equal(last.phase, "settled", "the parked relay settles on the hook");
    assert.equal(last.value, "sonnet");
    assert.ok(!last.cancelled, "…as an APPLY");
    assert.deepEqual(host.writes.slice(writesBefore), [], "Sonata wrote nothing — the user answered");
  } finally {
    engine.clear();
  }
});

await check("U3/U4: a parked Yes carries the staged effort leg through the hook — into the effort PICKER", () => {
  const { host, engine } = driveToParkedCacheMiss((e) => e.startClaudeStagedSwitch("sonnet", "low"));
  try {
    const writesBefore = host.writes.length;
    engine.noteModelSwitchConfirmed("sonnet", "claude-sonnet-5");
    assert.deepEqual(host.writes.slice(writesBefore), ["/effort", "\r"], "the effort leg opens its picker");
    assert.equal(engine.hasPending(), true, "…as ONE logical switch");
  } finally {
    engine.clear();
  }
});

await check("B5: a chunk-split park reads its cursor from the snapshot, not from the scan", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    driveModelPickerToApply(host, engine, "sonnet", { start: (e) => e.startClaudeStagedSwitch("sonnet", "low") });
    engine.ingest(CACHE_MISS_CHUNK_HEAD);
    assert.ok(!phasesOf(host.events).includes("parked"), "the half-painted dialog has not parked yet");
    engine.ingest(CACHE_MISS_CHUNK_NO_ROW);
    const parked = lastEvent(host.events);
    assert.equal(parked.phase, "parked");
    assert.equal(parked.dialog, "claude-cachemiss");
    engine.ingest(CACHE_MISS_TRAILING_BYTES);
    host.screen = CACHE_MISS_CHUNK_HEAD + CACHE_MISS_CHUNK_NO_ROW; // the dialog is on the grid while parked (M5 gate)
    const writesBefore = host.writes.length;
    engine.answerParkedControlConfirm(1);
    assert.deepEqual(host.writes.slice(writesBefore), ["\r"], "the snapshot's cursor is on the chosen row → confirm now");
    engine.ingest(CLAUDE_MODEL_RECEIPT);
    assert.deepEqual(host.writes.slice(writesBefore), ["\r"], "the receipt alone does not settle the model leg");
    engine.noteModelSwitchConfirmed("sonnet", "claude-sonnet-5");
    assert.deepEqual(host.writes.slice(writesBefore), ["\r", "/effort", "\r"], "the Yes settles the model leg and the effort picker opens");
    assert.ok(!host.writes.includes(ESC), "no rollback Esc");
  } finally {
    engine.clear();
  }
});

await check("U4: an injected No on a picker-raised dialog is Enter + ONE picker-closing Esc, then cancelled", async () => {
  const { host, engine } = driveToParkedCacheMiss();
  try {
    const writesBefore = host.writes.length;
    engine.answerParkedControlConfirm(2); // `No, go back` — the snapshot's cursor is on row 1
    // one arrow toward row 2, then (after the landing) Enter + the deferred Esc
    assert.deepEqual(host.writes.slice(writesBefore), [ARROW_DOWN], "one validated arrow first");
    engine.ingest(NATIVE_MOVE_TO_NO);
    assert.deepEqual(
      host.writes.slice(writesBefore),
      [ARROW_DOWN, "\r", ESC],
      "Enter on No, trailed by the Esc that closes the RETURNED picker (m2 arm d: pickerOpenAfterAnswer=true)",
    );
    host.screen = COMPOSER_IDLE_GRID;
    await delay(PARKED_CANCEL_VERIFY_WAIT_MS);
    const last = lastEvent(host.events);
    assert.equal(last.phase, "settled");
    assert.equal(last.cancelled, true, "…cancelled after the bounded beat");
    assert.equal(host.writes.filter((w) => w === ESC).length, 1, "exactly one Esc — the grid showed no picker afterwards");
  } finally {
    engine.clear();
  }
});

await check("U4: a NATIVE No leaves the picker open — the relay closes it with one grid-verified Esc", async () => {
  const { host, engine } = driveToParkedCacheMiss();
  try {
    // The user pressed No in the Terminal: dialog gone, PICKER back on the grid, `Kept …` printed.
    host.screen = modelPickerFocused("Sonnet");
    engine.ingest(CLOSE_REPAINT + "⎿ Kept model as Fable 5.1");
    assert.equal(lastEvent(host.events).phase, "parked", "nothing concluded inside the beat");
    await delay(PARKED_CANCEL_VERIFY_WAIT_MS);
    const last = lastEvent(host.events);
    assert.equal(last.phase, "settled");
    assert.equal(last.cancelled, true);
    assert.deepEqual(host.writes.slice(-1), [ESC], "the returned picker, IDENTIFIED on the grid, is Esc'd once");
  } finally {
    engine.clear();
  }
});

await check("B5: a native cursor move during the park outranks the snapshot", async () => {
  const { host, engine } = driveToParkedCacheMiss();
  try {
    // The user arrowed to row 2 INSIDE the dialog: the grid still shows the dialog
    // (cursor on No), the stream carries the move.
    host.screen = "Switch model?\nthe full history gets re-read on your next message.\n  1. Yes, switch to Sonnet 5\n❯ 2. No, go back";
    engine.ingest(NATIVE_MOVE_TO_NO);
    const writesBefore = host.writes.length;
    engine.answerParkedControlConfirm(2);
    assert.deepEqual(host.writes.slice(writesBefore), ["\r", ESC], "already on row 2 per the scan → Enter (+ the picker-closing Esc)");
    host.screen = "❯ "; // the dialog and the picker are gone by the time `Kept …` prints
    engine.ingest(CLAUDE_MODEL_CANCEL);
    await delay(PARKED_CANCEL_VERIFY_WAIT_MS);
    const settled = lastEvent(host.events);
    assert.equal(settled.phase, "settled");
    assert.equal(settled.cancelled, true);
  } finally {
    engine.clear();
  }
});

await check("B5: after a press, a cursor-less frame WAITS — the snapshot never validates a landing", async () => {
  const { host, engine } = driveToParkedCacheMiss();
  try {
    engine.ingest(NATIVE_MOVE_TO_NO);
    const writesBefore = host.writes.length;
    engine.answerParkedControlConfirm(1);
    assert.deepEqual(host.writes.slice(writesBefore), [ARROW_UP], "one arrow toward row 1, validated before any Enter");
    engine.ingest(CLOSE_REPAINT);
    assert.deepEqual(host.writes.slice(writesBefore), [ARROW_UP], "a cursor-less post-press frame presses NOTHING");
    host.screen = "❯ ";
    engine.ingest(CLAUDE_MODEL_CANCEL);
    await delay(PARKED_CANCEL_VERIFY_WAIT_MS);
    const settled = lastEvent(host.events);
    assert.equal(settled.phase, "settled");
    assert.equal(settled.cancelled, true);
    assert.deepEqual(host.writes.slice(writesBefore), [ARROW_UP], "the arrow is the ONLY byte — no blind Enter, no blind Esc");
  } finally {
    engine.clear();
  }
});

// ── SL-4 / U3: the stream can only REJECT a model switch, never settle one ────
const STALE_FAILURE_WINDOW = readFileSync(
  resolve(FIXTURES, "claude-midsession/stale-failure-repaint-2.1.258.txt"),
  "utf8",
);

await check("SL-4/U3: a repainted OLD rejection does not FAIL the switch in flight", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    driveModelPickerToApply(host, engine, "haiku");
    const eventsBefore = host.events.length;
    engine.ingest(STALE_FAILURE_WINDOW);
    assert.equal(lastEvent(host.events).phase, "pending", "not `failed` — the replayed rejection names another value");
    assert.equal(host.events.length, eventsBefore, "…and the poisoned window produces no verdict of any kind");
  } finally {
    engine.clear();
  }
});

await check("U3: the KNOWN RESIDUAL is CLOSED — a replayed success settles nothing", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    // `fable` is the frame's current model; use an ADAPTED frame with Haiku current so the walk happens.
    engine.injectClaudeControlSwitch("model", "fable");
    host.screen = modelPickerFocused("Haiku").replace("3. Fable ✔ ", "3. Fable   ").replace("5. Haiku ", "5. Haiku ✔ ");
    engine.ingest("(paint)");
    host.screen = modelPickerFocused("Sonnet").replace("3. Fable ✔ ", "3. Fable   ");
    engine.ingest("(Sonnet)");
    host.screen = modelPickerFocused("Fable").replace("3. Fable ✔ ", "3. Fable   ");
    engine.ingest("(Fable)");
    assert.equal(host.writes[host.writes.length - 1], APPLY);
    engine.ingest(STALE_FAILURE_WINDOW);
    assert.equal(lastEvent(host.events).phase, "pending", "CLOSED: a replayed success line for ANOTHER model settles nothing");
    assert.equal(engine.hasPending(), true, "…the switch awaits its hook");
  } finally {
    engine.clear();
  }
});

await check("U3: a DUPLICATE PostModelSwitch is a no-op", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    driveModelPickerToApply(host, engine, "haiku");
    engine.noteModelSwitchConfirmed("haiku", "claude-haiku-4-5-20251001");
    const afterFirst = host.events.length;
    engine.noteModelSwitchConfirmed("haiku", "claude-haiku-4-5-20251001");
    engine.noteModelSwitchConfirmed("haiku", "claude-haiku-4-5-20251001");
    assert.equal(host.events.length, afterFirst, "idempotent by construction");
  } finally {
    engine.clear();
  }
});

await check("U3: a PostModelSwitch for ANOTHER alias is ignored", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    driveModelPickerToApply(host, engine, "haiku");
    engine.noteModelSwitchConfirmed("sonnet", "claude-sonnet-5");
    assert.equal(lastEvent(host.events).phase, "pending", "a foreign alias does not settle this switch");
    assert.equal(engine.hasPending(), true);
    engine.noteModelSwitchConfirmed("haiku", "claude-haiku-4-5-20251001");
    assert.equal(lastEvent(host.events).phase, "settled", "…while the matching alias settles it");
  } finally {
    engine.clear();
  }
});

await check("U3: a PostModelSwitch with NO pending switch is a no-op", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    engine.noteModelSwitchConfirmed("haiku", "claude-haiku-4-5-20251001");
    assert.deepEqual(host.events, []);
    assert.deepEqual(host.writes, []);
  } finally {
    engine.clear();
  }
});

await check("U3: a PostModelSwitch BEFORE `s` (still navigating) settles nothing", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    engine.injectClaudeControlSwitch("model", "haiku");
    host.screen = modelPickerFocused("Fable");
    engine.ingest("(paint)");
    engine.noteModelSwitchConfirmed("haiku", "claude-haiku-4-5-20251001");
    assert.equal(lastEvent(host.events).phase, "pending", "a Post that cannot be ours (we have not pressed `s`) is ignored");
  } finally {
    engine.clear();
  }
});

await check("U3: the model axis does not settle on its OWN success receipt", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    driveModelPickerToApply(host, engine, "sonnet");
    engine.ingest("⎿  Set model to Sonnet 5 for this session only");
    assert.equal(lastEvent(host.events).phase, "pending", "the (session-only) receipt does not settle the model axis");
    engine.noteModelSwitchConfirmed("sonnet", "claude-sonnet-5");
    assert.equal(lastEvent(host.events).phase, "settled", "…the hook does");
  } finally {
    engine.clear();
  }
});

const CACHE_MISS_ON_GRID = CACHE_MISS_CHUNK_HEAD + CACHE_MISS_CHUNK_NO_ROW;

await check("U3: a `Kept model as …` line does NOT cancel while the dialog is still on the grid", async () => {
  const { host, engine } = driveToParkedCacheMiss();
  try {
    host.screen = CACHE_MISS_ON_GRID;
    engine.ingest(CLAUDE_MODEL_CANCEL);
    await delay(PARKED_CANCEL_VERIFY_WAIT_MS);
    assert.equal(lastEvent(host.events).phase, "parked", "the relay stays parked — the dialog is still up");
    host.screen = "❯ ";
    engine.ingest(CLAUDE_MODEL_CANCEL);
    await delay(PARKED_CANCEL_VERIFY_WAIT_MS);
    const last = lastEvent(host.events);
    assert.equal(last.phase, "settled");
    assert.equal(last.cancelled, true);
  } finally {
    engine.clear();
  }
});

await check("U3: a real cancel concludes after the bounded beat, with no Esc when nothing is left open", async () => {
  const { host, engine } = driveToParkedCacheMiss();
  try {
    host.screen = "❯ ";
    engine.ingest(CLOSE_REPAINT + CLAUDE_MODEL_CANCEL);
    assert.equal(lastEvent(host.events).phase, "parked", "nothing is concluded inside the beat");
    await delay(PARKED_CANCEL_VERIFY_WAIT_MS);
    const last = lastEvent(host.events);
    assert.equal(last.phase, "settled");
    assert.equal(last.cancelled, true);
    assert.ok(!host.writes.includes(ESC), "…no Esc: the grid shows neither dialog nor picker");
  } finally {
    engine.clear();
  }
});

await check("U3: a Yes whose repaint REPLAYS an old `Kept …` is not reported as a cancel", async () => {
  const { host, engine } = driveToParkedCacheMiss();
  try {
    host.screen = "❯ ";
    engine.ingest(CLOSE_REPAINT + CLAUDE_MODEL_CANCEL);
    assert.equal(lastEvent(host.events).phase, "parked");
    engine.noteModelSwitchConfirmed("sonnet", "claude-sonnet-5");
    const settled = lastEvent(host.events);
    assert.equal(settled.phase, "settled");
    assert.ok(!settled.cancelled, "…an APPLY, not the cancel the stream argued for");
    const afterSettle = host.events.length;
    await delay(PARKED_CANCEL_VERIFY_WAIT_MS);
    assert.equal(host.events.length, afterSettle, "the elapsed beat emits nothing after a settle");
  } finally {
    engine.clear();
  }
});

await check("U3/U4: the EFFORT axis keeps the bare cancel needle; a picker-raised effort dialog parks", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    engine.injectClaudeControlSwitch("effort", "low");
    host.screen = EFFORT_SLIDER_MEASURED;
    engine.ingest("(slider)");
    host.screen = effortSliderAt(0);
    engine.ingest("(low)");
    assert.equal(host.writes[host.writes.length - 1], APPLY, "`s` on low");
    engine.ingest(
      "Change effort level?\nThis conversation is cached for the current effort. Switching to low means " +
        "the full history gets re-read on your next message.\n❯ 1. Yes, switch to low\n  2. No, go back\n",
    );
    assert.equal(lastEvent(host.events).phase, "parked", "the effort dialog parks the relay (m2 arm e1: raised on `s` too)");
    host.screen = CACHE_MISS_ON_GRID;
    engine.ingest("⎿ Kept effort level as medium");
    const last = lastEvent(host.events);
    assert.equal(last.phase, "settled", "the effort cancel needle still fires on its own");
    assert.equal(last.cancelled, true);
  } finally {
    engine.clear();
  }
});

await check("U4: an EXTERNAL clear mid-picker Escs the open picker exactly once", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    engine.injectClaudeControlSwitch("model", "haiku");
    host.screen = modelPickerFocused("Fable");
    engine.ingest("(paint)"); // picker seen open, one arrow pressed
    const before = host.writes.length;
    engine.clear(); // a run starting / PTY teardown
    assert.deepEqual(host.writes.slice(before), [ESC], "an abandoned picker would eat the next keystroke — close it");
  } finally {
    engine.clear();
  }
});


// ── review round (D2 U4): B1 / M3 / M4 ────────────────────────────────────────

await check("U4/B1: a parked-relay FAILURE on a picker-raised dialog also closes the RETURNED picker (two grid-verified Escs)", async () => {
  const { host, engine } = driveToParkedCacheMiss();
  try {
    // The user answered Yes in the drawer; the cursor is on row 1 → Enter →
    // `confirming`. Then nothing arrives (hook lost): the 4 s settle window fires.
    engine.answerParkedControlConfirm(1);
    assert.equal(host.writes[host.writes.length - 1], "\r", "Enter on the chosen row");
    // Simulate the timeout path directly through its measured screen sequence:
    // after the rollback Esc the DIALOG closes and the PICKER is back (F103).
    host.screen = modelPickerFocused("Sonnet");
    await delay(4300); // PARKED_CONFIRM_SETTLE_TIMEOUT_MS (4000) → failParked → Esc
    const escsAfterFirst = host.writes.filter((w) => w === ESC).length;
    assert.equal(escsAfterFirst, 1, "the first Esc (the dialog) has been written");
    assert.equal(engine.hasPending(), true, "…and the relay has NOT concluded while the picker is on the grid");
    // The verify tick reads the grid, sees the picker, Escs it; the next tick sees the composer.
    await delay(1000);
    host.screen = COMPOSER_IDLE_GRID;
    await delay(1000);
    assert.equal(host.writes.filter((w) => w === ESC).length, 2, "the second Esc closed the returned picker");
    assert.equal(engine.hasPending(), false, "…and only then did the relay conclude");
    assert.equal(lastEvent(host.events).phase, "needs-attention", "needs-attention, with no picker left to eat the next prompt");
  } finally {
    engine.clear();
  }
});

await check("U4/M3: a transcript line above the picker cannot forge a focused row", () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    engine.injectClaudeControlSwitch("model", "haiku");
    // ADAPTED: the user's earlier prompt `❯ 5. Haiku please` sits in the transcript
    // ABOVE the picker; the real cursor is on Fable.
    host.screen = modelPickerFocused("Fable").replace("   Select model", "❯ 5. Haiku please\n   Select model");
    engine.ingest("(paint)");
    assert.equal(host.writes[host.writes.length - 1], ARROW_DOWN, "the drive walks from Fable — it did not press `s` on a forged Haiku");
  } finally {
    engine.clear();
  }
});

await check("U4/M4: an opening frame with rows but no legible cursor arms the nav timeout (no permanent pending)", async () => {
  const host = makeHost("claude");
  const engine = new ControlSwitchEngine(host);
  try {
    engine.injectClaudeControlSwitch("model", "haiku");
    // ADAPTED: rows painted, `❯` not yet.
    host.screen = modelPickerFocused("Fable").replace("   ❯ 3. Fable", "     3. Fable");
    engine.ingest("(paint without cursor)");
    assert.deepEqual(host.writes.slice(2), [], "nothing pressed without a cursor");
    assert.equal(engine.hasPending(), true, "pending, awaiting the cursor…");
    host.screen = COMPOSER_IDLE_GRID; // the user closed it natively meanwhile
    await delay(2800 + 800);
    assert.equal(engine.hasPending(), false, "…but bounded: the nav timeout concluded it");
    assert.equal(lastEvent(host.events).phase, "needs-attention");
    assert.ok(!host.writes.includes(ESC), "and no blind Esc — the grid showed no picker");
  } finally {
    engine.clear();
  }
});

await check("U4/M5: the parked Enter is gated on the dialog still being on the GRID", () => {
  const { host, engine } = driveToParkedCacheMiss();
  try {
    // The user answered natively; the dialog is gone and the PICKER is back, but
    // the stream still holds the dialog's cursor bytes.
    host.screen = modelPickerFocused("Sonnet");
    const before = host.writes.length;
    engine.answerParkedControlConfirm(1); // snapshot cursor is on row 1 → would Enter
    assert.deepEqual(host.writes.slice(before), [], "NO Enter — the grid shows no dialog (an Enter here would hit the picker = persisted switch)");
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
