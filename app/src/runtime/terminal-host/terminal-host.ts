import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import * as pty from "node-pty";
import { normalizePromptForMatch } from "../../shared/prompt-markers";
import type {
  ApprovalChoice,
  ApprovalDecision,
  ApprovalDecisionEncoding,
  ApprovalKind,
  ClaudePermissionMode,
  CodexApprovalMode,
  CodexPermissionMode,
  CodexSandboxMode,
  CompletionConfidence,
  CompletionHint,
  CompletionSource,
  LaunchSpeedMode,
  ReasoningEffort,
  RuntimeProvider,
  RunId,
  RunKind,
  RunStatus,
  TaskId,
} from "../../shared/types/domain";
import type { RuntimeEvent, RunUpdatedEvent } from "../../shared/types/events";
import type { RemoteControlInjectResponse, TerminalReplaySnapshot } from "../../shared/types/ipc";
import { ensureClaudeRuntimeSettings } from "../cli-signal";
import { CODEX_DUET_PROFILE, ensureCodexRuntimeSettings } from "../providers/codex";
import { shellQuotePath } from "../shell-quote";
import { TerminalScrollback } from "./terminal-scrollback";

export const BRACKETED_PASTE_START = "\x1b[200~";
export const BRACKETED_PASTE_END = "\x1b[201~";
export const CSI_U_ENTER = "\x1b[13u";

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
export const ARROW_DOWN = "\x1b[B";
export const ESC = "\x1b";
/** Ctrl+U — kill-line in both CLIs' composers. Idempotent on an empty line
 *  (probe C2/C6/X2, claude 2.1.212 + codex 0.144.5); per-LINE on Claude, so
 *  multi-line clears send a counted flood (see cliInputClearFlood). */
export const KILL_LINE = "\x15";

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

const DEFAULT_ROWS = 36;
const DEFAULT_COLS = 120;
const DEFAULT_SCROLLBACK_LIMIT = 64 * 1024;
const DEFAULT_COMPLETION_QUIET_MS = 1800;
const DEFAULT_POST_COMPLETION_ATTRIBUTION_MS = 5000;
const DEFAULT_APPROVAL_SETTLE_MS = 1200;
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
 *  Esc into next week's turn. */
const STOP_ESC_RETRY_MIN_MS = 800;
const STOP_ESC_RETRY_WINDOW_MS = 45_000;
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
/** How long after the human's last terminal keystroke Duet treats them as
 *  actively typing and holds delivery (S2). Bridges the gaps between keystrokes
 *  — and the pause-to-think over a half-typed line — that the idle-prompt
 *  heuristic alone cannot see. Dogfood-tuned. */
const HUMAN_ACTIVE_WINDOW_MS = 3500;
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
  postCompletionAttributionMs?: number;
}

export interface StartTaskOptions {
  cwd?: string;
  /**
   * The session's Duet-owned runtime home for Claude's hooks/usage/settings (D8).
   * The app passes ~/.duet/data/runtime/<taskId> so nothing Duet-owned lands in
   * the agent's working directory. Defaults to `<cwd>/.duet` when unset (the
   * legacy in-cwd location) so a bare TerminalHost in a test still works.
   */
  runtimeDir?: string;
  command?: string;
  args?: string[];
  /** Codex only: the launch permission preset. Fanned out to the legacy
   *  (sandbox × approval × reviewer) flags at the codexArgs seam. */
  codexPermissionMode?: CodexPermissionMode;
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
  /** Codex only: the Duet-home shim dir for the injected hook profile. Present →
   *  buildArgs writes the profile+shims (write-if-changed) and spawns with
   *  `-p duet`. The controller supplies binDir because it owns Duet-home; the
   *  codex edge owns the `$CODEX_HOME` profile-file location. */
  codexHookPaths?: { binDir: string };
  resumeLast?: boolean;
  /** Provider session id to resume natively (claude --resume / codex resume). */
  resumeRef?: string;
  /**
   * Fresh-spawn only: pin the new session to an id Duet chose up front
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
}

export interface PromptSubmission {
  taskId: TaskId;
  runId: RunId | null;
  kind: RunKind;
  submittedAt: string;
}

export interface PromptAttachmentSubmission {
  path: string;
}

interface SnapshotEntry {
  exists: boolean;
  type: "file" | "directory" | "other" | "missing" | "error";
  size?: number;
  mtimeMs?: number;
  sha256?: string | null;
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

interface ApprovalCandidate {
  kind: ApprovalKind;
  fingerprint: string | null;
  fingerprintHash: string | null;
  promptAfterApproval: boolean;
  choices: ApprovalChoice[];
  /** v2-parsed panels carry their own decision→key map (digits / CR). */
  optionKeys?: Partial<Record<ApprovalDecision, string>>;
  grammar?: "v2" | "legacy";
}

type ActiveRun = RunUpdatedEvent["payload"];
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
}

