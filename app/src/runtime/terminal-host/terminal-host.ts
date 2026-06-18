import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import * as pty from "node-pty";
import type {
  ApprovalChoice,
  ApprovalDecision,
  ApprovalDecisionEncoding,
  ApprovalKind,
  ClaudePermissionMode,
  CodexApprovalMode,
  CodexPermissionPreset,
  CodexSandboxMode,
  CompletionConfidence,
  CompletionHint,
  CompletionSource,
  DeliveryControlChange,
  LaunchSpeedMode,
  ReasoningEffort,
  RuntimeProvider,
  RunId,
  RunKind,
  RunStatus,
  TaskId,
} from "../../shared/types/domain";
import type { RuntimeEvent, RunUpdatedEvent } from "../../shared/types/events";
import { ensureClaudeRuntimeSettings } from "../cli-signal";

export const BRACKETED_PASTE_START = "\x1b[200~";
export const BRACKETED_PASTE_END = "\x1b[201~";
export const CSI_U_ENTER = "\x1b[13u";
export const ARROW_DOWN = "\x1b[B";
export const ESC = "\x1b";
export const SHIFT_TAB = "\x1b[Z";
const CTRL_U = "\x15";
const ENTER = "\r";

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

const DEFAULT_ROWS = 36;
const DEFAULT_COLS = 120;
// Modal-panel detection (probe evidence: spikes/slash-probes, 2026-06-12).
// cleanTerminal output sometimes loses spaces between rendered cells, so the
// patterns tolerate collapsed whitespace.
const MODAL_DETECT_WINDOW_MS = 45_000;
const MODAL_SCAN_CHARS = 4000;
// Ambient (startup/idle) panels must survive a quiescence window before
// arming: real panels are static (P1 2026-06-12: 65s+ without a byte),
// transient repaint frames are not.
const AMBIENT_MODAL_CONFIRM_MS = 1200;
const AMBIENT_MODAL_QUIET_MS = 600;
export const CLAUDE_MODAL_FOOTER_RE = /Esc\s*to\s*(cancel|clear)/gi;
export const CODEX_MODAL_FOOTER_RE = /esc\s*to\s*(go\s*back|close)|space\s*to\s*select/gi;
// What the composer looks like when it is back: Claude prints a dismissal
// line (⎿ … dismissed / cancelled) and its bottom bar (◉ mode glyph,
// "← for agents"); Codex repaints its status bar ("gpt-5.5 xhigh · /path").
// Probe screens: spikes/slash-probes evidence, 2026-06-12.
export const CLAUDE_COMPOSER_REDRAW_RE = /dismissed|cancelled|◉|←\s*for\s*agents/gi;
export const CODEX_COMPOSER_REDRAW_RE = /gpt[-\w.]+\s*\w*\s*·\s*[~/]/gi;
/** Marker shared by all single-writer guard errors so DeliveryController can
 *  re-queue (not fail) items blocked by a guard. */
export const USER_CONTROL_GUARD_MESSAGE =
  "The user is controlling the terminal — Duet writes are paused until hand-back.";

function lastMatchIndex(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  let last = -1;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    last = match.index;
    if (match.index === pattern.lastIndex) {
      pattern.lastIndex += 1;
    }
  }
  return last;
}
const DEFAULT_SCROLLBACK_LIMIT = 64 * 1024;
const DEFAULT_COMPLETION_QUIET_MS = 1800;
const DEFAULT_TASK_READY_MIN_AGE_MS = 8000;
const CODEX_TASK_READY_MIN_AGE_MS = 14_000;
const DEFAULT_TASK_READY_QUIET_MS = 900;
const DEFAULT_POST_COMPLETION_ATTRIBUTION_MS = 5000;
const DEFAULT_APPROVAL_SETTLE_MS = 1200;
/** Gap between option-prompt keystrokes so the native form's per-question
 *  auto-advance (and the final Submit-tab render) settles before the next key.
 *  Phase 0 saw the advance repaint well under this; generous = robust. */
const OPTION_PROMPT_KEY_DELAY_MS = 300;
/** How long after the human's last terminal keystroke Duet treats them as
 *  actively typing and holds delivery (S2). Bridges the gaps between keystrokes
 *  — and the pause-to-think over a half-typed line — that the idle-prompt
 *  heuristic alone cannot see. Dogfood-tuned. */
const HUMAN_ACTIVE_WINDOW_MS = 3500;
const DEFAULT_CONTROL_WAIT_MS = 15_000;
const CONTROL_CONTEXT_CHARS = 6000;

const CODEX_FILE_EDIT_APPROVAL_HINTS = [
  "would you like to make the following edits",
  "don't ask again for these files",
  "press enter to confirm",
];

const CODEX_COMMAND_APPROVAL_HINTS = [
  "would you like to run the following command",
  "don't ask again for commands that start with",
  "press enter to confirm",
];

const CODEX_WORKSPACE_TRUST_APPROVAL_HINTS = [
  "do you trust the contents of this directory",
  "trusting the directory",
  "press enter to continue",
];

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
  defaultWorkspace: string;
  provider?: RuntimeProvider;
  eventSink?: (event: RuntimeEvent) => void;
  scrollbackLimit?: number;
  completionQuietMs?: number;
  postCompletionAttributionMs?: number;
}

