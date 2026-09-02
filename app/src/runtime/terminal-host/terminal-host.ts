import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import * as pty from "node-pty";
import { IMAGE_MARKER_RE, normalizePromptForMatch } from "../../shared/prompt-markers";
import type { CodexOfferedPermissionMode } from "../../shared/types/codex-settings";
import type {
  ApprovalChoice,
  ApprovalDecision,
  ApprovalDecisionEncoding,
  ApprovalKind,
  ClaudePermissionMode,
  CodexApprovalMode,
  CodexSandboxMode,
  CompletionConfidence,
  CompletionHint,
  CompletionSource,
  LaunchSpeedMode,
  PendingWake,
  ReasoningEffort,
  TurnEndWake,
  RuntimeProvider,
  RunId,
  RunKind,
  RunStatus,
  StopInterruptEncoding,
  TaskId,
} from "../../shared/types/domain";
import type {
  ControlSwitchAttentionReason,
  RuntimeEvent,
  RuntimeReconcileChange,
  RunUpdatedEvent,
} from "../../shared/types/events";
import type {
  ClaudeControlSwitchKind,
  ClaudeControlSwitchResponse,
  RemoteControlInjectResponse,
  TerminalReplaySnapshot,
} from "../../shared/types/ipc";
import { ensureClaudeRuntimeSettings } from "../cli-signal";
import { shouldIgnorePath } from "../ignore-path";
import {
  CODEX_SONATA_PROFILE,
  ensureCodexRuntimeSettings,
  type CodexHookPaths,
} from "../providers/codex";
import { shellQuotePath } from "../shell-quote";
import { normalizeTerminalDimensions, type TerminalDimensions } from "../terminal-dimensions";
import { loginShellPath, mergePath } from "./login-shell-path";
import { TerminalScrollback } from "./terminal-scrollback";
import { TaskScreenModel } from "./task-screen-model";
import { ARROW_DOWN, ARROW_UP, cleanTerminal, ESC, KILL_LINE } from "./tui-parsers-common";
import {
  CLAUDE_MODE_LINE_ON_SCREEN_RE,
  claudeFullscreenOfferOpen,
  claudeRewindPanelOpen,
  compactRemoteControlScan,
  findRemoteControlUrlOnScreen,
  hasRemoteControlDisconnect,
  parseClaudePermissionModeLine,
  parseClaudeTrustDialogRows,
  REMOTE_CONTROL_SCAN_LIMIT,
} from "./tui-parsers-claude";
import { isCodexTrustDialog, isCodexUpdatePrompt } from "./tui-parsers-codex";
import { ControlSwitchEngine } from "./control-switch-engine";

export const BRACKETED_PASTE_START = "\x1b[200~";
export const BRACKETED_PASTE_END = "\x1b[201~";
export const CSI_U_ENTER = "\x1b[13u";
// Claude 2.1.214 completed six separately-pasted image paths in 157–203ms in
// the clean probe, but the affected field session exceeded 260ms. Poll the
// rendered effect with a generous bound that still precedes the 2.5s Enter
// recovery rung; the bound is a fallback, never the success criterion.
const ATTACHMENT_EFFECT_POLL_MS = 25;
const ATTACHMENT_EFFECT_TIMEOUT_MS = 1_500;
// The settle gap between pasting the attachment paths and pasting the prompt
// text / opening the effect poll. Named (not an inline literal) so the exported
// worst-case bound below is derived from the real value, never a copy that can
// silently drift.
const ATTACHMENT_SUBMIT_SETTLE_MS = 120;
/**
 * Worst-case elapsed time from the start of an attachment submit sequence to
 * the submit Enter: the pre-paste baseline poll, the settle gap, then the
 * bounded effect fallback. This is a hard cross-file invariant — the
 * DeliveryController's first Enter-retry rung MUST stay above it, so a heal
 * nudge can never fire while this sequence is still legitimately mid-paste.
 * DeliveryController asserts `ATTACHMENT_SUBMIT_WORST_CASE_MS < enterRetryDelaysMs[0]`
 * at construction, so retuning either constant to violate the margin fails loud.
 */
export const ATTACHMENT_SUBMIT_WORST_CASE_MS =
  ATTACHMENT_EFFECT_POLL_MS + ATTACHMENT_SUBMIT_SETTLE_MS + ATTACHMENT_EFFECT_TIMEOUT_MS;
const CODEX_SKILL_MENTION_RE = /^\$[A-Za-z0-9][\w.-]*$/;

export function attachmentChipEffectSatisfied(
  beforePasteCount: number,
  currentCount: number,
  expectedAttachments: number,
  promptText: string,
): boolean {
  const renderedDelta = Math.max(0, currentCount - beforePasteCount);
  const promptMarkerCount = promptText.match(IMAGE_MARKER_RE)?.length ?? 0;
  // A long paste can collapse to [Pasted text #N +K lines], so its literal
  // image markers never render and this compensated threshold cannot succeed.
  // The 1500ms fallback is the required failure direction: slower, never early.
  return renderedDelta >= expectedAttachments + promptMarkerCount;
}

function needsCodexSkillMentionEnter(provider: RuntimeProvider, text: string): boolean {
  return provider === "codex" && CODEX_SKILL_MENTION_RE.test(text);
}

const DEFAULT_SCROLLBACK_LIMIT = 64 * 1024;
const DEFAULT_COMPLETION_QUIET_MS = 1800;
/**
 * How long a claude PROMPT run must read idle-composer-completed CONTINUOUSLY —
 * on the stream AND on the grid — before the quiescence backstop may close it at
 * LOW confidence in a session whose hooks are alive. See
 * `stoplessTurnEndConfirmed` for the full measured argument; the number itself
 * is set by the one documented misfire shape: a post-submit stall that leaves a
 * >=1.75s printable-quiet window on a live run (claude 2.1.211, 5 field
 * misfires). 30s is an order of magnitude past that, and past Sonata's 20s
 * liveness rung — so a run reaching this window has ALREADY surfaced honestly as
 * "still working" before it is closed, and nothing the user sees is skipped.
 *
 * NOT one of the quiescence/settle constants: those tune when the judge RUNS,
 * this bounds how long a Stop-less ending stays un-closed. The cost it buys is
 * paid only on the gap path — a turn that ends with a Stop closes immediately at
 * high confidence and never reaches this window at all.
 */
const CLAUDE_STOPLESS_TURN_END_CONFIRM_MS = 30_000;
const DEFAULT_POST_COMPLETION_ATTRIBUTION_MS = 5000;
const DEFAULT_APPROVAL_SETTLE_MS = 1200;
/** Trailing-edge throttle period for the approval scan. The panel is a
 *  human-timescale state (a box waiting for input is quiescent by
 *  definition), so coalescing the grid extract+parse to at
 *  most one pass per this window — instead of one per pty chunk — removes the
 *  O(buffer)-per-chunk hot-path cost under a CLI firehose while keeping
 *  freshly-painted-panel latency under ~150ms (research 2026-07-24, VS Code's
 *  agent-terminal ~100–150ms quiescence cadence). */
const APPROVAL_SCAN_CADENCE_MS = 120;
/** PTY output coalescing window (S3). node-pty `onData` chunks accumulate for
 *  this long, then flush as ONE concatenated batch through `handlePtyData` —
 *  upstream of every consumer (scrollback seq write, the `pty:data` broadcast
 *  that main.ts fans out to the recorder, local API, notifier and every
 *  BrowserWindow, each window's reducer pass, and the terminal xterm write). A
 *  batch is the byte-order concatenation of the window's chunks, so it is
 *  indistinguishable from a single large chunk node-pty can already deliver —
 *  the equivalence that makes this transparent to all downstream semantics.
 *  Under a firehose this collapses per-chunk cost from hundreds/sec to ≤~200/sec
 *  while adding ≤5ms latency, well inside every timing consumer's tolerance
 *  (liveness, the 1800ms completion debounce, S2's 120ms approval cadence, the
 *  human-typing echo path). Matches VS Code's TerminalDataBufferer `throttleBy`
 *  (research 2026-07-24): each IPC crossing costs far more than the byte copy
 *  inside a batch. */
const PTY_BATCH_COALESCE_MS = 5;
/** How long after the stop Esc the belt-clear fires. The prompt-restore is
 *  effectively immediate — present at the earliest measured snapshot, +300ms
 *  (probe C10) — so 900ms is comfortably past it; the belt is cosmetic
 *  cleanliness, and the submit-time prefix flood (the dirty flag's only
 *  consumer) is the correctness defense for any latency tail. */
const CLI_INPUT_CLEAR_DELAY_MS = 900;
/** Esc-retry admissibility window after a stop: a PreToolUse hook landing
 *  inside it proves the turn survived the Esc. The lower bound skips the
 *  in-flight hook race (a tool that had already started before the Esc
 *  reached the CLI); the upper bound keeps a forgotten stop from firing an
 *  Esc into next week's turn.
 *
 *  The lower bound has a SECOND job since claude 2.1.216: an Esc PAIR at an
 *  idle composer opens the Rewind restore picker, and `stopRun`'s Esc plus this
 *  retry Esc are the only pair Sonata can emit on a claude path. Measured live
 *  at 2.1.220 (spikes/upstream-sync-2026-08/claude/q3c-esc-window captures):
 *  the pair FIRES at inter-Esc gaps ≤700ms and does NOT at ≥800ms — the
 *  threshold sits in (700, 800]. The comparison below is `elapsed < MIN`, so
 *  an elapsed of exactly 800ms FIRES: the old 800 held the line with ~100ms of
 *  margin against a threshold that is only bounded from above. 1200 buys a
 *  ~500ms margin and costs nothing — the bound only has to clear the in-flight
 *  hook race, and a tool that starts >1.2s after the Esc is just as good a
 *  proof that the turn survived. */
const STOP_ESC_RETRY_MIN_MS = 1200;
const STOP_ESC_RETRY_WINDOW_MS = 45_000;
/**
 * Ctrl+C — codex's turn interrupt since 0.152.x, and a LOADED BYTE. Defined here
 * rather than beside `ESC`/`KILL_LINE` in tui-parsers-common deliberately: those
 * are inert parsing/editing primitives that any module may reach for, and this
 * one is not safe to write without the state check `stopInterruptKey()` performs.
 * The byte and the reason it is dangerous should not be separable.
 *
 * MEASURED at codex 0.152.1 (spikes/upstream-sync-2026-09/codex, probe q31 —
 * every cell of the state space Sonata's stop can reach):
 *
 *  | state at the press                  | what Ctrl+C does                     |
 *  |-------------------------------------|--------------------------------------|
 *  | live turn (either phase — `stopInterruptKey`) | interrupts; `Interrupt` hook +115…151ms; no `Stop`; composer left EMPTY (the prompt is NOT restored, unlike an Esc interrupt) |
 *  | live turn, native approval panel up  | DENIES the request (`✗ You canceled the request to run …`) AND interrupts (`Interrupt` +120ms) |
 *  | `/model` picker open                | closes the picker; no quit           |
 *  | idle composer holding a draft       | clears the draft                     |
 *  | **idle composer, EMPTY**            | **QUITS THE CLI — exit 0, one press, no confirmation** |
 *
 * The last row is the whole reason this is not a straight byte swap. The binary
 * calls the action `fixed.interrupt_or_quit` (unrebindable, unlike the
 * `chat.interrupt_turn` action beside it) and carries a `" again to quit"`
 * footer fragment that suggested a confirmation step — there is none at this
 * binary. And an empty composer is not a rare state: it is what an interrupt
 * itself leaves behind, so a stop and its resend are two DIFFERENT actions
 * (q31 s1 — a second press 2.5s after the interrupt quit; q31 s3 — clearing a
 * draft then pressing again quit).
 */
const CTRL_C = "\x03";
/**
 * The run statuses under which a codex turn is genuinely in flight — the whole
 * guard on `CTRL_C`. `stopped`/`completed`/`failed`/`pty-exited`/`approval-denied`
 * are turns already over.
 *
 * DELIBERATELY NOT `isActiveRunStatus` (reading-core/selectors/runs.ts), which
 * carries the same three plus `stopping`. The two answer different questions and
 * must be allowed to differ: that one asks "should the surface show this run as
 * in flight" — where a stop already requested still reads busy — while this one
 * asks "may we write a key that QUITS the CLI if we are wrong". A run mid-stop
 * has already had its interrupt written; a second one is the resend hazard
 * `stopEscRetry` exists to avoid, not a stop.
 *
 * (No run is ever actually SET to `stopping` today — `stopRun` goes straight to
 * `stopped` via `finishActiveRun`, and the status survives in the union for the
 * task-level mapping. So excluding it costs nothing now and stays the safe
 * direction if that ever changes. A status added to `RunStatus` later defaults to
 * NOT-live here, which is the same safe direction by construction.)
 */
const LIVE_TURN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "active",
  "waiting-for-approval",
  "resumed-after-approval",
]);
/** Flood bounds. The floor blankets visually-WRAPPED long lines (kill
 *  granularity for wrapped lines is unprobed — review F2) and any small
 *  restore regardless of bookkeeping; the cap only bounds pathological
 *  inputs. Each kill is one byte — overshoot costs nothing (probe C9/X3). */
const CLI_INPUT_CLEAR_MIN_KILLS = 40;
const CLI_INPUT_CLEAR_MAX_KILLS = 600;
let terminalGenerationSequence = 0;

function nextTerminalGeneration(explicit?: number): number {
  if (explicit !== undefined) {
    terminalGenerationSequence = Math.max(terminalGenerationSequence, explicit);
    return explicit;
  }
  terminalGenerationSequence += 1;
  return terminalGenerationSequence;
}
/** After a hook-broker approval TIMEOUT, the CLI's native card for the same
 *  request repaints within a beat (probe: ~200ms). A scraped candidate inside
 *  this window is that resurface, not a new ask — mark it so, so the notification
 *  layer stays quiet (the user was already told). Generous; one-shot. */
const BROKER_EXPIRY_RESURFACE_MS = 5000;
/** Gap between option-prompt keystrokes so the native form's per-question
 *  auto-advance (and the final Submit-tab render) settles before the next key.
 *  Phase 0 saw the advance repaint well under this; generous = robust. */
const OPTION_PROMPT_KEY_DELAY_MS = 300;
/** Presses the workspace-trust walk may spend before giving up (its two rows put
 *  the affirm one ONE press away, so this is 6× the need). The margin exists for
 *  the measured input-ARMING window after the dialog's paint, which silently
 *  swallows an early press — the walk re-reads and presses again rather than
 *  assuming the first one landed. Exhausting the bound aborts; it never guesses. */
const CLAUDE_TRUST_WALK_MAX_STEPS = 6;
/** Settle gap after each trust-walk press. The dialog repaints the cursor move on
 *  the same frame as the key (measured), so this is generous; it is also the
 *  re-read cadence while a swallowed press leaves the cursor put. */
const CLAUDE_TRUST_WALK_STEP_MS = 350;
/** Cap on ONE settled-grid read inside the walk. `whenSettled` drops its queued
 *  callback if the model is disposed mid-await (teardown), so without this the
 *  awaiting IPC call — and the drawer's disabled buttons — would hang forever. */
const CLAUDE_TRUST_WALK_GRID_READ_MS = 2000;
/** How long after the human's last terminal keystroke Sonata treats them as
 *  actively typing and holds delivery (S2). Bridges the gaps between keystrokes
 *  — and the pause-to-think over a half-typed line — that the idle-prompt
 *  heuristic alone cannot see. Dogfood-tuned. */
const HUMAN_ACTIVE_WINDOW_MS = 3500;
/** How long after a codex spawn to check for the boot "Update available!" gate
 *  (consolidation S4). Past a normal boot (the delivery latch opens ~1s after
 *  spawn), so a session that is STILL not composer-ready here AND whose tail
 *  matches the gate signature is genuinely stuck behind it. One-shot; the
 *  signature match is the real discriminator, so the window only needs to clear
 *  a healthy boot. Codex-only — claude has no such gate. */
const CODEX_BOOT_UPDATE_CHECK_MS = 4000;
/** How long after a codex spawn to check for the boot directory-trust dialog
 *  (codex-trust S2). Deliberately the SAME window as the update gate above and
 *  for the same reason, not by coincidence: both are onboarding screens codex
 *  paints in its first frames instead of the composer, so the window only has to
 *  clear a HEALTHY boot (the delivery latch opens ~1s after spawn) — past that,
 *  a session still not composer-ready is genuinely parked. Kept as its own
 *  constant rather than shared, so a future measurement can move one gate's
 *  window without silently moving the other's. One-shot; codex-only. */
const CODEX_BOOT_TRUST_DIALOG_CHECK_MS = 4000;
/**
 * Terminal traffic that is NOT the human composing a line — emulator-generated
 * query replies AND mouse activity. xterm.js relays all of these through the
 * SAME `onData` path as keystrokes, with no flag to tell them apart (confirmed:
 * `CoreService.triggerDataEvent`'s `wasUserInput` is not surfaced; and even
 * iTerm2 classifies mouse reports identically to keystrokes). So the activity
 * tracker must filter them structurally, or `isHumanActivelyTyping` never clears
 * and delivery wedges — which is exactly what mouse motion/scroll (`ESC[<…M`)
 * and `?`-prefixed cursor reports did on the post-reply screen.
 *
 * The set is the well-specified terminal INPUT grammar (CSI/OSC/DCS/mouse) — a
 * stable standard, NOT a guess at Claude's volatile TUI — so a future CLI adding
 * a new probe is excluded by default rather than re-breaking us (the 2.1.191
 * regression: DECRQM `$y` / kitty `?u` / OSC color / SGR mouse slipped past the
 * old `[Rn]`/`[?>]c`/focus list). Reading the rendered composer instead would
 * re-couple us to that volatile TUI (placeholder text, layout); this depends on
 * the spec instead. Genuine human keys (printables, Enter, Ctrl-*, arrows,
 * edit/function keys, paste, kitty key PRESSES `CSI…u` without `?`) match none
 * of these shapes and so are correctly seen as input.
 *
 * Accepted ambiguity: the CPR alternative also matches Shift+F3 (`ESC[1;2R`) —
 * the spec shapes genuinely overlap. The failure direction is benign (a real
 * key counted as non-typing → never causes a wedge, at worst delivers one
 * keypress too eagerly), and F-keys are vanishingly rare in the Claude TUI.
 */
const TERMINAL_NON_TYPING_RE = new RegExp(
  [
    "\\x1b\\[[?]?[0-9;]*[Rn]", // CPR / DSR / DECXCPR cursor-position report (incl. `?`-prefixed)
    "\\x1b\\[[?>=][0-9;]*c", // device attributes DA1/DA2/DA3 (CSI form)
    "\\x1b\\[[?]?[0-9;]*\\$y", // DECRQM mode report  ESC[?<n>;<m>$y
    "\\x1b\\[\\?[0-9;]*u", // kitty keyboard flags reply  ESC[?<flags>u (NOT a keypress: those lack `?`)
    "\\x1b\\[<[0-9;]*[Mm]", // SGR mouse report (motion/scroll/press/release) — forward, never typing
    "\\x1b\\[M[\\s\\S]{3}", // legacy X10 mouse report (ESC[M + 3 coordinate bytes)
    "\\x1b\\][0-9]+;[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)", // OSC reply (color/title/palette) … BEL|ST
    "\\x1bP[\\s\\S]*?\\x1b\\\\", // DCS reply (XTVERSION / XTGETTCAP / DA3) … ST
    "\\x1b\\[[IO]", // focus in / out
  ].join("|"),
  "g",
);

/**
 * True when a chunk is entirely non-typing terminal traffic (query replies +
 * mouse) — i.e. removing every recognized non-typing token leaves nothing.
 * Robust to BATCHING (a redraw can emit several replies/mouse events in one
 * chunk; if even one slipped through it would bump the typing timestamp and the
 * activity window would never clear under continuous animation/scrolling). A
 * mixed chunk that still contains a real keystroke returns false → treated as
 * input (never miss genuine typing).
 */
export function isNonTypingTerminalInput(data: string): boolean {
  if (data.length === 0) {
    return false;
  }
  return data.replace(TERMINAL_NON_TYPING_RE, "").length === 0;
}

// Codex approval hint-strings retired in S4 (the scrape funeral): the hook
// PermissionRequest broker is codex's SOLE approval channel now (D5/D6). The
// native-panel scrape below is Claude-only — codex never populates
// `approvalHints`, and `detectApproval` refuses to scrape non-Claude providers.
// History: git log -S CODEX_COMMAND_APPROVAL_HINTS.

const CLAUDE_FILE_EDIT_APPROVAL_HINTS = [
  "do you want to make this edit",
  "do you want to make these edits",
  "allow this edit",
  "allow edits",
  "enter to confirm",
];

const CLAUDE_FILE_READ_APPROVAL_HINTS = ["read(", "allow reading from", "during this session"];

const CLAUDE_COMMAND_APPROVAL_HINTS = [
  "do you want to proceed",
  "allow command",
  "allow this command",
  "run this command",
  "enter to confirm",
];

const CLAUDE_WORKSPACE_TRUST_APPROVAL_HINTS = [
  "quick safety check",
  "is this a project you created or one you trust",
  "yes, i trust this folder",
  "enter to confirm",
];

// claude ≥2.1.17x panel grammar (probe findings 2026-06-13): tool panels
// dropped "Enter to confirm" — the footer is now "Esc to cancel · Tab to
// amend[ · ctrl+e to explain]" — and a header line names the tool class.
// Structured parsing lives in parseClaudeApprovalPanel; these markers also
// feed idle-prompt ordering (a live panel's footer must precede the prompt).
const CLAUDE_PANEL_END_MARKERS = ["esc to cancel", "tab to amend", "enter to confirm"];

const CLAUDE_PANEL_HEADER_KINDS: Array<{ header: string; kind: ApprovalKind }> = [
  { header: "bashcommand", kind: "command" },
  { header: "editfile", kind: "file-edit" },
  { header: "createfile", kind: "file-edit" },
  { header: "readfile", kind: "file-read" },
];

const BACKGROUND_TERMINAL_HINTS = [
  "background terminal",
  "background terminals",
  "still running",
  "running in the background",
  "use /stop",
];

const PROVIDER_ERROR_LINE_RE =
  /api error|overloaded|rate limit|retrying|invalid request|internal server error/i;

export interface TerminalHostOptions {
  taskId: TaskId;
  /** Stable for one TerminalHost and monotonically newer for every host in
   *  this main-process lifetime. Tests may inject a deterministic value. */
  generation?: number;
  defaultWorkspace: string;
  provider?: RuntimeProvider;
  eventSink?: (event: RuntimeEvent) => void;
  scrollbackLimit?: number;
  completionQuietMs?: number;
  /** Test seam for CLAUDE_STOPLESS_TURN_END_CONFIRM_MS — a smoke cannot wait 30s
   *  to prove a 30s window, and the window's LENGTH is not what it is testing. */
  stoplessTurnEndConfirmMs?: number;
  postCompletionAttributionMs?: number;
}

