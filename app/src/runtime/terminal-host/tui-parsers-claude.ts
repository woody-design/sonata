import { cleanTerminal } from "./tui-parsers-common";

// ── Pure Claude TUI parsers (consolidation S4) ───────────────────────────────
// Moved verbatim from terminal-host.ts: Remote Control detection, the screen
// owners that gate readiness (Rewind panel, fullscreen boot offer,
// workspace-trust rows), and the permission mode-line footer needle. All pure
// (take a RAW tail or a rendered viewport, return a verdict); unit-pinned by
// tests/smoke/remote-control-detect-units.mjs and the readiness smokes.
// Provenance comments are preserved intact — every anchor here is
// probe-measured, not assumed.

// ── Remote Control detection — TWO channels, one per SIGNAL KIND (D-1) ───────
// Unit-pinned in tests/smoke/remote-control-detect-units.mjs; consumed by
// TerminalHost.detectRemoteControlState. RE-MEASURED at claude 2.1.258 (upstream
// sync 2026-09-01, SL-11 — probes rc3/rc5/rc6, findings F4b/F4c/F4d), and the
// re-measurement MOVED one of the two channels:
//
//   OFF  → the raw pty STREAM. `Remote Control disconnected.` is a one-shot
//          EVENT, and the grid is the wrong place to read it: rc6 measured the
//          line STILL on screen after a reconnect had already succeeded, so a
//          grid read would report a live session as dead.
//   URL  → the reconstructed SCREEN. Was a stream read, and that is what broke.
//          See findRemoteControlUrlOnScreen for the measured byte sequence.
export const REMOTE_CONTROL_SCAN_LIMIT = 2048;
/** The session link, ANCHORED to the sentence claude wraps around it. Both
 *  alternations are MEASURED verbatim at 2.1.258 and are the only two link-
 *  bearing forms the probes ever rendered (rc1/rc3/rc5/rc6):
 *
 *    the native panel, link on the SAME line
 *      This session is available in the Claude mobile app and at https://…
 *    the boot / re-connect banner, link on the NEXT line
 *      /remote-control is active · Continue here, on your phone, or at
 *      https://…
 *
 *  `\s+` spans both cases (the grid joins rows with "\n"). See
 *  findRemoteControlUrlOnScreen for why the anchor is load-bearing rather than
 *  decorative. */
const REMOTE_CONTROL_LINK_RE =
  /(?:available in the Claude mobile app and at|Continue here, on your phone, or at)\s+(https:\/\/claude\.(?:ai|com)\/code\/session_[A-Za-z0-9_-]+)/;

/** Strip CSI escapes and ALL whitespace. claude word-positions panel/result text
 *  with cursor moves (`\x1b[NG`) instead of spaces, so a positioned line glues
 *  after stripping — matching the compacted form is whitespace- and
 *  position-insensitive. Apply to the accumulated RAW tail so a split landing
 *  inside an escape reassembles before stripping. */
export function compactRemoteControlScan(raw: string): string {
  return raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\s+/g, "");
}

/** The OFF signal: claude's "Remote Control disconnected." Case kept (its own
 *  capitalization) so lowercase model prose can't trip it; the glued form also
 *  excludes the panel option "Disconnect this session" and the slash menu.
 *  STILL EXACT at 2.1.258 (rc3 arm B: the production 2048-char rolling tail
 *  matched 504ms after the native panel's "Disconnect this session"). */
export function hasRemoteControlDisconnect(compact: string): boolean {
  return compact.includes("RemoteControldisconnected");
}

