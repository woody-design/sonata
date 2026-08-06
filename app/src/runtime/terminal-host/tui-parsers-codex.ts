import type { CodexPermissionMode, ReasoningEffort } from "../../shared/types/domain";
import { isReasoningEffort } from "../../shared/types/domain";
import { cleanTerminal } from "./tui-parsers-common";

// ── Pure Codex TUI-stream parsers (consolidation S4) ─────────────────────────
// Moved verbatim from terminal-host.ts: the `/permissions` single-level picker,
// the Full Access consent dialog, and the `/model` two-level picker — every
// string probe-measured through the app's own cleanTerminal + whitespace-strip
// (NOT assumed, per the S2 glyph lesson). All pure; unit-pinned by
// tests/smoke/midsession-receipt.mjs. Provenance comments preserved intact.

// Mid-session Codex PERMISSION switch (S3). Codex has no arg form and no
// Shift+Tab cycle: Sonata types bare `/permissions` (RED LINE 1 — a codex slash
// line WITH args submits as a chat prompt and burns a turn, so NEVER append
// anything) + Enter to open a single-level picker, then navigates it by arrow
// keys and Enter, reading the picker's own text as the choreography receipt.
// Every string below is MEASURED from real codex 0.144.5 through the app's own
// cleanTerminal + whitespace-strip (spikes/midsession-switch-probe +
// scratchpad capture, 2026-07-18) — NOT assumed, per the S2 glyph lesson.
//
// Picker (compacted): `UpdateModelPermissions` header, then three rows whose
// LABELS are the match keys (never the row number — D5: match by TEXT, the digit
// is only part of the cursor anchor):
//   `›1.Askforapproval(current)…`  `2.Approveforme…`  `3.FullAccess…`
// The `›` (U+203A) cursor marks the highlighted row; it also leads the composer
// placeholder (`›Write tests…`), so the cursor anchor requires `›` + a DIGIT +
// `.` to tell the picker cursor apart from composer prose. Footer while open:
// `Pressentertoconfirmoresctogoback`. Confirm receipt (a codex event line, `•`
// U+2022 anchor): `•PermissionsupdatedtoApproveforme`.
const CODEX_PICKER_HEADER_RE = /UpdateModelPermissions/;
const CODEX_PICKER_FOOTER_RE = /Pressentertoconfirmoresctogoback/;
// ── Full Access consent dialog — a GRID-fed pair (upstream sync SL-2) ────────
//
// Confirming the **Full Access** row does NOT print a receipt — it opens a
// consent dialog. This is a RED LINE 2 interstitial (the codex trust-dialog
// silent-Yes lineage): granting unrestricted filesystem + network access is a
// human consent Sonata must NEVER auto-answer. S7 (revision 3) OVERTURNS S3's
// rollback-on-detect: instead of Escing the dialog away (which flashed it shut
// before the user could act — "一闪就没了"), the choreography PARKS on it and
// surfaces its rows in the Action Drawer, injecting ONLY the user's chosen
// answer (see the parked-confirm relay).
//
// MEASURED VERBATIM, codex 0.146.0 (spikes/upstream-sync-2026-08/codex,
// `out-q1-consent.frames.log` @ consent-1st) — TWO rows; 0.146.0 deleted the old
// `Yes, and don't ask again` row (F1), so Cancel moved 3 → 2:
//   `Enable full access?`
//   `› 1. Yes, continue anyway  Apply full access for this session`
//   `  2. Cancel                Go back without enabling full access`
//   `Press enter to confirm or esc to go back`   cursor `›` U+203A
//
// CHANNEL — these two read the reconstructed SCREEN (TaskScreenModel grid text),
// never the linear pty tail (D-1). Codex 0.146 repaints the consent as a CELL
// DIFF over the `/permissions` picker that occupied the same rows: a cell already
// holding the right character is never retransmitted, so the STREAM reads
// `Enablfullaccess?` (the `e` of "Enable" lived in the picker's frame) and
// `1Yes,continueanyway` (no `›`, no `.`). Which characters are elided depends on
// the prior frame + terminal width, so no regex widening can fix it — the grid
// converges to the CURRENT screen and is the only honest substrate for this
// SPATIAL query. Both parsers stay pure and compaction-based: `cleanTerminal` is
// a near-noop on plain grid rows, and the whitespace-strip still buys tolerance
// of the column padding the dialog lays its descriptions out with.
const CODEX_FULL_ACCESS_CONSENT_RE = /Enablefullaccess\?/;
// Consent cursor rows: `›` + digit + `.` + the row LABEL. The LABEL anchor is the
// red line — never a bare row number: it is what tells this cursor apart from any
// other `›\d.` row (the /permissions picker's `Askforapproval`/…, the composer
// placeholder), so a screen the choreography does not actually recognize reads as
// null (→ wait → timeout → needs-attention) instead of navigating blind.
// Most-recent-wins (greatest index).
const CODEX_CONSENT_CURSOR_RES: ReadonlyArray<readonly [RegExp, 1 | 2]> = [
  [/›\d\.Yes,continueanyway/, 1],
  [/›\d\.Cancel/, 2],
];
/** Label → mode, ordered as the picker renders (ask → approve → full). The
 *  order is a stable picker property used ONLY to pick an arrow direction; the
 *  cursor's actual row is always re-read by TEXT after each press. */