export interface StartTaskOptions {
  cwd?: string;
  command?: string;
  args?: string[];
  sandbox?: CodexSandboxMode;
  approval?: CodexApprovalMode;
  permissionMode?: ClaudePermissionMode;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  speedMode?: LaunchSpeedMode | null;
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

export interface NativeControlResult {
  provider: RuntimeProvider;
  change: DeliveryControlChange;
  verifiedAt: string;
  evidence: string;
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
  taskReadyMinAgeMs: number;
  taskReadyQuietMs: number;
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
  private readonly profile: TerminalProviderProfile;
  private readonly defaultWorkspace: string;
  private readonly eventSink: ((event: RuntimeEvent) => void) | null;
  private readonly scrollbackLimit: number;
  private readonly completionQuietMs: number;
  private readonly postCompletionAttributionMs: number;
  private ptyProcess: pty.IPty | null = null;
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
  /** decision → key bytes for the CURRENTLY surfaced panel (v2 grammar
   *  parses the panel's own numbered options; digits instant-select). */
  private activeApprovalOptionKeys: Partial<Record<ApprovalDecision, string>> | null = null;
  private persistReceiptTimers: NodeJS.Timeout[] = [];
  private nativeAnswerRecheckTimers: NodeJS.Timeout[] = [];
  private startedAt: number | null = null;
  private activeRun: ActiveRun | null = null;
  private runSeq = 0;
  private completionTimer: NodeJS.Timeout | null = null;
  private approvalSettleTimer: NodeJS.Timeout | null = null;
  private taskReadyTimer: NodeJS.Timeout | null = null;
  private acceptsInputAnnounced = false;
  private lastPtyDataAt = 0;
  private taskReady = false;
  private recentAttributionRun: RecentAttributionRun | null = null;
  private activeRunRaw = "";
  private modalActive = false;
  private modalSignature: string | null = null;
  /** How the panel was armed: slash panels have probe-verified Esc
   *  semantics; ambient (startup/idle) panels do NOT — Esc on the resume
   *  panel silently resumes full, Esc on Codex trust quits the process. */
  private modalOrigin: "slash" | "ambient" | null = null;
  private ambientModalCandidate: { signature: string; sinceMs: number } | null = null;
  private ambientModalTimer: NodeJS.Timeout | null = null;
  /** Arms the modal detector for a window after a slash passthrough. */
  private lastSlashSubmitAt = 0;
  /**
   * The human holds the keys (drawer take-over). Single-writer: while true
   * every automation write path throws USER_CONTROL_GUARD_MESSAGE and only
   * writeUserInput() may reach the PTY. P1b (2026-06-12): a single arrow
   * key against a live panel flips the idle-prompt heuristic, so delivery
   * MUST pause while a human navigates — this is a safety property.
   */
  private userControlActive = false;
  /**
   * Single-writer arbitration between Duet's automation and the human typing in
   * the terminal (S2). `duetWriteDepth` > 0 means an automation write SEQUENCE is
   * in flight — a prompt paste (sync attachment writes + the deferred text/Enter
   * timers), an option-prompt key run, or a control-change drive. Human
   * keystrokes that arrive during that window are held in `pendingHumanInput` and
   * flushed the instant the sequence completes, so the two byte streams never
   * interleave (no `git che`+paste corruption; no split bracketed-paste frame).
   * `lastHumanInputAt` timestamps the human's last terminal keystroke;
   * `isHumanActivelyTyping()` reads it to pause delivery while the human drives.
   */
  private duetWriteDepth = 0;
  private pendingHumanInput = "";
  private lastHumanInputAt = 0;
  private humanSettleTimer: NodeJS.Timeout | null = null;
  /** Printable chars the human has typed onto the current terminal line since
   *  their last Enter/clear — i.e. an uncommitted draft. > 0 holds delivery so an
   *  automation paste never lands mid-line (tracked from relayed keystrokes, not
   *  the screen). */
  private humanLineChars = 0;