/**
 * The session link (for display), or null — read off the RECONSTRUCTED SCREEN,
 * never the pty stream.
 *
 * WHY NOT THE STREAM (rc5, DECISIVE — this is what moved). Since 2.1.252 claude
 * paints in the alternate screen and repaints DIFFERENTIALLY, emitting only the
 * cells that changed. When the RC panel's link line is repainted over text that
 * already occupies those columns, the characters that are ALREADY CORRECT are
 * not re-emitted. Measured verbatim, injecting at the composer edge:
 *
 *     at https:\x1b[69G/claude.ai/code/session_….
 *
 * Escapes stripped, that stream reads `at https:/claude.ai/…` — ONE slash. The
 * `//` never enters the stream at all, so no amount of re-anchoring a stream
 * regex can find it, and compacting whitespace (the trick that makes the OFF
 * needle position-proof) cannot help either: the bytes are absent, not spaced.
 * The same session, injected 3s later, painted the line contiguously and the old
 * stream read worked — which is exactly why this was intermittent rather than
 * simply broken, and why `remote-control-disconnect.mjs` failed while a hand
 * run of the same steps passed.
 *
 * The grid has no such gap: it is the surface those positioned writes are
 * addressing, so it holds the assembled line. rc5 measured all three injection
 * moments finding the link on the grid within 150–760ms, including the one where
 * the stream never produced it in 45 seconds.
 *
 * WHY IT IS ANCHORED TO THE SENTENCE, not just to the link shape. Moving to the
 * grid WIDENED the false-positive surface, and pretending otherwise would be the
 * dishonest half of this change. The retired stream reader could only ever see
 * bytes that arrived AFTER activation — `remoteControlScan` is cleared on every
 * transition — so a link printed earlier in the session was structurally out of
 * reach. A whole-viewport read has no such fence: it sees everything on screen
 * at the moment RC turns on, and because the value LATCHES (captured once, held
 * for the whole connection) one wrong read is not self-correcting. Ordering
 * cannot fix it either — the panel paints LOW (rows 33–39 of 40), so a
 * model-quoted or user-pasted `claude.ai/code/session_…` above it would win on
 * first-match, and the composer sits BELOW it, so last-match would lose to a
 * pasted one. The discriminating signal is neither position nor shape but
 * CONTEXT: claude's own sentence around the link.
 *
 * What that leaves. A bare link anywhere on screen is now ignored, which is the
 * whole point. The residual is a model that reproduces one of claude's two
 * sentences verbatim AND follows it with a link — narrower than a bare URL by a
 * wide margin, and stated rather than denied. The failure direction is also the
 * right one: an upstream reword makes the popover show "Connecting…" while RC
 * works (visible, harmless, recoverable), where the unanchored version would
 * hand the user someone else's session link and look correct doing it.
 *
 * FIRST match: rc6 measured the disconnect redraw clearing EVERY link row from
 * the grid, and measured the banner and the open panel carrying the SAME id
 * while both are visible — so among ANCHORED matches there has never been more
 * than one session to choose between.
 *
 * Still guarded upstream by "activation is OUR signal" — see
 * detectRemoteControlState. This function never turns RC on; it only fills in
 * the link of a connection Sonata already asked for.
 */
