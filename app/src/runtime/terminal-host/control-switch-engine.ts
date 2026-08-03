import type {
  ClaudePermissionMode,
  CodexPermissionMode,
  ReasoningEffort,
  RuntimeProvider,
  TaskId,
} from "../../shared/types/domain";
import type { ControlSwitchAttentionReason, RuntimeEvent } from "../../shared/types/events";
import type {
  ClaudeControlSwitchKind,
  ClaudeControlSwitchResponse,
} from "../../shared/types/ipc";
import { ARROW_DOWN, ARROW_UP, ESC, SHIFT_TAB } from "./tui-parsers-common";
import {
  asClaudePermissionMode,
  claudeCacheMissCancelled,
  claudeCacheMissDialogOpen,
  CONTROL_SWITCH_SCAN_LIMIT,
  expectedPermissionLandings,
  parseClaudeCacheMissCursor,
  parseClaudeControlReceipt,
  parseClaudePermissionModeLine,
} from "./tui-parsers-claude";
import {
  asCodexPermissionMode,
  asCodexReasoningTarget,
  CODEX_ROW_BY_ORDER,
  CODEX_ROW_ORDER,
  codexModelPickerFooterVisible,
  codexModelPickerLevel1Open,
  codexModelPickerLevel2Open,
  codexPermissionConsentDialogOpen,
  codexPermissionPickerFooterVisible,
  codexPermissionPickerOpen,
  codexPickerNavStep,
  parseCodexConsentCursor,
  parseCodexModelLevel1,
  parseCodexModelLevel2,
  parseCodexModelReceipt,
  parseCodexPermissionPickerCursor,
  parseCodexPermissionReceipt,
  reasoningRowToEffort,
  type CodexPickerLevel,
  type CodexReasoningRow,
} from "./tui-parsers-codex";

/** How long to wait for a `/model` / `/effort` receipt line before declaring
 *  the screen an unrecognized state and surfacing needs-attention (RED LINE:
 *  no auto-answer, no retry). ~5s covers the CLI's echo→apply→print latency
 *  with headroom (probe receipts landed well inside 2.5s). */
const CONTROL_SWITCH_RECEIPT_TIMEOUT_MS = 5000;
/** Per-STEP receipt window for the permission Shift+Tab stepping engine (S2).
 *  The mode line is "instant" (probe: it repaints on the same frame as the
 *  keypress), so 1.5s is generous; a step that earns no recognized mode line in
 *  this window is treated as an unrecognized outcome and flips the engine to
 *  return-home (RED LINE: it never blind-presses anything but `\x1b[Z`). */
const PERMISSION_STEP_RECEIPT_TIMEOUT_MS = 1500;
/** Seeking bound: 2× the largest possible cycle (the 6 ClaudePermissionModes).
 *  A reachable target is found within one cycle (≤6 steps); the 2× margin
 *  absorbs a single dropped/duplicated receipt. Exhausting it → return-home. */
const PERMISSION_MAX_SEEK_STEPS = 12;
/** Return-home bound: once seeking is abandoned, keep stepping until the ORIGIN
 *  mode line is seen again, but cap it so a session whose receipts have gone
 *  fully opaque can't loop forever — at the cap we emit needs-attention at the
 *  last-known landing and let the hook-payload SSOT reconcile the display. */
const PERMISSION_MAX_RETURN_STEPS = 12;
/** Codex `/permissions` picker choreography windows (S3). Opening waits for the
 *  picker header after `/permissions`+Enter — generous, since a cold codex may
 *  take a beat to render the picker. Nav/confirm are per-STEP: the picker
 *  repaints on the same frame as the arrow/Enter (measured), so ~2s is ample;
 *  a step that earns no recognized frame in its window flips to the Esc-rollback
 *  path (RED LINE 3 — never a blind retry). */
const CODEX_PICKER_OPEN_TIMEOUT_MS = 6000;
const CODEX_PICKER_NAV_TIMEOUT_MS = 2500;
const CODEX_PICKER_CONFIRM_TIMEOUT_MS = 4000;
/** After the rollback Esc, how long to let the composer repaint before checking
 *  the picker footer is gone (RED LINE 3 verification) and emitting
 *  needs-attention. Bounded — the check is diagnostic, never a retry. */
const CODEX_PICKER_CLOSE_VERIFY_MS = 900;
/** Navigation bound: the picker has 3 rows, so any reachable row is ≤2 arrow
 *  presses away; 6 (2× the row count) absorbs a dropped/duplicated repaint.
 *  Exhausting it → Esc-rollback + needs-attention (never keep pressing blind). */
const CODEX_PICKER_MAX_NAV_STEPS = 6;
/** Codex `/model` two-level picker choreography windows (S4). Each level opens
 *  after the prior confirm; `open` waits for the level header + a recognized
 *  cursor, `nav` for a validated post-arrow repaint, `confirm` for the receipt.
 *  Same "repaints on the same frame as the keypress" reality as the permission
 *  picker (measured), so the per-step windows are generous; a window that earns
 *  no recognized frame flips to the Esc-rollback path (RED LINE — never a blind
 *  retry). */
const CODEX_MODEL_OPEN_TIMEOUT_MS = 6000;
const CODEX_MODEL_LEVEL2_OPEN_TIMEOUT_MS = 4000;
const CODEX_MODEL_NAV_TIMEOUT_MS = 2500;
const CODEX_MODEL_CONFIRM_TIMEOUT_MS = 4000;
/** After each rollback Esc, how long to let the screen repaint before deciding
 *  whether another Esc is needed (a level-2 Esc returns to level 1 — measured;
 *  the footer's continued presence is the "still in a picker" signal) or the
 *  choreography can conclude needs-attention. */
const CODEX_MODEL_CLOSE_VERIFY_MS = 700;
/** Per-level navigation bound: the model list is short (≤8 rows) and reasoning is
 *  5 rows, so any reachable row is a handful of presses away; 8 (well past 2× the
 *  reasoning rows, generous for the model list) absorbs a dropped/duplicated
 *  repaint. Exhausting it → Esc-rollback + needs-attention (never press blind). */
const CODEX_MODEL_MAX_NAV_STEPS = 8;
/** Parked-confirm relay windows (S7). While PARKED (waiting-user) there is NO
 *  timeout — the drawer is the resolution surface and send is gated, so the
 *  user takes as long as they like (a dismiss injects the Cancel row). Once the
 *  user answers, the nav/confirm/cancel windows mirror the codex picker: the
 *  dialog repaints on the same frame as the arrow/Enter, so ~2.5s per nav step
 *  and ~4s for the settle receipt are generous; a window that earns no
 *  recognized frame Escs the dialog and surfaces needs-attention (never a blind
 *  retry). The cancel-exit verify is the short "did the picker footer clear"
 *  window after the codex-Cancel Esc. */
const PARKED_CONFIRM_NAV_TIMEOUT_MS = 2500;
const PARKED_CONFIRM_SETTLE_TIMEOUT_MS = 4000;
const PARKED_CONFIRM_CANCEL_VERIFY_MS = 900;
/** Navigation bound: the parked dialogs have 2 rows, so any row is one press
 *  away; 6 absorbs a dropped/duplicated repaint. Exhausting it → Esc + attention. */
const PARKED_CONFIRM_MAX_NAV_STEPS = 6;
/** Esc bound across a parked relay's lifetime — spent by the failure rollback and
 *  by the native-Cancel picker close. One Esc closes any ONE of these screens
 *  (codex 0.146.0: the consent replaces the picker rather than stacking over it),
 *  so the cap is the safety net for a screen whose modal never clears. */
const PARKED_CONFIRM_MAX_ROLLBACK_ESCS = 3;
/** How many rows each whitelisted dialog renders (MEASURED). The relay refuses a
 *  row outside its dialog's range — the renderer only offers valid rows, so this
 *  is the backstop, not the gate. codex-consent lost its `Yes, and don't ask
 *  again` row at 0.146.0 (F1), which is what moved Cancel from row 3 to row 2. */
const PARKED_DIALOG_ROW_COUNT: Record<"claude-cachemiss" | "codex-consent", number> = {
  "claude-cachemiss": 2,
  "codex-consent": 2,
};
/** The codex consent's Cancel row (`2. Cancel  Go back without enabling full
 *  access`, measured 0.146.0). */
const CODEX_CONSENT_CANCEL_ROW = 2;
/** How long after the Cancel confirm to send the picker-closing Esc. MEASURED
 *  (0.146.0): the two exits from the consent are NOT symmetric — `esc` lands on
 *  the idle composer, but ENTER on the Cancel row goes BACK to the `/permissions`
 *  picker, which then sits there swallowing whatever is typed next. So the relay
 *  spaces one Esc behind the Enter, the same shape (and the same held write-lock)
 *  as the `/permissions` + Enter pair that opens the picker. */
const CODEX_CONSENT_CANCEL_ESC_DELAY_MS = 250;
/** Rollback Esc bound: the picker is at most two levels deep, so two Escs return
 *  to the composer; a third is a safety cap against a screen whose footer never
 *  clears (then we conclude needs-attention regardless). */
const CODEX_MODEL_MAX_ROLLBACK_ESCS = 3;

/** The `control-switch:state` event payload the engine emits back through the
 *  host (the sole runtime event this choreography raises). */
type ControlSwitchStatePayload = Extract<
  RuntimeEvent,
  { type: "control-switch:state" }
>["payload"];

/**
 * The narrow seam the ControlSwitchEngine drives the session through. The engine
 * owns the single in-flight switch (`pendingControlSwitch`) and its receipt scan;
 * everything that touches the shared PTY / AtomicWriter / event sink goes through
 * this interface, so TerminalHost keeps those internals private and the engine
 * stays unit-testable against a fake host.
 */
export interface ControlSwitchHost {
  readonly taskId: TaskId;
  readonly provider: RuntimeProvider;
  /** A live PTY exists (the engine's guard before any write). */
  hasPty(): boolean;
  /** Write raw bytes to the PTY (no-op if it is already gone). */
  writePty(data: string): void;
  /** A native approval screen owns the terminal — refuse to start a switch. */
  isApprovalActive(): boolean;
  /** A run is in flight — refuse to start a switch (idle only). */
  hasActiveRun(): boolean;
  /** An automation write sequence is mid-flight (the AtomicWriter depth > 0). */
  isSonataWriting(): boolean;
  /** Open/close an AtomicWriter sequence so human keystrokes buffer, never split. */
  beginSonataWrite(): void;
  endSonataWrite(): void;
  /** Schedule an automation write under the held write-lock (the deferred Enter). */
  deferSonataWrite(ms: number, fn: () => void, owner?: "prompt" | "control"): void;
  /** Kill-line flood the composer before a typed slash command (RED LINE 1). */
  clearComposerBeforeTypedCommand(): void;
  /**
   * Read the reconstructed SCREEN — the settled viewport of the task's existing
   * `TaskScreenModel` grid (D-1). The engine's SPATIAL queries (is this modal on
   * screen? which row holds its cursor?) belong here, not on the linear pty tail:
   * a TUI repaints a modal as a CELL DIFF over whatever occupied those rows, so
   * characters that happen to be correct already are NEVER transmitted and the
   * stream carries a garbled `Enablfullaccess?` while the dialog is plainly
   * displayed (measured, codex 0.146.0). The grid converges to the current
   * screen, so both PRESENCE and ABSENCE of a modal are trustworthy there.
   * TEMPORAL queries — receipts, rejections, `Kept … as` lines: events that
   * happened, not state that is — stay on the stream, which retains them after
   * the screen has repainted past.
   *
   * Callback-shaped because the grid is only complete once the emulator's
   * pending writes have drained (`whenSettled`): it runs SYNCHRONOUSLY in the
   * quiescent case (a dialog awaiting input produces no output, so nothing is in
   * flight) and otherwise on the last write's parse callback. `fn` may therefore
   * run after the pending switch has moved on — every caller re-reads
   * `pendingControlSwitch` and re-checks its axis/phase. `fn` may also never run
   * at all (no screen model / a disposed one during teardown): that is FAIL-SAFE
   * by construction — a missing read leaves the state machine where it was, and
   * the per-phase timeout (or, while parked, the user) resolves it.
   */
  readScreen(fn: (screen: string) => void): void;
  /** Emit the `control-switch:state` event through the host's event sink. */
  emitControlSwitchEvent(payload: ControlSwitchStatePayload): void;
}

