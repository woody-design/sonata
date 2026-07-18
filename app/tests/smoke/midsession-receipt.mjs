import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Unit coverage for the mid-session switch receipt parser (S1). The pure
// parser is the seam the receipt watcher keys on: it turns the RAW pty tail
// (ANSI + word-positioned redraw + whitespace noise) into a settle / fail /
// keep-waiting verdict. Strings are the probe-verified verbatim receipts
// (claude 2.1.214 — spikes/midsession-switch-probe/findings.md).
const require = createRequire(import.meta.url);
const {
  parseClaudeControlReceipt,
  parseClaudePermissionModeLine,
  parseCodexPermissionPickerCursor,
  parseCodexPermissionReceipt,
  codexPermissionPickerOpen,
  codexPermissionPickerFooterVisible,
  codexPermissionConsentDialogOpen,
} = require("../../dist/runtime");

// — Success: model —
assert.equal(
  parseClaudeControlReceipt(
    "⎿ Set model to Sonnet 5 and saved as your default for new sessions",
    "model",
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
  ),
  "settled",
  "the word-positioned (glued) model receipt still settles",
);
assert.equal(
  parseClaudeControlReceipt("  ⎿  SeteffortleveltolowsavedasyourdefaultfornewsessionsX", "effort"),
  "settled",
  "the word-positioned (glued) effort receipt still settles",
);

// — Success: effort —
assert.equal(
  parseClaudeControlReceipt(
    "⎿ Set effort level to low (saved as your default for new sessions)",
    "effort",
  ),
  "settled",
  "the `Set effort level to …` receipt settles an effort switch",
);

// — Failure: model —
assert.equal(
  parseClaudeControlReceipt("⎿ Model 'bogus-model-xyz' not found", "model"),
  "failed",
  "the `Model '<x>' not found` receipt fails a model switch",
);

// — Timeout paths: no receipt yet (parser returns null → the watcher waits,
//   then the timeout re-classifies the screen as needs-attention). —
assert.equal(
  parseClaudeControlReceipt("❯ /model sonnet", "model"),
  null,
  "the echoed command line is not a receipt",
);
assert.equal(
  parseClaudeControlReceipt("", "model"),
  null,
  "an empty scan keeps waiting",
);
assert.equal(
  parseClaudeControlReceipt(
    "· Thinking… (esc to interrupt · ctrl+t to hide todos)",
    "effort",
  ),
  null,
  "unrelated TUI chrome keeps waiting",
);

// — Cross-kind isolation: each kind matches only its own receipt line. —
assert.equal(
  parseClaudeControlReceipt("⎿ Set effort level to low", "model"),
  null,
  "an effort receipt must NOT settle a model switch",
);
assert.equal(
  parseClaudeControlReceipt("⎿ Set model to Sonnet 5", "effort"),
  null,
  "a model receipt must NOT settle an effort switch",
);
// `/effort` has no probed failure receipt — a `Model '…' not found` in the
// scan must not fail an effort switch (it times out to needs-attention).
assert.equal(
  parseClaudeControlReceipt("⎿ Model 'x' not found", "effort"),
  null,
  "the model-failure line does not fail an effort switch",
);

// — Robustness: ANSI escapes + word-positioned redraw + whitespace noise. The
//   parser strips ANSI and collapses whitespace, so a split/positioned receipt
//   still matches (the RAW tail is accumulated before parsing). —
assert.equal(
  parseClaudeControlReceipt(
    "\x1b[2m\x1b[38;5;244m⎿ Set model to\x1b[0m\x1b[32G Fable 5\x1b[0m",
    "model",
  ),
  "settled",
  "ANSI-decorated + cursor-positioned receipt still settles",
);
assert.equal(
  parseClaudeControlReceipt("⎿   Set    model\n   to   Opus 4.8", "model"),
  "settled",
  "collapsed whitespace bridges a wrapped receipt",
);

// — Failure wins over success in the same scan (safe ordering): a screen that
//   somehow shows both is treated as a failure, never a false settle. —
assert.equal(
  parseClaudeControlReceipt(
    "⎿ Model 'bogus' not found\n⎿ Set model to Sonnet 5",
    "model",
  ),
  "failed",
  "a failure line in the scan wins over a later success line",
);

// ===========================================================================
// Permission Shift+Tab stepping engine — mode-line receipt parser (S2). The
// engine presses `\x1b[Z` and reads the TUI mode line to learn which mode it
// landed in. Strings are the probe-verified cycle receipts (claude 2.1.214 —
// spikes/midsession-switch-probe/findings.md §S0).
// ===========================================================================

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

// — Full Access consent dialog (RED LINE 2): confirming Full Access opens a
//   "Enable full access?" consent dialog, NOT a receipt. The choreography must
//   recognize it and roll back — it is never auto-answered. (Measured verbatim,
//   codex 0.144.5.) —
const FULL_ACCESS_CONSENT =
  "Enable full access? When Codex runs with full access, it can edit any file on your computer and run commands with network, without your approval.›1.Yes,continueanywayApplyfullaccessforthissession2.Yes,anddon'taskagainEnablefullaccessandrememberthischoice3.CancelGobackwithoutenablingfullaccessPressentertoconfirmoresctogoback";
assert.equal(
  codexPermissionConsentDialogOpen("Enable full access? When Codex runs with full access…"),
  true,
  "the `Enable full access?` consent dialog is recognized (roll back, never auto-answer)",
);
assert.equal(
  codexPermissionConsentDialogOpen(FULL_ACCESS_CONSENT),
  true,
  "…the full measured consent frame is recognized",
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
// The consent frame carries no `• Permissions updated to` receipt — the engine
// must not mistake it for a settle.
assert.equal(
  parseCodexPermissionReceipt(FULL_ACCESS_CONSENT),
  null,
  "the consent dialog is not a confirm receipt",
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

console.log("midsession-receipt: OK");