const CODEX_PICKER_ROWS: ReadonlyArray<readonly [RegExp, CodexPermissionMode]> = [
  [/Askforapproval/, "ask-for-approval"],
  [/Approveforme/, "approve-for-me"],
  [/FullAccess/, "full-access"],
];
export const CODEX_ROW_ORDER: Record<CodexPermissionMode, number> = {
  "ask-for-approval": 0,
  "approve-for-me": 1,
  "full-access": 2,
};
export const CODEX_ROW_BY_ORDER: readonly CodexPermissionMode[] = [
  "ask-for-approval",
  "approve-for-me",
  "full-access",
];
/** Cursor-row patterns: the `›` glyph + a digit + `.` + the row label. The
 *  digit/dot are the anchor that rejects the composer placeholder (`›Write…`);
 *  the LABEL identifies the mode. */
const CODEX_PICKER_CURSOR_RES: ReadonlyArray<readonly [RegExp, CodexPermissionMode]> = [
  [/›\d+\.Askforapproval/, "ask-for-approval"],
  [/›\d+\.Approveforme/, "approve-for-me"],
  [/›\d+\.FullAccess/, "full-access"],
];
/** Confirm-receipt patterns, anchored on the `•` codex event-line bullet so
 *  prose can't forge them (the S2 glyph-anchor discipline). */
const CODEX_PICKER_RECEIPT_RES: ReadonlyArray<readonly [RegExp, CodexPermissionMode]> = [
  [/•PermissionsupdatedtoAskforapproval/, "ask-for-approval"],
  [/•PermissionsupdatedtoApproveforme/, "approve-for-me"],
  [/•PermissionsupdatedtoFullAccess/, "full-access"],
];

const CODEX_PERMISSION_MODE_SET: ReadonlySet<CodexPermissionMode> = new Set<CodexPermissionMode>([
  "ask-for-approval",
  "approve-for-me",
  "full-access",
]);

/** Narrow an untrusted string (the IPC `value`/`from`) to a CodexPermissionMode. */
export function asCodexPermissionMode(value: string | undefined): CodexPermissionMode | null {
  return value && CODEX_PERMISSION_MODE_SET.has(value as CodexPermissionMode)
    ? (value as CodexPermissionMode)
    : null;
}

/** The compacted (escapes + ALL whitespace removed) view the codex picker parsers
 *  key on — same transform as the claude receipt/mode-line parsers and the Remote
 *  Control detector, so a chunk split inside an escape reassembles first. */
function codexPickerCompact(rawScan: string): string {
  return cleanTerminal(rawScan).replace(/\s+/g, "");
}

/** The `/permissions` picker is on screen (its header rendered). */
export function codexPermissionPickerOpen(rawScan: string): boolean {
  return CODEX_PICKER_HEADER_RE.test(codexPickerCompact(rawScan));
}

/** The picker's confirm/cancel footer is on screen — used only to VERIFY an Esc
 *  actually closed the picker (RED LINE 3), never to drive navigation. */
export function codexPermissionPickerFooterVisible(rawScan: string): boolean {
  return CODEX_PICKER_FOOTER_RE.test(codexPickerCompact(rawScan));
}

/** The Full Access consent dialog is on screen (a RED LINE 2 interstitial — see
 *  CODEX_FULL_ACCESS_CONSENT_RE). S7 PARKS on it and relays its rows through the
 *  Action Drawer rather than auto-answering or Escing it away.
 *
 *  `screenText` MUST be the reconstructed grid (TaskScreenModel.viewportText()),
 *  not the pty tail — on the linear stream this predicate is structurally false
 *  while the dialog is on screen (the cell-diff repaint; see the constant's
 *  comment). Because the grid holds only the CURRENT screen, its ABSENCE is
 *  equally trustworthy: it is how the relay sees the user answer natively. */