export interface StartTaskOptions {
  cwd?: string;
  /**
   * The session's Sonata-owned runtime home for Claude's hooks/usage/settings (D8).
   * The app passes ~/.sonata/data/runtime/<taskId> so nothing Sonata-owned lands in
   * the agent's working directory. Defaults to `<cwd>/.sonata` when unset (the
   * legacy in-cwd location) so a bare TerminalHost in a test still works.
   */
  runtimeDir?: string;
  command?: string;
  args?: string[];
  /** Codex only: the launch permission preset. Fanned out to the legacy
   *  (sandbox × approval × reviewer) flags at the codexArgs seam — hence the
   *  OFFERED type: only a mode with a row in `CODEX_PERMISSION_MODE_FLAGS` can
   *  be launched into. */
  codexPermissionMode?: CodexOfferedPermissionMode;
  permissionMode?: ClaudePermissionMode;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  speedMode?: LaunchSpeedMode | null;
  /** Claude only: spawn with `--remote-control` so the session is phone-
   *  reachable from the start (the "arm at session start" path). */
  remoteControl?: boolean;
  /** Claude only: set false for native-approval mode — routes PermissionRequest
   *  to the scrape/keys fallback instead of the hook-intercept broker (S2).
   *  Default (undefined) is broker-on. */
  approvalBroker?: boolean;
  /** Codex only: the Sonata-home shim dir for the injected hook profile, plus an
   *  optional `pretrustCwd` the controller's policy chose for this spawn's trust
   *  ledger. Present → buildArgs writes the profile+shims (write-if-changed) and
   *  spawns with `-p sonata`. The controller supplies binDir + pretrustCwd (it owns
   *  Sonata-home and the trust policy); the codex edge owns the `$CODEX_HOME`
   *  profile-file location and the ledger mechanism. */
  codexHookPaths?: CodexHookPaths;
  /**
   * Codex only: suppress codex's own boot "Update available!" prompt for THIS
   * spawn, because Sonata has taken over keeping the CLI current. Resolved per
   * spawn by main (`RuntimeController.buildStartOptions` → the CLI updater's
   * `spawnDecision()`); this edge only emits the flag it is told to. The host
   * stays settings-blind — main resolves, options carry.
   */
  codexSuppressUpdatePrompt?: boolean;
  resumeLast?: boolean;
  /** Provider session id to resume natively (claude --resume / codex resume). */
  resumeRef?: string;
  /**
   * Fresh-spawn only: pin the new session to an id Sonata chose up front
   * (claude --session-id), so the Task's binding is known at birth instead
   * of guessed by file mtime. Ignored when resuming. Claude-only today.
   */
  sessionId?: string;
  /**
   * Per-spawn environment overlay — the clean lever for per-session
   * provider policy (e.g. suppressing the resume interstitial) without
   * ever mutating user-global state.
   */
  extraEnv?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export interface StartedPty {
  pid: number;
  cwd: string;
  command: string;
  args: string[];
  /** The geometry this PTY and the host's two headless terminals were actually
   *  built at — the boot fan-out's single clamped value, handed back so a mirror
   *  the host does NOT own (the controller's `StatusRegionTracker`) can be sized
   *  from the same source rather than from its own reading of the request. */
  dimensions: TerminalDimensions;
}

export interface PromptSubmission {
  taskId: TaskId;
  runId: RunId | null;
  kind: RunKind;
  /** When submitPrompt returned — the WRITE time. For a plain send this is also
   *  the effect time (the Enter fires within the same 120ms deferred tick). */
  submittedAt: string;
  /**
   * Present ONLY for an attachment send, whose submit Enter fires asynchronously
   * — 145ms to ~1.65s later — after the effect-verified paste sequence. Resolves
   * to the ISO time the sequence actually pressed Enter (or resolved its bounded
   * fallback). DeliveryController re-stamps the in-flight epoch and re-arms the
   * receipt timeout + heal ladder from this time, so none of them run from the
   * lying write-time epoch. Never resolves if the sequence is canceled (Stop),
   * which the stop path handles separately.
   */
  effect?: Promise<string>;
}

export interface PromptAttachmentSubmission {
  path: string;
}

interface SnapshotEntry {
  exists: boolean;
  type: "file" | "directory" | "other" | "missing" | "error";
  size?: number;
  mtimeMs?: number;
  error?: string;
}

interface RecentAttributionRun {
  id: RunId;
  expiresAt: number;
  /** The finished run's prompt — lets a LATE UserPromptSubmit echo (file-queue
   *  latency) be recognized as belonging to the run that already ran, instead
   *  of beginning a phantom run for it. */
  prompt: string;
}

/**
 * A screen whose approve cannot be a key sequence at all (upstream sync
 * 2026-09-01). `optionKeys` answers a panel whose affirm option is addressable
 * — a digit, or an Enter on a row that is already focused. Claude's 2.1.252
 * workspace-trust dialog is neither: its affirm row is second, carries no digit,
 * and the default row's Enter EXITS the CLI. Answering it means moving a cursor
 * — a choreography with a screen read between every press — so the candidate
 * names the walk instead of a key, and `sendApprovalDecision` dispatches to it.
 * One walk exists; the field is absent on every other candidate.
 */
type ApprovalAnswerWalk = "claude-workspace-trust";

interface ApprovalCandidate {
  kind: ApprovalKind;
  fingerprint: string | null;
  fingerprintHash: string | null;
  promptAfterApproval: boolean;
  choices: ApprovalChoice[];
  /** v2-parsed panels carry their own decision→key map (digits / CR). */
  optionKeys?: Partial<Record<ApprovalDecision, string>>;
  /** Set when `approve` is answered by a grid-verified cursor walk rather than
   *  by `optionKeys` (see ApprovalAnswerWalk). Never set for other decisions:
   *  deny stays Esc. */
  optionWalk?: ApprovalAnswerWalk;
  grammar?: "v2" | "legacy";
}

type ActiveRun = RunUpdatedEvent["payload"];

/** The one in-flight mid-session control switch. Two shapes, one pointer (the
 *  shared single-switch guard):
 *   - `value` (S1) — a `/model` / `/effort` typed command awaiting its one
 *     printed receipt line. `timer` is the one-shot receipt→needs-attention
 *     window.
 *   - `permission` (S2) — the Shift+Tab stepping engine. Each `\x1b[Z` steps one
 *     mode; the mode-line receipt says where we landed. `phase` seeks the target,
 *     then (on abort) returns to `origin`. `landed` is the last confirmed mode
 *     (needs-attention display anchor); `observed` accumulates every mode a
 *     receipt confirmed this run (fed to the menu's reachable-modes set). `timer`
 *     is the CURRENT per-step window, re-armed on each step. */
interface TerminalProviderProfile {
  provider: RuntimeProvider;
  defaultCommand: string;
  approvalSource: string;
  supportsSlashStop: boolean;
  /** Fence-only vocabulary (S6): the last-activity ordering anchors inside
   *  `detectIdlePrompt` (composer must render AFTER work text) and
   *  `detectIdleComposer` (the quiescence run-closer's "work happened"
   *  evidence). NOT a busy/idle driver — that is cli-state (hooks) with the
   *  StatusRegionTracker's own display-only glyph constants behind it. */
  activityHints: string[];
  /** The glyphs a COMPOSER PROMPT can paint with — the anchor `detectIdlePrompt`
   *  scans for to locate the last prompt in the tail. NOT the picker/dialog
   *  cursor vocabulary: those anchors live in the tui-parsers modules and pin
   *  `›` + a digit + `.` + a row LABEL, so widening here can never loosen them.
   *  A cross-provider superset by design (the ASCII `>` fallback plus both
   *  CLIs' glyphs — the ORDERING rules, not the glyph identity, are what tell a
   *  live panel from an idle composer), but per-provider so a glyph only ONE
   *  CLI paints cannot manufacture a prompt in the other's stream. */
  composerPromptGlyphs: string[];
  idlePromptModelHints: RegExp;
  buildArgs: (options: StartTaskOptions & { cwd: string }) => string[];
  approvalHints: {
    fileRead: string[];
    fileEdit: string[];
    command: string[];
    workspaceTrust: string[];
  };
  /** Panel-footer markers that anchor idle-prompt ordering: a live panel
   *  blocks readiness until the prompt renders AFTER its footer. Separate
   *  from approvalHints so legacy endNeedle positions stay intact. */
  approvalEndMarkers: string[];
  /** Boot-dialog footers (directory trust, quit confirms) whose option cursor
   *  paints the SAME `›` glyph the composer scan reads as an idle prompt.
   *  Consumed ONLY by `detectIdlePrompt` — never by `detectApprovalCandidate`
   *  — so the codex approval scrape stays retired (S4) while readiness stops
   *  lying about a dialog screen. The dialog itself is answered by the human
   *  in the co-visible Terminal; until then delivery must hold, because a
   *  submitted prompt's Enter would silently answer it (the trust dialog eats
   *  the pasted text AND its Enter picks "Yes, continue" — probed 0.144.5,
   *  spikes/codex-boot-input-window, field-hit 2026-07-17 BeDog session). */
  bootDialogHints: string[];
}

export class TerminalHost extends EventEmitter {
  private readonly taskId: TaskId;
  private readonly generation: number;
  private readonly profile: TerminalProviderProfile;
  private readonly defaultWorkspace: string;
  private readonly eventSink: ((event: RuntimeEvent) => void) | null;
  private readonly scrollbackLimit: number;
  private readonly completionQuietMs: number;
  private readonly stoplessTurnEndConfirmMs: number;
  private readonly postCompletionAttributionMs: number;
  /** When the ACTIVE run's idle-composer verdict first became true, and which
   *  run it belongs to — the sustained window `stoplessTurnEndConfirmed` reads.
   *  Null whenever the last judge pass saw the run as not-idle. */
  private sustainedIdleVerdict: { runId: RunId; since: number } | null = null;
  private ptyProcess: pty.IPty | null = null;
  /**
   * Teardown intent for the CURRENTLY live PTY (SL-6). `disposeProcess` flips it
   * on before killing; the process's own `onExit` closure captures THIS token, so
   * `pty:exit` can say whether the death was Sonata's doing or came from outside
   * (a crash, or the user quitting the CLI in the co-visible Terminal).
   *
   * A per-PROCESS token, not a host field, because `startTask` disposes the old
   * PTY and immediately spawns a new one: a host-level flag would either be reset
   * before the old process's asynchronous `onExit` arrived (reporting a Sonata
   * teardown as a crash) or survive into the new process (reporting a crash as a
   * teardown). Each closure reading its own token cannot be misattributed.
   */
  private processTeardown: { sonataInitiated: boolean } | null = null;
  private scrollback: TerminalScrollback | null = null;
  private rawTail = "";
  private cwd: string | null = null;
  private fileWatcher: fs.FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  // One-shot boot watchdog (codex only): fires the codex "Update available!"
  // needs-attention banner if the composer is still not ready when it elapses AND
  // the tail matches the gate signature. Armed in startTask, cleared on teardown.
  private codexBootUpdateTimer: NodeJS.Timeout | null = null;
  // One-shot boot watchdog (codex only): fires the codex directory-trust
  // needs-attention banner if the composer is still not ready when it elapses AND
  // the SCREEN matches the dialog signature. Armed in startTask, cleared on
  // teardown — the sibling of codexBootUpdateTimer above.
  private codexTrustDialogTimer: NodeJS.Timeout | null = null;
  /** The trust-dialog banner is currently raised for this session (codex-trust
   *  S2, plan L2). Gates the clearing pass — it is what makes the pass free on
   *  every session that never saw the dialog (the overwhelming majority, since
   *  S1's pre-trust is unconditional), and what keeps `cleared` from ever being
   *  emitted for a banner that was never raised. Reset on teardown, so the next
   *  spawn re-detects from scratch rather than inheriting a stale verdict. */
  private codexTrustDialogSurfaced = false;
  private fileSnapshot = new Map<string, SnapshotEntry>();
  /**
   * The workspace stat state captured at the START of the active run (OBS S6 /
   * D3). Retained (a cheap paths+stat Map copy of `fileSnapshot`, no extra walk)
   * so that at run end the reconcile can diff current-vs-run-start and name the
   * paths the run changed — the net for Bash-mediated edits the semantic
   * PostToolUse channel can't see. Overwritten at each `beginRun`.
   */
  private runStartSnapshot: Map<string, SnapshotEntry> | null = null;
  private pendingFileTimers = new Map<string, NodeJS.Timeout>();
  private approvalActive = false;
  private lastApprovalKind: ApprovalKind | null = null;
  private lastApprovalFingerprint: string | null = null;
  private lastApprovalDecision: ApprovalDecision | null = null;
  private lastApprovalDecisionAt: number | null = null;
  /** Epoch ms of the most recent hook-broker approval TIMEOUT (Sonata answered
   *  nothing → the CLI's native card is taking over). One-shot: the next scraped
   *  candidate within the resurface window is the SAME request reappearing, so it
   *  is marked `resurfacedAfterDecision` (a broker payload can never share the
   *  scrape's text-derived fingerprint, so the fingerprint path cannot recognize
   *  it — this timing signal does). Consumed on use. */
  private brokerExpiryResurfaceAt: number | null = null;
  /** A same-kind candidate was swallowed inside the post-decision settle
   *  window (the phantom-repaint class). Gates the settle re-check's re-arm:
   *  only a suppressed candidate needs the extra look — every other path
   *  keeps the one-shot settle semantics. */
  private approvalSuppressedInSettleWindow = false;
  /** decision → key bytes for the CURRENTLY surfaced panel (v2 grammar
   *  parses the panel's own numbered options; digits instant-select). */
  private activeApprovalOptionKeys: Partial<Record<ApprovalDecision, string>> | null = null;
  /** The CURRENTLY surfaced panel's approve is a cursor walk, not a key (see
   *  ApprovalAnswerWalk). Mirrors `activeApprovalOptionKeys`: written by
   *  `surfaceApproval`, cleared with it on every spawn/teardown boundary. */
  private activeApprovalWalk: ApprovalAnswerWalk | null = null;
  /** A cursor walk is mid-flight. Approvals are single-answer by contract (the
   *  drawer single-flights, and the FIRST answer consumes the panel), and a
   *  second walk would press arrows against a screen the first is still moving —
   *  so a concurrent request is refused loudly rather than interleaved. */
  private approvalWalkInFlight = false;
  /** Per-task headless screen model (S4b). Reconstructs the CURRENT screen from
   *  the raw PTY stream so `detectApproval` reads the settled grid instead of the
   *  raw byte tail. Created/reset alongside `scrollback` in `startTask`, resized
   *  where the PTY resizes, disposed on teardown. */
  private screenModel: TaskScreenModel | null = null;
  /** Grid-era re-expression of the old byte-offset `approvalScanFloor` (S4b). A
   *  hook-broker reply goes down the CLI's own stdout channel and cannot be
   *  swallowed, so it DEFINITIVELY answers whatever panel is on screen at
   *  decision time. Under the raw tail that answered panel's bytes lingered
   *  forever (claude ≥2.1.186 paints the full native panel while the broker
   *  holds) and re-detected as a phantom "resurfaced" ask >1.2s later, wedging
   *  the run (2026-07-03) — the floor excised them by byte offset. Under the grid
   *  the panel LEAVES the screen when the TUI repaints past it (S4a Q4: grid
   *  parses ~5 chunks vs raw's 149–232), so the floor's job is mostly VACUOUS.
   *  This watermark covers only the RESIDUAL window where the answered panel
   *  still lingers on the grid before that repaint (and the non-repainting
   *  synthetic CLIs in the smokes, where it lingers indefinitely): a candidate
   *  whose grid fingerprint equals it is answered history and must not
   *  (re)surface. Keying on fingerprint is reliable BECAUSE grid fingerprints
   *  are stable (S4a: 46→2) — the very instability that forced the byte floor is
   *  gone. Set only on broker decisions (native-key decisions can be swallowed →
   *  the resurface honesty backstop must stay live for them); cleared when the
   *  panel leaves the grid, on a new surface, and on run/task reset. */
  private brokerAnsweredFingerprint: string | null = null;
  /** True when this task runs with the PermissionRequest broker ON (the
   *  production default; S2 standing condition). In that mode the broker owns
   *  every approval end-to-end — ask → card → reply-file — and the grid scrape
   *  must NOT proactively surface a NATIVE card (S4b R1). The raw scrape got this
   *  for free: claude co-renders the "running PermissionRequest hook" spinner
   *  while the broker holds, so every raw frame parsed as a `promptAfterApproval`
   *  collision and was excluded. The grid converges PAST that spinner to a clean
   *  waiting panel, so `detectApproval` would surface a native card DURING the
   *  hold and answer it with PTY digit keys — double-answering the ask the broker
   *  also replies to. Measured: the grid surfaces ~7ms BEFORE the broker ask even
   *  reaches the controller, so an ask-time note cannot win the race; the mode is
   *  the only race-free signal, and terminal-host already knows it at spawn. In
   *  broker-ON the scrape is a BACKSTOP only — it surfaces solely when the broker
   *  EXPIRES (brokerExpiryResurfaceAt armed; the broker gave up and the native
   *  card is now the live surface), exactly the S4 "native card appears only
   *  after a broker timeout" architecture. Broker-OFF (`approvalBroker: false`,
   *  the co-visible Terminal / native-approval mode) leaves the scrape as the
   *  genuine approval channel, so it always surfaces. Set in startTask from an
   *  EXPLICIT approvalBroker:true (production, via buildStartOptions); defaults
   *  OFF so a bare-host test with no running broker still surfaces its panel. */
  private approvalBrokerOn = false;
  /** The CLI's own "session is up" declaration (SessionStart hook). Opens
   *  acceptsPromptInput structurally: claude ≥2.1.186 repaints transcript
   *  history on --resume (old ❯ prompt lines, "✻ Baked for Ns" summaries),
   *  which reads as activity-after-prompt in the linear idle scrape and
   *  starved the boot latch forever (2026-07-03 diagnosis). Hook-less
   *  spawns (codex, broker-off) keep the scrape path. */
  private hookSessionStarted = false;
  private persistReceiptTimers: NodeJS.Timeout[] = [];
  private nativeAnswerRecheckTimers: NodeJS.Timeout[] = [];
  /** One-shot handoff for the ask a stale-approval clear silently drops —
   *  consumed by the controller at turn-end. See `takeOrphanedScrapeApproval`. */
  private orphanedScrapeApproval: { previousKind: ApprovalKind | null } | null = null;
  private startedAt: number | null = null;
  private activeRun: ActiveRun | null = null;
  private runSeq = 0;
  private completionTimer: NodeJS.Timeout | null = null;
  private approvalSettleTimer: NodeJS.Timeout | null = null;
  /** The single in-flight coalesced approval scan (throttle-with-trailing-edge,
   *  see scheduleApprovalScan). Cleared on PTY teardown alongside the settle
   *  timer so a scan cannot fire on a dead/replaced session. */
  private approvalScanTimer: NodeJS.Timeout | null = null;
  /** Coalescing buffer for node-pty `onData` chunks (S3), in arrival order. The
   *  ~5ms one-shot `ptyBatchTimer` joins and drains it through `handlePtyData`
   *  once per batch. Flushed (never dropped) on every teardown path — symmetric
   *  with `approvalScanTimer` — because these chunks arrived before teardown and
   *  the pre-batching synchronous path handled exactly such chunks. */
  private pendingPtyData: string[] = [];
  private ptyBatchTimer: NodeJS.Timeout | null = null;
  private lastPtyDataAt = 0;
  /** Last chunk that carried PRINTABLE content (survives cleanTerminal). The
   *  idle claude TUI emits a 5-byte control-only chunk every ~200ms
   *  (housekeeping, s4-diags/zzz-completion-trace) — raw-byte recency
   *  therefore never goes quiet, which silently debounced the completion
   *  timer to death. "The CLI is still talking" must mean VISIBLE output. */
  private lastPrintablePtyDataAt = 0;
  private taskReady = false;
  private recentAttributionRun: RecentAttributionRun | null = null;
  /** The last finished run's trimmed prompt, surviving the next beginRun
   *  (unlike recentAttributionRun, which beginRun clears): the back-stamp's
   *  ambiguity guard against a finished same-text twin's late hook echo. */
  private lastFinishedPrompt: { text: string; expiresAt: number } | null = null;
  /**
   * The run whose turn end declared in-flight background work and is still
   * waiting to be woken by it (SL-16) — the id alone, because the id is the
   * whole question this answers ("which run does the revival continue?"). Set at
   * the completion that stamped `pendingWake`; the wake's DETAIL lives on that
   * run's own record, where it is durable, rather than being mirrored here.
   *
   * NO EXPIRY, deliberately. The wake tracks the background task's OWN duration
   * (MEASURED: a 70s sleep woke the session at ~69s, 4/4) — a job that runs for
   * an hour wakes in an hour, and any timeout Sonata invented would be a guess
   * that silently unlinks the honest cases. It is cleared only by evidence: the
   * revival consuming it, a later turn end positively reporting no background
   * work left (`background_tasks: []` — the ONLY trace of the F43 revival that
   * fired no `UserPromptSubmit` at all), or a fresh spawn.
   */
  private runAwaitingWake: RunId | null = null;
  private activeRunRaw = "";
  // Remote Control (phone access) — tracked optimistically; no hook/structured
  // signal exists for it, and the footer `/rc` pill is not a state readout at all
  // (SL-11 measured its TEXT identical connected and not — only its COLOUR moves,
  // and the grid is text-only). `injectRemoteControl` flips us active; the
  // scraped session URL confirms and carries the phone link.
  // KNOWN BLIND SPOT, registered not fixed (SL-11 F4e): claude can auto-start RC
  // at boot from org policy or a server-side default with no `--remote-control`
  // flag, and "activation is OUR signal" means Sonata reports OFF for such a
  // session. Closing it is a product decision on `defaultRemoteControl`, not a
  // detection change.
  private remoteControlActive = false;
  private remoteControlUrl: string | null = null;
  // Rolling RAW tail (capped) — the OFF signal ONLY. While active we compact it
  // (escapes + whitespace removed) to detect the disconnect line — robust to
  // claude's word-positioned redraw (glued words) AND to a split landing inside a
  // word OR inside an escape sequence. Reset on every transition so a stale match
  // can't fire after a reconnect. The URL is NOT read here any more: since
  // 2.1.252's differential repaint the stream stopped carrying the link whole
  // (SL-11) — see detectRemoteControlState.
  private remoteControlScan = "";
  // The mid-session control-switch choreography (five axis state machines + the
  // S7 parked-confirm drawer relay). Owns the single in-flight switch and its
  // receipt scan; TerminalHost delegates the IPC entry points + PTY-frame ingest.
  private readonly controlSwitch: ControlSwitchEngine;
  /**
   * Single-writer arbitration between Sonata's automation and the human typing in
   * the terminal (S2 — the AtomicWriter). `sonataWriteDepth` > 0 means an
   * automation write SEQUENCE is in flight — a prompt paste (sync attachment
   * writes + the deferred text/Enter timers) or an option-prompt key run. Human
   * keystrokes that arrive during that window are held in `pendingHumanInput` and
   * flushed the instant the sequence completes, so the two byte streams never
   * interleave (no `git che`+paste corruption; no split bracketed-paste frame).
   * `lastHumanInputAt` timestamps the human's last terminal keystroke — used
   * ONLY to reconcile natively-answered approvals, never to hold delivery.
   */
  private sonataWriteDepth = 0;
  private pendingHumanInput = "";
  private lastHumanInputAt = 0;
  private humanSettleTimer: NodeJS.Timeout | null = null;
  // Deferred automation writes (submitPrompt's text/Enter, /rc's Enter) that
  // have not fired yet. stopRun cancels them: an Esc aimed at a turn must not
  // be followed by our own deferred paste STARTING one (probe S0,
  // stop-after-send race). Each handle balances its write-lock hold on
  // cancel. `owner` distinguishes a run-starting prompt's bytes from control
  // sends (/stop, /rc Enter) so a canceled control write can never produce a
  // false "your prompt never reached the CLI" verdict (review F3).
  private readonly pendingDeferredWrites = new Set<{
    owner: "prompt" | "control";
    cancel: () => void;
  }>();
  // Whether the CURRENT prompt submission's text/paths have actually been
  // written into the composer (they are visible, awaiting the submit Enter).
  // Reset when a prompt submission begins, set the moment its bytes land. stopRun
  // reads it so a mid-sequence cancel can report honestly whether the prompt
  // reached the CLI (paths/text pasted) or never left — an attachment send's
  // Enter can lag ~1.65s behind its paste, so "canceled before it reached the
  // CLI" was a lie for the whole in-between.
  private promptTextReachedComposer = false;
  // The CLI's input line may hold text Sonata did not put there on purpose —
  // Esc-interrupt restores the interrupted prompt into the composer (probe
  // C1/X1). While set, the next injection prefixes a kill-line flood; the
  // post-stop belt timer also clears the line in place but does NOT consume
  // the flag (review F1: the restore's latency has no probed lower tail, so
  // only a consuming injection — whose flood provably precedes its own paste
  // — may stand the guard down).
  private cliInputMaybeDirty = false;
  private cliInputClearTimer: NodeJS.Timeout | null = null;
  private slashStopTimer: NodeJS.Timeout | null = null;
  // Monotonic high-water line count of prompt text pasted this session —
  // sizes the kill flood. The restore is the INTERRUPTED TURN's prompt, not
  // necessarily the last submission (a 1-line mid-turn steer must not
  // undersize the flood for a 10-line turn — review F2), so this only
  // ratchets up; overshoot kills are free no-ops (probe C9/X3).
  private cliDirtyLineHighWater = 1;
  // One-shot Esc resend, armed by stopRun, fired ONLY on unambiguous
  // turn-alive evidence (a PreToolUse hook after the stop). Never fires at
  // idle: a repeated Esc there opens Claude's rewind menu / prefills Codex's
  // edit-previous buffer (probe C6/X2). Carries the stopped run's id so the
  // retry is recordable in the durable report (review F4).
  //
  // ARMED ONLY WHEN THE STOP WROTE Esc — i.e. never on a codex stop that wrote
  // Ctrl+C (SL-15). Two independent reasons, either sufficient:
  //   - Resending Ctrl+C is UNSAFE. The retry's only guard is the PreToolUse
  //     evidence; it cannot gate on the run pointer, because `stopRun` has
  //     already closed the run by the time this could fire (`activeRun` is null
  //     for every retry, which is also why its own guard reads `!this.activeRun`).
  //     A Ctrl+C that lands on an idle codex composer QUITS the CLI outright
  //     (q31 s2 — exit 0, one press, no confirmation), so a blind resend trades
  //     a swallowed interrupt for a killed session.
  //   - There is nothing to recover. The retry exists for a SWALLOWED Esc on
  //     claude. A codex Ctrl+C interrupted on EVERY measured press — q34's four
  //     cells across both turn phases (+118…151ms) and q33's production
  //     `stopRun()` on a streaming turn (+115ms) — and the codex Esc this would
  //     otherwise resend is measured INERT against a streaming turn (q34, 2/2).
  private stopEscRetry: {
    requestedAt: number;
    retried: boolean;
    runId: RunId | null;
  } | null = null;

  constructor(options: TerminalHostOptions) {
    super();
    this.taskId = options.taskId;
    this.generation = nextTerminalGeneration(options.generation);
    this.profile = terminalProviderProfile(options.provider ?? "codex");
    this.defaultWorkspace = options.defaultWorkspace;
    this.eventSink = options.eventSink ?? null;
    this.scrollbackLimit = options.scrollbackLimit ?? DEFAULT_SCROLLBACK_LIMIT;
    this.completionQuietMs = options.completionQuietMs ?? DEFAULT_COMPLETION_QUIET_MS;
    this.stoplessTurnEndConfirmMs =
      options.stoplessTurnEndConfirmMs ?? CLAUDE_STOPLESS_TURN_END_CONFIRM_MS;
    this.postCompletionAttributionMs =
      options.postCompletionAttributionMs ?? DEFAULT_POST_COMPLETION_ATTRIBUTION_MS;
    // The control-switch engine drives the session through a narrow seam: the
    // shared PTY under the AtomicWriter, the idle guards, and the event sink.
    // The adapter keeps those internals private to TerminalHost.
    this.controlSwitch = new ControlSwitchEngine({
      taskId: this.taskId,
      provider: this.profile.provider,
      hasPty: () => this.ptyProcess !== null,
      writePty: (data) => {
        this.ptyProcess?.write(data);
      },
      isApprovalActive: () => this.approvalActive,
      isRewindPanelOpen: () => this.isRewindPanelOpen(),
      screenPermissionMode: () => this.screenPermissionMode(),
      hasActiveRun: () => this.activeRun !== null,
      isSonataWriting: () => this.sonataWriting,
      beginSonataWrite: () => this.beginSonataWrite(),
      endSonataWrite: () => this.endSonataWrite(),
      deferSonataWrite: (ms, fn, owner) => this.deferSonataWrite(ms, fn, owner),
      clearComposerBeforeTypedCommand: () => this.clearComposerBeforeTypedCommand(),
      // The engine's SPATIAL queries read the SAME per-task screen model the
      // approval detector uses (D-1: one grid per task, never a third emulator).
      // Deferred through `whenSettled` exactly like `scheduleApprovalScan`, so the
      // read sees a COMPLETE grid rather than a mid-parse prefix — synchronous in
      // the quiescent case, which is every parked dialog. No screen model means no
      // pty: skip the callback rather than hand the engine an empty screen it
      // could misread as "the dialog closed".
      readScreen: (fn) => {
        this.screenModel?.whenSettled(() => fn(this.approvalScanGrid()));
      },
      emitControlSwitchEvent: (payload) => this.emitEvent("control-switch:state", payload),
    });
  }

  get workspace(): string | null {
    return this.cwd;
  }

  hasActiveRun(): boolean {
    return Boolean(this.activeRun);
  }

  /** The Sonata-owned run currently open, for attribution of controller-side
   *  events (hook-broker approvals carry no runId of their own). */
  activeRunId(): RunId | null {
    return this.activeRun ? this.activeRun.id : null;
  }

  isApprovalActive(): boolean {
    return this.approvalActive;
  }

  /** True whenever a mid-session control switch is in flight, in ANY phase —
   *  including a PARKED consent dialog (`waiting-user`, which has no timeout by
   *  design). The delivery pump gates on this: a queued item that pasted text +
   *  Enter while a codex Full Access consent is parked would land on the dialog,
   *  whose default row is "Yes, continue anyway" — a silent full-access grant.
   *  Never auto-answer a consent is the program's hard red line. */
  hasPendingControlSwitch(): boolean {
    return this.controlSwitch.hasPending();
  }

  /**
   * Structural "the composer exists and is idle" check — the boot-latch
   * fence (contract §4 permanent fence list). Prompt detection requires the
   * prompt to render AFTER any approval-screen text, so a pending trust
   * screen blocks this both via approvalActive and via the prompt-ordering
   * rule. The delivery pump re-polls THIS gate every ~500ms while blocked;
   * it opens the boot latch (~1s after spawn, probe s6-diags) and never
   * re-gates delivery after that.
   *
   * No PTY-quiet gate. A modern TUI never goes byte-quiet — the idle claude
   * TUI emits a control-only chunk every ~200ms forever (s4-diags), which is
   * exactly what starved the retired between-runs poller (`checkTaskReady`,
   * S6): its debounce re-armed on every chunk and its quiet gate read the
   * raw-byte clock, so `task:ready`/`task:accepts-input` never fired in the
   * full app. The structural idle-prompt is the honest readiness signal: it
   * requires the `❯` composer rendered after any panel, and
   * `activeRun`/`approvalActive` cover the busy/panel cases.
   */
  acceptsPromptInput(): boolean {
    if (!this.ptyProcess || this.activeRun || this.approvalActive) {
      return false;
    }
    // A recognized Rewind panel owns the screen — see isRewindPanelOpen. Ranked
    // ABOVE the hook short-circuit below: SessionStart says the composer came
    // up, which is true and irrelevant once a modal is painted over it.
    if (this.isRewindPanelOpen()) {
      return false;
    }
    // Claude's fullscreen-renderer BOOT offer owns the screen the same way — see
    // isFullscreenOfferOpen. Ranked here for the same reason, even though the
    // offer is measured painting BEFORE SessionStart could fire: the ordering
    // that makes it safe today is upstream's, not ours.
    if (this.isFullscreenOfferOpen()) {
      return false;
    }
    // Hook-first: SessionStart is the CLI declaring its composer is up — no
    // scrape can outrank that. Required for resumed sessions on claude
    // ≥2.1.186, whose history repaint (old ❯ lines + "✻ Baked for Ns"
    // summaries) permanently defeats the linear prompt-after-activity scrape
    // below. The busy/panel cases stay covered by the guards above.
    if (this.hookSessionStarted) {
      return true;
    }
    // Codex's directory-trust dialog owns the screen the same way — see
    // isCodexTrustDialogOpen for why this one is ranked BELOW the hook and the
    // fullscreen offer is ranked above it.
    if (this.isCodexTrustDialogOpen()) {
      return false;
    }
    return detectIdlePrompt(this.rawTail, this.profile).ready;
  }

  /**
   * Codex's boot directory-trust dialog is on the SCREEN GRID (SL-6). A screen
   * owner for READINESS, the codex sibling of `isFullscreenOfferOpen`: the boot
   * latch must not open on a screen whose Enter answers a consent question and
   * discards the prompt that carried it.
   *
   * WHY A GRID PREDICATE WHEN `bootDialogHints` ALREADY GUARDS THIS. The needle
   * guard is an ORDERING claim over the pty tail and it holds while the dialog's
   * footers are the most recent thing in the window — MEASURED true at 0.152.0
   * (q20). What it cannot do is UN-latch: `DeliveryController`'s boot latch is
   * one-way, and codex 0.152.0 paints a composer-shaped startup draft ~120ms
   * before this dialog exists, so a pump landing in that window latches on a
   * screen the needles cannot describe yet. The confidence gate on the latch
   * (`acceptsFirstPrompt`) is what closes that window; this predicate is the
   * belt — a second, independent reason the same latch stays shut, keyed on the
   * dialog's own identity rather than on a footer having resolved.
   *
   * RANKED BELOW THE HOOK SHORT-CIRCUIT, and that is the one place this diverges
   * from `isFullscreenOfferOpen`'s placement. The offer paints strictly before
   * SessionStart could fire, so ranking it above the hook is free. This dialog's
   * CELLS can OUTLIVE the answer: codex is spawned `--no-alt-screen`, so an
   * answered dialog does not vanish with a buffer swap — its rows scroll up and
   * can sit inside a tall viewport for a while (the reason
   * `checkCodexTrustDialogCleared` was written with two legs). Ranked above the
   * hook, that lingering grid would read NOT-READY for a session the CLI has
   * already declared started — a false hold on a live session, which is the
   * worse failure of the two. SessionStart cannot fire until onboarding
   * completes, so the hook being set is itself proof the dialog was answered.
   *
   * Codex-only, so a claude frame can never reach a codex-shaped needle; no
   * screen model means no PTY, and every gate here reads closed rather than
   * holds. Sonata NEVER answers this dialog — the standing RED LINE is
   * untouched; this only decides whether Sonata may WRITE while it is up.
   */
  isCodexTrustDialogOpen(): boolean {
    if (this.profile.provider !== "codex" || !this.screenModel) {
      return false;
    }
    return isCodexTrustDialog(this.screenModel.viewportText());
  }

  /**
   * May the DELIVERY BOOT LATCH open right now? (SL-6.)
   *
   * A strictly stronger question than {@link acceptsPromptInput}, and the split
   * is the point: `acceptsPromptInput()` answers "is a composer accepting input"
   * for every caller, while this answers the one-way, irreversible question
   * `DeliveryController.pump()` asks ONCE per session — after which delivery is
   * send-is-send and no scrape re-gates it. An irreversible decision deserves a
   * stricter test than a reversible one.
   *
   * THE EXTRA TERM, codex only: the idle-prompt read must be MEDIUM confidence,
   * i.e. `hasModelOrCwdHint` — the composer's footer has resolved to a real
   * `<model> <effort> · <cwd>`. MEASURED at codex 0.152.0 and re-measured
   * byte-identical at 0.152.1 (SL-6, q20): codex
   * paints a startup DRAFT at ~147ms whose box reads `model: loading` /
   * `directory: loading` under a real composer glyph and placeholder. That draft
   * reads `ready: true` at LOW confidence; the resolved composer ~850ms later
   * reads MEDIUM. Without this term a pump landing in the draft window latches,
   * and the trust dialog that replaces the draft at ~270ms then receives the
   * first delivery's paste and Enter — Sonata emits `prompt:submitted`, the
   * Enter grants directory trust, and the prompt itself is discarded.
   *
   * The reproduction is an A/B PAIR, and reading the right file matters:
   *   …/q25-boot-latch-vs-trust.untrusted-forced.PRE-FIX.capture.txt
   *       this term reverted (the grid belt below LEFT IN PLACE) — latch at
   *       161ms, delivery at 1028ms with `dialogOnScreenAtDelivery: true`.
   *   …/q25-boot-latch-vs-trust.untrusted-forced.capture.txt
   *       the shipped build — never latches, `deliveredAtMs: null`, and the
   *       dialog is still unanswered at the end of the watch.
   * Both at codex-cli 0.152.1, same probe, same arranged race. The PRE-FIX half
   * also settles which leg carries the fix: with ONLY the grid belt in place the
   * incident still reproduced, because `canDeliver()` never consults
   * `acceptsPromptInput()` — once the latch is open, nothing re-gates the write.
   * So this term is the fix and the belt is the belt; do not relax this one on
   * the theory that the other covers it.
   *
   * NOT a needle on the draft's own text. `? for shortcuts` IS draft-transient
   * at 0.152.0 (MEASURED: present in the ≤270ms frames, absent from the resolved
   * composer), so by last-index ranking a `bootDialogHints` entry would in fact
   * discriminate — the first write-up of this gap was wrong to say otherwise.
   * It is rejected on two better grounds. It is not reliably MATCHABLE: the
   * string reached the reconstructed grid but not the pty tail contiguously in 2
   * of the 3 measured boot arms (cell-diff repaint), and the guard reads the
   * tail. And it is an accident where the confidence term is a fact: "which
   * footer string does this build happen to print while loading" is upstream
   * trivia that moves every release, while "has the CLI told us the model and
   * cwd it is running" is the same semantic property the medium/low split
   * already encodes everywhere else in this file.
   *
   * THE DELIBERATE CONSEQUENCE, chosen rather than incurred: a codex spawn whose
   * footer NEVER resolves never latches, so a queued prompt stays queued. The
   * reachable case is a session that cannot take prompts anyway — logged out
   * (the boot parks on the login onboarding screen), or offline so the model
   * catalog never answers. MEASURED for the logged-out arm in
   * `q26-unauthenticated-latch.capture.txt`. Sending a prompt into either would
   * paste it into a screen that will never run it; holding is the honest
   * outcome, and it is VISIBLE rather than silent — `bootLatched` is surfaced on
   * `DeliveryTaskState` as the "is the CLI still starting?" display bit, so the
   * queue reads "still starting" instead of pretending to have sent. That is the
   * opposite of the invisible hold S3 decision A warns about.
   *
   * The hook short-circuit is honoured — and is INERT for codex today, which is
   * worth saying plainly so nobody reads it as load-bearing. `bootLatched` never
   * re-arms (`noteSessionBoundary` only refreshes the grace), so this predicate
   * is consulted ONLY during initial boot; and codex emits `SessionStart` lazily,
   * with the first `UserPromptSubmit`, which cannot happen before the latch it
   * gates. So for codex the term is provably false whenever it is evaluated, and
   * for claude the provider test already returns true ahead of it. It is kept
   * deliberately, not by accident: `SessionStart` is the CLI's own declaration
   * that its session is up — strictly stronger evidence than any footer scrape —
   * and if codex ever fires it eagerly, or the latch is ever made to re-arm at a
   * session boundary, this is the term that keeps a provably-live session from
   * hanging on a footer that never resolves. One boolean read for a guard whose
   * absence would be a wedge.
   *
   * Claude is untouched: its boot interstitials have their own guard family
   * (`isRewindPanelOpen`, `isFullscreenOfferOpen`, the workspace-trust needles),
   * and claude's composer carries no equivalent model/cwd footer to key on.
   *
   * Cost: one extra `detectIdlePrompt` scan per pump, ONLY while unlatched and
   * ONLY for codex — `pump()` stops calling this the moment the latch opens.
   */
  acceptsFirstPrompt(): boolean {
    if (!this.acceptsPromptInput()) {
      return false;
    }
    if (this.hookSessionStarted || this.profile.provider !== "codex") {
      return true;
    }
    return detectIdlePrompt(this.rawTail, this.profile).confidence === "medium";
  }

  /**
   * Claude's Rewind restore picker is on screen (claude ≥2.1.216; an Esc pair at
   * an idle composer opens it — see STOP_ESC_RETRY_MIN_MS for Sonata's own
   * exposure, and `claudeRewindPanelOpen` for the measured frames).
   *
   * A SCREEN OWNER, joining `approvalActive` and `controlSwitch.hasPending()` at
   * the same four gates: readiness (above), `canDeliver`, `submitPrompt` and the
   * Enter-retry ladder. It has to be its own gate rather than ride the
   * idle-prompt ordering, because after the boot latch opens nothing re-reads
   * that scrape — delivery is send-is-send from then on (S6).
   *
   * This is a deliberate, narrow exception to S3 decision A ("a slash-opened
   * panel does not hold delivery — a paste into a panel the user opened is
   * visible and recoverable, an invisible hold is the S1 wedge class"). Both of
   * that decision's premises fail here and only here: the panel's Enter is a
   * RESTORE, so a mis-delivery is NOT recoverable; and the hold is not invisible
   * — it carries a delivery-state flag and its own composer status line
   * ("Rewind panel open…"). It also self-clears with no event needed: the
   * dismissal repaints the composer, and the blocked queue re-pumps on the
   * 500ms poll.
   *
   * Reads the SCREEN GRID (D-1's standing rule: a state query belongs on the
   * grid). The stream cannot answer this — see `claudeRewindPanelOpen` for the
   * measured per-line-diff failure that forced the migration.
   *
   * SYNCHRONOUS `viewportText()`, not the `whenSettled` deferral the approval
   * scan and the switch engine use, because every caller here is a synchronous
   * predicate (`acceptsPromptInput`, `canDeliver`, `submitPrompt`,
   * `nudgePromptSubmit`, the switch guards) and a callback cannot answer them.
   * That is sound: per `TaskScreenModel`'s contract a naked read is
   * stale-but-consistent — a complete byte-stream PREFIX, never torn. The two
   * staleness edges are NOT symmetric, and the honest reading is:
   *   - DISMISSAL (grid still shows the panel): reads open → holds → SAFE, and
   *     it self-corrects on the delivery pump's 500ms re-poll.
   *   - OPENING (grid has not yet parsed the panel's write): reads closed. This
   *     is the unsafe edge, bounded by one write-drain: `@xterm` parses at least
   *     by the next microtask, so every timer- and event-driven caller is past
   *     it (the approval/switch events that re-pump are themselves emitted from
   *     inside `whenSettled`, i.e. after the drain). It survives only for a
   *     caller firing in the same turn as the panel's own pty batch — and the
   *     one Esc pair Sonata itself could emit is now impossible by
   *     STOP_ESC_RETRY_MIN_MS, so reaching it means the user pressed Esc Esc in
   *     the CLI and hit Send in Sonata inside the same microtask.
   * Rejected: holding whenever writes are pending. During any active turn writes
   * are always pending, and claude delivery is write-through mid-turn, so that
   * would wedge the normal path to defend a microtask.
   *
   * No screen model means no PTY — read closed rather than hold, matching every
   * other gate here (`!this.ptyProcess` already refuses upstream).
   *
   * Codex has no such panel; the predicate is claude-only so a codex frame can
   * never reach a claude-shaped needle.
   */
  isRewindPanelOpen(): boolean {
    if (this.profile.provider !== "claude" || !this.screenModel) {
      return false;
    }
    return claudeRewindPanelOpen(this.screenModel.viewportText());
  }

  /**
   * The permission mode claude's composer footer is currently showing, or null
   * if the screen cannot answer (codex; no screen model; the mode-line row not
   * legible right now).
   *
   * The stepping engine's ORIGIN read (SL-5). The engine's per-step receipts
   * already come off the mode line; this asks the same parser the same question
   * one beat earlier — "which mode am I in BEFORE the first press" — so the
   * landing validator is anchored on the session rather than on
   * `task.permissionMode`, whose hook-fed reconcile was MEASURED to lag an
   * undriven flip indefinitely (q18 arm G: no hook fires for a native
   * Shift+Tab; the next turn corrects it). See `startPermissionSwitch` for the
   * seven-press failure that lag caused.
   *
   * Reads the SCREEN GRID, per D-1's standing rule that a state query belongs
   * on the grid — and here the grid is not merely preferred but required: the
   * pty tail is CUMULATIVE, so it still holds every mode line the session ever
   * printed, and "most recent match wins" on a tail that survived a repaint
   * cannot distinguish the current footer from a scrolled-past one. The grid
   * converges to what is displayed.
   *
   * SYNCHRONOUS `viewportText()` for the same reason `isRewindPanelOpen` is —
   * the caller is a synchronous predicate and a naked read is
   * stale-but-consistent. Both staleness edges are benign here: the value it
   * answers with is one the user set seconds ago at the earliest, and a read
   * that lands mid-repaint returns null (no legible row) rather than a wrong
   * mode, because the parser is glyph-anchored.
   */
  screenPermissionMode(): ClaudePermissionMode | null {
    if (this.profile.provider !== "claude" || !this.screenModel) {
      return null;
    }
    return parseClaudePermissionModeLine(this.screenModel.viewportText());
  }

