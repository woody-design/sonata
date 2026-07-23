import type { ClaudePermissionMode } from "../../shared/types/domain";
import { cleanTerminal } from "./tui-parsers-common";

// ── Pure Claude TUI-stream parsers (consolidation S4) ────────────────────────
// Moved verbatim from terminal-host.ts: Remote Control stream detection, the
// mid-session model/effort receipt + cache-miss confirm dialog, and the
// Shift+Tab permission mode-line reader. All pure (take an accumulated RAW tail,
// return a verdict); unit-pinned by tests/smoke/remote-control-detect-units.mjs
// and tests/smoke/midsession-receipt.mjs. Provenance comments are preserved
// intact — every anchor here is probe-measured, not assumed.

// Remote Control stream detection (pure; unit-tested in
// tests/smoke/remote-control-detect-units.mjs). See detectRemoteControlState.
export const REMOTE_CONTROL_SCAN_LIMIT = 2048;
const REMOTE_CONTROL_URL_RE = /https:\/\/claude\.(?:ai|com)\/code\/session_[A-Za-z0-9_-]+/;

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
 *  excludes the panel option "Disconnect this session" and the slash menu. */
export function hasRemoteControlDisconnect(compact: string): boolean {
  return compact.includes("RemoteControldisconnected");
}

/** The session link (for display), or null. Takes the RAW scan and strips ONLY
 *  escapes (whitespace preserved) so the id stops at the space/glyph after it —
 *  fully compacting would glue a trailing word onto the session id. The id char
 *  class includes `-`/`_` so a hyphenated/base64url id is never truncated. */
export function findRemoteControlUrl(raw: string): string | null {
  return raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").match(REMOTE_CONTROL_URL_RE)?.[0] ?? null;
}
// Mid-session Claude model/effort switch receipt detection (pure; unit-tested
// in tests/smoke/midsession-receipt.mjs). Sonata injects `/model <id>` /
// `/effort <level>` as typed text and watches the pty stream for the CLI's own
// receipt line (probe-verified verbatim, claude 2.1.214 — spikes/midsession-
// switch-probe/findings.md):
//   model  success → `⎿ Set model to Sonnet 5 and saved as your default …`
//   effort success → `⎿ Set effort level to low (saved as your default …)`
//   model  failure → `⎿ Model 'bogus-model-xyz' not found`
// The receipt is WORD-POSITIONED — claude lays it out with cursor moves
// (`\x1b[NG`), not spaces — so stripping ANSI glues the words
// ("Set model to" → "Setmodelto"). We therefore match the COMPACTED form
// (escapes + ALL whitespace removed) on the accumulated RAW tail, exactly like
// the Remote Control detector, so a split landing inside an escape reassembles
// first. Screen text is a choreography RECEIPT only — the statusline mirror
// stays the model SSOT.
export const CONTROL_SWITCH_SCAN_LIMIT = 4096;
const CONTROL_SWITCH_MODEL_OK_RE = /Setmodelto/;
const CONTROL_SWITCH_EFFORT_OK_RE = /Seteffortlevelto/;
const CONTROL_SWITCH_MODEL_FAIL_RE = /Model'[^']*'notfound/;

export function parseClaudeControlReceipt(
  rawScan: string,
  kind: "model" | "effort",
): "settled" | "failed" | null {
  const compact = cleanTerminal(rawScan).replace(/\s+/g, "");
  if (kind === "effort") {
    // No failure receipt is probed for `/effort` (its levels come from a curated
    // list, so a "not found" is unreachable); an unrecognized outcome times out
    // to needs-attention rather than being guessed as a failure here.
    return CONTROL_SWITCH_EFFORT_OK_RE.test(compact) ? "settled" : null;
  }
  // Failure first: a `Model '<x>' not found` line never contains `Set model to`,
  // so checking failure ahead of success is the safe ordering.
  if (CONTROL_SWITCH_MODEL_FAIL_RE.test(compact)) {
    return "failed";
  }
  return CONTROL_SWITCH_MODEL_OK_RE.test(compact) ? "settled" : null;
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

/** The claude cache-miss confirm dialog is on screen (a recognized RED-LINE
 *  interstitial S7 PARKS on and relays through the drawer). Requires BOTH the
 *  distinctive body phrase and the `2. No, go back` row so prose can't forge it. */
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

/** The cache-miss dialog closed with a `Kept <model|effort> as …` line — a clean
 *  cancel (No/Esc), nothing changed CLI-side. Axis-scoped. */
export function claudeCacheMissCancelled(rawScan: string, kind: "model" | "effort"): boolean {
  const compact = cleanTerminal(rawScan).replace(/\s+/g, "");
  return (
    kind === "model" ? CLAUDE_CACHE_MISS_CANCEL_MODEL_RE : CLAUDE_CACHE_MISS_CANCEL_EFFORT_RE
  ).test(compact);
}

// Mid-session Claude PERMISSION switch (S2). Unlike model/effort (a typed
// command with one printed receipt), permission has no arg form: Sonata drives
// the native Shift+Tab (`\x1b[Z`) cycle one step at a time and reads the TUI's
// mode line as the per-step *choreography receipt* to learn which mode it just
// landed in. Probe-verified cycle + strings (claude 2.1.214, this account —
// spikes/midsession-switch-probe/findings.md §S0):
//   default (Manual) ↔ `⏸ manual mode on`    acceptEdits ↔ `⏵⏵ accept edits on`
//   plan             ↔ `⏸ plan mode on`      auto        ↔ `⏵⏵ auto mode on`
//   cycle: manual → accept edits → plan → auto → manual (auto is account-gated).
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
const PERMISSION_MODE_LINE_RES: ReadonlyArray<readonly [RegExp, ClaudePermissionMode]> = [
  [new RegExp(`${MODE_LINE_GLYPH}accepteditson`), "acceptEdits"],
  [new RegExp(`${MODE_LINE_GLYPH}manualmodeon`), "default"],
  [new RegExp(`${MODE_LINE_GLYPH}planmodeon`), "plan"],
  [new RegExp(`${MODE_LINE_GLYPH}automodeon`), "auto"],
];

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
 *  spikes/midsession-switch-probe §S0 and re-observed 2026-07-23 in the
 *  midsession-permission-switch e2e's `observedModes`):
 *  manual (default) → accept edits → plan → auto → manual. `auto` is
 *  account-gated. */
export const CLAUDE_PERMISSION_CYCLE: readonly ClaudePermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
];

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
 * An OFF-cycle origin (`bypassPermissions` / `dontAsk`, set outside the Shift+Tab
 * cycle) has no predictable successor, so any cycle member is accepted — the
 * stale-repaint filter (landing === `from`) still rejects a redraw of `from`
 * itself. This preserves the blind-seek the engine used before landing
 * validation for that rare off-cycle case.
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
