import type { ClaudePermissionMode } from "../../shared/types/domain";
import { cleanTerminal } from "./tui-parsers-common";

// ── Pure Claude TUI-stream parsers (consolidation S4) ────────────────────────
// Moved verbatim from terminal-host.ts: Remote Control stream detection, the
// mid-session model/effort receipt + cache-miss confirm dialog, and the
// Shift+Tab permission mode-line reader. All pure (take an accumulated RAW tail,
// return a verdict); unit-pinned by tests/smoke/remote-control-detect-units.mjs
// and tests/smoke/midsession-receipt.mjs. Provenance comments are preserved
// intact — every anchor here is probe-measured, not assumed.

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
// Mid-session Claude model/effort switch receipt detection (pure; unit-tested
// in tests/smoke/midsession-receipt.mjs). Sonata injects `/model <id>` /
// `/effort <level>` as typed text and watches the pty stream for the CLI's own
// receipt line. RE-MEASURED VERBATIM at claude 2.1.258 (upstream sync
// 2026-09-01, SL-4 — probes q13/q14/q16, findings F16/F17/F19); the 2.1.214
// forms this parser was written against are noted where they moved:
//
//   model  success → `⎿ Set model to Sonnet 5 and saved as your default for new
//                       sessions`                        (tail gained "for new sessions")
//   model  success → `⎿ Set model to Opus 5 (1M context) (default) and saved as
//                       your default for new sessions`   (the picker's Default row)
//   model  success → `⎿ Set model to Opus 5 (1M context) for this session only`
//                                                        (the picker's `s` key — NEW shape)
//   model  failure → `⎿ Model 'bogus-model-xyz' not found`            (unchanged)
//   effort success → `⎿ Set effort level to low (saved as your default for new
//                       sessions): Quick, straightforward implementation with…`
//                                                        (gained a description tail)
//   effort success → `⎿ Set effort level to max (this session only): …`
//                                                        (max does not persist)
//   effort failure → `⎿ Invalid argument: bogus-tier. Valid options are: low,
//                       medium, high, xhigh, max, ultracode, auto`     (NEW — see below)
//
// The receipt is WORD-POSITIONED — claude lays it out with cursor moves
// (`\x1b[NG`), not spaces — so stripping ANSI glues the words
// ("Set model to" → "Setmodelto"). We therefore match the COMPACTED form
// (escapes + ALL whitespace removed) on the accumulated RAW tail, exactly like
// the Remote Control detector, so a split landing inside an escape reassembles
// first. (2.1.248 started rendering model NAMES as code; re-verified — the SGR
// around the name lands between the anchor words and the compaction removes it,
// so the needles are unaffected.) Screen text is a choreography RECEIPT only —
// the statusline mirror stays the model SSOT.
//
// ── WHY THE FAILURE NEEDLES ARE ANCHORED ON THE VALUE WE ASKED FOR ──────────
//
// Because the scan window is a byte window over a stream that REPAINTS HISTORY.
// Since 2.1.252 claude renders in the alternate screen, and a switch that
// changes the banner's shape forces a FULL TRANSCRIPT REDRAW — so every receipt
// the session ever printed re-enters the pty stream, inside the window
// `detectControlSwitchReceipt` opened for the CURRENT switch.
//
// MEASURED (q13 arm B4, at production's exact arming point — one pty write for
// the command, arm, `\r` 120ms later, rolling 4096-char window, first verdict
// wins): `/model haiku` SUCCEEDED — the receipt said so and the statusline
// mirror moved to Haiku 4.5 — and the parser returned `failed`, because the
// redraw the switch itself provoked carried this session's earlier
// `Model'bogus-model-xyz'notfound` line into the window. Sonata would have told
// the user Claude rejected a model it had just accepted.
//
// An un-anchored needle cannot tell a receipt for THIS switch from a repaint of
// an old one. The pending VALUE can: the failure line echoes the exact string we
// asked for (measured — `/model bogus-model-xyz` → `Model 'bogus-model-xyz' not
// found`; `/effort bogus-tier` → `Invalid argument: bogus-tier.`). So the caller
// passes it and the needle is built around it. If a future release ever
// normalises the name in the failure line, this needle misses and the switch
// falls to its existing timeout → needs-attention: an honest "I could not tell",
// which is the correct direction to fail in. Claiming a rejection that did not
// happen is not.
//
// ── THE MODEL-AXIS SUCCESS NEEDLE IS RETIRED (D2 U3, 2026-09-02) ────────────
//
// It used to be `/Setmodelto/`, and it was the KNOWN RESIDUAL this comment block
// spent four paragraphs apologising for: the success receipt names the model's
// DISPLAY name ("Sonnet 5"), not the alias we sent ("sonnet"), so it could not be
// anchored on the pending value the way the failure needles are. A replayed
// `Set model to …` therefore settled switches it did not belong to.
//
// That residual is not an argument about a regex; it is reproducible, and h4
// reproduced it on this binary rather than inheriting the claim: each leg's own
// settle window, replayed through this parser with a pending value the session
// NEVER asked for (`a-value-never-asked-for`), still returned `settled` — 9 of 12
// legs, which is every leg that had a success receipt at all; the other three are
// the two cancels and the rejection, whose windows carry no success line to be
// fooled by (`h4-model-switch-hooks.capture.txt`, §"THE UNANCHORED SUCCESS
// NEEDLE").
//
// WHAT REPLACED IT: the `PostModelSwitch` hook, whose `requested_model` is the
// ALIAS Sonata typed — measured byte-for-byte equal to `pending.value` across the
// whole alias set including the bracketed `opus[1m]`, and identical whether the
// switch came from the slash command (`source: "command"`) or the picker
// (`source: "picker"`). That is the anchor the stream could never provide, so the
// registered structural fix ("confirm against the MIRROR, not the stream") is
// TAKEN: `ControlSwitchEngine.noteModelSwitchConfirmed` settles the model axis,
// and this parser is left with the two verdicts the stream can still state
// honestly.
//
// SO, DELIBERATELY, `parseClaudeControlReceipt(scan, "model", …)` NEVER RETURNS
// "settled". Not "the caller stopped reading it" — the needle is gone, because a
// needle that exists is a needle a future caller re-reads. What stays on the model
// axis is the anchored FAILURE needle, and it stays because it has to: a rejected
// alias fires NO hook at all (h4 arm c — `/model bogus-model-name` produced the
// `Model '…' not found` receipt and zero ModelSwitch events), so the stream is the
// only witness a rejection has.
//
// The EFFORT axis keeps BOTH needles, and that is measurement rather than
// symmetry: `/effort low` fires no hook of any kind (h4 arm d — zero hook payloads
// of any event between the command and its receipt), so there is nothing to move
// it to. Effort is now the last stream-confirmed switch axis on the claude side.
export const CONTROL_SWITCH_SCAN_LIMIT = 4096;
const CONTROL_SWITCH_EFFORT_OK_RE = /Seteffortlevelto/;

