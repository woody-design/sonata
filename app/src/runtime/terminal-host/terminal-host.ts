import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import * as pty from "node-pty";
import type {
  ApprovalKind,
  CompletionConfidence,
  CompletionSource,
  RunId,
  RunKind,
  RunStatus,
  TaskId,
} from "../../shared/types/domain";
import type { RuntimeEvent, RunUpdatedEvent } from "../../shared/types/events";

export const BRACKETED_PASTE_START = "\x1b[200~";
export const BRACKETED_PASTE_END = "\x1b[201~";
export const CSI_U_ENTER = "\x1b[13u";
export const ESC = "\x1b";

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

const DEFAULT_ROWS = 36;
const DEFAULT_COLS = 120;
const DEFAULT_SCROLLBACK_LIMIT = 64 * 1024;
const DEFAULT_COMPLETION_QUIET_MS = 1800;
const DEFAULT_TASK_READY_MIN_AGE_MS = 8000;
const DEFAULT_TASK_READY_QUIET_MS = 900;
const DEFAULT_POST_COMPLETION_ATTRIBUTION_MS = 5000;

const FILE_EDIT_APPROVAL_HINTS = [
  "would you like to make the following edits",
  "don't ask again for these files",
  "press enter to confirm",
];

const COMMAND_APPROVAL_HINTS = [
  "would you like to run the following command",
  "don't ask again for commands that start with",
  "press enter to confirm",
];

const WORKSPACE_TRUST_APPROVAL_HINTS = [
  "do you trust the contents of this directory",
  "trusting the directory",
  "press enter to continue",
];

const BACKGROUND_TERMINAL_HINTS = [
  "background terminal",
  "background terminals",
  "still running",
  "running in the background",
  "use /stop",
];

export interface TerminalHostOptions {
  taskId: TaskId;
  defaultWorkspace: string;
  eventSink?: (event: RuntimeEvent) => void;
  scrollbackLimit?: number;
  completionQuietMs?: number;
  postCompletionAttributionMs?: number;
}

export interface StartTaskOptions {
  cwd?: string;
  command?: string;
  args?: string[];
  sandbox?: "read-only" | "workspace-write";
  approval?: "never" | "on-request";
  resumeLast?: boolean;
  cols?: number;
  rows?: number;
}

export interface StartedPty {
  pid: number;
  cwd: string;
  command: string;
  args: string[];
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

type ActiveRun = RunUpdatedEvent["payload"];

export class TerminalHost extends EventEmitter {
  private readonly taskId: TaskId;
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
  private startedAt: number | null = null;
  private activeRun: ActiveRun | null = null;
  private runSeq = 0;
  private completionTimer: NodeJS.Timeout | null = null;
  private taskReadyTimer: NodeJS.Timeout | null = null;
  private lastPtyDataAt = 0;
  private taskReady = false;
  private recentAttributionRun: RecentAttributionRun | null = null;
  private activeRunRaw = "";

