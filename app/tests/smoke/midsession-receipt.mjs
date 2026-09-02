import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Unit coverage for the mid-session switch receipt parser (S1). The pure
// parser is the seam the receipt watcher keys on: it turns the RAW pty tail
// (ANSI + word-positioned redraw + whitespace noise) into a settle / fail /
// keep-waiting verdict. Strings are the probe-verified verbatim receipts
// (claude 2.1.214 — spikes/midsession-switch-probe/findings.md), re-stamped
// against claude 2.1.258 by the 2026-09-01 sync (SL-4, probes q13/q14/q16 —
// spikes/upstream-sync-2026-09/claude/findings.md F16/F17/F19). Where a receipt
// MOVED between those versions, both forms are pinned: the parser has to keep
// working against a binary a user has not updated yet.
const require = createRequire(import.meta.url);
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const readFixture = (name) => readFileSync(resolve(FIXTURES, name), "utf8");
const {
  parseClaudeControlReceipt,
  parseClaudePermissionModeLine,
  parseCodexPermissionPickerCursor,
  parseCodexPermissionReceipt,
  codexPermissionPickerOpen,
  codexPermissionPickerFooterVisible,
  codexPermissionConsentDialogOpen,
  codexModelPickerLevel1Open,
  codexModelPickerLevel2Open,
  codexModelPickerFooterVisible,
  parseCodexModelLevel1,
  parseCodexModelLevel2,
  parseCodexModelReceipt,
  claudeCacheMissDialogOpen,
  parseClaudeCacheMissCursor,
  claudeCacheMissCancelled,
  parseCodexConsentCursor,
} = require("../../dist/runtime");

// — Success: model. Both receipt tails are MEASURED — 2.1.214 had no
//   "for new sessions", 2.1.258 does. —
assert.equal(
  parseClaudeControlReceipt(
    "⎿ Set model to Sonnet 5 and saved as your default for new sessions",
    "model",
    "sonnet",
  ),
  "settled",
  "the `Set model to …` receipt settles a model switch",
);

// The REAL rendered receipt is WORD-POSITIONED — claude lays it out with cursor
// moves, so once ANSI is stripped the words glue ("SetmodeltoSonnet 5andsaved").
// This is the exact string captured from the pty (spikes/midsession-switch-probe
// inject-probe) — the parser MUST still settle it (regression pin for the
// space-bearing-regex bug).
assert.equal(
  parseClaudeControlReceipt(
    "  ⎿  SetmodeltoSonnet 5andsavedasyourdefaultfornewsessions",
    "model",
    "sonnet",
  ),
  "settled",
  "the word-positioned (glued) model receipt still settles",
);
assert.equal(
  parseClaudeControlReceipt(
    "  ⎿  SeteffortleveltolowsavedasyourdefaultfornewsessionsX",
    "effort",
    "low",
  ),
  "settled",
  "the word-positioned (glued) effort receipt still settles",
);

// MEASURED at 2.1.258 (q13 arm C2): choosing a picker row with `s` (session-only)
// prints a receipt with NO "saved as your default" tail at all. It is still a
// settle — the model DID change — and the anchor is unchanged, so this pins that
// the needle never depended on the tail.
assert.equal(
  parseClaudeControlReceipt(
    "⎿  Set model to Opus 5 (1M context) for this session only",
    "model",
    "opus[1m]",
  ),
  "settled",
  "the picker's session-only receipt (no default tail) still settles",
);
// MEASURED at 2.1.258 (q13 arm C1): the picker's `Default (recommended)` row adds
// a parenthesised `(default)` between the name and the tail.
assert.equal(
  parseClaudeControlReceipt(
    "⎿  Set model to Opus 5 (1M context) (default) and saved as your default for new sessions",
    "model",
    "opus[1m]",
  ),
  "settled",
  "the picker's Default-row receipt settles",
);

// — Success: effort. 2.1.258 appends a description after a colon, and `max`
//   reports "(this session only)" instead of the default tail — both MEASURED
//   (q16), both still settles. —
assert.equal(
  parseClaudeControlReceipt(
    "⎿ Set effort level to low (saved as your default for new sessions)",
    "effort",
    "low",
  ),
  "settled",
  "the `Set effort level to …` receipt settles an effort switch",
);
assert.equal(
  parseClaudeControlReceipt(
    "⎿  Set effort level to low (saved as your default for new sessions): Quick, straightforward implementation with minimal overhead",
    "effort",
    "low",
  ),
  "settled",
  "…and the 2.1.258 description tail does not disturb it",
);
assert.equal(
  parseClaudeControlReceipt(
    "⎿  Set effort level to max (this session only): Maximum capability with deepest reasoning. May use excessive tokens",
    "effort",
    "max",
  ),
  "settled",
  "…and `max`, which does NOT persist as a default, still settles",
);

// — Failure: model. The needle is anchored on the value THIS switch asked for
//   (see parseClaudeControlReceipt's block comment): a repaint of an older
//   failure naming a different model must not fail this one. —
assert.equal(
  parseClaudeControlReceipt("⎿ Model 'bogus-model-xyz' not found", "model", "bogus-model-xyz"),
  "failed",
  "the `Model '<x>' not found` receipt fails a model switch that asked for <x>",
);
assert.equal(
  parseClaudeControlReceipt("⎿ Model 'bogus-model-xyz' not found", "model", "haiku"),
  null,
  "…and the SAME line does not fail a switch that asked for a different model",
);
// A real alias carries regex metacharacters (`opus[1m]` — MODEL_OPTIONS.claude).
// Unescaped, `[1m]` would become a character class and the needle would never
// match its own failure; escaped, it matches literally and nothing else.
assert.equal(
  parseClaudeControlReceipt("⎿ Model 'opus[1m]' not found", "model", "opus[1m]"),
  "failed",
  "a value carrying regex metacharacters is matched LITERALLY",
);
assert.equal(
  parseClaudeControlReceipt("⎿ Model 'opusm' not found", "model", "opus[1m]"),
  null,
  "…and is not treated as a character class (`opusm` must not match `opus[1m]`)",
);

