import { cleanTerminal } from "./tui-parsers-common";

// ── Pure Codex TUI parsers (consolidation S4) ────────────────────────────────
// Moved verbatim from terminal-host.ts: the two BOOT screens that must never be
// auto-answered — the "Update available!" gate and the workspace-trust dialog.
// Every string probe-measured through the app's own cleanTerminal (NOT assumed,
// per the S2 glyph lesson). Provenance comments preserved intact.

// ── Codex boot "Update available!" gate (consolidation S4) ───────────────────
//
// When a newer codex release exists, the CLI renders a full-screen gate at boot
// and BLOCKS composer readiness until the user resolves it in the terminal:
//   Update available! … 1. Update now (runs `brew upgrade --cask codex`) …
//   Press enter to continue    …    https://github.com/openai/codex/releases/latest
// Sonata surfaces this as a passive needs-attention banner on a boot readiness
// timeout — it must NEVER auto-answer it (running brew / pressing keys blind is
// the user's call). The product-side detector for that boot-latch path; the
// smoke suite keeps its own copy for the environmental-SKIP signal.
const CODEX_UPDATE_PROMPT_STRONG_RE = /Update available!|(?<!\w)Update now(?!\w)/i;
const CODEX_UPDATE_RELEASES_RE = /releases\/latest/i;
const CODEX_UPDATE_WORD_RE = /(?<!\w)update(?!\w)/i;

/** True iff `terminalText` (a CLEANED PTY tail — ANSI/control already stripped)
 *  shows codex's boot update gate. Anchored on the gate's own strings so an
 *  unrelated readiness failure that merely mentions "update" cannot masquerade as
 *  it: `Update available!` / `Update now` stand alone (specific to the gate); the
 *  weaker `releases/latest` URL fragment (which can appear in release-note prose)
 *  only counts when it CO-OCCURS with an update cue (S3 review rider). */
export function isCodexUpdatePrompt(terminalText: string): boolean {
  if (!terminalText) {
    return false;
  }
  if (CODEX_UPDATE_PROMPT_STRONG_RE.test(terminalText)) {
    return true;
  }
  return CODEX_UPDATE_RELEASES_RE.test(terminalText) && CODEX_UPDATE_WORD_RE.test(terminalText);
}