export function findRemoteControlUrlOnScreen(screenText: string): string | null {
  return cleanTerminal(screenText).match(REMOTE_CONTROL_LINK_RE)?.[1] ?? null;
}
// Claude REWIND panel (upstream sync 2026-08-03, claude 2.1.216+). An Esc PAIR
// at an idle composer opens a restore picker over the composer — measured live
// at 2.1.220 (spikes/upstream-sync-2026-08/claude/, probes q3a/q3b/q3c): the
// pair fires at inter-Esc gaps ≤700ms and not at ≥800ms, and ONE Esc dismisses
// it cleanly. Two frames, both captured verbatim:
//
//   with history (q4q3b-activity-esc.capture.txt, "Q3b — Esc, 50ms, Esc"):
//     Rewind
//     Restore the code and/or conversation to the point before…
//       <the prompt text of the checkpoint>
//       No code changes
//     ❯ (current)
//     Enter to continue · Esc to cancel
//
//   empty history (q3a-esc-nohistory.capture.txt, "B — Esc, 50ms, Esc"):
//     Rewind
//     Nothing to rewind to yet.
//     Esc to cancel
//
// WHY THIS IS A RED LINE. The panel's `Enter to continue` is a RESTORE — it
// rewrites the conversation (and, on a checkpoint with changes, the code) back
// to the highlighted row. A delivered prompt pastes text and presses Enter, so
// a panel nobody noticed would answer itself. That is the codex trust-dialog
// silent-Yes lineage (terminal-host `bootDialogHints`), one class worse: the
// trust dialog's default row is recoverable, a restore is not.
//
// READS THE SCREEN GRID, NOT THE STREAM — D-1's standing rule ("state query →
// grid, event detection → stream"), applied on measured drift rather than by
// decree. "Is a modal on screen?" is a state query, and the first cut of this
// predicate proved why the rule exists. It scanned the pty tail and needed a
// LIVENESS rule to tell a live panel from a dismissed one still sitting in the
// tail: the last `❯` had to precede the panel's footer. Claude's renderer diffs
// PER LINE, so that rule is defeated by an ARROW MOVE inside the list — measured
// in this capture family (q2a-model-picker RAW stream: the footer is emitted
// exactly ONCE for a whole four-arrow session, each arrow emitting only a fresh
// `❯` + row fragment). Arrowing off `(current)` onto a real checkpoint therefore
// puts a bare `❯` after the footer and the stream predicate read CLOSED — in
// precisely the sub-state where Enter is destructive. The grid has no such
// failure: it converges to the CURRENT screen whatever the paint order, a
// dismissed panel simply leaves the viewport, and cursor position is irrelevant
// because the panel is either displayed or it is not.
//
// Recognition is CO-OCCURRENCE — a single substring is forgeable by assistant
// prose (S2's lesson), and this panel's own body text is exactly the kind of sentence a
// session discussing Sonata would print. Each variant needs its distinctive
// BODY *and* its FOOTER. The title `Rewind` carries no independent weight (it
// is a substring of "Nothing to rewind…"), so it is not required separately.
// Compacted (whitespace removed) like every other claude parser here: on grid
// rows that also makes the match indifferent to column wrapping, and it keeps
// the needles identical to the stream-era ones. The `·` separator survives.
const CLAUDE_REWIND_HISTORY_BODY_RE = /Restorethecodeand\/orconversationtothepointbefore/;
const CLAUDE_REWIND_HISTORY_FOOTER_RE = /Entertocontinue·Esctocancel/;
const CLAUDE_REWIND_EMPTY_BODY_RE = /Nothingtorewindtoyet\./;
const CLAUDE_REWIND_EMPTY_FOOTER_RE = /Esctocancel/;

/** The claude Rewind panel is on the SCREEN — pass a rendered viewport
 *  (`TaskScreenModel.viewportText()`), never a pty tail. Requires a variant's
 *  body AND its footer, both visible in the same frame.
 *
 *  Callers treat this as a screen owner for readiness (it is not a composer).
 *  A Send while it is open lands in it, as a terminal Enter would (X2).
 *  Sonata NEVER dismisses it — one Esc would close it, but the user may have
 *  opened it deliberately in the co-visible CLI, and answering a screen the user
 *  may be using is the standing red line. Recognition + hold + surface only.
 *
 *  No liveness rule and no scan window: a viewport is already scoped to the
 *  current screen, which is the whole reason this reads the grid (see above). */
export function claudeRewindPanelOpen(screenText: string): boolean {
  // `cleanTerminal` is a near-noop on plain grid rows (S4a Q1) but is kept so a
  // caller handing over a still-escaped frame cannot silently miss.
  const compact = cleanTerminal(screenText).replace(/\s+/g, "");
  return (
    (CLAUDE_REWIND_HISTORY_BODY_RE.test(compact) &&
      CLAUDE_REWIND_HISTORY_FOOTER_RE.test(compact)) ||
    // The empty variant is KEPT even though its Enter restores nothing (there is
    // nothing behind "Nothing to rewind to yet."): it is still a modal over the
    // composer, so a delivered prompt's text goes nowhere useful and its Enter is
    // a guess. Its footer token `Esctocancel` is a prefix of the approval
    // panel's `Esctocancel·Tabtoamend`, which mattered on the stream (a stale
    // rewind body could pair with a live approval footer) and cannot matter on
    // the grid: the two are full-screen modals in the alternate buffer and never
    // share a viewport, so the body needle is never present on an approval frame.
    (CLAUDE_REWIND_EMPTY_BODY_RE.test(compact) && CLAUDE_REWIND_EMPTY_FOOTER_RE.test(compact))
  );
}