/** Prepare a pending value for embedding in a needle.
 *
 *  Whitespace is stripped FIRST so both sides of the comparison live in the same
 *  space: the haystack is fully compacted, so a value carrying a space would be
 *  spaceless in the receipt and spaced in the needle, and could never match its
 *  own rejection. Sonata's own aliases have no spaces, but the asymmetry would be
 *  a trap for the next value someone adds.
 *
 *  Then the regex metacharacters are escaped. This is not hypothetical: `opus[1m]`
 *  is a real alias (`MODEL_OPTIONS.claude`), and unescaped its brackets become a
 *  character class, so the needle would match `Model 'opus1' not found` and miss
 *  the rejection it was built for. This parser is also the seam an IPC-supplied
 *  string reaches, which is the second reason it is escaped rather than trusted. */
function valueNeedle(value: string): string {
  return value.replace(/\s+/g, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The verdict on a pending mid-session model/effort switch, read off the
 * accumulated RAW tail. `value` is the value the pending switch ASKED FOR — it
 * is what makes a failure receipt attributable to this switch rather than to a
 * repaint of an older one (see the block comment above).
 *
 * ASYMMETRIC BY MEASUREMENT since D2 U3: the MODEL axis can only ever answer
 * `"failed"` or `null` here — its success is confirmed by the `PostModelSwitch`
 * hook, not by this stream. The EFFORT axis answers all three, because no hook
 * exists for it. See the block comment above for the evidence on both halves.
 */
export function parseClaudeControlReceipt(
  rawScan: string,
  kind: "model" | "effort",
  value: string,
): "settled" | "failed" | null {
  const compact = cleanTerminal(rawScan).replace(/\s+/g, "");
  // Both axes check failure FIRST: neither failure line can contain its axis's
  // success anchor, so the ordering is safe, and reading a rejection as a
  // success would be the worse mistake.
  if (kind === "effort") {
    // `Invalid argument: <tier>. Valid options are: …` — MEASURED at 2.1.258
    // (q16). The old comment here asserted a `/effort` failure was unreachable
    // "because its levels come from a curated list"; that reasoning covered only
    // the values SONATA sends, and the receipt exists, so the switch used to sit
    // pending for the full timeout instead of failing honestly.
    if (new RegExp(`Invalidargument:${valueNeedle(value)}\\.`).test(compact)) {
      return "failed";
    }
    return CONTROL_SWITCH_EFFORT_OK_RE.test(compact) ? "settled" : null;
  }
  if (new RegExp(`Model'${valueNeedle(value)}'notfound`).test(compact)) {
    return "failed";
  }
  // No success needle on this axis — the retirement, not an omission. The hook
  // settles a model switch; the stream can only reject one.
  return null;
}

// Mid-session Claude cache-miss confirm dialog (S7). On a session WITH history —
// the normal Sonata case — a `/model <id>` / `/effort <level>` inject does NOT
// apply immediately: claude raises a modal confirm (measured, claude 2.1.214 —
// spikes/midsession-switch-probe/findings.md §"S7 cache-miss probe"):
//   Switch model?  /  Change effort level?
//   Your next response will be slower and use more tokens
//   This conversation is cached for the current <axis>. Switching to <target>
//   means the full history gets re-read on your next message.
//   ❯ 1. Yes, switch to <target>
//     2. No, go back
// This is NOT a hook option-prompt (parseClaudeApprovalPanel returns null on it —
// S5-F) — it is a TUI dialog Sonata must scrape-recognize to PARK on and relay
// through the Action Drawer (S7 revision 3). RED LINE (codex trust-dialog silent-
// Yes lineage): recognition must be forge-resistant, so it anchors on the
// CO-OCCURRENCE of the distinctive body phrase AND the numbered-row grammar —
// neither the title (`Switch model?` vs `Change effort level?`) nor the Yes-row
// label (it embeds the target name) is axis-stable, but a boundary of assistant
// prose can't forge BOTH `…re-read on your next message` and `2. No, go back`
// together (stronger than S2's single-substring lesson). Same compacted form
// (escapes + ALL whitespace removed) the other claude parsers key on.
const CLAUDE_CACHE_MISS_BODY_RE = /thefullhistorygetsre-readonyournextmessage/;
const CLAUDE_CACHE_MISS_NO_ROW_RE = /2\.No,goback/;
// Cursor rows: `❯` (U+276F) + the row LABEL. The digit+dot (`1.`/`2.`) appear in
// the INITIAL full render but claude DROPS them in the partial arrow-move repaint
// (measured: after ↓ the row renders `❯No, go back`, no digit) — so the digit is
// OPTIONAL and the LABEL is the anchor (it also rejects the composer `❯ ` prompt,
// which is never followed by a row label). "Most recent wins" (greatest match
// index) so a stale pre-move cursor repaint can't outvote the latest frame.
const CLAUDE_CACHE_MISS_CURSOR_RES: ReadonlyArray<readonly [RegExp, 1 | 2]> = [
  [/❯\d?\.?Yes,switchto/, 1],
  [/❯\d?\.?No,goback/, 2],
];
// Cancel receipt: choosing No (or Esc) closes the dialog with a `Kept …` line —
// the switch did NOT apply (measured; settings.json byte-unchanged). Axis-scoped
// so a model cancel can't read an effort receipt and vice versa.
const CLAUDE_CACHE_MISS_CANCEL_MODEL_RE = /Keptmodelas/;
const CLAUDE_CACHE_MISS_CANCEL_EFFORT_RE = /Kepteffortlevelas/;

/**
 * The claude cache-miss confirm dialog is on screen (a recognized RED-LINE
 * interstitial S7 PARKS on and relays through the drawer). Requires BOTH the
 * distinctive body phrase and the `2. No, go back` row so prose can't forge it.
 *
 * TWO SUBSTRATES, deliberately, and the same compaction serves both. Over the pty
 * SCAN it is the PARK trigger — "a dialog appeared" is an event, and the stream is
 * where events live. Over the rendered GRID it is the cancel gate's absence test
 * (see `claudeCacheMissCancelled`) — "is the dialog still up" is a state, and only
 * the grid can answer a state truthfully, because the stream keeps the dialog's
 * bytes long after the screen has moved on. h4 measured the grid direction live:
 * true while parked, false the instant it closed, on every arm that raised one.
 */
export function claudeCacheMissDialogOpen(rawScan: string): boolean {
  const compact = cleanTerminal(rawScan).replace(/\s+/g, "");
  return CLAUDE_CACHE_MISS_BODY_RE.test(compact) && CLAUDE_CACHE_MISS_NO_ROW_RE.test(compact);
}

/** Which row the `❯` cursor currently highlights (1 = Yes, 2 = No), or null if no
 *  cursor row is recognized yet (keep waiting). Most-recent-wins. */
export function parseClaudeCacheMissCursor(rawScan: string): 1 | 2 | null {
  const compact = cleanTerminal(rawScan).replace(/\s+/g, "");
  let best: 1 | 2 | null = null;
  let bestIndex = -1;
  for (const [re, row] of CLAUDE_CACHE_MISS_CURSOR_RES) {
    const globalRe = new RegExp(re.source, "g");
    let match: RegExpExecArray | null;
    let lastIndex = -1;
    while ((match = globalRe.exec(compact)) !== null) {
      lastIndex = match.index;
      globalRe.lastIndex = match.index + 1;
    }
    if (lastIndex > bestIndex) {
      bestIndex = lastIndex;
      best = row;
    }
  }
  return best;
}

/**
 * The cache-miss dialog closed with a `Kept <model|effort> as …` line — a clean
 * cancel (No/Esc), nothing changed CLI-side. Axis-scoped.
 *
 * STILL UNANCHORED, and now GATED at the one call site rather than fixed here
 * (F22, narrowed by D2 U3). It cannot be anchored: the line names the model that
 * was KEPT — the one being switched AWAY from — not the pending target, so the
 * only value the engine holds is the wrong one to match on. What made that
 * dangerous was that a REPLAYED `Kept …` could fire it while the dialog was still
 * open and unanswered, reporting a cancel the user never chose (and dropping a
 * staged Save's queued effort leg with it).
 *
 * So the MODEL axis now requires a second, structural term before believing this
 * line: the dialog must be GONE FROM THE GRID (`claudeCacheMissDialogOpen` over
 * the viewport). That is a state query answered on the substrate D-1 reserves for
 * state, and h4 measured both directions of it live — the predicate reads TRUE off
 * the grid while the dialog is parked, and FALSE the moment it closes, on every
 * arm that raised one. A replay can put the phrase back in the stream; it cannot
 * put the dialog back on the screen.
 *
 * The EFFORT axis keeps the bare needle, because it has no second witness of any
 * kind (no hook — h4 arm d) and adding a grid term there without the hook to
 * settle the Yes side would only make an effort cancel harder to see, not safer.
 */
export function claudeCacheMissCancelled(rawScan: string, kind: "model" | "effort"): boolean {
  const compact = cleanTerminal(rawScan).replace(/\s+/g, "");
  return (
    kind === "model" ? CLAUDE_CACHE_MISS_CANCEL_MODEL_RE : CLAUDE_CACHE_MISS_CANCEL_EFFORT_RE
  ).test(compact);
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
// Recognition is CO-OCCURRENCE, like the cache-miss dialog above and for the
// same reason — a single substring is forgeable by assistant prose (S2's
// lesson), and this panel's own body text is exactly the kind of sentence a
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
 *  Callers treat this as a screen owner: readiness, delivery, the mid-session
 *  control switches and the Enter-retry ladder all hold while it is true.
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
// WHY IT IS A RED LINE. MEASURED (F8a) — writing exactly what
// DeliveryController writes at an open boot latch, a bracketed paste followed by
// the submit CR:
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
// gates is ONE-WAY (`DeliveryController.bootLatched` never re-closes, and
// nothing re-reads the scrape afterwards). So a FALSE POSITIVE is not the mild
// failure it is for the Rewind panel, whose own hold self-clears on the next
// repaint: here it wedges the latch shut for the life of the session, with the
// queue sitting at "Queued" over a static screen and no override left. The
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
//      re-evaluates on every call and the delivery pump re-polls it about every
//      500ms, so the hold lifts on the first poll after the hint clears —
//      bounded by the hint's own ~1–2s lifetime, not by the session's. The
//      one-way boot latch is what would have made a false hold permanent, and
//      this hold expires before it can be the thing that keeps the latch shut.
//      (c) POST-latch it costs nothing at all: this guard feeds readiness ONLY
//      (see `isFullscreenOfferOpen`), and readiness stops gating delivery once
//      the latch opens.
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
 *  because the Enter that opens delivery answers the offer and destroys the
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
// required (co-occurrence, as with the cache-miss and Rewind predicates): a
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

// Mid-session Claude PERMISSION switch (S2). Unlike model/effort (a typed
// command with one printed receipt), permission has no arg form: Sonata drives
// the native Shift+Tab (`\x1b[Z`) cycle one step at a time and reads the TUI's
// mode line as the per-step *choreography receipt* to learn which mode it just
// landed in. RE-MEASURED at claude 2.1.258 (upstream sync 2026-09-01, SL-5 —
// spikes/upstream-sync-2026-09/claude/q17, 12 presses = 3 full cycles, plus q18
// arm E for the off-cycle origins). The cycle and all four phrases are
// UNCHANGED from the 2.1.214 stamp this block used to carry:
//   default (Manual) ↔ `⏸ manual mode on`    acceptEdits ↔ `⏵⏵ accept edits on`
//   plan             ↔ `⏸ plan mode on`      auto        ↔ `⏵⏵ auto mode on`
//   cycle: manual → accept edits → plan → auto → manual — 4 members, no more.
// `auto` was measured PRESENT on this account (and is now this account's own
// startup default: an unflagged spawn boots into it — q17 arm C, the 8/14
// server-side rollout landing here). `bypassPermissions` is NOT in the cycle
// (12 presses never reached it), so Sonata cannot step into it unattended.
// Step latency is ~27ms and one press advances exactly one mode at any spacing
// down to 40ms; only three presses written in the SAME tick coalesce into one
// advance (q17 arm B). The engine's one-press-per-receipt shape never bursts,
// so that coalescing is unreachable from here.
// The line is receipt-only — the hook payload's `permission_mode` stays the
// state SSOT (lazy reconcile). Compacted match (escapes + ALL whitespace
// removed) on the RAW tail, like the model/effort receipt and the Remote Control
// detector, so a split landing inside an escape reassembles first; LAST match
// wins so a repaint of a prior mode line can't outvote the current one.
//
// ANCHORED on the leading status glyph (measured — spikes/glyph-capture.mjs):
// every mode line's phrase is immediately preceded, AFTER compaction, by one of
// exactly two glyphs — `⏸` U+23F8 (manual/plan) or `⏵⏵` U+23F5 U+23F5
// (accept edits/auto). The glyph is NOT unique per mode (so it can't identify
// one — the phrase does that), but it is a boundary prose can't forge. This is
// the S2-specific hardening the review demanded: without the anchor a repaint
// of assistant prose containing the target phrase (e.g. "…I'll turn plan mode
// on…" → compacts to `…planmodeon…`) would read as a receipt and settle the
// choreography ONE MODE SHORT while signalling success — a silent
// under-delivery (S1's un-anchored false-match is harmless by contrast: it only
// drops a pending affordance). The glyph never appears in prose immediately
// before the exact phrase, so anchoring on it rejects the prose without
// weakening the true positives (re-verified against a real stepping e2e).
const MODE_LINE_GLYPH = "[\\u23f8\\u23f5]";
/** The mode-line phrases and the mode each names — the ONE source the S2 receipt
 *  parser below, the readiness footer needle (`terminal-host.ts`,
 *  `idlePromptModelHints`) and the fullscreen-offer discriminator
 *  (`claudeFullscreenOfferOpen` condition 3) are all built from. Readiness and
 *  the offer guard only ask "is a mode line on screen", which is a strictly
 *  weaker question than "which mode did we land in", so they reuse these
 *  phrases rather than restating them; the parser keeps sole ownership of the
 *  mode SEMANTICS. Order is load-bearing here only as a tie-break (first wins at
 *  an equal match index) and is unchanged.
 *
 *  `dontAsk` ADDED 2026-09-01 (SL-5, MEASURED at 2.1.258 — q17 arm C spawns
 *  `--permission-mode dontAsk` and the footer paints `⏵⏵ don't ask on
 *  (shift+tab to cycle) · ← for agents`, ASCII apostrophe U+0027). It is not a
 *  cycle member — no Shift+Tab press ever lands on it (q18 arm E) — but it IS a
 *  reachable session state: `ClaudePermissionMode` includes it, `claudeArgs`
 *  maps it to `--permission-mode dontAsk`, and `parseCreateTaskRequest` accepts
 *  it, so a task created through the local API can spawn straight into it. Until
 *  this entry existed all three consumers went BLIND on such a session: the S2
 *  parser could not read its origin, readiness lost its mode-line redundancy
 *  leg, and `claudeFullscreenOfferOpen`'s "a composer is on screen" negative —
 *  the structural discriminator that keeps a repaint from being read as the boot
 *  offer — failed OPEN. Adding the phrase closes all three at once, which is
 *  exactly why the table is shared. */
const CLAUDE_MODE_LINE_PHRASES: ReadonlyArray<readonly [phrase: string, mode: ClaudePermissionMode]> = [
  ["accept edits on", "acceptEdits"],
  ["manual mode on", "default"],
  ["plan mode on", "plan"],
  ["auto mode on", "auto"],
  ["don't ask on", "dontAsk"],
];
const PERMISSION_MODE_LINE_RES: ReadonlyArray<readonly [RegExp, ClaudePermissionMode]> =
  CLAUDE_MODE_LINE_PHRASES.map(
    ([phrase, mode]) => [new RegExp(`${MODE_LINE_GLYPH}${phrase.replace(/\s+/g, "")}`), mode] as const,
  );

/**
 * "A permission mode line is on screen" — the readiness detector's footer
 * needle, NOT a mode reader. `detectIdlePrompt` asks only whether the idle
 * footer is present near the composer; which mode it names is none of its
 * business, so this collapses all four phrases into one predicate and returns a
 * boolean's worth of information. The mode SSOT stays the hook payload, with
 * `parseClaudePermissionModeLine` as S2's choreography receipt.
 *
 * Two differences from the parser's patterns, both deliberate:
 *  - whitespace-TOLERANT rather than compacted, because it is tested against
 *    `cleanTerminal` output (escapes stripped, spacing intact) rather than the
 *    parser's fully compacted tail. `\s*` between words absorbs a paint that
 *    split the phrase across a cursor move.
 *  - the same `⏸`/`⏵` glyph anchor. Readiness could afford a looser needle (a
 *    false positive only raises a confidence label), but the anchor costs
 *    nothing and keeps assistant prose about permission modes — the exact
 *    sentence a session ABOUT this code prints — out of a screen-state answer.
 */
export const CLAUDE_MODE_LINE_ON_SCREEN_RE = new RegExp(
  `${MODE_LINE_GLYPH}\\s*(?:${CLAUDE_MODE_LINE_PHRASES.map(([phrase]) =>
    phrase.split(" ").join("\\s*"),
  ).join("|")})`,
  "i",
);

/** Parse the most recent TUI permission mode line out of the compacted RAW tail,
 *  or null if none is recognized yet (keep waiting until the per-step timeout).
 *  Each pattern is anchored on the leading status glyph (`⏸` / `⏵⏵`) so
 *  prose that merely contains a mode phrase can't be misread as a receipt.
 *  "Most recent" = the match at the greatest index, so a redraw of the prior
 *  mode line can't mask the step's real landing. */
export function parseClaudePermissionModeLine(rawScan: string): ClaudePermissionMode | null {
  const compact = cleanTerminal(rawScan).replace(/\s+/g, "").toLowerCase();
  let best: ClaudePermissionMode | null = null;
  let bestIndex = -1;
  for (const [re, mode] of PERMISSION_MODE_LINE_RES) {
    // `re` sources are glyph-anchored, lowercase, glued forms — match against the
    // compacted tail (the glyphs are case-invariant, so lowercasing is safe).
    const globalRe = new RegExp(re.source, "g");
    let match: RegExpExecArray | null;
    let lastIndex = -1;
    while ((match = globalRe.exec(compact)) !== null) {
      // The match index points at the glyph; order by where the PHRASE lands
      // (index of the last char) so `⏵⏵` (2 chars) and `⏸` (1 char) rank fairly.
      lastIndex = match.index + match[0].length;
      globalRe.lastIndex = match.index + 1;
    }
    if (lastIndex > bestIndex) {
      bestIndex = lastIndex;
      best = mode;
    }
  }
  return best;
}

/** The full ClaudePermissionMode set, for validating the `value`/`from` strings
 *  that cross the IPC seam into the permission stepping engine. */
const CLAUDE_PERMISSION_MODE_SET: ReadonlySet<ClaudePermissionMode> = new Set<ClaudePermissionMode>([
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "default",
  "dontAsk",
  "plan",
]);

/** Narrow an untrusted string to a ClaudePermissionMode, or null. */
export function asClaudePermissionMode(value: string | undefined): ClaudePermissionMode | null {
  return value && CLAUDE_PERMISSION_MODE_SET.has(value as ClaudePermissionMode)
    ? (value as ClaudePermissionMode)
    : null;
}

/** The Shift+Tab permission cycle order, probe-measured (claude 2.1.214 — see
 *  spikes/midsession-switch-probe §S0; re-observed 2026-07-23 in the
 *  midsession-permission-switch e2e's `observedModes`; RE-MEASURED UNCHANGED at
 *  2.1.258, SL-5 q17 arm A — 12 consecutive presses traced this exact order
 *  three times over, with no fifth member and no `bypassPermissions`):
 *  manual (default) → accept edits → plan → auto → manual. `auto` is
 *  account-gated and IS granted on this account. */
export const CLAUDE_PERMISSION_CYCLE: readonly ClaudePermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
];

/** Is `mode` a member of the Shift+Tab cycle — i.e. can stepping ever LAND on
 *  it? `dontAsk` and `bypassPermissions` are the two that cannot (MEASURED,
 *  SL-5 q18 arm E: eight presses from a `dontAsk` session walk the four cycle
 *  members twice and never come back), which is what makes them unreachable
 *  return-home destinations for the stepping engine. */
export function isClaudePermissionCycleMode(mode: ClaudePermissionMode): boolean {
  return CLAUDE_PERMISSION_CYCLE.includes(mode);
}

/**
 * The mode(s) a single Shift+Tab press from `from` may legitimately land on. For
 * a cycle member it is the next cycle mode, PLUS the `plan → default` wrap that
 * fires when the account-gated `auto` is absent. A landing outside this set means
 * the cycle model no longer holds — a stale two-frames-old repaint, a
 * double-press, or an unexpected screen — so the stepping engine treats it as a
 * FAILED step (fail loud) rather than reading it as the step's receipt (review
 * F3: the old engine accepted ANY post-press mode line, so a stale pre-press
 * frame read as "landed on the same mode", double-pressed, and could strand the
 * session on neither the target nor the origin).
 *
 * An OFF-cycle origin is one the cycle cannot reach (`isClaudePermissionCycleMode`
 * is false): `bypassPermissions` and `dontAsk`. Both keep the blanket exemption —
 * any cycle member is accepted — and the stale-repaint filter (landing === `from`)
 * still rejects a redraw of `from` itself. This preserves the blind-seek the
 * engine used before landing validation for those two rare cases.
 *
 * WHAT IS KNOWN ABOUT EACH, and why neither is encoded (SL-5):
 *
 *  - `bypassPermissions` — successor UNMEASURED and not measurable from Sonata.
 *    A `--permission-mode bypassPermissions` spawn parks on an unanswered
 *    "WARNING: … Bypass Permissions mode" consent screen and never paints a
 *    composer (q18 arm E), so there is no mode line to step away from.
 *  - `dontAsk` — successor OBSERVED ONCE, at 2.1.258: the single press taken
 *    from a `--permission-mode dontAsk` composer landed on `default` (q18 arm E;
 *    the seven presses after it were cycle-internal, so they corroborate the
 *    CYCLE, not this transition). **n=1 does not earn a one-member expectation
 *    here**, and the asymmetry is what decides it: a one-member set that is
 *    RIGHT buys nothing the stale-repaint filter does not already give, while a
 *    one-member set that upstream later makes WRONG turns a drive that would
 *    have worked into a guaranteed failure — and since SL-5 also removed the
 *    walking recovery for non-cycle origins (`beginPermissionReturn` stops
 *    immediately rather than pressing toward an unreachable home), that failure
 *    now resolves on press 1 with no second chance. Fail-loud is the right
 *    contract for a transition we have MODELLED; it is the wrong contract for
 *    one we have SAMPLED once. Recorded here as knowledge rather than encoded as
 *    a rule; a second independent observation would change the calculus.
 */
export function expectedPermissionLandings(
  from: ClaudePermissionMode,
): ReadonlySet<ClaudePermissionMode> {
  const idx = CLAUDE_PERMISSION_CYCLE.indexOf(from);
  if (idx === -1) {
    return new Set(CLAUDE_PERMISSION_CYCLE);
  }
  const next = CLAUDE_PERMISSION_CYCLE[(idx + 1) % CLAUDE_PERMISSION_CYCLE.length];
  const landings = new Set<ClaudePermissionMode>();
  if (next) {
    landings.add(next);
  }
  if (from === "plan") {
    landings.add("default");
  }
  return landings;
}