// — Failure: effort. MEASURED at 2.1.258 (q16): `/effort <bogus>` prints
//   `Invalid argument: <x>. Valid options are: low, medium, high, xhigh, max,
//   ultracode, auto`. Before this was measured the parser returned null here and
//   the switch sat pending for the full timeout. —
assert.equal(
  parseClaudeControlReceipt(
    "⎿  Invalid argument: bogus-tier. Valid options are: low, medium, high, xhigh, max, ultracode, auto",
    "effort",
    "bogus-tier",
  ),
  "failed",
  "the `Invalid argument: <tier>.` receipt fails an effort switch that asked for <tier>",
);
assert.equal(
  parseClaudeControlReceipt(
    "⎿  Invalid argument: bogus-tier. Valid options are: low, medium, high, xhigh, max, ultracode, auto",
    "effort",
    "high",
  ),
  null,
  "…and does not fail a switch that asked for a different tier",
);

// — Timeout paths: no receipt yet (parser returns null → the watcher waits,
//   then the timeout re-classifies the screen as needs-attention). —
assert.equal(
  parseClaudeControlReceipt("❯ /model sonnet", "model", "sonnet"),
  null,
  "the echoed command line is not a receipt",
);
assert.equal(
  parseClaudeControlReceipt("", "model", "sonnet"),
  null,
  "an empty scan keeps waiting",
);
assert.equal(
  parseClaudeControlReceipt(
    "· Thinking… (esc to interrupt · ctrl+t to hide todos)",
    "effort",
    "high",
  ),
  null,
  "unrelated TUI chrome keeps waiting",
);
// MEASURED at 2.1.258 (q16): `/effort auto` is accepted but prints a receipt in a
// shape this parser does not recognise. Sonata never INJECTS `auto` (it is not in
// REASONING_OPTIONS, and config.ts records why), so this pins the honest
// consequence if it ever did: keep waiting, then needs-attention — never a
// guessed settle.
assert.equal(
  parseClaudeControlReceipt("⎿  Effort level set to auto", "effort", "auto"),
  null,
  "the `/effort auto` receipt is NOT recognised as a settle (unmodelled, fails safe)",
);

// — Cross-kind isolation: each kind matches only its own receipt line. —
assert.equal(
  parseClaudeControlReceipt("⎿ Set effort level to low", "model", "sonnet"),
  null,
  "an effort receipt must NOT settle a model switch",
);
assert.equal(
  parseClaudeControlReceipt("⎿ Set model to Sonnet 5", "effort", "low"),
  null,
  "a model receipt must NOT settle an effort switch",
);
// A `Model '…' not found` in the scan must not fail an effort switch, even when
// the two axes share a value string.
assert.equal(
  parseClaudeControlReceipt("⎿ Model 'x' not found", "effort", "x"),
  null,
  "the model-failure line does not fail an effort switch",
);
assert.equal(
  parseClaudeControlReceipt("⎿  Invalid argument: x. Valid options are: low", "model", "x"),
  null,
  "…and the effort-failure line does not fail a model switch",
);

// — Robustness: ANSI escapes + word-positioned redraw + whitespace noise. The
//   parser strips ANSI and collapses whitespace, so a split/positioned receipt
//   still matches (the RAW tail is accumulated before parsing). —
assert.equal(
  parseClaudeControlReceipt(
    "\x1b[2m\x1b[38;5;244m⎿ Set model to\x1b[0m\x1b[32G Fable 5.1\x1b[0m",
    "model",
    "fable",
  ),
  "settled",
  "ANSI-decorated + cursor-positioned receipt still settles",
);
assert.equal(
  parseClaudeControlReceipt("⎿   Set    model\n   to   Opus 4.8", "model", "opus"),
  "settled",
  "collapsed whitespace bridges a wrapped receipt",
);

// — Failure wins over success in the same scan (safe ordering): a screen that
//   shows both, for THIS switch's value, is treated as a failure. —
assert.equal(
  parseClaudeControlReceipt(
    "⎿ Model 'bogus' not found\n⎿ Set model to Sonnet 5",
    "model",
    "bogus",
  ),
  "failed",
  "a failure line for this switch's value wins over a later success line",
);

// ── The repaint hazard, pinned on MEASURED windows ──────────────────────────
//
// Both fixtures are VERBATIM pty windows produced by the production ladder at
// claude 2.1.258 (q13, arms B4 and B5 — the exact 4096-char rolling window
// `detectControlSwitchReceipt` held at the moment it reached a verdict). Since
// 2.1.252 claude renders in the alternate screen, and a switch that reshapes the
// banner forces a FULL TRANSCRIPT REDRAW, so every receipt the session ever
// printed re-enters the stream inside the CURRENT switch's window.
const STALE_FAILURE_WINDOW = readFixture("claude-midsession/stale-failure-repaint-2.1.258.txt");
const STALE_SUCCESS_WINDOW = readFixture("claude-midsession/stale-success-repaint-2.1.258.txt");

// The window is genuinely poisoned — an earlier arm's failure line is in it…
assert.match(
  STALE_FAILURE_WINDOW.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\s+/g, ""),
  /Model'bogus-model-xyz'notfound/,
  "fixture sanity: the measured window really does carry the earlier failure line",
);
// …and it is the window of a `/model haiku` that SUCCEEDED (the statusline mirror
// moved to Haiku 4.5 as it was captured). What the window does NOT contain is
// haiku's own receipt — the `Set model to` lines in it are replays naming
// `Opus 5` and `Opus 5 (1M context)`. Stated explicitly because it changes what
// the next assertion proves: the FAILURE half is fixed (the stale rejection no
// longer wins), and the value it settles on is a replayed success for another
// model, which is the residual pinned at the bottom of this block.
assert.doesNotMatch(
  STALE_FAILURE_WINDOW.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\s+/g, ""),
  /SetmodeltoHaiku/,
  "fixture sanity: the succeeding switch's OWN receipt is NOT in this window",
);
assert.equal(
  parseClaudeControlReceipt(STALE_FAILURE_WINDOW, "model", "haiku"),
  "settled",
  "a repaint of an EARLIER switch's rejection must not FAIL the switch in flight",
);
// The same window, for the switch that actually failed, still fails.
assert.equal(
  parseClaudeControlReceipt(STALE_FAILURE_WINDOW, "model", "bogus-model-xyz"),
  "failed",
  "…while the switch that DID ask for the rejected value still reads failed",
);