// Claude FULLSCREEN-RENDERER OFFER — the boot interstitial (upstream sync
// 2026-09-01, SL-3; claude 2.1.257). MEASURED verbatim — the catalog and the
// numbers below are `spikes/upstream-sync-2026-09/claude/findings.md` F7/F8
// (tracked; the probe captures it cites are not, per D6), and the frame itself
// is the tracked fixture `tests/fixtures/claude-boot/fullscreen-offer-2.1.257.txt`:
//
//   Try the new fullscreen renderer?
//
//   · Flicker-free output — fixes the flashing you see during long responses
//   · Mouse support — click to move your cursor or expand results
//   · Selected text auto-copies to your clipboard
//
//   ❯ 1. Yes, try it
//     2. Not now
//
//   Enter to confirm · Esc to cancel
//
// WHERE IT SITS IN THE CEREMONY. On the NORMAL screen, after the workspace-trust
// grant and BEFORE the `?1049h` alternate-screen switch (F7: the switch never
// happens while the offer is unanswered), and before the session starts — the
// SessionStart hook did not arrive in 60s of the offer standing open. That last
// fact is why a readiness guard can work at all: `acceptsPromptInput()`'s
// hook short-circuit is not yet armed, so a screen-owner gate is reachable.
//
// WHY IT IS A RED LINE. MEASURED (F8a) — writing exactly what a send writes
// at an open boot latch, a bracketed paste followed by the submit CR:
//   - the paste is DISCARDED (screen byte-identical; the payload never appears);
//   - the CR answers the FOCUSED row, `1. Yes, try it`;
//   - the CLI switches renderer and RE-EXECS IN PLACE (same pid, argv rewritten
//     from `claude …` to `…/claude.exe …`);
//   - the user's prompt is GONE — no text, no receipt, no error.
// That is the codex silent-Yes lineage (terminal-host `bootDialogHints`,
// field-hit 2026-07-17) on the claude side, with a config change the user never
// asked for on top. (The changelog's "accepting drops the spawn flags" is
// FALSIFIED at 2.1.257: `--settings` and `--permission-mode` both survived the
// re-exec, reordered. The lost PROMPT is the harm, not lost flags.)
//
// WHY A GUARD IS ENOUGH — the offer does NOT capture input invisibly. A stray
// printable key at this screen leaves it byte-identical AND does not resurface
// in the composer once the offer is answered (F8b), so holding until the
// human answers in the co-visible Terminal loses nothing. Sonata NEVER answers
// it: `1. Yes, try it` restarts the CLI under a different renderer, which is a
// configuration decision about the user's own tool.
//
// WHY THIS IS NOT `bootDialogHints`. Codex's boot guard works by ORDERING inside
// `detectIdlePrompt` — its needles must paint AFTER the composer glyph so they
// outrank it. Here the distinctive text paints BEFORE the `❯`: everything after
// the cursor row is `2. Not now` and `Enter to confirm · Esc to cancel`, and the
// footer is ALREADY in the needle list twice (CLAUDE_PANEL_END_MARKERS and the
// workspace-trust hints), which is the incidental reason readiness happens to
// hold today. Incidental is the problem: tool panels already dropped
// `Enter to confirm` once, at 2.1.17x, and if this footer follows them the
// composer scan opens onto a modal whose Enter re-execs the CLI. A screen-owner
// predicate keys on the offer's OWN identity instead, which is also what D-1
// asks for — "is a modal on screen" is a state query, so it reads the grid.
//
// ── RECOGNITION, and why a co-occurrence of two substrings is NOT enough here ──
//
// This predicate outranks the SessionStart short-circuit, and the boot latch it
// gates is ONE-WAY (`TerminalHost.bootLatched()` never re-closes, and
// nothing re-reads the scrape afterwards). So a FALSE POSITIVE is not the mild
// failure it is for the Rewind panel, whose own hold self-clears on the next
// repaint: here it wedges the latch shut for the life of the session, with the
// first message held over a static screen and no override left. The
// forgery that reaches it is real and specific — claude ≥2.1.186 REPAINTS
// TRANSCRIPT HISTORY on a resumed session (the documented reason the hook
// short-circuit exists at all), so a session that once discussed this screen
// brings its wording back onto the grid at boot. A pasted frame does the same.
//
// Three conditions, therefore, and the third is the one that does the work:
//
//   1. the QUESTION, LINE-SCOPED and anchored — the whole compacted line must BE
//      the question, so prose that merely contains it ("the offer asks Try the
//      new fullscreen renderer? before…") cannot match;
//   2. the AFFIRM ROW, LINE-SCOPED and anchored, absorbing an optional cursor
//      and an optional digit (`parseClaudeTrustDialogRows` below records what
//      happened when 2.1.252 stripped the digits off the trust rows — the same
//      hand can strip these);
//   3. NO PERMISSION MODE LINE ON SCREEN. This is the structural discriminator,
//      and it is what a needle count can never be. The real offer paints BEFORE
//      the session starts: there is no composer on that screen and no permission
//      mode to display, MEASURED absent in every captured offer frame. Every
//      forgery, by construction, has a LIVE COMPOSER under it — a history
//      repaint, a paste, model prose — and F6 measured that claude's composer
//      footer carries a glyph-anchored mode line in every mode.
//      So the negative separates "the offer owns the screen" from "the offer's
//      words are on a screen the composer owns", which is exactly the question.
//      `CLAUDE_MODE_LINE_ON_SCREEN_RE` is reused rather than restated (it is
//      already S2's tested vocabulary, and already glyph-anchored precisely to
//      keep prose out of a screen-state answer). Declared further down this
//      file; read at call time, so the reference is fine.
//      MEASURED BOUNDARY (SL-5, q17 arm D at 2.1.258): the footer mode line is
//      not unconditional. A single Ctrl-C at an idle composer REPLACES that row
//      with `Press Ctrl-C again to exit` for ~1–2s, so for that window a live
//      composer has no mode line. F6's "never absent" was over-stated and is
//      corrected here rather than relied on.
//
//      Be exact about what that costs: for the RESUMED-REPAINT forgery class —
//      a screen carrying the offer's question line and affirm row over a live
//      composer — the discriminator is the ONLY thing standing between them and
//      a true verdict, so during that window the guard genuinely fires on a
//      screen it should not. The surface is open, not merely wider, and
//      `claude-boot-interstitial.mjs` pins that false positive as expected
//      behaviour so it stays visible.
//
//      What makes it survivable is the SHAPE of the consequence, not its
//      absence. (a) The guard's only effect is a readiness HOLD; recognition
//      writes nothing to the pty (RED LINE), so a false hold costs latency,
//      never an action. (b) It is not a latch: `acceptsPromptInput()`
//      re-evaluates on every call and the boot-latch poll re-checks it about
//      every 500ms, so the hold lifts on the first poll after the hint clears —
//      bounded by the hint's own ~1–2s lifetime, not by the session's. The
//      one-way boot latch is what would have made a false hold permanent, and
//      this hold expires before it can be the thing that keeps the latch shut.
//      (c) POST-latch it costs nothing at all: this guard feeds readiness ONLY
//      (see `isFullscreenOfferOpen`), and nothing gates a send once the latch
//      opens.
//
//      Narrowing it further would mean a second composer-presence signal, which
//      is a readiness question, not this one.
//
// REJECTED — adding a third BODY needle from the offer's feature bullets
// (`Flicker-free output`, `Mouse support`). It points the wrong way: every
// additional REQUIRED needle makes the guard fire LESS, so a single reworded
// marketing bullet fails the guard OPEN onto the modal whose Enter destroys the
// prompt — the harmful direction. It also does not close the forgery it was
// meant to close, because a repaint or paste of the frame carries the bullets
// too. Condition 3 costs nothing on the fire-less axis (the real frame cannot
// have a mode line) and closes the whole class.
//
// KNOWN BOUNDARY: the anchored question line assumes the offer's own line does
// not WRAP, which holds for any viewport at least ~34 columns wide. Below that
// the guard reads closed — the same viewport-too-narrow boundary `isCodexTrustDialog`
// documents, and the same direction: a pane that small has bigger problems.
const CLAUDE_FULLSCREEN_OFFER_QUESTION_LINE_RE = /^trythenewfullscreenrenderer\?$/i;
const CLAUDE_FULLSCREEN_OFFER_AFFIRM_LINE_RE = /^❯?\d*\.?yes,tryit$/i;