  /**
   * Claude's fullscreen-renderer BOOT offer is on screen (claude 2.1.257;
   * MEASURED frames + the delivery-into-the-offer experiment in
   * `claudeFullscreenOfferOpen`). A screen owner for READINESS: the boot latch
   * must not open on it, because the Enter that opens delivery answers the
   * offer, destroys the queued prompt and re-execs the CLI under a different
   * renderer.
   *
   * READINESS ONLY, and deliberately not the other three gates the Rewind panel
   * feeds (`canDeliver`, `submitPrompt`, `nudgePromptSubmit`). Those are all
   * POST-latch paths, and this offer is strictly PRE-latch: it paints between
   * the trust grant and the alternate-screen switch, before the session starts,
   * and the boot latch is what unlocks every one of them. Holding
   * `acceptsPromptInput()` therefore holds all of them, and adding gates for a
   * state that cannot exist behind them would be scaffolding, not safety. If a
   * future sync moves an interstitial of this class past the latch, THAT is when
   * it earns the Rewind panel's full treatment.
   *
   * Sonata NEVER answers it — same standing rule as the Rewind panel and the
   * codex trust dialog. The two answers are a renderer choice for the user's own
   * tool; the human answers in the co-visible Terminal and the hold clears by
   * itself when the composer paints (the delivery pump re-polls this gate).
   *
   * SYNCHRONOUS `viewportText()` and grid-not-stream, for the reasons spelled
   * out on `isRewindPanelOpen` above; the staleness asymmetry is the same, and
   * the safe edge (reads open → holds) is the one this predicate can hit.
   *
   * Codex has no such offer; claude-only so a codex frame can never reach a
   * claude-shaped needle.
   */
  isFullscreenOfferOpen(): boolean {
    if (this.profile.provider !== "claude" || !this.screenModel) {
      return false;
    }
    return claudeFullscreenOfferOpen(this.screenModel.viewportText());
  }

  /** The SessionStart hook arrived for this PTY's session (startup, resume,
   *  or /clear) — record the CLI's own boot declaration. */
  noteHookSessionStart(): void {
    this.hookSessionStarted = true;
  }

  startTask(options: StartTaskOptions = {}): StartedPty {
    this.disposeProcess();

    const cwd = path.resolve(options.cwd ?? this.defaultWorkspace);
    fs.mkdirSync(cwd, { recursive: true });
    this.cwd = cwd;
    this.startedAt = Date.now();
    this.rawTail = "";
    this.approvalActive = false;
    this.lastApprovalKind = null;
    this.lastApprovalFingerprint = null;
    this.lastApprovalDecision = null;
    this.lastApprovalDecisionAt = null;
    this.brokerExpiryResurfaceAt = null;
    this.approvalSuppressedInSettleWindow = false;
    this.activeApprovalOptionKeys = null;
    this.activeApprovalWalk = null;
    this.brokerAnsweredFingerprint = null;
    // The broker-ON gate requires an EXPLICIT approvalBroker:true — production
    // sets it in buildStartOptions (the broker is always constructed), while a
    // bare-host test that omits it (no controller, no broker running) stays
    // gate-OFF so its scraped panel still surfaces. `false` (native-approval
    // mode) is also gate-OFF: the scrape is the channel there. Gates the grid
    // scrape's native surfacing (S4b R1).
    this.approvalBrokerOn = options.approvalBroker === true;
    this.hookSessionStarted = false;
    this.clearPersistReceiptTimers();
    this.clearNativeAnswerRecheckTimers();
    this.activeRun = null;
    this.recentAttributionRun = null;
    this.activeRunRaw = "";
    this.sustainedIdleVerdict = null;
    // A wake belongs to the session that announced it: a fresh spawn is a new
    // session, and the old session's background work can never wake this one.
    this.runAwaitingWake = null;
    this.taskReady = false;
    this.clearCompletionTimer();
    this.clearApprovalSettleTimer();
    this.clearApprovalScanTimer();
    this.remoteControlActive = false;
    this.remoteControlUrl = null;
    this.remoteControlScan = "";
    // AtomicWriter reset (review F5). disposeProcess() above cancels the deferred
    // writes and the stop-hygiene flags, but the write-lock DEPTH and the buffered
    // human keystrokes are not stop-hygiene — a PTY death mid-sequence (endSonataWrite
    // only flushes when a live pty brings the depth to 0) leaves `pendingHumanInput`
    // holding stale bytes and `sonataWriteDepth` > 0, so the NEXT session's first
    // automation sequence would flush those bytes into its first command. Reset the
    // write-lock/human-input state to a clean slate for the new PTY. (humanSettleTimer
    // is only cleared by disposeProcess on the non-crash path, so clear it here too.)
    this.sonataWriteDepth = 0;
    this.pendingHumanInput = "";
    this.lastHumanInputAt = 0;
    if (this.humanSettleTimer) {
      clearTimeout(this.humanSettleTimer);
      this.humanSettleTimer = null;
    }
    this.controlSwitch.clear();
    this.startFileWatcher(cwd);

    const command = options.command ?? this.profile.defaultCommand;
    const args = Array.isArray(options.args)
      ? options.args
      : this.profile.buildArgs({
          ...options,
          cwd,
        });
    // FAN-OUT #1 (boot). The single clamp for this task's geometry: the PTY,
    // both grids, the rendered mirror and the `task:started` payload all read
    // from this one value, so none of them can be sized differently from the
    // terminal the CLI is wrapping its text to.
    const dimensions = normalizeTerminalDimensions(options.cols, options.rows);

    this.ptyProcess = pty.spawn(command, args, {
      name: "xterm-256color",
      cols: dimensions.cols,
      rows: dimensions.rows,
      cwd,
      env: ptyEnvironment(options.extraEnv),
    });
    // Fresh teardown token for THIS process (see the field's note). Assigned
    // after the spawn, so the `disposeProcess()` at the top of startTask stamped
    // the OUTGOING process's token, not this one's.
    const teardown = { sonataInitiated: false };
    this.processTeardown = teardown;
    // Main-process mirror of the rendered buffer, sized to the PTY, so a
    // (re)opened terminal window can restore recent scrollback (snapshot+tail).
    this.scrollback = new TerminalScrollback(dimensions);
    // Headless screen model (S4b), same PTY size — the approval detector reads
    // its reconstructed grid. Fed once per batch in handlePtyData, resized with
    // the PTY, disposed in disposeProcess.
    this.screenModel = new TaskScreenModel(dimensions);

    this.ptyProcess.onData((data) => this.ingestPtyData(data));
    this.ptyProcess.onExit((exit) => {
      // Flush any coalesced tail BEFORE exit handling (S3): the pending batch
      // must broadcast as `pty:data` (with a live scrollback seq) ahead of
      // `pty:exit`, or a produced tail byte would either be lost or arrive
      // AFTER the exit event — reordering the stream. onExit is the crash path
      // and does NOT route through disposeProcess, so this flush is its own;
      // ptyProcess and the mirror are still live here (nulled below).
      this.flushPtyData();
      // RC never outlives the process — clear it so the header button
      // doesn't keep showing "on" for a dead/crashed session.
      if (this.remoteControlActive) {
        this.setRemoteControlActive(false, null);
      }
      // A switch still awaiting its receipt when the PTY dies never gets one —
      // drop the watch + timeout so it can't fire needs-attention on a dead
      // session. onExit is the crash path (it does NOT route through
      // disposeProcess), so this clear is its own. The renderer clears
      // `view.controlSwitch` off the pty:exit event below.
      this.controlSwitch.clear();
      this.emitEvent("pty:exit", {
        taskId: this.taskId,
        generation: this.generation,
        runId: this.activeRun ? this.activeRun.id : null,
        exitCode: exit.exitCode,
        signal: exit.signal ?? null,
        elapsedMs: this.startedAt ? Date.now() - this.startedAt : null,
        // Whether SONATA killed this process (SL-6). Read off the token this
        // closure captured at spawn — never the host field, which by now may
        // belong to a replacement PTY. The exit CODE is not a substitute: codex's
        // silent-exit class (#36005) leaves no stderr and no crash report, so a
        // crash is indistinguishable from a clean quit by status alone.
        sonataInitiated: teardown.sonataInitiated,
      });
      this.finishActiveRun("pty-exited", "PTY exited", {
        completionSource: "pty-exit",
        completionConfidence: "high",
      });
      this.ptyProcess = null;
      // Stop hygiene must not survive the process it was aimed at: a leaked
      // stopEscRetry could fire an Esc into the NEXT session within its 45s
      // window (review F8).
      this.clearStopHygieneState();
    });

    this.emitEvent("task:started", {
      taskId: this.taskId,
      provider: this.profile.provider,
      model: options.model?.trim() || null,
      reasoningEffort: options.reasoningEffort ?? null,
      speedMode: options.speedMode ?? null,
      command,
      args,
      cwd: redactPath(cwd),
      // The clamped pair, never the caller's raw request: this event is the
      // public record of what the PTY was actually built at, and a consumer
      // reading it must see the geometry the CLI is wrapping its text to.
      // NOTE (SL-9 review M1): the `StatusRegionTracker`'s own `task:started`
      // handler does NOT receive this in production — startTask emits
      // synchronously, before the controller has registered the runtime the
      // event router looks up. The tracker is sized from `StartedPty.dimensions`
      // instead; this payload's clamped-ness is for every OTHER reader.
      rows: dimensions.rows,
      cols: dimensions.cols,
      persistence: "raw-terminal-memory-only",
    });

    // Spawned with `--remote-control`: arm our state immediately (symmetric with
    // injectRemoteControl). Activation is OUR signal, never the scraped URL — so
    // disconnect detection is armed from the start even if the URL line never
    // scrapes cleanly, and the URL scrape becomes pure link-capture (below).
    if (options.remoteControl) {
      this.setRemoteControlActive(true);
    }

    // Boot watchdogs: surface the two codex screens that can park a boot instead
    // of the composer — the "Update available!" gate (S4) and the directory-trust
    // dialog (codex-trust S2). Codex-only; one-shot; neither ever writes a key.
    if (this.profile.provider === "codex") {
      this.codexBootUpdateTimer = setTimeout(() => {
        this.codexBootUpdateTimer = null;
        this.checkCodexBootUpdatePrompt();
      }, CODEX_BOOT_UPDATE_CHECK_MS);
      this.codexBootUpdateTimer.unref?.();
      this.codexTrustDialogTimer = setTimeout(() => {
        this.codexTrustDialogTimer = null;
        // Read the grid only once every pending write has drained, so the check
        // sees the COMPLETE boot frame rather than a mid-parse one (the same
        // discipline as the approval scan). No screen model means no PTY, and
        // therefore no detection — the grid is the only substrate this signature
        // has, so its absence reads "nothing on screen", never "hold".
        this.screenModel?.whenSettled(() => this.checkCodexBootTrustDialog());
      }, CODEX_BOOT_TRUST_DIALOG_CHECK_MS);
      this.codexTrustDialogTimer.unref?.();
    }

    return {
      pid: this.ptyProcess.pid,
      cwd,
      command,
      args,
      dimensions,
    };
  }

  /**
   * The boot watchdog elapsed. If the composer is STILL not ready AND the PTY tail
   * matches codex's "Update available!" gate signature, surface a passive
   * needs-attention banner so the user resolves it in the terminal. RED LINE: we
   * NEVER write a key — running `brew upgrade` or pressing Enter blind is the
   * user's call. The `acceptsPromptInput()` guard means a session that booted fine
   * (composer up) never fires, even if stale update text lingers in the tail.
   */
  private checkCodexBootUpdatePrompt(): void {
    if (
      !this.ptyProcess ||
      this.acceptsPromptInput() ||
      !isCodexUpdatePrompt(cleanTerminal(this.rawTail))
    ) {
      return;
    }
    this.emitEvent("codex-update-prompt:detected", { taskId: this.taskId });
  }

  /**
   * The trust-dialog boot watchdog elapsed. If the composer is STILL not ready
   * AND the reconstructed SCREEN matches codex's directory-trust dialog, surface
   * a passive needs-attention banner so the user answers it in the CLI window.
   *
   * RED LINE: Sonata NEVER answers this dialog. Not a key, not an Enter, not
   * ever. One of its two answers is a consent decision about what a folder's own
   * `.codex/` layer may load; the other QUITS the process. This method emits an
   * event and writes NOTHING to the pty — the same standing rule the claude
   * Rewind panel carries (`tui-parsers-claude.ts:210-220`), and the direct lesson
   * of 2026-07-17, when a delivery's Enter silently answered this very dialog.
   * S1's unconditional pre-trust is not a counter-example: that is a decision
   * taken before the CLI starts, from a folder-pick gesture the user actually
   * made. Answering a screen already on the user's display is a different act.
   *
   * Reads the GRID, not the tail (D-1 — see `isCodexTrustDialog`). The
   * `acceptsPromptInput()` guard means a session that booted fine never fires,
   * and the grid's own convergence means an already-answered dialog is simply not
   * on screen.
   */
  private checkCodexBootTrustDialog(): void {
    if (
      !this.ptyProcess ||
      this.acceptsPromptInput() ||
      !isCodexTrustDialog(this.approvalScanGrid())
    ) {
      return;
    }
    this.codexTrustDialogSurfaced = true;
    this.emitEvent("codex-trust-dialog:detected", { taskId: this.taskId });
  }

  /**
   * The raised trust-dialog banner has nothing left to point at (plan L2). Runs
   * on the coalesced settled-grid scan while — and only while — the banner is up,
   * so the banner retires the moment the human answers instead of waiting for
   * `pty:exit` the way its update-gate template must.
   *
   * The retirement test is the exact NEGATION of what raised it: the banner
   * asserts a conjunction (no composer AND the dialog on screen), so it stands
   * down as soon as EITHER conjunct fails. Both disjuncts are real signals of
   * "answered", and they are independent, which is the point:
   *   - the dialog left the SCREEN — plan L2's mechanism, and the reason this
   *     signature reads the grid at all (an answered dialog's bytes never leave
   *     the tail, which is why the update banner cannot do this);
   *   - the composer ACCEPTS INPUT — the readiness fence the codex
   *     `bootDialogHints` guard holds shut for exactly as long as this dialog is
   *     unanswered (`detectIdlePrompt`; pinned by tests/smoke/task-ready-
   *     detection.mjs, whose measured post-trust screen reads ready with the
   *     dialog text still in the scanned window).
   * SL-6 NARROWED the second leg, and the narrowing goes further than it first
   * looks. Now that `isCodexTrustDialogOpen()` is ranked inside
   * `acceptsPromptInput()`, a SCRAPE-derived composer can no longer read ready
   * while the dialog's cells are on the grid. The hook path cannot rescue it AT
   * BOOT either: codex emits `SessionStart` LAZILY — with the first
   * `UserPromptSubmit`, not at spawn (probed at 0.144.4 and 0.144.5;
   * runtime-controller's `watchHooks` documents the same fact and declines to
   * arm a spawn-anchored liveness window because of it) — and a first
   * UserPromptSubmit requires a delivery, which requires the very boot latch
   * this dialog is guarding. So during a codex boot `hookSessionStarted` is
   * PROVABLY false, and **leg 1 (the dialog leaves the screen) is the only
   * operative leg there**.
   *
   * Leg 2 is not dead — it is now a pin for sessions whose hook HAS fired: after
   * the first submit, across `/clear`, and on resume, where an answered dialog's
   * cells can still be scrolling up the viewport. The smoke keeps it green by
   * calling `noteHookSessionStart()` by hand, which is honest for exactly those
   * states and is not a boot scenario.
   *
   * This STRENGTHENS the ranking decision rather than complicating it: because
   * the hook is provably unset during a codex boot, ranking the grid predicate
   * below the hook short-circuit cannot be bypassed pre-answer — there is no
   * pre-answer state in which the short-circuit fires. The ranking buys its
   * false-hold protection for the post-answer case at zero cost to the case it
   * guards. Residual, unchanged: a HOOKLESS codex spawn (profile write failed)
   * whose answered dialog lingers on the grid keeps the banner up until the
   * repaint clears it — MEASURED at ~220ms (q25: the dialog owned the grid at
   * the delivery instant and was gone from the next sampled frame) — and the
   * failure direction is a stale "go answer it" banner, never a write.
   *
   * The second leg is not belt-and-braces — on the real spawn it is likely the
   * one that fires. Sonata launches codex with `--no-alt-screen` (see codexArgs),
   * so the answered dialog does NOT vanish with a buffer swap the way an
   * alt-screen modal does: its rows stay inline and scroll up as the welcome box
   * and composer paint beneath them, which can keep them inside a tall viewport
   * for a while. How long is a paint detail Sonata has never measured, and the
   * banner must not be hostage to it. Both legs are pinned independently in
   * tests/smoke/codex-trust-dialog.mjs precisely so neither can quietly become
   * the only one that works.
   *
   * One-shot per detection, by the `codexTrustDialogSurfaced` gate: no `cleared`
   * without a `detected`, and no repeats. That gate is also why this costs
   * nothing on the hot path — it is false for every session that never saw the
   * dialog, which after S1's unconditional pre-trust is essentially all of them.
   */
  private checkCodexTrustDialogCleared(): void {
    if (!this.codexTrustDialogSurfaced) {
      return;
    }
    if (!this.acceptsPromptInput() && isCodexTrustDialog(this.approvalScanGrid())) {
      return;
    }
    this.codexTrustDialogSurfaced = false;
    this.emitEvent("codex-trust-dialog:cleared", { taskId: this.taskId });
  }

  writeRaw(data: string): void {
    if (!this.ptyProcess) {
      throw new Error("No PTY process is running.");
    }
    this.ptyProcess.write(data);
  }

  /**
   * Inject `/remote-control` out-of-band (NOT via the delivery queue). claude
   * handles `/rc` as a client-side command in parallel with any active turn, so
   * this works mid-stream (verified 2026-06-27, claude 2.1.195). Held under the
   * write-lock so a human keystroke mid-inject buffers instead of splitting the
   * paste. An open approval panel would swallow the command, so we refuse in that
   * state and report it rather than flip to a false "on".
   *
   * WHAT IT DOES, re-measured at 2.1.258 (SL-11, rc3/rc5): from OFF it connects
   * AND opens claude's native Remote Control panel (Disconnect / Show QR /
   * Continue, cursor on Continue) in the SAME move — the 2.1.195 note that a
   * connect and a panel were two separate invocations no longer holds. A second
   * injection while that panel is up DISMISSES it and leaves `/remote-control`
   * in the composer, so this is not an idempotent "show me the panel" call.
   * `manageRemoteControl` is still correct (it injects once, on a session whose
   * panel is closed, and switches the user to the terminal); `enableRemoteControl`
   * leaves that panel open behind Sonata's own UI — registered in SL-11's
   * findings (F4d), not fixed here.
   */
  injectRemoteControl(): RemoteControlInjectResponse {
    if (!this.ptyProcess) {
      return { ok: false, reason: "no-process" };
    }
    if (this.approvalActive) {
      return { ok: false, reason: "panel-open" };
    }
    // The write-lock (beginSonataWrite) only BUFFERS human keystrokes; it does NOT
    // serialise two automation writers. If a prompt delivery is mid-sequence (its
    // deferred paste/Enter still pending), injecting now would interleave `/rc`
    // bytes with the prompt's — refuse and let the caller retry once it clears.
    if (this.sonataWriting) {
      return { ok: false, reason: "busy" };
    }
    this.beginSonataWrite();
    this.ptyProcess.write(`${BRACKETED_PASTE_START}/remote-control${BRACKETED_PASTE_END}`);
    // Defer the Enter under the held lock (mirrors the prompt-delivery path): a
    // human keystroke landing in the gap buffers rather than splitting the frame.
    this.deferSonataWrite(
      120,
      () => {
        if (this.ptyProcess) {
          this.ptyProcess.write(CSI_U_ENTER);
        }
      },
      "control",
    );
    this.endSonataWrite();
    // Optimistic: we asked to connect. The scraped URL confirms + carries the
    // link. A second invocation opens the panel (still active), so flipping to
    // true is always correct here.
    this.setRemoteControlActive(true);
    return { ok: true };
  }

  private setRemoteControlActive(active: boolean, url?: string | null): void {
    const nextUrl = url === undefined ? this.remoteControlUrl : url;
    if (this.remoteControlActive === active && this.remoteControlUrl === nextUrl) {
      return;
    }
    this.remoteControlActive = active;
    this.remoteControlUrl = nextUrl;
    // Fresh scan window per transition: prevents a stale "disconnected" (or a
    // stale URL) in the rolling tail from firing again right after a reconnect.
    this.remoteControlScan = "";
    this.emitEvent("remote-control:state", {
      taskId: this.taskId,
      active: this.remoteControlActive,
      url: this.remoteControlUrl,
    });
  }

  /**
   * Remote Control has NO hook/structured channel (confirmed), so we read the
   * TUI — but ONLY while we already believe RC is on. Activation is always OUR
   * own signal (`injectRemoteControl` or the `--remote-control` spawn flag), never
   * a scraped URL: a `claude.ai/code/session_…` link can appear in model output, a
   * file, or a RESUMED transcript, and must not flip RC on with a foreign link.
   *
   * The two signals ride DIFFERENT channels, because they are different kinds of
   * thing (D-1). RE-MEASURED at claude 2.1.258 (SL-11; probes rc3/rc5/rc6):
   *
   *   OFF → the rolling RAW tail, compacted (escapes + ALL whitespace removed),
   *         which survives claude's word-POSITIONED redraw
   *         (`This\x1b[9Gsession\x1b[17Gis…` — words glue after stripping) and a
   *         PTY split landing inside a word or an escape (we accumulate RAW and
   *         strip the whole tail, so a split escape reassembles first). It stays
   *         on the STREAM because it is a one-shot EVENT: rc6 measured
   *         `Remote Control disconnected.` still on the GRID after a reconnect
   *         had already succeeded, so a grid read would call a live session dead.
   *   URL → `screenModel`'s reconstructed grid, NOT the stream. The stream stopped
   *         carrying the link whole — the differential repaint elides characters
   *         already correct on screen, so `https://` reaches the tail as
   *         `https:` + a column jump + `/claude.ai/…`. Full rationale and the
   *         measured bytes: findRemoteControlUrlOnScreen. Read under
   *         `whenSettled`, NOT synchronously (see below).
   *
   * WHY THE URL READ IS DEFERRED, when `screenPermissionMode` reads the same grid
   * synchronously: that one is a PULL — a caller asks at an arbitrary moment, and
   * a stale-but-consistent answer is corrected by simply asking again. This is a
   * PUSH, and one-shot: the only batch that paints the link is the one that
   * triggers this call, and `@xterm`'s WriteBuffer can defer that parse past the
   * synchronous return. MEASURED (SL-11): a naked read here saw the pre-write
   * grid, the alt-screen went quiet immediately afterwards — no further batch,
   * so no second chance — and the link was still unreported 30s later while an
   * independent grid fed the same bytes had it. `whenSettled` runs the read after
   * the batch has drained, which is the same reason
   * `clearApprovalIfAnsweredNatively` is deferred.
   *
   * (channels re-derived 2026-09-01 at 2.1.258; the 2.1.195 form was a single
   * stream read, and the URL half of it had gone intermittently blind.)
   */
  private detectRemoteControlState(data: string): void {
    if (!this.remoteControlActive) {
      return;
    }
    this.remoteControlScan = (this.remoteControlScan + data).slice(-REMOTE_CONTROL_SCAN_LIMIT);
    if (hasRemoteControlDisconnect(compactRemoteControlScan(this.remoteControlScan))) {
      this.setRemoteControlActive(false, null);
      return;
    }
    if (!this.remoteControlUrl) {
      this.screenModel?.whenSettled(() => {
        // Re-checked inside the deferral: between the write and the drain RC can
        // have gone off, the link can have been captured by an earlier batch's
        // callback, or the PTY can have been torn down.
        if (!this.remoteControlActive || this.remoteControlUrl || !this.screenModel) {
          return;
        }
        const url = findRemoteControlUrlOnScreen(this.screenModel.viewportText());
        if (url) {
          this.setRemoteControlActive(true, url);
        }
      });
    }
  }

  /**
   * Kick off a mid-session Claude control switch (mid-session switch program).
   * The idle-only / single-switch guards are shared across every axis; the drive
   * itself forks by kind:
   *   - `model` / `effort` (S1) — inject `/model <id>` / `/effort <level>` as
   *     typed text + Enter and watch for the printed receipt line.
   *   - `permission` (S2) — drive the Shift+Tab (`\x1b[Z`) stepping engine toward
   *     the target mode, reading the TUI mode line as the per-step receipt.
   * `from` is the permission origin (the session's current mode; the return-home
   * anchor); ignored for model/effort.
   *
   * Idle-only, one at a time: an active run, an in-flight Sonata write, an open
   * approval panel, or a prior pending switch all refuse (the renderer also gates
   * on turnActivity — this is the backend guard). RED LINE inheritance: we drive
   * and OBSERVE; a stuck/opaque screen surfaces needs-attention, and we NEVER
   * write anything but the axis's own bytes (no blind-Enter, no non-`\x1b[Z` key).
   */
  injectClaudeControlSwitch(
    kind: ClaudeControlSwitchKind,
    value: string,
    from?: string,
  ): ClaudeControlSwitchResponse {
    return this.controlSwitch.injectClaudeControlSwitch(kind, value, from);
  }

  /** Begin a STAGED claude model+effort Save (S7 Part 1) — see ControlSwitchEngine. */
  startClaudeStagedSwitch(
    model: string | null,
    effort: string | null,
  ): ClaudeControlSwitchResponse {
    return this.controlSwitch.startClaudeStagedSwitch(model, effort);
  }

  /** The user chose a drawer row for a PARKED recognized-confirm dialog (S7 Part 2). */
  answerParkedControlConfirm(rowNumber: number): void {
    this.controlSwitch.answerParkedControlConfirm(rowNumber);
  }

  /**
   * The human's keystrokes into the terminal. The human may type anytime;
   * delivery is never held on "the human is typing" (send-is-send). The one
   * invariant kept here is byte-level atomicity: a keystroke that arrives mid
   * automation-sequence buffers and flushes AFTER it, never interleaving (the
   * AtomicWriter — a split bracketed-paste frame is corruption). `lastHumanInputAt`
   * + the settle pass are retained ONLY to reconcile a native approval the human
   * may answer directly in the terminal (until hook-intercept, S2).
   */
  writeUserInput(data: string): void {
    if (!this.ptyProcess) {
      throw new Error("No PTY process is running.");
    }
    // xterm relays the CLI's terminal-query replies (cursor-position/DSR, device
    // attributes, DECRQM, OSC color, kitty flags) AND mouse reports through the
    // SAME onData path as human keystrokes. None are the human answering a panel,
    // and a redrawing TUI emits them constantly — counting them as activity would
    // keep the approval-reconciliation pass firing forever. Forward them to the
    // PTY (the CLI asked) but never mark them as input.
    if (!isNonTypingTerminalInput(data)) {
      this.lastHumanInputAt = Date.now();
      this.scheduleHumanInputSettle();
    }
    // A lone Esc typed into the Terminal window during a run is the human
    // interrupting natively — the CLI restores the interrupted prompt into
    // its input box just like a Sonata stop (probe C1/X1). Mark the line dirty
    // so the next Sonata injection pre-clears instead of concatenating. Flag
    // only — NO belt timer: the human is driving the terminal and may want
    // to edit the restored text right there.
    if (data === ESC && this.activeRun) {
      this.cliInputMaybeDirty = true;
    }
    if (this.sonataWriting) {
      this.pendingHumanInput += data;
      return;
    }
    this.ptyProcess.write(data);
  }

  /** Re-arm the settle timer on every keystroke; it fires once the human has
   *  been quiet for the activity window (their input burst ended). */
  private scheduleHumanInputSettle(): void {
    if (this.humanSettleTimer) {
      clearTimeout(this.humanSettleTimer);
    }
    this.humanSettleTimer = setTimeout(() => {
      this.humanSettleTimer = null;
      this.onHumanInputSettled();
    }, HUMAN_ACTIVE_WINDOW_MS);
  }

  /** The human just finished a burst of terminal input — they may have answered
   *  a native approval/panel directly. Re-derive readiness from fresh screen
   *  evidence; a held queue re-pumps via the 500ms poll. */
  private onHumanInputSettled(): void {
    if (!this.ptyProcess) {
      return;
    }
    this.clearApprovalIfAnsweredNatively();
    this.scheduleNativeAnswerRecheck();
    this.taskReady = false;
  }

  /** Marks the start of an automation write sequence (a prompt paste, an
   *  approval/option key run, a control-change drive). Nestable; while the depth
   *  is > 0, human keystrokes buffer instead of splitting the sequence (S2). */
  private beginSonataWrite(): void {
    this.sonataWriteDepth++;
  }

  /** Ends one automation write sequence; when the last one finishes, flush any
   *  human keystrokes that arrived mid-sequence so they land contiguously. */
  private endSonataWrite(): void {
    if (this.sonataWriteDepth > 0) {
      this.sonataWriteDepth--;
    }
    if (this.sonataWriteDepth === 0 && this.pendingHumanInput && this.ptyProcess) {
      const buffered = this.pendingHumanInput;
      this.pendingHumanInput = "";
      this.ptyProcess.write(buffered);
    }
  }

  /** Schedule an automation write `ms` from now, holding the write-lock across
   *  the timer gap so a human keystroke in that window buffers rather than
   *  splitting the sequence. Cancellable as a group by stopRun (a canceled
   *  handle releases its write-lock hold without writing). */
  private deferSonataWrite(ms: number, fn: () => void, owner: "prompt" | "control" = "prompt"): void {
    this.beginSonataWrite();
    const handle = { owner, cancel: () => {} };
    const timer = setTimeout(() => {
      this.pendingDeferredWrites.delete(handle);
      try {
        fn();
      } finally {
        this.endSonataWrite();
      }
    }, ms);
    handle.cancel = () => {
      clearTimeout(timer);
      this.pendingDeferredWrites.delete(handle);
      this.endSonataWrite();
    };
    this.pendingDeferredWrites.add(handle);
  }