export function codexPermissionConsentDialogOpen(screenText: string): boolean {
  return CODEX_FULL_ACCESS_CONSENT_RE.test(codexPickerCompact(screenText));
}

/** Which consent row the `›` cursor currently highlights (1 = Yes, continue
 *  anyway; 2 = Cancel), or null if none is recognized yet. Label-anchored, so an
 *  unrecognized screen is null rather than a guess. Most-recent-wins.
 *  Grid-fed, exactly like `codexPermissionConsentDialogOpen`. */
export function parseCodexConsentCursor(screenText: string): 1 | 2 | null {
  const compact = codexPickerCompact(screenText);
  let best: 1 | 2 | null = null;
  let bestIndex = -1;
  for (const [re, row] of CODEX_CONSENT_CURSOR_RES) {
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

/** The mode whose row currently holds the `›` cursor, or null if no cursor row is
 *  recognized yet. "Most recent wins" (greatest match index) so a stale repaint
 *  of the pre-move cursor can't outvote the row the latest frame highlights —
 *  exactly like parseClaudePermissionModeLine. */
export function parseCodexPermissionPickerCursor(rawScan: string): CodexPermissionMode | null {
  const compact = codexPickerCompact(rawScan);
  let best: CodexPermissionMode | null = null;
  let bestIndex = -1;
  for (const [re, mode] of CODEX_PICKER_CURSOR_RES) {
    const globalRe = new RegExp(re.source, "g");
    let match: RegExpExecArray | null;
    let lastIndex = -1;
    while ((match = globalRe.exec(compact)) !== null) {
      lastIndex = match.index;
      globalRe.lastIndex = match.index + 1;
    }
    if (lastIndex > bestIndex) {
      bestIndex = lastIndex;
      best = mode;
    }
  }
  return best;
}

/** The mode a `• Permissions updated to <label>` receipt confirms, or null if no
 *  receipt is on the scan yet (keep waiting until the confirm timeout). */
export function parseCodexPermissionReceipt(rawScan: string): CodexPermissionMode | null {
  const compact = codexPickerCompact(rawScan);
  for (const [re, mode] of CODEX_PICKER_RECEIPT_RES) {
    if (re.test(compact)) {
      return mode;
    }
  }
  return null;
}

// ── Codex `/model` two-level picker choreography (S4) ───────────────────────
//
// Bare `/model` opens a TWO-level picker (measured, codex 0.144.5 —
// spikes/midsession-switch-probe/codex-run2.snaps.log, folded through the app's
// cleanTerminal + whitespace-strip). Every string below is verbatim from that
// capture; the compacted (whitespace-removed) forms are what the parsers key on:
//
//   Level 1 header:  `Select Model and Effort`      → `SelectModelandEffort`
//   Level 1 rows:    `› 1. gpt-5.6-sol (current)  Latest frontier…`
//                    `2. gpt-5.6-terra  Balanced…`  … (DYNAMIC set + order —
//                    the picker shows the account's non-legacy models, which may
//                    differ from Sonata's curated list; legacy models like
//                    gpt-5.4 are NOT offered here, only via `codex -m`. D5: a
//                    target model absent from the visible rows → Esc-rollback +
//                    needs-attention, turning upstream/legacy drift into signal.)
//   Level 2 header:  `Select Reasoning Level for gpt-5.6-sol`
//   Level 2 rows:    `1. Low (default)  Fast…`  `2. Medium…`
//                    `› 3. High (current)  Greater…`  `4. Extra high…`
//                    `5. More reasoning…  Max and Ultra…`  (v1 targets low→xhigh;
//                    `More reasoning…` — Max/Ultra — is NEVER entered, D6.)
//   Shared footer:   `Press enter to confirm or esc to go back`
//   Confirm receipt: `• Model changed to gpt-5.6-sol xhigh`  (`•` U+2022 anchor,
//                    the model slug then the reasoning token, both glued after
//                    whitespace-strip). A Max/Ultra confirm adds a suffix —
//                    `• Model changed to gpt-5.6-sol ultra for this conversation`
//                    (measured, codex 0.146.0) — which the unanchored tail ignores.
//
// The `›` (U+203A) cursor marks the highlighted row and ALSO leads the composer
// placeholder + the slash-menu, so a cursor anchor needs `›` + DIGIT + `.` to
// tell a picker row apart from prose (same discipline as S3). Model rows anchor
// on the `gpt-` slug prefix (never a description word); reasoning rows on the
// fixed label set. `(current)` — NOT `(default)` — marks the dimension to
// PRESERVE when the other dimension is the one being switched.
const CODEX_MODEL_L1_HEADER_RE = /SelectModelandEffort/;
const CODEX_MODEL_L2_HEADER_RE = /SelectReasoningLevelfor/;
// Shared with the /permissions picker; kept as its own constant for clarity.
const CODEX_MODEL_FOOTER_RE = /Pressentertoconfirmoresctogoback/;
// One model row: optional cursor, digit, `.`, and the `gpt-…` slug. The slug
// charclass excludes `(` and capitals, so it stops before `(current)` / the
// capitalized description; the `gpt-` prefix rejects description prose.
const CODEX_MODEL_L1_ROW_RE = /(›?)(\d)\.(gpt-[a-z0-9.-]+)(\(current\))?/g;
// One reasoning row: optional cursor, digit, `.`, the label, optional `(current)`.
// Labels have distinct leading letters (L/M/H/E/M), so alternation order is safe;
// `Morereasoning` and `Extrahigh` never collide with `Medium`/`High`.
const CODEX_MODEL_L2_ROW_RE =
  /(›?)(\d)\.(Low|Medium|High|Extrahigh|Morereasoning)(\(current\)|\(default\))?/g;
// Confirm receipt: `• Model changed to <model> <effort>`. UNLIKE the picker rows
// (word-positioned TUI redraws that must be whitespace-stripped), this codex event
// line is printed with real spaces (measured — codex-run2 line 25), so the parser
// keeps single-space separators: the SPACE between model and effort is the reliable
// token boundary. `gpt-\S+` stops at that space (bounding the model correctly even
// when a composer-footer repaint glues a SECOND `<model> <effort>` right after —
// the first match wins), and the leading space disambiguates `high` from `xhigh`
// without a trailing anchor (an end-boundary guard would instead REJECT a valid
// receipt whenever the next redraw glues text onto the effort with no space).
//
// The alternation spans ALL SIX efforts, not just the four v1 TARGETS. The receipt
// REPORTS what codex applied; it is not the place that fences what Sonata may
// target (that fence is `asCodexReasoningTarget`, applied when the choreography
// picks a picker row — D6 still never enters `More reasoning…`). MEASURED on codex
// 0.146.0: a Max/Ultra confirm prints `• Model changed to gpt-5.6-sol ultra for
// this conversation`, which the four-token alternation read as NULL while a control
// `• Model changed to gpt-5.6-sol medium` parsed fine — so the break was Ultra/Max
// only, not format-wide. On a null the change HAS applied CLI-side while the confirm
// phase keeps waiting: it times out and rolls back from pickerLevel 2 (up to two
// Escs into a composer whose picker is already closed), and reports a verdict that
// misdescribes what happened. Parsing the receipt reaches the SAME needs-attention
// verdict immediately, on the TRUE landed pair, with no stray Escs. It does NOT
// refresh the mirror: a landed≠target receipt finishes as needs-attention, which
// carries no (model, effort) and so triggers no mirror write — that staleness still
// waits on the turn_context reconcile either way.
// This matters even though today's choreography only ever confirms a v1 row: the
// picker's rows and shape are server-mutable without a CLI release (W5), so what a
// confirm can land on is not ours to bound.
// Alternation order: `xhigh` stays ahead of `high` per the file's longest-first
// convention; `max`/`ultra` are prefix-free against every other token, so appending
// them cannot shadow or be shadowed.
const CODEX_MODEL_RECEIPT_RE = /•\s*Model changed to (gpt-\S+) (xhigh|high|medium|low|max|ultra)/;

/** The five reasoning rows the level-2 picker can show. `more` is the
 *  `More reasoning…` submenu row (Max/Ultra) — recognized ONLY so the
 *  choreography can refuse to enter it (D6, out of scope v1). */
export type CodexReasoningRow = "low" | "medium" | "high" | "xhigh" | "more";
const CODEX_REASONING_ROW_LABELS: ReadonlyArray<readonly [string, CodexReasoningRow]> = [
  ["Low", "low"],
  ["Medium", "medium"],
  ["High", "high"],
  ["Extrahigh", "xhigh"],
  ["Morereasoning", "more"],
];
/** The four switchable reasoning ids ↔ the codex config.toml / receipt token
 *  (D6 v1 set). `more` is excluded — it is never a target. */
const CODEX_REASONING_TARGET_SET: ReadonlySet<ReasoningEffort> = new Set<ReasoningEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
]);
export function asCodexReasoningTarget(value: string | undefined): ReasoningEffort | null {
  return value && CODEX_REASONING_TARGET_SET.has(value as ReasoningEffort)
    ? (value as ReasoningEffort)
    : null;
}
/** A CodexReasoningRow that is also a switchable target (drops `more`). */
export function reasoningRowToEffort(row: CodexReasoningRow): ReasoningEffort | null {
  return row === "more" ? null : row;
}