// ── Codex boot directory-trust dialog (codex-trust S2) ──────────────────────
//
// The FALLBACK layer. S1 made codex pre-trust UNCONDITIONAL (every spawn writes
// the cwd into the `-p sonata` profile's trust ledger before the CLI starts), so
// in the ordinary case this dialog never paints. What is left is the residual
// set the plan names: the ledger write failed, the profile layer was damaged, or
// codex re-worded the gate. In those cases the CLI parks on its onboarding trust
// screen, the composer never appears, and Reading is silent about it — the exact
// "the app knows why and won't say" shape this slice exists to end.
//
// RED LINE. Recognition + surface ONLY. Sonata NEVER answers this dialog — not a
// keystroke, not an Enter, not ever. Its "Yes, continue" is a consent decision
// about what a folder's own `.codex/` layer may load (S0 report §4), and its
// other answer QUITS the process. This is the direct lineage of the 2026-07-17
// incident, where a delivery's Enter silently answered it while the pasted
// prompt was discarded, and of the same standing rule the claude Rewind panel
// carries (`claudeRewindPanelOpen`). The pre-trust of S1 is a decision
// taken BEFORE the CLI starts, from a gesture the user actually made; answering
// a screen already on the user's display is a different act, and it stays
// forbidden.
//
// CHANNEL — the GRID, never the pty tail (D-1: a state query belongs on the
// reconstructed screen). "Is the trust dialog on screen right now?" is a state
// query in both directions: the watchdog asks it to RAISE the banner, and the
// clearing pass asks it to RETIRE the banner once the human answers. The tail
// cannot answer the second half at all — the answered dialog's bytes sit in it
// forever (the same reason `claudeRewindPanelOpen` moved off the stream), which
// is precisely why the update banner it is modelled on can only clear on
// `pty:exit`. On the grid the answered dialog
// simply leaves the viewport.
//
// VOCABULARY — the strings are the codex `bootDialogHints` set (terminal-host
// `codexProfile`, MEASURED on 0.144.x through the app's own cleanTerminal +
// whitespace-strip) plus the widget's question line, re-verified VERBATIM
// against `codex-rs/tui/src/onboarding/trust_directory.rs` @ `rust-v0.146.1`
// (S0 report §6, dialog-wording row: byte-identical at 0.146.1).
//
// SIGNATURE — strong anchor + co-occurrence, three needles that must share ONE
// frame:
//   1. the question line `Do you trust the contents of this directory?` — the
//      strong anchor, a sentence no other codex screen renders;
//   2. AND a numbered `Yes, continue` row;
//   3. AND a numbered `No, quit` row.
// The pair of option rows is the forgery fence. A single needle is forgeable by
// assistant prose (the S2 glyph lesson, and this dialog's question is exactly
// the sentence a session ABOUT this code prints); the widget, by contrast,
// renders both options unconditionally and always together — it has exactly two
// and no third answer (S0 report / D1). So prose that merely mentions trust, or
// quotes the question, or lists the words "yes, continue", reads FALSE.
//
// The `\d\.` prefix is the list grammar WITHOUT the `›` cursor glyph: the cursor
// marks only the
// HIGHLIGHTED row, and arrowing onto "No, quit" moves it — recognition that
// depended on where it sits would be defeated by exactly that keypress (the B1
// lesson pinned in `claudeRewindPanelOpen`). The digit is the list grammar and
// stays put.
//
// TOLERATES, does not DEPEND ON: 0.146.1 also renders a git-root note ("Note:
// You're in a subdirectory of a Git project. Trusting will apply to the
// repository root: …"), a caller-supplied error line, and a footer whose tail
// varies (`Press <key> to continue` vs `… to continue and create a sandbox…`).
// None of them is a needle, so their presence, absence or re-wording changes
// nothing here.
//
// KNOWN BOUNDARY of the grid channel — seen, not missed. `viewportText()` is
// VIEWPORT-ONLY: it reads `term.rows` lines from `viewportY` down and never
// touches the scrollback ring (`task-screen-model.ts`; the substrate fence
// machine-checks that nothing reads above `viewportY`). Codex is spawned with
// `--no-alt-screen`, so this widget is ordinary inline output rather than a
// full-screen modal pinned to the viewport, and it runs to ~13 rows with the
// git-root note and an error line present. On a terminal the user has shrunk far
// enough (`normalizeTerminalDimensions` floors rows at 2) the question line can
// therefore sit ABOVE `viewportY` while the option rows are still on screen —
// and the co-occurrence then reads FALSE.
//
// Accepted, on the failure DIRECTION. That case yields silence: no banner, which
// is exactly today's pre-S2 behaviour, and the readiness guard still keeps the
// boot latch shut so no held message is written into the dialog. The alternative — matching on
// fewer needles so a partial view still fires — trades this narrow silence for a
// forgeable signature, and a banner that can lie is worse than one that can be
// quiet. Reaching for scrollback is not the escape either: D-1 refinement 4 names
// a grid consumer that wants scrollback as a channel-misuse smell. If this
// silence is ever OBSERVED rather than merely derivable, the honest fix is a
// second needle set scoped to what a short viewport does show, not a weaker one.
//
// PREFIX OVERLAP, adjudicated: codex's Full Access consent dialog (raised by
// its own `/permissions` picker) has the row `› 1. Yes, continue anyway`, which
// contains `1.Yes,continue`. It cannot collide — that dialog carries neither the
// trust question nor a `No, quit` row, and the co-occurrence requires all three.
// Narrowing the row regex with a negative lookahead would buy nothing and would
// couple this signature to the OTHER dialog's wording.
const CODEX_TRUST_QUESTION_RE = /Doyoutrustthecontentsofthisdirectory\?/;
const CODEX_TRUST_YES_ROW_RE = /\d\.Yes,continue/;
const CODEX_TRUST_QUIT_ROW_RE = /\d\.No,quit/;

/** Codex's boot directory-trust dialog is on SCREEN — pass a rendered viewport
 *  (`TaskScreenModel.viewportText()`), never a pty tail (see the block above).
 *
 *  Because the grid holds only the CURRENT screen, its ABSENCE is as trustworthy
 *  as its presence: that is how the banner learns the human answered, with no
 *  liveness rule and no scan window. Callers surface it and nothing else — the
 *  RED LINE above admits no write of any kind into the codex pty. */
export function isCodexTrustDialog(screenText: string): boolean {
  if (!screenText) {
    return false;
  }
  // Compacted (escapes + ALL whitespace removed): `cleanTerminal` is a near-noop
  // on plain grid rows but is kept so a caller handing over a still-escaped
  // frame cannot silently miss, and the whitespace-strip makes the match
  // indifferent to the dialog's column padding and to where the viewport wraps
  // its rows — which is what lets ONE needle set read both the widget's laid-out
  // grid and the collapsed cell-diff form the boot repaint produces.
  const compact = cleanTerminal(screenText).replace(/\s+/g, "");
  return (
    CODEX_TRUST_QUESTION_RE.test(compact) &&
    CODEX_TRUST_YES_ROW_RE.test(compact) &&
    CODEX_TRUST_QUIT_ROW_RE.test(compact)
  );
}