type PendingControlSwitch =
  | {
      axis: "value";
      kind: "model" | "effort";
      value: string;
      /** A queued follow-up command for the staged Save sequence (Part 1, S7): the
       *  second changed axis (`/effort Y` after `/model X`). Run as ONE logical
       *  switch only after THIS command settles (a clean receipt OR a relayed Yes
       *  through the cache-miss drawer); dropped on a failure/cancel so the second
       *  axis never applies when the first didn't. Null for a single-axis switch.
       *  (A failed/needs-attention leg is honest without extra state: the chip
       *  follows each axis's SSOT — a landed model shows even if the effort leg
       *  then fails — and the terminal event names the axis that couldn't confirm.) */
      next: { kind: "effort"; value: string } | null;
      timer: NodeJS.Timeout | null;
    }
  | {
      axis: "permission";
      target: ClaudePermissionMode;
      origin: ClaudePermissionMode;
      phase: "seeking" | "returning";
      landed: ClaudePermissionMode | null;
      /** The mode we were on when we wrote the CURRENT Shift+Tab — the anchor for
       *  validate-each-press (review F3): a landing equal to it is a stale pre-press
       *  repaint (keep waiting), a landing that is not an expected cycle successor is
       *  an unexpected screen (fail loud). Null before the first press. */
      pressedFrom: ClaudePermissionMode | null;
      seekSteps: number;
      returnSteps: number;
      observed: Set<ClaudePermissionMode>;
      timer: NodeJS.Timeout | null;
    }
  | {
      // `codex-permission` (S3) — the `/permissions` picker choreography. Codex
      // has no arg form: we type bare `/permissions`+Enter to OPEN the picker,
      // then navigate its three text-matched rows with arrow keys, confirming
      // with Enter, and read the `• Permissions updated to <label>` receipt.
      //   opening    — typed `/permissions`+Enter; waiting for the picker header.
      //   navigating — picker open; stepping arrows toward the target ROW (by
      //                text), re-reading the cursor after each press.
      //   confirming — pressed Enter on the target row; waiting for the receipt.
      //   closing    — a failure fired the rollback Esc; waiting to verify the
      //                picker closed, then needs-attention.
      // `pickerOpen` gates the cancellation Esc: an abandoned picker swallows the
      // next typed char, so an EXTERNAL clear (run start / PTY teardown) mid-picker
      // must Esc once before releasing (measured — an open picker eats input).
      axis: "codex-permission";
      target: CodexPermissionMode;
      phase: "opening" | "navigating" | "confirming" | "closing";
      pickerOpen: boolean;
      /** The cursor row we last acted from (to recognize a pre-move repaint). */
      lastCursor: CodexPermissionMode | null;
      /** The row the last arrow press is expected to move the cursor to. */
      awaitingCursor: CodexPermissionMode | null;
      navSteps: number;
      /** Set once a KNOWN needs-attention cause is recognized mid-flow, so the
       *  eventual (async, post-rollback) `finishCodexPicker` can name it. `consent`
       *  = the Full Access `Enable full access?` dialog was seen (RED LINE 2 — never
       *  auto-answered). Absent ⇒ a generic timeout/opaque-screen rollback. */
      attentionReason: ControlSwitchAttentionReason | null;
      timer: NodeJS.Timeout | null;
    }
  | {
      // `codex-model` (S4) — the `/model` TWO-level picker choreography. Codex has
      // no arg form (an inline `/model x` burns a turn), so we type bare `/model`+
      // Enter to OPEN the picker, navigate level 1 (models) then level 2
      // (reasoning) by TEXT, and read the `• Model changed to <model> <effort>`
      // receipt. One flow serves both the model chip's model section and its
      // effort section (`switchKind`): the SELECTED dimension navigates to its
      // named row, the OTHER dimension navigates to the level's `(current)`-marked
      // row (preserving it). Phases:
      //   opening       — typed `/model`+Enter; waiting for level-1 header+cursor.
      //   navigating-l1 — stepping arrows toward the level-1 model ROW.
      //   opening-l2    — pressed Enter on the model; waiting for level-2 header
      //                   (which must name `chosenModel`) + cursor.
      //   navigating-l2 — stepping arrows toward the level-2 reasoning ROW (never
      //                   `More reasoning…`).
      //   confirming    — pressed Enter on the reasoning row; waiting for the
      //                   receipt.
      //   closing       — a failure fired the level-appropriate Esc rollback;
      //                   waiting to verify the picker(s) closed, then
      //                   needs-attention.
      axis: "codex-model";
      /** Which chip section drove this: `codex-model` = the model section (level-1
       *  target is `value`, level-2 holds the CURRENT effort); `codex-effort` = the
       *  effort section (level-1 holds the current model via its `(current)` row,
       *  level-2 target is `value`). Also the event kind echoed back for the
       *  pending/needs-attention affordance. */
      switchKind: "codex-model" | "codex-effort";
      /** The switched dimension's selected value (a model slug or a reasoning id) —
       *  the display target and the level's navigation target. */
      value: string;
      /** codex-model ONLY: the effort to PRESERVE at level 2. Measured: after
       *  choosing a DIFFERENT model, codex resets the reasoning to that model's
       *  default and marks NO `(current)` row — so preserving the session's effort
       *  can't ride the `(current)` marker (that only works when the model is
       *  unchanged, i.e. the codex-effort case). We instead navigate level 2 to
       *  this explicit effort (the renderer's `task.reasoningEffort`). Null / a
       *  non-v1 effort (Native Default / Max / Ultra) can't be preserved → the
       *  model switch rolls back to needs-attention (a documented v1 limit).
       *  STALENESS BOUNDARY (accepted, S5-tracked): `task.reasoningEffort` is a
       *  MIRROR with no live codex feed (codex has no statusline/effort event —
       *  the mirror is only written by OUR picker receipts). So after a NATIVE
       *  terminal `/model` change the mirror is stale, and a Sonata model switch
       *  will WRITE that stale effort back onto the live CLI (stronger than S3's
       *  display-only staleness — this pushes it into the running session). The
       *  codex-EFFORT direction is immune: it reads the live level-1 `(current)`
       *  marker, never this mirror. Fix rides S5's `turn_context` reconcile
       *  (widened to task.model/reasoningEffort). */
      preserveEffort: ReasoningEffort | null;
      phase:
        | "opening"
        | "navigating-l1"
        | "opening-l2"
        | "navigating-l2"
        | "confirming"
        | "closing";
      /** How deep the picker is open (0 = closed, 1 = level 1, 2 = level 2) — gates
       *  the level-appropriate rollback Esc(es) and the cancellation Esc. */
      pickerLevel: 0 | 1 | 2;
      /** The model row confirmed at level 1 (the level-2 header must name it, and
       *  the receipt's model is validated against it). */
      chosenModel: string | null;
      /** The reasoning row confirmed at level 2 (the receipt's effort is validated
       *  against it). */
      chosenEffort: ReasoningEffort | null;
      /** The CURRENT level's row order, captured ONCE from its complete opening
       *  frame (footer visible) and used for the whole level's navigation. Codex
       *  repaints only the changed rows after an arrow, so a post-move frame lacks
       *  the far rows — the order is a level-invariant, so capturing it up front
       *  (rather than re-parsing each partial frame) is what makes multi-step nav
       *  work. Cleared when the level changes. */
      order: Map<string, number> | null;
      byDigit: Map<number, string> | null;
      /** The CURRENT level's resolved target row (the selected value, or the
       *  `(current)`-marked row to preserve), resolved once at capture time. */
      target: string | null;
      /** The cursor row we last acted from (to recognize a pre-move repaint). */
      lastCursor: string | null;
      /** The row the last arrow press is expected to move the cursor to. */
      awaitingCursor: string | null;
      navSteps: number;
      rollbackEscs: number;
      /** Set when a KNOWN needs-attention cause is recognized, so the async
       *  (post-rollback) `finishCodexModel` can name it. `drift` = the target model
       *  row was absent from the live picker (legacy/curated-list drift, D5), or the
       *  effort to preserve had no v1 row. Absent ⇒ a generic timeout/opaque-screen
       *  rollback. */
      attentionReason: ControlSwitchAttentionReason | null;
      timer: NodeJS.Timeout | null;
    }
  | {
      // `parked-confirm` (S7) — a RECOGNIZED confirm dialog is open in the
      // Terminal and Sonata is PARKED on it, relaying its rows through the Action
      // Drawer (revision 3). Two whitelisted dialogs:
      //   `claude-cachemiss` — the `Switch model? / Change effort level?` dialog a
      //     `/model` / `/effort` inject raises on a session with history. Rows:
      //     1 = Yes (apply), 2 = No (cancel). Yes → the normal `Set …` receipt →
      //     settle (+ run a queued `next` for the staged sequence, Part 1); No →
      //     the `Kept … as` line → cancelled (drop `next`).
      //   `codex-consent` — the `Enable full access?` consent the /permissions
      //     Full Access row opens. Rows (0.146.0): 1 = Yes, continue anyway →
      //     grant → the `• Permissions updated to Full Access` receipt → settle +
      //     mirror; 2 = Cancel → back to the /permissions picker, which one Esc
      //     then closes (measured — the consent's two exits differ: `esc` from
      //     the consent lands on the composer, Enter on Cancel does not).
      // The dialog is reached by transforming the driving pending IN PLACE (the
      // value axis for claude, the codex-permission `confirming` phase for codex),
      // so the single-switch guard still holds one pointer. RED LINE: only the
      // user's chosen row is ever injected; a dismiss injects the Cancel row; an
      // active-phase timeout Escs the dialog (measured clean) → needs-attention.
      // Phases:
      //   waiting-user — dialog parked, drawer shown; NO timeout (the drawer is the
      //                  resolution surface, send is gated). Also settles if the
      //                  user answers NATIVELY in the co-visible Terminal.
      //   navigating   — the user answered; driving the cursor to `targetRow`,
      //                  validating each arrow press.
      //   confirming   — pressed Enter on the target row; waiting for the settle
      //                  signal (receipt for a grant/Yes, `Kept …` for a claude No).
      //   cancel-exit  — codex ONLY: the consent left the screen without our grant
      //                  confirm — either we Enter'd its Cancel row (its closing
      //                  Esc already queued) or the user answered natively.
      //                  Bounded wait: a grant receipt still settles Yes (a native
      //                  Yes closes the dialog a beat before it prints), otherwise
      //                  the verify timer settles cancelled.
      //   closing      — an active-phase timeout fired the Esc rollback; verifying,
      //                  then needs-attention.
      axis: "parked-confirm";
      dialog: "claude-cachemiss" | "codex-consent";
      /** The kind echoed to the renderer (chip pending label + drawer copy) and,
       *  for claude-cachemiss, the value axis the settle/cancel receipt is scoped
       *  to. `model` | `effort` for claude; `codex-permission` for codex. The
       *  renderer composes the VERBATIM drawer rows from (dialog, kind, value) +
       *  its own registered copy — the host navigates by row NUMBER (validated by
       *  the cursor parser), so it never needs the row text. */
      originKind: ClaudeControlSwitchKind;
      /** claude-cachemiss: the switched value (a model id / effort level) — the
       *  display target. Unused for codex-consent (its target is always
       *  full-access). */
      value: string;
      /** claude-cachemiss ONLY: a queued follow-up command (the staged sequence's
       *  second axis, Part 1). Run only after a Yes settles; dropped on a No. */
      next: { kind: "effort"; value: string } | null;
      /** codex-consent ONLY: the mode the grant receipt confirms (full-access). */
      codexTarget: CodexPermissionMode | null;
      phase: "waiting-user" | "navigating" | "confirming" | "cancel-exit" | "closing";
      /** The CLI row (1-based) the user chose / we're driving the cursor toward. */
      targetRow: number | null;
      /** The cursor row we last acted from (to recognize a pre-move repaint). */
      lastCursor: number | null;
      /** The row the last arrow press is expected to move the cursor to. */
      awaitingCursor: number | null;
      navSteps: number;
      rollbackEscs: number;
      timer: NodeJS.Timeout | null;
    };