/** Claude's fullscreen-renderer boot offer owns the SCREEN — pass a rendered
 *  viewport (`TaskScreenModel.viewportText()`), never a pty tail.
 *
 *  Treated as a screen owner by readiness: the boot latch must not open on it,
 *  because a held first message's Enter would answer the offer and destroy the
 *  prompt (see above). Recognition + hold only; Sonata writes nothing here. */
export function claudeFullscreenOfferOpen(screenText: string): boolean {
  const cleaned = cleanTerminal(screenText);
  // A composer is on screen, so whatever else is here is CONTENT, not a boot
  // modal. Checked first: it is the cheap single test, and it is the one that
  // makes a resumed session's history repaint safe.
  if (CLAUDE_MODE_LINE_ON_SCREEN_RE.test(cleaned)) {
    return false;
  }
  let question = false;
  let affirm = false;
  for (const line of cleaned.split("\n")) {
    // Compacted per line (escapes + all whitespace removed), like every other
    // claude row reader here: it absorbs word-position painting and makes the
    // stream's collapsed spacing read the same as a laid-out grid row.
    const compact = line.replace(/\s+/g, "");
    if (CLAUDE_FULLSCREEN_OFFER_QUESTION_LINE_RE.test(compact)) {
      question = true;
    } else if (CLAUDE_FULLSCREEN_OFFER_AFFIRM_LINE_RE.test(compact)) {
      affirm = true;
    }
  }
  return question && affirm;
}

