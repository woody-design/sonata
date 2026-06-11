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
import { ensureClaudeStatuslineSettings } from "../usage";

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
const DEFAULT_SCROLLBACK_LIMIT = 64 * 1024;
const DEFAULT_COMPLETION_QUIET_MS = 1800;
const DEFAULT_TASK_READY_MIN_AGE_MS = 8000;
const CODEX_TASK_READY_MIN_AGE_MS = 14_000;
const DEFAULT_TASK_READY_QUIET_MS = 900;
const DEFAULT_POST_COMPLETION_ATTRIBUTION_MS = 5000;
const DEFAULT_APPROVAL_SETTLE_MS = 1200;
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
  private startedAt: number | null = null;
  private activeRun: ActiveRun | null = null;
  private runSeq = 0;
  private completionTimer: NodeJS.Timeout | null = null;
  private approvalSettleTimer: NodeJS.Timeout | null = null;
  private taskReadyTimer: NodeJS.Timeout | null = null;
  private lastPtyDataAt = 0;
  private taskReady = false;
  private recentAttributionRun: RecentAttributionRun | null = null;
  private activeRunRaw = "";

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
    this.activeRun = null;
    this.recentAttributionRun = null;
    this.activeRunRaw = "";
    this.taskReady = false;
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
      env: ptyEnvironment(),
    });

    this.ptyProcess.onData((data) => this.handlePtyData(data));
    this.ptyProcess.onExit((exit) => {
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
    for (const attachment of attachments) {
      this.ptyProcess.write(`${BRACKETED_PASTE_START}${attachment.path}${BRACKETED_PASTE_END}`);
    }
    const textDelayMs = attachments.length > 0 ? 120 : 0;
    const enterDelayMs = attachments.length > 0 ? 260 : 120;
    setTimeout(() => {
      if (this.ptyProcess && trimmed) {
        this.ptyProcess.write(`${BRACKETED_PASTE_START}${trimmed}${BRACKETED_PASTE_END}`);
      }
    }, textDelayMs);
    setTimeout(() => {
      if (this.ptyProcess) {
        this.ptyProcess.write(CSI_U_ENTER);
      }
    }, enterDelayMs);
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
    if (!this.isIdleComposerReady()) {
      await this.waitForIdleComposer(DEFAULT_CONTROL_WAIT_MS);
    }
    if (!this.isIdleComposerReady()) {
      throw new Error("Cannot change controls until the provider composer is idle.");
    }

    const evidence =
      this.profile.provider === "codex"
        ? await this.applyCodexControlChange(change)
        : await this.applyClaudeControlChange(change);
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
    this.sendPositiveApproval("approve", CSI_U_ENTER, "CSI-u Enter");
  }

  sendApproveForSession(): void {
    this.sendPositiveApproval(
      "approve-for-session",
      `${ARROW_DOWN}${CSI_U_ENTER}`,
      "ArrowDown + CSI-u Enter",
    );
  }

  private sendPositiveApproval(
    decision: Extract<ApprovalDecision, "approve" | "approve-for-session">,
    keySequence: string,
    encodedAs: ApprovalDecisionEncoding,
  ): void {
    const decisionAt = Date.now();
    const previousKind = this.lastApprovalKind;
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
    this.scheduleApprovalSettleCheck(decisionAt);
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
    this.clearApprovalSettleTimer();
  }

  async stopRun(options: { inspectDelayMs?: number; forceSlashStop?: boolean } = {}): Promise<void> {
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
    this.disposeProcess();
    this.stopFileWatcher();
    this.clearCompletionTimer();
    this.clearApprovalSettleTimer();
  }

  private disposeProcess(): void {
    if (!this.ptyProcess) {
      return;
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
  }

  private handlePtyData(data: string): void {
    this.lastPtyDataAt = Date.now();
    this.rawTail = `${this.rawTail}${data}`.slice(-this.scrollbackLimit);
    if (this.activeRun) {
      this.activeRunRaw = `${this.activeRunRaw}${data}`.slice(-this.scrollbackLimit);
    }
    this.emitEvent("pty:data", { taskId: this.taskId, data });
    this.detectApproval();
    this.scheduleTaskReadyCheck();
    this.scheduleCompletionCheck();
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
}): string[] {
  return [
    ...(options.resumeRef ? ["--resume", options.resumeRef] : []),
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
          settingsPath: ensureClaudeStatuslineSettings(options.cwd),
          resumeRef: options.resumeRef,
        }),
      approvalHints: {
        fileRead: CLAUDE_FILE_READ_APPROVAL_HINTS,
        fileEdit: CLAUDE_FILE_EDIT_APPROVAL_HINTS,
        command: CLAUDE_COMMAND_APPROVAL_HINTS,
        workspaceTrust: CLAUDE_WORKSPACE_TRUST_APPROVAL_HINTS,
      },
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

function detectClaudePermissionMode(cleanText: string): ClaudePermissionMode | null {
  const tail = cleanText.toLowerCase().slice(-1800);
  const compact = tail.replace(/[^a-z]+/g, "");
  if (compact.includes("accepted") || (compact.includes("accept") && compact.includes("edi"))) {
    return "acceptEdits";
  }
  if (compact.includes("planmod") || compact.includes("planmode") || compact.includes("plan")) {
    return "plan";
  }
  if (compact.includes("automode") || compact.includes("autoon")) {
    return "auto";
  }
  if (compact.includes("default")) {
    return "default";
  }
  if ((compact.includes("shifttab") || compact.includes("cycle")) && !compact.includes("accept") && !compact.includes("plan") && !compact.includes("auto")) {
    return "default";
  }
  return null;
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

function ptyEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return {
    ...env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
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
  };
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