/**
 * The mid-session control-switch choreography engine (consolidation S4). Owns the
 * five axis state machines (claude model/effort, claude permission Shift+Tab
 * stepping, codex /permissions picker, codex /model two-level picker) plus the
 * S7 parked-confirm drawer relay, all driven off the PTY stream through a narrow
 * ControlSwitchHost. Moved verbatim from TerminalHost; the only edits are the
 * host-seam rewrites (PTY writes, AtomicWriter, idle guards, event emission).
 */
export class ControlSwitchEngine {
  // `pendingControlSwitch` is THE one in-flight switch (idle only) — a single
  // pointer, so no two axes ever overlap (the shared single-switch guard).
  // `controlSwitchScan` is the rolling RAW pty tail we watch for the receipt
  // line(s) while it is set; the permission engine resets it each step. Both
  // clear the instant the switch resolves — the statusline (model/effort) / the
  // hook payload (permission), not this scrape, remains the state authority.
  private pendingControlSwitch: PendingControlSwitch | null = null;
  private controlSwitchScan = "";
  // The frame captured AT PARK TIME (review F2). A parked dialog is static until
  // a key is pressed, so the relay's first nav read needs the parked cursor — but
  // if we kept it in `controlSwitchScan` (a 4096-char rolling window), the stale
  // dialog text would linger there and defeat the codex native-cancel detection,
  // which is ABSENCE-based (`!consentDialogOpen`): a small post-Esc repaint never
  // evicts the consent text, so the relay parked forever. So at park we snapshot
  // the frame HERE and RESET `controlSwitchScan` — post-park frames then dominate
  // the scan (native-cancel/receipt detection see fresh content), while the first
  // nav read falls back to this snapshot for the retained cursor.
  private parkedFrame = "";

  constructor(private readonly host: ControlSwitchHost) {}

  /** True whenever a mid-session control switch is in flight, in ANY phase —
   *  including a PARKED consent dialog (`waiting-user`, which has no timeout by
   *  design). The delivery pump and every host write-path gate on this. */
  hasPending(): boolean {
    return this.pendingControlSwitch !== null;
  }

  /** Feed each fresh PTY frame to the pending switch's receipt watcher. Called
   *  from TerminalHost.handlePtyData in the same dispatch position the inlined
   *  detectControlSwitchReceipt held (between remote-control + approval scrape). */
  ingest(data: string): void {
    this.detectControlSwitchReceipt(data);
  }

  /** Drop the in-flight switch (host lifecycle: run start, PTY teardown, dispose).
   *  Closes an abandoned codex picker first so it can't swallow the next keystroke. */
  clear(): void {
    this.clearPendingControlSwitch();
  }

  injectClaudeControlSwitch(
    kind: ClaudeControlSwitchKind,
    value: string,
    from?: string,
  ): ClaudeControlSwitchResponse {
    // Provider gate, BOTH directions (the backend half of the renderer's chip
    // gate): the three `codex-*` kinds reach only a codex session; the three
    // claude kinds only a claude session. A claude kind on codex would burn a
    // turn on an inline `/model` arg (probe hazard) and codex has no Shift+Tab
    // cycle; a codex kind on claude has no picker to drive.
    const isCodexKind =
      kind === "codex-permission" || kind === "codex-model" || kind === "codex-effort";
    const wantProvider: RuntimeProvider = isCodexKind ? "codex" : "claude";
    if (this.host.provider !== wantProvider) {
      return { ok: false, reason: "wrong-provider" };
    }
    if (!this.host.hasPty()) {
      return { ok: false, reason: "no-process" };
    }
    if (this.host.isApprovalActive()) {
      return { ok: false, reason: "panel-open" };
    }
    if (this.host.hasActiveRun()) {
      return { ok: false, reason: "not-idle" };
    }
    // A prior switch still resolving, or any automation write mid-sequence —
    // refuse rather than interleave a second drive's bytes. (The shared
    // single-switch guard: no two axes — across BOTH providers — ever overlap.)
    if (this.pendingControlSwitch || this.host.isSonataWriting()) {
      return { ok: false, reason: "busy" };
    }

    if (kind === "codex-permission") {
      return this.startCodexPermissionSwitch(value, from);
    }
    if (kind === "codex-model" || kind === "codex-effort") {
      return this.startCodexModelSwitch(kind, value, from);
    }
    if (kind === "permission") {
      return this.startPermissionSwitch(value, from);
    }

    // Single-axis claude model/effort switch: inject the one command, no queued
    // follow-up. The staged Save sequence (Part 1) uses startClaudeStagedSwitch,
    // which threads a `next` through this same writer.
    this.writeClaudeValueCommand(kind, value, null);
    return { ok: true };
  }

  /**
   * Begin a STAGED claude model+effort Save (Part 1, S7): apply only the CHANGED
   * axes as ONE logical switch. When both change, run `/model X` first, then
   * `/effort Y` (queued as the first command's `next`); the cache-miss drawer
   * relay (if it fires) sits between them and the second command runs only after
   * the first settles. When one changes, it's the single-axis path. The renderer
   * only calls this with a genuinely-dirty pair (Save is disabled when clean), and
   * has already run the idle/single-switch guards via injectClaudeControlSwitch's
   * shape — but we re-check the invariants a mid-session switch always requires.
   */
  startClaudeStagedSwitch(
    model: string | null,
    effort: string | null,
  ): ClaudeControlSwitchResponse {
    if (this.host.provider !== "claude") {
      return { ok: false, reason: "wrong-provider" };
    }
    if (!this.host.hasPty()) {
      return { ok: false, reason: "no-process" };
    }
    if (this.host.isApprovalActive()) {
      return { ok: false, reason: "panel-open" };
    }
    if (this.host.hasActiveRun()) {
      return { ok: false, reason: "not-idle" };
    }
    if (this.pendingControlSwitch || this.host.isSonataWriting()) {
      return { ok: false, reason: "busy" };
    }
    // Nothing to do (defensive — Save is disabled when clean). An empty pair is
    // caller input the engine can't act on, not a busy CLI — report it honestly.
    if (!model && !effort) {
      return { ok: false, reason: "invalid" };
    }
    if (model) {
      // Model first; queue effort as the continuation (if it also changed).
      this.writeClaudeValueCommand("model", model, effort ? { kind: "effort", value: effort } : null);
    } else {
      // Only effort changed — single command.
      this.writeClaudeValueCommand("effort", effort as string, null);
    }
    return { ok: true };
  }

  /**
   * Inject one `/model X` / `/effort Y` command and arm the receipt watch. Shared
   * by the single-axis inject, the staged Save sequence, and the parked cache-miss
   * Yes continuation. `next` is a queued follow-up (run after this settles).
   */
  private writeClaudeValueCommand(
    kind: "model" | "effort",
    value: string,
    next: { kind: "effort"; value: string } | null,
  ): void {
    if (!this.host.hasPty()) {
      return;
    }
    const command = `/${kind} ${value}`;
    this.host.beginSonataWrite();
    // Clear the composer line UNCONDITIONALLY before our command lands, so it
    // can't concatenate onto an Esc-restored prompt OR text a human typed
    // straight into the idle Terminal (which sets no dirty flag) — a
    // `<prefix>/model x` line submits as a chat prompt. Screen-blind-safe: a
    // no-op on a clean line. (F1 review fix: the old dirty-flag-gated flood
    // no-oped exactly when a human's untracked typing needed clearing.)
    this.host.clearComposerBeforeTypedCommand();
    // Typed text, NOT bracketed paste: write the command bytes as real
    // keystrokes (probe verified `/model sonnet` typed, then Enter, applies).
    this.host.writePty(command);
    // Defer the Enter under the held lock (mirrors the prompt-delivery path): a
    // human keystroke landing in the gap buffers rather than splitting the frame.
    // A raw carriage return (`\r`), NOT CSI_U_ENTER: a command typed raw into the
    // slash path submits on `\r` in BOTH legacy and kitty input modes, whereas
    // the CSI-u encoding only lands under a negotiated kitty session (probe: raw
    // `/model` + CSI_U_ENTER did not submit; + `\r` did). The bracketed-paste
    // prompt path can rely on CSI_U_ENTER; this raw-command path cannot.
    this.host.deferSonataWrite(
      120,
      () => {
        if (this.host.hasPty()) {
          this.host.writePty("\r");
        }
      },
      "control",
    );
    this.host.endSonataWrite();

    // Arm the watch: fresh scan window, pending state, and the needs-attention
    // timeout. The receipt (settled/failed) clears the timer.
    this.controlSwitchScan = "";
    const timer = setTimeout(() => {
      this.onControlSwitchTimeout();
    }, CONTROL_SWITCH_RECEIPT_TIMEOUT_MS);
    timer.unref?.();
    this.pendingControlSwitch = { axis: "value", kind, value, next, timer };
    this.emitControlSwitchState("pending", { kind, value });
  }

  /**
   * Begin a permission switch via the Shift+Tab stepping engine (S2). We can't
   * jump to a mode — there is no arg form — so we press Shift+Tab (`\x1b[Z`) one
   * step at a time and read the TUI mode line to learn where we landed, repeating
   * until the target is confirmed. `origin` is where we return to if the target
   * proves unreachable: a Shift+Tab abort is a STATE CHANGE (unlike Esc, you
   * cannot back out of it), so we must land the session somewhere honest, not
   * strand it. Falls back to `default` (Manual — the cycle anchor, always a
   * member) when the caller's current mode is unknown.
   */
  private startPermissionSwitch(value: string, from?: string): ClaudeControlSwitchResponse {
    const target = asClaudePermissionMode(value);
    if (!target) {
      // The renderer only offers reachable ClaudePermissionMode ids; a non-mode
      // value is a caller bug, not a screen state — refuse without touching the pty.
      return { ok: false, reason: "invalid" };
    }
    const origin = asClaudePermissionMode(from) ?? "default";
    if (target === origin) {
      // Already there — nothing to step. Report settled so the pending affordance
      // never appears (defensive; the menu marks the current mode, so this is rare).
      this.emitControlSwitchState("settled", { kind: "permission", value: target });
      return { ok: true };
    }

    this.controlSwitchScan = "";
    this.pendingControlSwitch = {
      axis: "permission",
      target,
      origin,
      phase: "seeking",
      landed: null,
      pressedFrom: null,
      seekSteps: 0,
      returnSteps: 0,
      observed: new Set<ClaudePermissionMode>([origin]),
      timer: null,
    };
    this.emitControlSwitchState("pending", { kind: "permission", value: target });
    this.writePermissionStep();
    return { ok: true };
  }

  /**
   * One Shift+Tab step: write `\x1b[Z` under the write-lock (the ONLY byte this
   * choreography ever emits — RED LINE), reset the scan window so only this
   * step's mode line is read, and arm the per-step receipt timeout.
   */
  private writePermissionStep(): void {
    const pending = this.pendingControlSwitch;
    if (!pending || pending.axis !== "permission" || !this.host.hasPty()) {
      return;
    }
    // Anchor the landing validation for THIS press: the mode we are on now (the
    // last confirmed landing, or the origin for the first press). A post-press
    // frame that still shows this mode is a stale pre-press repaint; a frame
    // showing a non-successor mode is an unexpected screen (review F3).
    pending.pressedFrom = pending.landed ?? pending.origin;
    this.controlSwitchScan = "";
    this.host.beginSonataWrite();
    this.host.writePty(SHIFT_TAB);
    this.host.endSonataWrite();
    const timer = setTimeout(() => {
      this.onPermissionStepTimeout();
    }, PERMISSION_STEP_RECEIPT_TIMEOUT_MS);
    timer.unref?.();
    pending.timer = timer;
  }