// ── KNOWN RESIDUAL, pinned as what it is rather than hidden ────────────────
// The SUCCESS needle is NOT value-anchored, deliberately: the receipt names the
// model's DISPLAY name ("Sonnet 5"), not the alias we sent ("sonnet"), so
// anchoring it would mean trusting the label table this very sync had to correct
// and would fail CLOSED into needs-attention on every upstream rename — worse
// than what it fixes. Two shapes of the consequence, both on MEASURED windows:
//
// (a) the sharpest one — `fable` was never switched to in the session this
//     window came from, so no `Set model to Fable 5.1` exists anywhere in it, and
//     the parser settles anyway on a replayed `Set model to Opus 5`.
assert.equal(
  parseClaudeControlReceipt(STALE_FAILURE_WINDOW, "model", "fable"),
  "settled",
  "RESIDUAL: a replayed success line for ANOTHER model settles a switch whose own receipt is absent",
);
// (b) the same-value shape: this window's only `Set model to` is a repaint, and
//     it settles the switch a beat early (measured settling on chunk 3, live).
assert.equal(
  parseClaudeControlReceipt(STALE_SUCCESS_WINDOW, "model", "sonnet"),
  "settled",
  "RESIDUAL: a repainted success line can settle a switch early (mirror is the SSOT)",
);

// ===========================================================================
// Permission Shift+Tab stepping engine — mode-line receipt parser (S2). The
// engine presses `\x1b[Z` and reads the TUI mode line to learn which mode it
// landed in.
//
// The cases below the divider are COMPOSED minimal forms (the phrase and its
// glyph, nothing else) exercising the parser's tolerances — ANSI, wrapping,
// case, the glyph anchor. They were written against claude 2.1.214
// (spikes/midsession-switch-probe/findings.md §S0) and are kept as the
// tolerance suite, not as evidence of what the CLI renders.
//
// The MEASURED rows the CLI actually paints at 2.1.258 are pinned first, added
// by upstream sync SL-5 (spikes/upstream-sync-2026-09/claude/q17 arms A/C/D,
// q18 arm E). The distinction matters: a composed `"⏸ plan mode on"` cannot
// catch a chrome change, and SL-5 found one the composed suite was blind to —
// a fifth mode (`dontAsk`) whose row the phrase table did not carry at all.
// ===========================================================================

// — MEASURED, VERBATIM footer rows at claude 2.1.258 under Sonata's production
//   spawn shape — byte-exact from the capture's rendered rows, 2-space indent
//   included (the grid reader trims trailing padding, so there is none to
//   carry). Note `default`'s row alone has no `(shift+tab to cycle)` tail; that
//   asymmetry is upstream's and is reproduced here rather than tidied. —
assert.equal(
  parseClaudePermissionModeLine("  ⏸ manual mode on · ← for agents"),
  "default",
  "MEASURED 2.1.258 default footer row",
);
assert.equal(
  parseClaudePermissionModeLine("  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents"),
  "acceptEdits",
  "MEASURED 2.1.258 acceptEdits footer row",
);
assert.equal(
  parseClaudePermissionModeLine("  ⏸ plan mode on (shift+tab to cycle) · ← for agents"),
  "plan",
  "MEASURED 2.1.258 plan footer row",
);
assert.equal(
  parseClaudePermissionModeLine("  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents"),
  "auto",
  "MEASURED 2.1.258 auto footer row",
);
// The row SL-5 added the table entry for. `dontAsk` is not a Shift+Tab cycle
// member — no press ever lands on it (q18 arm E) — but a session can SPAWN into
// it (`claudeArgs` maps `--permission-mode dontAsk`), and until this entry
// existed the parser, the readiness footer needle and the fullscreen-offer
// discriminator were all blind to such a session's composer. ASCII apostrophe
// U+0027, verified on the captured bytes.
assert.equal(
  parseClaudePermissionModeLine("  ⏵⏵ don't ask on (shift+tab to cycle) · ← for agents"),
  "dontAsk",
  "MEASURED 2.1.258 dontAsk footer row",
);
// OCCLUSION (q17 arm D): a single Ctrl-C at an idle composer REPLACES the
// mode-line row with this hint for ~1–2s. It must read as "no mode line", so
// the engine's origin read declines instead of inventing a mode — and so the
// readiness needle's absence is an honest absence, not a misparse. Byte-exact:
// 2-space indent, 87 spaces, `/rc`, 118 columns.
assert.equal(
  parseClaudePermissionModeLine(
    "  Press Ctrl-C again to exit                                                                                       /rc",
  ),
  null,
  "MEASURED 2.1.258 Ctrl-C hint row (which occludes the mode line) is not a mode",
);

// ── COMPOSED tolerance suite (below) ────────────────────────────────────────

// — Each cyclable mode's line maps to its ClaudePermissionMode id. —
assert.equal(parseClaudePermissionModeLine("⏸ manual mode on"), "default", "`manual mode on` → default");
assert.equal(
  parseClaudePermissionModeLine("⏵ accept edits on"),
  "acceptEdits",
  "`accept edits on` → acceptEdits",
);
assert.equal(parseClaudePermissionModeLine("⏸ plan mode on"), "plan", "`plan mode on` → plan");
assert.equal(parseClaudePermissionModeLine("⏵⏵ auto mode on"), "auto", "`auto mode on` → auto");

// — No mode line yet → null (the engine keeps waiting until the per-step timeout). —
assert.equal(parseClaudePermissionModeLine(""), null, "empty scan → keep waiting");
assert.equal(
  parseClaudePermissionModeLine("· Thinking… (esc to interrupt)"),
  null,
  "unrelated TUI chrome → keep waiting",
);

// — Word-positioned / ANSI-decorated redraw: claude lays the line out with
//   cursor moves, so stripping ANSI glues the words. The parser compacts (ANSI
//   + ALL whitespace removed) before matching, so it still recognizes it. —
assert.equal(
  parseClaudePermissionModeLine("\x1b[2m\x1b[38;5;244m⏸ plan\x1b[0m\x1b[20Gmode on\x1b[0m"),
  "plan",
  "ANSI + cursor-positioned mode line still parses",
);
assert.equal(
  parseClaudePermissionModeLine("⏵⏵   auto    mode\n   on"),
  "auto",
  "collapsed whitespace bridges a wrapped mode line",
);

// — Last match wins: a repaint that redraws the PRIOR mode line above the
//   current one must not outvote the most recent landing. —
assert.equal(
  parseClaudePermissionModeLine("⏸ plan mode on\n⏵⏵ auto mode on"),
  "auto",
  "the most recent (last) mode line wins over a repainted earlier one",
);
assert.equal(
  parseClaudePermissionModeLine("⏵⏵ auto mode on\n⏸ manual mode on"),
  "default",
  "…and again in the other order (last match is authoritative)",
);