/** One parsed level of the `/model` picker: which row holds the `›` cursor,
 *  which carries `(current)`, and the row order keyed by the picker's own digit
 *  (dynamic for models). Row identities are the model slug (level 1) or the
 *  CodexReasoningRow id (level 2). */
export interface CodexPickerLevel<T extends string> {
  cursor: T | null;
  current: T | null;
  /** Row identity → the picker's 1-based digit (nav direction + neighbor). */
  order: Map<T, number>;
  /** The picker's digit → row identity (the neighbor lookup for a nav press). */
  byDigit: Map<number, T>;
}

function parseCodexPickerRows<T extends string>(
  slice: string,
  rowRe: RegExp,
  identify: (label: string) => T | null,
): CodexPickerLevel<T> {
  const order = new Map<T, number>();
  const byDigit = new Map<number, T>();
  let cursor: T | null = null;
  let current: T | null = null;
  let cursorIndex = -1;
  const re = new RegExp(rowRe.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(slice)) !== null) {
    const isCursor = match[1] === "›";
    const digit = Number(match[2]);
    const id = identify(match[3] ?? "");
    if (!id || Number.isNaN(digit)) {
      continue;
    }
    // Last occurrence per digit wins (freshest repaint inside the slice).
    order.set(id, digit);
    byDigit.set(digit, id);
    if ((match[4] ?? "") === "(current)") {
      current = id;
    }
    if (isCursor && match.index > cursorIndex) {
      cursorIndex = match.index;
      cursor = id;
    }
  }
  return { cursor, current, order, byDigit };
}