  /**
   * Drive the Shift+Tab stepping engine off a fresh pty frame, validating each
   * press's landing before accepting it as this step's receipt (review F3). The
   * mode line is parsed most-recent-wins from the reset-per-step scan; then:
   *   - no recognized mode yet → wait (the per-step timeout guards).
   *   - landing === the mode we pressed FROM → a stale pre-press repaint → wait
   *     (the fix for the double-press: the old engine read this as "landed on the
   *     same mode" and pressed again).
   *   - landing is not an expected cycle successor of `pressedFrom` → an
   *     unexpected screen → fail loud (return-home / needs-attention), never
   *     read it as the receipt and never blind-continue.
   *   - otherwise it is the step's real landing → hand to onPermissionReceipt.
   */
  private onPermissionData(pending: Extract<PendingControlSwitch, { axis: "permission" }>): void {
    const landed = parseClaudePermissionModeLine(this.controlSwitchScan);
    if (!landed) {
      return; // no recognized mode line yet — wait (per-step timeout guards)
    }
    const from = pending.pressedFrom;
    if (from !== null) {
      if (landed === from) {
        return; // stale pre-press repaint of the mode we pressed FROM — keep waiting
      }
      if (!expectedPermissionLandings(from).has(landed)) {
        this.handlePermissionStepFailure(pending); // unexpected landing — fail loud
        return;
      }
    }
    this.onPermissionReceipt(landed);
  }

  /**
   * A step's mode-line receipt landed. Record it, then decide the next move:
   *   seeking  — target? settle. else keep seeking until the bound, then flip to
   *              returning-home.
   *   returning — origin? we're home (couldn't reach the target) → needs-attention.
   *              else keep stepping toward origin until the return cap.
   */
  private onPermissionReceipt(landed: ClaudePermissionMode): void {
    const pending = this.pendingControlSwitch;
    if (!pending || pending.axis !== "permission") {
      return;
    }
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    pending.landed = landed;
    pending.observed.add(landed);

    if (pending.phase === "seeking") {
      if (landed === pending.target) {
        this.finishPermissionSwitch("settled", pending);
        return;
      }
      pending.seekSteps += 1;
      if (pending.seekSteps >= PERMISSION_MAX_SEEK_STEPS) {
        this.beginPermissionReturn(pending);
        return;
      }
      this.writePermissionStep();
      return;
    }

    // returning home
    if (landed === pending.origin) {
      this.finishPermissionSwitch("needs-attention", pending);
      return;
    }
    pending.returnSteps += 1;
    if (pending.returnSteps >= PERMISSION_MAX_RETURN_STEPS) {
      this.finishPermissionSwitch("needs-attention", pending);
      return;
    }
    this.writePermissionStep();
  }

  /**
   * A step earned no recognized mode line within its window — an unrecognized
   * outcome (a redraw we don't parse, or an unexpected screen). The failure
   * contract (shared with an unexpected-landing, review F3) lives in
   * handlePermissionStepFailure.
   */
  private onPermissionStepTimeout(): void {
    const pending = this.pendingControlSwitch;
    if (!pending || pending.axis !== "permission") {
      return;
    }
    this.handlePermissionStepFailure(pending);
  }

