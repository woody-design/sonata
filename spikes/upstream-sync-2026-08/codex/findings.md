# Probe S1 — codex 0.146.0 measured findings (2026-08-03)

Status: PASS — all five questions measured live against `codex-cli 0.146.0`,
isolated `CODEX_HOME` (scratch, seeded auth), node-pty + `@xterm/headless`
driver preserving cell attributes; every verdict produced by running Sonata's
PRODUCTION parsers (esbuild-bundled `tui-parsers-codex.ts`, unmodified) over
the captured PTY streams (`needle-check.txt`). Written by the orchestrator
from the S1 agent's report (harness policy blocks subagent report files).

## HEADLINE — cell-diff repaints defeat linear-stream dialog parsing

Codex 0.146 repaints the full-access consent dialog as a CELL DIFF over the
`/permissions` picker occupying the same rows: cells already holding the
right character are NEVER retransmitted (e.g. the `e` of "Enable" — columns
8-9 already held `e ` from the picker; the `› ` cursor and the `.` after the
digit likewise elided). The linear compacted stream reads
`Enablfullaccess?` / `1Yes,continueanyway`.

Production impact (measured, real parsers):
- `CODEX_FULL_ACCESS_CONSENT_RE = /Enablefullaccess\?/` → NO MATCH
- `CODEX_CONSENT_CURSOR_RES[0] /›\d\.Yes,continueanyway/` → NO MATCH
- picker header/footer/cursor REs → still match (picker painted fresh)

So `codexPermissionConsentDialogOpen()` = false and `parseCodexConsentCursor()`
= null WHILE THE DIALOG IS ON SCREEN. Which characters get elided depends on
the prior frame + terminal width → NON-DETERMINISTIC; no regex widening can
fix it. Fix direction: parse a RENDERED FRAME (`@xterm/headless`, already an
app dependency), not the linear byte stream — architecture call, S7 red line.
Evidence: `capture-q1-consent-repaint.txt`.

## Q1 (F1) consent dialog — CONFIRMED 2 rows

`Enable full access?` body + `› 1. Yes, continue anyway  Apply full access
for this session` / `  2. Cancel  Go back without enabling full access` +
`Press enter to confirm or esc to go back`. Cursor `›` U+203A verified.
NEW: **Esc from the consent lands at the idle composer, NOT back on the
picker** — the consent REPLACES the picker (rollback expectations change; the
old measured Cancel→picker→ESC→composer path is gone). Dialog fired on a
fresh session; the persistence row no longer exists. Correction:
`notices.hide_full_access_warning` still parses — only the row that set it
is gone.

### Addendum (SL-2 implementation, same 0.146.0 binary): the consent's two exits are NOT symmetric

S1 measured only the `esc` exit. Driving the OTHER one during SL-2 showed they
differ, and the difference is load-bearing for the relay:

- `esc` from the consent → the idle **composer** (S1's finding, unchanged).
- **Enter on `2. Cancel` → back to the `/permissions` picker**, cursor on row 1,
  picker still OPEN. Nothing else closes it, and an abandoned codex picker
  swallows the next typed characters — measured downstream in the smoke as the
  next `/permissions` inject being eaten and its Enter confirming the picker's
  highlighted row instead.
  So the S3-era "Cancel → picker → one Esc → composer" leg is **still required**
  for the Cancel row; only the Esc path lost it.
- That returning picker is ALSO cell-diff garbled: the stream reads
  `UpdatModelPermissions` (the `e` elided, the consent's own text having held
  those cells), so `codexPermissionPickerOpen` is false on it too. The relay
  therefore does not try to DETECT the return — it spaces one Esc behind the
  Cancel Enter, on the measured certainty of what that Enter does.
- The consent fires AGAIN on a second Full Access confirm in the SAME session
  (smoke switch E parks after switch C cancelled) — no once-per-session
  suppression.

## Q2 (X1) /model picker — RESOLVED: two levels here, CATALOG-decided

Bare `codex` and Sonata's production `codexArgs` render the IDENTICAL picker
— spawn shape irrelevant; the remote catalog decides. This account has no
auto modes → opens at `Select Model and Effort`, 7 `gpt-*` rows, `(current)`
on row 1. L2 `Select Reasoning Level for gpt-5.6-sol`: 5 rows, `(default)`
Low, `(current)` High. L3 `Advanced Reasoning`: Max / Ultra. The suspected
apply-scope level does NOT fire on the default path (Enter on Ultra
committed immediately) — hypothesis retired.

Parsers: L1/L2 pass on WHOLE-SCAN; on a 4000-char window they return
null/0 (post-arrow repaints are cell diffs too) — whole-scan retention is
load-bearing.

Receipts (control experiment):
- → Ultra: `• Model changed to gpt-5.6-sol ultra for this conversation`
  → `parseCodexModelReceipt` = **null** (effort alternation lacks ultra/max)
- → Medium: `• Model changed to gpt-5.6-sol medium` → parses fine.
Failure is Ultra/Max-specific, not format-wide; `for this conversation`
suffix harmless (no end anchor). Residual: a user switching to Ultra/Max
natively goes untracked (truthfulness, not control).

## Q3 (F2) Ultra glyph — CONFIRMED byte-exact and persistent

Composer `›` (U+203A) → after Ultra switch → `»` (U+00BB), still `»` after
6s idle. `U L T R A` banner occupies the footer line ~2.1s (present +1.2s,
+1.9s; gone by +2.4s). NEW: codex composer footer has NO `? for shortcuts` —
it is `<model> <effort> · <cwd>`.

## Q4 (W2) status indicator — both activityHints RENDER; static claim wrong

`• Working (0s • esc to interrupt)` — both `working` and `esc to interrupt`
match on the cleaned tail. Present <60ms after submit, ticks 1/s, the same
line replaced IN PLACE by the answer at completion — no printable-silent gap.
No flicker observed (single turn — keep the W2 watch).

## Q5 boot trust dialog + trust_level serialization — NO CHANGE NEEDED

Dialog renders `› 1. Yes, continue` / `  2. No, quit` / `Press enter to
continue` — ALL FIVE `bootDialogHints` alive ("No, quit" renders despite
being absent from the binary as a literal). Serialization: bare form
`[projects."<abs path>"]` + `trust_level = "trusted"` (od -c verified) —
`parseTrustedProjectPaths` round-trips it; dotted-key risk retired. Note:
grant written to `config.toml` under the profile-less spawn used here
(consistent with the inventory's profile-less claim; the `-p sonata` layer
path not re-verified this round).

## Method lesson (applies to both providers)

**Absence of a contiguous literal in the shipped binary is NOT evidence of
absence in the UI** — parts of the 271MB Rust binary are compressed (zstd
linked), and Bun compilation hides Claude literals the same way. Two static
"ABSENT" calls this sync ("esc to interrupt" codex + claude, "No, quit")
were all refuted live. Static string probes may only be trusted for
PRESENCE, never absence.

## Evidence files

capture-q1-consent-repaint.txt · capture-q5-trust-serialization.txt ·
capture-binary-strings.txt · capture-sonata-profile-trust-ledger.txt ·
needle-check.txt · out-q5a-boot.frames.log · driver.mjs · steps-*.json ·
binary-probe.py

## Deviation ledger (agent's, accepted by orchestrator)

Fresh attribute-preserving driver (the cell-diff garbling IS the headline —
legacy regex-strip harness cannot see it); abortOnTimeout guard (fired for
real at the consent-Esc step — refused to blind-fire Enter); verified with
real bundled parsers, not replicas; added the Medium control switch (splits
"ultra token unsupported" from "format broken"); entered `More reasoning…`
(D6 forbids targeting Max/Ultra — lifted for measurement only; two effort
switches, one trivial prompt); mid-run sanitizer fix (cell-diff repaints
corrupt echoed paths, so single-char-deletion variants of the username are
also masked; captures re-sanitized in place).