/** The `/model` level-1 (model) picker is on screen. */
export function codexModelPickerLevel1Open(rawScan: string): boolean {
  return CODEX_MODEL_L1_HEADER_RE.test(codexPickerCompact(rawScan));
}

/** The `/model` level-2 (reasoning) picker is on screen — optionally verifying
 *  its header names `model` (S4: the level-2 header must name the model chosen at
 *  level 1, or the screen is unexpected → rollback). */
export function codexModelPickerLevel2Open(rawScan: string, model?: string): boolean {
  const compact = codexPickerCompact(rawScan);
  if (model) {
    return compact.includes(`SelectReasoningLevelfor${model.replace(/\s+/g, "")}`);
  }
  return CODEX_MODEL_L2_HEADER_RE.test(compact);
}

/** The picker's confirm/cancel footer is on screen (RED LINE 3 rollback
 *  verification — a picker is still open until it's gone). */
export function codexModelPickerFooterVisible(rawScan: string): boolean {
  return CODEX_MODEL_FOOTER_RE.test(codexPickerCompact(rawScan));
}

/** Parse the level-1 (model) rows. Keyed on the whole compacted tail (NOT a
 *  header-sliced frame): codex repaints only the changed rows after an arrow, so a
 *  post-move frame often omits the level header — and the two levels' row regexes
 *  are disjoint by anchor (`gpt-` slug vs the reasoning labels), so a whole-scan
 *  parse never bleeds level 2 into level 1. Most-recent-wins (last cursor/digit
 *  occurrence) keeps a stale repaint from outvoting the latest frame. */
export function parseCodexModelLevel1(rawScan: string): CodexPickerLevel<string> {
  const compact = codexPickerCompact(rawScan);
  return parseCodexPickerRows<string>(compact, CODEX_MODEL_L1_ROW_RE, (slug) => slug || null);
}

/** Parse the level-2 (reasoning) rows (whole-scan, same rationale as level 1). */
export function parseCodexModelLevel2(rawScan: string): CodexPickerLevel<CodexReasoningRow> {
  const compact = codexPickerCompact(rawScan);
  return parseCodexPickerRows<CodexReasoningRow>(compact, CODEX_MODEL_L2_ROW_RE, (label) => {
    for (const [text, id] of CODEX_REASONING_ROW_LABELS) {
      if (label === text) {
        return id;
      }
    }
    return null;
  });
}