// — Case-insensitive (defensive): the TUI is lowercase, but the parser lowercases
//   so a capitalization change upstream doesn't silently break detection. (The
//   glyph anchor is case-invariant, so the leading `⏵⏵` still qualifies.) —
assert.equal(
  parseClaudePermissionModeLine("⏵⏵ ACCEPT EDITS ON"),
  "acceptEdits",
  "case-insensitive match (glyph-anchored)",
);

// — GLYPH ANCHOR (S2 review finding 1): the phrase alone, WITHOUT the leading
//   status glyph, must NOT settle — otherwise a repaint of assistant prose that
//   happens to contain the target phrase would halt the choreography one mode
//   short while signalling success (silent under-delivery). The real mode line
//   is always glyph-prefixed (measured — spikes/glyph-capture.mjs). —
assert.equal(
  parseClaudePermissionModeLine("I'll turn plan mode on next"),
  null,
  "prose containing the phrase but NO leading glyph must not be read as a receipt",
);
assert.equal(
  parseClaudePermissionModeLine("please switch to accept edits on the repo"),
  null,
  "prose 'accept edits on …' without the glyph is not a receipt",
);
assert.equal(
  parseClaudePermissionModeLine("planmodeon"),
  null,
  "the bare glued phrase (no glyph) is not a receipt",
);
// …but a real glyphed mode line sitting AFTER prose that contains the phrase
// still parses to the real landing (the anchor rejects the prose, keeps the line).
assert.equal(
  parseClaudePermissionModeLine("I'll turn plan mode on next\n⏸ manual mode on"),
  "default",
  "a real glyphed mode line still wins over prose containing a (glyph-less) phrase",
);

// ===========================================================================
// Codex `/permissions` picker choreography — cursor + receipt parsers (S3).
// Strings are MEASURED from real codex 0.144.5 through the app's own
// cleanTerminal + whitespace-strip (spikes/midsession-switch-probe + the S3
// capture, 2026-07-18). The picker header, its three rows, the `›` (U+203A)
// cursor, the `Press enter…` footer, and the `• Permissions updated to <label>`
// receipt are all verbatim frames the parsers must key on.
// ===========================================================================

// Real captured frames (compacted form shown for reference; the parsers compact
// internally, so the tests pass the near-raw redraw text they see on the wire).
const PICKER_OPEN =
  "/permissions/permissionschoosewhatCodexisallowedtodoUpdateModelPermissions›1.Askforapproval(current)Codexcanreadandeditfilesinthecurrentworkspace,andruncommands.Approvalisrequiredtoaccesstheinternetoreditotherfiles.2.ApproveformeOnlyaskforactionsdetectedaspotentiallyunsafe.3.FullAccessCodexcaneditfilesoutsidethisworkspaceandaccesstheinternetwithoutaskingforapproval.Exercisecautionwhenusing.Pressentertoconfirmoresctogoback";
const PICKER_AFTER_DOWN1 =
  "1.Askforapproval(current)Codexcanreadandeditfilesinthecurrentworkspace,andruncommands.Approvalisrequiredtoaccesstheinternetoreditotherfiles.›2.ApproveformeOnlyaskforactionsdetectedaspotentiallyunsafe.";
const PICKER_AFTER_DOWN2 =
  "2.ApproveformeOnlyaskforactionsdetectedaspotentiallyunsafe.›3.FullAccessCodexcaneditfilesoutsidethisworkspaceandaccesstheinternetwithoutaskingforapproval.Exercisecautionwhenusing.";
const RECEIPT_APPROVE =
  "›Writetestsfor@filenamegpt-5.6-solhigh·/tmp/ws•PermissionsupdatedtoApproveforme";
const COMPOSER_AFTER_ESC = "›Writetestsfor@filenamegpt-5.6-solhigh·/tmp/ws";

// — Picker open detection (header anchor). —
assert.equal(codexPermissionPickerOpen(PICKER_OPEN), true, "the picker header marks it open");
assert.equal(
  codexPermissionPickerOpen(COMPOSER_AFTER_ESC),
  false,
  "the bare composer (post-Esc) is NOT the picker",
);
assert.equal(codexPermissionPickerFooterVisible(PICKER_OPEN), true, "the confirm/cancel footer is up");
assert.equal(
  codexPermissionPickerFooterVisible(COMPOSER_AFTER_ESC),
  false,
  "the footer is gone once the picker closes (Esc-rollback verification signal)",
);

// — Cursor row identified by the `›`+digit+label anchor, mapped by LABEL (never
//   the row number — D5: match by TEXT). The opening frame's cursor is on the
//   current mode (`›1.Ask for approval (current)`). —
assert.equal(
  parseCodexPermissionPickerCursor(PICKER_OPEN),
  "ask-for-approval",
  "opening cursor sits on the current row (ask-for-approval)",
);
assert.equal(
  parseCodexPermissionPickerCursor(PICKER_AFTER_DOWN1),
  "approve-for-me",
  "one arrow-down moves the cursor to approve-for-me",
);
assert.equal(
  parseCodexPermissionPickerCursor(PICKER_AFTER_DOWN2),
  "full-access",
  "a second arrow-down moves the cursor to full-access",
);

// — The `›` cursor also LEADS the composer placeholder (`›Write tests…`), so a
//   bare `›` without a digit+row-label must NOT read as a picker cursor. —
assert.equal(
  parseCodexPermissionPickerCursor(COMPOSER_AFTER_ESC),
  null,
  "the composer placeholder's `›` (no digit/row) is not a picker cursor",
);
assert.equal(
  parseCodexPermissionPickerCursor(""),
  null,
  "an empty scan → no cursor yet (keep waiting)",
);

// — Non-cursor rows carry no `›`, so a picker frame reports ONLY the highlighted
//   row, never all three. (down1 has row 1 without `›`, only row 2 cursored.) —
assert.notEqual(
  parseCodexPermissionPickerCursor(PICKER_AFTER_DOWN1),
  "ask-for-approval",
  "a row rendered without the `›` cursor is not reported as the cursor row",
);