export class TerminalHost extends EventEmitter {
  private readonly taskId: TaskId;
  private readonly generation: number;
  private readonly profile: TerminalProviderProfile;
  private readonly defaultWorkspace: string;
  private readonly eventSink: ((event: RuntimeEvent) => void) | null;
  private readonly scrollbackLimit: number;
  private readonly completionQuietMs: number;
  private readonly postCompletionAttributionMs: number;
  private ptyProcess: pty.IPty | null = null;
  private scrollback: TerminalScrollback | null = null;
  private rawTail = "";
  private cwd: string | null = null;
  private fileWatcher: fs.FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private fileSnapshot = new Map<string, SnapshotEntry>();
  private pendingFileTimers = new Map<string, NodeJS.Timeout>();
  private approvalActive = false;
  private lastApprovalKind: ApprovalKind | null = null;
  private lastApprovalFingerprint: string | null = null;
  private lastApprovalDecision: ApprovalDecision | null = null;
  private lastApprovalDecisionAt: number | null = null;
  /** Epoch ms of the most recent hook-broker approval TIMEOUT (Duet answered
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
  /** Cumulative pty bytes since spawn — a stream coordinate that survives the
   *  rawTail/activeRunRaw suffix trims, so a point in the stream stays
   *  addressable after buffers are sliced. */
  private ptyBytesTotal = 0;
  /** Approval-scrape watermark (stream coordinate): panel bytes at or before
   *  this point are ANSWERED history and can no longer become candidates.
   *  Advanced ONLY on hook-broker decisions — the reply went down the CLI's
   *  own stdout channel and cannot be swallowed, so the painted panel is
   *  settled fact the moment the reply is written. (claude ≥2.1.186 paints
   *  the FULL native panel while the broker holds; those bytes stay in the
   *  linear run buffer forever and re-detected as a phantom "resurfaced"
   *  ask >1.2s after the decision, wedging the run — 2026-07-03 diagnosis.)
   *  Native-key decisions do NOT move it: keys can be swallowed, and the
   *  resurface-after-settle honesty backstop exists exactly for them. */
  private approvalScanFloor = 0;
  /** The CLI's own "session is up" declaration (SessionStart hook). Opens
   *  acceptsPromptInput structurally: claude ≥2.1.186 repaints transcript
   *  history on --resume (old ❯ prompt lines, "✻ Baked for Ns" summaries),
   *  which reads as activity-after-prompt in the linear idle scrape and
   *  starved the boot latch forever (2026-07-03 diagnosis). Hook-less
   *  spawns (codex, broker-off) keep the scrape path. */
  private hookSessionStarted = false;
  private persistReceiptTimers: NodeJS.Timeout[] = [];
  private nativeAnswerRecheckTimers: NodeJS.Timeout[] = [];
  private startedAt: number | null = null;
  private activeRun: ActiveRun | null = null;
  private runSeq = 0;
  private completionTimer: NodeJS.Timeout | null = null;
  private approvalSettleTimer: NodeJS.Timeout | null = null;
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
  private activeRunRaw = "";
  // Remote Control (phone access) — tracked optimistically; no hook/structured
  // signal exists for it, and the footer "/rc active" is a volatile TUI scrape
  // we refuse. `injectRemoteControl` flips us active; the scraped session URL
  // confirms and carries the phone link.
  private remoteControlActive = false;
  private remoteControlUrl: string | null = null;
  // Rolling RAW tail (capped). While active we compact it (escapes + whitespace
  // removed) to detect the OFF line and to capture the URL — robust to claude's
  // word-positioned redraw (glued words) AND to a split landing inside a word OR
  // inside an escape sequence. Reset on every transition so a stale match can't
  // fire after a reconnect.
  private remoteControlScan = "";
  /**
   * Single-writer arbitration between Duet's automation and the human typing in
   * the terminal (S2 — the AtomicWriter). `duetWriteDepth` > 0 means an
   * automation write SEQUENCE is in flight — a prompt paste (sync attachment
   * writes + the deferred text/Enter timers) or an option-prompt key run. Human
   * keystrokes that arrive during that window are held in `pendingHumanInput` and
   * flushed the instant the sequence completes, so the two byte streams never
   * interleave (no `git che`+paste corruption; no split bracketed-paste frame).
   * `lastHumanInputAt` timestamps the human's last terminal keystroke — used
   * ONLY to reconcile natively-answered approvals, never to hold delivery.
   */
  private duetWriteDepth = 0;
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
  // The CLI's input line may hold text Duet did not put there on purpose —
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
    this.postCompletionAttributionMs =
      options.postCompletionAttributionMs ?? DEFAULT_POST_COMPLETION_ATTRIBUTION_MS;
  }

  get workspace(): string | null {
    return this.cwd;
  }

  hasActiveRun(): boolean {
    return Boolean(this.activeRun);
  }

  /** The Duet-owned run currently open, for attribution of controller-side
   *  events (hook-broker approvals carry no runId of their own). */
  activeRunId(): RunId | null {
    return this.activeRun ? this.activeRun.id : null;
  }

  isApprovalActive(): boolean {
    return this.approvalActive;
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
    // Hook-first: SessionStart is the CLI declaring its composer is up — no
    // scrape can outrank that. Required for resumed sessions on claude
    // ≥2.1.186, whose history repaint (old ❯ lines + "✻ Baked for Ns"
    // summaries) permanently defeats the linear prompt-after-activity scrape
    // below. The busy/panel cases stay covered by the guards above.
    if (this.hookSessionStarted) {
      return true;
    }
    return detectIdlePrompt(this.rawTail, this.profile).ready;
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
    this.ptyBytesTotal = 0;
    this.approvalScanFloor = 0;
    this.hookSessionStarted = false;
    this.clearPersistReceiptTimers();
    this.clearNativeAnswerRecheckTimers();
    this.activeRun = null;
    this.recentAttributionRun = null;
    this.activeRunRaw = "";
    this.taskReady = false;
    this.clearCompletionTimer();
    this.clearApprovalSettleTimer();
    this.remoteControlActive = false;
    this.remoteControlUrl = null;
    this.remoteControlScan = "";
    this.startFileWatcher(cwd);

    const command = options.command ?? this.profile.defaultCommand;
    const args = Array.isArray(options.args)
      ? options.args
      : this.profile.buildArgs({
          ...options,
          cwd,
        });
    const cols = Number(options.cols) || DEFAULT_COLS;
    const rows = Number(options.rows) || DEFAULT_ROWS;

    this.ptyProcess = pty.spawn(command, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: ptyEnvironment(options.extraEnv),
    });
    // Main-process mirror of the rendered buffer, sized to the PTY, so a
    // (re)opened terminal window can restore recent scrollback (snapshot+tail).
    this.scrollback = new TerminalScrollback(cols, rows);

    this.ptyProcess.onData((data) => this.handlePtyData(data));
    this.ptyProcess.onExit((exit) => {
      // RC never outlives the process — clear it so the header button
      // doesn't keep showing "on" for a dead/crashed session.
      if (this.remoteControlActive) {
        this.setRemoteControlActive(false, null);
      }
      this.emitEvent("pty:exit", {
        taskId: this.taskId,
        generation: this.generation,
        runId: this.activeRun ? this.activeRun.id : null,
        exitCode: exit.exitCode,
        signal: exit.signal ?? null,
        elapsedMs: this.startedAt ? Date.now() - this.startedAt : null,
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
      rows,
      cols,
      persistence: "raw-terminal-memory-only",
    });

    // Spawned with `--remote-control`: arm our state immediately (symmetric with
    // injectRemoteControl). Activation is OUR signal, never the scraped URL — so
    // disconnect detection is armed from the start even if the URL line never
    // scrapes cleanly, and the URL scrape becomes pure link-capture (below).
    if (options.remoteControl) {
      this.setRemoteControlActive(true);
    }

    return {
      pid: this.ptyProcess.pid,
      cwd,
      command,
      args,
    };
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
   * this works mid-stream (verified 2026-06-27, claude 2.1.195): when OFF it
   * connects; when already ON it opens claude's native Remote Control panel
   * (Disconnect / Show QR / Continue). Held under the write-lock so a human
   * keystroke mid-inject buffers instead of splitting the paste. An open
   * approval panel would swallow the command, so we refuse in that state
   * and report it rather than flip to a false "on".
   */
  injectRemoteControl(): RemoteControlInjectResponse {
    if (!this.ptyProcess) {
      return { ok: false, reason: "no-process" };
    }
    if (this.approvalActive) {
      return { ok: false, reason: "panel-open" };
    }
    // The write-lock (beginDuetWrite) only BUFFERS human keystrokes; it does NOT
    // serialise two automation writers. If a prompt delivery is mid-sequence (its
    // deferred paste/Enter still pending), injecting now would interleave `/rc`
    // bytes with the prompt's — refuse and let the caller retry once it clears.
    if (this.duetWriting) {
      return { ok: false, reason: "busy" };
    }
    this.beginDuetWrite();
    this.ptyProcess.write(`${BRACKETED_PASTE_START}/remote-control${BRACKETED_PASTE_END}`);
    // Defer the Enter under the held lock (mirrors the prompt-delivery path): a
    // human keystroke landing in the gap buffers rather than splitting the frame.
    this.deferDuetWrite(
      120,
      () => {
        if (this.ptyProcess) {
          this.ptyProcess.write(CSI_U_ENTER);
        }
      },
      "control",
    );
    this.endDuetWrite();
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
   * Remote Control has NO hook/structured channel (confirmed), so we read its
   * stream — but ONLY while we already believe RC is on. Activation is always OUR
   * own signal (`injectRemoteControl` or the `--remote-control` spawn flag), never
   * a scraped URL: a `claude.ai/code/session_…` link can appear in model output, a
   * file, or a RESUMED transcript, and must not flip RC on with a foreign link.
   * Once active, the rolling RAW tail is compacted (escapes + ALL whitespace
   * removed) so two things are robust against claude's word-POSITIONED redraw
   * (`This\x1b[9Gsession\x1b[17Gis…` — words glue after stripping) AND against a
   * PTY split landing inside a word or inside an escape sequence (we accumulate
   * RAW and strip the whole tail, so a split escape reassembles first):
   *   OFF → claude's `Remote Control disconnected.` line (whitespace-insensitive;
   *         case kept so model prose "…remote control disconnected…" can't trip it).
   *   URL → the session link, captured once for display.
   * (verified 2026-06-27/28, claude 2.1.195 — re-validate on claude upgrades).
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
      const url = findRemoteControlUrl(this.remoteControlScan);
      if (url) {
        this.setRemoteControlActive(true, url);
      }
    }
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
    // its input box just like a Duet stop (probe C1/X1). Mark the line dirty
    // so the next Duet injection pre-clears instead of concatenating. Flag
    // only — NO belt timer: the human is driving the terminal and may want
    // to edit the restored text right there.
    if (data === ESC && this.activeRun) {
      this.cliInputMaybeDirty = true;
    }
    if (this.duetWriting) {
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
  private beginDuetWrite(): void {
    this.duetWriteDepth++;
  }

  /** Ends one automation write sequence; when the last one finishes, flush any
   *  human keystrokes that arrived mid-sequence so they land contiguously. */
  private endDuetWrite(): void {
    if (this.duetWriteDepth > 0) {
      this.duetWriteDepth--;
    }
    if (this.duetWriteDepth === 0 && this.pendingHumanInput && this.ptyProcess) {
      const buffered = this.pendingHumanInput;
      this.pendingHumanInput = "";
      this.ptyProcess.write(buffered);
    }
  }

  /** Schedule an automation write `ms` from now, holding the write-lock across
   *  the timer gap so a human keystroke in that window buffers rather than
   *  splitting the sequence. Cancellable as a group by stopRun (a canceled
   *  handle releases its write-lock hold without writing). */
  private deferDuetWrite(ms: number, fn: () => void, owner: "prompt" | "control" = "prompt"): void {
    this.beginDuetWrite();
    const handle = { owner, cancel: () => {} };
    const timer = setTimeout(() => {
      this.pendingDeferredWrites.delete(handle);
      try {
        fn();
      } finally {
        this.endDuetWrite();
      }
    }, ms);
    handle.cancel = () => {
      clearTimeout(timer);
      this.pendingDeferredWrites.delete(handle);
      this.endDuetWrite();
    };
    this.pendingDeferredWrites.add(handle);
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

  private get duetWriting(): boolean {
    return this.duetWriteDepth > 0;
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
    const candidate = detectApprovalCandidate(this.approvalScanSource(), this.profile);
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
    this.clearApprovalSettleTimer();
    // A run-starting send supersedes any armed stop-Esc retry: an Esc fired
    // now would kill the very turn this submission is starting. A control
    // send (createRun:false — the codex /stop follow-up) is PART of the stop
    // and must not shorten the retry window (review F5).
    const submissionOwner: "prompt" | "control" =
      options.createRun === false ? "control" : "prompt";
    if (submissionOwner === "prompt") {
      this.stopEscRetry = null;
    }
    // Hold the write-lock across the whole sync+deferred sequence so a human
    // keystroke landing mid-paste buffers (and flushes after) rather than
    // splitting the bracketed-paste frame (S2). The initial begin covers the
    // synchronous attachment writes; each deferred write keeps the depth > 0
    // until it fires, so endDuetWrite() below does not release early.
    this.beginDuetWrite();
    // Suspenders for the post-stop belt: if the CLI's input line may still
    // hold an Esc-restored prompt (fast resend beat the belt timer, or the
    // belt was skipped behind an approval), kill it before ANY of this
    // submission's bytes land — otherwise the paste concatenates onto it
    // (probe C1/C8). No-op on a clean line.
    this.writeCliInputClearFlood("pre-submit");
    for (const attachment of attachments) {
      this.ptyProcess.write(`${BRACKETED_PASTE_START}${shellQuotePath(attachment.path)}${BRACKETED_PASTE_END}`);
    }
    const textDelayMs = attachments.length > 0 ? 120 : 0;
    const enterDelayMs = attachments.length > 0 ? 260 : 120;
    // Ratchet the flood high-water: prompt lines + one line per pasted
    // attachment path (each is its own composer line).
    this.cliDirtyLineHighWater = Math.max(
      this.cliDirtyLineHighWater,
      trimmed.split("\n").length + attachments.length,
    );
    this.deferDuetWrite(
      textDelayMs,
      () => {
        if (this.ptyProcess && trimmed) {
          this.ptyProcess.write(`${BRACKETED_PASTE_START}${trimmed}${BRACKETED_PASTE_END}`);
        }
      },
      submissionOwner,
    );
    this.deferDuetWrite(
      enterDelayMs,
      () => {
        if (this.ptyProcess) {
          this.ptyProcess.write(CSI_U_ENTER);
        }
      },
      submissionOwner,
    );
    // A bare Codex skill mention ("$name") opens the skill-mention popup,
    // whose "Press enter to insert" consumes the first Enter. The second
    // Enter submits the inserted mention. Both steps verified by probe
    // s3b.codexSkillDoubleEnter; with trailing text the popup closes on its
    // own and the extra Enter never fires.
    if (this.profile.provider === "codex" && /^\$[A-Za-z0-9][\w.-]*$/.test(trimmed)) {
      this.deferDuetWrite(
        enterDelayMs + 320,
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
    this.endDuetWrite();
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
   * in-flight automation sequence (duetWriting) → never interleave our own bytes
   * mid-paste. Returns whether it wrote.
   */
  nudgePromptSubmit(): boolean {
    if (!this.ptyProcess || this.approvalActive || this.duetWriting) {
      return false;
    }
    this.beginDuetWrite();
    this.ptyProcess.write(CSI_U_ENTER);
    this.endDuetWrite();
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
    this.beginRun(text || "(prompt)", kind, {
      ...(text.startsWith("<task-notification>") ? { title: "(background task returned)" } : {}),
      promptId: options.promptId ?? null,
    });
  }


  private cleanTail(chars: number): string {
    return cleanTerminal(this.rawTail).slice(-chars);
  }

  sendApprove(): void {
    this.sendApprovalDecision("approve");
  }

  sendApproveForSession(): void {
    this.sendApprovalDecision("approve-for-session");
  }

  sendApproveAlways(): void {
    this.sendApprovalDecision("approve-always");
  }

  /**
   * Answer the surfaced panel with the key its OWN parsed option list maps
   * to (v2 grammar: digits instant-select; trust: plain CR). Legacy-grammar
   * panels keep their historically verified encodings. `approve-always`
   * exists only where the panel offered a native persistent option — there
   * is no Duet-invented persistence to fall back to.
   */
  sendApprovalDecision(
    decision: Extract<ApprovalDecision, "approve" | "approve-for-session" | "approve-always">,
  ): void {
    // CSI-u Enter / ArrowDown are Claude's native-panel grammar — WRONG for
    // codex's card (S4). Codex answers exclusively via the broker reply channel;
    // no code path should ever replay panel keys to a codex PTY. Fail loudly
    // rather than corrupt the codex TUI with foreign keystrokes.
    if (this.profile.provider !== "claude") {
      throw new Error(
        `Native approval-key replay is Claude-only; ${this.profile.provider} answers via the hook broker.`,
      );
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
    // Everything painted so far — including the full native panel claude
    // ≥2.1.186 renders while the broker holds — is answered history now: the
    // reply went down the hook's stdout and cannot be swallowed. Below the
    // watermark it can never re-detect as a phantom "resurfaced" ask (which
    // used to flip the run back to waiting-for-approval >1.2s after the
    // decision and drop the Stop hook — the 2026-07-03 wedge).
    this.approvalScanFloor = this.ptyBytesTotal;
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
   * A hook-broker approval TIMED OUT (Duet answered nothing; the CLI's native
   * card is taking over for the SAME request). Arm the resurface recognition so
   * the scrape's imminent re-detection of that native card is marked as a
   * resurface, not a fresh ask — else the user gets a second "needs you"
   * notification for a request they were already told about. One-shot; the next
   * candidate within the resurface window consumes it.
   */
  noteBrokerApprovalExpiry(): void {
    this.brokerExpiryResurfaceAt = Date.now();
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
    this.beginDuetWrite();
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
      this.endDuetWrite();
    }
  }

  async stopRun(
    options: { inspectDelayMs?: number; forceSlashStop?: boolean } = {},
  ): Promise<{ canceledPendingPromptWrite: boolean }> {
    const stoppedRunId = this.activeRun ? this.activeRun.id : null;
    const stoppedCommandApprovalRun = this.activeRun?.approvalKind === "command";
    // Abort our own undelivered bytes FIRST: submitPrompt defers its text and
    // Enter writes on timers, so a stop clicked right after a send would
    // otherwise be trailed by our own paste starting the very turn the user
    // tried to stop (probe S0, stop-after-send race). The caller relays
    // `canceledPendingPromptWrite` to the DeliveryController so the aborted
    // item is reported honestly instead of waiting out the receipt timeout.
    const canceledPendingPromptWrite = this.cancelPendingDeferredWrites() > 0;
    this.writeRaw(ESC);
    // Esc-interrupt restores the interrupted prompt into the CLI's own input
    // box when the turn had produced nothing yet (probe C1/X1, claude
    // 2.1.212 + codex 0.144.5) — and a canceled text write can likewise
    // strand a pasted prompt there. Either way the next injection would
    // concatenate onto it: mark the line dirty, clear it once the TUI
    // settles (belt), and let the next submission's prefix flood cover a
    // straggler (suspenders).
    this.cliInputMaybeDirty = true;
    this.armCliInputClear();
    // Arm the one-shot Esc resend: if a PreToolUse hook lands after this
    // stop, the turn provably survived the Esc (swallowed key) — resend once.
    this.stopEscRetry = { requestedAt: Date.now(), retried: false, runId: stoppedRunId };
    this.taskReady = false;
    this.emitEvent("run:stop-requested", {
      taskId: this.taskId,
      runId: stoppedRunId,
      phase: "interrupt",
      encodedAs: "Esc",
    });
    this.emitEvent("run:stopped", {
      taskId: this.taskId,
      runId: stoppedRunId,
      interruptSent: true,
      slashStopSent: false,
      slashStopReason: "Esc sent immediately; /stop inspection is running in the background",
    });
    this.finishActiveRun("stopped", "Esc interrupt sent", {
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
    return { canceledPendingPromptWrite };
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
  private writeCliInputClearFlood(reason: "pre-submit" | "post-stop settle"): boolean {
    if (!this.cliInputMaybeDirty || !this.ptyProcess) {
      return false;
    }
    if (reason !== "pre-submit") {
      if (this.approvalActive || this.duetWriteDepth > 0 || this.isHumanActivelyTyping()) {
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
      this.beginDuetWrite();
      this.ptyProcess.write(flood);
      this.endDuetWrite();
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

  resize(cols: number, rows: number): void {
    if (!this.ptyProcess) {
      return;
    }
    const nextCols = Number(cols) || DEFAULT_COLS;
    const nextRows = Number(rows) || DEFAULT_ROWS;
    this.ptyProcess.resize(nextCols, nextRows);
    // Keep the mirror in lock-step with the PTY so the serialized layout matches.
    this.scrollback?.resize(nextCols, nextRows);
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
    // Outside the ptyProcess guard: after a crash-exit already nulled the
    // process, a following dispose/startTask must still not leak timers.
    this.clearStopHygieneState();
    if (!this.ptyProcess) {
      return;
    }
    if (this.remoteControlActive) {
      this.setRemoteControlActive(false, null);
    }
    const proc = this.ptyProcess;
    this.ptyProcess = null;
    this.scrollback?.dispose();
    this.scrollback = null;
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
    if (this.humanSettleTimer) {
      clearTimeout(this.humanSettleTimer);
      this.humanSettleTimer = null;
    }
  }

  private handlePtyData(data: string): void {
    this.lastPtyDataAt = Date.now();
    const printable = cleanTerminal(data).trim().length > 0;
    if (printable) {
      this.lastPrintablePtyDataAt = this.lastPtyDataAt;
    }
    if (process.env.DUET_DEBUG_COMPLETION && this.activeRun && printable) {
      console.log(
        `[completion] ${new Date().toISOString()} run=${this.activeRun.id} pty-data len=${data.length} printable=${JSON.stringify(cleanTerminal(data).trim().slice(0, 60))}`,
      );
    }
    this.ptyBytesTotal += data.length;
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
    this.detectRemoteControlState(data);
    this.detectApproval();
    if (this.isHumanActivelyTyping()) {
      // While the human is typing in the terminal they may be answering a native
      // approval directly — re-check each repaint so approvalActive clears
      // promptly (continuous reconciliation; the settle pass catches a late one).
      this.clearApprovalIfAnsweredNatively();
    }
    // Completion debounce keys on PRINTABLE chunks only: the idle TUI's
    // ~200ms control-only heartbeat would otherwise clear+re-arm the timer
    // forever and the quiescence completion (slash runs, the Esc-interrupt
    // run-closer) never fires (s4-diags/zzz-completion-trace).
    if (printable) {
      this.scheduleCompletionCheck();
    }
  }

  /** The approval scrape's view of the stream: the run buffer (or idle tail)
   *  minus everything at or before the broker-decision watermark. A panel the
   *  broker already answered lies below the floor and cannot re-detect; a
   *  genuinely NEW ask paints fresh bytes above it. */
  private approvalScanSource(): string {
    const base = this.activeRun ? this.activeRunRaw : this.rawTail;
    const postFloorBytes = this.ptyBytesTotal - this.approvalScanFloor;
    if (postFloorBytes >= base.length) {
      return base;
    }
    return base.slice(base.length - postFloorBytes);
  }

  private detectApproval(): void {
    // The native-panel approval scrape is Claude-only (S4 funeral). Codex (and
    // any future hook-capable provider whose approvals arrive via the
    // PermissionRequest broker) never surfaces a scraped card — the broker owns
    // that channel end-to-end (ask → card → reply). A codex native card only
    // appears AFTER a broker timeout, and it is answered in the Terminal, not
    // re-scraped into a phantom Duet card (see handleApprovalExpired).
    if (this.profile.provider !== "claude") {
      return;
    }
    const approvalSource = this.approvalScanSource();
    const candidate = detectApprovalCandidate(approvalSource, this.profile);
    if (!candidate || candidate.promptAfterApproval) {
      return;
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
      // 2026-07-02): only positive Duet sends arm the settle check at
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
    this.lastApprovalKind = candidate.kind;
    this.lastApprovalFingerprint = candidate.fingerprint;
    this.activeApprovalOptionKeys = candidate.optionKeys ?? null;
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

    // Floored scan (fix/dormant-resume completion, review 2026-07-03): the
    // settle re-check is an approval scrape like the others, so it reads the
    // stream through the broker-decision watermark. The native-key honesty
    // backstop is preserved by construction — key decisions never advance the
    // floor, so a genuinely-still-open panel stays above it and resurfaces;
    // a broker-answered panel lies below it and cannot phantom-resurface
    // (this was the third scan site; the fix had converted the other two).
    const candidate = detectApprovalCandidate(this.approvalScanSource(), this.profile);
    if (!candidate || candidate.promptAfterApproval) {
      return;
    }
    if (Date.now() - this.lastPtyDataAt < DEFAULT_APPROVAL_SETTLE_MS - 50) {
      // A candidate is on screen but bytes are still flowing — too fresh to
      // judge. When a same-kind candidate was SUPPRESSED inside the settle
      // window it has no other path back (a static panel emits no further
      // bytes to re-trigger detection), so re-arm instead of dropping; the
      // chain ends when the screen quiets (judged below) or the candidate
      // leaves the tail. Every other path keeps today's one-shot semantics —
      // an unconditional re-arm would widen the false-resurface window for
      // answered panels whose text still lingers in the run tail.
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
  }

  private hasBackgroundTerminalHint(): boolean {
    const recent = cleanTerminal(this.rawTail).toLowerCase();
    return BACKGROUND_TERMINAL_HINTS.some((hint) => recent.includes(hint));
  }

  private inspectSlashStop(
    stoppedRunId: RunId | null,
    options: { forceSlashStop?: boolean; stoppedCommandApprovalRun?: boolean },
  ): void {
    const shouldSubmitSlashStop =
      this.profile.supportsSlashStop &&
      (Boolean(options.forceSlashStop) ||
        Boolean(options.stoppedCommandApprovalRun) ||
        this.hasBackgroundTerminalHint());
    const approvalGuardBlockedSlashStop = shouldSubmitSlashStop && this.approvalActive;
    if (shouldSubmitSlashStop && !approvalGuardBlockedSlashStop && this.ptyProcess) {
      try {
        this.submitPrompt("/stop", { createRun: false });
      } catch {
        // A stopped run should not be reopened by cleanup failure.
      }
    }

    const slashStopSent = shouldSubmitSlashStop && !approvalGuardBlockedSlashStop;
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
      sha256: after.exists ? (after.sha256 ?? null) : null,
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
        sha256: after.exists ? (after.sha256 ?? null) : null,
      });
    }

    this.fileSnapshot = nextSnapshot;
  }

  private beginRun(
    text: string,
    kind: RunKind,
    options: { title?: string; promptId?: string | null } = {},
  ): ActiveRun {
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
      endedAt: endedAt.toISOString(),
      elapsedMs: endedAt.getTime() - Date.parse(this.activeRun.startedAt),
    });

    this.activeRun = null;
    this.activeRunRaw = "";
    this.recentAttributionRun = {
      id: finished.id,
      expiresAt: Date.now() + this.postCompletionAttributionMs,
      prompt: finished.prompt,
    };
    this.lastFinishedPrompt = {
      text: finished.prompt.trim(),
      expiresAt: Date.now() + this.postCompletionAttributionMs,
    };
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
    if (process.env.DUET_DEBUG_COMPLETION) {
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
    // (`hasModelOrCwdHint` — the "? for shortcuts" needle a TRUE idle composer
    // paints). LOW-confidence closure survives only for hook-less sessions
    // (the honest backstop for a never-handshook CLI). Field evidence, claude
    // 2.1.211: a big-session post-submit stall leaves a >=1.75s printable-quiet
    // window while the model still works for minutes, and detectIdleComposer
    // reads the submit frame (activity glyph, then the composer ❯) as completed
    // at LOW confidence — closing a 2s-old live run. All 5 field misfires were
    // low-confidence; the medium gate blocks each. Failure direction (Woody):
    // prefer a "still working" lie (liveness surfaces it honestly at 20s/60s)
    // over a "done" lie (actively misleading). Slash runs keep quiescence as
    // their honest completion — no Stop hook exists for them.
    const heuristicMayClose =
      this.activeRun.kind === "slash" ||
      !this.hookSessionStarted ||
      hint.confidence === "medium";
    const completed = idleVerdict && heuristicMayClose;
    if (!completed) {
      this.updateActiveRun({
        lifecyclePhase: "active",
        lastLifecycleHint: hint,
      });
      // A DEMOTED verdict — the scrape sees an idle composer but hooks own this
      // turn's end — must keep the run under judgment: re-arm so a later Stop,
      // or a medium-confidence idle footer, still closes it. (The old
      // not-completed branch returned without re-arming, relying on the next
      // printable chunk to re-schedule; a demoted run can go byte-silent for
      // minutes, so it needs its own poll.) No busy loop: scheduleCompletion
      // check no-ops once the run leaves "active", and the printable-quiet
      // guard debounces each re-arm to a completionQuietMs cadence.
      if (idleVerdict && !heuristicMayClose) {
        this.scheduleCompletionCheck();
      }
      return;
    }

    this.finishActiveRun("completed", "terminal idle/composer heuristic", {
      completionSource: "terminal-idle-heuristic",
      completionConfidence: this.activeRun.kind === "slash" ? "medium" : hint.confidence,
      completionHint: hint,
    });
  }

  /**
   * Complete the active run from the authoritative turn-end signal — the Claude
   * `Stop` hook. This is the honest answer to "did the turn end?": a structured
   * event, not the composer-idle screen scrape. `checkCompletionHeuristic`
   * stays as the fallback (for hook-less sessions or a missed Stop), so this is
   * purely additive — Stop completes promptly, the scrape still backstops it.
   *
   * A no-op when no Duet-owned run is active (a take-over turn, or the scrape
   * already finished it — which also avoids any double-completion) and for
   * runs mid-stop. UNLIKE the heuristic it is NOT gated on the approval flag:
   * a genuinely pending ask holds its turn open, so Stop arriving while we
   * think an approval is waiting proves that state stale — see the guard
   * comment in the body (2026-07-03 phantom-resurface wedge).
   */
  completeRunFromTurnEnd(failure?: { errorExcerpt: string }): ActiveRun | null {
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
      this.approvalActive = false;
      this.approvalSuppressedInSettleWindow = false;
      this.clearApprovalSettleTimer();
    }
    // `StopFailure` (probed S6: fires on API errors with a structured
    // `error` field, while Stop stays silent) rides the same completion
    // path — the turn ENDED; the hint carries the structured error, so the
    // scrape-side excerpt extraction is now the fallback, not the primary.
    if (failure) {
      return this.finishActiveRun("completed", "stop-failure hook (turn failed)", {
        completionSource: "hook-stop",
        completionConfidence: "high",
        completionHint: withCompletionErrorExcerpt(undefined, failure.errorExcerpt),
      });
    }
    return this.finishActiveRun("completed", "stop hook (turn ended)", {
      completionSource: "hook-stop",
      completionConfidence: "high",
    });
  }

  private clearCompletionTimer(): void {
    if (!this.completionTimer) {
      return;
    }
    clearTimeout(this.completionTimer);
    this.completionTimer = null;
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
 * The ONE place Duet's user-facing `CodexPermissionMode` fans back out to
 * Codex's legacy (sandbox × approval × reviewer) axes — verified live against
 * codex 0.144.4 (spikes/codex-perm-profile-probe, probe-modes.mjs): each row
 * shows the matching "(current)" in the TUI `/permissions` picker, full-access
 * boots straight into "YOLO mode" with no confirmation modal, and every row's
 * `approvals_reviewer` is accepted at spawn. The explicit `approvals_reviewer`
 * on ALL rows shields Duet sessions from a globally-persisted `auto_review`
 * (which the Codex TUI writes into the active config layer) bleeding in.
 *
 * `permission_profile`/`default_permissions` (the upstream profile system) are
 * silently ignored on 0.144.4 — when they start working, this table is the one
 * function to swap.
 */
const CODEX_PERMISSION_MODE_FLAGS: Record<
  CodexPermissionMode,
  { sandbox: CodexSandboxMode; approval: CodexApprovalMode; reviewer: string }
> = {
  "ask-for-approval": { sandbox: "workspace-write", approval: "on-request", reviewer: "user" },
  "approve-for-me": { sandbox: "workspace-write", approval: "on-request", reviewer: "auto_review" },
  "full-access": { sandbox: "danger-full-access", approval: "never", reviewer: "user" },
};

export function codexArgs(options: {
  cwd: string;
  permissionMode: CodexPermissionMode;
  model?: string | null | undefined;
  reasoningEffort?: ReasoningEffort | null | undefined;
  speedMode?: LaunchSpeedMode | null | undefined;
  resumeLast?: boolean;
  resumeRef?: string | undefined;
  /** Layer the Duet hook profile via `-p <profile>` (CONFIG_PROFILE_V2). Unset
   *  → no profile flag (bare TerminalHost in a test still works). */
  profile?: string | undefined;
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
  const permission = CODEX_PERMISSION_MODE_FLAGS[options.permissionMode];
  return [
    ...base,
    // `-p duet` layers Duet's hook profile onto the user's own config (union,
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
      // Verified against claude 2.1.209 idle layout (spikes/claude-idle-prompt-fable/):
      // the model/effort/cwd line renders ABOVE the composer, outside the
      // forward-700 promptTail window, so the model tokens never match there on
      // 2.1.x. `shortcuts` (from the idle footer "? for shortcuts") is what
      // actually lands post-glyph at a true idle composer and is absent while
      // working ("esc to interrupt") — it, not the model name, restores the
      // medium-confidence signal. Model/effort tokens kept as a harmless
      // superset for other layouts; `fable` added for completeness.
      idlePromptModelHints: /opus|sonnet|haiku|fable|xhigh|high|medium|low|effort|shortcuts|for agents|~/i,
      buildArgs: (options) =>
        claudeArgs({
          permissionMode: options.permissionMode,
          model: options.model,
          reasoningEffort: options.reasoningEffort,
          settingsPath: ensureClaudeRuntimeSettings(
            options.runtimeDir ?? path.join(options.cwd, ".duet"),
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
    };
  }

  return {
    provider,
    defaultCommand: "codex",
    approvalSource: "native Codex PTY approval screen",
    supportsSlashStop: true,
    activityHints: ["working", "esc to interrupt"],
    idlePromptModelHints: /gpt[-\w.]*|xhigh|high|medium|low|~/i,
    buildArgs: (options) => {
      // Spawn-prep the injected hook profile + stable shims (write-if-changed).
      // Byte-stable and task-invariant: the SessionStart handshake then carries
      // identity + hook liveness. Absent codexHookPaths (a bare TerminalHost in
      // a test) → no injection, no `-p duet`.
      //
      // If the write fails (unwritable dir, ENOSPC, a shell-unsafe shim path),
      // DEGRADE to a hookless spawn rather than aborting the launch. Post-S4
      // there is NO scrape beneath: hookless codex degrades to Terminal-driven
      // use — the missing handshake raises the liveness banner AND a needs-you
      // notification (notification-policy: cli-hooks:liveness→missing), and any
      // approval is answered natively in the Terminal (no per-approval Duet
      // card in this state; recorded in the plan's negative space).
      let profile: string | undefined;
      if (options.codexHookPaths) {
        try {
          ensureCodexRuntimeSettings(options.codexHookPaths);
          profile = CODEX_DUET_PROFILE;
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
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}






// detectClaudePermissionMode (the permission-mode banner scrape) retired in
// S4: S3 deleted its last caller (driveClaudePermission); mode DISPLAY now
// follows the hook payload's `permission_mode` (runtime-controller). History:
// git log -S detectClaudePermissionMode.

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rawTailSince(snapshot: string, current: string): string {
  if (current.startsWith(snapshot)) {
    return current.slice(snapshot.length);
  }
  const maxOverlap = Math.min(snapshot.length, current.length);
  for (let length = maxOverlap; length > 0; length -= 1) {
    if (snapshot.slice(-length) === current.slice(0, length)) {
      return current.slice(length);
    }
  }
  return current;
}

function attachmentPromptTitle(count: number): string {
  return count === 1 ? "[Image attachment]" : `[${count} image attachments]`;
}

// "This hook echo is that stored prompt" — the equivalence relation for every
// UserPromptSubmit-hook comparison in beginRunFromHook. Reads through the CLI's
// [Image #N] decoration: the hook payload carries it, the run prompt Duet stored
// does not. All three call sites (finishedTwin, back-stamp guard, echo-swallow)
// share it, so the image back-stamp fix can never outrun the twin-safety guard —
// normalizing only the back-stamp would let a just-finished twin's late image
// echo cross-wire its prompt_id onto the next run (review 2026-07-05).
function samePromptModuloCliDecoration(stored: string, hookText: string): boolean {
  return normalizePromptForMatch(stored) === normalizePromptForMatch(hookText);
}

export function cleanTerminal(text: string): string {
  return text
    .replace(ANSI_RE, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(CONTROL_RE, "");
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
  // Nested-session markers inherited when Duet itself was launched from a
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
  return {
    ...env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    ...(extraEnv ?? {}),
  };
}

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
      sha256: hashSmallFile(filePath, stat.size),
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

function hashSmallFile(filePath: string, size: number): string | null {
  if (size > 2 * 1024 * 1024) {
    return null;
  }
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

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
    before.sha256 !== after.sha256 ||
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
  const lastPrompt = recent.lastIndexOf(">");
  const lastCodexPrompt = recent.lastIndexOf("›");
  const lastClaudePrompt = recent.lastIndexOf("❯");
  const lastAnyPrompt = Math.max(lastPrompt, lastCodexPrompt, lastClaudePrompt);
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
  return {
    kind,
    fingerprint,
    fingerprintHash: fingerprint ? sha256(fingerprint).slice(0, 16) : null,
    promptAfterApproval: detectIdlePrompt(rawText, profile).promptAfterApproval,
    choices: approvalChoices(rawText, profile),
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
  if (footerIndex < 0 || options.length < 2) {
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
    return [
      {
        decision: "approve",
        label: "Trust this folder",
        description:
          "Choose the native “Yes, I trust this folder” option (plain Enter — this screen ignores CSI-u).",
        encodedAs: "CR",
      },
      {
        decision: "deny",
        label: "Deny",
        description: "Dismiss the native trust screen.",
        encodedAs: "Esc",
      },
    ];
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
        "Duet shows a receipt of what was written.",
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

function claudePanelOptionKeys(panel: ParsedClaudePanel): Partial<Record<ApprovalDecision, string>> {
  if (panel.isBypass) {
    // "Yes, I accept" is option 2; deny falls through to Esc (sendDeny).
    return { approve: "2" };
  }
  if (panel.isTrust) {
    // CSI-u Enter bounces off the trust screen (pre-kitty-negotiation);
    // plain CR is probe-verified.
    return { approve: "\r" };
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

function shouldIgnorePath(relativePath: string): boolean {
  if (!relativePath) {
    return true;
  }
  const parts = relativePath.split(/[\\/]/);
  return (
    parts.includes(".git") ||
    parts.includes(".duet") ||
    parts.includes("node_modules") ||
    parts.includes("__pycache__") ||
    parts.includes("sample-output") ||
    relativePath.endsWith(".DS_Store") ||
    relativePath.endsWith(".pyc")
  );
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