// Claude WORKSPACE-TRUST dialog rows (upstream sync 2026-09-01, claude 2.1.252).
// The boot dialog that asks whether the workspace may be trusted. Two rows, one
// `❯` cursor, answered ONLY by moving that cursor and pressing Enter.
//
// WHY A ROW READER AT ALL. Through 2.1.220 the affirm row was BOTH first and the
// default, and it carried a digit, so a bare Enter (or a `1`) answered it — a
// static key sufficed. At 2.1.252 both of those facts are gone (MEASURED,
// spikes/upstream-sync-2026-09/claude/q3-trust-variants.capture.txt):
//
//   2.1.176:  ❯ 1. Yes, I trust this folder      2.1.252:  ❯ No, exit
//                2. No, exit                                 Yes, I trust this folder
//
// so the affirm row moved from first to second, lost its digit (a digit is now
// inert — measured: `1` on the live dialog left the screen byte-identical), and
// the default row became the DECLINE, whose Enter exits the CLI with status 1.
// Both of Sonata's old approve encodings were measured killing the session on
// this screen: plain `\r` and CSI-u Enter (`\x1b[13u`) each exited 1.
//
// Because the affirm row's POSITION is the thing that moved, the answer path
// must not assume a direction: it reads both rows' screen positions here and
// steps toward the affirm one. That keeps the same code correct on the 2.1.176
// layout (affirm above) and on 2.1.252 (affirm below).
//
// READS THE SCREEN GRID, NOT THE STREAM — D-1's standing rule. "Which row holds
// the cursor" is a STATE query, and claude repaints an arrow move as a per-line
// cell diff (measured in the same capture: one Down emits only ` No, exit` +
// `❯Yes, I trust this folder` fragments), so a stream tail carries every cursor
// position the dialog ever had and cannot say which one is current. The grid
// converges to the current screen, so it can.
//
// Row identity is the row LABEL, matched per line in compacted space (escapes +
// all whitespace removed) so word-position painting and column wrapping cannot
// break it, and so an optional leading `1.`/`2.` is absorbed. BOTH rows are
// required (co-occurrence, as with the Rewind predicate): a
// single label is forgeable by assistant prose, and a half-read dialog is
// exactly the state in which a guessed keypress is destructive.
const CLAUDE_TRUST_AFFIRM_ROW_RE = /yes,itrustthisfolder/i;
const CLAUDE_TRUST_DECLINE_ROW_RE = /no,exit/i;
const CLAUDE_TRUST_CURSOR = "❯";

