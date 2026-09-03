import type { CodexOfferedPermissionMode } from "../../shared/types/codex-settings";
import type {
  ClaudePermissionMode,
  ReasoningEffort,
  RuntimeProvider,
  TaskId,
} from "../../shared/types/domain";
import type { ControlSwitchAttentionReason, RuntimeEvent } from "../../shared/types/events";
import type {
  ClaudeControlSwitchKind,
  ClaudeControlSwitchResponse,
} from "../../shared/types/ipc";
import { ARROW_DOWN, ARROW_LEFT, ARROW_RIGHT, ARROW_UP, ESC, SHIFT_TAB } from "./tui-parsers-common";
import {
  asClaudePermissionMode,
  claudeCacheMissCancelled,
  claudeCacheMissDialogOpen,
  claudeEffortPickerOpen,
  claudeModelAliasRow,
  claudeModelPickerOpen,
  claudeModelSwitchMatches,
  CONTROL_SWITCH_SCAN_LIMIT,
  expectedPermissionLandings,
  isClaudePermissionCycleMode,
  parseClaudeCacheMissCursor,
  parseClaudeControlReceipt,
  parseClaudeEffortSlider,
  parseClaudeModelPicker,
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
// The claude session-scoped PICKER drive (D2 U4). Timeouts sized like the codex
// pickers'; `s` is the CLI's own session-only apply key (F15/F16/F89, m2).
const CLAUDE_PICKER_OPEN_TIMEOUT_MS = 6000;
const CLAUDE_PICKER_NAV_TIMEOUT_MS = 2500;
const CLAUDE_PICKER_CLOSE_VERIFY_MS = 700;
/** 5 model rows / 6 effort ticks — the longest direct walk is 5; 8 is the loud bound. */
const CLAUDE_PICKER_MAX_NAV_STEPS = 8;
const CLAUDE_PICKER_MAX_ROLLBACK_ESCS = 2;
const CLAUDE_PICKER_APPLY_KEY = "s";
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
 *  clears (then we conclude needs-attention regardless).
 *
 *  0.152.1 CORRECTION to the premise, not the number (SL-7, q28): the picker is
 *  THREE levels deep, not two. `More reasoning…` opens an `Advanced Reasoning`
 *  submenu (Max / Ultra) whose shared footer keeps `pickerOnScreen` true, and the
 *  MEASURED distance from it back to a composer is exactly three Escs. Sonata's
 *  own choreography never confirms that row (D6), so it cannot build the stack
 *  itself — but a user arrowing onto it inside a picker Sonata opened can, and
 *  the cursor-validation failure that follows lands in this rollback. So 3 is no
 *  longer one Esc of slack over a two-deep stack; it is the exact depth, with
 *  nothing spare. A fourth upstream level would strand a picker open, which is
 *  the state this whole path exists to prevent — treat the number as coupled to
 *  the measured depth and re-check it when the picker's shape moves. */
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
  /** Claude's Rewind restore picker owns the screen — refuse to start a switch.
   *  Every claude switch ends in a deferred `\r`, and on that panel a bare `\r`
   *  IS `Enter to continue`, i.e. a RESTORE. Same class as isApprovalActive,
   *  and it must be checked at the SAME entry points (a user can open the panel
   *  in the CLI and then hit Save on the model chip). One of those entry points
   *  also serves the codex axes; the host's implementation is claude-only, so
   *  this reads permanently false there and the codex paths are unchanged. */
  isRewindPanelOpen(): boolean;
  /**
   * The permission mode the SCREEN is currently showing (claude only; null on
   * codex, and null whenever the footer mode line is not legible).
   *
   * SYNCHRONOUS, unlike `readScreen` below, because its one caller —
   * `startPermissionSwitch` — is a synchronous predicate that must answer
   * "where do I start pressing" before it returns. Sound for the same reason
   * `isRewindPanelOpen` is: per `TaskScreenModel`'s contract a naked read is
   * stale-but-consistent (a complete byte-stream PREFIX, never torn), and the
   * staleness this answer has to survive is a HUMAN's — a mode the user flipped
   * seconds to minutes ago — not one write-drain's worth. The only race left is
   * a native Shift+Tab landing inside the same microtask as the menu click,
   * which degrades to exactly the pre-SL-5 behaviour.
   *
   * Null is a real answer, not an error: the mode-line row is absent for ~1–2s
   * after a Ctrl-C at an idle composer (the hint replaces it — MEASURED, SL-5
   * q17 arm D), and there is no screen model before the pty exists. The caller
   * falls back to its `from` argument there.
   */
  screenPermissionMode(): ClaudePermissionMode | null;
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
      // `claude-picker` (D2 U4) — the SESSION-SCOPED claude model/effort switch.
      // The slash form (`/model X`, `/effort Y`) applied the switch AND wrote the
      // user's durable default (F68: `~/.claude/settings.json`, 3/3 under every
      // launch channel) — the one pollution Sonata caused. The CLI's own
      // session-only affordance is the picker's `s` key ("Set model to X for this
      // session only" / "Set effort level to Y (this session only)", settings
      // byte-unchanged — F89, m2 arms a/b/e/f at 2.1.259). Woody's ruling: ONE
      // drive path — this one — no slash fallback.
      //
      // `/model` is a ROW picker (walk ↑/↓ to the row whose LABEL maps to the
      // alias — `CLAUDE_MODEL_ALIASES`); `/effort` is a SLIDER (←/→ one tick per
      // press, current = the ▲ marker's nearest label). Both read the GRID (D-1:
      // state questions). Phases:
      //   opening    — typed the bare command + Enter; waiting for the picker's
      //                title/footer on the grid (the footer names `s` — the proof
      //                the affordance still exists at this binary).
      //   navigating — stepping one validated arrow at a time toward `target`
      //                (a row label / a tick index), re-reading the cursor after
      //                each press; a pre-move repaint waits, an unexpected jump
      //                rolls back (never keep guessing).
      //   applying   — pressed `s`; waiting on the stream for the cache-miss
      //                dialog (→ PARK, the S7 relay unchanged), the effort receipt
      //                (effort has no hook), or the `PostModelSwitch` hook
      //                (`noteModelSwitchConfirmed` — the model axis's settle since
      //                D2 U3). A native Esc prints `Kept … as` and leaves the
      //                picker closed — believed only once the grid agrees.
      //   closing    — a failure fired the rollback Esc; verifying the picker
      //                closed, then `failed` (a named cause) or needs-attention.
      // Measured shapes the drive rests on (m2): no arming window (arrow at +0ms
      // registers); `s` on the row that is ALREADY current fires nothing at all
      // (arm c) — so a target marked ✔ settles as a no-op after an Esc; a target
      // with NO row (plain `opus`: the picker's only Opus row is 1M) fails loud
      // with a named error rather than walking the list.
      axis: "claude-picker";
      kind: "model" | "effort";
      value: string;
      /** The staged Save's queued second axis (`effort` after `model`), run as ONE
       *  logical switch after THIS one settles; dropped on failure/cancel. */
      next: { kind: "effort"; value: string } | null;
      phase: "opening" | "navigating" | "applying" | "closing";
      /** The picker was seen open on the grid — gates the rollback/cancellation
       *  Esc (an abandoned picker eats the next keystroke, and Enter on it is a
       *  PERSISTED switch: m2's own run1 hit exactly that). */
      pickerOpen: boolean;
      /** model: the target row LABEL; effort: the target tick INDEX. */
      target: string | number | null;
      lastCursor: string | number | null;
      awaitingCursor: string | number | null;
      navSteps: number;
      rollbackEscs: number;
      /** `drift` = the alias's row/tick is absent from the live picker. */
      attentionReason: ControlSwitchAttentionReason | null;
      /** A NAMED failure to report as `failed` (vs the generic needs-attention). */
      failError: string | null;
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
      /** OFFERED-typed on every axis below: a target is a picker ROW to walk to,
       *  and the cursor rows are the three the picker paints. Codex's cycle-only
       *  `read-only` mode is nameable but has neither, so the type keeps it out
       *  of the choreography rather than a convention doing it (SL-17). */
      target: CodexOfferedPermissionMode;
      phase: "opening" | "navigating" | "confirming" | "closing";
      pickerOpen: boolean;
      /** The cursor row we last acted from (to recognize a pre-move repaint). */
      lastCursor: CodexOfferedPermissionMode | null;
      /** The row the last arrow press is expected to move the cursor to. */
      awaitingCursor: CodexOfferedPermissionMode | null;
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
      //   cancel-exit  — the dialog left the screen without our own confirm, and
      //                  the deciding evidence is one bounded beat away. BOTH
      //                  dialogs use it now, for the same ambiguity. codex: the
      //                  consent closed (we Enter'd its Cancel row, its closing Esc
      //                  already queued, or the user answered natively) and a
      //                  native Yes's grant receipt can still arrive a beat later.
      //                  claude (since D2 U3): a `Kept …` line AND the dialog's
      //                  absence from the grid have both gone true, and a
      //                  `PostModelSwitch` for a Yes can still arrive — because a
      //                  Yes's own banner repaint is what may have replayed that
      //                  `Kept …` line into the window in the first place. Either
      //                  way the verify timer settles cancelled only if nothing
      //                  came.
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
      /** claude-cachemiss ONLY (D2 U4): the dialog was raised by the PICKER's `s`,
       *  not a slash. MEASURED (m2 arm d): a No / Esc on that dialog returns to the
       *  PICKER, still open — so the cancel paths must Esc it once more, exactly
       *  the codex consent's Enter-on-Cancel shape. False for a slash-raised
       *  dialog (no production path raises one any more; kept for the type). */
      fromPicker: boolean;
      /** codex-consent ONLY: the mode the grant receipt confirms (full-access). */
      codexTarget: CodexOfferedPermissionMode | null;
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
  // the scan (native-cancel/receipt detection see fresh content), while the nav
  // read taken BEFORE the relay has pressed anything falls back to this snapshot
  // for the retained cursor. Every read AFTER a press must come from post-press
  // evidence, never from here (see `driveParkedNav`).
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

  /**
   * A `PostModelSwitch` hook arrived for this task: the CLI is declaring, in a
   * structured payload, that a model switch COMPLETED. `requestedModel` is the
   * payload's `requested_model` — the alias the switch asked for.
   *
   * THIS IS THE MODEL AXIS'S CONFIRM (D2 U3). It replaces the `Set model to …`
   * stream needle, which could not be anchored on the pending value and therefore
   * settled switches it did not belong to (the KNOWN RESIDUAL, F19 — reproduced on
   * 2.1.258 in `h4-model-switch-hooks.capture.txt`). The hook can be anchored:
   * `requested_model` is measured byte-for-byte equal to the alias Sonata typed,
   * across the whole `MODEL_OPTIONS` set INCLUDING the bracketed `opus[1m]`, and
   * identical whether the switch was driven by the slash command (`source:
   * "command"`) or by the CLI's own picker (`source: "picker"`).
   *
   * MATCHED ON `requested_model` AND NOTHING ELSE, which is a measured choice, not
   * a preference. `to_model` looks like the stronger key and is not: h4 measured a
   * SECOND `PreModelSwitch` firing 62–64ms behind the first for the same switch,
   * same session, same prompt, carrying a DIFFERENT `to_model`
   * (`claude-sonnet-5` while `requested_model` stayed `haiku`) and double the cost
   * estimate — 6 of 6 legs whose target was `haiku`, 0 of the 4 legs that targeted
   * a different model and fired a `Pre` at all. Across every one of those the
   * requested alias never moved. So the alias is the invariant and
   * the canonical id is not, which also corrects F35's "byte-identical duplicate".
   *
   * BOTH PHASES, because a model switch can be waiting in either. In the VALUE
   * phase (no dialog — a session with no history, or a second switch in a row) this
   * is the whole confirm. In the PARKED phase it is the honest settle for a Yes,
   * INCLUDING a Yes the user pressed themselves in the co-visible Terminal: the
   * hook fires off the CLI's own decision, not off our keystroke (measured — a
   * parked Post lands 66–92ms after the dialog is answered, whoever answered it).
   *
   * IDEMPOTENT BY CONSTRUCTION rather than by a flag. Every settle path clears
   * `pendingControlSwitch` first, so a duplicate Post finds nothing pending and
   * returns; a Post naming a different alias fails the equality test; a Post for a
   * model while the pending switch is the EFFORT leg of a staged Save fails the
   * axis test. None of those needs remembered state.
   */
  noteModelSwitchConfirmed(requestedModel: string, toModel: string | null = null): void {
    const pending = this.pendingControlSwitch;
    if (!pending) {
      return; // no switch in flight — a native switch we did not drive; nothing to settle
    }
    if (pending.axis === "claude-picker") {
      if (pending.kind !== "model") {
        return; // the EFFORT leg of a staged Save — a model hook cannot settle it
      }
      if (pending.phase !== "applying") {
        return; // a Post can only follow our `s`; anything else is not ours to settle
      }
      // Alias OR the measured picker `requested_model` form OR `to_model` against
      // the canonical id (D2 U4: the Fable row reports `claude-fable-5-1[1m]`, m2
      // arm a) — never `to_model` from a Pre, whose second copy drifts (F84).
      if (!claudeModelSwitchMatches(pending.value, requestedModel, toModel)) {
        this.debugForeignModelSwitch(requestedModel, pending.value);
        return;
      }
      this.settleClaudePicker(pending);
      return;
    }
    if (
      pending.axis !== "parked-confirm" ||
      pending.dialog !== "claude-cachemiss" ||
      pending.originKind !== "model"
    ) {
      return;
    }
    if (!claudeModelSwitchMatches(pending.value, requestedModel, toModel)) {
      this.debugForeignModelSwitch(requestedModel, pending.value);
      return;
    }
    if (
      // The three phases the receipt watcher accepts a settle in, PLUS
      // `cancel-exit` — the bounded beat opened when both cancel terms went true,
      // which exists precisely so a Post still in flight can win it
      // (`beginParkedModelCancelExit`). `closing` stays excluded for the same
      // reason it always was: a rollback Esc is in flight and the relay has
      // committed to needs-attention.
      pending.phase === "waiting-user" ||
      pending.phase === "navigating" ||
      pending.phase === "confirming" ||
      pending.phase === "cancel-exit"
    ) {
      this.settleParkedClaudeYes(pending);
    }
  }

  /**
   * A `PostModelSwitch` named an alias that is not the one in flight. Ignored —
   * never guess — but worth a diag line, because it is the fingerprint of a real
   * situation rather than noise: someone switched the model to something else
   * while Sonata's own switch was still pending (most plausibly the user, in the
   * co-visible Terminal). Env-gated and inert by default, the same discipline as
   * `TerminalHost.debugCompletion`, so it costs a shipped session nothing and a
   * unit test no output.
   */
  private debugForeignModelSwitch(requested: string, pending: string): void {
    if (process.env.SONATA_DEBUG_COMPLETION) {
      console.log(
        `[control-switch] ${new Date().toISOString()} task=${this.host.taskId} PostModelSwitch requested="${requested}" ignored — pending switch asked for "${pending}"`,
      );
    }
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
    if (this.host.isApprovalActive() || this.host.isRewindPanelOpen()) {
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

    // Single-axis claude model/effort switch: the session-scoped picker drive
    // (D2 U4), no queued follow-up. The staged Save sequence (Part 1) uses
    // startClaudeStagedSwitch, which threads a `next` through the same starter.
    this.startClaudePicker(kind, value, null);
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
    if (this.host.isApprovalActive() || this.host.isRewindPanelOpen()) {
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
      this.startClaudePicker("model", model, effort ? { kind: "effort", value: effort } : null);
    } else {
      // Only effort changed — single picker.
      this.startClaudePicker("effort", effort as string, null);
    }
    return { ok: true };
  }

  /**
   * Start the session-scoped claude picker drive (D2 U4): type the bare `/model`
   * or `/effort`, defer the Enter under the write-lock, and wait for the picker on
   * the grid. Shared by the single-axis inject, the staged Save sequence, and the
   * parked cache-miss Yes continuation. `next` is a queued follow-up (run after
   * this settles).
   */
  private startClaudePicker(
    kind: "model" | "effort",
    value: string,
    next: { kind: "effort"; value: string } | null,
  ): void {
    if (!this.host.hasPty()) {
      return;
    }
    this.controlSwitchScan = "";
    this.pendingControlSwitch = {
      axis: "claude-picker",
      kind,
      value,
      next,
      phase: "opening",
      pickerOpen: false,
      target: null,
      lastCursor: null,
      awaitingCursor: null,
      navSteps: 0,
      rollbackEscs: 0,
      attentionReason: null,
      failError: null,
      timer: null,
    };
    this.emitControlSwitchState("pending", { kind, value });
    this.host.beginSonataWrite();
    // Clear the composer line UNCONDITIONALLY before the command lands (RED LINE 1):
    // `<prefix>/model` would submit as a chat prompt. Screen-blind-safe.
    this.host.clearComposerBeforeTypedCommand();
    // Typed text, NOT bracketed paste; raw `\r` submits the slash path in both
    // input modes (the S1 measurement still holds for the bare command).
    this.host.writePty(kind === "model" ? "/model" : "/effort");
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
    this.armClaudePickerTimeout(CLAUDE_PICKER_OPEN_TIMEOUT_MS);
  }

  private claudePickerOnScreen(kind: "model" | "effort", screen: string): boolean {
    return kind === "model" ? claudeModelPickerOpen(screen) : claudeEffortPickerOpen(screen);
  }

  /** Drive the picker state machine off a fresh pty frame (from
   *  detectControlSwitchReceipt while a claude-picker switch is unresolved). The
   *  opening/navigating phases are GRID reads (the picker is state); the applying
   *  phase watches the STREAM (the dialog, the receipt, the `Kept …` line are
   *  events) — plus the hook, which arrives through `noteModelSwitchConfirmed`. */
  private onClaudePickerData(): void {
    const pending = this.pendingControlSwitch;
    if (!pending || pending.axis !== "claude-picker") {
      return;
    }
    if (pending.phase === "opening" || pending.phase === "navigating") {
      this.host.readScreen((screen) => this.applyClaudePickerScreen(screen));
      return;
    }
    if (pending.phase !== "applying") {
      return; // closing — the close-verify chain owns the conclusion
    }
    // A session with history raises the cache-miss confirm on `s` too (MEASURED,
    // F89 + m2 arms a/f) — PARK and relay it through the drawer, unchanged S7.
    if (claudeCacheMissDialogOpen(this.controlSwitchScan)) {
      this.parkClaudeCacheMiss(pending);
      return;
    }
    if (pending.kind === "effort") {
      // Effort has no hook (F88, m2 arm e1): the receipt is its settle. The
      // session-only receipt `Set effort level to <x> (this session only): …` is
      // covered by the same success needle as the slash form.
      const verdict = parseClaudeControlReceipt(this.controlSwitchScan, "effort", pending.value);
      if (verdict === "settled") {
        this.settleClaudePicker(pending);
        return;
      }
      if (verdict === "failed") {
        pending.failError = `Claude rejected the effort level "${pending.value}".`;
        this.finishClaudePickerFailure(pending);
        return;
      }
    }
    if (claudeCacheMissCancelled(this.controlSwitchScan, pending.kind)) {
      // `Kept … as` — a native Esc on the picker (m2 arm d). The stream can replay
      // an old one (F19), so it is believed only once the grid shows no picker.
      this.host.readScreen((screen) => {
        const current = this.pendingControlSwitch;
        if (!current || current.axis !== "claude-picker" || current.phase !== "applying") {
          return;
        }
        if (!this.claudePickerOnScreen(current.kind, screen)) {
          const { kind, value } = current;
          current.pickerOpen = false;
          this.clearPendingControlSwitch();
          this.emitControlSwitchState("settled", { kind, value, cancelled: true });
        }
      });
    }
  }

  /** One grid read of the picker: resolve the target on the opening frame, then
   *  validate the post-press cursor and decide the next move. Re-guards the
   *  pending state because a grid read can land after the switch moved on. */
  private applyClaudePickerScreen(screen: string): void {
    const pending = this.pendingControlSwitch;
    if (
      !pending ||
      pending.axis !== "claude-picker" ||
      !this.host.hasPty() ||
      (pending.phase !== "opening" && pending.phase !== "navigating")
    ) {
      return;
    }
    if (!this.claudePickerOnScreen(pending.kind, screen)) {
      return; // not painted yet — wait (the open timeout Escs if it never comes)
    }
    pending.pickerOpen = true;
    let cursor: string | number | null;
    let order: string[] | null = null;
    if (pending.kind === "model") {
      const picker = parseClaudeModelPicker(screen);
      cursor = picker.focused;
      order = picker.rows.map((row) => row.label);
      if (pending.phase === "opening") {
        const alias = claudeModelAliasRow(pending.value);
        if (!alias) {
          pending.failError = `Claude's model picker has no row for "${pending.value}".`;
          this.failClaudePicker(pending);
          return;
        }
        if (!alias.pickerRow) {
          // MEASURED (m2 arm a): the picker's only Opus row is `Opus (1M context)`;
          // plain `opus` (200K) cannot be reached session-scoped. Named, not walked.
          pending.failError = `Claude's model picker has no row for ${alias.display}; start a new chat with it instead.`;
          this.failClaudePicker(pending);
          return;
        }
        const target = picker.rows.find((row) => row.label === alias.pickerRow);
        if (!target) {
          pending.attentionReason = "drift"; // the row table drifted from the live picker
          this.failClaudePicker(pending);
          return;
        }
        if (target.current) {
          // Already the session's model: `s` on it fires nothing (m2 arm c). Esc the
          // identified picker and settle as a no-op — the SSOT is already there.
          this.closeClaudePickerAndSettle(pending);
          return;
        }
        pending.target = target.label;
        pending.phase = "navigating";
        this.clearClaudePickerTimer(pending);
      }
    } else {
      const slider = parseClaudeEffortSlider(screen);
      cursor = slider.currentIndex;
      if (pending.phase === "opening") {
        if (slider.levels.length === 0 || slider.currentIndex === null) {
          return; // marker/labels not legible yet — wait
        }
        const index = slider.levels.indexOf(pending.value);
        if (index < 0) {
          pending.attentionReason = "drift"; // the tier is not on the live slider
          this.failClaudePicker(pending);
          return;
        }
        if (slider.currentIndex === index) {
          this.closeClaudePickerAndSettle(pending);
          return;
        }
        pending.target = index;
        pending.phase = "navigating";
        this.clearClaudePickerTimer(pending);
      }
    }
    this.advanceClaudePickerNav(cursor, order);
  }

  /** Validate the post-arrow cursor, then press `s` on the target or ONE validated
   *  arrow toward it. Bounded by the nav cap → Esc-rollback. */
  private advanceClaudePickerNav(cursor: string | number | null, order: string[] | null): void {
    const pending = this.pendingControlSwitch;
    if (
      !pending ||
      pending.axis !== "claude-picker" ||
      pending.phase !== "navigating" ||
      pending.target === null ||
      !this.host.hasPty()
    ) {
      return;
    }
    if (cursor === null) {
      return; // cursor not legible yet — wait (nav timeout guards)
    }
    if (pending.awaitingCursor !== null && cursor !== pending.awaitingCursor) {
      if (cursor === pending.lastCursor) {
        return; // pre-move repaint of where we pressed FROM — keep waiting
      }
      this.failClaudePicker(pending); // unexpected jump — roll back, never guess
      return;
    }
    pending.awaitingCursor = null;
    this.clearClaudePickerTimer(pending);
    if (cursor === pending.target) {
      this.pressClaudePickerApply(pending);
      return;
    }
    if (pending.navSteps >= CLAUDE_PICKER_MAX_NAV_STEPS) {
      this.failClaudePicker(pending);
      return;
    }
    let key: string;
    let expected: string | number;
    if (pending.kind === "model") {
      if (!order || typeof cursor !== "string" || typeof pending.target !== "string") {
        this.failClaudePicker(pending);
        return;
      }
      const current = order.indexOf(cursor);
      const wanted = order.indexOf(pending.target);
      if (current < 0 || wanted < 0) {
        this.failClaudePicker(pending);
        return;
      }
      const down = wanted > current;
      key = down ? ARROW_DOWN : ARROW_UP;
      expected = order[current + (down ? 1 : -1)] ?? pending.target;
    } else {
      if (typeof cursor !== "number" || typeof pending.target !== "number") {
        this.failClaudePicker(pending);
        return;
      }
      const right = pending.target > cursor;
      key = right ? ARROW_RIGHT : ARROW_LEFT;
      expected = cursor + (right ? 1 : -1);
    }
    pending.lastCursor = cursor;
    pending.awaitingCursor = expected;
    pending.navSteps += 1;
    this.controlSwitchScan = "";
    this.host.beginSonataWrite();
    this.host.writePty(key);
    this.host.endSonataWrite();
    this.armClaudePickerTimeout(CLAUDE_PICKER_NAV_TIMEOUT_MS);
  }

  /** The cursor is on the target: press `s` (session only) and watch the stream /
   *  hook for the outcome. `s` closes the picker on apply (MEASURED); pickerOpen
   *  stays true until a settle so an EXTERNAL clear mid-apply still Escs a picker
   *  that may not have closed. */
  private pressClaudePickerApply(
    pending: Extract<PendingControlSwitch, { axis: "claude-picker" }>,
  ): void {
    pending.phase = "applying";
    this.controlSwitchScan = "";
    this.host.beginSonataWrite();
    this.host.writePty(CLAUDE_PICKER_APPLY_KEY);
    this.host.endSonataWrite();
    this.armClaudePickerTimeout(CONTROL_SWITCH_RECEIPT_TIMEOUT_MS);
  }

  /** The target is already current — nothing to switch. Esc the picker we have
   *  just IDENTIFIED on the grid (red-line compliant: never a blind Esc) and settle
   *  honestly; the chip follows its unchanged SSOT. */
  private closeClaudePickerAndSettle(
    pending: Extract<PendingControlSwitch, { axis: "claude-picker" }>,
  ): void {
    this.clearClaudePickerTimer(pending);
    this.host.beginSonataWrite();
    this.host.writePty(ESC);
    this.host.endSonataWrite();
    pending.pickerOpen = false;
    this.settleClaudePicker(pending);
  }

  /** A picker switch settled (hook / effort receipt / no-op). Continue a queued
   *  `next` (staged Save) as the same logical switch, else emit settled. */
  private settleClaudePicker(
    pending: Extract<PendingControlSwitch, { axis: "claude-picker" }>,
  ): void {
    const { kind, value, next } = pending;
    pending.pickerOpen = false;
    this.clearPendingControlSwitch();
    if (next) {
      this.startClaudePicker(next.kind, next.value, null);
      return;
    }
    this.emitControlSwitchState("settled", { kind, value });
  }

  /** Roll back: Esc the picker if it is (or may be) open, verify on the next
   *  repaint, then conclude `failed` (named) or needs-attention. NEVER retry,
   *  NEVER guess a row — Enter on this picker is a PERSISTED switch. */
  private failClaudePicker(
    pending: Extract<PendingControlSwitch, { axis: "claude-picker" }>,
  ): void {
    this.clearClaudePickerTimer(pending);
    pending.phase = "closing";
    // Every rollback Esc is GRID-verified, the first one included: a user who
    // Esc'd the picker natively mid-walk has already closed it, and an Esc on the
    // idle composer is the blind key the red line forbids. Read, then decide.
    this.host.readScreen((screen) => {
      const current = this.pendingControlSwitch;
      if (!current || current.axis !== "claude-picker" || current.phase !== "closing") {
        return;
      }
      current.pickerOpen = this.claudePickerOnScreen(current.kind, screen);
      this.rollbackClaudePicker(current);
    });
  }

  private rollbackClaudePicker(
    pending: Extract<PendingControlSwitch, { axis: "claude-picker" }>,
  ): void {
    if (pending.pickerOpen && pending.rollbackEscs < CLAUDE_PICKER_MAX_ROLLBACK_ESCS && this.host.hasPty()) {
      this.controlSwitchScan = "";
      this.host.beginSonataWrite();
      this.host.writePty(ESC);
      this.host.endSonataWrite();
      pending.rollbackEscs += 1;
      const timer = setTimeout(() => this.onClaudePickerCloseVerify(), CLAUDE_PICKER_CLOSE_VERIFY_MS);
      timer.unref?.();
      pending.timer = timer;
      return;
    }
    this.finishClaudePickerFailure(pending);
  }

  private onClaudePickerCloseVerify(): void {
    const pending = this.pendingControlSwitch;
    if (!pending || pending.axis !== "claude-picker") {
      return;
    }
    pending.timer = null;
    this.host.readScreen((screen) => {
      const current = this.pendingControlSwitch;
      if (!current || current.axis !== "claude-picker" || current.phase !== "closing") {
        return;
      }
      current.pickerOpen = this.claudePickerOnScreen(current.kind, screen);
      this.rollbackClaudePicker(current);
    });
  }

  private finishClaudePickerFailure(
    pending: Extract<PendingControlSwitch, { axis: "claude-picker" }>,
  ): void {
    const { kind, value, failError, attentionReason } = pending;
    pending.pickerOpen = false;
    this.clearPendingControlSwitch();
    if (failError) {
      this.emitControlSwitchState("failed", { kind, value, error: failError });
      return;
    }
    this.emitControlSwitchState("needs-attention", {
      kind,
      value,
      reason: attentionReason ?? "interstitial",
    });
  }

  /** A per-phase timeout fired. Opening/navigating: the picker is in a state the
   *  choreography cannot read — roll back. Applying: `s` was pressed and neither
   *  the dialog, the receipt nor the hook arrived — an unrecognized interstitial
   *  the user must resolve natively; NOTHING further is written (the S1 rule:
   *  no auto-answer, no blind key). */
  private onClaudePickerTimeout(): void {
    const pending = this.pendingControlSwitch;
    if (!pending || pending.axis !== "claude-picker") {
      return;
    }
    pending.timer = null;
    if (pending.phase === "applying") {
      const { kind, value } = pending;
      pending.pickerOpen = false;
      this.clearPendingControlSwitch();
      this.emitControlSwitchState("needs-attention", { kind, value, reason: "interstitial" });
      return;
    }
    this.failClaudePicker(pending);
  }

  private armClaudePickerTimeout(ms: number): void {
    const pending = this.pendingControlSwitch;
    if (!pending || pending.axis !== "claude-picker") {
      return;
    }
    const timer = setTimeout(() => this.onClaudePickerTimeout(), ms);
    timer.unref?.();
    pending.timer = timer;
  }

  private clearClaudePickerTimer(
    pending: Extract<PendingControlSwitch, { axis: "claude-picker" }>,
  ): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
  }

  /**
   * Begin a permission switch via the Shift+Tab stepping engine (S2). We can't
   * jump to a mode — there is no arg form — so we press Shift+Tab (`\x1b[Z`) one
   * step at a time and read the TUI mode line to learn where we landed, repeating
   * until the target is confirmed. `origin` is where we return to if the target
   * proves unreachable: a Shift+Tab abort is a STATE CHANGE (unlike Esc, you
   * cannot back out of it), so we must land the session somewhere honest, not
   * strand it.
   *
   * THE ORIGIN COMES OFF THE SCREEN, not off the caller's `from` (SL-5). `from`
   * is `task.permissionMode` (renderer/main.ts) — the hook-payload mirror, which
   * `applyHookPermissionMode` reconciles LAZILY. SL-5 q18 arm G measured how
   * lazily: a mode change Sonata did not drive (the user's own Shift+Tab in the
   * Terminal pane; a server-side or Remote-Control flip) fires NO hook at all —
   * 65s of watched silence, corrected only by the next turn's
   * `UserPromptSubmit`. A user who flips natively and then picks a mode from the
   * access chip hands us a `from` the CLI left minutes ago.
   *
   * What that cost, MEASURED on this engine before the fix (q19, pre): a stale
   * `from` anchors `pressedFrom` on a mode the CLI is not in, so the FIRST real
   * landing is a non-successor and fails loud; return-home re-anchors on the
   * same stale value and fails again; the walk only terminates when the cycle
   * happens to deliver the stale origin back. Ground truth for
   * `default`-while-actually-`acceptEdits`, target `plan`: **7 mode changes**,
   * `needs-attention`, and the session left in `default` — neither the target
   * nor where it started. Asking for the mode you are ALREADY in (q19 h3) had
   * the same 7-press shape and moved the session OFF it.
   *
   * "Which mode am I in" is a STATE query, and D-1's standing rule puts state on
   * the GRID. `screenPermissionMode()` reads the footer mode line off the
   * settled viewport with the same shared parser the step receipts use. When it
   * cannot answer — no screen model, or the ~1–2s window where a Ctrl-C hint
   * REPLACES the mode-line row (q17 arm D) — we fall back to the caller's `from`
   * exactly as before, so the degradation is today's behaviour, not a new one.
   * Falls back to `default` (Manual — the cycle anchor, always a member) when
   * neither channel knows.
   *
   * This does NOT move the permission SSOT (contract §2): the mirror is still
   * the hook payload, and a settled switch still writes nothing to
   * `task.permissionMode`. The screen read decides only where THIS choreography
   * starts pressing — a receipt-side question, which is the mode line's job.
   */
  private startPermissionSwitch(value: string, from?: string): ClaudeControlSwitchResponse {
    const target = asClaudePermissionMode(value);
    if (!target) {
      // The renderer only offers reachable ClaudePermissionMode ids; a non-mode
      // value is a caller bug, not a screen state — refuse without touching the pty.
      return { ok: false, reason: "invalid" };
    }
    const origin = this.host.screenPermissionMode() ?? asClaudePermissionMode(from) ?? "default";
    if (target === origin) {
      // Already there — nothing to step. Report settled so the pending affordance
      // never appears. No longer merely defensive now that `origin` comes off the
      // screen: q19 arm h3 measured this exact shape (a native flip landed on the
      // very mode the user then picked) driving SEVEN presses off the target and
      // reporting needs-attention, because the old check compared the target
      // against a stale mirror value instead of against the session.
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
   *  raise needs-attention; otherwise keep stepping toward it.
   *
   *  An origin the CYCLE CANNOT REACH is a third case, and the honest answer
   *  there is to stop pressing (SL-5). `dontAsk` was MEASURED unreachable at
   *  2.1.258 — eight presses from a `dontAsk` session walk the four cycle
   *  members twice and never return (q18 arm E) — and `bypassPermissions` never
   *  paints a composer to step from at all. Walking the return cap for one of
   *  those is `PERMISSION_MAX_RETURN_STEPS` further mode changes that provably
   *  cannot arrive, which is the blind-press ladder this engine's RED LINE
   *  exists to forbid; it also ends the session in an arbitrary cycle mode
   *  rather than a bounded one. So: stop where we are and raise needs-attention
   *  immediately. The session is left somewhere the user can see (the CLI's own
   *  footer names it) and the hook SSOT reconciles the display on the next turn
   *  — the same reconcile every other terminal phase relies on. */
  private beginPermissionReturn(
    pending: Extract<PendingControlSwitch, { axis: "permission" }>,
  ): void {
    pending.phase = "returning";
    if (pending.landed === pending.origin) {
      this.finishPermissionSwitch("needs-attention", pending);
      return;
    }
    if (!isClaudePermissionCycleMode(pending.origin)) {
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
  private decideCodexNav(cursor: CodexOfferedPermissionMode): void {
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
    // claude-picker (D2 U4) — the session-scoped model/effort drive.
    if (pending.axis === "claude-picker") {
      this.onClaudePickerData();
    }
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
  private parkClaudeCacheMiss(
    pending: Extract<PendingControlSwitch, { axis: "claude-picker" }>,
  ): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    // `s` raised the dialog; the picker is behind it (a No/Esc returns there —
    // m2 arm d), so the relay carries `fromPicker` for its cancel exits.
    this.pendingControlSwitch = {
      axis: "parked-confirm",
      dialog: "claude-cachemiss",
      originKind: pending.kind,
      value: pending.value,
      next: pending.next,
      fromPicker: true,
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
      fromPicker: false,
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
   * this snapshot whenever the fresh scan carries NO cursor row of its own.
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
   * stays on the stream (scan, falling back to the park snapshot — review F2),
   * which is measured-reliable for it.
   *
   * That claude fallback keys on a PARSE MISS, not on a byte-empty scan (B5): a
   * dialog painted across chunks leaves the cursor row in the snapshot while the
   * post-park scan holds only the paint's cursor-less trailing bytes. Preferring a
   * non-empty scan there reads null on a dialog that IS on screen — and the parked
   * dialog is static, so no repaint ever corrects it: the nav timeout fires and
   * `failParked` Escs the dialog the user just answered (dropping a staged Save's
   * queued effort leg with it).
   *
   * The snapshot is consulted ONLY while `awaitingCursor` is null — i.e. before
   * the relay has pressed anything — because that is the whole span in which it
   * still describes the screen. This is the validate-each-press rule the engine
   * already lives by (3a: a stale pre-press frame is never a press's receipt): a
   * post-press position must be established by post-press evidence, so once an
   * arrow is on the wire the scan is the only admissible source and a cursor-less
   * frame means WAIT. Ungated, the stale snapshot could equal `awaitingCursor`
   * (the user moved the cursor natively between park and answer, so the relay
   * pressed AWAY from the snapshot's row) and be read as the landing on a frame
   * that is actually the dialog CLOSING — a native answer in the co-visible
   * Terminal, whose close repaint arrives cursor-less before its `Kept …` line.
   * The Enter would then land on the composer and submit whatever sits there.
   * The scan-first order matters for the same reason: a native move during the
   * park is post-park truth and must outrank the snapshot's retained cursor.
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
    const scanCursor = parseClaudeCacheMissCursor(this.controlSwitchScan);
    const prePress = pending.awaitingCursor == null;
    this.applyParkedNav(
      scanCursor ?? (prePress ? parseClaudeCacheMissCursor(this.parkedFrame) : null),
    );
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
   *  receipt (grant / Yes) or `Kept …` (claude No).
   *
   *  RE-DRIVEN at codex 0.152.1 (SL-7, q29 — both exits taken from their own
   *  freshly opened picker). The ASYMMETRY this trailing Esc exists for still
   *  holds exactly: `esc` on the consent lands on the idle COMPOSER (picker gone,
   *  `acceptsPromptInput` true), while Enter on `2. Cancel` lands back on the
   *  STILL-OPEN `/permissions` picker — header and footer up, no receipt printed,
   *  and the cursor RESET to row 1 (`Ask for approval`) rather than left on the
   *  Full Access row it came from. The reset is harmless here (this path Escs the
   *  picker away rather than navigating it), but it is the kind of detail a
   *  future "just re-confirm the row" shortcut would trip over. */
  private pressParkedConfirm(
    pending: Extract<PendingControlSwitch, { axis: "parked-confirm" }>,
  ): void {
    if (!this.host.hasPty()) {
      return;
    }
    const codexCancel =
      pending.dialog === "codex-consent" && pending.targetRow === CODEX_CONSENT_CANCEL_ROW;
    // claude No on a PICKER-raised dialog (D2 U4): Enter on `2. No, go back` returns
    // to the still-open picker (MEASURED m2 arm d, `pickerOpenAfterAnswer: true`),
    // so the injected No is trailed by the one Esc that closes it — the codex
    // Cancel's shape, for the same measured reason.
    const claudePickerNo =
      pending.dialog === "claude-cachemiss" && pending.fromPicker && pending.targetRow === 2;
    this.controlSwitchScan = "";
    this.host.beginSonataWrite();
    this.host.writePty("\r");
    if (codexCancel || claudePickerNo) {
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
    if (claudePickerNo) {
      // The `Kept … as` line + the bounded beat conclude cancelled; the deferred
      // Esc above closes the returned picker. A Post cannot follow a No.
      this.beginParkedModelCancelExit(pending);
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
        // The Yes side. On the EFFORT axis this is the only settle there is; on the
        // MODEL axis the parser returns null by construction (D2 U3) and
        // `noteModelSwitchConfirmed` carries the Yes instead — so this call is
        // effort's, and the shared line is the flow, not a shared claim.
        if (parseClaudeControlReceipt(scan, axis, pending.value) === "settled") {
          this.settleParkedClaudeYes(pending);
          return;
        }
        if (claudeCacheMissCancelled(scan, axis)) {
          if (axis === "effort") {
            this.settleParkedCancel(pending);
            return;
          }
          // MODEL axis: the `Kept …` line is necessary but no longer sufficient
          // (F22, narrowed). It carries no value anchor and the alternate-screen
          // redraw replays it, so a stale one could report a cancel while the
          // dialog was still open and unanswered — and with the model success
          // needle retired there is no longer a competing receipt to beat it. So
          // the line must be corroborated by the dialog's ABSENCE from the GRID,
          // which is the substrate D-1 reserves for state and the one a replay
          // cannot forge. Async, and re-guarded like every other grid read here:
          // it may land after the relay has moved on. If the dialog is still up we
          // simply do nothing — the phrase stays in the scan, so the next frame
          // re-asks the same question, and a genuine cancel answers it.
          //
          // …and even both terms together do not CONCLUDE. They open the bounded
          // exit beat, so a `PostModelSwitch` still in flight wins — see
          // `beginParkedModelCancelExit` for the race that makes that necessary.
          this.verifyParkedModelCancelOnGrid();
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
   * The MODEL-axis cancel gate: a `Kept model as …` line was seen in the scan, so
   * ask the GRID whether the dialog has actually left the screen before believing
   * it. Only then is it a cancel the user chose rather than a replayed line.
   *
   * Re-guards everything the async read could have outlived (the relay may have
   * settled, been cleared, or moved to `closing` in the meantime) and re-asserts
   * the model axis, so this can never conclude on behalf of an effort switch.
   */
  private verifyParkedModelCancelOnGrid(): void {
    this.host.readScreen((screen) => {
      const current = this.pendingControlSwitch;
      if (
        !current ||
        current.axis !== "parked-confirm" ||
        current.dialog !== "claude-cachemiss" ||
        current.originKind !== "model" ||
        (current.phase !== "waiting-user" &&
          current.phase !== "navigating" &&
          current.phase !== "confirming")
      ) {
        return;
      }
      if (claudeCacheMissDialogOpen(screen)) {
        return; // still parked on the dialog — the `Kept …` line was a replay
      }
      this.beginParkedModelCancelExit(current);
    });
  }

  /**
   * Both cancel terms are satisfied — the `Kept …` line is in the scan and the
   * dialog has left the grid — and this STILL does not conclude for a bounded
   * beat, because there is one shape in which both terms are true of a Yes.
   *
   * THE RACE, and it is the retirement's own doing. A Yes reshapes the banner,
   * which is F19's full-transcript redraw condition, which replays this session's
   * older receipts into the freshly-reset post-park scan. If the session ever
   * cancelled a switch before (or Esc'd the plain `/model` picker — F15 measured
   * that printing the same phrase), the replay can carry a `Kept model as …` into
   * the window at the exact moment the dialog leaves the screen for a Yes. Before
   * D2 U3 the success receipt was checked first and beat it; with the model
   * success needle retired there is nothing left in the STREAM to beat it, and the
   * thing that can — the `PostModelSwitch` hook — lands 66–92ms behind the answer
   * (MEASURED, h4). Concluding "cancelled" inside that window would report a lie
   * AND drop a staged Save's queued effort leg, which is exactly the harm class
   * this gate exists to close.
   *
   * So: adopt the shape the codex consent already uses for the same ambiguity —
   * park in `cancel-exit`, let the evidence arrive, and let the verify timer
   * conclude only if nothing did. `PARKED_CONFIRM_CANCEL_VERIFY_MS` (900ms) is ~10x
   * the measured hook latency. `noteModelSwitchConfirmed` accepts `cancel-exit`
   * for this reason and no other.
   */
  private beginParkedModelCancelExit(
    pending: Extract<PendingControlSwitch, { axis: "parked-confirm" }>,
  ): void {
    this.clearParkedTimer(pending);
    pending.phase = "cancel-exit";
    const timer = setTimeout(() => this.onParkedCancelExitVerify(), PARKED_CONFIRM_CANCEL_VERIFY_MS);
    timer.unref?.();
    pending.timer = timer;
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

  /** The bounded exit beat elapsed with no settle signal: the dialog closed
   *  without applying, so conclude cancelled — the user chose Cancel (or Esc'd)
   *  and the Terminal is theirs to reconcile either way. Serves BOTH parked
   *  dialogs, because the ambiguity is the same one: codex waits out a grant
   *  receipt that a native Yes prints a beat after closing the consent
   *  (`beginParkedConsentExit`), claude waits out the `PostModelSwitch` a Yes
   *  fires a beat after the dialog leaves the screen (`beginParkedModelCancelExit`).
   *  Only the settle they conclude with differs. */
  private onParkedCancelExitVerify(): void {
    const pending = this.pendingControlSwitch;
    if (!pending || pending.axis !== "parked-confirm") {
      return;
    }
    pending.timer = null;
    if (pending.dialog === "claude-cachemiss") {
      this.settleParkedCancel(pending);
      return;
    }
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
      this.startClaudePicker(next.kind, next.value, null);
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
    const { originKind, value, fromPicker } = pending;
    this.clearPendingControlSwitch();
    if (fromPicker && (originKind === "model" || originKind === "effort") && this.host.hasPty()) {
      // A NATIVE No/Esc on a picker-raised dialog leaves the PICKER open (m2 arm
      // d). Esc it only if the grid shows it — an identified screen, never a blind
      // key. (The injected No already queued its Esc, so this read finds nothing.)
      const kind = originKind;
      this.host.readScreen((screen) => {
        if (this.claudePickerOnScreen(kind, screen) && this.host.hasPty()) {
          this.host.beginSonataWrite();
          this.host.writePty(ESC);
          this.host.endSonataWrite();
        }
      });
    }
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
    // Same premise for the claude picker (D2 U4): an abandoned `/model` picker eats
    // the next keystroke and turns a delivered prompt's Enter into a PERSISTED
    // model switch (m2 run1 measured exactly that by accident). One Esc, only when
    // the picker was seen open and our own settle/rollback has not already closed it.
    if (pending?.axis === "claude-picker" && pending.pickerOpen && this.host.hasPty()) {
      try {
        this.host.writePty(ESC);
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