// — Receipt parser (bullet-anchored, LABEL-matched). —
assert.equal(
  parseCodexPermissionReceipt(RECEIPT_APPROVE),
  "approve-for-me",
  "the `• Permissions updated to Approve for me` receipt maps to approve-for-me",
);
assert.equal(
  parseCodexPermissionReceipt("• Permissions updated to Full Access"),
  "full-access",
  "…and Full Access maps to full-access",
);
assert.equal(
  parseCodexPermissionReceipt("• Permissions updated to Ask for approval"),
  "ask-for-approval",
  "…and Ask for approval maps to ask-for-approval",
);

// — No receipt yet → null (keep waiting). The picker frame itself is NOT a
//   receipt (it names the rows but carries no `• Permissions updated to` line). —
assert.equal(parseCodexPermissionReceipt(""), null, "empty scan → no receipt yet");
assert.equal(
  parseCodexPermissionReceipt(PICKER_OPEN),
  null,
  "the open picker (row labels only) is not a confirm receipt",
);

// — BULLET ANCHOR (S2 glyph lesson): the phrase WITHOUT the leading `•` codex
//   event bullet must NOT read as a receipt — prose could contain the words. —
assert.equal(
  parseCodexPermissionReceipt("I updated the permissions to Approve for me earlier"),
  null,
  "prose containing the words but no `•` bullet is not a receipt",
);
assert.equal(
  parseCodexPermissionReceipt("PermissionsupdatedtoApproveforme"),
  null,
  "the bare glued phrase (no bullet) is not a receipt",
);

// — ANSI-decorated / whitespace-noisy redraw still parses (compacted internally). —
assert.equal(
  parseCodexPermissionReceipt("\x1b[32m•\x1b[0m Permissions   updated\n   to   Approve for me"),
  "approve-for-me",
  "ANSI + collapsed-whitespace receipt still parses",
);
assert.equal(
  parseCodexPermissionPickerCursor("\x1b[7m›\x1b[0m2.\x1b[1mApprove for me\x1b[0m"),
  "approve-for-me",
  "ANSI-decorated cursor row still parses",
);

// — Full Access consent dialog (RED LINE 2): confirming Full Access opens an
//   "Enable full access?" consent dialog, NOT a receipt. The choreography PARKS
//   on it and relays its rows — it is never auto-answered. Detection reads the
//   GRID; the fixtures live in the S7 section below (CONSENT_GRID), which also
//   pins WHY the stream cannot serve this query. —
assert.equal(
  codexPermissionConsentDialogOpen("Enable full access? When Codex runs with full access…"),
  true,
  "the `Enable full access?` consent dialog is recognized (park, never auto-answer)",
);
assert.equal(
  codexPermissionConsentDialogOpen(PICKER_OPEN),
  false,
  "the plain permission picker is NOT the consent dialog",
);
assert.equal(
  codexPermissionConsentDialogOpen(COMPOSER_AFTER_ESC),
  false,
  "the bare composer is not the consent dialog",
);

// — Cross-vocabulary isolation: a claude mode line is not a codex cursor/receipt. —
assert.equal(
  parseCodexPermissionPickerCursor("⏸ plan mode on"),
  null,
  "a claude mode line is not a codex picker cursor",
);
assert.equal(
  parseCodexPermissionReceipt("⎿ Set model to Sonnet 5"),
  null,
  "a claude model receipt is not a codex permission receipt",
);

// ===========================================================================
// Codex `/model` TWO-level picker choreography — level parsers + receipt (S4).
// Strings are MEASURED from real codex 0.144.5 (spikes/midsession-switch-probe/
// codex-run2.snaps.log), passed here in near-raw form (spaces + the real glyphs);
// the parsers compact internally (ANSI + whitespace stripped), so the picker
// headers, the DYNAMIC model rows, the reasoning rows, the `›` cursor, `(current)`
// marker, the shared footer, and the `• Model changed to <model> <effort>`
// receipt are all verbatim frames the parsers key on.
// ===========================================================================

// Level 1 (models) — the opening frame, cursor + (current) on gpt-5.6-sol.
const MODEL_L1 =
  "Select Model and Effort  Access legacy models by running codex -m <model_name> or in your config.toml" +
  "  › 1. gpt-5.6-sol (current)  Latest frontier agentic coding model." +
  "  2. gpt-5.6-terra  Balanced agentic coding model for everyday work." +
  "  3. gpt-5.6-luna  Fast and affordable agentic coding model." +
  "  4. gpt-5.5  Frontier model for complex coding, research, and real-world work." +
  "  5. gpt-5.3-codex-spark  Ultra-fast coding model." +
  "  Press enter to confirm or esc to go back";
// The SAME frame after two arrow-downs (cursor now on gpt-5.6-luna).
const MODEL_L1_ON_LUNA =
  "Select Model and Effort  Access legacy models by running codex -m <model_name> or in your config.toml" +
  "  1. gpt-5.6-sol (current)  Latest frontier agentic coding model." +
  "  2. gpt-5.6-terra  Balanced agentic coding model for everyday work." +
  "  › 3. gpt-5.6-luna  Fast and affordable agentic coding model." +
  "  4. gpt-5.5  Frontier model for complex coding, research, and real-world work." +
  "  5. gpt-5.3-codex-spark  Ultra-fast coding model." +
  "  Press enter to confirm or esc to go back";
// Level 2 (reasoning) frame — rendered BELOW the level-1 frame (both present),
// cursor + (current) on High, (default) on Low.
const MODEL_L2 =
  MODEL_L1 +
  "  Select Reasoning Level for gpt-5.6-sol" +
  "  1. Low (default)  Fast responses with lighter reasoning" +
  "  2. Medium  Balances speed and reasoning depth for everyday tasks" +
  "  › 3. High (current)   Greater reasoning depth for complex problems" +
  "  4. Extra high       Extra high reasoning depth for complex problems" +
  "  5. More reasoning…  Max and Ultra consume usage limits faster" +
  "  Press enter to confirm or esc to go back";
const MODEL_RECEIPT = "• Model changed to gpt-5.6-sol xhigh";
const MODEL_COMPOSER_AFTER = "›Implement {feature}gpt-5.6-sol xhigh · /tmp/ws";