/** The (model, effort) a `• Model changed to <model> <effort>` receipt confirms,
 *  or null if no receipt is on the scan yet (keep waiting until the timeout). The
 *  effort token is validated against the full `ReasoningEffort` union — every tier
 *  codex can REPORT, including Max/Ultra, which Sonata never targets but a confirm
 *  can still land on (see CODEX_MODEL_RECEIPT_RE); an unrecognized token → null. */
export function parseCodexModelReceipt(
  rawScan: string,
): { model: string; effort: ReasoningEffort } | null {
  // Single-space normalization (NOT the whitespace-strip the picker parsers use —
  // see CODEX_MODEL_RECEIPT_RE): keeps the model↔effort space as the token
  // boundary. cleanTerminal drops ANSI/control; collapse runs of whitespace to one
  // space so a wrapped/positioned line still reads as one.
  const normalized = cleanTerminal(rawScan).replace(/\s+/g, " ");
  const match = CODEX_MODEL_RECEIPT_RE.exec(normalized);
  if (!match) {
    return null;
  }
  // The alternation above already admits exactly the six union members, so this
  // guard never rejects in practice — it CARRIES the ReasoningEffort type from the
  // shared union (the same "is this one of the six tiers" check the settings
  // normalize layer uses), so widening the regex to a non-tier token would fail
  // here rather than smuggle a string into the mirror.
  const effort = match[2];
  if (!match[1] || !isReasoningEffort(effort)) {
    return null;
  }
  return { model: match[1], effort };
}

/** One arrow press toward `target` from `cursor`, using the picker's own CAPTURED
 *  digit order (dynamic for models) for direction and the immediate neighbor as
 *  the expected post-press cursor (validate-each-press). Returns null if the
 *  cursor/target/neighbor digit is missing from the captured order — the caller
 *  rolls back. Generic over the level's row identity. */
export function codexPickerNavStep<T extends string>(
  order: Map<T, number>,
  byDigit: Map<number, T>,
  cursor: T,
  target: T,
): { down: boolean; expected: T } | null {
  const cursorDigit = order.get(cursor);
  const targetDigit = order.get(target);
  if (cursorDigit === undefined || targetDigit === undefined || cursorDigit === targetDigit) {
    return null;
  }
  const down = targetDigit > cursorDigit;
  const expected = byDigit.get(cursorDigit + (down ? 1 : -1));
  if (expected === undefined) {
    return null;
  }
  return { down, expected };
}

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
// carries (`tui-parsers-claude.ts:210-220`). The pre-trust of S1 is a decision
// taken BEFORE the CLI starts, from a gesture the user actually made; answering
// a screen already on the user's display is a different act, and it stays
// forbidden.
//
// CHANNEL — the GRID, never the pty tail (D-1: a state query belongs on the
// reconstructed screen). "Is the trust dialog on screen right now?" is a state
// query in both directions: the watchdog asks it to RAISE the banner, and the
// clearing pass asks it to RETIRE the banner once the human answers. The tail
// cannot answer the second half at all — the answered dialog's bytes sit in it
// forever (the same reason `claudeRewindPanelOpen` and the Full Access consent
// pair moved off the stream), which is precisely why the update banner it is
// modelled on can only clear on `pty:exit`. On the grid the answered dialog
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
// The `\d\.` prefix is this file's own cursor-anchor discipline (see
// CODEX_PICKER_CURSOR_RES) minus the `›` glyph: the cursor marks only the
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
// PREFIX OVERLAP, adjudicated: the Full Access consent dialog's row is
// `› 1. Yes, continue anyway`, which contains `1.Yes,continue`. It cannot
// collide — that dialog carries neither the trust question nor a `No, quit` row,
// and the co-occurrence requires all three. Narrowing the row regex with a
// negative lookahead would buy nothing and would couple this signature to the
// OTHER dialog's wording.
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
  // Same compaction as every other parser here: `cleanTerminal` is a near-noop
  // on plain grid rows but is kept so a caller handing over a still-escaped
  // frame cannot silently miss, and the whitespace-strip makes the match
  // indifferent to the dialog's column padding and to where the viewport wraps
  // its rows — which is what lets ONE needle set read both the widget's laid-out
  // grid and the collapsed cell-diff form the boot repaint produces.
  const compact = codexPickerCompact(screenText);
  return (
    CODEX_TRUST_QUESTION_RE.test(compact) &&
    CODEX_TRUST_YES_ROW_RE.test(compact) &&
    CODEX_TRUST_QUIT_ROW_RE.test(compact)
  );
}