  /**
   * Paste attachment paths as separate frames, then submit only after the
   * rendered composer proves their chip effects landed. Claude 2.1.214 batches
   * path conversion asynchronously; write completion is not chip completion,
   * and one frame containing multiple paths stays literal on both providers.
   */
  private deferAttachmentSubmission(
    attachments: PromptAttachmentSubmission[],
    trimmed: string,
    owner: "prompt" | "control",
    onEffect?: (at: string) => void,
  ): void {
    this.beginSonataWrite();
    let canceled = false;
    let settled = false;
    const timers = new Set<NodeJS.Timeout>();
    const handle = { owner, cancel: () => {} };
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
      this.pendingDeferredWrites.delete(handle);
      this.endSonataWrite();
    };
    const schedule = (ms: number, fn: () => void): void => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!canceled) {
          fn();
        }
      }, ms);
      timers.add(timer);
    };
    handle.cancel = () => {
      if (settled) {
        return;
      }
      canceled = true;
      finish();
    };
    this.pendingDeferredWrites.add(handle);

    this.writeCliInputClearFlood("pre-submit");
    schedule(ATTACHMENT_EFFECT_POLL_MS, () => {
      void this.renderedImageMarkerCount().then((beforePasteCount) => {
        if (canceled || settled || !this.ptyProcess) {
          return;
        }
        for (const attachment of attachments) {
          this.ptyProcess.write(
            `${BRACKETED_PASTE_START}${shellQuotePath(attachment.path)}${BRACKETED_PASTE_END}`,
          );
        }
        if (owner === "prompt") {
          // The paths are in the composer now — a stop from here on can no longer
          // honestly claim nothing reached the CLI.
          this.promptTextReachedComposer = true;
        }
        const pastedAt = Date.now();
        schedule(ATTACHMENT_SUBMIT_SETTLE_MS, () => {
          if (!this.ptyProcess) {
            finish();
            return;
          }
          if (trimmed) {
            this.ptyProcess.write(`${BRACKETED_PASTE_START}${trimmed}${BRACKETED_PASTE_END}`);
          }
          const checkEffect = (): void => {
            void this.renderedImageMarkerCount().then((currentCount) => {
              if (canceled || settled || !this.ptyProcess) {
                return;
              }
              const timedOut = Date.now() - pastedAt >= ATTACHMENT_EFFECT_TIMEOUT_MS;
              // An inconclusive marker read (snapshot unavailable → null) is
              // NOT a satisfied effect: never fall toward an early Enter. The
              // bounded timeout is the floor that still fires it.
              const effectSatisfied =
                beforePasteCount !== null &&
                currentCount !== null &&
                attachmentChipEffectSatisfied(
                  beforePasteCount,
                  currentCount,
                  attachments.length,
                  trimmed,
                );
              if (effectSatisfied || timedOut) {
                this.ptyProcess.write(CSI_U_ENTER);
                // The sequence has pressed Enter — signal the effect epoch so
                // delivery re-stamps its receipt/heal timing off the real
                // submit, not submitPrompt's synchronous return. Fires once,
                // whether Enter came from a satisfied effect or the fallback.
                onEffect?.(new Date().toISOString());
                // An effect can still materialize after the bounded fallback.
                // The next send must fence the composer even when this one
                // appeared clean at Enter time (probe P2).
                this.cliInputMaybeDirty = true;
                if (needsCodexSkillMentionEnter(this.profile.provider, trimmed)) {
                  // Codex's bare-$name popup consumes the first Enter to insert
                  // the mention (probe s3b); the second remains owned by this
                  // cancellable sequence so Stop cannot submit it afterwards.
                  schedule(320, () => {
                    if (this.ptyProcess) {
                      this.ptyProcess.write(CSI_U_ENTER);
                    }
                    finish();
                  });
                } else {
                  finish();
                }
                return;
              }
              schedule(ATTACHMENT_EFFECT_POLL_MS, checkEffect);
            });
          };
          checkEffect();
        });
      });
    });
  }

  /**
   * Count rendered image markers for attachment effect verification. Returns
   * `null` when the count is inconclusive (a snapshot read that threw) so the
   * caller keeps polling to the bounded timeout instead of acting on a
   * rawTail-inflated number.
   *
   * Content-sensitivity limit (accepted this slice, not fixed): the markers are
   * counted over the WHOLE rendered screen, so markers that are not this paste's
   * chips — e.g. a claude mid-turn write-through echoing `[Image #N]` text —
   * move the count too. The delta+timeout design tolerates this (a spuriously
   * high count only ever satisfies EARLIER within the bound, never past it), but
   * it cannot isolate the composer region; a screen-local counter is the real
   * fix and is out of scope here.
   */
  private async renderedImageMarkerCount(): Promise<number | null> {
    try {
      const snapshot = await this.serializeScrollback();
      // A null snapshot means no live terminal mirror — which, in a running
      // session, only coincides with a null ptyProcess (both are torn down
      // together in disposeProcess, and the caller guards on ptyProcess). So
      // this rawTail read is self-consistent across the whole sequence in
      // production and only exists for pre-mirror test hosts; it is NOT the
      // dangerous baseline/current mix (that is the throw path — see below).
      const rendered = snapshot?.data ?? this.rawTail;
      return cleanTerminal(rendered).match(IMAGE_MARKER_RE)?.length ?? 0;
    } catch {
      // Snapshot READ FAILED. Do NOT fall back to counting this.rawTail: the
      // linear PTY stream repaints the same marker, so a rawTail count read
      // against a snapshot baseline inflates the delta toward an EARLY Enter —
      // the one direction effect verification promises is impossible. Treat the
      // poll as inconclusive; the bounded ATTACHMENT_EFFECT_TIMEOUT_MS is the
      // floor that still fires the Enter without stranding the write lock.
      return null;
    }
  }

  /** Cancel every deferred automation write that has not fired. Returns how
   *  many PROMPT-owned writes were canceled (0 = the prompt's bytes were all
   *  out; canceled control writes — /stop, /rc Enter — don't count, review
   *  F3: they must never mark a delivered prompt undelivered). */
  private cancelPendingDeferredWrites(): number {
    let promptCancels = 0;
    for (const handle of [...this.pendingDeferredWrites]) {
      if (handle.owner === "prompt") {
        promptCancels += 1;
      }
      handle.cancel();
    }
    return promptCancels;
  }

  private get sonataWriting(): boolean {
    return this.sonataWriteDepth > 0;
  }

  /** True within the activity window of the human's last terminal keystroke.
   *  Used only to reconcile a natively-answered approval (handlePtyData +
   *  onHumanInputSettled) — NOT to hold delivery (send-is-send). */
  isHumanActivelyTyping(): boolean {
    return (
      this.lastHumanInputAt > 0 && Date.now() - this.lastHumanInputAt < HUMAN_ACTIVE_WINDOW_MS
    );
  }

  /**
   * A natively-answered approval leaves no decision event of its own — the
   * human's keys are invisible to the automation flags, and a stuck
   * approvalActive wedges the delivery gate forever. Screen evidence is the
   * source of truth: when the approval text is gone (or the idle prompt
   * rendered after it), the screen WAS answered. Only evaluated around
   * take-over, where native answers are possible.
   */
  private clearApprovalIfAnsweredNatively(): void {
    if (!this.approvalActive) {
      return;
    }
    const candidate = detectApprovalCandidate(this.approvalScanGrid(), this.profile);
    if (candidate && !candidate.promptAfterApproval) {
      return;
    }
    const previousKind = this.lastApprovalKind;
    this.approvalActive = false;
    this.lastApprovalDecision = "answered-natively";
    this.lastApprovalDecisionAt = Date.now();
    this.approvalSuppressedInSettleWindow = false;
    this.taskReady = false;
    this.emitEvent("approval:decision", {
      taskId: this.taskId,
      runId: this.activeRun ? this.activeRun.id : null,
      decision: "answered-natively",
      encodedAs: "native-keys",
      previousKind,
    });
    this.updateActiveRun({
      status: "active",
      lifecyclePhase: "resumed-after-approval",
      approvalDecision: "answered-natively",
      approvalKind: previousKind ?? "unknown",
    });
  }

  private scheduleNativeAnswerRecheck(): void {
    this.clearNativeAnswerRecheckTimers();
    for (const delayMs of [1500, 4000]) {
      this.nativeAnswerRecheckTimers.push(
        setTimeout(() => {
          this.clearApprovalIfAnsweredNatively();
        }, delayMs),
      );
    }
  }

  private clearNativeAnswerRecheckTimers(): void {
    for (const timer of this.nativeAnswerRecheckTimers) {
      clearTimeout(timer);
    }
    this.nativeAnswerRecheckTimers = [];
  }

  /**
   * Receipt-by-observation: snapshot the project's settings.local.json
   * allow rules before the answer keys go out, then re-read on a short
   * ladder. A diff means the CLI persisted a rule — report exactly what it
   * wrote. No diff → no event: receipts are never fabricated.
   */
  private armPersistReceiptWatch(runId: RunId | null): void {
    this.clearPersistReceiptTimers();
    const workspace = this.cwd ?? this.defaultWorkspace;
    const settingsPath = path.join(workspace, ".claude", "settings.local.json");
    const before = readClaudeAllowRules(settingsPath);
    for (const delayMs of [1500, 3000, 6000]) {
      this.persistReceiptTimers.push(
        setTimeout(() => {
          const added = readClaudeAllowRules(settingsPath).filter((rule) => !before.includes(rule));
          if (added.length === 0) {
            return;
          }
          this.clearPersistReceiptTimers();
          this.emitEvent("approval:persisted", {
            taskId: this.taskId,
            runId,
            file: path.join(".claude", "settings.local.json"),
            rulesAdded: added,
          });
        }, delayMs),
      );
    }
  }

  private clearPersistReceiptTimers(): void {
    for (const timer of this.persistReceiptTimers) {
      clearTimeout(timer);
    }
    this.persistReceiptTimers = [];
  }

  submitPrompt(
    text: string,
    options: { createRun?: boolean; attachments?: PromptAttachmentSubmission[] } = {},
  ): PromptSubmission | null {
    const attachments = options.attachments ?? [];
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) {
      return null;
    }
    if (!this.ptyProcess) {
      throw new Error("No PTY process is running.");
    }
    if (this.approvalActive) {
      throw new Error("Cannot submit a prompt while a native approval screen is active.");
    }
    // RED LINE: a mid-session control switch may have a consent/interstitial
    // dialog open (a PARKED codex Full Access confirm has no timeout — it waits
    // for the user). Pasted prompt text + Enter would land on that dialog and
    // auto-answer its default row ("Yes, continue anyway" → silent full-access
    // grant). Delivery already gates on hasPendingControlSwitch upstream; this is
    // the backstop that keeps EVERY submit path honest. Classified as a delivery
    // guard error (re-queue + re-pump), not a hard failure — see
    // isDeliveryGuardError in delivery-controller.
    if (this.controlSwitch.hasPending()) {
      throw new Error("Cannot submit a prompt while a control switch is pending.");
    }
    // Same red line, claude's own interstitial: the Rewind panel's Enter is a
    // RESTORE of the conversation (and possibly the code) to the highlighted
    // row. Delivery gates on isRewindPanelOpen upstream; this is the backstop.
    if (this.isRewindPanelOpen()) {
      throw new Error("Cannot submit a prompt while the rewind panel is open.");
    }

    // A slash command is a single line with no attachments. A folded file/folder
    // reference makes the text multi-line (path on its own line), so the newline
    // check keeps "/cmd + a referenced file" classified as a prompt, not a slash.
    const kind: RunKind =
      trimmed.startsWith("/") && !trimmed.includes("\n") && attachments.length === 0 ? "slash" : "prompt";
    const runText = trimmed || attachmentPromptTitle(attachments.length);
    // Begin a run ONLY when the composer is idle (no active run). A mid-turn
    // send (write-through) must NOT beginRun here: beginRun would finish the
    // live turn as "closed by next input" and orphan it. Its run instead begins
    // when the CLI dequeues it and fires UserPromptSubmit (beginRunFromHook) —
    // the honest start moment. Codex (gated by hasActiveRun) only ever submits
    // when idle, so it is unaffected. createRun:false (e.g. /stop) never begins.
    const run =
      options.createRun === false || this.activeRun ? null : this.beginRun(runText, kind);
    const submittedAt = new Date().toISOString();

    this.taskReady = false;
    this.approvalActive = false;
    this.lastApprovalKind = null;
    this.lastApprovalDecision = null;
    this.lastApprovalDecisionAt = null;
    this.approvalSuppressedInSettleWindow = false;
    this.brokerAnsweredFingerprint = null;
    this.clearApprovalSettleTimer();
    // A run-starting send supersedes any armed stop-Esc retry: an Esc fired
    // now would kill the very turn this submission is starting. A control
    // send (createRun:false — the codex /stop follow-up) is PART of the stop
    // and must not shorten the retry window (review F5).
    const submissionOwner: "prompt" | "control" =
      options.createRun === false ? "control" : "prompt";
    if (submissionOwner === "prompt") {
      this.stopEscRetry = null;
      // A fresh prompt sequence: nothing of ITS bytes is in the composer yet.
      this.promptTextReachedComposer = false;
    }
    // Hold the write-lock across the whole sync+deferred sequence so a human
    // keystroke landing mid-paste buffers (and flushes after) rather than
    // splitting the bracketed-paste frame (S2). The initial begin covers the
    // synchronous attachment writes; each deferred write keeps the depth > 0
    // until it fires, so endSonataWrite() below does not release early.
    this.beginSonataWrite();
    // Suspenders for the post-stop belt: if the CLI's input line may still
    // hold an Esc-restored prompt (fast resend beat the belt timer, or the
    // belt was skipped behind an approval), kill it before ANY of this
    // submission's bytes land — otherwise the paste concatenates onto it
    // (probe C1/C8). No-op on a clean line.
    // Ratchet the flood high-water: prompt lines + one line per pasted
    // attachment path (each is its own composer line).
    this.cliDirtyLineHighWater = Math.max(
      this.cliDirtyLineHighWater,
      trimmed.split("\n").length + attachments.length,
    );
    // Attachment sends press Enter asynchronously (after the effect-verified
    // paste). Expose that moment as `effect` so delivery times its receipt/heal
    // from the real Enter, not this synchronous write time.
    let effect: Promise<string> | undefined;
    if (attachments.length > 0) {
      let resolveEffect!: (at: string) => void;
      effect = new Promise<string>((resolve) => {
        resolveEffect = resolve;
      });
      this.deferAttachmentSubmission(attachments, trimmed, submissionOwner, resolveEffect);
    } else {
      this.writeCliInputClearFlood("pre-submit");
      this.deferSonataWrite(
        0,
        () => {
          if (this.ptyProcess && trimmed) {
            this.ptyProcess.write(`${BRACKETED_PASTE_START}${trimmed}${BRACKETED_PASTE_END}`);
            if (submissionOwner === "prompt") {
              this.promptTextReachedComposer = true;
            }
          }
        },
        submissionOwner,
      );
      this.deferSonataWrite(
        120,
        () => {
          if (this.ptyProcess) {
            this.ptyProcess.write(CSI_U_ENTER);
          }
        },
        submissionOwner,
      );
    }
    // A bare Codex skill mention ("$name") opens the skill-mention popup,
    // whose "Press enter to insert" consumes the first Enter. The second
    // Enter submits the inserted mention. Both steps verified by probe
    // s3b.codexSkillDoubleEnter; with trailing text the popup closes on its
    // own and the extra Enter never fires.
    if (
      attachments.length === 0 &&
      needsCodexSkillMentionEnter(this.profile.provider, trimmed)
    ) {
      this.deferSonataWrite(
        440,
        () => {
          if (this.ptyProcess) {
            this.ptyProcess.write(CSI_U_ENTER);
          }
        },
        submissionOwner,
      );
    }
    // Release the initial begin; the deferred writes hold the depth until they
    // fire, so the lock spans the full sequence.
    this.endSonataWrite();
    // The run this submission belongs to: a freshly-begun run (idle send), or —
    // for a control action that doesn't start one (createRun:false, e.g. /stop)
    // — the run it acts upon. A mid-turn write-through has NO run yet (null);
    // its run begins later on the UserPromptSubmit hook.
    const submissionRunId = run
      ? run.id
      : options.createRun === false
        ? this.activeRun?.id ?? null
        : null;
    this.emitEvent("prompt:submitted", {
      taskId: this.taskId,
      runId: submissionRunId,
      kind,
      chars: trimmed.length,
      attachments: attachments.length,
    });
    return {
      taskId: this.taskId,
      runId: submissionRunId,
      kind,
      submittedAt,
      ...(effect ? { effect } : {}),
    };
  }

  /**
   * Re-send the submit Enter for a prompt whose delivery earned no receipt.
   *
   * WHY: Claude's TUI silently swallows the submit Enter inside a boot-init
   * window (≈[first ❯ paint, +200ms]; probe spikes/first-prompt-enter-race,
   * claude 2.1.210) — the bracketed-paste prompt text buffers into the composer
   * but the Enter is dropped, so a first-of-session prompt can sit unsent until
   * a human presses Enter in the terminal. DeliveryController calls this when an
   * in-flight prompt is still unreceipted after a delay. An extra Enter on an
   * already-empty composer is a harmless no-op, so re-sending is always safe: if
   * the first Enter landed, nothing happens; if it was swallowed, the stuck text
   * finally submits (matches the manual-Enter recovery observed 10/10 in probe).
   *
   * Guards: no PTY → nothing to write; an active approval → a stray Enter would
   * confirm the panel (the caller also guards this, belt-and-suspenders); an
   * in-flight automation sequence (sonataWriting) → never interleave our own bytes
   * mid-paste. Returns whether it wrote.
   */
  nudgePromptSubmit(): boolean {
    // A pending control switch may own a parked consent/interstitial dialog; an
    // Enter re-send would auto-answer its default row (RED LINE — see
    // hasPendingControlSwitch). The Enter-retry ladder refuses while any switch
    // is in flight, mirroring the submitPrompt and canDeliver gates. The same
    // holds for a claude Rewind panel, where the bare Enter this writes IS the
    // restore action — the sharpest form of the exposure, since there is not
    // even pasted text to make it visible.
    if (
      !this.ptyProcess ||
      this.approvalActive ||
      this.sonataWriting ||
      this.controlSwitch.hasPending() ||
      this.isRewindPanelOpen()
    ) {
      return false;
    }
    this.beginSonataWrite();
    this.ptyProcess.write(CSI_U_ENTER);
    this.endSonataWrite();
    return true;
  }

  /**
   * Hook-driven run-start (Claude). The CLI fired `UserPromptSubmit` — a turn is
   * genuinely beginning now (either the first send, or a queued mid-turn send
   * the CLI just dequeued). Begin the run from the prompt the CLI actually
   * received. No-op if a run is already active: the idle-send path already began
   * it via submitPrompt, and this hook (arriving ~300ms later) must not restart
   * it. This is the symmetric half of the `Stop`-hook run completion — the run
   * lifecycle is now bracketed by authoritative CLI signals on both edges.
   */
  beginRunFromHook(prompt: string, options: { promptId?: string | null } = {}): void {
    if (!this.ptyProcess) {
      return;
    }
    const text = prompt.trim();
    if (this.activeRun) {
      // The hook is the echo of a run the idle-send path already began —
      // stamp the CLI's prompt_id onto it (the exact run↔turn bridge; the
      // write path can never know the id, only the hook does). Text identity
      // guards against stamping a DIFFERENT prompt's id — but text alone
      // cannot tell TWO consecutive sends of identical text apart: a
      // just-finished twin's LATE echo would stamp ITS id onto this run and
      // cross-wire both turns' attribution (review 2026-07-03). When a twin
      // finished inside the attribution window, refuse the stamp — the run
      // degrades to the text bridge, wrong never.
      const finishedTwin =
        this.lastFinishedPrompt !== null &&
        this.lastFinishedPrompt.expiresAt > Date.now() &&
        samePromptModuloCliDecoration(this.lastFinishedPrompt.text, text);
      if (
        options.promptId &&
        !this.activeRun.promptId &&
        samePromptModuloCliDecoration(this.activeRun.prompt, text) &&
        !finishedTwin
      ) {
        this.updateActiveRun({ promptId: options.promptId });
      }
      return;
    }
    // A slash run settles by quiescence seconds before its UserPromptSubmit
    // clears the hook file queue (~250ms watcher + fs latency): that late
    // event is the ECHO of the run that already ran, not a new turn — begun,
    // it would be a phantom run with no output to ever close it. Text
    // identity inside the attribution window recognizes exactly the echo; a
    // human typing a command natively in the terminal (different text, or no
    // fresh completion) still gets its run.
    if (
      this.recentAttributionRun &&
      this.recentAttributionRun.expiresAt > Date.now() &&
      samePromptModuloCliDecoration(this.recentAttributionRun.prompt, text)
    ) {
      this.debugCompletion(`hook-echo swallowed "${text.slice(0, 40)}"`);
      return;
    }
    const kind: RunKind = text.startsWith("/") && !text.includes("\n") ? "slash" : "prompt";
    // A background-workflow task-notification: the CLI resumed the session
    // with an XML system message in the user role. The run is real (the CLI
    // is working — busy state, stop affordance, completion all apply), but
    // its title must never be the raw XML — and never even transiently:
    // `run:started` feeds auto-titling (main + renderer) and the run-index
    // report the moment it fires, so the honest label must ride the FIRST
    // event, not a follow-up patch (review P2, 2026-07-02). The prompt stays
    // verbatim — it is the detection key for the reading surface's husk
    // suppression.
    const revival = text.startsWith("<task-notification>");
    // SL-16 — the revival's other half. The title has said "(background task
    // returned)" since 2026-07-02; now the run MODEL agrees with it and names
    // WHICH run returned. Two terms, both required, and the conjunction is the
    // point: the prompt text proves this turn is machine-injected (the only
    // discriminator that exists at 2.1.258 — `UserPromptSubmit.source` is
    // specified and NOT emitted, F44), and the awaited wake proves there was
    // something to come back FROM. A prompt the USER types during the pause
    // satisfies neither and correctly gets an ordinary run — their turn is
    // their own, and the background work is still in flight behind it.
    const revivalOf = revival ? (this.runAwaitingWake ?? undefined) : undefined;
    if (revivalOf) {
      // Consumed once. A second backgrounded task still in flight will re-arm
      // this at the revival turn's OWN end (its `Stop` carries the remaining
      // entries), so a chain of wakes links run→run→run rather than all
      // pointing back at the first.
      this.runAwaitingWake = null;
    }
    this.beginRun(text || "(prompt)", kind, {
      ...(revival ? { title: "(background task returned)" } : {}),
      ...(revivalOf ? { revivalOf } : {}),
      promptId: options.promptId ?? null,
    });
  }

  sendApprove(): Promise<void> {
    return this.sendApprovalDecision("approve");
  }

  sendApproveForSession(): Promise<void> {
    return this.sendApprovalDecision("approve-for-session");
  }

  sendApproveAlways(): Promise<void> {
    return this.sendApprovalDecision("approve-always");
  }

  /**
   * Answer the surfaced panel with the key its OWN parsed option list maps
   * to (v2 grammar: digits instant-select). Legacy-grammar panels keep their
   * historically verified encodings. `approve-always` exists only where the
   * panel offered a native persistent option — there is no Sonata-invented
   * persistence to fall back to.
   *
   * ASYNC because one screen — the workspace-trust dialog — cannot be answered
   * by any key: its affirm row is not the default and carries no digit, so
   * approving it means walking a cursor with a grid read between every press
   * (`answerClaudeTrustByWalk`). Every other decision still writes its key
   * SYNCHRONOUSLY, in this same tick, before the first await; the promise only
   * lets the walk's outcome — including its refusal to guess — reach the caller,
   * which surfaces it on the drawer and re-enables the button for a retry
   * (`decideApproval`, session-flows.ts). Mirrors `sendOptionPromptAnswer`,
   * the other multi-key answer relay.
   */
  async sendApprovalDecision(
    decision: Extract<ApprovalDecision, "approve" | "approve-for-session" | "approve-always">,
  ): Promise<void> {
    // CSI-u Enter / ArrowDown are Claude's native-panel grammar — WRONG for
    // codex's card (S4). Codex answers exclusively via the broker reply channel;
    // no code path should ever replay panel keys to a codex PTY. Fail loudly
    // rather than corrupt the codex TUI with foreign keystrokes.
    if (this.profile.provider !== "claude") {
      throw new Error(
        `Native approval-key replay is Claude-only; ${this.profile.provider} answers via the hook broker.`,
      );
    }
    // The walk owns `approve` on the screens that declare one, and it is checked
    // BEFORE the key map on purpose: a trust candidate carries no approve key
    // precisely so this branch is the only way to affirm it, and the legacy
    // `CSI_U_ENTER` fallback below would otherwise exit the CLI.
    if (this.activeApprovalWalk === "claude-workspace-trust") {
      if (decision === "approve") {
        await this.answerClaudeTrustByWalk();
        return;
      }
      // The trust screen offers exactly two actions (`claudeTrustChoices`), so
      // no other positive decision can be legitimate here — and letting one
      // through would reach the legacy fallback and write `ArrowDown + CSI-u
      // Enter` blind at a screen where a stray Enter exits the CLI.
      throw new Error(`The trust screen offers no native option for "${decision}".`);
    }
    const panelKey = this.activeApprovalOptionKeys?.[decision];
    const legacyKey =
      decision === "approve"
        ? CSI_U_ENTER
        : decision === "approve-for-session"
          ? `${ARROW_DOWN}${CSI_U_ENTER}`
          : null;
    const keySequence = panelKey ?? legacyKey;
    if (!keySequence) {
      throw new Error(`The active approval screen offers no native option for "${decision}".`);
    }
    this.sendPositiveApproval(decision, keySequence, describeApprovalKeySequence(keySequence));
  }

  private sendPositiveApproval(
    decision: Extract<ApprovalDecision, "approve" | "approve-for-session" | "approve-always">,
    keySequence: string,
    encodedAs: ApprovalDecisionEncoding,
  ): void {
    const decisionAt = Date.now();
    const previousKind = this.lastApprovalKind;
    if (decision !== "approve") {
      // Any native option-2 answer may persist a rule (the CLI's own
      // write); watch the project settings file and receipt what lands.
      this.armPersistReceiptWatch(this.activeRun ? this.activeRun.id : null);
    }
    this.writeRaw(keySequence);
    this.emitEvent("approval:decision", {
      taskId: this.taskId,
      runId: this.activeRun ? this.activeRun.id : null,
      decision,
      encodedAs,
      previousKind,
    });
    this.updateActiveRun({
      status: "active",
      lifecyclePhase: "resumed-after-approval",
      approvalDecision: decision,
      approvalKind: previousKind ?? "unknown",
    });
    this.taskReady = false;
    this.approvalActive = false;
    this.lastApprovalDecision = decision;
    this.lastApprovalDecisionAt = decisionAt;
    this.approvalSuppressedInSettleWindow = false;
    this.scheduleApprovalSettleCheck(decisionAt);
  }

  /**
   * Affirm claude's workspace-trust dialog by MOVING ITS CURSOR onto the
   * `Yes, I trust this folder` row and confirming there — the only channel that
   * screen offers, and the only one that is safe.
   *
   * WHY NOT A KEY (all MEASURED at 2.1.252,
   * spikes/upstream-sync-2026-09/claude/q3-trust-variants.capture.txt):
   *   - the dialog boots with `❯ No, exit`; the affirm row is SECOND,
   *   - its rows carry no digits, and a digit is inert (screen byte-identical),
   *   - `\r` and CSI-u Enter — Sonata's two former approve encodings — each
   *     answered the DEFAULT row and exited the CLI with status 1. A user
   *     tapping Approve killed the session.
   * The row order is what moved (2.1.176 had the affirm row FIRST, with a
   * digit), so this walk takes its direction from the grid rather than assuming
   * one: it is correct on both layouts and on whatever the next one is.
   *
   * WHY VERIFY-AND-RETRY RATHER THAN A FIXED SEQUENCE. An input-ARMING window
   * follows the dialog's paint (measured, q2): a Down written at +0ms is
   * swallowed — the screen stays byte-identical — while one at +500ms lands.
   * A blind `ArrowDown + CR` therefore has a state in which the CR answers
   * `No, exit`. In the field the window is long spent by the time a human taps
   * Approve, but the co-visible Terminal makes the cursor's position genuinely
   * unknown anyway (the user can move it themselves), which is the deeper
   * reason the position is READ and never assumed.
   *
   * RED LINE: nothing is pressed at a screen this cannot read. A grid without
   * BOTH rows, or with the cursor on neither, aborts — it never presses an arrow
   * "to see what happens", and it never confirms except from a frame that shows
   * the affirm row focused. Aborting is safe by construction: no decision is
   * emitted, the panel stays live and answerable (drawer or Terminal), and the
   * delivery gate stays shut. The thrown reason reaches the drawer's status line.
   *
   * The write-lock is held across the whole walk (as `sendOptionPromptAnswer`
   * does) so a human keystroke buffers instead of interleaving between an arrow
   * and the confirm — where it would land as an answer to the dialog.
   */
  private async answerClaudeTrustByWalk(): Promise<void> {
    if (this.approvalWalkInFlight) {
      throw new Error("The trust screen is already being answered.");
    }
    this.approvalWalkInFlight = true;
    this.beginSonataWrite();
    try {
      for (let step = 0; ; step++) {
        const screen = await this.readSettledGrid(CLAUDE_TRUST_WALK_GRID_READ_MS);
        if (screen === null) {
          throw new Error("Could not read the terminal screen to confirm the trust screen's cursor.");
        }
        const rows = parseClaudeTrustDialogRows(screen);
        if (!rows) {
          throw new Error("The trust screen's options are no longer on the terminal screen.");
        }
        if (rows.focused === "affirm") {
          // The confirming CR runs the SAME bookkeeping every other positive
          // answer does — emitted here, at the moment the key actually goes on
          // the wire, rather than optimistically before a walk that may refuse.
          this.sendPositiveApproval("approve", "\r", "grid-verified Arrow + CR");
          return;
        }
        if (rows.focused === null) {
          // Mid-repaint: the cursor belongs to neither row on this frame. Wait
          // for the next settled grid rather than press into an unknown state.
          if (step >= CLAUDE_TRUST_WALK_MAX_STEPS) {
            throw new Error("The trust screen's cursor never settled on a row.");
          }
          await delay(CLAUDE_TRUST_WALK_STEP_MS);
          continue;
        }
        if (step >= CLAUDE_TRUST_WALK_MAX_STEPS) {
          throw new Error(
            "Could not move the trust screen's cursor onto “Yes, I trust this folder”. Answer it in the Terminal.",
          );
        }
        // Direction from the grid, never a constant. A press that the arming
        // window swallows simply leaves the cursor where it was, and the next
        // pass presses again — bounded by CLAUDE_TRUST_WALK_MAX_STEPS.
        this.writeRaw(rows.affirmIndex > rows.declineIndex ? ARROW_DOWN : ARROW_UP);
        await delay(CLAUDE_TRUST_WALK_STEP_MS);
      }
    } finally {
      this.endSonataWrite();
      this.approvalWalkInFlight = false;
    }
  }

  /**
   * The settled grid as a promise (the callback `readScreen` seam the
   * ControlSwitchEngine gets, awaited). Resolves null when the screen cannot be
   * read — no model, or `whenSettled` never calls back because the model was
   * disposed mid-await (teardown drops queued waiters, by design). The timeout
   * is what keeps that case from hanging the IPC call that is awaiting the walk,
   * which would strand the drawer's buttons disabled.
   */
  private readSettledGrid(timeoutMs: number): Promise<string | null> {
    const model = this.screenModel;
    if (!model) {
      return Promise.resolve(null);
    }
    return new Promise<string | null>((resolve) => {
      let settled = false;
      const finish = (value: string | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      timer.unref?.();
      model.whenSettled(() => finish(this.approvalScanGrid()));
    });
  }

  /**
   * A hook-broker approval was answered on the REPLY channel (S2): no keys
   * were written, but terminal-host state must resync. While the broker
   * holds, the claude TUI paints the pending tool line ("Write(page.html) ·
   * Computing… · running PermissionRequest hook"), and the approval scrape
   * can false-positive on those bytes — `surfaceApproval` then flips the run
   * to waiting-for-approval and sets `approvalActive`, and with the decision
   * made on the hook channel NOTHING else ever resumes them: the Stop hook's
   * completion is guarded on status, so the run wedges "Waiting for approval"
   * forever and the approval guard blocks every later send (S5
   * walking-skeleton diag, s5-diags/evidence-walking-skeleton). Mirrors
   * sendPositiveApproval's bookkeeping minus the keys and minus the event
   * (the controller emits its own decision event for broker replies). The
   * post-decision settle re-check keeps the honesty backstop: anything
   * genuinely still asking on screen resurfaces after the window.
   */
  noteHookApprovalDecision(decision: ApprovalDecision, kind: ApprovalKind): void {
    const decisionAt = Date.now();
    if (this.activeRun?.status === "waiting-for-approval") {
      this.updateActiveRun({
        status: "active",
        lifecyclePhase: "resumed-after-approval",
        approvalDecision: decision,
        approvalKind: kind,
      });
    }
    // The panel on screen right now — the full native panel claude ≥2.1.186
    // renders while the broker holds — is answered history: the reply went down
    // the hook's stdout and cannot be swallowed. Capture its grid fingerprint as
    // the answered-panel watermark (S4b): while that same panel lingers on the
    // grid before the TUI repaints past it, any candidate matching it is
    // suppressed (detectApproval + checkApprovalSettled), so it can never
    // re-detect as a phantom "resurfaced" ask (which used to flip the run back to
    // waiting-for-approval >1.2s after the decision and drop the Stop hook — the
    // 2026-07-03 wedge). Replaces the old byte-offset approvalScanFloor: the grid
    // has no history tail to slice, and the answered panel simply leaves the
    // screen on repaint. If nothing parses right now (the panel already repainted
    // away), there is nothing to suppress — null is correct.
    this.brokerAnsweredFingerprint =
      detectApprovalCandidate(this.approvalScanGrid(), this.profile)?.fingerprint ?? null;
    this.approvalActive = false;
    this.lastApprovalDecision = decision;
    this.lastApprovalDecisionAt = decisionAt;
    this.approvalSuppressedInSettleWindow = false;
    this.taskReady = false;
    this.scheduleApprovalSettleCheck(decisionAt);
    // The wedged run's completion check was parked (schedule-skip on
    // waiting-for-approval) — re-arm it now that the run is active again.
    this.scheduleCompletionCheck();
  }

  /**
   * A hook-broker approval TIMED OUT (Sonata answered nothing; the CLI's native
   * card is taking over for the SAME request). Arm the resurface recognition so
   * the scrape's imminent re-detection of that native card is marked as a
   * resurface, not a fresh ask — else the user gets a second "needs you"
   * notification for a request they were already told about. One-shot; the next
   * candidate within the resurface window consumes it.
   */
  noteBrokerApprovalExpiry(): void {
    // The broker gave up → the native card it painted is now the live surface the
    // user must answer. Arm the resurface recognition — which also OPENS the
    // broker-ON backstop gate (nativeApprovalSurfaceSuppressed) for this one
    // detection — then re-arm a scan (S4b R1): the card was painted during the
    // suppressed hold and may sit fully quiescent (step-0: a waiting panel emits
    // nothing), so without an explicit scan there is no printable chunk to
    // trigger detection. The scan reads the settled grid, finds the card, and
    // surfaces it as a resurface.
    this.brokerExpiryResurfaceAt = Date.now();
    this.scheduleApprovalScan();
  }

  sendDeny(): void {
    const previousKind = this.lastApprovalKind;
    this.writeRaw(ESC);
    this.emitEvent("approval:decision", {
      taskId: this.taskId,
      runId: this.activeRun ? this.activeRun.id : null,
      decision: "deny",
      encodedAs: "Esc",
      previousKind,
    });
    this.updateActiveRun({
      status: "approval-denied",
      lifecyclePhase: "approval-denied",
      approvalDecision: "deny",
      approvalKind: previousKind ?? "unknown",
    });
    this.taskReady = false;
    this.finishActiveRun("approval-denied", "Esc denied native approval", {
      completionSource: "native-control",
      completionConfidence: "high",
    });
    this.approvalActive = false;
    this.lastApprovalDecision = "deny";
    this.lastApprovalDecisionAt = Date.now();
    this.approvalSuppressedInSettleWindow = false;
    this.clearApprovalSettleTimer();
  }

  /**
   * A stop key that Sonata wrote for a DIFFERENT purpose (the stop interrupt, or
   * its one-shot resend) landed while a native approval panel owned the screen
   * — so the CLI consumed it as a DENY. Settle the approval state to match what
   * the key actually did.
   *
   * TRUE FOR BOTH STOP KEYS, and measured for each rather than carried over.
   * Claude's Esc denies the panel (the long-standing measurement this method was
   * written for). Codex's Ctrl+C denies it too and says so on screen — q31 s8,
   * a real command-approval panel: the press printed `✗ You canceled the request
   * to run curl …` AND `■ Conversation interrupted`, with `Interrupt` at +120ms.
   * So the deny bookkeeping below is honest for either key; only the `encodedAs`
   * label differs, which is why the caller passes it.
   *
   * Mirrors `sendDeny`'s bookkeeping minus its two writes: NO second key (the
   * caller's key already denied; a second Esc ≤700ms later is the documented
   * Rewind-panel-opening pair, and a second Ctrl+C is quit-capable — see
   * `CTRL_C`) and NO `finishActiveRun` (the stop path owns the run's end, as
   * "stopped" — the honest reason the run is over).
   *
   * Without this the stop paths clear nothing: `approvalActive` stays true with
   * no clearer reachable from a stop, and the scrape's `SCRAPE_APPROVAL_KEY` in
   * `DeliveryController.pendingApprovalKeys` — released ONLY by an
   * `approval:decision` — is never freed. `canDeliver()` then reads false on two
   * independent gates and every later send sits "Queued" until the user types in
   * the Terminal (ask-flows review B1, 2026-08-07).
   *
   * `runId` is the CALLER's captured id, never `activeRunId()`: the retry path
   * runs with no active run at all (its own guard), and the stop path's pointer
   * is about to be nulled by `finishActiveRun`. An unassigned decision beside a
   * run-attributed `approval:detected` is exactly the unbalanced audit trail the
   * broker abort path already learned to avoid (runtime-controller.ts
   * `abortPendingBrokerApprovals`).
   *
   * No settle re-check is armed (as in `sendDeny`): if the key did NOT take and
   * the panel is still live, `detectApproval`'s suppression branch arms one
   * itself off `lastApprovalDecisionAt` — "arming at the suppression site covers
   * every decision source by construction" (review P2).
   */
  private settleApprovalAsStopKeyDeny(runId: RunId | null, encodedAs: StopInterruptEncoding): void {
    if (!this.approvalActive) {
      return;
    }
    const previousKind = this.lastApprovalKind;
    this.taskReady = false;
    this.approvalActive = false;
    this.lastApprovalDecision = "deny";
    this.lastApprovalDecisionAt = Date.now();
    this.approvalSuppressedInSettleWindow = false;
    this.clearApprovalSettleTimer();
    // The native-answer recheck ladder exists only to reconcile THIS approval
    // against a human's in-terminal keys; the decision above is that
    // reconciliation, so the armed rungs are stale. A later ask re-arms its own
    // ladder from `onHumanInputSettled`.
    this.clearNativeAnswerRecheckTimers();
    // Record the decision on the run while it is still open (a no-op on the
    // retry path, which has none) — status is left alone deliberately: the
    // caller's `finishActiveRun` writes the terminal one.
    this.updateActiveRun({
      approvalDecision: "deny",
      approvalKind: previousKind ?? "unknown",
    });
    this.emitEvent("approval:decision", {
      taskId: this.taskId,
      runId,
      decision: "deny",
      encodedAs,
      previousKind,
    });
  }

  /**
   * Which key a stop writes, and what to call it in the record.
   *
   * CLAUDE is Esc and stays Esc — its stop choreography is measured-correct
   * (SL-2b s3/s8 re-measured the Esc semantics this program depends on) and is
   * untouched by SL-15.
   *
   * CODEX moved: at 0.152.1 Ctrl+C is the only key that interrupts a live turn in
   * EVERY phase of it. Esc — the key production `stopRun()` used to write — is
   * phase-dependent, and the phase it fails in is the one that matters (probe
   * q34, two keys × two phases, each cell run twice):
   *
   *   |        | before the model emits anything | once tokens are streaming |
   *   |--------|---------------------------------|---------------------------|
   *   | Esc    | interrupts (+138/141ms)         | NOTHING — the turn runs on to its own `Stop` (2/2) |
   *   | Ctrl+C | interrupts (+127/144ms)         | interrupts (+118/151ms)   |
   *
   * The streaming cell is the user-facing bug, because output arriving is WHY a
   * stop gets pressed. C17 measured that cell three times (three Esc paths, three
   * turns finished, no `Interrupt` hook) and generalised it to "Esc no longer
   * interrupts"; q34 narrowed the claim without softening the consequence.
   *
   * THE GUARD IS THE RUN POINTER, and it is structural on purpose. Ctrl+C is
   * `fixed.interrupt_or_quit`: at an idle EMPTY composer one press QUITS the CLI
   * (q31 s2 — exit 0, no confirmation). The key may therefore only be written
   * when a turn is genuinely in flight, and "genuinely in flight" has to be
   * decided from something structural rather than from a clock or a screen read:
   *
   *  - a SCREEN belt is FALSIFIED, twice over. Empirically: sampled through
   *    genuinely live turns, the production idle-prompt detector read `ready:true`
   *    in 12/20, 12/20 and 14/20 samples (q31 s1, three runs) — the codex
   *    counterpart of F12's coin flip, so a "refuse if the screen looks idle"
   *    belt would refuse the majority of real interrupts and re-open C17.
   *    Architecturally: the status scrape that DOES track codex's working row is
   *    contract §3.1 fence #1, display-only, and nothing may derive state from it.
   *  - `acceptsPromptInput()` is not a second signal either — it returns false
   *    whenever `activeRun` is set, so it restates this pointer rather than
   *    standing beside it.
   *
   * WHAT THE GUARD DOES NOT COVER, sized honestly rather than described as a
   * fault case. This pointer trails codex by the length of the turn-end hook
   * round trip, so there is a window after EVERY codex turn in which the pointer
   * still says "live" and codex is already sitting at an idle EMPTY composer —
   * the one state where a single Ctrl+C quits:
   *
   *   model emits its last token, codex repaints an idle composer
   *     → the `Stop` shim writes its `hook-*.json`   (~110–170ms, the latency
   *       measured on this channel for `Interrupt`, which shares it)
   *     → `HookWatcher` picks it up on its next tick (0–250ms; production runs
   *       the 250ms default, no override)
   *     → dispatch closes the run                    (SL-9 end-to-end: hook at
   *       +141ms, run closed at +253ms)
   *
   * i.e. roughly a QUARTER TO HALF A SECOND, once per turn end, and a click at
   * the moment the last token lands is exactly the click a user makes. A dropped
   * `Stop` hook widens the same window to the quiescence closer
   * (`stoplessTurnEndConfirmed`), but it is the tail of this distribution, not
   * the whole of it.
   *
   * The renderer's ■ is NOT part of the hazard: the run report rides a 1000ms
   * trailing debounce, so the button outlives the pointer — and a click in that
   * tail reads a pointer that is already closed and writes Esc. It fails safe in
   * the direction that matters.
   *
   * NOT NARROWED BY A RECENCY BELT, and that is a decision rather than an
   * oversight. "Only send Ctrl+C if printable output landed within the last N ms"
   * would close most of this window — and would refuse exactly the interrupt the
   * user most wants, because a codex turn can be printable-silent for minutes
   * while the model works (SL-2b F13b measured that directly, and it is why the
   * quiescence judge had to be restated on raw timestamps). Refusing a stalled
   * turn's stop is the failure this slice exists to fix; a belt that reintroduces
   * it for a fraction of a second's protection is a bad trade. Not shipped, and
   * not shipped on a guess either way — it would need its own measurement.
   *
   * The root fix retires the window instead of guarding it: a key that is not
   * quit-capable in ANY state. Codex offers one — `tui.keymap.chat.interrupt_turn`
   * is rebindable and loads from Sonata's own profile (MEASURED in q32: bound to
   * `alt-i` it interrupted a live turn at +121ms and was completely inert at an
   * idle composer). Adopting it is a decision this slice reports rather than
   * takes; see findings C29 for the hazard that comes with it.
   *
   * With no live run there is nothing to interrupt, so the key stays Esc — the
   * byte this path already wrote in that state, unchanged rather than
   * re-decided on an unmeasured basis.
   */
  private stopInterruptKey(): { key: string; encodedAs: StopInterruptEncoding } {
    if (this.profile.provider !== "codex") {
      return { key: ESC, encodedAs: "Esc" };
    }
    const live = this.activeRun !== null && LIVE_TURN_STATUSES.has(this.activeRun.status);
    return live ? { key: CTRL_C, encodedAs: "Ctrl+C" } : { key: ESC, encodedAs: "Esc" };
  }

  /**
   * Answer a native AskUserQuestion (option-prompt) form by playing back a
   * verified key sequence built by `optionPromptAnswerSequence` /
   * `optionPromptDismissSequence` (2.1.212 grammar: digits select/toggle,
   * RIGHT advances, free-text travels as one chunk, a Submit-tab CR only when
   * the form has one). Same keystroke-relay mechanism approvals use — not
   * stdin games.
   */
  async sendOptionPromptAnswer(keys: string[]): Promise<void> {
    if (!this.ptyProcess) {
      throw new Error("No PTY process is running.");
    }
    // Hold the write-lock across the whole multi-key run (with its inter-key
    // delays) so a human keystroke buffers rather than interleaving into the
    // answer sequence (S2).
    this.beginSonataWrite();
    try {
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (key === undefined) {
          continue;
        }
        if (i > 0) {
          await delay(OPTION_PROMPT_KEY_DELAY_MS);
        }
        if (!this.ptyProcess) {
          throw new Error("The PTY exited mid-answer.");
        }
        this.writeRaw(key);
      }
    } finally {
      this.endSonataWrite();
    }
  }

  async stopRun(
    options: { inspectDelayMs?: number; forceSlashStop?: boolean } = {},
  ): Promise<{ canceledPendingPromptWrite: boolean; promptReachedComposer: boolean }> {
    const stoppedRunId = this.activeRun ? this.activeRun.id : null;
    const stoppedCommandApprovalRun = this.activeRun?.approvalKind === "command";
    // Abort our own undelivered bytes FIRST: submitPrompt defers its text and
    // Enter writes on timers, so a stop clicked right after a send would
    // otherwise be trailed by our own paste starting the very turn the user
    // tried to stop (probe S0, stop-after-send race). The caller relays
    // `canceledPendingPromptWrite` to the DeliveryController so the aborted
    // item is reported honestly instead of waiting out the receipt timeout.
    const canceledPendingPromptWrite = this.cancelPendingDeferredWrites() > 0;
    // Capture BEFORE any control write (the deferred /stop) can touch it: whether
    // the aborted prompt had already pasted its text/paths into the composer.
    const promptReachedComposer = this.promptTextReachedComposer;
    // WHICH key, decided from the run pointer read in this same breath — see
    // `stopInterruptKey`. Read BEFORE `finishActiveRun` below nulls the pointer.
    const interrupt = this.stopInterruptKey();
    this.writeRaw(interrupt.key);
    // An Esc interrupt restores the interrupted prompt into the CLI's own input
    // box when the turn had produced nothing yet (probe C1/X1, claude
    // 2.1.212 + codex 0.144.5) — and a canceled text write can likewise
    // strand a pasted prompt there. Either way the next injection would
    // concatenate onto it: mark the line dirty, clear it once the TUI
    // settles (belt), and let the next submission's prefix flood cover a
    // straggler (suspenders).
    //
    // Kept unconditional even though a codex Ctrl+C interrupt leaves the composer
    // EMPTY (q31 s1: the composer read `› Ask Codex to do anything` after the
    // press — codex's own placeholder — while the prompt stayed in the transcript
    // as history). The flag's other producer is the canceled text write above,
    // which is key-independent, and its cost when wrong is a kill-line flood into
    // an already-empty composer — the designed harmless no-op (probe C2/C6/X2).
    // Deriving it from the key would trade that no-op for a concatenation bug.
    this.cliInputMaybeDirty = true;
    this.armCliInputClear();
    // Arm the one-shot resend ONLY when the key written was Esc: if a PreToolUse
    // hook lands after this stop, the turn provably survived it (swallowed key) —
    // resend once. Never armed behind a Ctrl+C; see `stopEscRetry` for the two
    // independent reasons.
    this.stopEscRetry =
      interrupt.encodedAs === "Esc" ? { requestedAt: Date.now(), retried: false, runId: stoppedRunId } : null;
    this.taskReady = false;
    // The key written above is a DENY when a native approval panel owns the
    // screen — settle the approval state to match, with the id captured at the
    // top (this still runs BEFORE `finishActiveRun` nulls the pointer, so the
    // decision lands on the still-open run, and still BEFORE `run:stopped` so
    // the surface ends on "Stopped" rather than "Approval denied").
    //
    // POSITIONED HERE, NOT NEXT TO THE INTERRUPT KEY (review 1): the emit is
    // synchronously RE-ENTRANT — eventSink → RuntimeController.handleRuntimeEvent
    // → DeliveryController.pump → deliver → submitPrompt, all on this stack. A
    // queued item released by this very decision therefore submits from inside
    // stopRun, so every piece of stop state it reads must already be written:
    //   - `cliInputMaybeDirty` (above) or its pre-submit kill-line flood is
    //     skipped and the paste CONCATENATES onto an Esc-restored prompt;
    //   - `stopEscRetry` (above) or that submit's own `stopEscRetry = null`
    //     is clobbered by this method's re-arm, leaving a 45s Esc retry armed
    //     behind a send that already went out.
    this.settleApprovalAsStopKeyDeny(stoppedRunId, interrupt.encodedAs);
    this.emitEvent("run:stop-requested", {
      taskId: this.taskId,
      runId: stoppedRunId,
      phase: "interrupt",
      encodedAs: interrupt.encodedAs,
    });
    this.emitEvent("run:stopped", {
      taskId: this.taskId,
      runId: stoppedRunId,
      interruptSent: true,
      slashStopSent: false,
      slashStopReason: `${interrupt.encodedAs} sent immediately; /stop inspection is running in the background`,
    });
    this.finishActiveRun("stopped", `${interrupt.encodedAs} interrupt sent`, {
      completionSource: "native-control",
      completionConfidence: "high",
    });
    const inspectDelayMs = Number(options.inspectDelayMs) || 900;
    if (this.slashStopTimer) {
      clearTimeout(this.slashStopTimer);
    }
    this.slashStopTimer = setTimeout(() => {
      this.slashStopTimer = null;
      this.inspectSlashStop(stoppedRunId, {
        ...options,
        stoppedCommandApprovalRun,
      });
    }, inspectDelayMs);
    this.slashStopTimer.unref?.();
    return { canceledPendingPromptWrite, promptReachedComposer };
  }

  /** Arm (or re-arm) the post-stop belt clear of the CLI input line. */
  private armCliInputClear(): void {
    if (this.cliInputClearTimer) {
      clearTimeout(this.cliInputClearTimer);
    }
    this.cliInputClearTimer = setTimeout(() => {
      this.cliInputClearTimer = null;
      this.writeCliInputClearFlood("post-stop settle");
    }, CLI_INPUT_CLEAR_DELAY_MS);
    this.cliInputClearTimer.unref?.();
  }

  /**
   * Clear the CLI's input line with a counted kill-line flood. Ctrl+U kills
   * per-LINE on Claude (an emptied line can cost a second kill), so the
   * flood is sized from the session's high-water pasted line count — the
   * restore is the interrupted TURN's prompt, not necessarily the last
   * submission (review F2) — with a floor for wrapped lines; every extra
   * kill on an empty line is a no-op (probe C2/C6/C8/C9/X2/X3).
   *
   * Only the `pre-submit` path consumes the dirty flag: its flood provably
   * precedes its own paste, so the line is clean when it matters. The belt
   * path leaves the flag armed — the restore's latency has no probed lower
   * tail, and a belt that fired before a slow restore must not stand the
   * submit-time guard down (review F1). The belt also skips (flag kept)
   * while an approval owns the screen, another automation write is
   * mid-sequence, or a co-present human typed in the terminal within the
   * activity window (their in-terminal edit of the restored text must not be
   * wiped — review F7).
   */
  /**
   * Unconditionally kill the composer line before typing a raw slash COMMAND
   * (`/model`, `/effort`, `/permissions`). This does NOT gate on
   * `cliInputMaybeDirty` — unlike an Esc-restored prompt, a co-present human can
   * type unsubmitted text straight into the idle Terminal composer (typeable per
   * the Two-Window Contract), which sets NO dirty flag. If that text is still on
   * the line, our command concatenates onto it — and a slash line with a text
   * prefix SUBMITS as a chat prompt: on codex that burns a real turn (RED LINE 1,
   * and the `run:started` then silently cancels the switch), and a claude
   * `<prefix>/model x` misfires the same way. So the clear must be
   * SCREEN-BLIND-safe rather than flag-conditional. KILL_LINE (`\x15`) on an
   * already-empty composer is the designed harmless no-op (probe C2/C6/X2). The
   * caller already holds the write-lock, so the kills land ahead of the typed
   * command in order.
   */
  private clearComposerBeforeTypedCommand(): void {
    if (!this.ptyProcess) {
      return;
    }
    const kills = Math.min(
      Math.max(this.cliDirtyLineHighWater * 2 + 2, CLI_INPUT_CLEAR_MIN_KILLS),
      CLI_INPUT_CLEAR_MAX_KILLS,
    );
    this.ptyProcess.write(KILL_LINE.repeat(kills));
    // Whatever was on the line is gone; a later Esc-restore flag would be stale.
    this.cliInputMaybeDirty = false;
  }

  private writeCliInputClearFlood(reason: "pre-submit" | "post-stop settle"): boolean {
    if (!this.cliInputMaybeDirty || !this.ptyProcess) {
      return false;
    }
    if (reason !== "pre-submit") {
      if (this.approvalActive || this.sonataWriteDepth > 0 || this.isHumanActivelyTyping()) {
        return false;
      }
    }
    const kills = Math.min(
      Math.max(this.cliDirtyLineHighWater * 2 + 2, CLI_INPUT_CLEAR_MIN_KILLS),
      CLI_INPUT_CLEAR_MAX_KILLS,
    );
    const flood = KILL_LINE.repeat(kills);
    if (reason === "pre-submit") {
      this.cliInputMaybeDirty = false;
      // Caller (submitPrompt) already holds the write-lock; write directly so
      // the flood lands ahead of the attachment/text pastes in order.
      this.ptyProcess.write(flood);
    } else {
      this.beginSonataWrite();
      this.ptyProcess.write(flood);
      this.endSonataWrite();
    }
    return true;
  }

  /**
   * A PreToolUse hook arrived for this task. If a stop was requested and the
   * turn is still running tools afterwards, the Esc was swallowed — resend it
   * ONCE. PreToolUse is the only admissible evidence: Notification fires at
   * idle ("waiting for your input") and PostToolUse can be the death rattle
   * of the very tool the Esc interrupted, so acting on either would fire an
   * Esc into an idle TUI — which opens Claude's rewind menu / prefills
   * Codex's edit-previous buffer (probe C6/X2). A new run (activeRun) means
   * the user moved on: never retry into it.
   *
   * ESC-ONLY BY CONSTRUCTION (SL-15). `stopEscRetry` is armed only by a stop that
   * WROTE Esc, so this method can never resend a codex Ctrl+C — see that field
   * and `CTRL_C` for why a blind resend of that key is not an option.
   */
  noteToolActivityAfterStop(): void {
    const retry = this.stopEscRetry;
    if (!retry || retry.retried || this.activeRun || !this.ptyProcess) {
      return;
    }
    const elapsed = Date.now() - retry.requestedAt;
    if (elapsed < STOP_ESC_RETRY_MIN_MS || elapsed > STOP_ESC_RETRY_WINDOW_MS) {
      return;
    }
    retry.retried = true;
    this.writeRaw(ESC);
    // Same Esc-is-a-deny settlement as `stopRun`, and reachable here for a
    // different reason: the very tool this PreToolUse announces is what asks,
    // so a native panel can be painted (and scraped → `approvalActive`) between
    // the stop and this resend. The `activeRun` guard above does not exclude it
    // — `surfaceApproval` sets the flag with no run open (its `updateActiveRun`
    // simply no-ops), which is the ordinary take-over shape. `retry.runId` for
    // the same recordability reason the stop events use it (review F4).
    this.settleApprovalAsStopKeyDeny(retry.runId, "Esc");
    this.cliInputMaybeDirty = true;
    this.armCliInputClear();
    // The stopped run's id makes the resend recordable: run-index drops
    // null-runId stop events, which would leave the durable report blind to
    // every retry (review F4).
    this.emitEvent("run:stop-requested", {
      taskId: this.taskId,
      runId: retry.runId,
      phase: "interrupt-retry",
      encodedAs: "Esc",
    });
  }

  completeActiveRun(reason = "manual"): ActiveRun | null {
    return this.finishActiveRun("completed", reason, {
      completionSource: "manual-control",
      completionConfidence: "high",
    });
  }

  /**
   * FAN-OUT #2 (live resize). Takes ALREADY-CLAMPED dimensions — the caller
   * (`RuntimeController.resizeTerminal`) normalizes once and hands the same
   * value to the `StatusRegionTracker` it owns, so all four mirrors of one
   * task's geometry move together or not at all.
   *
   * EVERY leg here throws on some un-clamped input — node-pty rejects
   * non-positive / NaN / Infinity dimensions, @xterm rejects NaN, Infinity and
   * any non-integer — and the PTY goes first. That is exactly why the clamp is
   * upstream: a throw part-way through would leave the PTY resized and the
   * grids stale, wrapping the CLI's text at a column the parsers no longer know
   * about.
   */
  resize(dimensions: TerminalDimensions): void {
    if (!this.ptyProcess) {
      return;
    }
    this.ptyProcess.resize(dimensions.cols, dimensions.rows);
    // Keep the mirror in lock-step with the PTY so the serialized layout matches.
    this.scrollback?.resize(dimensions);
    // The approval screen model must track the same geometry so panel rows wrap
    // and land where the parser expects them.
    this.screenModel?.resize(dimensions);
  }

  /** Snapshot the terminal for replay into a (re)opening window, or null when
   *  there is no live terminal yet. */
  async serializeScrollback(): Promise<TerminalReplaySnapshot | null> {
    if (!this.scrollback) {
      return null;
    }
    return {
      ...(await this.scrollback.snapshot()),
      generation: this.generation,
    };
  }

  dispose(): void {
    this.disposeProcess();
    this.stopFileWatcher();
    this.clearCompletionTimer();
    this.clearApprovalSettleTimer();
    this.clearApprovalScanTimer();
    this.clearPersistReceiptTimers();
    this.clearNativeAnswerRecheckTimers();
  }

  /** Reset every piece of stop/interrupt hygiene bound to the CURRENT
   *  process. Called on dispose AND pty exit (review F8: a leaked retry or
   *  dirty flag must not act on the next session). */
  private clearStopHygieneState(): void {
    this.cancelPendingDeferredWrites();
    if (this.cliInputClearTimer) {
      clearTimeout(this.cliInputClearTimer);
      this.cliInputClearTimer = null;
    }
    if (this.slashStopTimer) {
      clearTimeout(this.slashStopTimer);
      this.slashStopTimer = null;
    }
    this.cliInputMaybeDirty = false;
    this.cliDirtyLineHighWater = 1;
    this.stopEscRetry = null;
  }

  private disposeProcess(): void {
    // Flush the coalesced tail FIRST (S3), while the mirror and ptyProcess are
    // still live (both nulled below): these chunks arrived before teardown, and
    // the pre-batching synchronous path handled exactly such chunks — dropping
    // them here would lose already-produced output a live terminal window had
    // shown. Covers dispose() and startTask() (both route through here). On the
    // post-crash path ptyProcess is already null but onExit already flushed, so
    // the buffer is empty and this is a no-op. Any detector timers this arms are
    // cleared by the continuation below / the caller (startTask, dispose), just
    // as the last pre-teardown chunk's did before batching.
    this.flushPtyData();
    // Outside the ptyProcess guard: after a crash-exit already nulled the
    // process, a following dispose/startTask must still not leak timers.
    this.clearStopHygieneState();
    // A switch waiting on its receipt when the PTY dies never gets one — drop it
    // (no needs-attention: the session is gone, there is nothing to point at).
    this.controlSwitch.clear();
    // The boot watchdogs must never fire on a dead/replaced session.
    if (this.codexBootUpdateTimer) {
      clearTimeout(this.codexBootUpdateTimer);
      this.codexBootUpdateTimer = null;
    }
    if (this.codexTrustDialogTimer) {
      clearTimeout(this.codexTrustDialogTimer);
      this.codexTrustDialogTimer = null;
    }
    // No `cleared` event on the way out: the renderer retires this banner on the
    // task's `pty:exit`, exactly as it does the update-gate one. Resetting the
    // flag is what lets the next spawn detect the dialog again from scratch
    // instead of inheriting the dead session's verdict.
    this.codexTrustDialogSurfaced = false;
    if (!this.ptyProcess) {
      return;
    }
    if (this.remoteControlActive) {
      this.setRemoteControlActive(false, null);
    }
    const proc = this.ptyProcess;
    this.ptyProcess = null;
    // Stamp the outgoing process's teardown token BEFORE the kill, so its own
    // (asynchronous) onExit reports a Sonata-initiated death (SL-6). Stamped
    // here rather than at every call site: dispose(), a task close, and
    // startTask's pre-spawn dispose all funnel through this one method, and each
    // of them is Sonata's own decision to end the process.
    if (this.processTeardown) {
      this.processTeardown.sonataInitiated = true;
    }
    this.scrollback?.dispose();
    this.scrollback = null;
    this.screenModel?.dispose();
    this.screenModel = null;
    try {
      proc.write("\x04");
    } catch {
      // Ignore shutdown races.
    }
    try {
      proc.kill();
    } catch {
      // Ignore shutdown races.
    }
    this.clearApprovalSettleTimer();
    this.clearApprovalScanTimer();
    if (this.humanSettleTimer) {
      clearTimeout(this.humanSettleTimer);
      this.humanSettleTimer = null;
    }
  }

  /** node-pty `onData` entry (S3). Coalesce raw chunks for ~5ms so the single
   *  downstream entry `handlePtyData` — and therefore the scrollback seq write,
   *  the `pty:data` IPC broadcast (fanned to every window), each reducer pass,
   *  and the terminal xterm write — runs once per batch under a firehose instead
   *  of once per chunk. The first chunk arms the one-shot flush timer; every
   *  chunk arriving before it fires is an O(1) push (the timer is never
   *  rescheduled while pending, so continuous output cannot starve the flush).
   *  Not unref'd — same lifecycle as approvalScanTimer; teardown flushes it. */
  private ingestPtyData(data: string): void {
    this.pendingPtyData.push(data);
    if (this.ptyBatchTimer) {
      return;
    }
    this.ptyBatchTimer = setTimeout(() => {
      this.ptyBatchTimer = null;
      this.flushPtyData();
    }, PTY_BATCH_COALESCE_MS);
  }

  /** Drain the coalesced buffer through `handlePtyData` as one concatenated
   *  batch (byte-order preserved ⇒ indistinguishable from one large node-pty
   *  chunk). Called by the ~5ms timer, and synchronously — timer cleared first —
   *  before pty:exit handling and on every teardown path, so no produced tail
   *  byte is lost or reordered. Empty-buffer and no-live-mirror cases are safe
   *  no-ops (handlePtyData's seq falls back to MAX_SAFE_INTEGER post-teardown,
   *  as before). */
  private flushPtyData(): void {
    if (this.ptyBatchTimer) {
      clearTimeout(this.ptyBatchTimer);
      this.ptyBatchTimer = null;
    }
    if (this.pendingPtyData.length === 0) {
      return;
    }
    const batch = this.pendingPtyData.join("");
    this.pendingPtyData = [];
    this.handlePtyData(batch);
  }

  private handlePtyData(data: string): void {
    this.lastPtyDataAt = Date.now();
    const printable = cleanTerminal(data).trim().length > 0;
    if (printable) {
      this.lastPrintablePtyDataAt = this.lastPtyDataAt;
    }
    if (process.env.SONATA_DEBUG_COMPLETION && this.activeRun && printable) {
      console.log(
        `[completion] ${new Date().toISOString()} run=${this.activeRun.id} pty-data len=${data.length} printable=${JSON.stringify(cleanTerminal(data).trim().slice(0, 60))}`,
      );
    }
    this.rawTail = `${this.rawTail}${data}`.slice(-this.scrollbackLimit);
    // The mirror assigns this chunk's ingest seq; tag it onto the broadcast below
    // so a mid-stream-hydrating terminal window can stitch the chunk onto its
    // replay snapshot exactly once (write iff seq >= snapshot.seq). If the mirror
    // was already torn down (a late node-pty data event after disposeProcess()
    // nulled it), fall back to MAX_SAFE_INTEGER, not 0: such a chunk is genuinely
    // the newest, so a window still hydrating against a snapshot captured *before*
    // teardown must treat it as tail (>= any snapshot seq) and write it — a 0
    // would misfile it as already-in-snapshot and drop it.
    const seq = this.scrollback?.write(data) ?? Number.MAX_SAFE_INTEGER;
    if (this.activeRun) {
      this.activeRunRaw = `${this.activeRunRaw}${data}`.slice(-this.scrollbackLimit);
    }
    this.emitEvent("pty:data", {
      taskId: this.taskId,
      generation: this.generation,
      data,
      seq,
    });
    // Feed the approval screen model this batch (S4b). One write per S3 batch;
    // the grid is queried on the trailing scan cadence AFTER the write drains
    // (see scheduleApprovalScan → screenModel.whenSettled).
    this.screenModel?.write(data);
    this.detectRemoteControlState(data);
    this.controlSwitch.ingest(data);
    // Approval scanning is coalesced onto a trailing-edge throttle instead of
    // running the grid extract+parse on every chunk: under a
    // CLI firehose that was hundreds of O(buffer) parses/sec. PRINTABLE-gated
    // like the completion debounce — the idle TUI's ~200ms control-only
    // heartbeat must not arm a scan. This does not delay panel detection: a
    // panel's own text IS printable, so the chunk that paints it arms the scan,
    // and the scan is TRAILING (reads the latest buffer when it fires), so it
    // sees the panel complete even if later paint bytes are control-only.
    if (printable) {
      this.scheduleApprovalScan();
    }
    if (this.isHumanActivelyTyping()) {
      // While the human is typing in the terminal they may be answering a native
      // approval directly — re-check each repaint so approvalActive clears
      // promptly (continuous reconciliation; the settle pass catches a late one).
      // NOT coalesced: clearApprovalIfAnsweredNatively short-circuits unless
      // approvalActive AND the human typed within HUMAN_ACTIVE_WINDOW_MS — a
      // rare, human-timescale window with a quiescent panel on screen (no
      // firehose), so its grid scan is never on the hot path. Deferred to the
      // screen drain (S4b) so it reads THIS batch's repaint, not the pre-write
      // grid — the batch may be the very keystroke echo that cleared the panel.
      this.screenModel?.whenSettled(() => this.clearApprovalIfAnsweredNatively());
    }
    // Completion debounce keys on PRINTABLE chunks only: the idle TUI's
    // ~200ms control-only heartbeat would otherwise clear+re-arm the timer
    // forever and the quiescence completion (slash runs, the Esc-interrupt
    // run-closer) never fires (s4-diags/zzz-completion-trace).
    if (printable) {
      this.scheduleCompletionCheck();
    }
  }

  /** The approval scrape's view of the SCREEN (S4b): the settled viewport rows of
   *  the reconstructed grid, joined with "\n" — the exact shape the parser wants
   *  (S4a Q1: parses identically to a clean raw parse). The grid shows only the
   *  CURRENT screen, so an answered panel the TUI has repainted past is simply
   *  gone — there is no history tail to slice (the old byte-offset floor is
   *  vacuous here; its residual broker-answered dedup lives in
   *  `brokerAnsweredFingerprint`). The surfacing callers query this inside
   *  `screenModel.whenSettled` so every pending write has drained first — the
   *  grid is COMPLETE, never mid-parse. */
  private approvalScanGrid(): string {
    return this.screenModel?.viewportText() ?? "";
  }

  /** Throttle-with-trailing-edge scheduler for the approval scan. The FIRST
   *  printable chunk arms a single timer; every chunk arriving before it fires
   *  is a no-op (the timer is already set), so the scan runs at most once per
   *  APPROVAL_SCAN_CADENCE_MS no matter how fast chunks arrive. It is NOT a
   *  reset-on-every-chunk debounce — the timer is never rescheduled while
   *  pending, so continuous printable output cannot starve it. When it fires it
   *  reads the LATEST buffer (trailing edge), so a scan armed by chunk N that
   *  fires after chunks N+1..N+k sees through N+k. */
  private scheduleApprovalScan(): void {
    if (this.approvalScanTimer) {
      return;
    }
    this.approvalScanTimer = setTimeout(() => {
      this.approvalScanTimer = null;
      // A scan armed by a chunk whose PTY has since been torn down (dispose /
      // startTask / crash-exit nulled ptyProcess) must be a safe no-op — mirror
      // the settle- and completion-timer callback guards.
      if (!this.ptyProcess) {
        return;
      }
      // Query the grid only after pending writes drain (S4b): whenSettled runs
      // detectApproval synchronously when nothing is in flight (the quiescent
      // waiting-panel case — step-0 measured zero output while a panel waits) and
      // otherwise defers to the last write's parse callback, so the scan always
      // reads a COMPLETE grid, never a mid-parse frame. Re-check ptyProcess in
      // case teardown raced the drain.
      this.screenModel?.whenSettled(() => {
        if (!this.ptyProcess) {
          return;
        }
        this.detectApproval();
        // The second grid reader on this cadence (codex-trust S2, plan L2). It
        // rides the approval scan rather than arming a timer of its own because
        // it asks the same kind of question of the same settled screen — and the
        // repaint that answers it (codex tearing the dialog down and drawing its
        // welcome box + composer) is unmissably printable, which is exactly what
        // arms this scan. Gated on a raised banner, so it is a no-op otherwise.
        this.checkCodexTrustDialogCleared();
      });
    }, APPROVAL_SCAN_CADENCE_MS);
  }

  private clearApprovalScanTimer(): void {
    if (!this.approvalScanTimer) {
      return;
    }
    clearTimeout(this.approvalScanTimer);
    this.approvalScanTimer = null;
  }

  /**
   * True when the grid scrape must NOT surface a native approval card (S4b R1).
   * In broker-ON mode the PermissionRequest broker owns every approval
   * end-to-end, so a scraped native card would race and double-answer it (via
   * PTY digit keys). The one exception is a broker EXPIRY: the broker gave up,
   * so the native card the CLI now shows IS the live surface the user must
   * answer — `noteBrokerApprovalExpiry` arms `brokerExpiryResurfaceAt` (and
   * re-arms a scan) exactly then, opening the gate for that one detection. In
   * broker-OFF mode (native-approval / co-visible Terminal) the scrape is the
   * genuine approval channel, so nothing is suppressed.
   */
  private nativeApprovalSurfaceSuppressed(): boolean {
    return this.approvalBrokerOn && this.brokerExpiryResurfaceAt === null;
  }

  private detectApproval(): void {
    // The native-panel approval scrape is Claude-only (S4 funeral). Codex (and
    // any future hook-capable provider whose approvals arrive via the
    // PermissionRequest broker) never surfaces a scraped card — the broker owns
    // that channel end-to-end (ask → card → reply). A codex native card only
    // appears AFTER a broker timeout, and it is answered in the Terminal, not
    // re-scraped into a phantom Sonata card (see handleApprovalExpired).
    if (this.profile.provider !== "claude") {
      return;
    }
    // Broker-ON backstop gate (S4b R1): while the broker owns the approval
    // channel the grid scrape must not proactively surface a native card — it
    // would answer via PTY digit keys and double-answer the broker's reply. The
    // scrape acts only when the broker EXPIRES (the sole moment the native card
    // becomes the live surface); that path arms brokerExpiryResurfaceAt, which
    // opens this gate. See nativeApprovalSurfaceSuppressed.
    if (this.nativeApprovalSurfaceSuppressed()) {
      return;
    }
    const candidate = detectApprovalCandidate(this.approvalScanGrid(), this.profile);
    if (!candidate || candidate.promptAfterApproval) {
      // No panel on the grid (or the composer rendered past it): whatever the
      // broker answered has left the screen, so the answered-panel watermark is
      // spent — a later identical-fingerprint ask must be free to surface.
      this.brokerAnsweredFingerprint = null;
      return;
    }
    // Grid-era re-expression of the broker-decision floor (S4b): a panel whose
    // grid fingerprint equals the last broker-answered one is that same answered
    // panel still lingering on screen before the TUI repaints past it (or a
    // non-repainting synthetic CLI that never clears it) — answered history, not
    // a new ask. Suppress it; the watermark is cleared above once the panel
    // finally leaves the grid. A genuinely-different panel (new fingerprint)
    // falls through and clears the stale watermark.
    if (this.brokerAnsweredFingerprint !== null) {
      if (candidate.fingerprint === this.brokerAnsweredFingerprint) {
        return;
      }
      this.brokerAnsweredFingerprint = null;
    }

    if (this.approvalActive && this.lastApprovalKind === candidate.kind) {
      return;
    }

    const decisionAgeMs = this.lastApprovalDecisionAt ? Date.now() - this.lastApprovalDecisionAt : null;
    // Post-decision settle window: a same-kind candidate this soon after an
    // answer is a repaint of the answered panel, not a new ask. Fingerprint
    // identity alone cannot dedupe it — a PARTIAL repaint hashes to a NEW
    // fingerprint, which re-armed `approvalPending` with no decision ever
    // coming (the fresh-workspace trust wedge: answered → ~6ms later the same
    // screen re-detects → delivery gate closed forever; s3-diags). Honesty
    // backstop: checkApprovalSettled re-derives from the live screen once the
    // window closes and resurfaces anything genuinely unanswered — so the
    // worst case of this suppression is a ≤1.2s VISIBLE delay, never a hold.
    if (
      decisionAgeMs !== null &&
      decisionAgeMs < DEFAULT_APPROVAL_SETTLE_MS &&
      candidate.kind === this.lastApprovalKind
    ) {
      this.approvalSuppressedInSettleWindow = true;
      // Whoever suppresses must guarantee the honesty re-check (review P2,
      // 2026-07-02): only positive Sonata sends arm the settle check at
      // decision time — an answered-natively or deny decision records
      // lastApprovalDecisionAt WITHOUT one, so a candidate suppressed here
      // would have no path back on a static screen. Worse than a hold: the
      // decision already cleared approvalPending, so the gate is OPEN while
      // a live panel sits card-less (digit-swallow class). Arming at the
      // suppression site covers every decision source by construction.
      if (!this.approvalSettleTimer && this.lastApprovalDecisionAt) {
        this.scheduleApprovalSettleCheck(this.lastApprovalDecisionAt);
      }
      return;
    }
    // A hook-broker timeout leaves NO scrape fingerprint (the broker ask never
    // painted a native panel), so the fingerprint path below cannot recognize
    // the native card that now repaints for the same request. This one-shot
    // timing signal does: the first candidate within the window after a broker
    // expiry IS that resurface.
    const brokerExpiryResurface =
      this.brokerExpiryResurfaceAt !== null &&
      Date.now() - this.brokerExpiryResurfaceAt < BROKER_EXPIRY_RESURFACE_MS;
    if (brokerExpiryResurface) {
      this.brokerExpiryResurfaceAt = null; // consume — one native repaint only
    }
    const resurfacedAfterDecision =
      brokerExpiryResurface ||
      (Boolean(this.lastApprovalDecisionAt) &&
        Boolean(candidate.fingerprint) &&
        candidate.fingerprint === this.lastApprovalFingerprint &&
        (decisionAgeMs ?? 0) >= DEFAULT_APPROVAL_SETTLE_MS);
    if (candidate.fingerprint && candidate.fingerprint === this.lastApprovalFingerprint && !resurfacedAfterDecision) {
      return;
    }

    this.surfaceApproval(
      candidate,
      resurfacedAfterDecision
        ? {
            resurfacedAfterDecision,
            decisionAgeMs,
          }
        : {},
    );
  }

  private surfaceApproval(
    candidate: ApprovalCandidate,
    evidence: { resurfacedAfterDecision?: boolean; decisionAgeMs?: number | null } = {},
  ): void {
    this.taskReady = false;
    this.approvalActive = true;
    this.approvalSuppressedInSettleWindow = false;
    // A legitimate surface supersedes any answered-panel watermark (S4b).
    this.brokerAnsweredFingerprint = null;
    this.lastApprovalKind = candidate.kind;
    this.lastApprovalFingerprint = candidate.fingerprint;
    this.activeApprovalOptionKeys = candidate.optionKeys ?? null;
    this.activeApprovalWalk = candidate.optionWalk ?? null;
    // DESIGNED PROVIDER ASYMMETRY (S4): this is the only writer of run.status
    // "waiting-for-approval", and `detectApproval` gates it to Claude — so a
    // CODEX run.status NEVER becomes waiting-for-approval, even during a broker
    // hold (cli-state / view.status still says "Waiting for approval", fed by
    // the PermissionRequest hook). This asymmetry is load-bearing: run.status
    // stays "active" through a hold, which is exactly what lets
    // checkCompletionHeuristic complete a no-Stop codex turn via the D6
    // quiescence net (it guards on status === "active"). Do not "fix" the
    // asymmetry by writing waiting-for-approval on the codex broker path.
    this.updateActiveRun({
      status: "waiting-for-approval",
      lifecyclePhase: "waiting-for-approval",
      approvalKind: candidate.kind,
    });
    const payload: Extract<RuntimeEvent, { type: "approval:detected" }>["payload"] = {
      taskId: this.taskId,
      runId: this.activeRun ? this.activeRun.id : null,
      kind: candidate.kind,
      source: this.profile.approvalSource,
      fingerprintHash: candidate.fingerprintHash,
      choices: candidate.choices,
    };
    if (evidence.resurfacedAfterDecision) {
      payload.resurfacedAfterDecision = true;
      payload.previousDecision = this.lastApprovalDecision;
    }
    if (evidence.decisionAgeMs !== undefined) {
      payload.decisionAgeMs = evidence.decisionAgeMs;
    }
    this.emitEvent("approval:detected", payload);
  }

  private scheduleApprovalSettleCheck(decisionAt: number): void {
    this.clearApprovalSettleTimer();
    this.approvalSettleTimer = setTimeout(
      () => this.checkApprovalSettled(decisionAt),
      DEFAULT_APPROVAL_SETTLE_MS,
    );
  }

  private checkApprovalSettled(decisionAt: number): void {
    this.approvalSettleTimer = null;
    if (!this.ptyProcess || !this.lastApprovalDecisionAt || this.lastApprovalDecisionAt !== decisionAt) {
      return;
    }
    if (this.approvalActive) {
      return;
    }

    // Read the settled grid (S4b): defer until pending writes drain so the
    // re-check judges a COMPLETE screen. Synchronous in the common case — a
    // settle check fires ~1.2s after a decision, when output has stopped
    // (screenModel is non-null here: it shares the ptyProcess lifecycle, guarded
    // above). Re-assert the settle-time guards inside, in case a write drain
    // deferred the callback across a decision change or teardown.
    this.screenModel?.whenSettled(() => {
      if (
        !this.ptyProcess ||
        this.lastApprovalDecisionAt !== decisionAt ||
        this.approvalActive
      ) {
        return;
      }
      // Same broker-ON backstop gate as detectApproval (S4b R1): in broker-ON the
      // settle re-check must not resurface a native card either (the broker owns
      // the answer; the answered panel's linger is covered by
      // brokerAnsweredFingerprint). Only a broker expiry opens the gate.
      if (this.nativeApprovalSurfaceSuppressed()) {
        return;
      }
      const candidate = detectApprovalCandidate(this.approvalScanGrid(), this.profile);
      if (!candidate || candidate.promptAfterApproval) {
        // The answered panel has left the grid — spend the watermark, symmetric
        // with detectApproval's clear (S4b R1 OPT-3), so its liveness does not
        // depend solely on the scan cadence continuing to fire.
        this.brokerAnsweredFingerprint = null;
        return;
      }
      // A broker-answered panel still lingering on the grid is answered history
      // — the grid-era floor (brokerAnsweredFingerprint). Under the raw tail the
      // byte floor made this candidate null; on the grid the panel stays visible
      // until the TUI repaints, so the fingerprint watermark carries the dedup.
      // Key/native decisions never set the watermark, so a genuinely-still-open
      // natively-answered panel still resurfaces here (the honesty backstop).
      if (candidate.fingerprint !== null && candidate.fingerprint === this.brokerAnsweredFingerprint) {
        return;
      }
      if (Date.now() - this.lastPtyDataAt < DEFAULT_APPROVAL_SETTLE_MS - 50) {
        // A candidate is on screen but bytes are still flowing — too fresh to
        // judge. When a same-kind candidate was SUPPRESSED inside the settle
        // window it has no other path back (a static panel emits no further
        // bytes to re-trigger detection), so re-arm instead of dropping; the
        // chain ends when the screen quiets (judged below) or the candidate
        // leaves the grid. Every other path keeps today's one-shot semantics —
        // an unconditional re-arm would widen the false-resurface window.
        if (this.approvalSuppressedInSettleWindow) {
          this.scheduleApprovalSettleCheck(decisionAt);
        }
        return;
      }

      const decisionAgeMs = Date.now() - decisionAt;
      this.surfaceApproval(candidate, {
        resurfacedAfterDecision: true,
        decisionAgeMs,
      });
    });
  }

  private hasBackgroundTerminalHint(): boolean {
    const recent = cleanTerminal(this.rawTail).toLowerCase();
    return BACKGROUND_TERMINAL_HINTS.some((hint) => recent.includes(hint));
  }

  private inspectSlashStop(
    stoppedRunId: RunId | null,
    options: { forceSlashStop?: boolean; stoppedCommandApprovalRun?: boolean },
  ): void {
    // A NEW run means the user already moved on — stop→refill→edit→resend
    // can complete well inside the inspection delay (S2 invites exactly
    // that), and a `/stop` now would kill the corrected turn, not clean up
    // the stopped one (S2 review F1). Cleanup still runs when the old run is
    // somehow still the active one (approval-parked command) or nothing new
    // started.
    if (this.activeRun && this.activeRun.id !== stoppedRunId) {
      return;
    }
    const shouldSubmitSlashStop =
      this.profile.supportsSlashStop &&
      (Boolean(options.forceSlashStop) ||
        Boolean(options.stoppedCommandApprovalRun) ||
        this.hasBackgroundTerminalHint());
    const approvalGuardBlockedSlashStop = shouldSubmitSlashStop && this.approvalActive;
    // Report what HAPPENED, not what was intended. `submitPrompt` has three
    // screen-owner throws — approval (pre-empted by the guard above), a pending
    // control switch, and the Rewind panel — and the catch swallows all of them,
    // so a predicted flag made `run:stopped` claim a `/stop` that was never
    // written. The control-switch case is reachable today (codex is the only
    // provider with `supportsSlashStop`, and a codex switch can be pending here)
    // and was already wrong before this slice; deriving the flag from the actual
    // outcome fixes it and covers the rewind throw for free — that one cannot
    // fire today, since the panel is claude's and claude has supportsSlashStop
    // false, but the flag no longer depends on that staying true.
    let slashStopSent = false;
    let slashStopThrew = false;
    if (shouldSubmitSlashStop && !approvalGuardBlockedSlashStop && this.ptyProcess) {
      try {
        this.submitPrompt("/stop", { createRun: false });
        slashStopSent = true;
      } catch {
        // A stopped run should not be reopened by cleanup failure.
        slashStopThrew = true;
      }
    }

    if (!shouldSubmitSlashStop && !approvalGuardBlockedSlashStop) {
      return;
    }
    this.emitEvent("run:stopped", {
      taskId: this.taskId,
      runId: stoppedRunId,
      interruptSent: true,
      slashStopSent,
      slashStopReason: approvalGuardBlockedSlashStop
        ? "slash stop was not sent because a native approval screen was still active"
        : slashStopThrew
          ? "slash stop was refused by a screen-owner guard (pending control switch or rewind panel)"
          : options.stoppedCommandApprovalRun
            ? "stopped run had an active command approval"
            : "background terminal hint detected or forceSlashStop requested",
    });
  }

  private startFileWatcher(cwd: string): void {
    this.stopFileWatcher();
    this.fileSnapshot = snapshotWorkspace(cwd);

    try {
      this.fileWatcher = fs.watch(cwd, { recursive: true }, (eventType, filename) => {
        const relativePath = typeof filename === "string" ? filename : String(filename || "");
        if (shouldIgnorePath(relativePath)) {
          return;
        }
        this.scheduleFileChange(eventType, relativePath);
      });

      this.fileWatcher.on("error", (error) => {
        this.emitEvent("file:watch-error", {
          taskId: this.taskId,
          cwd: redactPath(cwd),
          mode: "fs.watch",
          error: error.message,
        });
        this.stopNativeFileWatcher();
        this.startPollingWatcher(cwd, "fs.watch emitted an async error");
      });

      this.emitEvent("file:watching", { taskId: this.taskId, cwd: redactPath(cwd), mode: "fs.watch" });
    } catch (error) {
      this.emitEvent("file:watch-error", {
        taskId: this.taskId,
        cwd: redactPath(cwd),
        mode: "fs.watch",
        error: error instanceof Error ? error.message : String(error),
      });
      this.startPollingWatcher(cwd, "fs.watch threw during setup");
    }
  }

  private scheduleFileChange(eventType: string, relativePath: string): void {
    const existingTimer = this.pendingFileTimers.get(relativePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.pendingFileTimers.delete(relativePath);
      this.emitFileChange(eventType, relativePath);
    }, 120);

    this.pendingFileTimers.set(relativePath, timer);
  }

  private emitFileChange(eventType: string, relativePath: string): void {
    if (!this.cwd || shouldIgnorePath(relativePath)) {
      return;
    }

    const absolutePath = path.join(this.cwd, relativePath);
    const before = this.fileSnapshot.get(relativePath) ?? { exists: false, type: "missing" as const };
    const after = snapshotFile(absolutePath);
    const changeKind = classifyChange(before, after);

    if (changeKind === "unchanged") {
      return;
    }

    if (after.exists) {
      this.fileSnapshot.set(relativePath, after);
    } else {
      this.fileSnapshot.delete(relativePath);
    }

    this.emitEvent("file:changed", {
      taskId: this.taskId,
      runId: this.attributionRunId(),
      path: relativePath,
      absolutePath,
      eventType,
      changeKind,
      type: after.type,
      size: after.exists ? (after.size ?? null) : null,
      mtimeMs: after.exists ? (after.mtimeMs ?? null) : null,
      // OBS S7: the watcher no longer content-hashes. The payload keeps its
      // `sha256` field (cross-process contract shape unchanged) but it is now
      // always null — identity is (type, size, mtimeMs).
      sha256: null,
    });
  }

  private stopFileWatcher(): void {
    for (const timer of this.pendingFileTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingFileTimers.clear();

    this.stopNativeFileWatcher();

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private stopNativeFileWatcher(): void {
    if (!this.fileWatcher) {
      return;
    }

    try {
      this.fileWatcher.close();
    } catch {
      // Ignore shutdown races.
    }
    this.fileWatcher = null;
  }

  private startPollingWatcher(cwd: string, reason: string): void {
    if (this.pollTimer) {
      return;
    }

    this.pollTimer = setInterval(() => this.pollWorkspace(cwd), 750);
    this.emitEvent("file:watching", {
      taskId: this.taskId,
      cwd: redactPath(cwd),
      mode: "polling",
      reason,
    });
  }

  private pollWorkspace(cwd: string): void {
    const nextSnapshot = snapshotWorkspace(cwd);
    const paths = new Set([...this.fileSnapshot.keys(), ...nextSnapshot.keys()]);

    for (const relativePath of paths) {
      if (shouldIgnorePath(relativePath)) {
        continue;
      }

      const before = this.fileSnapshot.get(relativePath) ?? { exists: false, type: "missing" as const };
      const after = nextSnapshot.get(relativePath) ?? { exists: false, type: "missing" as const };
      const changeKind = classifyChange(before, after);
      if (changeKind === "unchanged") {
        continue;
      }

      this.emitEvent("file:changed", {
        taskId: this.taskId,
        runId: this.attributionRunId(),
        path: relativePath,
        absolutePath: path.join(cwd, relativePath),
        eventType: "poll",
        changeKind,
        type: after.type,
        size: after.exists ? (after.size ?? null) : null,
        mtimeMs: after.exists ? (after.mtimeMs ?? null) : null,
        sha256: null, // OBS S7: poll fallback compares stat identity only.
      });
    }

    this.fileSnapshot = nextSnapshot;
  }

  private beginRun(
    text: string,
    kind: RunKind,
    options: { title?: string; promptId?: string | null; revivalOf?: RunId } = {},
  ): ActiveRun {
    // A run beginning supersedes any in-flight control switch (model/effort OR a
    // permission stepping run): the receipt window is over (a new turn is
    // starting), so drop the pending watch and its timer(s) — otherwise a stale
    // per-step timeout could later fire a spurious needs-attention mid-run. Covers
    // a Sonata send AND a submit typed natively in the terminal (the renderer
    // send-gate can't see the latter). The matching `run:started` emitted below is
    // what clears the renderer's `view.controlSwitch`, so the two sides can't
    // disagree.
    this.controlSwitch.clear();
    if (this.activeRun) {
      this.finishActiveRun("completed", "closed by next input");
    }

    const now = new Date();
    const trimmed = text.trim();
    const run: ActiveRun = {
      taskId: this.taskId,
      id: `run-${now.getTime()}-${++this.runSeq}`,
      kind,
      prompt: text,
      promptId: options.promptId ?? null,
      // Rides `run:started`, for the same reason the honest title does: the
      // first event is what mints the run-index row and reaches the reading
      // surface, so the link must be there from the start rather than patched in.
      ...(options.revivalOf ? { revivalOf: options.revivalOf } : {}),
      title: options.title ?? (trimmed.split(/\r?\n/, 1)[0]?.slice(0, 120) || "(empty prompt)"),
      status: "active",
      lifecyclePhase: "active",
      startedAt: now.toISOString(),
      endedAt: null,
      elapsedMs: null,
      completionSource: null,
      completionConfidence: null,
    };

    this.activeRun = run;
    this.recentAttributionRun = null;
    this.activeRunRaw = "";
    // Retain the run-start workspace baseline for the turn-boundary reconcile
    // (OBS S6). A shallow Map copy — paths+stat only, no walk (fileSnapshot's
    // entries are replaced, never mutated, so the copy stays stable as the
    // watcher advances the live snapshot during the run).
    this.runStartSnapshot = new Map(this.fileSnapshot);
    this.debugCompletion(`begun "${trimmed.slice(0, 40)}"`);
    this.emitEvent("run:started", run);
    // Arm the completion path at birth: a run whose command was already
    // painted before the run began (a late hook-begun run, a command that
    // produces no further printable output) would otherwise wait on a
    // printable chunk that never comes.
    this.scheduleCompletionCheck();
    return run;
  }

  private updateActiveRun(patch: Partial<ActiveRun>): ActiveRun | null {
    if (!this.activeRun) {
      return null;
    }

    this.activeRun = {
      ...this.activeRun,
      ...removeUndefined(patch),
    };
    this.emitEvent("run:updated", this.activeRun);
    return this.activeRun;
  }

  private finishActiveRun(
    status: RunStatus,
    reason: string,
    metadata: {
      completionSource?: CompletionSource;
      completionConfidence?: CompletionConfidence;
      completionHint?: CompletionHint;
      /** SL-16 — the turn-end payload declared in-flight background work that
       *  will wake the session. Stamped on the finished run AND armed as the
       *  host's awaited wake, in one place, so the record and the attribution
       *  pointer can never disagree about which run is waiting. */
      pendingWake?: PendingWake;
    } = {},
  ): ActiveRun | null {
    if (!this.activeRun) {
      return null;
    }
    this.debugCompletion(`finish status=${status} reason="${reason}"`);

    const endedAt = new Date();
    const completionSource = metadata.completionSource ?? completionSourceForStatus(status);
    const completionConfidence = metadata.completionConfidence ?? completionConfidenceForStatus(status);
    const errorExcerpt =
      completionSource === "terminal-idle-heuristic"
        ? extractProviderErrorExcerpt(this.activeRunRaw, this.profile.provider)
        : null;
    const completionHint = errorExcerpt
      ? withCompletionErrorExcerpt(metadata.completionHint, errorExcerpt)
      : metadata.completionHint;
    const finished: ActiveRun = removeUndefined({
      ...this.activeRun,
      status,
      statusReason: reason,
      lifecyclePhase: status,
      completionSource,
      completionConfidence,
      ...(completionHint !== undefined ? { completionHint } : {}),
      ...(metadata.pendingWake ? { pendingWake: metadata.pendingWake } : {}),
      endedAt: endedAt.toISOString(),
      elapsedMs: endedAt.getTime() - Date.parse(this.activeRun.startedAt),
    });

    // Turn-boundary reconcile (OBS S6 / D3): emit the bounded workspace-stat
    // delta for the finishing run BEFORE clearing it, so Bash-mediated changes
    // the PostToolUse channel couldn't name still land on the run. Every run-end
    // path funnels through here, so this is the single honest reconcile seam.
    this.emitRunReconcile(finished.id);

    this.activeRun = null;
    this.activeRunRaw = "";
    // The sustained-idle window belongs to the run that just ended; a later run
    // must start its own (the runId check in `noteIdleVerdictForStoplessTurnEnd`
    // covers this too — clearing here keeps the state honest between runs).
    this.sustainedIdleVerdict = null;
    this.recentAttributionRun = {
      id: finished.id,
      expiresAt: Date.now() + this.postCompletionAttributionMs,
      prompt: finished.prompt,
    };
    this.lastFinishedPrompt = {
      text: finished.prompt.trim(),
      expiresAt: Date.now() + this.postCompletionAttributionMs,
    };
    // Arm the revival link from the SAME fact that stamped the record. Set
    // rather than merged: a fresh pause supersedes an older one (the newest
    // turn end is the one the wake will return to), and the older run keeps its
    // own honest stamp in the report either way.
    if (metadata.pendingWake) {
      this.runAwaitingWake = finished.id;
    }
    this.clearCompletionTimer();
    this.emitEvent("run:updated", finished);
    if (metadata.completionSource === "terminal-idle-heuristic") {
      this.markTaskReady(metadata.completionConfidence ?? "low");
    }
    return finished;
  }

  private scheduleCompletionCheck(): void {
    if (!this.activeRun || !this.ptyProcess) {
      return;
    }
    if (this.activeRun.status !== "active") {
      this.debugCompletion(`schedule-skip status=${this.activeRun.status}`);
      return;
    }

    this.clearCompletionTimer();
    this.completionTimer = setTimeout(() => this.checkCompletionHeuristic(), this.completionQuietMs);
  }

  private debugCompletion(message: string): void {
    // Diag-only telemetry (s4-diags); inert unless the env flag is set.
    if (process.env.SONATA_DEBUG_COMPLETION) {
      console.log(
        `[completion] ${new Date().toISOString()} run=${this.activeRun?.id ?? "none"} kind=${this.activeRun?.kind ?? "-"} ${message}`,
      );
    }
  }

  private checkCompletionHeuristic(): void {
    this.completionTimer = null;
    if (!this.activeRun || !this.ptyProcess) {
      return;
    }
    if (this.approvalActive || this.activeRun.status !== "active") {
      this.debugCompletion(
        `guard-exit approvalActive=${this.approvalActive} status=${this.activeRun.status}`,
      );
      return;
    }
    // Quiet = no PRINTABLE output. Raw-byte recency lies: the idle TUI emits
    // control-only housekeeping every ~200ms, which would keep this guard
    // (and the schedule debounce) re-arming forever.
    // NOTE (SL-2b review): this branch is effectively UNREACHABLE on the
    // streaming path and must not be trusted to police the sustained-idle
    // window. Every printable chunk both stamps `lastPrintablePtyDataAt` AND
    // calls `scheduleCompletionCheck`, which clears and re-arms at
    // `now + completionQuietMs` — so the judge can only ever fire at or after
    // `lastPrintablePtyDataAt + completionQuietMs`, making this test false at
    // every fire instant. A reset placed here would be dead code wearing a
    // safety comment. The real consequence is stronger and is handled where it
    // belongs (`stoplessTurnEndConfirmed`): during dense output NO judge pass
    // runs at all, so nothing here observes the output in the first place.
    if (Date.now() - this.lastPrintablePtyDataAt < this.completionQuietMs - 50) {
      this.debugCompletion(
        `data-fresh printableAgeMs=${Date.now() - this.lastPrintablePtyDataAt} → re-arm`,
      );
      this.scheduleCompletionCheck();
      return;
    }
    this.debugCompletion("judging");

    const hint = detectIdleComposer(this.activeRunRaw, this.profile);
    // A slash run has no model turn: no Stop hook closes it, and a cursor-diff
    // TUI may never repaint the composer ❯ into the run's OWN bytes — an
    // unknown command paints exactly one ⏺ line and nothing else, so S3's
    // "structural idle prompt in the run raw" test stayed false forever on a
    // static stream (■ wedged; the next send-click became an interrupt —
    // s4-diags/zzz-settle-probe). Reaching this line already guarantees the
    // stream has been QUIET for completionQuietMs (the animating spinner makes
    // real work never quiet), and that quiescence IS a slash run's honest
    // completion: the command was written and the CLI painted whatever it had
    // to say — output, or a panel now waiting for the human in the co-visible
    // terminal (the S5 attention banner's concern, not a busy state).
    // Supersedes S3's settle-on-panel-close, which this evidence showed was
    // repaint-order luck (Woody, 2026-07-02).
    const idleVerdict = this.activeRun.kind === "slash" ? true : hint.completed;
    // Turn-Signal Authority S1a (2026-07-16): once the SessionStart handshake
    // has landed for this PTY, the Stop/StopFailure hooks OWN a model turn's
    // end. The quiescence scrape is then only a backstop for the silent-tool-
    // stop gap (anthropics/claude-code#29881), so with hooks alive it may close
    // a PROMPT run ONLY on MEDIUM-confidence idle-footer evidence
    // (`hasModelOrCwdHint` — on claude the "? for shortcuts" needle a TRUE idle
    // composer paints; codex has NO such footer, its idle line is
    // `<model> <effort> · <cwd>` and the model/effort tokens carry the same
    // evidence — measured 0.146.0, upstream sync 2026-08-03). LOW-confidence
    // closure survives only for hook-less sessions (the honest backstop for a
    // never-handshook CLI). Field evidence, claude 2.1.211: a big-session
    // post-submit stall leaves a >=1.75s printable-quiet
    // window while the model still works for minutes, and detectIdleComposer
    // reads the submit frame (activity glyph, then the composer ❯) as completed
    // at LOW confidence — closing a 2s-old live run. All 5 field misfires were
    // low-confidence; the medium gate blocks each. Failure direction (Woody):
    // prefer a "still working" lie (liveness surfaces it honestly at 20s/60s)
    // over a "done" lie (actively misleading). Slash runs keep quiescence as
    // their honest completion — no Stop hook exists for them.
    //
    // SL-2b (2026-09-01, claude 2.1.257) added the third arm below. The medium
    // gate turned out to be a COIN FLIP at 2.1.257, not a test: whether the
    // alt-screen differential repaint happens to re-emit the footer after the
    // composer glyph decides it (q11 — a natively-denied tool reaches medium and
    // closes in 3.5s; a user Esc leaves `"❯ "` alone and wedges the run active
    // forever). `noteIdleVerdictForStoplessTurnEnd` is the honest replacement for
    // the case medium cannot reach.
    //
    // Why the medium arm was KEPT rather than retired: it never fires for a turn
    // the hooks cover. Those close on `Stop` at HIGH confidence in ~2s and never
    // reach this function's closing branch at all. Every measured medium close
    // was a STOP-LESS ending (q11 s6, a denied tool, closed 3.5s in) — i.e. the
    // medium arm lives entirely inside the gap, where dropping it would remove
    // coverage rather than remove a lie. It is also the SAFER of the two arms
    // (the stream reached medium in 0 of 18 samples of a live turn), so where it
    // does fire it earns a faster close than the confirm window would give.
    this.noteIdleVerdictForStoplessTurnEnd(idleVerdict);
    // Which arm admits this close — named once, so the gate and the reason it
    // reports can never drift apart. Order is evidence-strength: the sustained
    // window is only consulted when nothing stronger already admits the close
    // (which also keeps its `viewportText()` read off the common path).
    const closingArm = this.activeRun.kind === "slash" || !this.hookSessionStarted || hint.confidence === "medium"
      ? "terminal idle/composer heuristic"
      : this.stoplessTurnEndConfirmed()
        ? "sustained idle composer (Stop-less turn end)"
        : null;
    const completed = idleVerdict && closingArm !== null;
    // The sustained arm is the one a field triage will need to reason about
    // (a run that "should have closed" is a question about this window), so the
    // diag line carries its age — inert unless SONATA_DEBUG_COMPLETION is set.
    this.debugCompletion(
      `verdict idle=${idleVerdict} confidence=${hint.confidence} arm=${closingArm ?? "none"}` +
        ` sustainedIdleMs=${this.sustainedIdleVerdict ? Date.now() - this.sustainedIdleVerdict.since : "-"}`,
    );
    if (!completed) {
      this.updateActiveRun({
        lifecyclePhase: "active",
        lastLifecycleHint: hint,
      });
      // A DEMOTED verdict — the scrape sees an idle composer but hooks own this
      // turn's end — must keep the run under judgment: re-arm so a later Stop,
      // a medium-confidence idle footer, or the sustained-idle confirmation
      // still closes it. (The old not-completed branch returned without
      // re-arming, relying on the next printable chunk to re-schedule; a demoted
      // run can go byte-silent for minutes, so it needs its own poll.) This
      // re-arm is also what MEASURES the sustained window: each pass calls
      // `noteIdleVerdictForStoplessTurnEnd` again, so no separate timer is
      // needed — the window simply runs from the first idle pass until a pass
      // sees something else. No busy loop:
      // scheduleCompletionCheck no-ops once the run leaves "active", and the
      // printable-quiet guard debounces each re-arm to a completionQuietMs
      // cadence.
      if (idleVerdict && closingArm === null) {
        this.scheduleCompletionCheck();
      }
      return;
    }

    // The reason names WHICH backstop closed it — the two arms rest on very
    // different evidence and a field triage should not have to guess.
    this.finishActiveRun("completed", closingArm, {
      completionSource: "terminal-idle-heuristic",
      completionConfidence: this.activeRun.kind === "slash" ? "medium" : hint.confidence,
      completionHint: hint,
    });
  }

  /**
   * Track how long the active run has read idle-composer-completed WITHOUT
   * interruption. Called from every completion judge pass that actually judged
   * (the closing ones and the demoted ones that re-arm). THREE things restart
   * the window, which together are what make "continuously idle" a true claim
   * rather than a wall-clock-since-arming one: a pass that reads the run as
   * not-idle, printable output that landed after the window was armed, and a
   * change of run — a new run never inherits a previous one's window.
   */
  private noteIdleVerdictForStoplessTurnEnd(idleVerdict: boolean): void {
    if (!idleVerdict || !this.activeRun) {
      this.sustainedIdleVerdict = null;
      return;
    }
    if (
      this.sustainedIdleVerdict?.runId !== this.activeRun.id ||
      // Printable output landed AFTER this window was armed, so the stretch it
      // claims to measure was interrupted — restart it. Judge passes do not run
      // during dense output (see the caller's data-fresh note), so this
      // timestamp comparison is the only thing that can notice; without it
      // `since` would survive an arbitrarily long live stretch and the field
      // would be measuring wall-clock-since-arming while claiming to measure
      // continuous idleness.
      this.lastPrintablePtyDataAt > this.sustainedIdleVerdict.since
    ) {
      this.sustainedIdleVerdict = { runId: this.activeRun.id, since: Date.now() };
    }
  }

  /**
   * The claude STOP-LESS turn-end backstop (SL-2b) — a SECOND admitting arm
   * beside the medium gate, for the endings medium structurally cannot reach.
   *
   * MEASURED at 2.1.257 (q11, `spikes/upstream-sync-2026-09/claude`), which asked
   * what the hook family actually covers for turn completion:
   *   - a normal turn, a turn whose tool failed, a 91-second foreground tool
   *     call, and `/exit` ALL end on `Stop` — hooks own them, high confidence.
   *   - a user Esc mid-turn in the co-visible Terminal fires NO hook at all, and
   *   - a user denying a tool on the CLI's native panel fires none either
   *     (`PermissionDenied` is injected and does not fire for a UI deny).
   * Those two are the whole residual gap, and neither is reachable by wiring a
   * new event: of the 33 events 2.1.257 declares, `SessionEnd` fires only on
   * process teardown (reason `prompt_input_exit`) and `Notification(idle_prompt)`
   * — which DOES fire at this version, 60s after a turn ends, falsifying the
   * Phase-0 note — is anchored on the same turn-end the Stop hook is: it never
   * arrived in the 100s after either Stop-less ending. So the backstop stays a
   * screen judgement, and the job here is to make it an honest one.
   *
   * Three independent terms, each on the channel that can answer it (D-1):
   *  1. EVENT (stream, the caller's `idleVerdict`): did THIS RUN's own bytes go
   *     activity → composer? This is the term that carries the real weight — over
   *     18 samples spanning a genuinely live 91s tool call it read false every
   *     time, while every grid-side reading said "idle".
   *  2. STATE (grid, here): is a real composer on screen RIGHT NOW, with no panel
   *     owning it? An approval/option panel's end marker outranks its row cursor,
   *     so `detectIdlePrompt` reads a panel frame as not-ready — which is exactly
   *     the state that must not be closed as "done". Deliberately NOT the grid's
   *     CONFIDENCE: the idle footer is permanent chrome at 2.1.257 (present in
   *     18/18 busy samples), so a grid-fed `hasModelOrCwdHint` would be a vacuous
   *     gate — the measurement that falsified F5b's first candidate fix.
   *  3. TIME (here), in two parts that must BOTH hold: (a) the STREAM has been
   *     printable-silent for the whole window, and (b) a judge pass read the run
   *     idle across that whole window. (a) is stated on raw timestamps so it
   *     cannot be defeated by how the judge is scheduled — the first version of
   *     this predicate had only (b) and was wrong, because no judge pass runs
   *     during dense output, so an armed window survived arbitrary live
   *     streaming. The documented misfire shape is a post-submit stall with a
   *     >=1.75s printable-quiet window on a live run; requiring an order of
   *     magnitude more SILENCE than that is what buys back the safety the medium
   *     gate was standing in for.
   *
   * Claude-only by construction. Codex's stream is unaffected (it spawns
   * `--no-alt-screen`, so its footer stays inside the promptTail window and the
   * medium gate is a real test there), and its no-Stop turn-failure net is D6 —
   * both stay byte-identical.
   *
   * No screen model means no grid, so term 2 cannot be answered: refuse rather
   * than assume, matching every other grid predicate on this class.
   *
   * RESIDUAL RISK, stated rather than hidden. This admits a close on the ABSENCE
   * of liveness evidence, not on positive proof the turn ended — so the 2.1.211
   * field-misfire shape (a post-submit stall reading composer-after-activity at
   * LOW confidence) becomes closable IF that stall stays printable-SILENT for 30
   * continuous seconds. Two things bound it and one thing would remove it:
   *  - bound: term (a) demands genuine continuous printable SILENCE for the
   *    whole window, measured on the stream's own timestamps; the misfires it
   *    was built against had ~1.75s windows.
   *  - bound: a live claude turn at 2.1.257 renders an ANIMATED spinner with a
   *    running elapsed/token counter — measured repainting ~every second across
   *    a 91-second tool call (q11 s7), so a printable-silent live turn is
   *    structurally hard to produce. This is the load-bearing assumption, and it
   *    rests on ONE measured live-turn arm.
   *  - the removal, if it ever bites: require POSITIVE turn-end evidence on the
   *    grid instead — 2.1.257 paints `✻ <verb> for Ns · done` at every completed
   *    turn and `⎿ Interrupted · What should Claude do instead?` at an interrupt
   *    (both MEASURED under the production statusLine spawn, q11 s1/s3/s5/s6/s7).
   *    Deliberately NOT built now: it is upstream copy, and its failure mode is
   *    the SAFE one (a reword stops the close, i.e. reverts to today's wedge), so
   *    it is the right thing to add on evidence and the wrong thing to add on
   *    speculation. Registered in the sync findings (F13).
   * The certain harm on the other side is not hypothetical: without this, EVERY
   * user Esc mid-turn and EVERY native tool denial leaves a run "working"
   * forever (q11 s3/s6, MEASURED).
   */
  private stoplessTurnEndConfirmed(): boolean {
    if (this.profile.provider !== "claude" || !this.screenModel || !this.sustainedIdleVerdict) {
      return false;
    }
    const now = Date.now();
    // TIME (a) — THE STREAM has been printable-SILENT for the whole window.
    // Stated directly on the timestamps and on nothing else, so it holds however
    // the completion judge happens to be scheduled. This is the load-bearing
    // term, and its absence was the review's blocking finding: judge passes do
    // not run during dense output at all (every printable chunk re-arms the
    // timer to `now + completionQuietMs`), so a window armed once could survive
    // an arbitrarily long live stretch — an early post-submit stall arms it, a
    // minute of real streaming goes unobserved, and the next >=1.8s pause closes
    // a live run. It also covers the approval case for free with no
    // approval-specific code: the guard-exit at the top of the judge returns
    // before any bookkeeping, so an entire panel episode is invisible to (b) —
    // but a panel PAINTS, and its paint is printable.
    if (now - this.lastPrintablePtyDataAt < this.stoplessTurnEndConfirmMs) {
      return false;
    }
    // TIME (b) — and a judge pass read the run idle across that whole window,
    // never merely at this instant. Kept beside (a) rather than folded into it
    // because it answers a different question (what the RUN's bytes said, not
    // what the stream did), and because a field named `sustainedIdleVerdict`
    // must actually mean sustained — see `noteIdleVerdictForStoplessTurnEnd`.
    if (now - this.sustainedIdleVerdict.since < this.stoplessTurnEndConfirmMs) {
      return false;
    }
    return detectIdlePrompt(this.screenModel.viewportText(), this.profile).ready;
  }

  /**
   * Complete the active run from the authoritative turn-end signal — the Claude
   * `Stop` hook. This is the honest answer to "did the turn end?": a structured
   * event, not the composer-idle screen scrape. `checkCompletionHeuristic`
   * stays as the fallback (for hook-less sessions or a missed Stop), so this is
   * purely additive — Stop completes promptly, the scrape still backstops it.
   *
   * A no-op when no Sonata-owned run is active (a take-over turn, or the scrape
   * already finished it — which also avoids any double-completion) and for
   * runs mid-stop. UNLIKE the heuristic it is NOT gated on the approval flag:
   * a genuinely pending ask holds its turn open, so Stop arriving while we
   * think an approval is waiting proves that state stale — see the guard
   * comment in the body (2026-07-03 phantom-resurface wedge).
   *
   * `ending` names WHICH turn ending fired, and the completion is stamped with
   * it. `"interrupt"` (codex's `Interrupt` hook) is NOT a flavour of `"stop"`:
   * see `CompletionSource["hook-interrupt"]` for the invariant that separates
   * them and the consumer that depends on the separation. A closed two-member
   * union rather than a raw `CompletionSource` — this method may only ever stamp
   * a hook-driven ending, and the type should say so.
   *
   * `turnEndWake` is what the SAME payload said about whether this ending is
   * FINAL (SL-16) — already resolved against the session's history by the
   * controller's `BackgroundWorkTracker`, because "is anything in flight?" and
   * "did THIS turn leave something behind?" are different questions and only the
   * second one is a pause (review B1).
   *
   * Its `returned` half is handled BEFORE the no-active-run guard, and that order
   * is load-bearing rather than incidental: the F43 revival — measured 1 of 9 —
   * fires no `UserPromptSubmit`, so Sonata mints no run for it and the only
   * trace it leaves anywhere on this wire is precisely this call arriving with
   * `returned: true` and nothing active. Settling the wake there is what stops a
   * LATER, unrelated task-notification from being attributed to a wake that
   * already happened. The method's name still describes what it does when there
   * IS a run; when there is not, it is the turn-end signal settling the one
   * piece of state that outlives runs.
   */
  completeRunFromTurnEnd(options?: {
    errorExcerpt?: string;
    ending?: "stop" | "interrupt";
    turnEndWake?: TurnEndWake;
  }): ActiveRun | null {
    // Positive evidence that awaited work came back ends the pause. Note this is
    // NOT "the array is empty": a dev server still running while the shell we
    // were waiting on finished is a genuine return, and an empty array while
    // nothing was ever awaited is not.
    if (options?.turnEndWake?.returned) {
      this.runAwaitingWake = null;
    }
    if (!this.activeRun) {
      return null;
    }
    // Stop outranks a stale approval flag. A genuinely pending ask holds its
    // turn open (the broker blocks inside the PermissionRequest hook; a
    // native panel blocks the tool call), so Stop CANNOT fire while one is
    // truly waiting — its arrival proves the waiting-for-approval state is a
    // scrape artifact (an already-answered panel's bytes re-detected from the
    // run buffer). Trust the CLI: clear the stale state and complete. Every
    // other non-active status (stopping/stopped/…) keeps the no-op guard.
    const staleApproval =
      this.approvalActive || this.activeRun.status === "waiting-for-approval";
    if (this.activeRun.status !== "active" && this.activeRun.status !== "waiting-for-approval") {
      return null;
    }
    if (staleApproval) {
      this.debugCompletion("stop hook while approval flagged — treating as stale scrape state");
      // The scraped ask this flag stands for already emitted an
      // `approval:detected`, and clearing the flag here is SILENT — so its
      // decision never comes and the DeliveryController's SCRAPE_APPROVAL_KEY
      // (released only by an `approval:decision`) gates every later send
      // forever, while `isApprovalActive()` reads clean the whole time. Hand
      // the orphan to the controller rather than emitting here; see
      // `takeOrphanedScrapeApproval` for why this must not be an event.
      // Gated on the FLAG, not on `staleApproval`: the status-only arm of that
      // disjunct has no outstanding detection behind it.
      if (this.approvalActive) {
        this.orphanedScrapeApproval = { previousKind: this.lastApprovalKind };
      }
      this.approvalActive = false;
      this.approvalSuppressedInSettleWindow = false;
      this.clearApprovalSettleTimer();
    }
    // SL-16 — "ended, expecting wake", stamped on whichever ending fired. The
    // turn genuinely ended, so the status stays `completed` and the evidence
    // stays `hook-stop`/`high`: the Stop hook is exactly as authoritative about
    // the ENDING as it ever was, and demoting the confidence would corrupt a
    // well-defined axis ("how sure are we the turn ended?") to smuggle in an
    // answer to a different question. `pendingWake` IS that different question,
    // carried beside it rather than folded into it.
    const pendingWake = options?.turnEndWake?.opened ?? undefined;
    // `StopFailure` (probed S6: fires on API errors with a structured
    // `error` field, while Stop stays silent) rides the same completion
    // path — the turn ENDED; the hint carries the structured error, so the
    // scrape-side excerpt extraction is now the fallback, not the primary.
    // Claude-only, so it can never coexist with the codex interrupt ending.
    if (options?.errorExcerpt) {
      return this.finishActiveRun("completed", "stop-failure hook (turn failed)", {
        completionSource: "hook-stop",
        completionConfidence: "high",
        completionHint: withCompletionErrorExcerpt(undefined, options.errorExcerpt),
        ...(pendingWake ? { pendingWake } : {}),
      });
    }
    if (options?.ending === "interrupt") {
      return this.finishActiveRun("completed", "interrupt hook (turn interrupted)", {
        completionSource: "hook-interrupt",
        completionConfidence: "high",
        ...(pendingWake ? { pendingWake } : {}),
      });
    }
    return this.finishActiveRun(
      "completed",
      pendingWake ? "stop hook (turn ended, background work pending)" : "stop hook (turn ended)",
      {
        completionSource: "hook-stop",
        completionConfidence: "high",
        ...(pendingWake ? { pendingWake } : {}),
      },
    );
  }

  private clearCompletionTimer(): void {
    if (!this.completionTimer) {
      return;
    }
    clearTimeout(this.completionTimer);
    this.completionTimer = null;
  }

  /**
   * Take (once) the orphaned scraped approval that `completeRunFromTurnEnd`'s
   * stale-approval clear left behind, or null when there is none.
   *
   * A HANDOFF, not an event, and deliberately so. The decision that releases
   * this orphan has to reach the delivery gate, the renderer and the run-index
   * WITHOUT passing through this host's event sink — that sink is the only feed
   * into `CliStateModel.applyRuntimeEvent`, whose `approval:decision` → `busy`
   * rule would overwrite the `turn-ended` the Stop hook set moments earlier
   * (`RuntimeController.applyHookToTask` drives cli-state BEFORE it calls this
   * method), and nothing downstream corrects it: cli-state's only other
   * turn-enders are hooks and `task:ready`, which a hook-stop completion never
   * fires. So `RuntimeController.releaseOrphanedScrapeApproval` builds the
   * event and hands it to the three consumers explicitly — the same shape, for
   * the same reason, as `concludeExpiredBrokerApprovals`.
   *
   * Read-and-clear, mirroring that method's delete-before-emit: a re-emitted or
   * replayed turn-end can never fire a second decision for one ask.
   */
  takeOrphanedScrapeApproval(): { previousKind: ApprovalKind | null } | null {
    const orphan = this.orphanedScrapeApproval;
    this.orphanedScrapeApproval = null;
    return orphan;
  }

  private clearApprovalSettleTimer(): void {
    if (!this.approvalSettleTimer) {
      return;
    }
    clearTimeout(this.approvalSettleTimer);
    this.approvalSettleTimer = null;
  }

  /**
   * `task:ready` = a quiescence-completed run returned the composer. Fired
   * only from `finishActiveRun` (terminal-idle-heuristic completions: slash
   * runs, the Esc-interrupt run-closer, codex turns). Its consumer is the
   * cli-state busy→turn-ended fallback — the only path off "busy" for turns
   * that end with no Stop hook (probe s6-diags). The between-runs poller
   * that used to feed it (`checkTaskReady` — an ambient composer-ready
   * detector on the raw-byte clock, starved forever by the idle TUI's
   * ~200ms control-only heartbeat) was retired in S6: contract §3.4 retired
   * the continuous composer-ready gate, and every other consumer had an
   * independent structured path. `taskReady` dedups to one event per idle
   * period (any submit/approval/stop resets it).
   */
  private markTaskReady(confidence: CompletionConfidence): void {
    if (this.taskReady) {
      return;
    }
    this.taskReady = true;
    this.emitEvent("task:ready", {
      taskId: this.taskId,
      source: "terminal-idle-composer-heuristic",
      confidence,
    });
  }

  /**
   * The turn-boundary reconcile (OBS S6 / D3). ONE workspace stat walk per run
   * end (never per event): diff the current workspace against the snapshot
   * retained at run start and report the paths that changed during the run. This
   * catches Bash-mediated (and any hook-invisible) edits the semantic PostToolUse
   * channel cannot name. `shouldIgnorePath` (inside `snapshotWorkspace`) keeps
   * build noise out on BOTH sides — the reconcile can never reintroduce the storm
   * the watcher used to. The run-index appends only the subset not already
   * tool-attributed. The diff is stat-identity (type/size/mtimeMs) via the shared
   * `classifyChange` — hash-free since OBS S7 (D4).
   */
  private emitRunReconcile(runId: RunId): void {
    const cwd = this.cwd;
    const baseline = this.runStartSnapshot;
    if (!cwd || !baseline) {
      return;
    }
    const current = snapshotWorkspace(cwd);
    const changes: RuntimeReconcileChange[] = [];
    const paths = new Set([...baseline.keys(), ...current.keys()]);
    for (const relativePath of paths) {
      const before = baseline.get(relativePath) ?? { exists: false, type: "missing" as const };
      const after = current.get(relativePath) ?? { exists: false, type: "missing" as const };
      const changeKind = classifyChange(before, after);
      if (changeKind === "unchanged") {
        continue;
      }
      changes.push({
        path: relativePath,
        absolutePath: path.join(cwd, relativePath),
        changeKind,
        type: after.exists ? after.type : "missing",
        size: after.exists ? (after.size ?? null) : null,
        sha256: null, // OBS S7: reconcile diffs stat identity — hash-free.
      });
      // Bound the event payload; the run-index caps again at append. A reconcile
      // this large means an ignored-dir escape, not normal work — the tail is
      // representative enough for the forensic record.
      if (changes.length >= RECONCILE_CHANGE_CAP) {
        break;
      }
    }
    if (changes.length === 0) {
      return;
    }
    this.emitEvent("run:reconciled", { taskId: this.taskId, runId, changes });
  }

  private attributionRunId(): RunId | null {
    if (this.activeRun) {
      return this.activeRun.id;
    }
    if (this.recentAttributionRun && this.recentAttributionRun.expiresAt > Date.now()) {
      return this.recentAttributionRun.id;
    }
    return null;
  }

  private emitEvent<T extends RuntimeEvent["type"]>(
    type: T,
    payload: Extract<RuntimeEvent, { type: T }>["payload"],
  ): void {
    const event = {
      type,
      payload,
      ts: new Date().toISOString(),
    } as Extract<RuntimeEvent, { type: T }>;
    this.emit(type, event);
    if (this.eventSink) {
      this.eventSink(event);
    }
  }
}

/**
 * The ONE place Sonata's user-facing permission mode fans back out to Codex's
 * legacy (sandbox × approval × reviewer) axes — verified live against codex
 * 0.144.4 (spikes/codex-perm-profile-probe, probe-modes.mjs): each row shows the
 * matching "(current)" in the TUI `/permissions` picker, full-access boots
 * straight into "YOLO mode" with no confirmation modal, and every row's
 * `approvals_reviewer` is accepted at spawn. The explicit `approvals_reviewer`
 * on ALL rows shields Sonata sessions from a globally-persisted `auto_review`
 * (which the Codex TUI writes into the active config layer) bleeding in.
 *
 * Keyed on `CodexOfferedPermissionMode`, NOT the full nameable vocabulary, and
 * that is the point: `read-only` is a mode Sonata can OBSERVE (codex's cycle-only
 * fourth mode, SL-17) and has deliberately not decided to OFFER, so it has no
 * row here — and because the key type excludes it, nothing can reach this table
 * holding one. Widening the key is the deliberate act that would make Read Only
 * spawnable; it is not something a caller can do by accident.
 *
 * `permission_profile`/`default_permissions` (the upstream profile system) are
 * silently ignored on 0.144.4 — when they start working, this table is the one
 * function to swap.
 */
const CODEX_PERMISSION_MODE_FLAGS: Record<
  CodexOfferedPermissionMode,
  { sandbox: CodexSandboxMode; approval: CodexApprovalMode; reviewer: string }
> = {
  "ask-for-approval": { sandbox: "workspace-write", approval: "on-request", reviewer: "user" },
  "approve-for-me": { sandbox: "workspace-write", approval: "on-request", reviewer: "auto_review" },
  "full-access": { sandbox: "danger-full-access", approval: "never", reviewer: "user" },
};

export function codexArgs(options: {
  cwd: string;
  permissionMode: CodexOfferedPermissionMode;
  model?: string | null | undefined;
  reasoningEffort?: ReasoningEffort | null | undefined;
  speedMode?: LaunchSpeedMode | null | undefined;
  resumeLast?: boolean;
  resumeRef?: string | undefined;
  /** Layer the Sonata hook profile via `-p <profile>` (CONFIG_PROFILE_V2). Unset
   *  → no profile flag (bare TerminalHost in a test still works). */
  profile?: string | undefined;
  /** Emit `-c check_for_update_on_startup=false`. Sonata sets this only when it
   *  owns keeping Codex current; unset → codex's own boot prompt is untouched. */
  suppressUpdatePrompt?: boolean | undefined;
}): string[] {
  const base = options.resumeRef
    ? ["resume", options.resumeRef]
    : options.resumeLast
      ? ["resume", "--last"]
      : [];
  const configOverrides: string[] = [];
  if (options.reasoningEffort) {
    configOverrides.push("-c", `model_reasoning_effort=${tomlString(options.reasoningEffort)}`);
  }
  if (options.speedMode === "fast") {
    configOverrides.push("-c", `service_tier=${tomlString("priority")}`);
  }
  if (options.suppressUpdatePrompt) {
    // Sonata owns keeping Codex current, so codex's own boot prompt would be a
    // second voice asking about the same thing. This key is the FIRST check in
    // both `get_upgrade_version_for_popup()` and `get_upgrade_version()`
    // (codex-rs/tui/src/updates.rs), so `false` short-circuits the popup path
    // structurally rather than racing it (G2).
    //
    // Bare `false` — a TOML boolean, NOT `tomlString`: the key is `Option<bool>`
    // and a quoted "false" would fail to deserialize. Per-spawn only; Sonata
    // never writes this into the user's own ~/.codex/config.toml (that would
    // silently change their terminal too — an explicitly rejected alternative).
    configOverrides.push("-c", "check_for_update_on_startup=false");
  }
  const permission = CODEX_PERMISSION_MODE_FLAGS[options.permissionMode];
  return [
    ...base,
    // `-p sonata` layers Sonata's hook profile onto the user's own config (union,
    // never clobber — verified). Placed ahead of the run flags; Codex accepts
    // it on both the TUI and exec forms.
    ...(options.profile ? ["-p", options.profile] : []),
    // `--dangerously-bypass-hook-trust` is REQUIRED whenever we inject the
    // profile: Codex does NOT persist hook trust for a `-p` PROFILE layer (only
    // User/SessionFlags layers can carry `[hooks.state]`), compounded by a known
    // silent trust-write failure under node-pty (openai/codex #22847, PR #17595).
    // Without it, EVERY new session re-prompts "N hooks need review" and our
    // control plane never runs. The flag is codex's documented path for
    // "automation that already vets its own hook sources" (we generate our own
    // shims); it does NOT un-gate an untrusted repo's `.codex/hooks.json` (those
    // load only for an already-trusted project). Full analysis + Woody's decision:
    // spikes/codex-hook-trust-research/findings.md (D4 overturn, 2026-07-06).
    // Gated on `profile` so a bare-TerminalHost test spawn (no hooks) stays clean.
    ...(options.profile ? ["--dangerously-bypass-hook-trust"] : []),
    "--no-alt-screen",
    ...(options.model?.trim() ? ["-m", options.model.trim()] : []),
    ...configOverrides,
    "-C",
    options.cwd,
    "-s",
    permission.sandbox,
    "-a",
    permission.approval,
    "-c",
    `approvals_reviewer=${tomlString(permission.reviewer)}`,
  ];
}

export function claudeArgs(options: {
  permissionMode?: ClaudePermissionMode | undefined;
  model?: string | null | undefined;
  reasoningEffort?: ReasoningEffort | null | undefined;
  settingsPath?: string | null | undefined;
  resumeRef?: string | undefined;
  sessionId?: string | undefined;
  remoteControl?: boolean | undefined;
}): string[] {
  return [
    ...(options.resumeRef ? ["--resume", options.resumeRef] : []),
    // --session-id pins a fresh session to a known id; it is mutually
    // exclusive with --resume (which already determines the id).
    ...(!options.resumeRef && options.sessionId ? ["--session-id", options.sessionId] : []),
    "--permission-mode",
    options.permissionMode ?? "default",
    ...(options.settingsPath ? ["--settings", options.settingsPath] : []),
    ...(options.model?.trim() ? ["--model", options.model.trim()] : []),
    ...(options.reasoningEffort ? ["--effort", options.reasoningEffort] : []),
    // MUST stay last: `--remote-control [name]` takes an OPTIONAL positional
    // name, so any flag placed after it would be swallowed as the name.
    ...(options.remoteControl ? ["--remote-control"] : []),
  ];
}

function terminalProviderProfile(provider: RuntimeProvider): TerminalProviderProfile {
  if (provider === "claude") {
    return {
      provider,
      defaultCommand: "claude",
      approvalSource: "native Claude PTY approval screen",
      supportsSlashStop: false,
      activityHints: [
        // DEAD UNDER PRODUCTION SPAWNS at 2.1.252, kept deliberately (upstream
        // sync 2026-09-01, SL-2 audit). Sonata's injected statusLine suppresses
        // this phrase completely — the q1 strict A/B found it absent from the
        // ENTIRE raw stream through a live turn (findings.md F5), and the SL-2
        // re-measurement saw the same (q5: a real turn's bytes carry
        // `✢ Gesticulating…`, `✳/✶/✻/✽` and the closing `✻ Churned for 1s`, and
        // no `esc to interrupt` anywhere). Both of this vocabulary's consumers
        // survive on the GLYPHS below, which are in the stream throughout:
        // `detectIdlePrompt`'s ordering anchor (composer must paint after work
        // text) and `detectIdleComposer`'s "work happened" evidence — the
        // end-of-turn summary line `✻ <verb> for Ns` reliably precedes the
        // repainted composer, which is exactly the ordering both rules want.
        // The phrase stays because it costs nothing, still appears on a spawn
        // without our statusLine (a bare TerminalHost in a test, and any future
        // spawn shape that drops it), and would come back the moment upstream
        // stops suppressing it. Nothing else in Sonata depends on it for claude:
        // StatusRegionTracker matches claude on glyphs (its `esc to interrupt`
        // pattern is codex-only), and `shared/terminal-transcript.ts` only
        // SUBTRACTS the phrase as chrome — an absent needle strips nothing.
        "esc to interrupt",
        "esctointerrupt",
        "thinking with",
        "thinkingwith",
        "cerebrating",
        "accomplishing",
        // Claude 2.x spinner/summary glyphs ("✶ Levitating…", "✻ Baked for 2s").
        // Resumed sessions never repaint the welcome banner, so these glyphs
        // are the only working-activity signal they emit. NOT self-sufficient
        // against premature completion: the old assumption ("the spinner
        // animates while working, so the completion quiet-window cannot elapse
        // mid-run") was falsified by claude 2.1.211 field evidence — a big-
        // session post-submit stall CAN stay printable-silent past the quiet
        // window while the model works for minutes, so detectIdleComposer sees
        // the submit frame (glyph, then composer ❯) as an idle prompt-after-
        // activity. The real guard now lives in checkCompletionHeuristic:
        // heuristic closure is confidence-gated when the SessionStart handshake
        // is alive (hooks own turn-end; the scrape may only close a prompt run
        // at MEDIUM confidence), so these glyphs no longer have to carry it.
        "✢",
        "✳",
        "✶",
        "✻",
        "✽",
      ],
      // `❯` is claude's own composer glyph; `>` and `›` are kept as the legacy
      // superset (welcome-screen placeholder, older layouts). `»` is NOT here:
      // it is codex's Ultra/Max composer glyph (upstream sync 2026-08-03) and
      // claude never paints it, so admitting it would only let a `»` in model
      // PROSE forge a prompt position in claude's stream.
      composerPromptGlyphs: [">", "›", "❯"],
      // The idle-footer needle behind `hasModelOrCwdHint` (a CONFIDENCE label,
      // never the `ready` verdict). Verified against claude 2.1.209
      // (spikes/claude-idle-prompt-fable/): the model/effort/cwd line renders
      // ABOVE the composer, outside the forward-700 promptTail window, so the
      // model tokens never match there on 2.1.x — the FOOTER is what lands
      // post-glyph at a true idle composer.
      //
      // STALE CLAIM RETIRED (upstream sync 2026-09-01, SL-2). The previous
      // comment here said `shortcuts` is what restores medium confidence and is
      // "absent while working (esc to interrupt)". Both halves are FALSIFIED for
      // PRODUCTION spawns at 2.1.252 — Sonata injects a statusLine on every
      // claude spawn (claude-runtime-settings.ts), and the q1 strict A/B
      // measured that config suppressing `? for shortcuts` and
      // `esc to interrupt` outright — absent at idle, absent through a live
      // turn, absent from the entire raw stream. The `◐ … · /effort` line is
      // suppressed on the SCREEN but not the stream: it is painted once in the
      // boot sequence and then erased when the statusline render lands
      // (spikes/upstream-sync-2026-09/claude/findings.md F5, capture q1a; the
      // pinned production-idle fixture carries that boot paint verbatim).
      //
      // What a production idle footer actually paints, MEASURED at 2.1.252
      // (q5-readiness-channel.capture.txt, all four permission modes walked):
      //     <statusline output>                                          /rc
      //     ⏸ manual mode on · ← for agents
      // so exactly ONE alternation below could still match — `for agents` — and
      // that affordance is upstream-churned territory (2.1.232 moved `/tasks`
      // and a `← N done` pulse into it). ONE reword there and the signal dies
      // silently. The mode line is the independent second token: it is present
      // in ALL FOUR modes (measured `⏸ manual mode on` / `⏵⏵ accept edits on
      // (shift+tab to cycle)` / `⏸ plan mode on (shift+tab to cycle)` /
      // `⏵⏵ auto mode on (shift+tab to cycle)`), and it is the one footer string
      // Sonata ALREADY depends on elsewhere — S2's permission-switch receipt
      // reads it — so a reword breaks a loud, tested path instead of only this
      // quiet one. The phrases are REUSED from that parser
      // (`CLAUDE_MODE_LINE_ON_SCREEN_RE`), never restated here.
      //
      // HONEST LIMIT — this redundancy does not restore production readiness on
      // its own, and SL-2 did not claim it does. `detectIdlePrompt` reads the
      // pty STREAM, and 2.1.252 paints inside the alternate screen (F3): its
      // differential repaint emits the footer BEFORE the composer glyph and then
      // homes the cursor to the composer, so after a real turn the forward-700
      // window is literally `"❯ "` — no footer, no token, whatever this regex
      // says. MEASURED over 42s of post-turn idle, 14 consecutive samples, raw
      // channel `confidence=low` every time while the reconstructed GRID read
      // `medium` every time (q5, section B). Fixing that is a CHANNEL question
      // (grid vs stream vs a Sonata-authored statusline beacon), registered for
      // Woody's design session — not a token question. The tokens here pay off
      // in the grid channel and cost nothing in the stream one.
      // Model/effort tokens kept as a harmless superset for other layouts.
      idlePromptModelHints: new RegExp(
        `${CLAUDE_MODE_LINE_ON_SCREEN_RE.source}|opus|sonnet|haiku|fable|xhigh|high|medium|low|effort|shortcuts|for agents|~`,
        "i",
      ),
      buildArgs: (options) =>
        claudeArgs({
          permissionMode: options.permissionMode,
          model: options.model,
          reasoningEffort: options.reasoningEffort,
          settingsPath: ensureClaudeRuntimeSettings(
            options.runtimeDir ?? path.join(options.cwd, ".sonata"),
            {
              approvalBroker: options.approvalBroker !== false,
              // Native fast mode (2.1.205+) rides in the injected `--settings`;
              // there is no claudeArgs flag for it. Opus-gated in the launch UI.
              fastMode: options.speedMode === "fast",
            },
          ),
          resumeRef: options.resumeRef,
          sessionId: options.sessionId,
          remoteControl: options.remoteControl,
        }),
      approvalHints: {
        fileRead: CLAUDE_FILE_READ_APPROVAL_HINTS,
        fileEdit: CLAUDE_FILE_EDIT_APPROVAL_HINTS,
        command: CLAUDE_COMMAND_APPROVAL_HINTS,
        workspaceTrust: CLAUDE_WORKSPACE_TRUST_APPROVAL_HINTS,
      },
      approvalEndMarkers: CLAUDE_PANEL_END_MARKERS,
      // EMPTY ON PURPOSE, and re-decided against a measured catalog (upstream
      // sync 2026-09-01, SL-3) rather than left as an assumption.
      //
      // The trust dialog is covered by the workspaceTrust needles above. The
      // boot sweep found exactly one OTHER interstitial that can own the screen
      // between spawn and the first idle composer — the fullscreen-renderer
      // offer (the catalog is spikes/upstream-sync-2026-09/claude/findings.md
      // F7) — and this vocabulary structurally cannot guard it. `bootDialogHints`
      // works by ORDERING: a needle only holds readiness when it paints AFTER
      // the composer glyph. The offer's identity paints BEFORE its `❯`; all
      // that follows the cursor row is `2. Not now` (too generic to admit — it
      // would let assistant prose forge a hold) and `Enter to confirm · Esc to
      // cancel`, which is already in the needle list twice. The guard for that
      // screen is therefore a grid screen-owner predicate, `isFullscreenOfferOpen`
      // — keyed on the offer's own wording, ranked above the SessionStart
      // short-circuit, and unaffected by paint order.
      bootDialogHints: [],
    };
  }

  return {
    provider,
    defaultCommand: "codex",
    approvalSource: "native Codex PTY approval screen",
    supportsSlashStop: true,
    // Fence-only ordering vocabulary, and both needles are still MEASURED present
    // in a live 0.152.1 turn's footer (`• Working (2s • esc to interrupt)`, q31
    // s1) — which is all this list needs them for. NOT a statement about the
    // interrupt key: `esc to interrupt` is upstream copy that SL-15 measured to
    // hold only before the model starts emitting (q34). The stop's key is chosen
    // in `stopInterruptKey`, never read off this line.
    activityHints: ["working", "esc to interrupt"],
    // `»` (U+00BB) is the SAME composer prompt as `›` (U+203A), rendered at the
    // Max/Ultra tiers. MEASURED byte-exact on codex 0.146.0
    // (spikes/upstream-sync-2026-08/codex/out-q2b-model-walk.frames.log): after a
    // switch to Ultra the composer paints `» Run /review on my current changes`
    // and STAYS `»` at idle — it is a tier state, not a transient. Sonata reaches
    // that state two ways: a native `/model` switch in the co-visible Terminal,
    // and its OWN launch menus (`reasoningOptionsForModel` offers max/ultra for
    // the models that allow them), which paint `»` from the very first frame.
    // Without this glyph the last prompt found in an Ultra tail is a STALE `›`/`>`
    // from the scrollback, which sits BEFORE the run's activity text — so
    // `detectIdlePrompt.ready` goes permanently false and, hook-first path aside,
    // the boot latch never opens (delivery) and the quiescence net never closes a
    // no-Stop codex turn. Codex's PICKER cursor is unaffected — it stays `›` in
    // the same capture — and the picker/consent anchors are not touched.
    composerPromptGlyphs: [">", "›", "❯", "»"],
    // The effort tokens are independent redundancy behind `gpt[-\w.]*` (an Ultra
    // footer still carries the model slug), so they must span all SIX tiers codex
    // can display, not the four v1 targets — same channel distinction the receipt
    // parser records: this reads what codex IS, `asCodexReasoningTarget` fences
    // what Sonata may ASK for. Measured idle footer at Ultra:
    // `gpt-5.6-sol ultra · <cwd>` (same capture).
    //
    // `default` joins them at 0.152.1 (SL-7, q29 arm B, MEASURED): a session with
    // no effort configured paints `gpt-5.6-sol default · <cwd>` — a SEVENTH token
    // in the effort position, and one that names the ABSENCE of a tier rather
    // than a tier, which is why a list built from the tier enum could not have
    // contained it.
    //
    // HONESTLY: adding it fixes no observed failure. That footer already matched
    // on `gpt[-\w.]*`, and it would have matched with or without this change —
    // there is no measured frame in which `default` is the only surviving needle
    // (the post-switch banner animation truncates the footer from the TAIL, so it
    // eats the effort token and the cwd while leaving the slug). It is added
    // because the RULE this alternation follows should be stateable — "every
    // token the effort position can display" — rather than "the six members of
    // the ReasoningEffort union", which is now a description of Sonata's type
    // instead of a description of codex's screen. Since C14 this predicate is
    // load-bearing for the boot latch, and a list whose membership rule has drifted
    // from its purpose is how a needle goes quietly missing.
    idlePromptModelHints: /gpt[-\w.]*|xhigh|high|medium|low|max|ultra|default|~/i,
    buildArgs: (options) => {
      // Spawn-prep the injected hook profile + stable shims (write-if-changed).
      // Byte-stable and task-invariant: the SessionStart handshake then carries
      // identity + hook liveness. Absent codexHookPaths (a bare TerminalHost in
      // a test) → no injection, no `-p sonata`.
      //
      // If the write fails (unwritable dir, ENOSPC, a shell-unsafe shim path),
      // DEGRADE to a hookless spawn rather than aborting the launch. Post-S4
      // there is NO scrape beneath: hookless codex degrades to Terminal-driven
      // use — the missing handshake raises the liveness banner AND a needs-you
      // notification (notification-policy: cli-hooks:liveness→missing), and any
      // approval is answered natively in the Terminal (no per-approval Sonata
      // card in this state; recorded in the plan's negative space).
      let profile: string | undefined;
      if (options.codexHookPaths) {
        try {
          ensureCodexRuntimeSettings(options.codexHookPaths);
          profile = CODEX_SONATA_PROFILE;
        } catch (error) {
          console.error(
            `[codex] hook profile write failed; launching hookless (scrape-driven): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      return codexArgs({
        cwd: options.cwd,
        permissionMode: options.codexPermissionMode ?? "ask-for-approval",
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        speedMode: options.speedMode,
        resumeLast: Boolean(options.resumeLast),
        resumeRef: options.resumeRef,
        profile,
        suppressUpdatePrompt: options.codexSuppressUpdatePrompt,
      });
    },
    // Codex approvals flow through the hook PermissionRequest broker (D5); the
    // native-panel scrape is retired for codex (S4). Empty hints keep the
    // shared scrape functions inert for codex even if `detectApproval`'s
    // provider guard is ever relaxed — belt and suspenders.
    approvalHints: {
      fileRead: [],
      fileEdit: [],
      command: [],
      workspaceTrust: [],
    },
    approvalEndMarkers: [],
    // Codex boot screens that render their option cursor with the composer's
    // own `›`. Every needle here sits AFTER that glyph in the paint stream, so
    // it outranks it in the idle-prompt ordering and holds readiness until the
    // human answers in the Terminal. That ORDERING is the whole mechanism: a
    // needle painting before the cursor row buys nothing (the claude
    // fullscreen-offer lesson, SL-3 — that screen needed a grid predicate
    // instead, because its identity paints ahead of its own `❯`).
    //
    // RE-WALKED LIVE at codex 0.152.0 (upstream sync 2026-09-01, SL-6) against
    // the pty window production actually scans — `cleanTerminal(rawTail)
    // .slice(-8000).toLowerCase()`, NOT a whitespace-stripped one — because
    // `detectIdlePrompt` matches each hint together with its `compactText`
    // twin against that single haystack. Evidence:
    // spikes/upstream-sync-2026-09/codex/q20-boot-ceremony.fresh-untrusted
    // .capture.txt (`rawAtDialog`) and q23-hooks-review.capture.txt
    // (`productionWindow`).
    //
    // DIRECTORY-TRUST DIALOG ("Do you trust the contents of this directory?
    // › 1. Yes, continue  2. No, quit  Press enter to continue"). Row order and
    // wording are UNCHANGED at 0.152.0, and the highlighted row is still the
    // AFFIRM one — codex did not repeat claude's 2.1.252 default-row flip. Of
    // the five needles, three fire on the production window ("press enter to
    // continue", "yes, continue", "no,quit") and the guard reads `ready: false`
    // while the dialog owns the screen. The comma-tight spellings are LOAD
    // BEARING, not belt-and-braces: `compactText` strips every non-alphanumeric,
    // so "no, quit" yields "noquit" — and the cursor-paint stream renders the
    // row as "no,quit", which keeps the comma and drops the space. Neither the
    // literal nor its compact twin matches that; only the explicit spelling does.
    // "yes,continue" fired at 0.144.x and does NOT fire here — kept, not pruned:
    // WHICH characters a cell-diff repaint elides depends on the previous frame
    // and the terminal width, so it is non-deterministic across widths and
    // sessions (the 2026-08 headline). A needle that is inert in one capture is
    // the one that carries the guard in another.
    //
    // HOOKS-REVIEW SCREEN (`startup_hooks_review.rs`, reworked at 0.148 — B4).
    // Added here on MEASUREMENT, not speculation: with
    // `--dangerously-bypass-hook-trust` removed, codex 0.152.0 paints
    //   Hooks need review / N hooks are new or changed.
    //   › 1. Review hooks
    //     2. Trust all and continue
    //     3. Continue without trusting (hooks won't run)
    //   Press enter to confirm or esc to go back
    // and the shipped five needles matched NONE of it, so `detectIdlePrompt`
    // returned `ready: true` on a screen whose Enter selects "Review hooks".
    // Rows 2 and 3 paint after row 1's cursor, so they satisfy the ordering; the
    // stream collapses them to "Trustallandcontinue" / "Continuewithouttrusting",
    // which is exactly what the automatic `compactText` twin of each plain
    // spelling matches. Two independent needles for one screen, and that
    // redundancy — not an enumeration of collapse variants — is the answer to
    // PARTIAL collapse: spelling out every way a repaint might elide one space
    // is combinatorial, while needing BOTH rows to be mangled in the same frame
    // is not.
    //
    // Sonata's own spawn always passes `--dangerously-bypass-hook-trust`
    // (gated on `profile` in codexArgs), so this screen is unreachable on the
    // happy path. It is reachable on the DEGRADED one: a profile-write failure
    // drops both flags, and a user with their own untrusted hooks then boots
    // straight into it. The title line ("Hooks need review") is deliberately NOT
    // a needle — it paints BEFORE the cursor row and would be inert.
    bootDialogHints: [
      "press enter to continue",
      "yes, continue",
      "yes,continue",
      "no, quit",
      "no,quit",
      "trust all and continue",
      "continue without trusting",
    ],
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}






// detectClaudePermissionMode (the permission-mode banner scrape) retired in
// S4: S3 deleted its last caller (driveClaudePermission); mode DISPLAY now
// follows the hook payload's `permission_mode` (runtime-controller). History:
// git log -S detectClaudePermissionMode.

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function attachmentPromptTitle(count: number): string {
  return count === 1 ? "[Image attachment]" : `[${count} image attachments]`;
}

// "This hook echo is that stored prompt" — the equivalence relation for every
// UserPromptSubmit-hook comparison in beginRunFromHook. Reads through the CLI's
// [Image #N] decoration: the hook payload carries it, the run prompt Sonata stored
// does not. All three call sites (finishedTwin, back-stamp guard, echo-swallow)
// share it, so the image back-stamp fix can never outrun the twin-safety guard —
// normalizing only the back-stamp would let a just-finished twin's late image
// echo cross-wire its prompt_id onto the next run (review 2026-07-05).
function samePromptModuloCliDecoration(stored: string, hookText: string): boolean {
  return normalizePromptForMatch(stored) === normalizePromptForMatch(hookText);
}


export function extractProviderErrorExcerpt(rawText: string, provider?: RuntimeProvider): string | null {
  const matches = cleanTerminal(rawText)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line && !isTerminalChromeLine(line, provider) && PROVIDER_ERROR_LINE_RE.test(line))
    .slice(-3);
  if (matches.length === 0) {
    return null;
  }

  const excerpt = matches.join("\n");
  return excerpt.length <= 500 ? excerpt : `...${excerpt.slice(-497)}`;
}

function withCompletionErrorExcerpt(
  hint: CompletionHint | undefined,
  errorExcerpt: string,
): CompletionHint {
  return {
    ...(hint ?? {}),
    errorExcerpt,
  };
}

function isTerminalChromeLine(line: string, provider?: RuntimeProvider): boolean {
  if (!line) {
    return true;
  }
  const compact = line.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (provider === "claude" && compact.length <= 2) {
    return true;
  }
  return (
    /^esc\b/i.test(line) ||
    /^press\b/i.test(line) ||
    /^paste again\b/i.test(line) ||
    /^thinking\b/i.test(line) ||
    /^tokens?\b/i.test(line) ||
    /^context\b/i.test(line) ||
    /^[>*+~._-]{1,8}$/.test(line)
  );
}

function ptyEnvironment(extraEnv?: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // Nested-session markers inherited when Sonata itself was launched from a
  // Claude Code session. A child `claude` that sees them registers NO
  // ~/.claude/sessions/<pid>.json — the waitingFor side channel goes dark
  // (research 2026-06-12 §4.2). CLAUDE_CONFIG_DIR is intentionally kept:
  // it is user-owned configuration, not a nesting marker.
  delete env.CLAUDECODE;
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE_CODE_")) {
      delete env[key];
    }
  }
  // Finder/Dock-launched apps inherit launchd's minimal PATH, not the user's
  // interactive PATH — so a packaged Sonata can't find node/claude/codex/git.
  // Merge the login-shell PATH (darwin-only, cached once, ~2s timeout fallback,
  // `SONATA_DISABLE_LOGIN_SHELL_PATH=1` opt-out). See login-shell-path.ts.
  const mergedPath = mergePath(loginShellPath(), env.PATH);
  return {
    ...env,
    ...(mergedPath !== undefined ? { PATH: mergedPath } : {}),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    ...(extraEnv ?? {}),
  };
}

/**
 * Cap on the turn-boundary reconcile delta emitted per run end (OBS S6). Mirrors
 * the run-index changedFiles cap (`DEFAULT_REPORT_LIST_CAPS.changedFiles`, kept a
 * local literal to avoid coupling the host to run-index internals); the run-index
 * bounds again at append, so this only bounds the event payload size.
 */
const RECONCILE_CHANGE_CAP = 500;

function snapshotWorkspace(cwd: string): Map<string, SnapshotEntry> {
  const result = new Map<string, SnapshotEntry>();
  walk(cwd, cwd, result);
  return result;
}

function walk(root: string, current: string, result: Map<string, SnapshotEntry>): void {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    const relativePath = path.relative(root, absolutePath);
    if (shouldIgnorePath(relativePath)) {
      continue;
    }

    result.set(relativePath, snapshotFile(absolutePath));
    if (entry.isDirectory()) {
      walk(root, absolutePath, result);
    }
  }
}

function snapshotFile(filePath: string): SnapshotEntry {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return {
        exists: true,
        type: stat.isDirectory() ? "directory" : "other",
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    }

    return {
      exists: true,
      type: "file",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { exists: false, type: "missing" };
    }
    return {
      exists: false,
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Stat-identity change classification (OBS S7 / D4). The watcher is a
 * notification stream, not a truth source: file identity is (type, size,
 * mtimeMs) — no content hash.
 *
 * The swap is MONOTONIC toward fewer `modified` verdicts, so it adds ZERO new
 * `file:changed` noise. The retired OR-chain already carried
 * `before.mtimeMs !== after.mtimeMs`, so any mtime-moving rewrite (an
 * identical-byte `touch` included) was ALREADY `modified` — the dropped sha256
 * term could only ever ADD `modified` verdicts on top of that, never suppress
 * one. Removing it therefore only ever turns a former `modified` into
 * `unchanged`, never the reverse.
 *
 * The sole real semantic delta is that one now-lost case: a change where type,
 * size AND mtimeMs are all identical but content differs — a sub-granularity
 * torn write landing within a single mtime tick — now reads as UNCHANGED where
 * the sha256 term caught it. Vanishingly rare, and self-healing: any later
 * write moves mtime and re-surfaces the file.
 */
function classifyChange(before: SnapshotEntry, after: SnapshotEntry): "added" | "modified" | "deleted" | "unchanged" {
  if (!before.exists && after.exists) {
    return "added";
  }
  if (before.exists && !after.exists) {
    return "deleted";
  }
  if (!before.exists && !after.exists) {
    return "unchanged";
  }
  if (
    before.type !== after.type ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    return "modified";
  }
  return "unchanged";
}

function detectIdleComposer(rawText: string, profile: TerminalProviderProfile): {
  completed: boolean;
  source: "terminal-idle-heuristic";
  confidence: CompletionConfidence;
  signals: {
    promptAfterWorking: boolean;
    promptAfterApproval: boolean;
    hasModelOrCwdHint: boolean;
  };
} {
  const hint = detectIdlePrompt(rawText, profile);
  const recent = cleanTerminal(rawText).slice(-8000);
  const lowered = recent.toLowerCase();
  const lastWorking = maxLastIndexOf(lowered, profile.activityHints);
  const completed =
    profile.provider === "claude"
      ? hint.ready && lastWorking >= 0
      : hint.lastPromptIndex >= 0 &&
        lastWorking >= 0 &&
        hint.lastPromptIndex > lastWorking &&
        hint.ready;

  return {
    completed,
    source: "terminal-idle-heuristic",
    confidence: completed && hint.confidence === "medium" ? "medium" : "low",
    signals: {
      promptAfterWorking: hint.lastPromptIndex >= 0 && hint.lastPromptIndex > lastWorking,
      promptAfterApproval: hint.promptAfterApproval,
      hasModelOrCwdHint: hint.hasModelOrCwdHint,
    },
  };
}

export function detectIdleComposerForProvider(
  rawText: string,
  provider: RuntimeProvider = "codex",
): {
  completed: boolean;
  source: "terminal-idle-heuristic";
  confidence: CompletionConfidence;
  signals: {
    promptAfterWorking: boolean;
    promptAfterApproval: boolean;
    hasModelOrCwdHint: boolean;
  };
} {
  return detectIdleComposer(rawText, terminalProviderProfile(provider));
}

function detectIdlePrompt(rawText: string, profile: TerminalProviderProfile): {
  ready: boolean;
  confidence: CompletionConfidence;
  lastPromptIndex: number;
  promptAfterApproval: boolean;
  hasModelOrCwdHint: boolean;
} {
  const recent = cleanTerminal(rawText).slice(-8000);
  const lowered = recent.toLowerCase();
  // The prompt glyphs are provider vocabulary (like activityHints below): codex
  // renders the composer with `»` instead of `›` at the Max/Ultra tiers, and
  // claude must not inherit that glyph. Case-sensitive on `recent`, as the
  // per-glyph lastIndexOf calls this replaced always were.
  const lastAnyPrompt = maxLastIndexOf(recent, profile.composerPromptGlyphs);
  const lastActivity = maxLastIndexOf(lowered, profile.activityHints);
  const approvalNeedles = [
    ...profile.approvalHints.fileRead,
    ...profile.approvalHints.fileEdit,
    ...profile.approvalHints.command,
    ...profile.approvalHints.workspaceTrust,
    // Footer markers anchor a panel's END: without them the option line's
    // own "❯" glyph counts as a prompt rendered after the approval text and
    // a LIVE panel reads as answered (2.1.176 panels lost "enter to
    // confirm", which used to be the de-facto end anchor).
    ...profile.approvalEndMarkers,
    // Boot dialogs (codex directory trust) paint the composer's `›` as their
    // option cursor; their footers sit after it and must outrank it, or a
    // dialog screen reads as an idle composer and the first delivery's Enter
    // silently answers "Yes, continue" (upstream-sync 2026-07-17).
    ...profile.bootDialogHints,
  ].flatMap((hint) => [hint, compactText(hint)]);
  const lastApproval = maxLastIndexOf(lowered, approvalNeedles);
  const promptTail = lastAnyPrompt >= 0 ? recent.slice(lastAnyPrompt, lastAnyPrompt + 700) : "";
  const hasModelOrCwdHint = profile.idlePromptModelHints.test(promptTail);
  const ready =
    lastAnyPrompt >= 0 &&
    lastAnyPrompt > lastApproval &&
    lastAnyPrompt > lastActivity;

  return {
    ready,
    confidence: ready && hasModelOrCwdHint ? "medium" : "low",
    lastPromptIndex: lastAnyPrompt,
    promptAfterApproval: lastAnyPrompt >= 0 && lastAnyPrompt > lastApproval,
    hasModelOrCwdHint,
  };
}

/** Test seam: full candidate detection (kind, choices, fingerprint) as the
 *  host runs it, without standing up a PTY. */
export function detectApprovalCandidateForProvider(
  rawText: string,
  provider: RuntimeProvider = "codex",
): ApprovalCandidate | null {
  return detectApprovalCandidate(rawText, terminalProviderProfile(provider));
}

export function detectIdlePromptForProvider(
  rawText: string,
  provider: RuntimeProvider = "codex",
): {
  ready: boolean;
  confidence: CompletionConfidence;
  lastPromptIndex: number;
  promptAfterApproval: boolean;
  hasModelOrCwdHint: boolean;
} {
  return detectIdlePrompt(rawText, terminalProviderProfile(provider));
}

function detectApprovalCandidate(rawText: string, profile: TerminalProviderProfile): ApprovalCandidate | null {
  if (profile.provider === "claude") {
    const panel = parseClaudeApprovalPanel(rawText);
    if (panel) {
      const fingerprint = `${panel.kind}:${panel.fingerprintSource}`;
      return {
        kind: panel.kind,
        fingerprint,
        fingerprintHash: sha256(fingerprint).slice(0, 16),
        promptAfterApproval: detectIdlePrompt(rawText, profile).promptAfterApproval,
        choices: claudePanelChoices(panel),
        optionKeys: claudePanelOptionKeys(panel),
        ...(panel.isTrust ? { optionWalk: "claude-workspace-trust" as const } : {}),
        grammar: "v2",
      };
    }
  }

  const recent = cleanTerminal(rawText).toLowerCase();
  const compactRecent = compactText(recent);
  const fileRead = includesApprovalHints(compactRecent, profile.approvalHints.fileRead);
  const fileEdit = includesApprovalHints(compactRecent, profile.approvalHints.fileEdit);
  const command = includesApprovalHints(compactRecent, profile.approvalHints.command);
  const workspaceTrust = includesApprovalHints(compactRecent, profile.approvalHints.workspaceTrust);

  if (!fileRead && !fileEdit && !command && !workspaceTrust) {
    return null;
  }

  const kind: ApprovalKind = fileRead
    ? "file-read"
    : command
      ? "command"
      : fileEdit
        ? "file-edit"
        : "workspace-trust";
  const fingerprint = approvalFingerprint(kind, compactRecent, profile);
  // BACKSTOP (upstream sync 2026-09-01). The structured parser is the trust
  // screen's normal route, but it is the part that upstream drift breaks first —
  // 2.1.252's digit-less rows silently dropped this panel here, where the
  // generic legacy choices answer approve with a CSI-u Enter that EXITS the CLI.
  // So the walk is declared from the KIND too: whatever shape a future trust
  // screen paints, its approve keeps a cursor read in front of the confirming
  // Enter. Claude-only — codex's trust dialog is not scrape-answered at all
  // (the hook broker owns it), and sendApprovalDecision refuses non-claude.
  const trustWalk = profile.provider === "claude" && kind === "workspace-trust";
  return {
    kind,
    fingerprint,
    fingerprintHash: fingerprint ? sha256(fingerprint).slice(0, 16) : null,
    promptAfterApproval: detectIdlePrompt(rawText, profile).promptAfterApproval,
    choices: trustWalk ? claudeTrustChoices() : approvalChoices(rawText, profile),
    ...(trustWalk ? { optionWalk: "claude-workspace-trust" as const } : {}),
    grammar: "legacy",
  };
}

// ---------------------------------------------------------------------------
// claude ≥2.1.17x structured panel parsing (probe findings 2026-06-13).
//
// The stream is a cursor-diff paint: repaints of the same panel can glue
// words together and even drop characters, so (1) matching happens in
// compact space (lowercase, alphanumerics only — also strips ❯, dots and
// the curly apostrophe in "don’t"), (2) labels shown to the user are
// class-canonical rather than reconstructed from the lossy stream, and
// (3) when the LAST paint is too garbled to parse, earlier paints of the
// same panel are tried (walk-back). Classification and fingerprinting are
// confined to the panel's own header→footer slice — history outside the
// panel can no longer vote (the old anywhere-substring scan misclassified
// edit panels as file-read whenever a ⏺ Read(…) line sat in the backlog).
// ---------------------------------------------------------------------------

type ClaudePanelOptionSemantic = "approve-once" | "persist-rule" | "session-allow" | "deny-option";

interface ParsedClaudePanelOption {
  digit: "1" | "2" | "3";
  compact: string;
  semantic: ClaudePanelOptionSemantic;
}

interface ParsedClaudePanel {
  kind: ApprovalKind;
  isTrust: boolean;
  isBypass: boolean;
  options: ParsedClaudePanelOption[];
  fingerprintSource: string;
}

const CLAUDE_PANEL_SCAN_LINES = 400;

export function parseClaudeApprovalPanel(rawText: string): ParsedClaudePanel | null {
  const lines = cleanTerminal(rawText).split("\n").slice(-CLAUDE_PANEL_SCAN_LINES);
  const compactLines = lines.map((line) => compactText(line));

  // Question anchors, newest first; walk back past garbled repaints. The
  // bypass interstitial has no "Do you want…?" line — its stable anchor is
  // the "By proceeding, you accept …" sentence.
  const anchors: number[] = [];
  for (let i = compactLines.length - 1; i >= 0 && anchors.length < 6; i--) {
    const c = compactLines[i] ?? "";
    if (
      c.includes("doyouwantto") ||
      c.includes("quicksafetycheck") ||
      c.includes("isthisaprojectyoucreated") ||
      c.includes("byproceedingyouaccept")
    ) {
      anchors.push(i);
    }
  }
  for (const anchor of anchors) {
    const parsed = parseClaudePanelAtAnchor(lines, compactLines, anchor);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

function parseClaudePanelAtAnchor(
  lines: string[],
  compactLines: string[],
  anchor: number,
): ParsedClaudePanel | null {
  const anchorCompact = compactLines[anchor] ?? "";
  const isTrust =
    anchorCompact.includes("quicksafetycheck") || anchorCompact.includes("isthisaprojectyoucreated");
  const isBypass =
    anchorCompact.includes("byproceedingyouaccept") || anchorCompact.includes("bypasspermissionsmode");

  const options: ParsedClaudePanelOption[] = [];
  let footerIndex = -1;
  let expected = 1;
  for (let i = anchor + 1; i < Math.min(lines.length, anchor + 60); i++) {
    const compact = compactLines[i] ?? "";
    if (!compact) {
      continue;
    }
    if (compact.includes("esctocancel") || compact.includes("entertoconfirm")) {
      footerIndex = i;
      break;
    }
    if (expected <= 3 && compact.startsWith(String(expected))) {
      options.push({
        digit: String(expected) as ParsedClaudePanelOption["digit"],
        compact: compact.slice(1),
        semantic: "approve-once", // classified below once collection ends
      });
      expected += 1;
      continue;
    }
    const lastOption = options[options.length - 1];
    if (lastOption) {
      // Wrapped continuation of the previous option's text.
      lastOption.compact += compact;
    }
  }
  // The 2.1.252 workspace-trust dialog dropped the `1.`/`2.` digits from its
  // rows (MEASURED — spikes/upstream-sync-2026-09/claude/q3-trust-variants.
  // capture.txt; a digit is now inert on it), so the digit collector above finds
  // NOTHING and the panel used to fall through to the legacy hint path — which
  // answers approve with a CSI-u Enter that exits the CLI. The rows are still
  // there, named by their labels, so trust is admitted on the AFFIRM ROW's
  // presence instead of on a digit count. Evidence-based, not permissive: a
  // trust anchor with a footer but no `Yes, I trust this folder` row is still
  // refused. `options` stays empty for this shape and no consumer reads it —
  // the trust branches of claudePanelChoices / claudePanelOptionKeys are
  // option-blind, and the answer path re-reads the live grid rather than trust
  // parse-time row positions (they go stale while the card waits for the user).
  const trustAffirmRow =
    isTrust &&
    footerIndex > anchor &&
    compactLines.slice(anchor + 1, footerIndex).some((line) => line.includes("yesitrustthisfolder"));
  if (footerIndex < 0 || (options.length < 2 && !trustAffirmRow)) {
    return null;
  }
  for (const option of options) {
    option.semantic = classifyClaudePanelOption(option);
  }

  // Kind from the panel's own header line (exact compact equality — prose
  // mentioning "read file" must not vote), searched a short window above
  // the question; the command echo / diff preview sits in between.
  let kind: ApprovalKind = "unknown";
  let headerIndex = -1;
  if (isBypass) {
    kind = "dangerous-bypass";
  } else if (isTrust) {
    kind = "workspace-trust";
  } else {
    for (let i = anchor - 1; i >= Math.max(0, anchor - 25); i--) {
      const match = CLAUDE_PANEL_HEADER_KINDS.find((entry) => compactLines[i] === entry.header);
      if (match) {
        kind = match.kind;
        headerIndex = i;
        break;
      }
    }
    if (kind === "unknown") {
      // Header lost to a diff repaint (or a pre-header CLI): fall back to
      // the question's wording, then to the option texts — those carry the
      // permission class across grammar versions.
      const optionText = options.map((option) => option.compact).join("");
      if (anchorCompact.includes("edit") || anchorCompact.includes("create")) {
        kind = "file-edit";
      } else if (anchorCompact.includes("read") || optionText.includes("allowreadingfrom")) {
        kind = "file-read";
      } else if (optionText.includes("alledits")) {
        kind = "file-edit";
      } else if (optionText.includes("dontaskagain") || optionText.includes("allowaccessto")) {
        kind = "command";
      }
    }
  }

  const sliceStart = headerIndex >= 0 ? headerIndex : Math.max(0, anchor - 12);
  const fingerprintSource = compactLines.slice(sliceStart, footerIndex + 1).join("");
  return { kind, isTrust, isBypass, options, fingerprintSource };
}

function classifyClaudePanelOption(option: {
  digit: string;
  compact: string;
}): ClaudePanelOptionSemantic {
  if (option.digit === "1") {
    return "approve-once";
  }
  if (option.digit === "3" || option.compact.startsWith("no")) {
    return "deny-option";
  }
  if (option.compact.includes("dontaskagain")) {
    return "persist-rule";
  }
  // "during this session", "always allow access to <dir>/ from this
  // project" (probe-verified session-scoped: dies on resume), and any
  // unrecognized yes-variant: session semantics. The persist receipt
  // watcher still arms on every option-2 answer, so a future persistent
  // wording is receipted even if classified conservatively here.
  return "session-allow";
}

function claudePanelChoices(panel: ParsedClaudePanel): ApprovalChoice[] {
  if (panel.isBypass) {
    // Mirror native's safe ordering: "No, exit" is the default; accepting
    // bypass is the deliberate opt-in. Deny is listed FIRST so the card's
    // primary/default action stays safe.
    return [
      {
        decision: "deny",
        label: "Cancel (stay safe)",
        description:
          "Decline Bypass Permissions mode (the native default, “No, exit”). Claude will keep asking before dangerous actions.",
        encodedAs: "Esc",
      },
      {
        decision: "approve",
        label: "Enable bypass — accept the risk",
        description:
          "Choose the native “Yes, I accept”. Claude will run EVERY command without asking — intended only for a sandboxed container/VM. You accept all responsibility.",
        encodedAs: "digit 2",
      },
    ];
  }

  if (panel.isTrust) {
    return claudeTrustChoices();
  }

  const choices: ApprovalChoice[] = [
    {
      decision: "approve",
      label: "Approve once",
      description: "Choose the native option 1 (Yes) for this approval only.",
      encodedAs: "digit 1",
    },
    {
      decision: "deny",
      label: "Deny",
      description: "Dismiss the native approval screen.",
      encodedAs: "Esc",
    },
  ];

  const optionTwo = panel.options.find((option) => option.digit === "2");
  if (optionTwo?.semantic === "persist-rule") {
    choices.splice(1, 0, {
      decision: "approve-always",
      label: "Don't ask again",
      description:
        `Choose Claude's native persistent option (“${optionTwo.compact}”). ` +
        "Claude writes the allow rule to .claude/settings.local.json in this project; " +
        "Sonata shows a receipt of what was written.",
      encodedAs: "digit 2",
    });
  } else if (optionTwo?.semantic === "session-allow") {
    choices.splice(1, 0, {
      decision: "approve-for-session",
      label: "Allow for this session",
      description:
        `Choose Claude's native session option (“${optionTwo.compact}”). ` +
        "Resets when the session ends or is resumed.",
      encodedAs: "digit 2",
    });
  }

  return choices;
}

/** The trust screen's two actions. Shared by the v2 and legacy detection paths
 *  so a parser drift can never silently downgrade this card to the generic
 *  "Approve once / CSI-u Enter" shape — the shape whose key exits the CLI. */
function claudeTrustChoices(): ApprovalChoice[] {
  return [
    {
      decision: "approve",
      label: "Trust this folder",
      description:
        "Choose the native “Yes, I trust this folder” option (Sonata arrows onto that row and confirms " +
        "only once the screen shows it highlighted — it is not the default here).",
      encodedAs: "grid-verified Arrow + CR",
    },
    {
      decision: "deny",
      label: "Deny",
      description: "Dismiss the native trust screen.",
      encodedAs: "Esc",
    },
  ];
}

function claudePanelOptionKeys(panel: ParsedClaudePanel): Partial<Record<ApprovalDecision, string>> {
  if (panel.isBypass) {
    // "Yes, I accept" is option 2; deny falls through to Esc (sendDeny).
    return { approve: "2" };
  }
  if (panel.isTrust) {
    // NO key: the trust screen's approve is a grid-verified cursor walk
    // (optionWalk), because its affirm row is neither the default nor
    // digit-addressable at 2.1.252 and every blind key exits the CLI. Returning
    // {} rather than a key is load-bearing — sendApprovalDecision's legacy
    // fallback would otherwise write the CSI-u Enter that kills the session.
    return {};
  }
  const keys: Partial<Record<ApprovalDecision, string>> = { approve: "1" };
  const optionTwo = panel.options.find((option) => option.digit === "2");
  if (optionTwo?.semantic === "persist-rule") {
    keys["approve-always"] = "2";
  } else if (optionTwo?.semantic === "session-allow") {
    keys["approve-for-session"] = "2";
  }
  return keys;
}

function approvalFingerprint(
  kind: ApprovalKind,
  compactRecent: string,
  profile: TerminalProviderProfile,
): string | null {
  const hints =
    kind === "file-read"
      ? profile.approvalHints.fileRead
      : kind === "command"
      ? profile.approvalHints.command
      : kind === "workspace-trust"
        ? profile.approvalHints.workspaceTrust
        : profile.approvalHints.fileEdit;
  const startNeedles = hints.slice(0, -1).map(compactText);
  const endNeedle = compactText(hints[hints.length - 1] ?? "enter to confirm");
  const startIndex = maxLastIndexOf(compactRecent, startNeedles);
  if (startIndex < 0) {
    return null;
  }
  const endIndex = compactRecent.indexOf(endNeedle, startIndex);
  const stableEnd = endIndex >= 0 ? endIndex + endNeedle.length : startIndex + 1600;
  return `${kind}:${compactRecent.slice(startIndex, stableEnd)}`;
}

function approvalChoices(rawText: string, profile: TerminalProviderProfile): ApprovalChoice[] {
  const choices: ApprovalChoice[] = [
    {
      decision: "approve",
      label: "Approve once",
      description: "Choose the native yes option for this approval only.",
      encodedAs: "CSI-u Enter",
    },
    {
      decision: "deny",
      label: "Deny",
      description: "Dismiss the native approval screen.",
      encodedAs: "Esc",
    },
  ];

  if (hasClaudeSessionApprovalOption(rawText, profile)) {
    choices.splice(1, 0, {
      decision: "approve-for-session",
      label: "Allow Session",
      description: "Choose Claude's native session-scoped yes option.",
      encodedAs: "ArrowDown + CSI-u Enter",
    });
  }

  return choices;
}

function hasClaudeSessionApprovalOption(rawText: string, profile: TerminalProviderProfile): boolean {
  if (profile.provider !== "claude") {
    return false;
  }
  const compactRecent = compactText(cleanTerminal(rawText).slice(-8000));
  return (
    compactRecent.includes("2yes") &&
    compactRecent.includes("allow") &&
    compactRecent.includes("duringthissession")
  );
}

function maxLastIndexOf(value: string, needles: string[]): number {
  if (needles.length === 0) {
    return -1;
  }
  return Math.max(...needles.map((needle) => value.lastIndexOf(needle)));
}

function describeApprovalKeySequence(keySequence: string): ApprovalDecisionEncoding {
  if (keySequence === "\r") {
    return "CR";
  }
  if (keySequence === "1" || keySequence === "2" || keySequence === "3") {
    return `digit ${keySequence}` as ApprovalDecisionEncoding;
  }
  if (keySequence === CSI_U_ENTER) {
    return "CSI-u Enter";
  }
  return "ArrowDown + CSI-u Enter";
}

function readClaudeAllowRules(settingsPath: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      permissions?: { allow?: unknown };
    };
    const allow = parsed.permissions?.allow;
    return Array.isArray(allow) ? allow.filter((rule): rule is string => typeof rule === "string") : [];
  } catch {
    return [];
  }
}

function completionSourceForStatus(status: RunStatus): CompletionSource {
  if (status === "completed") {
    return "unknown";
  }
  if (status === "stopped" || status === "approval-denied") {
    return "native-control";
  }
  if (status === "pty-exited") {
    return "pty-exit";
  }
  return "unknown";
}

function completionConfidenceForStatus(status: RunStatus): CompletionConfidence {
  if (status === "stopped" || status === "approval-denied" || status === "pty-exited") {
    return "high";
  }
  return "low";
}

function compactText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function includesApprovalHints(compactRecent: string, hints: string[]): boolean {
  if (hints.length === 0) {
    return false;
  }
  const compactHints = hints.map(compactText);
  const endNeedle = compactHints[compactHints.length - 1] ?? "";
  const triggers = compactHints.slice(0, -1);
  return compactRecent.includes(endNeedle) && triggers.some((hint) => compactRecent.includes(hint));
}

function redactPath(value: string): string {
  return value.replace(os.homedir(), "~");
}

function removeUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