// — Level headers + footer. —
assert.equal(codexModelPickerLevel1Open(MODEL_L1), true, "the level-1 header marks the model picker open");
assert.equal(
  codexModelPickerLevel1Open(MODEL_COMPOSER_AFTER),
  false,
  "the bare composer is NOT the level-1 picker",
);
assert.equal(codexModelPickerLevel2Open(MODEL_L2), true, "the level-2 header marks the reasoning picker open");
assert.equal(
  codexModelPickerLevel2Open(MODEL_L1),
  false,
  "level 1 alone does not read as level 2 (reasoning header absent)",
);
assert.equal(
  codexModelPickerLevel2Open(MODEL_L2, "gpt-5.6-sol"),
  true,
  "level 2 names the model chosen at level 1 (the header must match)",
);
assert.equal(
  codexModelPickerLevel2Open(MODEL_L2, "gpt-5.6-luna"),
  false,
  "a level-2 header for a DIFFERENT model does not satisfy the chosen-model check",
);
assert.equal(codexModelPickerFooterVisible(MODEL_L1), true, "the confirm/cancel footer is up while a level is open");
assert.equal(
  codexModelPickerFooterVisible(MODEL_COMPOSER_AFTER),
  false,
  "the footer is gone once the picker closes (rollback verification signal)",
);

// — Level-1 (model) rows: cursor, (current), and the DYNAMIC digit order. Row
//   identity is the `gpt-` slug (matches Sonata's curated `-m` value verbatim —
//   D5), never the digit. —
{
  const l1 = parseCodexModelLevel1(MODEL_L1);
  assert.equal(l1.cursor, "gpt-5.6-sol", "opening cursor sits on the current model row");
  assert.equal(l1.current, "gpt-5.6-sol", "the (current) marker identifies the model to preserve");
  assert.equal(l1.order.get("gpt-5.6-sol"), 1, "digit order: sol = 1");
  assert.equal(l1.order.get("gpt-5.6-terra"), 2, "digit order: terra = 2");
  assert.equal(l1.order.get("gpt-5.6-luna"), 3, "digit order: luna = 3");
  assert.equal(l1.order.get("gpt-5.5"), 4, "digit order: 5.5 = 4");
  assert.equal(l1.order.get("gpt-5.3-codex-spark"), 5, "digit order: spark = 5");
  assert.equal(l1.byDigit.get(2), "gpt-5.6-terra", "the neighbor lookup (digit → slug) resolves");
  // Legacy models (gpt-5.4 / gpt-5.4-mini) are NOT offered by this picker — a
  // switch to one must be recognizable as absent (D5 → rollback).
  assert.equal(l1.order.has("gpt-5.4"), false, "gpt-5.4 (legacy) is absent from the picker rows");
  assert.equal(l1.order.has("gpt-5.4-mini"), false, "gpt-5.4-mini (legacy) is absent too");
}
{
  const l1 = parseCodexModelLevel1(MODEL_L1_ON_LUNA);
  assert.equal(l1.cursor, "gpt-5.6-luna", "after two downs the cursor is on luna (validate-each-press)");
  assert.equal(l1.current, "gpt-5.6-sol", "the (current) marker stays on sol (not the cursor)");
}

// — Level-2 (reasoning) rows: cursor, (current), the fixed effort order, and the
//   `More reasoning…` submenu row (recognized ONLY to refuse it, D6). Parsing the
//   COMBINED (L1+L2) frame proves the level slices don't bleed into each other. —
{
  const l2 = parseCodexModelLevel2(MODEL_L2);
  assert.equal(l2.cursor, "high", "level-2 cursor sits on the current reasoning (High)");
  assert.equal(l2.current, "high", "the (current) marker identifies the reasoning to preserve");
  assert.equal(l2.order.get("low"), 1, "Low → low (row 1); (default) is NOT (current)");
  assert.equal(l2.order.get("medium"), 2, "Medium → medium (row 2)");
  assert.equal(l2.order.get("high"), 3, "High → high (row 3)");
  assert.equal(l2.order.get("xhigh"), 4, "Extra high → xhigh (row 4)");
  assert.equal(l2.order.get("more"), 5, "More reasoning… → more (row 5, never a target)");
  // The combined frame's level-1 parse still sees ONLY model rows (no bleed).
  const l1 = parseCodexModelLevel1(MODEL_L2);
  assert.equal(l1.cursor, "gpt-5.6-sol", "level-1 parse of the combined frame still reads the model cursor");
  assert.equal(l1.order.has("high"), false, "level-1 rows never include a reasoning label");
}

// — (current) on a NON-cursor reasoning row (a model switch that preserves xhigh
//   while the cursor rests elsewhere): current is read independently of cursor. —
{
  const frame =
    "Select Reasoning Level for gpt-5.6-luna" +
    "  › 1. Low  Fast responses" +
    "  2. Medium  Balances" +
    "  3. High  Greater depth" +
    "  4. Extra high (current)  Extra high reasoning depth" +
    "  5. More reasoning…  Max and Ultra" +
    "  Press enter to confirm or esc to go back";
  const l2 = parseCodexModelLevel2(frame);
  assert.equal(l2.cursor, "low", "cursor on Low");
  assert.equal(l2.current, "xhigh", "(current) on Extra high is read as xhigh regardless of the cursor");
}

// — Receipt parser (bullet-anchored; splits the glued model + reasoning). —
assert.deepEqual(
  parseCodexModelReceipt(MODEL_RECEIPT),
  { model: "gpt-5.6-sol", effort: "xhigh" },
  "the receipt yields BOTH the model slug and the reasoning token",
);
assert.deepEqual(
  parseCodexModelReceipt("• Model changed to gpt-5.6-luna medium"),
  { model: "gpt-5.6-luna", effort: "medium" },
  "…and a medium receipt splits luna + medium",
);
assert.deepEqual(
  parseCodexModelReceipt("• Model changed to gpt-5.5 high"),
  { model: "gpt-5.5", effort: "high" },
  "…and `high` (a suffix of `xhigh`) is not mis-split off gpt-5.5",
);
assert.deepEqual(
  parseCodexModelReceipt("• Model changed to gpt-5.4-mini low"),
  { model: "gpt-5.4-mini", effort: "low" },
  "…and a hyphenated slug + low splits cleanly",
);