export interface ClaudeTrustDialogRows {
  /** Screen-row index of `Yes, I trust this folder`. */
  affirmIndex: number;
  /** Screen-row index of `No, exit`. */
  declineIndex: number;
  /** Which row carries the `❯` cursor; null when neither does (mid-repaint —
   *  the caller must WAIT, never guess). */
  focused: "affirm" | "decline" | null;
}

/**
 * The trust dialog's two rows and the cursor's position, read off a rendered
 * viewport. Null when the screen does not show BOTH rows — i.e. this is not the
 * trust dialog (or not all of it), so nothing may be pressed at it.
 *
 * The intended input is ONE screen (the grid). Last occurrence wins per row, so
 * raw text still resolves to its most recent paint — but only the grid
 * guarantees the rows and the cursor come from the SAME paint, which is why the
 * answer path reads the grid (D-1) and not the pty tail.
 */
export function parseClaudeTrustDialogRows(screenText: string): ClaudeTrustDialogRows | null {
  let affirmIndex = -1;
  let declineIndex = -1;
  let focused: "affirm" | "decline" | null = null;
  const lines = cleanTerminal(screenText).split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const compact = line.replace(/\s+/g, "");
    const isAffirm = CLAUDE_TRUST_AFFIRM_ROW_RE.test(compact);
    const isDecline = !isAffirm && CLAUDE_TRUST_DECLINE_ROW_RE.test(compact);
    if (!isAffirm && !isDecline) {
      continue;
    }
    if (isAffirm) {
      affirmIndex = index;
    } else {
      declineIndex = index;
    }
    // The cursor is read from the row it decorates, so the composer's own bare
    // `❯ ` prompt (never followed by a row label) can never be mistaken for it.
    if (compact.includes(CLAUDE_TRUST_CURSOR)) {
      focused = isAffirm ? "affirm" : "decline";
    }
  }
  if (affirmIndex < 0 || declineIndex < 0) {
    return null;
  }
  return { affirmIndex, declineIndex, focused };
}