  constructor(options: TerminalHostOptions) {
    super();
    this.taskId = options.taskId;
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

  isApprovalActive(): boolean {
    return this.approvalActive;
  }

  isIdleComposerReady(): boolean {
    if (!this.ptyProcess || this.activeRun || this.approvalActive || !this.taskReady) {
      return false;
    }
    if (Date.now() - this.lastPtyDataAt < this.profile.taskReadyQuietMs) {
      return false;
    }
    return detectIdlePrompt(this.rawTail, this.profile).ready;
  }

  /**
   * Structural "the composer exists and is idle" check WITHOUT the
   * taskReadyMinAgeMs fuse. Prompt detection already requires the prompt to
   * render AFTER any approval-screen text, so a pending trust screen blocks
   * this both via approvalActive and via the prompt-ordering rule. Used by
   * the delivery gate so a queued first message goes out as soon as the CLI
   * accepts input (~3s) instead of at the task-ready floor (14s); task:ready
   * remains the unconditional fallback that pumps delivery at the latest.
   */
  acceptsPromptInput(): boolean {
    if (!this.ptyProcess || this.activeRun || this.approvalActive) {
      return false;
    }
    if (Date.now() - this.lastPtyDataAt < this.profile.taskReadyQuietMs - 50) {
      return false;
    }
    return detectIdlePrompt(this.rawTail, this.profile).ready;
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
    this.activeApprovalOptionKeys = null;
    this.clearPersistReceiptTimers();
    this.clearNativeAnswerRecheckTimers();
    this.activeRun = null;
    this.recentAttributionRun = null;
    this.activeRunRaw = "";
    this.taskReady = false;
    this.acceptsInputAnnounced = false;
    this.clearModalPanel();
    this.resetAmbientModalCandidate();
    this.clearCompletionTimer();
    this.clearApprovalSettleTimer();
    this.clearTaskReadyTimer();
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

    this.ptyProcess.onData((data) => this.handlePtyData(data));
    this.ptyProcess.onExit((exit) => {
      if (this.userControlActive) {
        // Control never outlives the process that granted it.
        this.setUserControl(false, "pty-exit");
      }
      this.emitEvent("pty:exit", {
        taskId: this.taskId,
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

  isUserControlActive(): boolean {
    return this.userControlActive;
  }

  /**
   * Explicit, reversible take-over (Warp CMD+I model). Idempotent; emits
   * terminal:user-control on every transition so the renderer, delivery
   * pump, and receipts all observe the same single-writer state.
   */
  setUserControl(active: boolean, reason: "user" | "pty-exit" = "user"): boolean {
    if (active && !this.ptyProcess) {
      throw new Error("No PTY process is running.");
    }
    if (this.userControlActive === active) {
      return this.userControlActive;
    }
    this.userControlActive = active;
    if (!active) {
      // Hand-back: the human may have changed anything — re-derive
      // readiness from fresh screen evidence instead of stale flags.
      this.clearApprovalIfAnsweredNatively();
      // The one-shot evaluation races the post-answer repaint: a hand-back
      // in the same beat as the answering keystroke still sees the panel
      // on screen and approvalActive wedges forever (probe 2026-06-13).
      // Re-check once the screen has had time to settle.
      this.scheduleNativeAnswerRecheck();
      this.taskReady = false;
      this.acceptsInputAnnounced = false;
      this.scheduleTaskReadyCheck();
    }
    this.emitEvent("terminal:user-control", {
      taskId: this.taskId,
      active,
      reason,
    });
    return this.userControlActive;
  }

  /**
   * The human's keystrokes into the terminal. No take-over gate (S2): the human
   * may type anytime. The single-writer invariant is held instead by (1) the
   * write-lock — keystrokes that arrive mid automation-sequence buffer and flush
   * after, never interleaving — and (2) the input-hold signal (`isHumanHoldingInput`),
   * which pauses delivery while the human is typing OR has an uncommitted line.
   */
  writeUserInput(data: string): void {
    if (!this.ptyProcess) {
      throw new Error("No PTY process is running.");
    }
    this.lastHumanInputAt = Date.now();
    this.scheduleHumanInputSettle();
    this.trackHumanLine(data);
    if (this.duetWriting) {
      this.pendingHumanInput += data;
      return;
    }
    this.ptyProcess.write(data);
  }

  /**
   * Track whether the human has an UNCOMMITTED line in the terminal, from the
   * keystrokes Duet itself relays — no screen scraping. The idle-prompt heuristic
   * matches the prompt's structure even with text typed after it, so a half-typed
   * `git g` left for a while would otherwise look idle and let an automation
   * paste land mid-line (the corruption case). `humanLineChars > 0` holds delivery
   * until the human submits (Enter) or clears the line.
   */
  private trackHumanLine(data: string): void {
    // Enter (either encoding) commits the line; so does a paste that carries a
    // newline. Strip bracketed-paste markers first so the newline check sees the
    // pasted content.
    const unwrapped = data.replace(/\x1b\[20[01]~/g, "");
    if (data === CSI_U_ENTER || /[\r\n]/.test(unwrapped)) {
      this.humanLineChars = 0;
      return;
    }
    // Ctrl-U (kill line), Ctrl-C (cancel), or a lone Esc clears the draft.
    if (data === "\x15" || data === "\x03" || data === "\x1b") {
      this.humanLineChars = 0;
      return;
    }
    // Strip remaining CSI escape sequences (arrows, function keys) — navigation,
    // not input. What's left is literal text typed or pasted onto the line.
    const literal = unwrapped.replace(/\x1b\[[0-9;]*[A-Za-z~]/g, "");
    let delta = 0;
    for (const ch of literal) {
      if (ch === "\x7f" || ch === "\b") {
        delta -= 1; // backspace / delete
      } else if (ch >= " ") {
        delta += 1; // printable (incl. multi-byte CJK code points)
      }
    }
    this.humanLineChars = Math.max(0, this.humanLineChars + delta);
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
   *  evidence and re-announce accepts-input so a held queue re-pumps. This is the
   *  activity-settle reconciliation that replaces the old explicit hand-back
   *  (which ran the identical body on setUserControl(false)). */
  private onHumanInputSettled(): void {
    if (!this.ptyProcess) {
      return;
    }
    this.clearApprovalIfAnsweredNatively();
    this.scheduleNativeAnswerRecheck();
    this.taskReady = false;
    this.acceptsInputAnnounced = false;
    this.scheduleTaskReadyCheck();
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
   *  splitting the sequence. */
  private deferDuetWrite(ms: number, fn: () => void): void {
    this.beginDuetWrite();
    setTimeout(() => {
      try {
        fn();
      } finally {
        this.endDuetWrite();
      }
    }, ms);
  }

  private get duetWriting(): boolean {
    return this.duetWriteDepth > 0;
  }

  /** True within the activity window of the human's last terminal keystroke. */
  isHumanActivelyTyping(): boolean {
    return (
      this.lastHumanInputAt > 0 && Date.now() - this.lastHumanInputAt < HUMAN_ACTIVE_WINDOW_MS
    );
  }

  /** The delivery pause signal: the human is either actively typing OR has an
   *  uncommitted line sitting in the terminal. Either way an automation paste
   *  would corrupt their input, so the queue holds (the Expect exclusivity
   *  lesson — here keyed on real input state, not a mode or a screen guess). */
  isHumanHoldingInput(): boolean {
    return this.isHumanActivelyTyping() || this.humanLineChars > 0;
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
    const approvalSource = this.activeRun ? this.activeRunRaw : this.rawTail;
    const candidate = detectApprovalCandidate(approvalSource, this.profile);
    if (candidate && !candidate.promptAfterApproval) {
      return;
    }
    const previousKind = this.lastApprovalKind;
    this.approvalActive = false;
    this.lastApprovalDecision = "answered-natively";
    this.lastApprovalDecisionAt = Date.now();
    this.taskReady = false;
    this.acceptsInputAnnounced = false;
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
    this.scheduleTaskReadyCheck();
  }

  private scheduleNativeAnswerRecheck(): void {
    this.clearNativeAnswerRecheckTimers();
    for (const delayMs of [1500, 4000]) {
      this.nativeAnswerRecheckTimers.push(
        setTimeout(() => {
          if (!this.userControlActive) {
            this.clearApprovalIfAnsweredNatively();
          }
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
    if (this.modalActive) {
      throw new Error(
        "The provider is showing an interactive panel — close it (Esc) before sending. Pasted text would be swallowed by the panel.",
      );
    }
    if (this.userControlActive) {
      throw new Error(USER_CONTROL_GUARD_MESSAGE);
    }

    const kind: RunKind = trimmed.startsWith("/") && attachments.length === 0 ? "slash" : "prompt";
    const runText = trimmed || attachmentPromptTitle(attachments.length);
    const run = options.createRun === false ? null : this.beginRun(runText, kind);
    const submittedAt = new Date().toISOString();

    this.taskReady = false;
    this.approvalActive = false;
    this.lastApprovalKind = null;
    this.lastApprovalDecision = null;
    this.lastApprovalDecisionAt = null;
    this.clearApprovalSettleTimer();
    // Hold the write-lock across the whole sync+deferred sequence so a human
    // keystroke landing mid-paste buffers (and flushes after) rather than
    // splitting the bracketed-paste frame (S2). The initial begin covers the
    // synchronous attachment writes; each deferred write keeps the depth > 0
    // until it fires, so endDuetWrite() below does not release early.
    this.beginDuetWrite();
    for (const attachment of attachments) {
      this.ptyProcess.write(`${BRACKETED_PASTE_START}${attachment.path}${BRACKETED_PASTE_END}`);
    }
    if (kind === "slash") {
      this.lastSlashSubmitAt = Date.now();
    }
    const textDelayMs = attachments.length > 0 ? 120 : 0;
    const enterDelayMs = attachments.length > 0 ? 260 : 120;
    // The deferred writes re-check userControlActive: a take-over that lands
    // between the guard above and these timers must still win — suppressed
    // bytes surface as a receipt timeout, never as keystrokes under the
    // human's navigation.
    this.deferDuetWrite(textDelayMs, () => {
      if (this.ptyProcess && trimmed && !this.userControlActive) {
        this.ptyProcess.write(`${BRACKETED_PASTE_START}${trimmed}${BRACKETED_PASTE_END}`);
      }
    });
    this.deferDuetWrite(enterDelayMs, () => {
      if (this.ptyProcess && !this.userControlActive) {
        this.ptyProcess.write(CSI_U_ENTER);
      }
    });
    // A bare Codex skill mention ("$name") opens the skill-mention popup,
    // whose "Press enter to insert" consumes the first Enter. The second
    // Enter submits the inserted mention. Both steps verified by probe
    // s3b.codexSkillDoubleEnter; with trailing text the popup closes on its
    // own and the extra Enter never fires.
    if (this.profile.provider === "codex" && /^\$[A-Za-z0-9][\w.-]*$/.test(trimmed)) {
      this.deferDuetWrite(enterDelayMs + 320, () => {
        if (this.ptyProcess && !this.userControlActive) {
          this.ptyProcess.write(CSI_U_ENTER);
        }
      });
    }
    // Release the initial begin; the deferred writes hold the depth until they
    // fire, so the lock spans the full sequence.
    this.endDuetWrite();
    this.emitEvent("prompt:submitted", {
      taskId: this.taskId,
      runId: run ? run.id : this.activeRun ? this.activeRun.id : null,
      kind,
      chars: trimmed.length,
      attachments: attachments.length,
    });
    return {
      taskId: this.taskId,
      runId: run ? run.id : this.activeRun ? this.activeRun.id : null,
      kind,
      submittedAt,
    };
  }

  async applyControlChange(change: DeliveryControlChange): Promise<NativeControlResult> {
    if (!this.ptyProcess) {
      throw new Error("No PTY process is running.");
    }
    if (this.approvalActive) {
      throw new Error("Cannot change controls while a native approval screen is active.");
    }
    if (this.activeRun) {
      throw new Error("Cannot change controls while a provider run is active.");
    }
    if (this.userControlActive) {
      throw new Error(USER_CONTROL_GUARD_MESSAGE);
    }
    if (!this.isIdleComposerReady()) {
      await this.waitForIdleComposer(DEFAULT_CONTROL_WAIT_MS);
    }
    if (!this.isIdleComposerReady()) {
      throw new Error("Cannot change controls until the provider composer is idle.");
    }

    // Hold the write-lock across the multi-step native drive (slash command,
    // picker navigation, digit selection) so a human keystroke buffers rather
    // than desyncing the navigation (S2). The idle-wait above only reads.
    this.beginDuetWrite();
    let evidence: string;
    try {
      evidence =
        this.profile.provider === "codex"
          ? await this.applyCodexControlChange(change)
          : await this.applyClaudeControlChange(change);
    } finally {
      this.endDuetWrite();
    }
    this.taskReady = false;
    this.scheduleTaskReadyCheck();
    return {
      provider: this.profile.provider,
      change,
      verifiedAt: new Date().toISOString(),
      evidence,
    };
  }

  private async applyCodexControlChange(change: DeliveryControlChange): Promise<string> {
    if (change.kind === "permission") {
      if (!change.codex) {
        throw new Error("Codex permission change was missing its native preset.");
      }
      return this.driveCodexPermissions(change.codex.preset);
    }
    return this.driveCodexModel(change.model, change.reasoningEffort);
  }

  private async driveCodexPermissions(preset: CodexPermissionPreset): Promise<string> {
    const label = codexPermissionPresetLabel(preset);
    const pickerOutput = await this.submitNativeSlashCommandAndWait(
      "/permissions",
      /Full\s*Access|FullAccess/i,
      DEFAULT_CONTROL_WAIT_MS,
      "Codex permissions picker",
    );
    const confirmationSnapshot = await this.selectCodexPickerItem(
      label,
      "Codex permissions option",
      pickerOutput,
      codexPermissionPresetIndex(preset),
    );
    if (preset === "fullAccess") {
      const fullAccessConfirmation = await this.waitForClean(
        /Permissions updated to\s+Full Access|Enable\s*full\s*access|Yes,\s*continue\s*anyway/i,
        DEFAULT_CONTROL_WAIT_MS,
        "Codex full access confirmation",
        confirmationSnapshot,
      );
      if (/Permissions updated to\s+Full Access/i.test(fullAccessConfirmation)) {
        return fullAccessConfirmation;
      }
      const finalConfirmationSnapshot = await this.selectCodexPickerItem(
        "Yes, continue anyway",
        "Codex full access confirmation option",
        fullAccessConfirmation,
      );
      return this.waitForClean(
        /Permissions updated to\s+Full Access/i,
        DEFAULT_CONTROL_WAIT_MS,
        "Codex permissions confirmation",
        finalConfirmationSnapshot,
      );
    }
    const confirmation = await this.waitForClean(
      new RegExp(`Permissions updated to\\s+${escapeRegExp(label)}`, "i"),
      DEFAULT_CONTROL_WAIT_MS,
      "Codex permissions confirmation",
      confirmationSnapshot,
    );
    return confirmation;
  }

  private async driveCodexModel(
    model: string | null,
    reasoningEffort: ReasoningEffort | null,
  ): Promise<string> {
    if (!model) {
      throw new Error("Codex model picker cannot verify a Native Default selection mid-session.");
    }
    const modelPickerOutput = await this.submitNativeSlashCommandAndWait(
      "/model",
      /Select Model|Select Model and Effort/i,
      DEFAULT_CONTROL_WAIT_MS,
      "Codex model picker",
    );
    let confirmationSnapshot = await this.selectCodexPickerItem(model, "Codex model option", modelPickerOutput);

    if (reasoningEffort) {
      const effortPickerOutput = await this.waitForClean(
        /effort|reasoning|Low|Medium|High|Extra High/i,
        DEFAULT_CONTROL_WAIT_MS,
        "Codex effort picker",
        confirmationSnapshot,
      );
      confirmationSnapshot = await this.selectCodexPickerItem(
        reasoningEffortPickerLabel(reasoningEffort),
        "Codex reasoning effort",
        effortPickerOutput,
      );
    }

    const confirmation = await this.waitForClean(
      new RegExp(`${escapeRegExp(model)}|model|effort|reasoning`, "i"),
      DEFAULT_CONTROL_WAIT_MS,
      "Codex model confirmation",
      confirmationSnapshot,
    );
    return confirmation;
  }

  private async selectCodexPickerItem(
    targetLabel: string,
    label: string,
    pickerOutput: string,
    targetIndexOverride?: number,
  ): Promise<string> {
    const targetDigit =
      targetIndexOverride === undefined
        ? pickerDigitForLabel(pickerOutput, targetLabel)
        : String(targetIndexOverride + 1);
    if (!targetDigit) {
      throw new Error(`${label} "${targetLabel}" was not found in the native picker.\n\n${pickerOutput.slice(-2200)}`);
    }
    const snapshot = this.rawTail;
    await delay(2000);
    this.writeRaw(targetDigit);
    await delay(180);
    this.writeRaw(ENTER);
    return snapshot;
  }

  private async applyClaudeControlChange(change: DeliveryControlChange): Promise<string> {
    if (change.kind === "permission") {
      if (!change.claude) {
        throw new Error("Claude permission change was missing its native mode.");
      }
      return this.driveClaudePermission(change.claude.permissionMode);
    }
    return this.driveClaudeModel(change.model, change.reasoningEffort);
  }

  private async driveClaudePermission(mode: ClaudePermissionMode): Promise<string> {
    if (!["default", "acceptEdits", "plan", "auto"].includes(mode)) {
      throw new Error(`Claude permission mode ${mode} is not available mid-session.`);
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = detectClaudePermissionMode(this.cleanTail(CONTROL_CONTEXT_CHARS));
      if (current === mode) {
        return this.cleanTail(CONTROL_CONTEXT_CHARS);
      }
      this.writeRaw(SHIFT_TAB);
      await delay(1800);
      const landed = detectClaudePermissionMode(this.cleanTail(CONTROL_CONTEXT_CHARS));
      if (landed === mode) {
        return this.cleanTail(CONTROL_CONTEXT_CHARS);
      }
    }

    throw new Error(
      `Claude permission mode ${mode} was not verified after bounded Shift+Tab cycling.\n\n${this.cleanTail(CONTROL_CONTEXT_CHARS).slice(-2200)}`,
    );
  }

  private async driveClaudeModel(
    model: string | null,
    reasoningEffort: ReasoningEffort | null,
  ): Promise<string> {
    if (model) {
      await this.submitNativeSlashSingleShot(`/model ${model}`);
      await this.waitForClean(new RegExp(escapeRegExp(model), "i"), 30_000, "Claude model confirmation");
      await this.waitForIdleComposer(DEFAULT_CONTROL_WAIT_MS);
    }
    if (reasoningEffort) {
      await this.submitNativeSlashSingleShot(`/effort ${reasoningEffort}`);
      await this.waitForClean(
        new RegExp(escapeRegExp(reasoningEffort), "i"),
        30_000,
        "Claude effort confirmation",
      );
      await this.waitForIdleComposer(DEFAULT_CONTROL_WAIT_MS);
    }
    return this.cleanTail(CONTROL_CONTEXT_CHARS);
  }

  private async submitNativeSlashCommandAndWait(
    text: string,
    pattern: RegExp,
    timeoutMs: number,
    label: string,
  ): Promise<string> {
    this.taskReady = false;
    const snapshot = this.rawTail;
    this.writeRaw(CTRL_U);
    await delay(40);
    this.writeRaw(`${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`);
    await delay(160);
    if (this.ptyProcess) {
      this.ptyProcess.write(ENTER);
    }
    return this.waitForClean(pattern, timeoutMs, label, snapshot);
  }

  private async submitNativeSlashSingleShot(text: string): Promise<void> {
    this.taskReady = false;
    this.writeRaw(`${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`);
    await delay(160);
    if (this.ptyProcess) {
      this.ptyProcess.write(CSI_U_ENTER);
    }
    await delay(500);
  }

  private async waitForClean(
    pattern: RegExp,
    timeoutMs: number,
    label: string,
    snapshot?: string,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const clean = snapshot
        ? cleanTerminal(rawTailSince(snapshot, this.rawTail)).slice(-CONTROL_CONTEXT_CHARS)
        : this.cleanTail(CONTROL_CONTEXT_CHARS);
      if (pattern.test(clean)) {
        return clean;
      }
      await delay(100);
    }
    const context = snapshot
      ? cleanTerminal(rawTailSince(snapshot, this.rawTail)).slice(-2200)
      : this.cleanTail(CONTROL_CONTEXT_CHARS).slice(-2200);
    throw new Error(`Timed out waiting for ${label}.\n\n${context}`);
  }

  private async waitForIdleComposer(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.approvalActive && !this.activeRun && detectIdlePrompt(this.rawTail, this.profile).ready) {
        return;
      }
      await delay(100);
    }
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
    if (this.userControlActive) {
      throw new Error(USER_CONTROL_GUARD_MESSAGE);
    }
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
    this.acceptsInputAnnounced = false;
    this.approvalActive = false;
    this.lastApprovalDecision = decision;
    this.lastApprovalDecisionAt = decisionAt;
    this.scheduleApprovalSettleCheck(decisionAt);
  }

  sendDeny(): void {
    if (this.userControlActive) {
      throw new Error(USER_CONTROL_GUARD_MESSAGE);
    }
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
    this.acceptsInputAnnounced = false;
    this.finishActiveRun("approval-denied", "Esc denied native approval", {
      completionSource: "native-control",
      completionConfidence: "high",
    });
    this.approvalActive = false;
    this.lastApprovalDecision = "deny";
    this.lastApprovalDecisionAt = Date.now();
    this.clearApprovalSettleTimer();
  }

  /**
   * Answer a native AskUserQuestion (option-prompt) form by playing back the
   * verified key sequence (`optionPromptAnswerSequence`): each question's chosen
   * 1-based digit, in order, then a CR for the Submit tab. Same keystroke-relay
   * mechanism approvals use — not stdin games.
   *
   * Single-writer: the human-on-the-terminal path is mutually exclusive with
   * this. We re-check user control before EVERY key so a take-over landing
   * mid-injection abandons the rest rather than racing the human's navigation.
   */
  async sendOptionPromptAnswer(keys: string[]): Promise<void> {
    if (!this.ptyProcess) {
      throw new Error("No PTY process is running.");
    }
    if (this.userControlActive) {
      throw new Error(USER_CONTROL_GUARD_MESSAGE);
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
        if (!this.ptyProcess || this.userControlActive) {
          throw new Error(USER_CONTROL_GUARD_MESSAGE);
        }
        this.writeRaw(key);
      }
    } finally {
      this.endDuetWrite();
    }
  }

  async stopRun(options: { inspectDelayMs?: number; forceSlashStop?: boolean } = {}): Promise<void> {
    if (this.userControlActive) {
      throw new Error(USER_CONTROL_GUARD_MESSAGE);
    }
    const stoppedRunId = this.activeRun ? this.activeRun.id : null;
    const stoppedCommandApprovalRun = this.activeRun?.approvalKind === "command";
    this.writeRaw(ESC);
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
    setTimeout(
      () => this.inspectSlashStop(stoppedRunId, {
        ...options,
        stoppedCommandApprovalRun,
      }),
      inspectDelayMs,
    );
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
    this.ptyProcess.resize(Number(cols) || DEFAULT_COLS, Number(rows) || DEFAULT_ROWS);
  }

  dispose(): void {
    this.clearTaskReadyTimer();
    this.resetAmbientModalCandidate();
    this.disposeProcess();
    this.stopFileWatcher();
    this.clearCompletionTimer();
    this.clearApprovalSettleTimer();
    this.clearPersistReceiptTimers();
    this.clearNativeAnswerRecheckTimers();
  }

  private disposeProcess(): void {
    if (!this.ptyProcess) {
      return;
    }
    if (this.userControlActive) {
      this.setUserControl(false, "pty-exit");
    }
    const proc = this.ptyProcess;
    this.ptyProcess = null;
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
    this.clearTaskReadyTimer();
    this.clearApprovalSettleTimer();
    if (this.humanSettleTimer) {
      clearTimeout(this.humanSettleTimer);
      this.humanSettleTimer = null;
    }
    this.humanLineChars = 0;
  }

  private handlePtyData(data: string): void {
    this.lastPtyDataAt = Date.now();
    this.rawTail = `${this.rawTail}${data}`.slice(-this.scrollbackLimit);
    if (this.activeRun) {
      this.activeRunRaw = `${this.activeRunRaw}${data}`.slice(-this.scrollbackLimit);
    }
    this.emitEvent("pty:data", { taskId: this.taskId, data });
    this.detectApproval();
    if (this.isHumanActivelyTyping()) {
      // While the human is typing in the terminal they may be answering a native
      // approval directly — re-check each repaint so approvalActive clears
      // promptly (continuous reconciliation; the settle pass catches a late one).
      this.clearApprovalIfAnsweredNatively();
    }
    this.detectModalPanel();
    this.scheduleTaskReadyCheck();
    this.scheduleCompletionCheck();
  }

  isModalActive(): boolean {
    return this.modalActive;
  }

  /**
   * Footer-hint detection for interactive TUI panels left open by a slash
   * passthrough. Signatures from probe screens (spikes/slash-probes):
   * Claude panels all end in "Esc to cancel/clear"; Codex panels in
   * "esc to go back/close" or "space to select". The detector only arms for
   * a window after a slash submit and never fires while the idle composer,
   * an approval screen, or an active run is visible — three independent
   * conditions against false positives from model output quoting these
   * phrases.
   */
  /**
   * The panel-open signal is positional, not structural: in the append-only
   * render stream, a panel is visible when its footer hint was rendered
   * AFTER the last composer redraw marker. detectIdlePrompt cannot serve as
   * the gate here — Claude panels draw their selection caret as "❯", which
   * that heuristic reads as an idle prompt.
   */
  private modalFooterSignature(): string | null {
    const clean = cleanTerminal(this.rawTail).slice(-MODAL_SCAN_CHARS);
    const footerRe =
      this.profile.provider === "claude" ? CLAUDE_MODAL_FOOTER_RE : CODEX_MODAL_FOOTER_RE;
    const redrawRe =
      this.profile.provider === "claude" ? CLAUDE_COMPOSER_REDRAW_RE : CODEX_COMPOSER_REDRAW_RE;
    const lastFooter = lastMatchIndex(clean, footerRe);
    if (lastFooter === -1 || lastFooter <= lastMatchIndex(clean, redrawRe)) {
      return null;
    }
    footerRe.lastIndex = lastFooter;
    const match = footerRe.exec(clean);
    footerRe.lastIndex = 0;
    return match ? match[0] : null;
  }

  private detectModalPanel(): void {
    if (this.modalActive) {
      if (
        (this.activeRun && this.activeRun.kind !== "slash") ||
        this.approvalActive ||
        this.modalFooterSignature() === null
      ) {
        this.clearModalPanel();
      }
      return;
    }
    // A slash submit records its own run (kind "slash"), so an active slash
    // run is exactly the state in which a panel can appear — only a real
    // prompt run disarms the detector.
    if ((this.activeRun && this.activeRun.kind !== "slash") || this.approvalActive) {
      this.resetAmbientModalCandidate();
      return;
    }
    const signature = this.modalFooterSignature();
    if (!signature) {
      this.resetAmbientModalCandidate();
      return;
    }
    const armedMs = Date.now() - this.lastSlashSubmitAt;
    if (this.lastSlashSubmitAt !== 0 && armedMs <= MODAL_DETECT_WINDOW_MS) {
      this.armModalPanel(signature, "slash");
      return;
    }
    // Ambient arming (startup/idle interstitials — the incident class):
    // same positional signature, but it must survive a quiescence window.
    if (
      this.ambientModalCandidate === null ||
      this.ambientModalCandidate.signature !== signature
    ) {
      this.ambientModalCandidate = { signature, sinceMs: Date.now() };
    }
    this.scheduleAmbientModalConfirm();
  }

  /** Static panels emit no further bytes (P1) — confirmation needs its own
   *  timer, re-checking the same screen rather than waiting for data. */
  private scheduleAmbientModalConfirm(): void {
    if (this.ambientModalTimer) {
      return;
    }
    this.ambientModalTimer = setTimeout(() => {
      this.ambientModalTimer = null;
      const candidate = this.ambientModalCandidate;
      if (!candidate || this.modalActive || !this.ptyProcess) {
        return;
      }
      if ((this.activeRun && this.activeRun.kind !== "slash") || this.approvalActive) {
        return;
      }
      if (Date.now() - this.lastPtyDataAt < AMBIENT_MODAL_QUIET_MS) {
        this.scheduleAmbientModalConfirm();
        return;
      }
      if (Date.now() - candidate.sinceMs < AMBIENT_MODAL_CONFIRM_MS) {
        this.scheduleAmbientModalConfirm();
        return;
      }
      const signature = this.modalFooterSignature();
      if (signature !== candidate.signature) {
        this.ambientModalCandidate = signature
          ? { signature, sinceMs: Date.now() }
          : null;
        if (signature) {
          this.scheduleAmbientModalConfirm();
        }
        return;
      }
      this.armModalPanel(signature, "ambient");
    }, AMBIENT_MODAL_CONFIRM_MS);
  }

  private resetAmbientModalCandidate(): void {
    this.ambientModalCandidate = null;
    if (this.ambientModalTimer) {
      clearTimeout(this.ambientModalTimer);
      this.ambientModalTimer = null;
    }
  }

  private armModalPanel(signature: string, origin: "slash" | "ambient"): void {
    this.modalActive = true;
    this.modalSignature = signature;
    this.modalOrigin = origin;
    this.resetAmbientModalCandidate();
    if (this.activeRun && this.activeRun.kind === "slash") {
      // The "run" ended in a panel, not output — settle it so the session
      // does not look busy while the panel waits for a human.
      this.finishActiveRun("completed", "slash command opened an interactive panel", {
        completionSource: "native-control",
        completionConfidence: "high",
      });
    }
    this.emitEvent("modal:state", {
      taskId: this.taskId,
      active: true,
      excerpt: this.cleanTail(600),
      signature,
      origin,
    });
  }

  private clearModalPanel(): void {
    if (!this.modalActive) {
      return;
    }
    this.modalActive = false;
    this.modalSignature = null;
    this.modalOrigin = null;
    this.lastSlashSubmitAt = 0;
    this.resetAmbientModalCandidate();
    this.emitEvent("modal:state", {
      taskId: this.taskId,
      active: false,
      excerpt: null,
      signature: null,
      origin: null,
    });
  }

  /**
   * Bounded Esc retries to close a detected panel. Claude's /config needs
   * two: the first Esc only clears its search filter (probe s1). Success is
   * verified structurally — the idle composer must come back.
   */
  async dismissModal(): Promise<boolean> {
    if (this.modalActive && this.modalOrigin !== "slash") {
      // Esc is only probe-verified for slash-opened panels. On ambient
      // interstitials it has side effects (resume panel: silently resumes
      // full; Codex trust: quits the process). Never offered, never sent.
      return false;
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (this.userControlActive) {
        // Single writer: the human is on the panel — never race their keys.
        return false;
      }
      if (!this.modalActive || !this.ptyProcess) {
        return true;
      }
      this.writeRaw(ESC);
      // The dismissal redraw clears modalActive through detectModalPanel
      // on incoming data; the wait gives the TUI time to repaint.
      await delay(1400);
      if (!this.modalActive) {
        return true;
      }
    }
    return !this.modalActive;
  }

  private scheduleTaskReadyCheck(): void {
    if (this.taskReady || this.activeRun || this.approvalActive || !this.ptyProcess) {
      return;
    }

    this.clearTaskReadyTimer();
    this.taskReadyTimer = setTimeout(() => this.checkTaskReady(), this.profile.taskReadyQuietMs);
  }

  private checkTaskReady(): void {
    this.taskReadyTimer = null;
    if (this.taskReady || this.activeRun || this.approvalActive || !this.ptyProcess) {
      return;
    }
    this.maybeAnnounceAcceptsInput();
    const taskAgeMs = this.startedAt ? Date.now() - this.startedAt : this.profile.taskReadyMinAgeMs;
    if (taskAgeMs < this.profile.taskReadyMinAgeMs) {
      this.taskReadyTimer = setTimeout(
        () => this.checkTaskReady(),
        this.profile.taskReadyMinAgeMs - taskAgeMs,
      );
      return;
    }
    if (Date.now() - this.lastPtyDataAt < this.profile.taskReadyQuietMs - 50) {
      this.scheduleTaskReadyCheck();
      return;
    }

    const hint = detectIdlePrompt(this.rawTail, this.profile);
    if (!hint.ready) {
      this.scheduleTaskReadyCheck();
      return;
    }

    this.markTaskReady(hint.confidence);
  }

  private detectApproval(): void {
    const approvalSource = this.activeRun ? this.activeRunRaw : this.rawTail;
    const candidate = detectApprovalCandidate(approvalSource, this.profile);
    if (!candidate || candidate.promptAfterApproval) {
      return;
    }

    if (this.approvalActive && this.lastApprovalKind === candidate.kind) {
      return;
    }

    const decisionAgeMs = this.lastApprovalDecisionAt ? Date.now() - this.lastApprovalDecisionAt : null;
    const resurfacedAfterDecision =
      Boolean(this.lastApprovalDecisionAt) &&
      Boolean(candidate.fingerprint) &&
      candidate.fingerprint === this.lastApprovalFingerprint &&
      (decisionAgeMs ?? 0) >= DEFAULT_APPROVAL_SETTLE_MS;
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
    this.lastApprovalKind = candidate.kind;
    this.lastApprovalFingerprint = candidate.fingerprint;
    this.activeApprovalOptionKeys = candidate.optionKeys ?? null;
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
    if (this.approvalActive || Date.now() - this.lastPtyDataAt < DEFAULT_APPROVAL_SETTLE_MS - 50) {
      return;
    }

    const approvalSource = this.activeRun ? this.activeRunRaw : this.rawTail;
    const candidate = detectApprovalCandidate(approvalSource, this.profile);
    if (!candidate || candidate.promptAfterApproval) {
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

  private beginRun(text: string, kind: RunKind): ActiveRun {
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
      title: trimmed.split(/\r?\n/, 1)[0]?.slice(0, 120) || "(empty prompt)",
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
    this.emitEvent("run:started", run);
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
      return;
    }

    this.clearCompletionTimer();
    this.completionTimer = setTimeout(() => this.checkCompletionHeuristic(), this.completionQuietMs);
  }

  private checkCompletionHeuristic(): void {
    this.completionTimer = null;
    if (!this.activeRun || !this.ptyProcess) {
      return;
    }
    if (this.approvalActive || this.activeRun.status !== "active") {
      return;
    }
    if (Date.now() - this.lastPtyDataAt < this.completionQuietMs - 50) {
      this.scheduleCompletionCheck();
      return;
    }

    const hint = detectIdleComposer(this.activeRunRaw, this.profile);
    if (!hint.completed) {
      this.updateActiveRun({
        lifecyclePhase: "active",
        lastLifecycleHint: hint,
      });
      return;
    }

    this.finishActiveRun("completed", "terminal idle/composer heuristic", {
      completionSource: "terminal-idle-heuristic",
      completionConfidence: hint.confidence,
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
   * Guarded exactly like the heuristic: never completes a run that is waiting on
   * an approval (status is "active" again only once the approval resolved —
   * lifecyclePhase "resumed-after-approval"), and a no-op when no Duet-owned run
   * is active (e.g. a take-over turn, or the scrape already finished it — which
   * also avoids any double-completion).
   */
  completeRunFromTurnEnd(): ActiveRun | null {
    if (!this.activeRun || this.activeRun.status !== "active" || this.approvalActive) {
      return null;
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

  private clearTaskReadyTimer(): void {
    if (!this.taskReadyTimer) {
      return;
    }
    clearTimeout(this.taskReadyTimer);
    this.taskReadyTimer = null;
  }

  private maybeAnnounceAcceptsInput(): void {
    if (this.acceptsInputAnnounced) {
      return;
    }
    const hint = detectIdlePrompt(this.rawTail, this.profile);
    if (!hint.ready || !this.acceptsPromptInput()) {
      return;
    }
    this.acceptsInputAnnounced = true;
    this.emitEvent("task:accepts-input", {
      taskId: this.taskId,
      source: "idle-prompt-structural",
      confidence: hint.confidence,
    });
  }

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

export function codexArgs(options: {
  cwd: string;
  sandbox: CodexSandboxMode;
  approval: CodexApprovalMode;
  model?: string | null | undefined;
  reasoningEffort?: ReasoningEffort | null | undefined;
  speedMode?: LaunchSpeedMode | null | undefined;
  resumeLast?: boolean;
  resumeRef?: string | undefined;
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
  return [
    ...base,
    "--no-alt-screen",
    ...(options.model?.trim() ? ["-m", options.model.trim()] : []),
    ...configOverrides,
    "-C",
    options.cwd,
    "-s",
    options.sandbox,
    "-a",
    options.approval,
  ];
}

export function claudeArgs(options: {
  permissionMode?: ClaudePermissionMode | undefined;
  model?: string | null | undefined;
  reasoningEffort?: ReasoningEffort | null | undefined;
  settingsPath?: string | null | undefined;
  resumeRef?: string | undefined;
  sessionId?: string | undefined;
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
  ];
}

function terminalProviderProfile(provider: RuntimeProvider): TerminalProviderProfile {
  if (provider === "claude") {
    return {
      provider,
      defaultCommand: "claude",
      approvalSource: "native Claude PTY approval screen",
      supportsSlashStop: false,
      taskReadyMinAgeMs: 14000,
      taskReadyQuietMs: 2500,
      activityHints: [
        "esc to interrupt",
        "esctointerrupt",
        "thinking with",
        "thinkingwith",
        "cerebrating",
        "accomplishing",
        // Claude 2.x spinner/summary glyphs ("✶ Levitating…", "✻ Baked for 2s").
        // Resumed sessions never repaint the welcome banner, so these glyphs
        // are the only working-activity signal they emit. Safe against
        // premature completion: the spinner animates while working, so the
        // completion quiet-window cannot elapse mid-run.
        "✢",
        "✳",
        "✶",
        "✻",
        "✽",
      ],
      idlePromptModelHints: /opus|sonnet|haiku|xhigh|high|medium|low|effort|~/i,
      buildArgs: (options) =>
        claudeArgs({
          permissionMode: options.permissionMode,
          model: options.model,
          reasoningEffort: options.reasoningEffort,
          settingsPath: ensureClaudeRuntimeSettings(options.cwd),
          resumeRef: options.resumeRef,
          sessionId: options.sessionId,
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
    taskReadyMinAgeMs: CODEX_TASK_READY_MIN_AGE_MS,
    taskReadyQuietMs: DEFAULT_TASK_READY_QUIET_MS,
    activityHints: ["working", "esc to interrupt"],
    idlePromptModelHints: /gpt[-\w.]*|xhigh|high|medium|low|~/i,
    buildArgs: (options) =>
      codexArgs({
        cwd: options.cwd,
        sandbox: options.sandbox ?? "read-only",
        approval: options.approval ?? "on-request",
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        speedMode: options.speedMode,
        resumeLast: Boolean(options.resumeLast),
        resumeRef: options.resumeRef,
      }),
    approvalHints: {
      fileRead: [],
      fileEdit: CODEX_FILE_EDIT_APPROVAL_HINTS,
      command: CODEX_COMMAND_APPROVAL_HINTS,
      workspaceTrust: CODEX_WORKSPACE_TRUST_APPROVAL_HINTS,
    },
    approvalEndMarkers: [],
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function codexPermissionPresetLabel(preset: CodexPermissionPreset): string {
  if (preset === "approveForMe") {
    return "Approve for me";
  }
  if (preset === "fullAccess") {
    return "Full Access";
  }
  return "Ask for approval";
}

function codexPermissionPresetIndex(preset: CodexPermissionPreset): number {
  if (preset === "approveForMe") {
    return 1;
  }
  if (preset === "fullAccess") {
    return 2;
  }
  return 0;
}

function reasoningEffortPickerLabel(effort: ReasoningEffort): string {
  if (effort === "xhigh") {
    return "Extra High";
  }
  return effort;
}

function pickerDigitForLabel(cleanText: string, targetLabel: string): string | null {
  const targetTokens = normalizedTokens(targetLabel);
  const lines = cleanText.split(/\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const segments = numberedPickerSegments(line);
    for (const segment of segments) {
      if (tokensContain(normalizedTokens(segment.text), targetTokens)) {
        return segment.digit;
      }
    }
  }
  return null;
}

function numberedPickerSegments(line: string): Array<{ digit: string; text: string }> {
  const matches = [...line.matchAll(/([1-9])[\).]\s*(?=[A-Za-z])/g)];
  const segments: Array<{ digit: string; text: string }> = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (!match) {
      continue;
    }
    const digit = match[1];
    if (!digit || match.index === undefined) {
      continue;
    }
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? line.length;
    segments.push({
      digit,
      text: line.slice(start, end),
    });
  }
  return segments;
}

export function detectClaudePermissionMode(cleanText: string): ClaudePermissionMode | null {
  // Shift+Tab cycling appends EVERY mode's banner into the stream
  // ("accept edits on" → "plan mode on" → "auto mode on" → default), so a
  // substring-anywhere test always matches the first-checked mode and
  // misreads the current one. The CURRENT mode is whatever the LAST status
  // line says. Every status line ends in the "← for agents" hint; the mode
  // banner (if any) sits just before it on the same line. So classify the
  // window immediately preceding the last composer hint. Compact away
  // spaces — cleanTerminal sometimes drops them ("auto mode on" →
  // "automodeon"). Default mode shows no banner, only the bare hint.
  const compact = cleanText.toLowerCase().replace(/[^a-z]+/g, "");
  const lastHint = compact.lastIndexOf("foragents");
  if (lastHint === -1) {
    return null;
  }
  // Isolate JUST the current status line: the span between the previous
  // hint and this one. A 60-char window would bleed into the prior line's
  // banner (which still lingers in the cycling stream).
  const prevHint = compact.lastIndexOf("foragents", lastHint - 1);
  const line = compact.slice(prevHint === -1 ? 0 : prevHint + "foragents".length, lastHint);
  if (line.includes("automodeon") || line.includes("autoon")) {
    return "auto";
  }
  if (line.includes("planmodeon") || line.includes("planmode")) {
    return "plan";
  }
  if (line.includes("accepteditson") || line.includes("acceptedits")) {
    return "acceptEdits";
  }
  return "default";
}

function normalizedTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/gpt[-\s]?/g, "gpt")
    .split(/[^a-z0-9.]+/)
    .filter(Boolean);
}

function tokensContain(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0) {
    return false;
  }
  return needle.every((token) =>
    haystack.some((candidate) => candidate === token || candidate.includes(token) || token.includes(candidate)),
  );
}

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