// — No receipt yet / not a receipt → null (keep waiting). —
assert.equal(parseCodexModelReceipt(""), null, "empty scan → no receipt yet");
assert.equal(parseCodexModelReceipt(MODEL_L1), null, "the open picker (row labels) is not a receipt");
assert.equal(
  parseCodexModelReceipt(MODEL_COMPOSER_AFTER),
  null,
  "the composer footer (model + effort, no bullet) is not a receipt",
);
// BULLET ANCHOR (S2 glyph lesson): the phrase without the `•` codex event bullet
// must NOT read as a receipt — prose could contain the words.
assert.equal(
  parseCodexModelReceipt("I changed the model to gpt-5.6-sol high yesterday"),
  null,
  "prose containing the words but no `•` bullet is not a receipt",
);
// — Max/Ultra receipts. Sonata never TARGETS Max/Ultra (D6 — the choreography
//   refuses the `More reasoning…` row), but the receipt REPORTS whatever codex
//   applied, and reading one as null would make the confirm phase time out and
//   Esc-roll back a change that already landed.
//   PROVENANCE (the method lesson — these labels are what future syncs trust):
//   the Ultra line is MEASURED verbatim on codex 0.146.0 (spikes/upstream-sync-
//   2026-08/codex/findings.md §Q2), and it is the form that carries the
//   `for this conversation` suffix — the half a future end-anchor "tightening"
//   would quietly break, so it is pinned as captured. The Max line is
//   EXTRAPOLATED, NOT captured: no Max receipt was ever taken. It combines the
//   tier set with the BARE receipt shape that IS measured (the medium control
//   above, and the high/low/xhigh cases before it). Treat it as a tier-coverage
//   case, not as evidence of what a Max confirm prints. —
assert.deepEqual(
  parseCodexModelReceipt("• Model changed to gpt-5.6-sol ultra for this conversation"),
  { model: "gpt-5.6-sol", effort: "ultra" },
  "the MEASURED Ultra receipt (with the `for this conversation` suffix) parses as ultra",
);
assert.deepEqual(
  parseCodexModelReceipt("• Model changed to gpt-5.6-sol max"),
  { model: "gpt-5.6-sol", effort: "max" },
  "…and the EXTRAPOLATED bare Max form (measured shape, uncaptured tier) parses as max",
);
// The suffix is not a licence for prose: an unrecognized token after the model is
// still null (the parser confirms a TIER, never an arbitrary word).
assert.equal(
  parseCodexModelReceipt("• Model changed to gpt-5.6-sol turbo"),
  null,
  "an effort token outside the six tiers is not a receipt — the parser waits",
);

// — ANSI-decorated / whitespace-noisy redraw still parses (compacted internally). —
assert.deepEqual(
  parseCodexModelReceipt("\x1b[32m•\x1b[0m Model   changed\n   to   gpt-5.6-sol   xhigh"),
  { model: "gpt-5.6-sol", effort: "xhigh" },
  "ANSI + collapsed-whitespace receipt still parses",
);

// — Cross-vocabulary isolation: a codex /permissions cursor / claude line is not
//   a /model picker artifact, and vice-versa. —
assert.equal(
  parseCodexModelLevel1("› 1. Ask for approval (current)").cursor,
  null,
  "a /permissions row (no gpt- slug) is not a /model level-1 cursor",
);
assert.equal(
  parseCodexModelReceipt("• Permissions updated to Approve for me"),
  null,
  "a /permissions receipt is not a /model receipt",
);
assert.equal(
  parseCodexPermissionReceipt(MODEL_RECEIPT),
  null,
  "a /model receipt is not a /permissions receipt",
);

// ── S7: claude cache-miss confirm dialog (park + drawer relay) ──────────────
// Verbatim frames (claude 2.1.214 — spikes/midsession-switch-probe/findings.md
// §"S7 cache-miss probe"). The parser compacts (ANSI-strip + whitespace-strip),
// so these human-readable strings exercise the same path the pty tail does.
const CACHE_MISS_MODEL =
  "Switch model?\n" +
  "Your next response will be slower and use more tokens\n" +
  "This conversation is cached for the current model. Switching to Sonnet 5 means the full history gets re-read on your next message.\n" +
  "❯ 1. Yes, switch to Sonnet 5\n" +
  "  2. No, go back";
const CACHE_MISS_EFFORT =
  "Change effort level?\n" +
  "Your next response will be slower and use more tokens\n" +
  "This conversation is cached for the current effort level. Switching to low means the full history gets re-read on your next message.\n" +
  "❯ 1. Yes, switch to low\n" +
  "  2. No, go back";
assert.equal(claudeCacheMissDialogOpen(CACHE_MISS_MODEL), true, "the model cache-miss dialog is recognized");
assert.equal(claudeCacheMissDialogOpen(CACHE_MISS_EFFORT), true, "the effort cache-miss dialog is recognized");
// Negative — the co-occurrence guard (RED LINE: prose must not forge it):
assert.equal(
  claudeCacheMissDialogOpen(
    "Sure — the full history gets re-read on your next message when you switch, but you don't need to worry.",
  ),
  false,
  "the body phrase ALONE (assistant prose) is NOT the dialog — needs the No-row too",
);
assert.equal(
  claudeCacheMissDialogOpen("Options:\n 1. keep going\n 2. No, go back"),
  false,
  "a `2. No, go back` row ALONE is NOT the dialog — needs the body phrase too",
);
// Cursor (arrows move `❯`; Enter selects):
assert.equal(parseClaudeCacheMissCursor(CACHE_MISS_MODEL), 1, "cursor starts on row 1 (Yes)");
assert.equal(
  parseClaudeCacheMissCursor("  1. Yes, switch to Sonnet 5\n❯ 2. No, go back"),
  2,
  "cursor on row 2 (No) after a down-arrow",
);
// The partial arrow-move repaint DROPS the row digit (measured): `❯No, go back`
// with no `2.` — the cursor must still read row 2 (label-anchored, digit optional).
assert.equal(
  parseClaudeCacheMissCursor("  Yes, switch to Sonnet 5\n❯No, go back"),
  2,
  "cursor on row 2 when the arrow-move repaint dropped the digit (label-anchored)",
);
assert.equal(
  parseClaudeCacheMissCursor("❯Yes, switch to Sonnet 5\n  No, go back"),
  1,
  "cursor on row 1 when the repaint dropped the digit",
);
assert.equal(
  parseClaudeCacheMissCursor(
    "❯ 1. Yes, switch to Sonnet 5\n  2. No, go back\n  1. Yes, switch to Sonnet 5\n❯ 2. No, go back",
  ),
  2,
  "most-recent cursor frame wins (a stale row-1 repaint can't outvote row 2)",
);
assert.equal(parseClaudeCacheMissCursor("❯ Write your prompt here"), null, "the composer `❯` prompt is not a dialog cursor");
// Cancel receipt (No / Esc → `Kept … as …`, axis-scoped):
assert.equal(claudeCacheMissCancelled("  ⎿  Kept model as Fable 5", "model"), true, "a `Kept model as` line is a model cancel");
assert.equal(claudeCacheMissCancelled("  ⎿  Kept model as Fable 5", "effort"), false, "a model cancel is not an effort cancel");
assert.equal(claudeCacheMissCancelled("  ⎿  Kept effort level as high", "effort"), true, "a `Kept effort level as` line is an effort cancel");