// Claude's permission MODE LINE — the composer footer that names the session's
// mode. Sonata reads it only as a SCREEN-SHAPE fact ("a composer footer is
// painted"), never as the mode: the hook payload's `permission_mode` is the mode
// SSOT. RE-MEASURED at claude 2.1.258 (upstream sync 2026-09-01, SL-5 —
// spikes/upstream-sync-2026-09/claude/q17/q18); the phrases:
//   default (Manual) ↔ `⏸ manual mode on`    acceptEdits ↔ `⏵⏵ accept edits on`
//   plan             ↔ `⏸ plan mode on`      auto        ↔ `⏵⏵ auto mode on`
//   dontAsk          ↔ `⏵⏵ don't ask on`
//
// ANCHORED on the leading status glyph (measured — spikes/glyph-capture.mjs):
// every mode line's phrase is immediately preceded by one of exactly two glyphs —
// `⏸` U+23F8 (manual/plan) or `⏵⏵` U+23F5 U+23F5 (accept edits/auto/don't ask).
// The glyph is a boundary prose can't forge: without it, assistant prose
// containing the phrase ("…I'll turn plan mode on…") would read as a footer.
const MODE_LINE_GLYPH = "[\\u23f8\\u23f5]";
/** The mode-line phrases — the ONE source the readiness footer needle
 *  (`terminal-host.ts`, `idlePromptModelHints`) and the fullscreen-offer
 *  discriminator (`claudeFullscreenOfferOpen` condition 3) are built from. Both
 *  only ask "is a mode line on screen", so the phrases live here once rather
 *  than being restated at each consumer.
 *
 *  `dontAsk` ADDED 2026-09-01 (SL-5, MEASURED at 2.1.258 — q17 arm C spawns
 *  `--permission-mode dontAsk` and the footer paints `⏵⏵ don't ask on
 *  (shift+tab to cycle) · ← for agents`, ASCII apostrophe U+0027). It is not a
 *  cycle member — no Shift+Tab press ever lands on it (q18 arm E) — but it IS a
 *  reachable session state: `ClaudePermissionMode` includes it, `claudeArgs`
 *  maps it to `--permission-mode dontAsk`, and `parseCreateTaskRequest` accepts
 *  it, so a task created through the local API can spawn straight into it. Until
 *  this entry existed both consumers went BLIND on such a session: readiness
 *  lost its mode-line redundancy leg, and `claudeFullscreenOfferOpen`'s "a
 *  composer is on screen" negative — the structural discriminator that keeps a
 *  repaint from being read as the boot offer — failed OPEN. Adding the phrase
 *  closed both at once, which is exactly why the table is shared. */
const CLAUDE_MODE_LINE_PHRASES: readonly string[] = [
  "accept edits on",
  "manual mode on",
  "plan mode on",
  "auto mode on",
  "don't ask on",
];

/**
 * "A permission mode line is on screen" — the readiness detector's footer
 * needle, NOT a mode reader. `detectIdlePrompt` asks only whether the idle
 * footer is present near the composer; which mode it names is none of its
 * business, so this collapses every phrase into one predicate and returns a
 * boolean's worth of information. The mode SSOT is the hook payload.
 *
 * Whitespace-TOLERANT rather than compacted, because it is tested against
 * `cleanTerminal` output (escapes stripped, spacing intact): `\s*` between words
 * absorbs a paint that split the phrase across a cursor move. The glyph anchor
 * stays even though readiness could afford a looser needle (a false positive
 * only raises a confidence label): it costs nothing and keeps assistant prose
 * about permission modes — the exact sentence a session ABOUT this code prints —
 * out of a screen-state answer.
 */
export const CLAUDE_MODE_LINE_ON_SCREEN_RE = new RegExp(
  `${MODE_LINE_GLYPH}\\s*(?:${CLAUDE_MODE_LINE_PHRASES.map((phrase) =>
    phrase.split(" ").join("\\s*"),
  ).join("|")})`,
  "i",
);

// ── Claude model identity (statusline `model.id` ↔ launch alias) ────────────

/**
 * The alias ↔ display ↔ canonical-id table, MEASURED (F16 ids and display names
 * at 2.1.258, re-confirmed at 2.1.259). `alias` is what Sonata passes as
 * `--model`; `display` and `id` are what the CLI writes back into the statusline
 * payload (`model.display_name`, `model.id`) — a FILE contract, so this table is
 * how a current-model reading maps back onto a launch row without parsing the
 * screen.
 */
export interface ClaudeModelAliasRow {
  alias: string;
  /** The statusline `model.display_name`. */
  display: string;
  /** The canonical API id (statusline `model.id`). */
  id: string;
}
export const CLAUDE_MODEL_ALIASES: readonly ClaudeModelAliasRow[] = [
  { alias: "fable", display: "Fable 5.1", id: "claude-fable-5-1" },
  { alias: "opus[1m]", display: "Opus 5 (1M context)", id: "claude-opus-5[1m]" },
  { alias: "opus", display: "Opus 5", id: "claude-opus-5" },
  { alias: "sonnet", display: "Sonnet 5", id: "claude-sonnet-5" },
  { alias: "haiku", display: "Haiku 4.5", id: "claude-haiku-4-5-20251001" },
];