  /**
   * A step's outcome was unusable — either no recognized mode line in the window
   * (timeout) or a landing that is not an expected cycle successor (review F3: an
   * unexpected screen we must never read as this step's receipt, and never
   * blind-continue past). Per the failure contract a SEEKING failure flips to
   * returning-home; a RETURNING failure keeps stepping toward origin, bounded by
   * the return cap, then needs-attention. We only ever step with `\x1b[Z` (RED
   * LINE) — never a blind Enter or other key to "clear" the screen.
   */
  private handlePermissionStepFailure(
    pending: Extract<PendingControlSwitch, { axis: "permission" }>,
  ): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    if (pending.phase === "seeking") {
      this.beginPermissionReturn(pending);
      return;
    }
    pending.returnSteps += 1;
    if (pending.returnSteps >= PERMISSION_MAX_RETURN_STEPS) {
      this.finishPermissionSwitch("needs-attention", pending);
      return;
    }
    this.writePermissionStep();
  }

  /** Enter the return-home phase: if we already know we're at origin, stop and
   *  raise needs-attention; otherwise keep stepping toward it. */
  private beginPermissionReturn(
    pending: Extract<PendingControlSwitch, { axis: "permission" }>,
  ): void {
    pending.phase = "returning";
    if (pending.landed === pending.origin) {
      this.finishPermissionSwitch("needs-attention", pending);
      return;
    }
    this.writePermissionStep();
  }

  /** Resolve a permission switch: clear the pending pointer and emit the terminal
   *  phase with the modes this choreography confirmed (so the menu learns which
   *  gated modes this session can reach). The hook payload's `permission_mode`
   *  remains the state SSOT — this event only drives the pending affordance /
   *  needs-attention banner. */
  private finishPermissionSwitch(
    phase: "settled" | "needs-attention",
    pending: Extract<PendingControlSwitch, { axis: "permission" }>,
  ): void {
    const observedModes = [...pending.observed];
    const target = pending.target;
    this.clearPendingControlSwitch();
    this.emitControlSwitchState(phase, { kind: "permission", value: target, observedModes });
  }

  // ── Codex `/permissions` picker choreography (S3) ───────────────────────────

  /**
   * Begin a codex permission switch. Codex has no arg form and no Shift+Tab
   * cycle: we OPEN a picker by typing bare `/permissions` (RED LINE 1 — never
   * with args, that submits as a chat prompt and burns a turn) + Enter, then
   * navigate its three rows by TEXT and confirm with Enter, reading the picker's
   * own text as the choreography receipt. `from` (the session's current mode)
   * only skips a no-op switch to the mode we're already in.
   */
  private startCodexPermissionSwitch(value: string, from?: string): ClaudeControlSwitchResponse {
    const target = asCodexPermissionMode(value);
    if (!target) {
      // The renderer only offers the three CodexPermissionMode ids; a non-mode
      // value is a caller bug, not a screen state — refuse without touching the pty.
      return { ok: false, reason: "invalid" };
    }
    const origin = asCodexPermissionMode(from);
    if (origin && target === origin) {
      // Already there — nothing to drive. Report settled so no pending affordance
      // appears (the menu marks the current mode, so this is rare/defensive).
      this.emitControlSwitchState("settled", { kind: "codex-permission", value: target });
      return { ok: true };
    }
    if (!this.host.hasPty()) {
      return { ok: false, reason: "no-process" };
    }

    this.controlSwitchScan = "";
    this.pendingControlSwitch = {
      axis: "codex-permission",
      target,
      phase: "opening",
      pickerOpen: false,
      lastCursor: null,
      awaitingCursor: null,
      navSteps: 0,
      attentionReason: null,
      timer: null,
    };
    this.emitControlSwitchState("pending", { kind: "codex-permission", value: target });

    // Type bare `/permissions` (typed text, NOT bracketed paste — mirrors the S1
    // `/model` inject), then defer the Enter under the held write-lock so a human
    // keystroke in the gap buffers rather than splitting the frame.
    this.host.beginSonataWrite();
    // Clear the composer UNCONDITIONALLY first (RED LINE 1): if a human typed
    // unsubmitted text into the idle Terminal, `/permissions` would concatenate
    // onto it (`<prefix>/permissions`) and SUBMIT as a chat prompt — codex burns
    // a real turn and the run:started silently cancels this switch. The old
    // dirty-flag-gated flood no-oped there (untracked typing sets no flag).
    this.host.clearComposerBeforeTypedCommand();
    this.host.writePty("/permissions");
    this.host.deferSonataWrite(
      120,
      () => {
        if (this.host.hasPty()) {
          this.host.writePty("\r");
        }
      },
      "control",
    );
    this.host.endSonataWrite();
    this.armCodexPickerTimeout(CODEX_PICKER_OPEN_TIMEOUT_MS);
    return { ok: true };
  }

  /** Drive the picker state machine off a fresh pty frame (called from
   *  detectControlSwitchReceipt while the codex-permission switch is unresolved). */
  private onCodexPickerData(): void {
    const pending = this.pendingControlSwitch;
    if (!pending || pending.axis !== "codex-permission") {
      return;
    }
    const scan = this.controlSwitchScan;

    if (pending.phase === "opening") {
      // Flip pickerOpen the instant the header renders — BEFORE the cursor parses
      // — so a timeout that fires while the picker is open (cursor unreadable)
      // still rolls back with an Esc rather than stranding an open picker.
      if (codexPermissionPickerOpen(scan)) {
        pending.pickerOpen = true;
      }
      if (!pending.pickerOpen) {
        return; // header not up yet — wait (opening timeout Escs if it never comes)
      }
      const cursor = parseCodexPermissionPickerCursor(scan);
      if (!cursor) {
        return; // picker open, cursor row not recognized yet — wait
      }
      pending.phase = "navigating";
      this.clearCodexPickerTimer(pending);
      this.decideCodexNav(cursor);
      return;
    }

    if (pending.phase === "navigating") {
      const cursor = parseCodexPermissionPickerCursor(scan);
      if (!cursor) {
        return; // no recognized cursor row yet — wait
      }
      if (pending.awaitingCursor && cursor !== pending.awaitingCursor) {
        // The move hasn't landed yet: a pre-move repaint still shows the row we
        // pressed FROM — ignore it and keep waiting. Any OTHER row is an
        // unexpected jump (wrap, drift) → roll back (never keep guessing).
        if (cursor === pending.lastCursor) {
          return;
        }
        this.failCodexPicker(pending);
        return;
      }
      pending.awaitingCursor = null;
      this.clearCodexPickerTimer(pending);
      this.decideCodexNav(cursor);
      return;
    }

    // `confirming` — watch for the `• Permissions updated to <label>` receipt.
    if (pending.phase === "confirming") {
      // The receipt (a TEMPORAL event) is read off the STREAM, and FIRST: on the
      // ask/approve rows it is the only outcome, and a landed receipt must beat
      // any dialog frame.
      const landed = parseCodexPermissionReceipt(scan);
      if (landed) {
        this.clearCodexPickerTimer(pending);
        // Confirm closed the picker (Enter dismisses it — measured). A receipt for
        // any mode OTHER than our target should be impossible (we confirmed the
        // target row), but if it happens the state is unexpected → needs-attention.
        pending.pickerOpen = false;
        this.finishCodexPicker(landed === pending.target ? "settled" : "needs-attention", pending);
        return;
      }
      // RED LINE 2: confirming Full Access opens a consent dialog instead of a
      // receipt. Never auto-answer it. S7 (revision 3) OVERTURNS S3's rollback:
      // instead of Escing the dialog away (it flashed shut before the user could
      // act), PARK on it and relay its rows through the drawer — the user's grant
      // is injected only when THEY choose it. "Is the dialog on screen" is a
      // SPATIAL query, so it reads the GRID (D-1): codex 0.146 paints the consent
      // as a cell diff over the picker rows it replaces, which leaves the stream
      // predicate FALSE on a dialog that is plainly displayed (measured) — the
      // choreography then timed out and Esc'd a consent the user never saw.
      this.host.readScreen((screen) => {
        const current = this.pendingControlSwitch;
        if (
          !current ||
          current.axis !== "codex-permission" ||
          current.phase !== "confirming" ||
          !codexPermissionConsentDialogOpen(screen)
        ) {
          return; // still no dialog (or the switch moved on) — the confirm timeout guards
        }
        this.parkCodexConsent(current);
      });
    }
    // `closing` — the rollback Esc is in flight; ignore picker frames and let the
    // close-verify timer emit needs-attention.
  }

  /**
   * Decide the next navigation move from the cursor's CURRENT row (always read by
   * text): confirm if we're on the target, else press ONE arrow toward it and
   * re-read. Direction comes from the picker's stable row order, but every press
   * is validated against the actual post-press cursor (`awaitingCursor`), so an
   * assumed index never drives blind. Bounded by the nav cap → Esc-rollback.
   */
  private decideCodexNav(cursor: CodexPermissionMode): void {
    const pending = this.pendingControlSwitch;
    if (!pending || pending.axis !== "codex-permission" || !this.host.hasPty()) {
      return;
    }
    if (process.env.SONATA_DEBUG_COMPLETION) {
      console.log(
        `[codex-permission] nav cursor=${cursor} target=${pending.target} navSteps=${pending.navSteps}`,
      );
    }
    if (cursor === pending.target) {
      pending.phase = "confirming";
      this.controlSwitchScan = "";
      this.host.beginSonataWrite();
      this.host.writePty("\r");
      this.host.endSonataWrite();
      this.armCodexPickerTimeout(CODEX_PICKER_CONFIRM_TIMEOUT_MS);
      return;
    }
    if (pending.navSteps >= CODEX_PICKER_MAX_NAV_STEPS) {
      this.failCodexPicker(pending);
      return;
    }
    const goingDown = CODEX_ROW_ORDER[pending.target] > CODEX_ROW_ORDER[cursor];
    const nextOrder = CODEX_ROW_ORDER[cursor] + (goingDown ? 1 : -1);
    const expected = CODEX_ROW_BY_ORDER[nextOrder];
    if (!expected) {
      // Off the ends of the row list — should be unreachable (target is a valid
      // row and cursor is between it and here). Defensive: roll back.
      this.failCodexPicker(pending);
      return;
    }
    pending.lastCursor = cursor;
    pending.awaitingCursor = expected;
    pending.navSteps += 1;
    this.controlSwitchScan = "";
    this.host.beginSonataWrite();
    this.host.writePty(goingDown ? ARROW_DOWN : ARROW_UP);
    this.host.endSonataWrite();
    this.armCodexPickerTimeout(CODEX_PICKER_NAV_TIMEOUT_MS);
  }

  /**
   * A per-phase timeout fired: the screen is in a state the choreography can't
   * recognize. RED LINE 3 — roll back with a single Esc (the ONLY non-navigation
   * byte we ever write, and only while the picker is open), then verify the
   * picker closed and surface needs-attention. NEVER retry, NEVER guess a row.
   */
  private onCodexPickerTimeout(): void {
    const pending = this.pendingControlSwitch;
    if (!pending || pending.axis !== "codex-permission") {
      return;
    }
    pending.timer = null;
    this.failCodexPicker(pending);
  }

  /** Roll back an unrecoverable picker choreography: Esc to close the picker (if
   *  open), then a bounded verify-window before emitting needs-attention. */
  private failCodexPicker(pending: Extract<PendingControlSwitch, { axis: "codex-permission" }>): void {
    this.clearCodexPickerTimer(pending);
    if (pending.pickerOpen && this.host.hasPty()) {
      this.controlSwitchScan = "";
      this.host.beginSonataWrite();
      this.host.writePty(ESC);
      this.host.endSonataWrite();
    }
    // Whether or not the picker was open, wait a beat, then conclude. The Esc's
    // effect (footer gone) is verified in the timer; we surface needs-attention
    // regardless — the user resolves it in the co-visible Terminal.
    pending.phase = "closing";
    pending.pickerOpen = false;
    const timer = setTimeout(() => {
      this.onCodexPickerCloseVerify();
    }, CODEX_PICKER_CLOSE_VERIFY_MS);
    timer.unref?.();
    pending.timer = timer;
  }

  /** After the rollback Esc, conclude the switch as needs-attention. The picker
   *  footer's absence from the post-Esc scan is the "it closed" evidence (logged
   *  when SONATA_DEBUG_COMPLETION is set); the terminal state is the user's to
   *  reconcile either way. */
  private onCodexPickerCloseVerify(): void {
    const pending = this.pendingControlSwitch;
    if (!pending || pending.axis !== "codex-permission") {
      return;
    }
    pending.timer = null;
    if (process.env.SONATA_DEBUG_COMPLETION) {
      const stillOpen = codexPermissionPickerFooterVisible(this.controlSwitchScan);
      console.log(
        `[codex-permission] rollback Esc → pickerClosed=${!stillOpen} target=${pending.target}`,
      );
    }
    this.finishCodexPicker("needs-attention", pending);
  }

  private armCodexPickerTimeout(ms: number): void {
    const pending = this.pendingControlSwitch;
    if (!pending || pending.axis !== "codex-permission") {
      return;
    }
    const timer = setTimeout(() => {
      this.onCodexPickerTimeout();
    }, ms);
    timer.unref?.();
    pending.timer = timer;
  }

  private clearCodexPickerTimer(
    pending: Extract<PendingControlSwitch, { axis: "codex-permission" }>,
  ): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
  }

  /** Resolve a codex permission switch: clear the pending pointer and emit the
   *  terminal phase. On `settled`, the CONTROLLER writes `task.codexPermissionMode`
   *  off this event — codex has no hook-payload permission mirror, so the picker
   *  receipt is the confirmation channel (the asymmetry vs claude's lazy hook
   *  reconcile; see runtime-controller `applyCodexPermissionSwitchReceipt`). */
  private finishCodexPicker(
    phase: "settled" | "needs-attention",
    pending: Extract<PendingControlSwitch, { axis: "codex-permission" }>,
  ): void {
    const target = pending.target;
    const reason = phase === "needs-attention" ? pending.attentionReason : null;
    this.clearPendingControlSwitch();
    this.emitControlSwitchState(phase, {
      kind: "codex-permission",
      value: target,
      ...(reason ? { reason } : {}),
    });
  }

  // ── Codex `/model` two-level picker choreography (S4) ────────────────────────

  /**
   * Begin a codex model/effort switch via the `/model` two-level picker. Codex has
   * no arg form (an inline `/model x` submits as a chat prompt and burns a turn —
   * RED LINE 1), so we type bare `/model` + Enter to OPEN the picker, navigate its
   * level-1 model rows then level-2 reasoning rows by TEXT, and read the
   * `• Model changed to <model> <effort>` receipt. `kind` selects which dimension
   * is being switched: `codex-model` targets the model row and preserves the
   * current reasoning (its level-2 `(current)` row); `codex-effort` targets the
   * reasoning row and preserves the current model (its level-1 `(current)` row).
   */
  private startCodexModelSwitch(
    kind: "codex-model" | "codex-effort",
    value: string,
    from?: string,
  ): ClaudeControlSwitchResponse {
    if (kind === "codex-effort" && !asCodexReasoningTarget(value)) {
      // The renderer only offers the v1 reasoning ids; a non-target value is a
      // caller bug, not a screen state — refuse without touching the pty.
      return { ok: false, reason: "invalid" };
    }
    if (kind === "codex-model" && value.trim().length === 0) {
      return { ok: false, reason: "invalid" };
    }
    if (!this.host.hasPty()) {
      return { ok: false, reason: "no-process" };
    }

    this.controlSwitchScan = "";
    this.pendingControlSwitch = {
      axis: "codex-model",
      switchKind: kind,
      value,
      // codex-model: `from` is the current effort to preserve at level 2 (the
      // (current) marker is gone after a model change — see the field doc).
      preserveEffort: kind === "codex-model" ? asCodexReasoningTarget(from) : null,
      phase: "opening",
      pickerLevel: 0,
      chosenModel: null,
      chosenEffort: null,
      order: null,
      byDigit: null,
      target: null,
      lastCursor: null,
      awaitingCursor: null,
      navSteps: 0,
      rollbackEscs: 0,
      attentionReason: null,
      timer: null,
    };
    this.emitControlSwitchState("pending", { kind, value });

    // Type bare `/model` (typed text, NOT bracketed paste — mirrors S1/S3), then
    // defer the Enter under the held write-lock so a human keystroke in the gap
    // buffers rather than splitting the frame.
    this.host.beginSonataWrite();
    // Clear the composer UNCONDITIONALLY first (RED LINE 1): if a human typed
    // unsubmitted text into the idle Terminal, `/model` would concatenate onto it
    // (`<prefix>/model`) and SUBMIT as a chat prompt — codex burns a real turn and
    // the run:started silently cancels this switch. Screen-blind-safe (a no-op on
    // a clean line). (Shared with S1/S3 — the F1 review lesson.)
    this.host.clearComposerBeforeTypedCommand();
    this.host.writePty("/model");
    this.host.deferSonataWrite(
      120,
      () => {
        if (this.host.hasPty()) {
          this.host.writePty("\r");
        }
      },
      "control",
    );
    this.host.endSonataWrite();
    this.armCodexModelTimeout(CODEX_MODEL_OPEN_TIMEOUT_MS);
    return { ok: true };
  }

  /** Drive the two-level picker state machine off a fresh pty frame (called from
   *  detectControlSwitchReceipt while a codex-model switch is unresolved). Each
   *  arrow/Enter is validated against the actual post-press cursor — a pre-move
   *  repaint waits, an unexpected jump rolls back (never keep guessing). */
  private onCodexModelPickerData(): void {
    const pending = this.pendingControlSwitch;
    if (!pending || pending.axis !== "codex-model") {
      return;
    }
    const scan = this.controlSwitchScan;

    if (process.env.SONATA_DEBUG_COMPLETION) {
      console.log(
        `[codex-model] phase=${pending.phase} await=${pending.awaitingCursor} ` +
          `l1cursor=${parseCodexModelLevel1(scan).cursor} l2cursor=${parseCodexModelLevel2(scan).cursor}`,
      );
    }

    if (pending.phase === "opening") {
      // Flip pickerLevel the instant the level-1 header renders — BEFORE the cursor
      // parses — so a timeout that fires while the picker is open (cursor
      // unreadable) still rolls back with an Esc rather than stranding it.
      if (codexModelPickerLevel1Open(scan)) {
        pending.pickerLevel = 1;
      }
      if (pending.pickerLevel < 1) {
        return; // header not up yet — wait (opening timeout Escs if it never comes)
      }
      // Capture the level-1 order + resolve the target from the COMPLETE opening
      // frame (footer up ⇒ all rows painted). This is the only frame guaranteed to
      // show every row; codex repaints partially after arrows, so the order must be
      // taken now or multi-step nav strands on a far row it can't see.
      if (!this.captureCodexModelLevel(parseCodexModelLevel1(scan), "l1")) {
        return; // frame not complete / target unresolved-yet — wait (open timeout Escs)
      }
      pending.phase = "navigating-l1";
      this.clearCodexModelTimer(pending);
      this.driveCodexModelNav(parseCodexModelLevel1(scan).cursor, "l1");
      return;
    }

    if (pending.phase === "navigating-l1") {
      this.advanceCodexModelNav(parseCodexModelLevel1(scan).cursor, "l1");
      return;
    }

    if (pending.phase === "opening-l2") {
      // The level-2 header MUST name the model we confirmed at level 1 (S4) — a
      // header for any other model is an unexpected screen; the open timeout Escs.
      if (!codexModelPickerLevel2Open(scan, pending.chosenModel ?? undefined)) {
        return;
      }
      pending.pickerLevel = 2;
      if (!this.captureCodexModelLevel(parseCodexModelLevel2(scan), "l2")) {
        return; // level-2 frame not complete / target unresolved yet — wait
      }
      pending.phase = "navigating-l2";
      this.clearCodexModelTimer(pending);
      this.driveCodexModelNav(parseCodexModelLevel2(scan).cursor, "l2");
      return;
    }

    if (pending.phase === "navigating-l2") {
      this.advanceCodexModelNav(parseCodexModelLevel2(scan).cursor, "l2");
      return;
    }

    if (pending.phase === "confirming") {
      const receipt = parseCodexModelReceipt(scan);
      if (!receipt) {
        return; // no receipt yet — wait (confirm timeout Escs)
      }
      this.clearCodexModelTimer(pending);
      // Confirm closed both picker levels (Enter applies + dismisses — measured).
      pending.pickerLevel = 0;
      const landed = receipt.model === pending.chosenModel && receipt.effort === pending.chosenEffort;
      this.finishCodexModel(landed ? "settled" : "needs-attention", pending, receipt);
    }
    // `closing` — a rollback Esc is in flight; ignore picker frames and let the
    // close-verify chain conclude needs-attention.
  }

  /** Capture a level's row ORDER + resolve its navigation target from the COMPLETE
   *  opening frame (footer visible). Returns false (keep waiting) until the frame
   *  is complete AND a cursor is readable; rolls back (D5 / `More reasoning…`
   *  guard) and returns false when the frame is complete but the target row is
   *  absent. On success the captured order drives the whole level's nav — codex's
   *  partial post-arrow repaints never show every row, so this one-shot capture is
   *  what makes multi-step navigation robust. */
  private captureCodexModelLevel(level: CodexPickerLevel<string>, which: "l1" | "l2"): boolean {
    const pending = this.pendingControlSwitch;
    if (!pending || pending.axis !== "codex-model") {
      return false;
    }
    if (!level.cursor || !codexModelPickerFooterVisible(this.controlSwitchScan)) {
      return false; // frame still painting — wait
    }
    const seam = process.env.SONATA_TEST_CODEX_MODEL_MISMATCH;
    let target: string | null;
    if (seam === which) {
      // Test seam (real-CLI smoke only): force a target miss at this level to
      // exercise the rollback (l1 → single Esc; l2 → Esc×2). Inert unless set.
      target = null;
    } else if (which === "l1") {
      target =
        pending.switchKind === "codex-model"
          ? level.order.has(pending.value)
            ? pending.value
            : null
          : level.current; // codex-effort → preserve the current model
    } else {
      // Level 2 (reasoning). codex-effort navigates to the SELECTED reasoning;
      // codex-model navigates to the current effort to PRESERVE it — explicitly,
      // NOT via the level-2 `(current)` marker, which codex drops after a model
      // change (measured). `preserveEffort` is null when the current effort is
      // Native Default / Max / Ultra → can't be held on a v1 row → rollback.
      const wanted =
        pending.switchKind === "codex-effort" ? (pending.value as string) : pending.preserveEffort;
      target = wanted && level.order.has(wanted) ? wanted : null;
      if (target === "more") {
        target = null; // NEVER enter More reasoning… (Max/Ultra — D6)
      }
    }
    if (!target) {
      // A curated target absent from the LIVE picker rows (legacy/list drift, D5),
      // no preservable (current), or the preserve-effort has no v1 row — nothing
      // changed CLI-side, and the cause is upstream drift, not an opaque screen.
      // (The test seam forces this path too; it inherits the drift banner, which is
      // the behavior it exercises.) Name it so the banner says "switch in the CLI".
      pending.attentionReason = "drift";
      this.failCodexModelPicker(pending); // absent row (D5) / no (current) / seam
      return false;
    }
    pending.order = level.order;
    pending.byDigit = level.byDigit;
    pending.target = target;
    return true;
  }

  /** Validate the post-arrow cursor, then decide the next move. A pre-move repaint
   *  (still on the row we pressed FROM) waits; an unexpected jump rolls back. */
  private advanceCodexModelNav(cursor: string | null, which: "l1" | "l2"): void {
    const pending = this.pendingControlSwitch;
    if (!pending || pending.axis !== "codex-model") {
      return;
    }
    if (!cursor) {
      return; // no recognized cursor row yet — wait
    }
    if (pending.awaitingCursor && cursor !== pending.awaitingCursor) {
      if (cursor === pending.lastCursor) {
        return; // pre-move repaint of the row we pressed FROM — keep waiting
      }
      this.failCodexModelPicker(pending); // unexpected jump — roll back
      return;
    }
    pending.awaitingCursor = null;
    this.clearCodexModelTimer(pending);
    this.driveCodexModelNav(cursor, which);
  }

  /** Confirm (Enter) if the cursor is on the captured target, else press ONE
   *  validated arrow toward it using the captured order. Bounded by the nav cap →
   *  Esc-rollback. Shared by both levels; the level only differs in what Enter
   *  advances TO (level 2 vs the receipt). */
  private driveCodexModelNav(cursor: string | null, which: "l1" | "l2"): void {
    const pending = this.pendingControlSwitch;
    if (
      !pending ||
      pending.axis !== "codex-model" ||
      !this.host.hasPty() ||
      !cursor ||
      !pending.order ||
      !pending.byDigit ||
      !pending.target
    ) {
      return;
    }
    if (cursor === pending.target) {
      if (which === "l1") {
        // Confirm the model → level 2 opens for it. Reset the per-level nav state;
        // commit pickerLevel to the 2-deep stack for rollback.
        pending.chosenModel = pending.target;
        pending.phase = "opening-l2";
        pending.pickerLevel = 2;
        pending.navSteps = 0;
        pending.order = null;
        pending.byDigit = null;
        pending.target = null;
        pending.lastCursor = null;
        pending.awaitingCursor = null;
        this.controlSwitchScan = "";
        this.host.beginSonataWrite();
        this.host.writePty("\r");
        this.host.endSonataWrite();
        this.armCodexModelTimeout(CODEX_MODEL_LEVEL2_OPEN_TIMEOUT_MS);
        return;
      }
      // level 2 — confirm the reasoning → the receipt.
      const effort = reasoningRowToEffort(pending.target as CodexReasoningRow);
      if (!effort) {
        this.failCodexModelPicker(pending); // defensive: `more` is never a target
        return;
      }
      pending.chosenEffort = effort;
      pending.phase = "confirming";
      this.controlSwitchScan = "";
      this.host.beginSonataWrite();
      this.host.writePty("\r");
      this.host.endSonataWrite();
      this.armCodexModelTimeout(CODEX_MODEL_CONFIRM_TIMEOUT_MS);
      return;
    }
    if (pending.navSteps >= CODEX_MODEL_MAX_NAV_STEPS) {
      this.failCodexModelPicker(pending);
      return;
    }
    const step = codexPickerNavStep(pending.order, pending.byDigit, cursor, pending.target);
    if (!step) {
      this.failCodexModelPicker(pending);
      return;
    }
    // Record the row we moved FROM + the row we expect to land ON, then press one
    // arrow under the write-lock and re-arm the nav window. Scan is reset so the
    // post-press cursor reads clean; the ORDER stays captured (not re-read).
    pending.lastCursor = cursor;
    pending.awaitingCursor = step.expected;
    pending.navSteps += 1;
    this.controlSwitchScan = "";
    this.host.beginSonataWrite();
    this.host.writePty(step.down ? ARROW_DOWN : ARROW_UP);
    this.host.endSonataWrite();
    this.armCodexModelTimeout(CODEX_MODEL_NAV_TIMEOUT_MS);
  }

  /**
   * A per-phase timeout fired: the screen is in a state the choreography can't
   * recognize. RED LINE — roll back with Esc(es) (the ONLY non-navigation bytes we
   * write, and only while a picker is open), then surface needs-attention. NEVER
   * retry, NEVER guess a row.
   */
  private onCodexModelTimeout(): void {
    const pending = this.pendingControlSwitch;
    if (!pending || pending.axis !== "codex-model") {
      return;
    }
    pending.timer = null;
    this.failCodexModelPicker(pending);
  }

  /** Begin the level-appropriate Esc rollback: a level-2 Esc returns to level 1,
   *  so we Esc, verify (on the next repaint) whether a picker footer remains, and
   *  Esc again until the composer is back or the bound is hit — then
   *  needs-attention. */
  private failCodexModelPicker(pending: Extract<PendingControlSwitch, { axis: "codex-model" }>): void {
    this.clearCodexModelTimer(pending);
    pending.phase = "closing";
    this.rollbackCodexModelPicker(pending);
  }

  private rollbackCodexModelPicker(
    pending: Extract<PendingControlSwitch, { axis: "codex-model" }>,
  ): void {
    const pickerOnScreen =
      pending.pickerLevel > 0 || codexModelPickerFooterVisible(this.controlSwitchScan);
    if (pickerOnScreen && pending.rollbackEscs < CODEX_MODEL_MAX_ROLLBACK_ESCS && this.host.hasPty()) {
      this.controlSwitchScan = "";
      this.host.beginSonataWrite();
      this.host.writePty(ESC);
      this.host.endSonataWrite();
      pending.rollbackEscs += 1;
      pending.pickerLevel = Math.max(0, pending.pickerLevel - 1) as 0 | 1 | 2;
      const timer = setTimeout(() => this.onCodexModelCloseVerify(), CODEX_MODEL_CLOSE_VERIFY_MS);
      timer.unref?.();
      pending.timer = timer;
      return;
    }
    // Nothing (more) open, or the Esc bound is hit — conclude. The terminal state
    // is the user's to reconcile in the co-visible Terminal either way.
    this.finishCodexModel("needs-attention", pending);
  }

  /** After a rollback Esc repainted, check whether another level remains open and
   *  Esc again, or conclude needs-attention. */
  private onCodexModelCloseVerify(): void {
    const pending = this.pendingControlSwitch;
    if (!pending || pending.axis !== "codex-model") {
      return;
    }
    pending.timer = null;
    if (process.env.SONATA_DEBUG_COMPLETION) {
      const stillOpen = codexModelPickerFooterVisible(this.controlSwitchScan);
      console.log(
        `[codex-model] rollback Esc #${pending.rollbackEscs} → pickerStillOpen=${stillOpen}`,
      );
    }
    this.rollbackCodexModelPicker(pending);
  }

  private armCodexModelTimeout(ms: number): void {
    const pending = this.pendingControlSwitch;
    if (!pending || pending.axis !== "codex-model") {
      return;
    }
    const timer = setTimeout(() => this.onCodexModelTimeout(), ms);
    timer.unref?.();
    pending.timer = timer;
  }

  private clearCodexModelTimer(
    pending: Extract<PendingControlSwitch, { axis: "codex-model" }>,
  ): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
  }

  /** Resolve a codex model/effort switch. On `settled`, the CONTROLLER writes
   *  task.model + task.reasoningEffort off the receipt fields — codex has no
   *  statusline/hook model mirror, so the picker receipt is the confirmation
   *  channel (the asymmetry vs claude's statusline follow; see runtime-controller
   *  `applyCodexModelSwitchReceipt`). */
  private finishCodexModel(
    phase: "settled" | "needs-attention",
    pending: Extract<PendingControlSwitch, { axis: "codex-model" }>,
    receipt?: { model: string; effort: ReasoningEffort },
  ): void {
    const kind = pending.switchKind;
    const value = pending.value;
    // Our own resolution (a confirm receipt or a completed Esc rollback) already
    // closed the picker; drop pickerLevel so clearPendingControlSwitch's
    // cancellation Esc is a no-op (it only fires for an EXTERNAL mid-picker clear).
    pending.pickerLevel = 0;
    this.clearPendingControlSwitch();
    if (phase === "settled" && receipt) {
      this.emitControlSwitchState("settled", {
        kind,
        value,
        codexModel: receipt.model,
        codexEffort: receipt.effort,
      });
      return;
    }
    this.emitControlSwitchState(phase, {
      kind,
      value,
      ...(pending.attentionReason ? { reason: pending.attentionReason } : {}),
    });
  }

  /**
   * Watch the pty stream for the pending switch's receipt while it is unresolved.
   * value axis (model/effort): the printed receipt line → settled/failed, else
   * wait for the timeout. permission axis: the TUI mode line → hand to the
   * stepping engine. codex-permission axis: hand every frame to the picker state
   * machine. Else wait for the per-phase timeout.
   */
  private detectControlSwitchReceipt(data: string): void {
    const pending = this.pendingControlSwitch;
    if (!pending) {
      return;
    }
    this.controlSwitchScan = (this.controlSwitchScan + data).slice(-CONTROL_SWITCH_SCAN_LIMIT);
    if (pending.axis === "permission") {
      this.onPermissionData(pending);
      return;
    }
    if (pending.axis === "codex-permission") {
      this.onCodexPickerData();
      return;
    }
    if (pending.axis === "codex-model") {
      this.onCodexModelPickerData();
      return;
    }
    if (pending.axis === "parked-confirm") {
      this.onParkedConfirmData();
      return;
    }
    // value axis (model/effort). On a session WITH history, the inject raises the
    // cache-miss confirm dialog (S7) INSTEAD of applying — recognize it and PARK
    // (relay through the drawer) rather than time out to needs-attention. Check the
    // receipt FIRST: on a session without history the switch applies with a clean
    // receipt and no dialog (the rare clean path); a settled receipt beats a stale
    // dialog frame from a prior repaint.
    const verdict = parseClaudeControlReceipt(this.controlSwitchScan, pending.kind);
    if (verdict === "settled") {
      this.settleValueSwitch(pending);
      return;
    }
    if (verdict === "failed") {
      const { kind, value } = pending;
      this.clearPendingControlSwitch();
      const label = kind === "model" ? "model" : "effort level";
      this.emitControlSwitchState("failed", {
        kind,
        value,
        error: `Claude rejected the ${label} "${value}".`,
      });
      return;
    }
    if (claudeCacheMissDialogOpen(this.controlSwitchScan)) {
      this.parkClaudeCacheMiss(pending);
    }
  }

  /** A value-axis (model/effort) switch settled — either a clean receipt or a
   *  relayed Yes through the cache-miss drawer. If a follow-up axis is queued
   *  (the staged Save sequence, Part 1), run it as the same logical switch; else
   *  emit the terminal settled. */
  private settleValueSwitch(
    pending: Extract<PendingControlSwitch, { axis: "value" }>,
  ): void {
    const { kind, value, next } = pending;
    this.clearPendingControlSwitch();
    if (next) {
      // Continue the staged sequence with the second axis — ONE logical switch.
      // The chip stays pending across it (a fresh pending is armed); the cache-miss
      // relay handles a second dialog if it appears (measured: usually the second
      // command applies cleanly, the reread already pending).
      this.writeClaudeValueCommand(next.kind, next.value, null);
      return;
    }
    this.emitControlSwitchState("settled", { kind, value });
  }

  // ── Recognized-confirm drawer relay (S7 parked-confirm) ─────────────────────
  //
  // When a choreography meets a WHITELISTED confirm dialog, Sonata PARKS: it
  // leaves the dialog OPEN in the Terminal, surfaces its rows in the Action
  // Drawer, and injects ONLY the user's chosen row (RED LINE — never auto-answer;
  // the codex trust-dialog silent-Yes lineage). Navigation is by ROW NUMBER
  // (the dialogs number their rows and mark the current one with a cursor glyph),
  // validated against the actual post-press cursor exactly like the codex pickers.

  /** Park a claude cache-miss confirm (`Switch model? / Change effort level?`):
   *  transform the pending value-axis switch into the parked-confirm relay, keeping
   *  the queued `next` (staged sequence) to run only on a Yes. */
  private parkClaudeCacheMiss(pending: Extract<PendingControlSwitch, { axis: "value" }>): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    this.pendingControlSwitch = {
      axis: "parked-confirm",
      dialog: "claude-cachemiss",
      originKind: pending.kind,
      value: pending.value,
      next: pending.next,
      codexTarget: null,
      phase: "waiting-user",
      targetRow: null,
      lastCursor: null,
      awaitingCursor: null,
      navSteps: 0,
      rollbackEscs: 0,
      timer: null,
    };
    this.snapshotParkedFrame();
    this.emitParkedState();
  }

  /** Park the codex Full Access consent (`Enable full access?`): transform the
   *  pending codex-permission switch into the parked-confirm relay. The grant
   *  receipt is `• Permissions updated to Full Access` (codexTarget). */
  private parkCodexConsent(
    pending: Extract<PendingControlSwitch, { axis: "codex-permission" }>,
  ): void {
    this.clearCodexPickerTimer(pending);
    this.pendingControlSwitch = {
      axis: "parked-confirm",
      dialog: "codex-consent",
      originKind: "codex-permission",
      value: "full-access",
      next: null,
      codexTarget: "full-access",
      phase: "waiting-user",
      targetRow: null,
      lastCursor: null,
      awaitingCursor: null,
      navSteps: 0,
      rollbackEscs: 0,
      timer: null,
    };
    // No frame snapshot for codex-consent: its cursor is a GRID read (D-1), and
    // the grid still holds the parked dialog when the drawer answer arrives. Only
    // the rolling scan is reset, so the receipt watcher below cannot be fooled by
    // pre-park text.
    this.controlSwitchScan = "";
    this.emitParkedState();
  }

  /**
   * Snapshot the current frame for the claude relay's first nav cursor read, then
   * RESET the rolling scan (review F2). The parked dialog is static until a key
   * press, so the relay needs the parked cursor, and the claude cache-miss cursor
   * is still a STREAM read — but a retained 4096-char window would keep stale
   * dialog text alive and defeat absence-based detection, so post-park frames must
   * dominate the fresh scan while `driveParkedNav`'s claude branch falls back to
   * this snapshot for the first read.
   */
  private snapshotParkedFrame(): void {
    this.parkedFrame = this.controlSwitchScan;
    this.controlSwitchScan = "";
  }

  private emitParkedState(): void {
    const pending = this.pendingControlSwitch;
    if (!pending || pending.axis !== "parked-confirm") {
      return;
    }
    this.emitControlSwitchState("parked", {
      kind: pending.originKind,
      value: pending.value,
      dialog: pending.dialog,
    });
  }

  /**
   * The user chose a drawer row (1-based CLI row). Begin navigating the dialog's
   * cursor to it (validate-each-press), then Enter. A dismiss maps (in the
   * renderer) to the Cancel row, so this is the ONLY answer channel and it always
   * carries a user-chosen row. Ignored if no parked dialog is waiting (a stale
   * click after the dialog already resolved).
   */
  answerParkedControlConfirm(rowNumber: number): void {
    const pending = this.pendingControlSwitch;
    if (!pending || pending.axis !== "parked-confirm" || pending.phase !== "waiting-user") {
      return;
    }
    const rowCount = PARKED_DIALOG_ROW_COUNT[pending.dialog];
    if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > rowCount) {
      return; // out of range — the renderer only offers valid rows; ignore
    }
    pending.targetRow = rowNumber;
    pending.phase = "navigating";
    pending.navSteps = 0;
    pending.lastCursor = null;
    pending.awaitingCursor = null;
    this.armParkedTimeout(PARKED_CONFIRM_NAV_TIMEOUT_MS);
    // Drive from the CURRENT screen (the dialog is static — no new frame is coming
    // until we press a key): the grid still holds it for codex, the park-time
    // snapshot for claude.
    this.driveParkedNav();
  }

  /**
   * One navigation decision, sourced from whichever substrate the dialog's cursor
   * actually lives on. codex-consent is a SPATIAL read of the GRID (D-1): its rows
   * repaint as a cell diff over the picker they replace, so on the stream the
   * cursor glyph and row digit are simply never transmitted (`1Yes,continueanyway`
   * — measured 0.146.0) and the parser returns null on a dialog that is on screen.
   * The grid also removes the need for a park-time snapshot: it still shows the
   * static dialog when the drawer answer arrives. The claude cache-miss cursor
   * stays on the stream (scan, falling back to the park snapshot for the first
   * read — review F2), which is measured-reliable for it.
   */
  private driveParkedNav(): void {
    const pending = this.pendingControlSwitch;
    if (!pending || pending.axis !== "parked-confirm") {
      return;
    }
    if (pending.dialog === "codex-consent") {
      this.host.readScreen((screen) => this.applyParkedNav(parseCodexConsentCursor(screen)));
      return;
    }
    this.applyParkedNav(parseClaudeCacheMissCursor(this.controlSwitchScan || this.parkedFrame));
  }

  /** Act on the cursor row just read: validate the post-press position, then Enter
   *  on the target row or press ONE arrow toward it. A pre-move repaint waits; an
   *  unexpected jump rolls back (never keep guessing). Re-guards the pending state
   *  because a grid read can land after the relay moved on. */
  private applyParkedNav(cursor: number | null): void {
    const pending = this.pendingControlSwitch;
    if (
      !pending ||
      pending.axis !== "parked-confirm" ||
      pending.phase !== "navigating" ||
      !this.host.hasPty() ||
      pending.targetRow == null
    ) {
      return;
    }
    if (cursor == null) {
      return; // cursor row not recognized yet — wait (the nav timeout guards)
    }
    if (pending.awaitingCursor != null && cursor !== pending.awaitingCursor) {
      if (cursor === pending.lastCursor) {
        return; // pre-move repaint of the row we pressed FROM — keep waiting
      }
      this.failParked(pending); // unexpected jump — roll back
      return;
    }
    pending.awaitingCursor = null;
    this.clearParkedTimer(pending);
    if (cursor === pending.targetRow) {
      this.pressParkedConfirm(pending);
      return;
    }
    if (pending.navSteps >= PARKED_CONFIRM_MAX_NAV_STEPS) {
      this.failParked(pending);
      return;
    }
    const goingDown = pending.targetRow > cursor;
    pending.lastCursor = cursor;
    pending.awaitingCursor = cursor + (goingDown ? 1 : -1);
    pending.navSteps += 1;
    this.controlSwitchScan = "";
    this.host.beginSonataWrite();
    this.host.writePty(goingDown ? ARROW_DOWN : ARROW_UP);
    this.host.endSonataWrite();
    this.armParkedTimeout(PARKED_CONFIRM_NAV_TIMEOUT_MS);
  }

  /** Press Enter on the target row, then enter the settle-watch phase. A codex
   *  Cancel (row 2) is the one row whose outcome is known up front — it returns to
   *  the `/permissions` picker (MEASURED 0.146.0; only `esc` reaches the composer)
   *  — so its Enter is trailed by the one Esc that closes that picker, and the
   *  relay goes straight to the bounded exit watch. Everything else waits for its
   *  receipt (grant / Yes) or `Kept …` (claude No). */
  private pressParkedConfirm(
    pending: Extract<PendingControlSwitch, { axis: "parked-confirm" }>,
  ): void {
    if (!this.host.hasPty()) {
      return;
    }
    const codexCancel =
      pending.dialog === "codex-consent" && pending.targetRow === CODEX_CONSENT_CANCEL_ROW;
    this.controlSwitchScan = "";
    this.host.beginSonataWrite();
    this.host.writePty("\r");
    if (codexCancel) {
      // Deferred under the held write-lock so a human keystroke in the gap buffers
      // rather than splitting the frame — and spaced, so codex processes the
      // consent's Enter (which repaints the picker) before the Esc arrives.
      this.host.deferSonataWrite(
        CODEX_CONSENT_CANCEL_ESC_DELAY_MS,
        () => {
          if (this.host.hasPty()) {
            this.host.writePty(ESC);
          }
        },
        "control",
      );
    }
    this.host.endSonataWrite();
    if (codexCancel) {
      // false: the picker-closing Esc is the deferred one written just above.
      this.beginParkedConsentExit(pending, false);
      return;
    }
    pending.phase = "confirming";
    this.armParkedTimeout(PARKED_CONFIRM_SETTLE_TIMEOUT_MS);
  }

  /** Drive the parked relay off each pty frame (from detectControlSwitchReceipt).
   *  Settle signals fire in `waiting-user` too, so a user who answers NATIVELY in
   *  the co-visible Terminal settles the relay honestly (we never injected). */
  private onParkedConfirmData(): void {
    const pending = this.pendingControlSwitch;
    if (!pending || pending.axis !== "parked-confirm") {
      return;
    }
    const scan = this.controlSwitchScan;

    if (pending.dialog === "claude-cachemiss") {
      const axis = pending.originKind === "effort" ? "effort" : "model";
      if (
        pending.phase === "waiting-user" ||
        pending.phase === "navigating" ||
        pending.phase === "confirming"
      ) {
        if (parseClaudeControlReceipt(scan, axis) === "settled") {
          this.settleParkedClaudeYes(pending);
          return;
        }
        if (claudeCacheMissCancelled(scan, axis)) {
          this.settleParkedCancel(pending);
          return;
        }
      }
      if (pending.phase === "navigating") {
        this.driveParkedNav();
      }
      return;
    }

    // codex-consent. The grant receipt is a TEMPORAL event → stream, and it is
    // checked in every phase that can still see it, INCLUDING `cancel-exit`: a
    // native Yes closes the dialog a beat before `• Permissions updated to Full
    // Access` prints, and reporting that as a cancel would be a lie.
    if (pending.phase !== "closing") {
      if (parseCodexPermissionReceipt(scan) === pending.codexTarget) {
        this.settleParkedCodexYes(pending);
        return;
      }
    }
    if (pending.phase === "waiting-user") {
      // A NATIVE answer (the user Esc'd / chose a row in the co-visible Terminal).
      // "Is the consent still up" is a SPATIAL query → the GRID (D-1), where the
      // dialog's ABSENCE is truthful: the grid converges to the current screen,
      // whereas the stream keeps the consent's bytes forever.
      //
      // The SAME read identifies WHAT the consent left behind, which decides
      // whether anything is owed to the terminal. Esc → the idle composer, nothing
      // to do. Enter on `2. Cancel` → the /permissions picker, still OPEN — and an
      // abandoned codex picker swallows the next typed characters, so a queued
      // prompt would paste into it and its Enter would confirm the highlighted row
      // (the composer kill-line flood does not close a picker). Nothing else in
      // the system closes it either: `clearPendingControlSwitch`'s Esc only covers
      // the codex-permission / codex-model axes, and parking discarded the pending
      // that carried `pickerOpen`. So the relay closes the picker IT opened, on a
      // POSITIVE identification — the same thing the injected-Cancel path does.
      // The grant path can never reach this Esc: a native Yes leaves the composer,
      // never the picker.
      this.host.readScreen((screen) => {
        const current = this.pendingControlSwitch;
        if (
          !current ||
          current.axis !== "parked-confirm" ||
          current.dialog !== "codex-consent" ||
          current.phase !== "waiting-user" ||
          codexPermissionConsentDialogOpen(screen)
        ) {
          return; // still parked on the dialog — keep waiting for the user
        }
        this.beginParkedConsentExit(current, codexPermissionPickerOpen(screen));
      });
      return;
    }
    if (pending.phase === "navigating") {
      this.driveParkedNav();
      return;
    }
    // `cancel-exit` — nothing to drive: the receipt check above can still settle a
    // native Yes, and the verify timer concludes cancelled.
    // `closing` — the fail Esc is in flight; the close-verify timer concludes.
  }

  /**
   * The codex consent is leaving the screen without our grant confirm — either we
   * just Enter'd its Cancel row or the user answered NATIVELY in the co-visible
   * Terminal. Wait one bounded beat and let the evidence decide: a grant receipt
   * still settles Yes (a native Yes closes the dialog a beat before it prints),
   * otherwise the verify timer settles cancelled.
   *
   * `closeReturnedPicker` says whether the /permissions picker is behind the
   * closing consent and must be Esc'd out (its Enter-on-Cancel exit, measured —
   * see CODEX_CONSENT_CANCEL_ESC_DELAY_MS). The two callers know it differently
   * and neither guesses: the INJECTED Cancel has already queued that Esc behind
   * its Enter on measured certainty (so it passes false — a second Esc here would
   * land on the composer), while the NATIVE path has just IDENTIFIED the screen on
   * the grid. Escing an identified screen is what the red line asks for; Escing an
   * unidentified one is what it forbids.
   */
  private beginParkedConsentExit(
    pending: Extract<PendingControlSwitch, { axis: "parked-confirm" }>,
    closeReturnedPicker: boolean,
  ): void {
    this.clearParkedTimer(pending);
    pending.phase = "cancel-exit";
    if (
      closeReturnedPicker &&
      this.host.hasPty() &&
      pending.rollbackEscs < PARKED_CONFIRM_MAX_ROLLBACK_ESCS
    ) {
      this.controlSwitchScan = "";
      this.host.beginSonataWrite();
      this.host.writePty(ESC);
      this.host.endSonataWrite();
      pending.rollbackEscs += 1;
    }
    const timer = setTimeout(() => this.onParkedCancelExitVerify(), PARKED_CONFIRM_CANCEL_VERIFY_MS);
    timer.unref?.();
    pending.timer = timer;
  }

  /** The bounded exit beat elapsed with no grant receipt: the consent closed
   *  without granting, so conclude cancelled — the user chose Cancel (or Esc'd)
   *  and the Terminal is theirs to reconcile either way. */
  private onParkedCancelExitVerify(): void {
    const pending = this.pendingControlSwitch;
    if (!pending || pending.axis !== "parked-confirm") {
      return;
    }
    pending.timer = null;
    this.settleParkedCodexCancel(pending);
  }

  /** claude Yes: the switch applied (receipt landed). Continue a queued `next`
   *  (staged sequence) or emit the terminal settled. */
  private settleParkedClaudeYes(
    pending: Extract<PendingControlSwitch, { axis: "parked-confirm" }>,
  ): void {
    const { originKind, value, next } = pending;
    this.clearPendingControlSwitch();
    if (next) {
      this.writeClaudeValueCommand(next.kind, next.value, null);
      return;
    }
    this.emitControlSwitchState("settled", { kind: originKind, value });
  }

  /** A user-chosen CANCEL (claude No, or a native codex cancel routed here):
   *  nothing changed CLI-side, so NO needs-attention — the chip follows its
   *  unchanged SSOT. Any queued `next` is dropped (the first axis didn't apply). */
  private settleParkedCancel(
    pending: Extract<PendingControlSwitch, { axis: "parked-confirm" }>,
  ): void {
    const { originKind, value } = pending;
    this.clearPendingControlSwitch();
    this.emitControlSwitchState("settled", { kind: originKind, value, cancelled: true });
  }

  /** codex grant (row 1, or a native Yes): the `• Permissions updated to Full
   *  Access` receipt landed — settle; the controller writes task.codexPermissionMode
   *  off this. */
  private settleParkedCodexYes(
    pending: Extract<PendingControlSwitch, { axis: "parked-confirm" }>,
  ): void {
    const target = pending.codexTarget ?? "full-access";
    this.clearPendingControlSwitch();
    this.emitControlSwitchState("settled", { kind: "codex-permission", value: target });
  }

  /** codex Cancel (row 2, or a native Esc/Cancel): the consent closed with no grant
   *  receipt — nothing changed, NO needs-attention (the human chose Cancel).
   *  `cancelled` tells the controller NOT to write the full-access mirror. */
  private settleParkedCodexCancel(
    pending: Extract<PendingControlSwitch, { axis: "parked-confirm" }>,
  ): void {
    const target = pending.codexTarget ?? "full-access";
    this.clearPendingControlSwitch();
    this.emitControlSwitchState("settled", {
      kind: "codex-permission",
      value: target,
      cancelled: true,
    });
  }

  private armParkedTimeout(ms: number): void {
    const pending = this.pendingControlSwitch;
    if (!pending || pending.axis !== "parked-confirm") {
      return;
    }
    const timer = setTimeout(() => this.onParkedTimeout(), ms);
    timer.unref?.();
    pending.timer = timer;
  }

  private clearParkedTimer(
    pending: Extract<PendingControlSwitch, { axis: "parked-confirm" }>,
  ): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
  }

  private onParkedTimeout(): void {
    const pending = this.pendingControlSwitch;
    if (!pending || pending.axis !== "parked-confirm") {
      return;
    }
    pending.timer = null;
    this.failParked(pending);
  }

  /** An ACTIVE phase (navigating / confirming / cancel) got stuck — the screen is
   *  unrecognized. RED LINE: Esc the dialog once (measured clean: claude Esc =
   *  cancel → composer; codex consent Esc → composer, 0.146.0 — it replaced the
   *  picker, so one Esc is the whole stack), verify, then needs-attention. NEVER
   *  retry, NEVER guess a row. (waiting-user has no timeout, so this only fires
   *  after the user has answered.) */
  private failParked(
    pending: Extract<PendingControlSwitch, { axis: "parked-confirm" }>,
  ): void {
    this.clearParkedTimer(pending);
    pending.phase = "closing";
    if (this.host.hasPty() && pending.rollbackEscs < PARKED_CONFIRM_MAX_ROLLBACK_ESCS) {
      this.controlSwitchScan = "";
      this.host.beginSonataWrite();
      this.host.writePty(ESC);
      this.host.endSonataWrite();
      pending.rollbackEscs += 1;
    }
    const timer = setTimeout(() => this.onParkedCloseVerify(), PARKED_CONFIRM_CANCEL_VERIFY_MS);
    timer.unref?.();
    pending.timer = timer;
  }

  private onParkedCloseVerify(): void {
    const pending = this.pendingControlSwitch;
    if (!pending || pending.axis !== "parked-confirm") {
      return;
    }
    pending.timer = null;
    const { originKind, value } = pending;
    const reason: ControlSwitchAttentionReason =
      pending.dialog === "codex-consent" ? "consent" : "interstitial";
    this.clearPendingControlSwitch();
    this.emitControlSwitchState("needs-attention", { kind: originKind, value, reason });
  }

  /**
   * No model/effort receipt arrived in time — the screen is in an unrecognized
   * state (a possible cache-miss confirm or Fable consent interstitial). RED LINE:
   * surface needs-attention and do NOTHING further — no auto-answer, no blind-
   * Enter, no retry. The user resolves it in the co-visible terminal. (Permission
   * steps use their own per-step timeout — `onPermissionStepTimeout`.)
   */
  private onControlSwitchTimeout(): void {
    const pending = this.pendingControlSwitch;
    if (!pending || pending.axis !== "value") {
      return;
    }
    const { kind, value } = pending;
    this.clearPendingControlSwitch();
    // The screen is an unrecognized interstitial (cache-miss confirm / Fable
    // consent) the user must answer natively — the DEFAULT flow on a session with
    // history (S1). Name it so the banner points at the confirm, not the generic
    // "couldn't confirm".
    this.emitControlSwitchState("needs-attention", { kind, value, reason: "interstitial" });
  }

  private clearPendingControlSwitch(): void {
    const pending = this.pendingControlSwitch;
    // Cancelling a codex-permission switch mid-picker (an EXTERNAL clear — a run
    // starting, the PTY tearing down — not our own settle/rollback, which already
    // dropped pickerOpen) must close the picker first: an abandoned codex picker
    // swallows the next typed char (measured), so the next prompt/keystroke would
    // land in the picker instead of the composer. One Esc — the ONLY rollback byte
    // (RED LINE 3) — before we let go. No-op once the picker has closed.
    if (pending?.axis === "codex-permission" && pending.pickerOpen && this.host.hasPty()) {
      try {
        this.host.writePty(ESC);
      } catch {
        // Teardown race — the pty is already gone; nothing to close.
      }
    }
    // Same premise for the codex-model TWO-level picker: an abandoned picker eats
    // the next typed char, so Esc once PER open level (level 2 → level 1 →
    // composer). Screen-blind by design, like the codex-permission case, but now
    // up to TWO Escs — and `pickerLevel` is committed to 2 OPTIMISTICALLY at the
    // level-1 confirm (before the `\r` that opens level 2 has even rendered it). So
    // an external clear (run start / PTY teardown) landing in that window emits
    // ESC×2 while only level 1 is actually open: the first closes it, the SECOND
    // lands on the idle composer (opening codex's edit-previous buffer) or, in a
    // narrow race, interrupts a fresh native run. Same accepted screen-blind family
    // as S3 (rare, recoverable, never submits / burns a turn / auto-answers), now
    // widened from one Esc to two. Our own settle/rollback zeroes pickerLevel, so
    // this only fires for an EXTERNAL mid-picker clear.
    if (pending?.axis === "codex-model" && pending.pickerLevel > 0 && this.host.hasPty()) {
      try {
        this.host.writePty(ESC.repeat(pending.pickerLevel));
      } catch {
        // Teardown race — the pty is already gone; nothing to close.
      }
    }
    if (pending?.timer) {
      clearTimeout(pending.timer);
    }
    this.pendingControlSwitch = null;
    this.controlSwitchScan = "";
    this.parkedFrame = "";
  }

  private emitControlSwitchState(
    phase: "pending" | "parked" | "settled" | "failed" | "needs-attention",
    payload: {
      kind: ClaudeControlSwitchKind;
      value: string;
      error?: string | null;
      observedModes?: ClaudePermissionMode[];
      codexModel?: string | null;
      codexEffort?: ReasoningEffort | null;
      reason?: ControlSwitchAttentionReason;
      /** `parked` ONLY: which recognized dialog is open (the renderer composes the
       *  verbatim drawer rows from this + kind + value). */
      dialog?: "claude-cachemiss" | "codex-consent";
      /** `settled` ONLY: the switch was user-CANCELLED (claude No / codex Cancel) —
       *  nothing changed, so the controller must NOT write any mirror off it. */
      cancelled?: boolean;
    },
  ): void {
    this.host.emitControlSwitchEvent({
      taskId: this.host.taskId,
      kind: payload.kind,
      value: payload.value,
      phase,
      error: payload.error ?? null,
      ...(payload.observedModes ? { observedModes: payload.observedModes } : {}),
      ...(payload.codexModel !== undefined ? { codexModel: payload.codexModel } : {}),
      ...(payload.codexEffort !== undefined ? { codexEffort: payload.codexEffort } : {}),
      ...(payload.reason ? { reason: payload.reason } : {}),
      ...(payload.dialog ? { dialog: payload.dialog } : {}),
      ...(payload.cancelled ? { cancelled: true } : {}),
    });
  }
}