// ── S7: codex Full Access consent (park + drawer relay), GRID-fed ───────────
//
// MEASURED VERBATIM from real codex 0.146.0 — spikes/upstream-sync-2026-08/codex,
// `out-q1-consent.frames.log`, the rendered SCREEN @ consent-1st. The probe's
// screen extraction is byte-identical to `TaskScreenModel.viewportText()`
// (`buffer.getLine(viewportY + y).translateToString(true)` joined with "\n"), so
// these ARE the rows the parsers see in production.
//
// TWO rows at 0.146.0 (F1: `Yes, and don't ask again` deleted upstream → Cancel
// moved 3 → 2), cursor `›` U+203A.
const CONSENT_GRID =
  "  Enable full access?\n" +
  "  When Codex runs with full access, it can edit any file on your computer and run commands with network, without your\n" +
  "  approval. Exercise caution when enabling full access. This significantly increases the risk of data loss, leaks, or\n" +
  "  unexpected behavior.\n" +
  "\n" +
  "› 1. Yes, continue anyway  Apply full access for this session\n" +
  "  2. Cancel                Go back without enabling full access\n" +
  "\n" +
  "  Press enter to confirm or esc to go back";
// Cursor on row 2 — the same measured frame with the `›` moved one row down (a
// down-arrow only relocates the glyph; the rows themselves are static).
const CONSENT_GRID_ROW2 =
  "  Enable full access?\n" +
  "  1. Yes, continue anyway  Apply full access for this session\n" +
  "› 2. Cancel                Go back without enabling full access\n" +
  "\n" +
  "  Press enter to confirm or esc to go back";
// The grid AFTER an Esc from the consent (measured @ after-esc-from-consent): the
// idle composer. 0.146.0 does NOT return to the /permissions picker — the consent
// REPLACED it. This is the relay's native-cancel signal, and it works ONLY on the
// grid: the grid converges to the current screen, so the dialog is simply gone.
const CONSENT_GRID_AFTER_ESC =
  "• You have 1 usage limit reset available. Run /usage to use one.\n" +
  "\n" +
  "› Improve documentation in @filename\n" +
  "\n" +
  "  gpt-5.6-sol high · /tmp/ws";
// WHY THE CHANNEL MOVED (the SL-2 red line). This is the RAW pty stream as the
// production compaction sees it at the very same instant CONSENT_GRID is on
// screen (measured, `capture-q1-consent-repaint.txt`): codex repaints the consent
// as a CELL DIFF over the /permissions picker that held those rows, so every cell
// already carrying the right character is NEVER transmitted — the `e` of "Enable"
// (the picker's frame had `e ` in columns 8-9), the `› ` cursor and the `.` after
// the digit. A stream-fed detector is therefore FALSE on a dialog that is plainly
// displayed, and no widened needle can fix it (which characters vanish depends on
// the prior frame and the terminal width).
const CONSENT_RAW_STREAM_CELL_DIFF =
  "Enablfullaccess?WhenCodexrunswithfullaccess,itcaneditanyfileonyourcomputerandruncommandswithnetwork," +
  "withoutyourapproval.Exercisecautionwhenenablingfullaccess.Thissignificantlyincreasestheriskofdataloss," +
  "leaks,orunexpectedbehavior.1Yes,continueanywayApplyfullacessforthiseson2.CancelGobackwithoutenablingfullaccess";

assert.equal(codexPermissionConsentDialogOpen(CONSENT_GRID), true, "the measured 0.146.0 consent GRID is recognized");
assert.equal(
  codexPermissionConsentDialogOpen(CONSENT_RAW_STREAM_CELL_DIFF),
  false,
  "…and the SAME dialog is invisible on the raw stream (cell-diff elision) — the measured reason the query reads the grid",
);
assert.equal(
  parseCodexConsentCursor(CONSENT_RAW_STREAM_CELL_DIFF),
  null,
  "…the stream loses the `›` cursor glyph and the row dot too, so the cursor is unreadable there",
);
assert.equal(
  codexPermissionConsentDialogOpen(CONSENT_GRID_AFTER_ESC),
  false,
  "the post-Esc grid is the idle COMPOSER — absence on the grid is the native-cancel signal",
);
assert.equal(parseCodexConsentCursor(CONSENT_GRID), 1, "consent cursor starts on row 1 (Yes, continue anyway)");
assert.equal(parseCodexConsentCursor(CONSENT_GRID_ROW2), 2, "consent cursor on row 2 (Cancel) after one down-arrow");
// LABEL-anchored, never row-number-blind: a `›\d.` row whose label is not a
// consent label must not read as a consent cursor (the discipline that makes an
// unrecognized screen fail SAFE — null → wait → needs-attention, never a guess).
assert.equal(
  parseCodexConsentCursor("› 1. Ask for approval (current)"),
  null,
  "a /permissions picker row is not a consent cursor (label anchor, not the digit)",
);
assert.equal(
  parseCodexConsentCursor(CONSENT_GRID_AFTER_ESC),
  null,
  "the composer placeholder's `›` is not a consent cursor",
);
// Most-recent-wins: a stale row-1 frame cannot outvote the latest highlight.
assert.equal(
  parseCodexConsentCursor(`${CONSENT_GRID}\n${CONSENT_GRID_ROW2}`),
  2,
  "the most recent cursor frame wins",
);
// The consent frame carries no `• Permissions updated to` receipt — the engine
// must not mistake it for a settle (receipts stay on the stream regardless).
assert.equal(
  parseCodexPermissionReceipt(CONSENT_GRID),
  null,
  "the consent dialog is not a confirm receipt",
);

console.log("midsession-receipt: OK");