  constructor(options: TerminalHostOptions) {
    super();
    this.taskId = options.taskId;
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
    this.activeRun = null;
    this.recentAttributionRun = null;
    this.activeRunRaw = "";
    this.taskReady = false;
    this.clearCompletionTimer();
    this.clearTaskReadyTimer();
    this.startFileWatcher(cwd);

    const command = options.command ?? "codex";
    const args = Array.isArray(options.args)
      ? options.args
      : codexArgs({
          cwd,
          sandbox: options.sandbox ?? "read-only",
          approval: options.approval ?? "on-request",
          resumeLast: Boolean(options.resumeLast),
        });
    const cols = Number(options.cols) || DEFAULT_COLS;
    const rows = Number(options.rows) || DEFAULT_ROWS;

    this.ptyProcess = pty.spawn(command, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      },
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

  submitPrompt(text: string, options: { createRun?: boolean } = {}): void {
    if (!text.trim()) {
      return;
    }
    if (!this.ptyProcess) {
      throw new Error("No PTY process is running.");
    }

    const kind: RunKind = text.trim().startsWith("/") ? "slash" : "prompt";
    const run = options.createRun === false ? null : this.beginRun(text, kind);

    this.approvalActive = false;
    this.lastApprovalKind = null;
    this.ptyProcess.write(`${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`);
    setTimeout(() => {
      if (this.ptyProcess) {
        this.ptyProcess.write(CSI_U_ENTER);
      }
    }, 120);
    this.emitEvent("prompt:submitted", {
      taskId: this.taskId,
      runId: run ? run.id : this.activeRun ? this.activeRun.id : null,
      kind,
      chars: text.length,
    });
  }

  sendApprove(): void {
    this.writeRaw(CSI_U_ENTER);
    this.emitEvent("approval:decision", {
      taskId: this.taskId,
      runId: this.activeRun ? this.activeRun.id : null,
      decision: "approve",
      encodedAs: "CSI-u Enter",
      previousKind: this.lastApprovalKind,
    });
    this.updateActiveRun({
      status: "active",
      lifecyclePhase: "resumed-after-approval",
      approvalDecision: "approve",
      approvalKind: this.lastApprovalKind ?? "unknown",
    });
    this.approvalActive = false;
  }

  sendDeny(): void {
    this.writeRaw(ESC);
    this.emitEvent("approval:decision", {
      taskId: this.taskId,
      runId: this.activeRun ? this.activeRun.id : null,
      decision: "deny",
      encodedAs: "Esc",
      previousKind: this.lastApprovalKind,
    });
    this.updateActiveRun({
      status: "approval-denied",
      lifecyclePhase: "approval-denied",
      approvalDecision: "deny",
      approvalKind: this.lastApprovalKind ?? "unknown",
    });
    this.finishActiveRun("approval-denied", "Esc denied native approval", {
      completionSource: "native-control",
      completionConfidence: "high",
    });
    this.approvalActive = false;
  }

  async stopRun(options: { inspectDelayMs?: number; forceSlashStop?: boolean } = {}): Promise<void> {
    this.writeRaw(ESC);
    this.updateActiveRun({ status: "stopping", lifecyclePhase: "stopping" });
    this.emitEvent("run:stop-requested", {
      taskId: this.taskId,
      runId: this.activeRun ? this.activeRun.id : null,
      phase: "interrupt",
      encodedAs: "Esc",
    });

    await delay(Number(options.inspectDelayMs) || 900);

    const shouldSubmitSlashStop =
      Boolean(options.forceSlashStop) ||
      this.hasBackgroundTerminalHint() ||
      this.activeRun?.approvalKind === "command";
    if (shouldSubmitSlashStop && this.ptyProcess) {
      this.submitPrompt("/stop", { createRun: false });
    }

    this.emitEvent("run:stopped", {
      taskId: this.taskId,
      runId: this.activeRun ? this.activeRun.id : null,
      interruptSent: true,
      slashStopSent: shouldSubmitSlashStop,
      slashStopReason: shouldSubmitSlashStop
        ? "background terminal hint detected, command approval was active, or forceSlashStop requested"
        : "no background terminal hint detected in recent terminal output",
    });
    this.finishActiveRun("stopped", shouldSubmitSlashStop ? "Esc + /stop" : "Esc", {
      completionSource: "native-control",
      completionConfidence: "high",
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
    this.ptyProcess.resize(Number(cols) || DEFAULT_COLS, Number(rows) || DEFAULT_ROWS);
  }

  dispose(): void {
    this.clearTaskReadyTimer();
    this.disposeProcess();
    this.stopFileWatcher();
    this.clearCompletionTimer();
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
    this.taskReadyTimer = setTimeout(() => this.checkTaskReady(), DEFAULT_TASK_READY_QUIET_MS);
  }

  private checkTaskReady(): void {
    this.taskReadyTimer = null;
    if (this.taskReady || this.activeRun || this.approvalActive || !this.ptyProcess) {
      return;
    }
    const taskAgeMs = this.startedAt ? Date.now() - this.startedAt : DEFAULT_TASK_READY_MIN_AGE_MS;
    if (taskAgeMs < DEFAULT_TASK_READY_MIN_AGE_MS) {
      this.taskReadyTimer = setTimeout(
        () => this.checkTaskReady(),
        DEFAULT_TASK_READY_MIN_AGE_MS - taskAgeMs,
      );
      return;
    }
    if (Date.now() - this.lastPtyDataAt < DEFAULT_TASK_READY_QUIET_MS - 50) {
      this.scheduleTaskReadyCheck();
      return;
    }

    const hint = detectIdlePrompt(this.rawTail);
    if (!hint.ready) {
      return;
    }

    this.taskReady = true;
    this.emitEvent("task:ready", {
      taskId: this.taskId,
      source: "terminal-idle-composer-heuristic",
      confidence: hint.confidence,
    });
  }

  private detectApproval(): void {
    const approvalSource = this.activeRun ? this.activeRunRaw : this.rawTail;
    const recent = cleanTerminal(approvalSource).toLowerCase();
    const compactRecent = compactText(recent);
    const hasConfirmPrompt = compactRecent.includes(compactText("press enter to confirm"));
    const hasContinuePrompt = compactRecent.includes(compactText("press enter to continue"));
    const fileEdit =
      hasConfirmPrompt &&
      (compactRecent.includes(compactText("would you like to make the following edits")) ||
        compactRecent.includes(compactText("don't ask again for these files")));
    const command =
      hasConfirmPrompt &&
      (compactRecent.includes(compactText("would you like to run the following command")) ||
        compactRecent.includes(compactText("don't ask again for commands that start with")));
    const workspaceTrust =
      hasContinuePrompt &&
      (compactRecent.includes(compactText("do you trust the contents of this directory")) ||
        compactRecent.includes(compactText("trusting the directory")));

    if (!fileEdit && !command && !workspaceTrust) {
      return;
    }

    const kind: ApprovalKind = command ? "command" : fileEdit ? "file-edit" : "workspace-trust";
    if (this.approvalActive && this.lastApprovalKind === kind) {
      return;
    }

    const fingerprint = approvalFingerprint(kind, compactRecent);
    if (fingerprint && fingerprint === this.lastApprovalFingerprint) {
      return;
    }

    this.approvalActive = true;
    this.lastApprovalKind = kind;
    this.lastApprovalFingerprint = fingerprint;
    this.updateActiveRun({
      status: "waiting-for-approval",
      lifecyclePhase: "waiting-for-approval",
      approvalKind: kind,
    });
    this.emitEvent("approval:detected", {
      taskId: this.taskId,
      runId: this.activeRun ? this.activeRun.id : null,
      kind,
      source: "native Codex PTY approval screen",
    });
  }

  private hasBackgroundTerminalHint(): boolean {
    const recent = cleanTerminal(this.rawTail).toLowerCase();
    return BACKGROUND_TERMINAL_HINTS.some((hint) => recent.includes(hint));
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
    metadata: { completionSource?: CompletionSource; completionConfidence?: CompletionConfidence; completionHint?: unknown } = {},
  ): ActiveRun | null {
    if (!this.activeRun) {
      return null;
    }

    const endedAt = new Date();
    const finished: ActiveRun = removeUndefined({
      ...this.activeRun,
      status,
      statusReason: reason,
      lifecyclePhase: status,
      completionSource: metadata.completionSource ?? completionSourceForStatus(status),
      completionConfidence: metadata.completionConfidence ?? completionConfidenceForStatus(status),
      completionHint: metadata.completionHint,
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

    const hint = detectIdleComposer(this.activeRunRaw);
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

  private clearTaskReadyTimer(): void {
    if (!this.taskReadyTimer) {
      return;
    }
    clearTimeout(this.taskReadyTimer);
    this.taskReadyTimer = null;
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
  sandbox: "read-only" | "workspace-write";
  approval: "never" | "on-request";
  resumeLast?: boolean;
}): string[] {
  const base = options.resumeLast ? ["resume", "--last"] : [];
  return [
    ...base,
    "--no-alt-screen",
    "-C",
    options.cwd,
    "-s",
    options.sandbox,
    "-a",
    options.approval,
  ];
}

export function cleanTerminal(text: string): string {
  return text
    .replace(ANSI_RE, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(CONTROL_RE, "");
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

function detectIdleComposer(rawText: string): {
  completed: boolean;
  source: "terminal-idle-heuristic";
  confidence: CompletionConfidence;
  signals: {
    promptAfterWorking: boolean;
    promptAfterApproval: boolean;
    hasModelOrCwdHint: boolean;
  };
} {
  const hint = detectIdlePrompt(rawText);
  const recent = cleanTerminal(rawText).slice(-8000);
  const lowered = recent.toLowerCase();
  const lastWorking = Math.max(lowered.lastIndexOf("working"), lowered.lastIndexOf("esc to interrupt"));
  const completed =
    hint.lastPromptIndex >= 0 &&
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

function detectIdlePrompt(rawText: string): {
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
  const lastAnyPrompt = Math.max(lastPrompt, lastCodexPrompt);
  const lastApproval = Math.max(
    lowered.lastIndexOf("would you like to make the following edits"),
    lowered.lastIndexOf("would you like to run the following command"),
    lowered.lastIndexOf("do you trust the contents of this directory"),
    lowered.lastIndexOf("press enter to confirm"),
    lowered.lastIndexOf("press enter to continue"),
  );
  const promptTail = lastAnyPrompt >= 0 ? recent.slice(lastAnyPrompt, lastAnyPrompt + 700) : "";
  const hasModelOrCwdHint = /gpt[-\w.]*|xhigh|high|medium|low|~/i.test(promptTail);
  const ready = lastAnyPrompt >= 0 && lastAnyPrompt > lastApproval;

  return {
    ready,
    confidence: ready && hasModelOrCwdHint ? "medium" : "low",
    lastPromptIndex: lastAnyPrompt,
    promptAfterApproval: lastAnyPrompt >= 0 && lastAnyPrompt > lastApproval,
    hasModelOrCwdHint,
  };
}

function approvalFingerprint(kind: ApprovalKind, compactRecent: string): string | null {
  const startNeedles =
    kind === "command"
      ? [
          compactText("would you like to run the following command"),
          compactText("don't ask again for commands that start with"),
        ]
      : kind === "workspace-trust"
        ? [
            compactText("do you trust the contents of this directory"),
            compactText("trusting the directory"),
          ]
        : [
            compactText("would you like to make the following edits"),
            compactText("don't ask again for these files"),
          ];
  const endNeedle =
    kind === "workspace-trust"
      ? compactText("press enter to continue")
      : compactText("press enter to confirm");
  const startIndex = maxLastIndexOf(compactRecent, startNeedles);
  if (startIndex < 0) {
    return null;
  }
  const endIndex = compactRecent.indexOf(endNeedle, startIndex);
  const stableEnd = endIndex >= 0 ? endIndex + endNeedle.length : startIndex + 1600;
  return `${kind}:${compactRecent.slice(startIndex, stableEnd)}`;
}

function maxLastIndexOf(value: string, needles: string[]): number {
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

function redactPath(value: string): string {
  return value.replace(os.homedir(), "~");
}

function removeUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
