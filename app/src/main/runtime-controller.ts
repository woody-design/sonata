import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import type {
  DeliveryAttachment,
  ReferenceResult,
  ArtifactCandidate,
  ApprovalDecision,
  ApprovalKind,
  ApprovalChoice,
  ClaudePermissionMode,
  CodexApprovalMode,
  CodexSandboxMode,
  CreateTaskRequest,
  CreateTaskResponse,
  LaunchSpeedMode,
  OpenTaskRequest,
  ReadSessionIndexRequest,
  ReadSlashCommandsRequest,
  ReadTranscriptResponse,
  ReasoningEffort,
  RunId,
  RunStatus,
  RuntimeEvent,
  RuntimeProvider,
  RuntimeReportUpdatedEvent,
  SessionIndexResponse,
  SessionSnapshotResponse,
  SlashCommandsResponse,
  Task,
  TaskId,
  UsageSnapshot,
  WorkspaceFilePreviewResponse,
  WorkspaceTreeEntry,
} from "../shared/types";
import { TaskNotFoundError } from "./errors";
import {
  TRANSCRIPT_SOURCES_SCHEMA_ID,
  TRANSCRIPT_SOURCES_SCHEMA_VERSION,
  type TranscriptSourceRef,
  type TranscriptSourcesFileV1,
} from "../shared/types/transcript";
import {
  freshTaskManifestV1,
  TASK_MANIFEST_SCHEMA_ID,
  TASK_MANIFEST_SCHEMA_VERSION,
  type RuntimeReportV1,
  type TaskManifestV1,
} from "../shared/schemas";
import {
  ArtifactPreview,
  DeliveryController,
  ProviderTranscript,
  RunIndex,
  isRunIndexEvent,
  resolveRunForTurn,
  TerminalHost,
  type StartTaskOptions,
  WorkspacePreview,
  ClaudeStatuslineUsageWatcher,
  ClaudeHookWatcher,
  ClaudeApprovalWatcher,
  writeApprovalReply,
  type ApprovalAsk,
  CliStateModel,
  parseClaudeStatuslinePayload,
  parseOptionPrompt,
  reconcileOptionPromptAnswers,
  optionPromptAnswerSequence,
  readClaudeResumeStats,
  StatusRegionTracker,
} from "../runtime";
import { buildSessionIndex } from "./session-index";
import { ensureClaudeProjectTrust, updateClaudeConfig } from "./claude-config";
import {
  projectRecordRoot,
  projectsDataDir,
  runtimeDir,
  attachmentsRootForTask,
} from "./duet-paths";
import { listSlashCommands as discoverSlashCommands } from "./skills-discovery";
import type { ProjectsStore } from "./projects-store";
import type { ResumeSettingsStore, ClaudeSettingsStore } from "./settings-store";
import type { ClaudeSettings } from "../shared/types/claude-settings";
import type { ClaudeHookPayload, CliStateSnapshot } from "../shared/types/cli-signal";
import type { OptionPrompt } from "../shared/types/option-prompt";
import {
  RESUME_PROMPT_MIN_IDLE_MS,
  RESUME_PROMPT_MIN_TOKENS,
  type ResumeSettings,
} from "../shared/types/resume-settings";
import type {
  PrepareResumeResponse,
  RemoteControlInjectResponse,
  ResumeSettingsResponse,
  RevertResumeBridgeResponse,
  TerminalReplaySnapshot,
} from "../shared/types/ipc";
import os from "node:os";

const DEFAULT_TASK_TITLE = "New Task";
const AUTO_TITLE_PLACEHOLDERS = new Set(["New Task", "Walking Skeleton Task"]);
// Undocumented but botmux-proven per-process levers (research §2.1). Both
// force the full-session path, which is exactly what we want: the panel
// never renders in the hidden PTY; Duet owns the choice. Version-fragile —
// the ambient modal detector (slice B) remains the net if they drift.
const RESUME_PANEL_SUPPRESS_ENV: Record<string, string> = {
  CLAUDE_CODE_RESUME_THRESHOLD_MINUTES: "999999999",
  CLAUDE_CODE_RESUME_TOKEN_THRESHOLD: "999999999",
};
const SUPPORTED_PROVIDERS = new Set<RuntimeProvider>(["codex", "claude"]);
const REASONING_EFFORTS = new Set<ReasoningEffort>(["low", "medium", "high", "xhigh", "max"]);
const CODEX_SANDBOX_MODES = new Set<CodexSandboxMode>([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
const CODEX_APPROVAL_MODES = new Set<CodexApprovalMode>(["never", "on-request"]);
const CLAUDE_PERMISSION_MODES = new Set<ClaudePermissionMode>([
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "default",
  "dontAsk",
  "plan",
]);

interface RuntimeControllerOptions {
  sendEvent: (event: RuntimeEvent) => void;
  projectsStore: ProjectsStore;
  resumeSettingsStore: ResumeSettingsStore;
  claudeSettingsStore: ClaudeSettingsStore;
}

interface ActiveTaskRuntime {
  task: Task;
  storageRoot: string;
  terminalHost: TerminalHost;
  runIndex: RunIndex;
  reportPath: string;
  runtime: ReturnType<TerminalHost["startTask"]>;
  providerTranscript: ProviderTranscript;
  deliveryController: DeliveryController;
  statusTracker: StatusRegionTracker;
  cliState: CliStateModel;
  /** A native AskUserQuestion awaiting an answer (Slice 5). Tracked so the
   *  controller can answer it, bound-check the selection, and emit a
   *  cancellation when the turn ends or the PTY exits unanswered. */
  pendingOptionPrompt: OptionPrompt | null;
  /** Last automatically applied title (run prompt or provider session
   *  name). null = unknown provenance (e.g. reopened task) → never
   *  auto-rename. A user rename makes title diverge from this. */
  autoTitle: string | null;
}

export class RuntimeController {
  private readonly sendEvent: (event: RuntimeEvent) => void;
  private readonly projectsStore: ProjectsStore;
  private readonly resumeSettingsStore: ResumeSettingsStore;
  private readonly claudeSettingsStore: ClaudeSettingsStore;
  private readonly claudeUsageWatcher: ClaudeStatuslineUsageWatcher;
  private readonly claudeHookWatcher: ClaudeHookWatcher;
  private readonly claudeApprovalWatcher: ClaudeApprovalWatcher;
  /** Live hook-broker approvals awaiting a card answer, keyed by broker id →
   *  the task + payload needed to build the reply decision, plus the
   *  detected event built ONCE at ask arrival (its ts/runId are the honest
   *  arrival-time facts; re-sent verbatim when the card's turn comes). */
  private readonly pendingBrokerApprovals = new Map<
    string,
    { taskId: TaskId; payload: ClaudeHookPayload; event: RuntimeEvent }
  >();
  /** Per task, the broker approvalId whose card is currently shown — enforces
   *  one card at a time; the rest queue (P3). */
  private readonly shownBrokerApproval = new Map<TaskId, string>();
  private readonly taskRuntimes = new Map<TaskId, ActiveTaskRuntime>();
  private readonly usageSnapshots = new Map<TaskId, UsageSnapshot>();
  private readonly pendingClaudeUsage = new Map<string, UsageSnapshot>();
  private taskSeq = 0;
  private attachmentSeq = 0;

  constructor(options: RuntimeControllerOptions) {
    this.sendEvent = options.sendEvent;
    this.projectsStore = options.projectsStore;
    this.resumeSettingsStore = options.resumeSettingsStore;
    this.claudeSettingsStore = options.claudeSettingsStore;
    this.claudeUsageWatcher = new ClaudeStatuslineUsageWatcher({
      onPayload: (payload, _filePath, mtimeMs) =>
        this.handleClaudeStatuslinePayload(payload, mtimeMs),
      onError: (error, filePath) => {
        console.debug(
          `[usage] skipped Claude statusline payload${filePath ? ` ${filePath}` : ""}: ${error.message}`,
        );
      },
    });
    this.claudeHookWatcher = new ClaudeHookWatcher({
      onPayload: (payload, workspace) => this.handleClaudeHookPayload(payload, workspace),
      onError: (error, filePath) => {
        console.debug(
          `[signal] skipped Claude hook payload${filePath ? ` ${filePath}` : ""}: ${error.message}`,
        );
      },
    });
    this.claudeApprovalWatcher = new ClaudeApprovalWatcher({
      onAsk: (ask, workspace) => this.handleApprovalAsk(ask, workspace),
      onExpired: (id, workspace) => this.handleApprovalExpired(id, workspace),
      onError: (error, filePath) => {
        console.debug(
          `[approval] skipped broker file${filePath ? ` ${filePath}` : ""}: ${error.message}`,
        );
      },
    });
  }

  createTask(request: CreateTaskRequest): CreateTaskResponse {
    assertSupportedProvider(request.provider);

    const now = new Date().toISOString();
    const taskId = this.nextTaskId();
    const title = request.title?.trim() || DEFAULT_TASK_TITLE;
    // Duet's own records live under ~/.duet (hidden, Duet-owned), keyed by taskId
    // and fully decoupled from where the agent works. providerCwd is the user's
    // work: a chosen folder, or — for a project-less session — a VISIBLE generated
    // workspace (D7), never the hidden record dir.
    const storageRoot = projectRecordRoot(taskId);
    const autoWorkspace = !request.cwd;
    const providerCwd = request.cwd
      ? path.resolve(request.cwd)
      : this.autoWorkspacePath(taskId);
    const reportPath = runtimeReportPath(storageRoot);
    // The record dir always; the generated workspace must exist before the PTY
    // spawns (a chosen folder already does).
    fs.mkdirSync(storageRoot, { recursive: true });
    if (autoWorkspace) {
      fs.mkdirSync(providerCwd, { recursive: true });
    }
    if (request.provider === "claude") {
      // Trust pre-write (two-window contract §2, S4): every cwd a task can be
      // born with was designated by the user in Duet's own UI — picked in the
      // folder dialog, chosen from recents / a project row, carried over as
      // the last-used folder — or is the auto workspace Duet itself just
      // created (trustworthy by construction: it is empty). That gesture IS
      // the trust grant (Woody, 2026-07-02: all four sources count), so the
      // native dialog is pre-answered instead of mirrored. Resume/reopen adds
      // no fresh gesture and does NOT pre-write (reopenTask) — its folder was
      // granted when the session was first created. On any failure the write
      // degrades to a no-op and the native dialog simply appears (the scrape
      // fallback answers it, as before S4).
      const trust = ensureClaudeProjectTrust(providerCwd);
      console.debug(
        `[trust] pre-write ${trust.reason}${trust.backupCreated ? " (backup created)" : ""}: ${trust.projectKey}`,
      );
    }
    const launchSettings = normalizeLaunchSettings(request.provider, request);
    // New Claude sessions inherit the Duet-owned default permission mode
    // (Settings → Approvals) unless the request names one explicitly. This
    // is the "set it once" that keeps a trusted session from prompting on
    // every tool call.
    const permissionModeRequest =
      request.provider === "claude" && request.permissionMode == null
        ? { ...request, permissionMode: this.claudeSettingsStore.read().defaultPermissionMode }
        : request;
    const permissionSettings = normalizePermissionSettings(
      request.provider,
      permissionModeRequest,
    );

    if (request.cwd) {
      this.projectsStore.noteFolderUsed(providerCwd);
    }

    const task: Task = {
      id: taskId,
      title,
      provider: request.provider,
      model: launchSettings.model,
      reasoningEffort: launchSettings.reasoningEffort,
      speedMode: launchSettings.speedMode,
      sandbox: permissionSettings.sandbox,
      approval: permissionSettings.approval,
      permissionMode: permissionSettings.permissionMode,
      runtimeSessionId: `runtime-${taskId}`,
      providerSessionRef: null,
      providerCwd,
      workingDirectory: providerCwd,
      autoWorkspace,
      status: "starting",
      createdAt: now,
      updatedAt: now,
    };

    const runIndex = new RunIndex({ taskId, reportPath });
    // Pin a fresh Claude session to an id we choose, so the Task's binding is
    // known at birth — discovery confirms this exact id instead of guessing
    // the newest jsonl in the cwd (which silently rebinds when several
    // sessions share a folder). mtime fallback stays on for safety.
    const pinnedSessionId = request.provider === "claude" ? randomUUID() : undefined;
    const providerTranscript = this.createProviderTranscript(
      taskId,
      request.provider,
      providerCwd,
      runIndex,
      { expectedSessionId: pinnedSessionId ?? null, allowMtimeFallback: true },
    );
    const terminalHost = new TerminalHost({
      taskId,
      provider: request.provider,
      defaultWorkspace: providerCwd,
      eventSink: (event) => this.handleRuntimeEvent(event, runIndex),
    });
    const deliveryController = new DeliveryController({
      taskId,
      provider: request.provider,
      terminalHost,
      eventSink: (event) => this.sendEvent(event),
      hasLiveTranscriptSource: () => providerTranscript.hasLiveSource(),
    });
    const statusTracker = new StatusRegionTracker({
      taskId,
      provider: request.provider,
      eventSink: (event) => this.sendEvent(event),
    });
    const cliState = new CliStateModel((snapshot) => this.emitCliState(taskId, snapshot));

    const ptyStartedAt = new Date().toISOString();
    const runtime = terminalHost.startTask(
      this.buildStartOptions({
        provider: request.provider,
        taskId,
        cwd: providerCwd,
        model: launchSettings.model,
        reasoningEffort: launchSettings.reasoningEffort,
        speedMode: launchSettings.speedMode,
        permissionSettings,
        remoteControl: Boolean(request.remoteControl),
        sessionId: pinnedSessionId ?? null,
        rows: request.rows,
        cols: request.cols,
      }),
    );

    const runningTask: Task = {
      ...task,
      status: "running",
      updatedAt: new Date().toISOString(),
    };
    const activeTask: ActiveTaskRuntime = {
      task: runningTask,
      storageRoot,
      terminalHost,
      runIndex,
      reportPath,
      runtime,
      providerTranscript,
      deliveryController,
      statusTracker,
      cliState,
      pendingOptionPrompt: null,
      autoTitle: null,
    };
    this.taskRuntimes.set(activeTask.task.id, activeTask);
    this.watchClaudeUsage(activeTask);
    this.watchClaudeHooks(activeTask);
    this.persistTaskManifest(activeTask.task, activeTask.storageRoot);
    providerTranscript.startDiscovery(ptyStartedAt);

    return {
      task: activeTask.task,
      runtime,
    };
  }

  openTask(request: OpenTaskRequest): CreateTaskResponse {
    const storageRoot = this.resolveOpenTaskStorageRoot(request);
    const manifest = this.readTaskManifest(storageRoot);
    if (request.taskId && manifest.task.id !== request.taskId) {
      throw new Error("Task manifest does not match the requested taskId.");
    }
    const existing = this.taskRuntimes.get(manifest.task.id);
    if (existing) {
      this.emitReportUpdated(existing.runIndex);
      return {
        task: existing.task,
        runtime: existing.runtime,
      };
    }

    // Native resume by default: the chain tip is the latest persisted
    // source whose file still exists (readTranscriptSources filters
    // missing files). When the provider session is gone we fall back to
    // a fresh spawn in the same folder — history stays readable, and the
    // caller is told via resumedProviderSession so it can say so.
    const persistedSources = this.readTranscriptSources(storageRoot);
    const resumeRef =
      request.resume === false ? null : (persistedSources.at(-1)?.providerSessionId ?? null);

    const providerCwd = taskProviderCwd(manifest.task, storageRoot);
    const task = normalizeTaskForProviderCwd(manifest.task, providerCwd);
    const permissionSettings = normalizePermissionSettings(task.provider, {
      sandbox: request.sandbox ?? task.sandbox,
      approval: request.approval ?? task.approval,
      permissionMode: request.permissionMode ?? task.permissionMode,
    });
    const runningTask = {
      ...task,
      sandbox: permissionSettings.sandbox,
      approval: permissionSettings.approval,
      permissionMode: permissionSettings.permissionMode,
      status: "running" as const,
      updatedAt: new Date().toISOString(),
      // A no-resume reopen (session gone, or resume explicitly off) starts a
      // genuinely new session. Void the dead binding so discovery's
      // first-establish writes the fresh id cleanly — otherwise the CAS guard
      // reads the stale non-null ref, mistakes the new session for a hijack,
      // and keeps pointing at the gone session.
      ...(resumeRef ? {} : { providerSessionRef: null }),
    };
    const reportPath = runtimeReportPath(storageRoot);
    const runIndex = new RunIndex({
      taskId: runningTask.id,
      reportPath,
      loadExisting: true,
    });
    // Resume: discovery must confirm the resumed id by identity and never
    // fall back to the freshest jsonl — that fallback is exactly how a
    // hand-driven /resume to a sibling conversation hijacked the binding.
    // No-resume reopen (session gone / resume disabled) pins a fresh id.
    const pinnedSessionId =
      !resumeRef && runningTask.provider === "claude" ? randomUUID() : undefined;
    const providerTranscript = this.createProviderTranscript(
      runningTask.id,
      runningTask.provider,
      providerCwd,
      runIndex,
      {
        expectedSessionId: resumeRef ?? pinnedSessionId ?? null,
        allowMtimeFallback: !resumeRef,
      },
    );
    const terminalHost = new TerminalHost({
      taskId: runningTask.id,
      provider: runningTask.provider,
      defaultWorkspace: providerCwd,
      eventSink: (event) => this.handleRuntimeEvent(event, runIndex),
    });
    const deliveryController = new DeliveryController({
      taskId: runningTask.id,
      provider: runningTask.provider,
      terminalHost,
      eventSink: (event) => this.sendEvent(event),
      hasLiveTranscriptSource: () => providerTranscript.hasLiveSource(),
    });
    const statusTracker = new StatusRegionTracker({
      taskId: runningTask.id,
      provider: runningTask.provider,
      eventSink: (event) => this.sendEvent(event),
    });
    const cliState = new CliStateModel((snapshot) => this.emitCliState(runningTask.id, snapshot));

    // Duet owns the resume moment (slice C): the interstitial is suppressed
    // per-spawn for every Claude resume — the choice happened (or the
    // policy applied) BEFORE the spawn, in Duet's own UI, from Duet's own
    // numbers. Per-spawn env, never a ~/.claude.json write.
    const claudeResume = runningTask.provider === "claude" && Boolean(resumeRef);
    const ptyStartedAt = new Date().toISOString();
    const runtime = terminalHost.startTask(
      this.buildStartOptions({
        provider: runningTask.provider,
        taskId: runningTask.id,
        cwd: providerCwd,
        model: runningTask.model,
        reasoningEffort: runningTask.reasoningEffort,
        speedMode: runningTask.speedMode,
        permissionSettings,
        remoteControl: Boolean(request.remoteControl),
        resumeRef,
        sessionId: pinnedSessionId ?? null,
        ...(claudeResume ? { extraEnv: RESUME_PANEL_SUPPRESS_ENV } : {}),
        rows: request.rows,
        cols: request.cols,
      }),
    );

    const activeTask = {
      task: runningTask,
      storageRoot,
      terminalHost,
      runIndex,
      reportPath,
      runtime,
      providerTranscript,
      deliveryController,
      statusTracker,
      cliState,
      pendingOptionPrompt: null,
      autoTitle: null,
    };
    this.taskRuntimes.set(runningTask.id, activeTask);
    this.watchClaudeUsage(activeTask);
    this.watchClaudeHooks(activeTask);
    this.persistTaskManifest(runningTask, storageRoot);

    if (claudeResume && request.resumeMode === "summary") {
      // The panel's option 1, made explicit and receipted: /compact runs
      // first, ahead of anything the user queued, and shows up in the
      // delivery queue as its own item.
      deliveryController.enqueue("/compact");
    }

    for (const source of persistedSources) {
      // Both CLIs append to the same session file on resume — the
      // re-attached chain tip must stay tailed for live updates.
      providerTranscript.attachExistingSource(source, { tail: Boolean(resumeRef) });
    }
    providerTranscript.startDiscovery(ptyStartedAt);

    this.emitReportUpdated(runIndex);

    return {
      task: runningTask,
      runtime,
      resumedProviderSession: Boolean(resumeRef),
    };
  }

  closeTask(taskId: TaskId): void {
    const active = this.requireTaskRuntime(taskId);
    this.disposeTaskRuntime(active);
    this.taskRuntimes.delete(taskId);
  }

  /**
   * Pre-spawn resume context (slice C): whether the resume moment needs
   * the inline choice, with the cost numbers the native panel would have
   * shown — computed from Duet's own data before any PTY exists.
   */
  prepareResume(taskId: TaskId): PrepareResumeResponse {
    const settings = this.resumeSettingsStore.read();
    const base: PrepareResumeResponse = {
      needsChoice: false,
      policy: settings.policy,
      overThreshold: false,
      idleMs: null,
      totalTokens: null,
      bridgeDismissed: this.readResumeBridgeDismissed(),
    };
    if (this.taskRuntimes.has(taskId)) {
      return base;
    }
    let storageRoot: string;
    try {
      storageRoot = this.resolveOpenTaskStorageRoot({ taskId });
    } catch {
      return base;
    }
    const manifest = this.readTaskManifest(storageRoot);
    if (manifest.task.provider !== "claude") {
      return base;
    }
    const tip = this.readTranscriptSources(storageRoot).at(-1);
    if (!tip?.providerSessionId || !tip.path) {
      return base;
    }
    const stats = readClaudeResumeStats(tip.path);
    const idleMs =
      stats.lastActivityMs === null ? null : Math.max(0, Date.now() - stats.lastActivityMs);
    const overThreshold =
      idleMs !== null &&
      stats.totalTokens !== null &&
      idleMs >= RESUME_PROMPT_MIN_IDLE_MS &&
      stats.totalTokens >= RESUME_PROMPT_MIN_TOKENS;
    return {
      ...base,
      idleMs,
      totalTokens: stats.totalTokens,
      overThreshold,
      needsChoice: settings.policy === "ask" && overThreshold,
    };
  }

  readResumeSettings(): ResumeSettingsResponse {
    return {
      settings: this.resumeSettingsStore.read(),
      bridgeDismissed: this.readResumeBridgeDismissed(),
    };
  }

  writeResumeSettings(settings: unknown): ResumeSettings {
    return this.resumeSettingsStore.write(settings);
  }

  readClaudeSettings(): ClaudeSettings {
    return this.claudeSettingsStore.read();
  }

  writeClaudeSettings(settings: unknown): ClaudeSettings {
    return this.claudeSettingsStore.write(settings);
  }

  /**
   * Removes the temporary `resumeReturnDismissed: true` bridge from
   * ~/.claude.json, only on an explicit click. Inside Duet the panel is
   * suppressed per-spawn regardless; this restores Claude's own warning
   * for terminals OUTSIDE Duet. Rides the shared `updateClaudeConfig`
   * primitive (S4) — same backup-once / atomic / conflict-retry rules as
   * the trust pre-write, one write path for the user-global config.
   */
  revertResumeBridge(): RevertResumeBridgeResponse {
    const result = updateClaudeConfig((config) => {
      if (config.resumeReturnDismissed !== true) {
        return false;
      }
      delete config.resumeReturnDismissed;
      return true;
    });
    return { cleared: result.applied || result.reason === "no-change" };
  }

  private readResumeBridgeDismissed(): boolean {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"),
      ) as Record<string, unknown>;
      return parsed.resumeReturnDismissed === true;
    } catch {
      return false;
    }
  }

  listTasks(): Task[] {
    return [...this.taskRuntimes.values()].map((active) => active.task);
  }

  readSessionSnapshot(taskId: TaskId): SessionSnapshotResponse {
    const live = this.taskRuntimes.get(taskId);
    if (live) {
      return {
        task: live.task,
        live: true,
        report: live.runIndex.read(),
        sources: live.providerTranscript.sources(),
        blocks: live.providerTranscript.blocks(),
      };
    }

    // Dormant session: rebuild the reading surface straight from disk.
    // No PTY, no tailing — attach the persisted sources, drain once, done.
    const record = this.requirePersistedSession(taskId);
    const task = record.manifest.task;
    const providerCwd = taskProviderCwd(task, record.storageRoot);
    const runIndex = new RunIndex({
      taskId,
      reportPath: runtimeReportPath(record.storageRoot),
      loadExisting: true,
    });
    const transcript = new ProviderTranscript({
      taskId,
      provider: task.provider,
      providerCwd,
      eventSink: () => {
        // One-shot read; the snapshot response carries everything.
      },
      resolveRunId: (input) => resolveRunForTurn(runIndex, input),
    });
    try {
      for (const source of this.readTranscriptSources(record.storageRoot)) {
        transcript.attachExistingSource(source);
      }
      return {
        task,
        live: false,
        report: runIndex.read(),
        sources: transcript.sources(),
        blocks: transcript.blocks(),
      };
    } finally {
      transcript.dispose();
    }
  }

  readSessionIndex(request: ReadSessionIndexRequest = {}): SessionIndexResponse {
    const liveTasks = new Map<TaskId, Task>();
    for (const active of this.taskRuntimes.values()) {
      liveTasks.set(active.task.id, active.task);
    }
    return buildSessionIndex({
      candidates: this.taskManifestCandidates(),
      liveTasks,
      overlay: this.projectsStore.read(),
      ...(request.includeArchived !== undefined
        ? { includeArchived: request.includeArchived }
        : {}),
    });
  }

  renameSession(taskId: TaskId, title: string): void {
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error("Session title must not be empty.");
    }
    // Renaming is metadata, not activity — leave updatedAt alone so the
    // session keeps its place in the sidebar ordering.
    const live = this.taskRuntimes.get(taskId);
    if (live) {
      live.task = { ...live.task, title: trimmed };
      this.persistTaskManifest(live.task, live.storageRoot);
      this.sendEvent({
        type: "task:updated",
        payload: { taskId, task: live.task, reason: "runtime-status" },
        ts: new Date().toISOString(),
      });
      return;
    }
    const record = this.requirePersistedSession(taskId);
    this.persistTaskManifest({ ...record.manifest.task, title: trimmed }, record.storageRoot);
  }

  archiveSession(taskId: TaskId, archived: boolean): void {
    // Like rename, the archive flag is metadata — updatedAt stays put.
    const live = this.taskRuntimes.get(taskId);
    if (live) {
      // Archiving a running session stops its PTY first; disposeTaskRuntime
      // persists the manifest with the flag already applied.
      live.task = { ...live.task, archived };
      if (archived) {
        this.disposeTaskRuntime(live);
        this.taskRuntimes.delete(taskId);
      } else {
        this.persistTaskManifest(live.task, live.storageRoot);
      }
      return;
    }
    const record = this.requirePersistedSession(taskId);
    this.persistTaskManifest({ ...record.manifest.task, archived }, record.storageRoot);
  }

  deleteSession(taskId: TaskId): void {
    const live = this.taskRuntimes.get(taskId);
    if (live) {
      this.disposeTaskRuntime(live);
      this.taskRuntimes.delete(taskId);
    }
    const record = this.persistedSessionRecord(taskId);
    if (record) {
      // storageRoot is Duet's own hidden record dir — remove it wholesale, with
      // the task's Duet-owned attachment and runtime subtrees. The agent's working
      // directory (providerCwd) is the user's VISIBLE work — a chosen folder or a
      // generated ~/Documents/Duet workspace — and is NEVER touched (C4). The CLI
      // transcript (CLI-owned) also stays.
      fs.rmSync(record.storageRoot, { recursive: true, force: true });
      fs.rmSync(attachmentsRootForTask(taskId), { recursive: true, force: true });
      fs.rmSync(runtimeDir(taskId), { recursive: true, force: true });
    }
    this.emitSessionsUpdated("session-deleted");
  }

  injectRemoteControl(taskId: TaskId): RemoteControlInjectResponse {
    const active = this.requireTaskRuntime(taskId);
    return active.terminalHost.injectRemoteControl();
  }

  writeTerminalUserInput(taskId: TaskId, data: string): void {
    if (typeof data !== "string" || data.length === 0) {
      return;
    }
    const active = this.requireTaskRuntime(taskId);
    active.terminalHost.writeUserInput(data);
  }

  listSlashCommands(request: ReadSlashCommandsRequest): SlashCommandsResponse {
    let provider = request.provider ?? null;
    let cwd = request.cwd ?? null;
    if (request.taskId) {
      const taskId = request.taskId as TaskId;
      const live = this.taskRuntimes.get(taskId);
      const task = live?.task ?? this.requirePersistedSession(taskId).manifest.task;
      provider = task.provider;
      cwd = this.sessionWorkingDirectory(taskId);
    }
    if (!provider || !SUPPORTED_PROVIDERS.has(provider)) {
      throw new Error("listSlashCommands needs a taskId or a provider.");
    }
    const { entries, warnings } = discoverSlashCommands(provider, cwd);
    return { provider, entries, warnings };
  }

  sessionWorkingDirectory(taskId: TaskId): string {
    const live = this.taskRuntimes.get(taskId);
    if (live) {
      return taskProviderCwd(live.task, live.storageRoot);
    }
    const record = this.requirePersistedSession(taskId);
    return taskProviderCwd(record.manifest.task, record.storageRoot);
  }

  renameProject(folderPath: string, displayName: string | null): void {
    this.projectsStore.setDisplayName(path.resolve(folderPath), displayName);
    this.emitSessionsUpdated("project-updated");
  }

  archiveProject(folderPath: string, archived: boolean): void {
    const resolved = path.resolve(folderPath);
    if (archived) {
      // Stop any live sessions working in this folder before hiding it.
      for (const active of [...this.taskRuntimes.values()]) {
        if (pathsEqual(taskProviderCwd(active.task, active.storageRoot), resolved)) {
          this.disposeTaskRuntime(active);
          this.taskRuntimes.delete(active.task.id);
        }
      }
    }
    this.projectsStore.setArchived(resolved, archived);
    this.emitSessionsUpdated("project-updated");
  }

  submitPrompt(taskId: TaskId, text: string, attachments: DeliveryAttachment[] = []): void {
    const active = this.requireTaskRuntime(taskId);
    let normalized: DeliveryAttachment[];
    try {
      normalized = this.normalizeDeliveryAttachments(active, attachments);
    } catch (error) {
      // Lazy materialization copies bitmap blobs in the renderer BEFORE this
      // validation runs. If validation now fails (e.g. a referenced path vanished
      // between attach and send), those just-copied blobs would orphan with no
      // handle. Clean them transactionally with the failed send (blob-guarded —
      // referenced originals are never touched), then surface the error.
      this.cleanupAttachments(taskId, attachments);
      throw error;
    }
    active.deliveryController.enqueue(text, normalized);
  }

  createAttachment(
    taskId: TaskId,
    input: { originalName: string; mediaType: string; bytes: ArrayBuffer },
  ): DeliveryAttachment {
    const active = this.requireTaskRuntime(taskId);
    const bytes = Buffer.from(new Uint8Array(input.bytes));
    const mediaType = normalizeImageMediaType(input.mediaType, input.originalName, bytes);
    if (!mediaType) {
      throw new Error("Only PNG, JPEG, GIF, and WebP images can be attached.");
    }
    if (bytes.length === 0) {
      throw new Error("Cannot attach an empty image.");
    }

    const id = `attachment-${Date.now()}-${++this.attachmentSeq}`;
    const filename = `${id}${imageExtension(mediaType)}`;
    const attachmentDirectory = attachmentsRootForTask(active.task.id);
    fs.mkdirSync(attachmentDirectory, { recursive: true });
    const attachmentPath = path.join(attachmentDirectory, filename);
    fs.writeFileSync(attachmentPath, bytes, { flag: "wx" });
    return {
      id,
      path: attachmentPath,
      originalName: input.originalName.trim() || filename,
      mediaType,
      size: bytes.length,
      provenance: "blob",
      kind: "image",
    };
  }

  /** Reference user paths by absolute path — NO copy, NEVER deleted (Invariant 4).
   *  taskId-independent (works before a session exists). Classifies each path by
   *  stat + extension so delivery can pick the channel (image chip vs path text),
   *  and reads a capped thumbnail for image references (a small file read for a
   *  chip preview — the agent reads the file itself anyway). */
  createReference(paths: string[]): ReferenceResult[] {
    const results: ReferenceResult[] = [];
    for (const input of paths) {
      // Per-path: a single missing/inaccessible path (e.g. one item of a
      // multi-file drag vanished, or a broken symlink) must not drop the rest.
      try {
        const resolved = path.resolve(input);
        const stat = fs.statSync(resolved);
        const isDirectory = stat.isDirectory();
        const ext = path.extname(resolved).toLowerCase();
        const imageMediaType = IMAGE_EXTENSION_MEDIA_TYPES.get(ext);
        const kind = isDirectory ? "folder" : imageMediaType ? "image" : "file";
        const attachment: DeliveryAttachment = {
          id: `attachment-${Date.now()}-${++this.attachmentSeq}`,
          path: resolved,
          originalName: path.basename(resolved) || resolved,
          mediaType: isDirectory ? "inode/directory" : imageMediaType ?? "application/octet-stream",
          size: isDirectory ? 0 : stat.size,
          provenance: "referenced",
          kind,
        };
        const previewDataUrl =
          imageMediaType && !isDirectory && stat.size > 0 && stat.size <= REFERENCE_PREVIEW_MAX_BYTES
            ? `data:${imageMediaType};base64,${fs.readFileSync(resolved).toString("base64")}`
            : null;
        results.push({ attachment, previewDataUrl });
      } catch {
        // Skip this path; the caller surfaces a count mismatch if needed.
      }
    }
    return results;
  }

  decideApproval(taskId: TaskId, decision: ApprovalDecision, approvalId: string | null = null): void {
    const active = this.requireTaskRuntime(taskId);
    // Hook-broker card (S2, Claude): answer on the hook channel — write the
    // reply the broker is polling for. No native keys, no scrape.
    const pending = approvalId ? this.pendingBrokerApprovals.get(approvalId) : null;
    if (approvalId && pending && pending.taskId === taskId) {
      this.pendingBrokerApprovals.delete(approvalId);
      writeApprovalReply(runtimeDir(taskId), approvalId, brokerDecisionJson(decision, pending.payload));
      const decisionEvent: RuntimeEvent = {
        type: "approval:decision",
        payload: {
          taskId,
          runId: active.terminalHost.activeRunId(),
          decision,
          encodedAs: "reply-file",
          previousKind: classifyApprovalKind(pending.payload),
          // The keyed delivery gate releases exactly THIS ask (S6 review P1).
          approvalId,
        },
        ts: new Date().toISOString(),
      };
      this.sendEvent(decisionEvent); // renderer clears the card + cli-state resyncs
      active.deliveryController.handleRuntimeEvent(decisionEvent); // clear the delivery gate
      // Audit trail (same reason as surfaceBrokerApproval): reply-channel
      // decisions must reach the run-index themselves.
      if (active.runIndex.consume(decisionEvent)) {
        this.emitReportUpdated(active.runIndex);
      }
      // Resync terminal-host state: the approval scrape may have flipped the
      // run to waiting-for-approval off the broker-held preview bytes; a
      // reply-channel decision must resume it or the run wedges (S5 diag).
      active.terminalHost.noteHookApprovalDecision(decision, classifyApprovalKind(pending.payload));
      if (this.shownBrokerApproval.get(taskId) === approvalId) {
        this.shownBrokerApproval.delete(taskId);
      }
      this.surfaceNextBrokerApproval(active); // P3: show the next queued approval, if any
      return;
    }
    // Fallback / Codex: the scraped native panel — replay keys.
    if (decision === "approve" || decision === "approve-for-session" || decision === "approve-always") {
      active.terminalHost.sendApprovalDecision(decision);
      return;
    }
    active.terminalHost.sendDeny();
  }

  /**
   * A broker surfaced a permission request (S2). Route it to its task, drive
   * cli-state to waiting-approval (as the old sink did), and surface the card
   * FROM THE HOOK — the one-line "what" comes from tool_name/tool_input, and the
   * answer goes back via the reply file (answerVia:"reply"), never native keys.
   */
  private handleApprovalAsk(ask: ApprovalAsk, workspace: string): void {
    const resolved = path.resolve(workspace);
    for (const active of this.taskRuntimes.values()) {
      if (active.task.provider !== "claude" || !pathsEqual(runtimeDir(active.task.id), resolved)) {
        continue;
      }
      active.cliState.applyHook(ask.payload);
      // Ask arrival is the ONE moment for gate + record (S6 review P2: doing
      // this inside the show path recorded a queued-then-shown ask twice —
      // the run-index appends, it does not dedupe). The event is built here
      // and stored so the show path re-sends it verbatim.
      const kind = classifyApprovalKind(ask.payload);
      const event: RuntimeEvent = {
        type: "approval:detected",
        payload: {
          taskId: active.task.id,
          // Broker asks carry no runId of their own; attribute to the open
          // Duet run — the same attribution the scrape path records.
          runId: active.terminalHost.activeRunId(),
          kind,
          source: "hook-broker",
          answerVia: "reply",
          approvalId: ask.id,
          summary: approvalSummary(ask.payload),
          choices: brokerApprovalChoices(kind, ask.payload),
        },
        ts: new Date().toISOString(),
      };
      this.pendingBrokerApprovals.set(ask.id, {
        taskId: active.task.id,
        payload: ask.payload,
        event,
      });
      // Gate: keyed per approvalId (S6 review P1) — a hidden queued ask
      // blocks delivery from the moment it exists, and deciding a DIFFERENT
      // ask cannot release it.
      active.deliveryController.handleRuntimeEvent(event);
      // The report is the approval audit trail: broker asks never flow
      // through the terminal-host eventSink, so consume into the run-index
      // here or the durable record silently loses hook-broker provenance.
      if (active.runIndex.consume(event)) {
        this.emitReportUpdated(active.runIndex);
      }
      this.surfaceBrokerApproval(active, ask.id);
      return;
    }
  }

  /**
   * SHOW a broker approval card — presentation only; the delivery gate and
   * the run-index record happened once at ask arrival (handleApprovalAsk).
   * Only ONE card per task at a time (P3): a concurrent ask stays in
   * pendingBrokerApprovals (still answerable + gate-blocking) and shows when
   * the current one resolves.
   */
  private surfaceBrokerApproval(active: ActiveTaskRuntime, id: string): void {
    const pending = this.pendingBrokerApprovals.get(id);
    if (!pending || pending.taskId !== active.task.id) {
      return;
    }
    if (!this.shownBrokerApproval.has(active.task.id)) {
      this.shownBrokerApproval.set(active.task.id, id);
      this.sendEvent(pending.event); // the card
    }
  }

  /**
   * A turn-terminal signal orphans every broker ask still pending for the
   * task: PermissionRequest hooks live INSIDE the turn, so an interrupt
   * kills the holding hook — no reply will ever be read and no expired
   * marker will ever be written. Without this release the keyed delivery
   * gate held those ids forever and every later send wedged (stop-continue
   * caught it on the keyed gate's first Esc run, 2026-07-03; the old
   * boolean was accidentally rescued by ANY later decision clearing it
   * globally). The CLI's own model of an interrupt is a rejection ("The
   * user doesn't want to proceed"), so the asks resolve honestly as
   * deny/Esc — gate released, report balanced, the shown card cleared.
   */
  private abortPendingBrokerApprovals(active: ActiveTaskRuntime, runId: RunId | null): void {
    for (const [id, pending] of this.pendingBrokerApprovals) {
      if (pending.taskId !== active.task.id) {
        continue;
      }
      this.pendingBrokerApprovals.delete(id);
      const decisionEvent: RuntimeEvent = {
        type: "approval:decision",
        payload: {
          taskId: active.task.id,
          // The terminating EVENT's runId — activeRunId() is already null
          // here (finishActiveRun cleared it before the event was emitted),
          // which sent these denials to unassignedApprovals while their
          // detected twins sat on the run: an unbalanced audit trail
          // (review 2026-07-03).
          runId: runId ?? active.terminalHost.activeRunId(),
          decision: "deny",
          encodedAs: "Esc",
          previousKind: classifyApprovalKind(pending.payload),
          approvalId: id,
        },
        ts: new Date().toISOString(),
      };
      active.deliveryController.handleRuntimeEvent(decisionEvent); // release the gate key
      if (active.runIndex.consume(decisionEvent)) {
        this.emitReportUpdated(active.runIndex);
      }
      if (this.shownBrokerApproval.get(active.task.id) === id) {
        // Only the SHOWN ask concerns the renderer — clearing a card the
        // user never saw would flash a phantom "Approval denied".
        this.shownBrokerApproval.delete(active.task.id);
        this.sendEvent(decisionEvent);
      }
    }
  }

  private surfaceNextBrokerApproval(active: ActiveTaskRuntime): void {
    if (this.shownBrokerApproval.has(active.task.id)) {
      return;
    }
    for (const [id, pending] of this.pendingBrokerApprovals) {
      if (pending.taskId === active.task.id) {
        this.surfaceBrokerApproval(active, id);
        return;
      }
    }
  }

  /**
   * A broker gave up (timeout) — the CLI's native panel is taking over, and the
   * scrape will surface it. Clear the hook card, but emit `approval:expired`
   * (NOT a false "answered-natively" decision): nothing was answered, so
   * cli-state stays waiting-approval and the delivery gate stays blocked through
   * the expiry→scrape gap (reviewer P1/P2).
   */
  private handleApprovalExpired(id: string, workspace: string): void {
    const pending = this.pendingBrokerApprovals.get(id);
    this.pendingBrokerApprovals.delete(id);
    const resolved = path.resolve(workspace);
    for (const active of this.taskRuntimes.values()) {
      if (active.task.provider !== "claude" || !pathsEqual(runtimeDir(active.task.id), resolved)) {
        continue;
      }
      if (!pending || pending.taskId !== active.task.id) {
        return;
      }
      const expiredEvent: RuntimeEvent = {
        type: "approval:expired",
        payload: { taskId: active.task.id, approvalId: id },
        ts: new Date().toISOString(),
      };
      // Gate: the key transitions asked→expired and keeps blocking through
      // the expiry→scrape gap (per-ask since the S6 review).
      active.deliveryController.handleRuntimeEvent(expiredEvent);
      if (this.shownBrokerApproval.get(active.task.id) === id) {
        // Only the SHOWN ask's expiry concerns the renderer — a hidden
        // queued ask expiring must not clear someone else's live card
        // (S6 review P2); its native panel is the scrape's to surface.
        this.shownBrokerApproval.delete(active.task.id);
        this.sendEvent(expiredEvent); // renderer clears the hook card + raises the banner
      }
      this.surfaceNextBrokerApproval(active); // a concurrent queued approval, if any
      return;
    }
  }

  async stopRun(taskId: TaskId, options: { inspectDelayMs?: number; forceSlashStop?: boolean }): Promise<void> {
    const active = this.requireTaskRuntime(taskId);
    await active.terminalHost.stopRun(options);
  }

  resizeTerminal(taskId: TaskId, cols: number, rows: number): void {
    const active = this.requireTaskRuntime(taskId);
    active.terminalHost.resize(cols, rows);
    active.statusTracker.resize(cols, rows);
  }

  /** Snapshot a task's terminal for replay into a (re)opening terminal window.
   *  Null when the task has no live runtime — the caller shows a blank terminal
   *  and tails live output from there. */
  async replayTerminal(taskId: TaskId): Promise<TerminalReplaySnapshot | null> {
    const runtime = this.taskRuntimes.get(taskId);
    if (!runtime) {
      return null;
    }
    return runtime.terminalHost.serializeScrollback();
  }

  readReport(taskId: TaskId): RuntimeReportV1 {
    const active = this.requireTaskRuntime(taskId);
    return active.runIndex.read();
  }

  readTranscript(taskId: TaskId): ReadTranscriptResponse {
    const active = this.requireTaskRuntime(taskId);
    return {
      sources: active.providerTranscript.sources(),
      blocks: active.providerTranscript.blocks(),
    };
  }

  readUsage(taskId: TaskId): UsageSnapshot | null {
    this.requireTaskRuntime(taskId);
    return this.usageSnapshots.get(taskId) ?? null;
  }

  listArtifacts(taskId: TaskId): ArtifactCandidate[] {
    const active = this.requireTaskRuntime(taskId);
    return this.currentArtifactPreview(active).listArtifacts();
  }

  readArtifact(taskId: TaskId, relativePath: string): ReturnType<ArtifactPreview["readArtifact"]> {
    const active = this.requireTaskRuntime(taskId);
    return this.currentArtifactPreview(active).readArtifact(relativePath);
  }

  readWorkspaceTree(taskId: TaskId): WorkspaceTreeEntry[] {
    const active = this.requireTaskRuntime(taskId);
    return this.currentWorkspacePreview(active).readTree();
  }

  readWorkspaceFile(taskId: TaskId, relativePath: string): WorkspaceFilePreviewResponse {
    const active = this.requireTaskRuntime(taskId);
    return this.currentWorkspacePreview(active).readFile(relativePath);
  }

  workspacePath(taskId: TaskId): string {
    const active = this.requireTaskRuntime(taskId);
    return this.workspaceRoot(active);
  }

  dispose(): void {
    for (const active of this.taskRuntimes.values()) {
      this.disposeTaskRuntime(active);
    }
    this.taskRuntimes.clear();
    this.usageSnapshots.clear();
    this.pendingClaudeUsage.clear();
    this.claudeUsageWatcher.dispose();
    this.claudeHookWatcher.dispose();
    this.claudeApprovalWatcher.dispose();
    this.pendingBrokerApprovals.clear();
  }

  private handleRuntimeEvent(event: RuntimeEvent, runIndex: RunIndex): void {
    if (event.type === "usage:updated") {
      this.publishUsageSnapshot(event.payload.taskId, event.payload.snapshot);
      this.maybeApplyProviderSessionName(event.payload.taskId, event.payload.snapshot.sessionName);
      return;
    }
    if (event.type === "sessions:updated") {
      this.sendEvent(event);
      return;
    }

    const eventRuntime = this.taskRuntimes.get(event.payload.taskId);
    eventRuntime?.deliveryController.handleRuntimeEvent(event);
    eventRuntime?.statusTracker.handleRuntimeEvent(event);
    eventRuntime?.cliState.applyRuntimeEvent(event);

    // A turn-terminal signal orphans every broker ask still pending for the
    // task (see abortPendingBrokerApprovals). Covers Duet's ■/Esc
    // (run:stopped), a native terminal Esc closed by the quiescence
    // run-closer (completed + terminal-idle-heuristic), and the PTY dying.
    // Normal hook-Stop completions can't coexist with a live ask — the
    // holding hook blocks the turn from ending.
    if (
      eventRuntime &&
      (event.type === "run:stopped" ||
        event.type === "pty:exit" ||
        (event.type === "run:updated" &&
          (event.payload.status === "stopped" ||
            (event.payload.status === "completed" &&
              event.payload.completionSource === "terminal-idle-heuristic"))))
    ) {
      const terminalRunId =
        event.type === "run:stopped"
          ? event.payload.runId
          : event.type === "run:updated"
            ? event.payload.id
            : null;
      this.abortPendingBrokerApprovals(eventRuntime, terminalRunId);
    }

    if (event.type === "pty:exit" && eventRuntime?.pendingOptionPrompt) {
      // The PTY died with a question still open — clear the card (no receipt).
      const toolUseId = eventRuntime.pendingOptionPrompt.toolUseId;
      eventRuntime.pendingOptionPrompt = null;
      this.sendEvent({
        type: "option-prompt:resolved",
        payload: { taskId: event.payload.taskId, toolUseId, answers: null },
        ts: new Date().toISOString(),
      });
    }

    if (event.type === "run:started") {
      this.updateTaskTitleFromRun(event.payload.taskId, event.payload.title);
      this.taskRuntimes.get(event.payload.taskId)?.providerTranscript.ensureDiscovery();
    }

    this.sendEvent(event);

    if (event.type === "transcript:located") {
      const active = this.taskRuntimes.get(event.payload.taskId);
      if (active) {
        this.persistTranscriptSources(active);
      }
      return;
    }

    // Allowlist boundary: only events RunIndex.consume actually handles cross
    // into it. Everything else — renderer-facing UI/state events
    // (remote-control:state), plus events delivered on other paths (delivery:*,
    // report:updated, transcript:blocks, pty:data) — was already sent to the
    // renderer above and stops here. This replaces the old denylist skip-list +
    // `event as RunIndexEvent` cast, which turned any un-routed event into an
    // assertNever main-process crash (the 2026-06 modal:state incident).
    if (!isRunIndexEvent(event)) {
      return;
    }

    const summary = runIndex.consume(event);
    if (!summary) {
      return;
    }

    this.emitReportUpdated(runIndex);
    if (event.type === "run:started" || event.type === "run:updated") {
      this.syncTaskStatusFromRunEvent(event);
    }
  }

  private syncTaskStatusFromRunEvent(event: Extract<RuntimeEvent, { type: "run:started" | "run:updated" }>): void {
    const active = this.taskRuntimes.get(event.payload.taskId);
    if (!active) {
      return;
    }
    const status = taskStatusFromRunStatus(event.payload.status);
    if (active.task.status === status) {
      return;
    }
    active.task = {
      ...active.task,
      status,
      updatedAt: new Date().toISOString(),
    };
    this.persistTaskManifest(active.task, active.storageRoot);
    this.sendEvent({
      type: "task:updated",
      payload: {
        taskId: active.task.id,
        task: active.task,
        reason: "runtime-status",
      },
      ts: new Date().toISOString(),
    });
  }

  private updateTaskTitleFromRun(taskId: TaskId, title: string): void {
    const active = this.taskRuntimes.get(taskId);
    const nextTitle = title.trim();
    if (!active || !nextTitle || !AUTO_TITLE_PLACEHOLDERS.has(active.task.title)) {
      return;
    }

    active.task = {
      ...active.task,
      title: nextTitle,
      updatedAt: new Date().toISOString(),
    };
    active.autoTitle = nextTitle;
    this.persistTaskManifest(active.task, active.storageRoot);
  }

  /**
   * Claude's statusline carries a provider-generated session title. It only
   * ever replaces an AUTOMATIC title (placeholder or the last auto-applied
   * value) — a user rename diverges from autoTitle and wins forever. Like
   * manual rename, this is metadata: updatedAt stays untouched.
   */
  private maybeApplyProviderSessionName(taskId: TaskId, sessionName: string | null | undefined): void {
    const active = this.taskRuntimes.get(taskId);
    const nextTitle = sessionName?.trim();
    if (!active || !nextTitle || active.task.title === nextTitle) {
      return;
    }
    const isAutomaticTitle =
      AUTO_TITLE_PLACEHOLDERS.has(active.task.title) || active.task.title === active.autoTitle;
    if (!isAutomaticTitle) {
      return;
    }
    active.task = { ...active.task, title: nextTitle };
    active.autoTitle = nextTitle;
    this.persistTaskManifest(active.task, active.storageRoot);
    this.sendEvent({
      type: "task:updated",
      payload: { taskId, task: active.task, reason: "runtime-status" },
      ts: new Date().toISOString(),
    });
    this.sendEvent({
      type: "sessions:updated",
      payload: { reason: "session-renamed" },
      ts: new Date().toISOString(),
    });
  }

  private emitReportUpdated(runIndex: RunIndex): void {
    const summary = runIndex.summary();
    const reportEvent: RuntimeReportUpdatedEvent = {
      type: "report:updated",
      payload: {
        taskId: summary.taskId,
        reportPath: summary.reportPath,
        runCount: summary.runCount,
        latestRunId: summary.latestRun?.runId ?? null,
        rawTerminalPersisted: false,
        rawTerminalPointer: null,
      },
      ts: new Date().toISOString(),
    };
    this.sendEvent(reportEvent);
  }

  private currentArtifactPreview(active: ActiveTaskRuntime): ArtifactPreview {
    return new ArtifactPreview({
      taskId: active.task.id,
      workspaceRoot: this.workspaceRoot(active),
      report: active.runIndex.read(),
    });
  }

  private currentWorkspacePreview(active: ActiveTaskRuntime): WorkspacePreview {
    return new WorkspacePreview({
      workspaceRoot: this.workspaceRoot(active),
    });
  }

  private workspaceRoot(active: ActiveTaskRuntime): string {
    return active.terminalHost.workspace ?? active.task.workingDirectory;
  }

  private requireTaskRuntime(taskId: TaskId): ActiveTaskRuntime {
    const active = this.taskRuntimes.get(taskId);
    if (!active) {
      throw new TaskNotFoundError("No runtime task matches the requested taskId.");
    }
    return active;
  }

  private disposeTaskRuntime(active: ActiveTaskRuntime): void {
    this.persistTaskManifest({
      ...active.task,
      status: "idle",
      updatedAt: new Date().toISOString(),
    }, active.storageRoot);
    active.providerTranscript.dispose();
    active.deliveryController.dispose();
    active.statusTracker.dispose();
    active.terminalHost.dispose();
    // Stop the report writer LAST: after this, a straggler PTY-exit event can no
    // longer re-create the record dir we are about to (for a delete) remove.
    active.runIndex.dispose();
    this.unwatchClaudeUsage(active);
    this.unwatchClaudeHooks(active);
    this.usageSnapshots.delete(active.task.id);
  }

  private publishUsageSnapshot(taskId: TaskId, snapshot: UsageSnapshot): void {
    const active = this.taskRuntimes.get(taskId);
    if (!active) {
      return;
    }
    const merged = mergeUsageSnapshot(this.usageSnapshots.get(taskId) ?? null, snapshot);
    if (!hasUsageData(merged)) {
      return;
    }
    this.usageSnapshots.set(taskId, merged);
    this.sendEvent({
      type: "usage:updated",
      payload: {
        taskId,
        snapshot: merged,
      },
      ts: new Date().toISOString(),
    });
  }

  private watchClaudeUsage(active: ActiveTaskRuntime): void {
    if (active.task.provider === "claude") {
      this.claudeUsageWatcher.watchWorkspace(runtimeDir(active.task.id));
    }
  }

  private unwatchClaudeUsage(active: ActiveTaskRuntime): void {
    if (active.task.provider === "claude") {
      this.claudeUsageWatcher.unwatchWorkspace(runtimeDir(active.task.id));
    }
  }

  private watchClaudeHooks(active: ActiveTaskRuntime): void {
    if (active.task.provider === "claude") {
      this.claudeHookWatcher.watchWorkspace(runtimeDir(active.task.id));
      this.claudeApprovalWatcher.watchWorkspace(runtimeDir(active.task.id));
    }
  }

  private unwatchClaudeHooks(active: ActiveTaskRuntime): void {
    if (active.task.provider === "claude") {
      this.claudeHookWatcher.unwatchWorkspace(runtimeDir(active.task.id));
      this.claudeApprovalWatcher.unwatchWorkspace(runtimeDir(active.task.id));
    }
  }

  /**
   * Route a Claude hook payload to its task by workspace (cwd) — more reliable
   * than session-id matching, which lags transcript discovery. The hook fires
   * only after the PTY is up, by which point the task is registered, so a
   * pending buffer isn't needed (unmatched payloads are simply dropped).
   */
  private handleClaudeHookPayload(payload: ClaudeHookPayload, workspace: string): void {
    // The watcher is keyed by the session's runtime dir (D8), not its cwd — route
    // the payload back to the task by the same key.
    const resolved = path.resolve(workspace);
    for (const active of this.taskRuntimes.values()) {
      if (active.task.provider === "claude" && pathsEqual(runtimeDir(active.task.id), resolved)) {
        active.cliState.applyHook(payload);
        this.applyHookPermissionMode(active, payload);
        this.handleOptionPromptHook(active, payload);
        // `UserPromptSubmit` is the authoritative "a turn is starting" signal —
        // the CLI just began (or dequeued) a prompt. Begin the run from it
        // (no-op if the idle-send path already began one). This is what makes
        // mid-turn write-through honest: a queued send's run starts exactly when
        // the CLI dequeues it, not when Duet wrote the bytes. Symmetric with the
        // Stop-hook completion below.
        if (payload.hook_event_name === "UserPromptSubmit") {
          const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
          active.terminalHost.beginRunFromHook(prompt, {
            // The CLI's prompt_id == the transcript's promptId/turnKey — the
            // exact run↔turn bridge (2026-07-03 loop-wakeup fix).
            promptId: typeof payload.prompt_id === "string" ? payload.prompt_id : null,
          });
        }
        // `Stop` is the authoritative "turn ended" signal — complete the active
        // run from it (structured truth) instead of waiting on the composer-idle
        // scrape, which lagged and could be fooled (spinner/timer ran on after
        // the reply). The terminal-host heuristic stays as the fallback, so this
        // is additive: prompt completion when Stop fires, scrape otherwise.
        if (payload.hook_event_name === "Stop") {
          active.terminalHost.completeRunFromTurnEnd();
        }
        // `StopFailure` is the turn's other honest ending: the API errored
        // out after retries and Stop will never fire (probed S6). Complete
        // the run with the structured error — the scrape-side excerpt
        // extraction remains the fallback for hook-less sessions.
        if (payload.hook_event_name === "StopFailure") {
          const error = typeof payload.error === "string" && payload.error.trim()
            ? payload.error.trim()
            : "API error";
          active.terminalHost.completeRunFromTurnEnd({ errorExcerpt: error });
        }
        return;
      }
    }
  }

  /**
   * Keep the displayed permission mode current from hook payloads (contract
   * §2: mid-session switching lives in the Terminal — Shift+Tab, /permissions
   * — and Reading only DISPLAYS the mode; the banner scrape that used to
   * verify drives is retired in S4). Every hook event carries
   * `permission_mode`, so a native switch is reflected on the next hook
   * activity — not instantly on the keypress; the statusline payload has no
   * mode field, so hooks are the only structured source.
   */
  private applyHookPermissionMode(active: ActiveTaskRuntime, payload: ClaudeHookPayload): void {
    const mode = payload.permission_mode;
    if (
      typeof mode !== "string" ||
      !CLAUDE_PERMISSION_MODES.has(mode as ClaudePermissionMode) ||
      active.task.permissionMode === mode
    ) {
      return;
    }
    // updatedAt stays put — a mode display refresh is metadata, not activity
    // (same rule as rename/archive), so the sidebar ordering doesn't jump.
    active.task = { ...active.task, permissionMode: mode as ClaudePermissionMode };
    this.persistTaskManifest(active.task, active.storageRoot);
    this.sendEvent({
      type: "task:updated",
      payload: { taskId: active.task.id, task: active.task, reason: "runtime-status" },
      ts: new Date().toISOString(),
    });
  }

  /**
   * Surface / reconcile a native AskUserQuestion (Slice 5) from the hooks duet
   * already injects. Phase 0: `PreToolUse` carries the questions structurally,
   * `PostToolUse` carries the verbatim answers. `Stop` with a prompt still open
   * means it was cancelled (or finished without a PostToolUse) → clear the card.
   * Detection is structured, not scraped; the floor stays a valid alternative.
   */
  private handleOptionPromptHook(active: ActiveTaskRuntime, payload: ClaudeHookPayload): void {
    const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
    const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";

    if (tool === "AskUserQuestion" && event === "PreToolUse") {
      const toolUseId = typeof payload.tool_use_id === "string" ? payload.tool_use_id : null;
      const prompt = parseOptionPrompt(toolUseId, payload.tool_input);
      if (!prompt) {
        return; // malformed input → fall through to the floor, never a broken card
      }
      // NOTE: multiSelect questions are surfaced too (the card shows them as
      // full context), but they are answered in the terminal, not injected —
      // the renderer only offers card-Send when every question is single-select
      // (the only verified injection mechanic). A real requirement-clarification
      // commonly mixes single + multi, so suppressing the whole card on any
      // multiSelect (the prior behavior) hid the card for the common case.
      active.pendingOptionPrompt = prompt;
      this.sendEvent({
        type: "option-prompt:detected",
        payload: { taskId: active.task.id, toolUseId: prompt.toolUseId, questions: prompt.questions },
        ts: new Date().toISOString(),
      });
      return;
    }

    if (tool === "AskUserQuestion" && event === "PostToolUse") {
      const toolUseId =
        typeof payload.tool_use_id === "string"
          ? payload.tool_use_id
          : active.pendingOptionPrompt?.toolUseId ?? "";
      active.pendingOptionPrompt = null;
      this.sendEvent({
        type: "option-prompt:resolved",
        payload: {
          taskId: active.task.id,
          toolUseId,
          answers: reconcileOptionPromptAnswers(payload.tool_response),
        },
        ts: new Date().toISOString(),
      });
      return;
    }

    if (event === "Stop" && active.pendingOptionPrompt) {
      const toolUseId = active.pendingOptionPrompt.toolUseId;
      active.pendingOptionPrompt = null;
      this.sendEvent({
        type: "option-prompt:resolved",
        payload: { taskId: active.task.id, toolUseId, answers: null },
        ts: new Date().toISOString(),
      });
    }
  }

  /**
   * Answer a pending AskUserQuestion by playing back the verified key sequence.
   * Guards on the `toolUseId` so a stale card (already answered, cancelled, or
   * superseded by a newer prompt) is a no-op rather than a mis-injection.
   */
  async answerOptionPrompt(taskId: TaskId, toolUseId: string, optionIndices: number[]): Promise<void> {
    const active = this.requireTaskRuntime(taskId);
    const prompt = active.pendingOptionPrompt;
    if (!prompt || prompt.toolUseId !== toolUseId) {
      return;
    }
    if (prompt.questions.some((question) => question.multiSelect)) {
      // Only the single-select sequence is verified; a multiSelect prompt is
      // answered in the terminal. Never inject a guessed multi-select sequence.
      return;
    }
    const keys = optionPromptAnswerSequence(prompt.questions, optionIndices);
    await active.terminalHost.sendOptionPromptAnswer(keys);
  }

  private emitCliState(taskId: TaskId, snapshot: CliStateSnapshot): void {
    this.sendEvent({
      type: "cli-state:changed",
      payload: {
        taskId,
        activity: snapshot.activity,
        tool: snapshot.tool,
        approvalKind: snapshot.approvalKind,
        source: snapshot.source,
        changedAt: snapshot.changedAt,
      },
      ts: new Date().toISOString(),
    });
  }

  private handleClaudeStatuslinePayload(payload: unknown, mtimeMs: number): void {
    // The sink file survives app restarts; its mtime — not parse time — is
    // the honest capturedAt for the popover's "as of" line.
    const result = parseClaudeStatuslinePayload(payload, { capturedAt: Math.round(mtimeMs) });
    if (!result) {
      return;
    }

    const active = this.activeTaskForProviderSession("claude", result.providerSessionId);
    if (!active) {
      this.pendingClaudeUsage.set(result.providerSessionId, result.snapshot);
      return;
    }

    this.publishUsageSnapshot(active.task.id, result.snapshot);
    this.maybeApplyProviderSessionName(active.task.id, result.snapshot.sessionName);
  }

  private activeTaskForProviderSession(
    provider: RuntimeProvider,
    providerSessionId: string,
  ): ActiveTaskRuntime | null {
    for (const active of this.taskRuntimes.values()) {
      if (
        active.task.provider === provider &&
        active.task.providerSessionRef === providerSessionId
      ) {
        return active;
      }
    }
    return null;
  }

  private flushPendingClaudeUsage(active: ActiveTaskRuntime): void {
    const providerSessionRef = active.task.providerSessionRef;
    if (!providerSessionRef) {
      return;
    }
    const pending = this.pendingClaudeUsage.get(providerSessionRef);
    if (!pending) {
      return;
    }
    this.pendingClaudeUsage.delete(providerSessionRef);
    this.publishUsageSnapshot(active.task.id, pending);
    this.maybeApplyProviderSessionName(active.task.id, pending.sessionName);
  }

  private createProviderTranscript(
    taskId: TaskId,
    provider: RuntimeProvider,
    providerCwd: string,
    runIndex: RunIndex,
    discovery: { expectedSessionId?: string | null; allowMtimeFallback?: boolean } = {},
  ): ProviderTranscript {
    return new ProviderTranscript({
      taskId,
      provider,
      providerCwd,
      expectedSessionId: discovery.expectedSessionId ?? null,
      allowMtimeFallback: discovery.allowMtimeFallback ?? true,
      eventSink: (event) => this.handleRuntimeEvent(event, runIndex),
      resolveRunId: (input) => resolveRunForTurn(runIndex, input),
      externallyClaimedPaths: () => {
        const claimed = new Set<string>();
        for (const runtime of this.taskRuntimes.values()) {
          if (runtime.task.id === taskId) {
            continue;
          }
          for (const source of runtime.providerTranscript.sources()) {
            claimed.add(source.path);
          }
        }
        return claimed;
      },
    });
  }

  private persistTranscriptSources(active: ActiveTaskRuntime): void {
    const file: TranscriptSourcesFileV1 = {
      schemaId: TRANSCRIPT_SOURCES_SCHEMA_ID,
      version: TRANSCRIPT_SOURCES_SCHEMA_VERSION,
      taskId: active.task.id,
      sources: active.providerTranscript.sources(),
    };
    const filePath = transcriptSourcesPath(active.storageRoot);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(file, null, 2)}\n`);
    fs.renameSync(tmpPath, filePath);

    const latest = active.providerTranscript.sources().at(-1);
    const current = active.task.providerSessionRef;
    if (latest && current !== latest.providerSessionId) {
      if (current === null) {
        // First establishment — a fresh Task learning the id of the session
        // it just spawned. This is the only sanctioned binding write.
        active.task = {
          ...active.task,
          providerSessionRef: latest.providerSessionId,
          updatedAt: new Date().toISOString(),
        };
        this.persistTaskManifest(active.task, active.storageRoot);
      } else {
        // CAS backstop: an established Task may NOT be silently rebound to a
        // different session. Identity-scoped discovery should make this
        // unreachable; if it fires, the live process diverged (e.g. a hand
        // /resume to another conversation) — keep the original binding.
        console.warn(
          `[duet] suppressed session rebind for ${active.task.id}: bound=${current} located=${latest.providerSessionId}`,
        );
      }
    }
    this.flushPendingClaudeUsage(active);
  }

  private readTranscriptSources(storageRoot: string): TranscriptSourceRef[] {
    const filePath = transcriptSourcesPath(storageRoot);
    if (!fs.existsSync(filePath)) {
      return [];
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as TranscriptSourcesFileV1;
      if (
        parsed.schemaId !== TRANSCRIPT_SOURCES_SCHEMA_ID ||
        parsed.version !== TRANSCRIPT_SOURCES_SCHEMA_VERSION
      ) {
        return [];
      }
      return parsed.sources.filter((source) => fs.existsSync(source.path));
    } catch {
      return [];
    }
  }

  private nextTaskId(): TaskId {
    return `task-${Date.now()}-${++this.taskSeq}`;
  }

  /**
   * The ONE assembly of provider spawn options (contract §2: session-start
   * config is fully structured spawn args — S4 consolidation). createTask and
   * reopenTask both ride it; the split assembly is exactly how a resume once
   * silently dropped `runtimeDir` (D8) and broke busy/Stop/approval detection.
   */
  private buildStartOptions(args: {
    provider: RuntimeProvider;
    taskId: TaskId;
    cwd: string;
    model: string | null;
    reasoningEffort: ReasoningEffort | null;
    speedMode: LaunchSpeedMode | null;
    permissionSettings: {
      sandbox: CodexSandboxMode | null;
      approval: CodexApprovalMode | null;
      permissionMode: ClaudePermissionMode | null;
    };
    remoteControl: boolean;
    resumeRef?: string | null;
    sessionId?: string | null;
    extraEnv?: Record<string, string>;
    rows?: number | undefined;
    cols?: number | undefined;
  }): StartTaskOptions {
    return {
      cwd: args.cwd,
      // Claude's hooks/usage/settings live HERE (D8) — Duet-owned, outside the
      // agent's working directory, so nothing Duet writes into the user's repo
      // and the hook watcher (also keyed by runtimeDir) keeps seeing them —
      // on fresh spawn and resume alike.
      runtimeDir: runtimeDir(args.taskId),
      sandbox: args.permissionSettings.sandbox ?? "read-only",
      approval: args.permissionSettings.approval ?? "on-request",
      model: args.model,
      reasoningEffort: args.reasoningEffort,
      speedMode: args.speedMode,
      ...(args.provider === "claude"
        ? { permissionMode: args.permissionSettings.permissionMode ?? "default" }
        : {}),
      ...(args.provider === "claude" && args.remoteControl ? { remoteControl: true } : {}),
      ...(args.resumeRef ? { resumeRef: args.resumeRef } : {}),
      // --session-id pins a fresh session only; --resume already owns the id.
      ...(!args.resumeRef && args.sessionId ? { sessionId: args.sessionId } : {}),
      ...(args.extraEnv ? { extraEnv: args.extraEnv } : {}),
      ...(args.rows !== undefined ? { rows: args.rows } : {}),
      ...(args.cols !== undefined ? { cols: args.cols } : {}),
    };
  }

  private autoWorkspacePath(taskId: TaskId): string {
    // The user's VISIBLE work for a project-less session — kept cleanly separate
    // from Duet's hidden records (P1). The folder name is display-only; the stored
    // absolute path is the ground truth (never reverse-decoded). A LOCAL-date prefix
    // makes Finder's name-sort match time-sort; a short session id keeps it unique
    // and recognizable without depending on a title that isn't set yet at creation
    // (D7, Woody: "date + session id"). The counter only fires on the astronomically
    // rare same-id collision.
    const base = this.visibleWorkspacesDir();
    const name = `${localDateStamp()}-${shortSessionId(taskId)}`;
    const candidate = path.join(base, name);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
    for (let i = 2; ; i++) {
      const next = path.join(base, `${name}-${i}`);
      if (!fs.existsSync(next)) {
        return next;
      }
    }
  }

  private visibleWorkspacesDir(): string {
    return process.env.DUET_WORKSPACES_DIR || path.join(app.getPath("documents"), "Duet");
  }

  private normalizeDeliveryAttachments(
    active: ActiveTaskRuntime,
    attachments: DeliveryAttachment[],
  ): DeliveryAttachment[] {
    const attachmentDirectory = `${attachmentsRootForTask(active.task.id)}${path.sep}`;
    return attachments.map((attachment) => {
      const resolved = path.resolve(attachment.path);
      if (attachment.provenance === "blob") {
        // Duet-owned blob: MUST live inside the per-task attachments dir and be a
        // real image. (No space-reject — delivery double-quotes the path now.)
        if (!resolved.startsWith(attachmentDirectory)) {
          throw new Error("Attachment path was not a generated Duet attachment path.");
        }
        if (!fs.existsSync(resolved)) {
          throw new Error(`Attachment file is missing: ${attachment.originalName}`);
        }
        if (!normalizeImageMediaType(attachment.mediaType, attachment.originalName, fs.readFileSync(resolved))) {
          throw new Error(`Attachment is not a supported image: ${attachment.originalName}`);
        }
        return { ...attachment, path: resolved };
      }
      // Referenced: the user's own path, anywhere. It MUST exist; Duet NEVER reads
      // or deletes it. No image media re-read (it may be a huge file) and no
      // readFileSync on a folder — its kind was classified at attach time, and the
      // agent reads it with its own tools (it already has the user's FS authority).
      if (!fs.existsSync(resolved)) {
        throw new Error(`Attachment no longer exists: ${attachment.originalName}`);
      }
      return { ...attachment, path: resolved };
    });
  }

  private cleanupAttachments(_taskId: TaskId, attachments: DeliveryAttachment[]): void {
    for (const attachment of attachments) {
      // LOAD-BEARING for Invariant 4 — DO NOT REMOVE this guard. A referenced
      // IMAGE has kind:"image", so DeliveryController.enqueue (which splits by
      // kind, not provenance) keeps it in item.attachments; cancelling a queued
      // prompt then calls this with the user's ORIGINAL image. Only this
      // provenance check stops us from deleting it. (Referenced files/folders are
      // folded into the prompt text and never reach here; referenced images do.)
      if (attachment.provenance !== "blob") {
        continue;
      }
      fs.rmSync(attachment.path, { force: true });
    }
  }

  private resolveOpenTaskStorageRoot(request: OpenTaskRequest): string {
    if (request.taskId) {
      const candidate = projectRecordRoot(request.taskId);
      if (fs.existsSync(taskManifestPath(candidate))) {
        return candidate;
      }
    }
    if (request.cwd) {
      const cwd = path.resolve(request.cwd);
      const matchingTaskStorageRoot = this.findLatestTaskStorageRootForProviderCwd(cwd);
      if (matchingTaskStorageRoot) {
        return matchingTaskStorageRoot;
      }
      throw new Error("No persisted Duet Task was found for the selected folder.");
    }
    return this.latestTaskStorageRoot();
  }

  private latestTaskStorageRoot(): string {
    const candidates = this.taskManifestCandidates()
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const latest = candidates[0]?.storageRoot;
    if (!latest) {
      throw new TaskNotFoundError("No persisted Duet Task was found.");
    }
    return latest;
  }

  private findLatestTaskStorageRootForProviderCwd(cwd: string): string | null {
    const candidates = this.taskManifestCandidates()
      .filter((candidate) => {
        const providerCwd = taskProviderCwd(candidate.manifest.task, candidate.storageRoot);
        return pathsEqual(providerCwd, cwd);
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const latest = candidates[0]?.storageRoot;
    return latest ?? null;
  }

  private taskManifestCandidates(): Array<{
    storageRoot: string;
    manifest: TaskManifestV1;
    mtimeMs: number;
  }> {
    const projectRoot = projectsDataDir();
    const entries = fs.existsSync(projectRoot)
      ? fs.readdirSync(projectRoot, { withFileTypes: true })
      : [];
    const candidates: Array<{ storageRoot: string; manifest: TaskManifestV1; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const storageRoot = path.join(projectRoot, entry.name);
      const manifestPath = taskManifestPath(storageRoot);
      if (!fs.existsSync(manifestPath)) {
        continue;
      }
      try {
        candidates.push({
          storageRoot,
          manifest: this.readTaskManifest(storageRoot),
          mtimeMs: fs.statSync(manifestPath).mtimeMs,
        });
      } catch {
        // Ignore unsupported records while scanning for open candidates.
      }
    }
    return candidates;
  }

  private readTaskManifest(cwd: string): TaskManifestV1 {
    const manifestPath = taskManifestPath(cwd);
    if (!fs.existsSync(manifestPath)) {
      throw new TaskNotFoundError("Task manifest was not found.");
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as TaskManifestV1;
    if (
      manifest.schemaId !== TASK_MANIFEST_SCHEMA_ID ||
      manifest.version !== TASK_MANIFEST_SCHEMA_VERSION ||
      !SUPPORTED_PROVIDERS.has(manifest.task.provider)
    ) {
      throw new Error("Task manifest is not supported by this walking skeleton.");
    }
    return manifest;
  }

  private persistTaskManifest(task: Task, storageRoot: string): void {
    const manifest = freshTaskManifestV1(task);
    const manifestPath = taskManifestPath(storageRoot);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    const tmpPath = `${manifestPath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.renameSync(tmpPath, manifestPath);
    this.emitSessionsUpdated("session-updated");
  }

  private emitSessionsUpdated(
    reason:
      | "session-created"
      | "session-updated"
      | "session-renamed"
      | "session-archived"
      | "session-deleted"
      | "project-updated",
  ): void {
    this.sendEvent({
      type: "sessions:updated",
      payload: { reason },
      ts: new Date().toISOString(),
    });
  }

  private persistedSessionRecord(
    taskId: TaskId,
  ): { storageRoot: string; manifest: TaskManifestV1 } | null {
    const direct = projectRecordRoot(taskId);
    if (fs.existsSync(taskManifestPath(direct))) {
      try {
        return { storageRoot: direct, manifest: this.readTaskManifest(direct) };
      } catch {
        // Fall through to the scan for unreadable direct manifests.
      }
    }
    const candidate = this.taskManifestCandidates().find(
      (entry) => entry.manifest.task.id === taskId,
    );
    return candidate
      ? { storageRoot: candidate.storageRoot, manifest: candidate.manifest }
      : null;
  }

  private requirePersistedSession(taskId: TaskId): {
    storageRoot: string;
    manifest: TaskManifestV1;
  } {
    const record = this.persistedSessionRecord(taskId);
    if (!record) {
      throw new TaskNotFoundError("No persisted session matches the requested taskId.");
    }
    return record;
  }
}

// Records live DIRECTLY under the task's record root (~/.duet/data/projects/
// <taskId>/) — no nested `.duet`, which was redundant once the whole tree is
// Duet-owned and hidden (C6).

function taskManifestPath(recordRoot: string): string {
  return path.join(recordRoot, "task.json");
}

function runtimeReportPath(recordRoot: string): string {
  return path.join(recordRoot, "runtime-report.json");
}

function transcriptSourcesPath(recordRoot: string): string {
  return path.join(recordRoot, "transcript-sources.json");
}

function normalizeImageMediaType(mediaType: string, originalName: string, bytes: Buffer): string | null {
  const sniffed = sniffImageMediaType(bytes);
  if (sniffed) {
    return sniffed;
  }
  const loweredMediaType = mediaType.toLowerCase();
  if (SUPPORTED_IMAGE_MEDIA_TYPES.has(loweredMediaType)) {
    return loweredMediaType;
  }
  const ext = path.extname(originalName).toLowerCase();
  return IMAGE_EXTENSION_MEDIA_TYPES.get(ext) ?? null;
}

function sniffImageMediaType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    (bytes.subarray(0, 6).toString("ascii") === "GIF87a" ||
      bytes.subarray(0, 6).toString("ascii") === "GIF89a")
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function imageExtension(mediaType: string): string {
  if (mediaType === "image/jpeg") {
    return ".jpg";
  }
  return `.${mediaType.replace("image/", "")}`;
}

// Cap on reading an image reference back for a chip thumbnail. Over this, the
// chip falls back to a kind icon (the agent still reads the file itself).
const REFERENCE_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;
const SUPPORTED_IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const IMAGE_EXTENSION_MEDIA_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

function assertSupportedProvider(provider: RuntimeProvider): void {
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new Error(`Unsupported Task provider: ${provider}`);
  }
}

function normalizeTaskForProviderCwd(task: Task, providerCwd: string): Task {
  const launchSettings = normalizeLaunchSettings(task.provider, task);
  const permissionSettings = normalizePermissionSettings(task.provider, task);
  return {
    ...task,
    model: launchSettings.model,
    reasoningEffort: launchSettings.reasoningEffort,
    speedMode: launchSettings.speedMode,
    sandbox: permissionSettings.sandbox,
    approval: permissionSettings.approval,
    permissionMode: permissionSettings.permissionMode,
    providerCwd,
    workingDirectory: providerCwd,
  };
}

/** YYYY-MM-DD in LOCAL time — so the auto-workspace name-sorts as time-sorts. */
function localDateStamp(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * A short, unique session id for the auto-workspace folder name — base36 of the
 * taskId's creation timestamp (matches the codebase's short-id convention, e.g.
 * the hook sink). Compact and recognizable; the manifest's stored providerCwd is
 * the ground truth, so this never needs to be decoded back to a taskId.
 */
function shortSessionId(taskId: string): string {
  const match = /^task-(\d+)-\d+$/.exec(taskId);
  const ms = match ? Number(match[1]) : NaN;
  return Number.isFinite(ms) ? ms.toString(36) : taskId.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function taskProviderCwd(task: Task, storageRoot: string): string {
  return path.resolve(task.providerCwd || task.workingDirectory || storageRoot);
}

function mergeUsageSnapshot(previous: UsageSnapshot | null, next: UsageSnapshot): UsageSnapshot {
  if (!previous || previous.provider !== next.provider) {
    return next;
  }
  // A partial snapshot (context-only or limits-only) refines, never erases:
  // an absent section means "not in this payload", not "gone".
  return {
    ...next,
    context: next.context ?? previous.context,
    limits: next.limits.length > 0 ? next.limits : previous.limits,
    sessionName: next.sessionName ?? previous.sessionName ?? null,
    costUsd: next.costUsd ?? previous.costUsd ?? null,
    modelDisplayName: next.modelDisplayName ?? previous.modelDisplayName ?? null,
    reasoningEffort: next.reasoningEffort ?? previous.reasoningEffort ?? null,
  };
}

function hasUsageData(snapshot: UsageSnapshot): boolean {
  // Model display counts as signal (S6.5): the startup payload is often
  // model-only ($0 cost, no context yet) and must still publish so the live
  // model chip follows the statusline from the first event.
  return Boolean(
    snapshot.context ||
      snapshot.limits.length > 0 ||
      typeof snapshot.costUsd === "number" ||
      snapshot.modelDisplayName,
  );
}

function pathsEqual(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function normalizeLaunchSettings(
  provider: RuntimeProvider,
  request: {
    model?: string | null;
    reasoningEffort?: ReasoningEffort | null;
    speedMode?: LaunchSpeedMode | null;
  },
): { model: string | null; reasoningEffort: ReasoningEffort | null; speedMode: LaunchSpeedMode | null } {
  const model = request.model?.trim() || null;
  const requestedReasoningEffort = request.reasoningEffort ?? null;
  const reasoningEffort = REASONING_EFFORTS.has(requestedReasoningEffort as ReasoningEffort)
    ? (requestedReasoningEffort as ReasoningEffort)
    : null;
  const speedMode =
    provider === "codex" && (request.speedMode === "default" || request.speedMode === "fast")
      ? request.speedMode
      : null;

  return {
    model,
    reasoningEffort,
    speedMode,
  };
}

function normalizePermissionSettings(
  provider: RuntimeProvider,
  request: {
    sandbox?: CodexSandboxMode | null;
    approval?: CodexApprovalMode | null;
    permissionMode?: ClaudePermissionMode | null;
  },
): {
  sandbox: CodexSandboxMode | null;
  approval: CodexApprovalMode | null;
  permissionMode: ClaudePermissionMode | null;
} {
  if (provider === "claude") {
    const permissionMode = CLAUDE_PERMISSION_MODES.has(
      request.permissionMode as ClaudePermissionMode,
    )
      ? (request.permissionMode as ClaudePermissionMode)
      : "default";
    return {
      sandbox: null,
      approval: null,
      permissionMode,
    };
  }

  const sandbox = CODEX_SANDBOX_MODES.has(request.sandbox as CodexSandboxMode)
    ? (request.sandbox as CodexSandboxMode)
    : "read-only";
  const approval = CODEX_APPROVAL_MODES.has(request.approval as CodexApprovalMode)
    ? (request.approval as CodexApprovalMode)
    : "on-request";
  return {
    sandbox,
    approval,
    permissionMode: null,
  };
}

function taskStatusFromRunStatus(status: RunStatus): Task["status"] {
  if (status === "active" || status === "resumed-after-approval") {
    return "running";
  }
  if (status === "waiting-for-approval") {
    return "waiting-for-approval";
  }
  if (status === "stopping") {
    return "stopping";
  }
  if (status === "stopped") {
    return "stopped";
  }
  if (status === "failed" || status === "pty-exited") {
    return "failed";
  }
  return "idle";
}

// ── Hook-broker approval helpers (S2) ────────────────────────────────────────

function toolInputRecord(payload: ClaudeHookPayload): Record<string, unknown> {
  const input = payload.tool_input;
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/** Map the hook's tool to Duet's ApprovalKind (mirrors the scrape grammar). */
function classifyApprovalKind(payload: ClaudeHookPayload): ApprovalKind {
  const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
  if (tool === "Bash") return "command";
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit")
    return "file-edit";
  if (tool === "Read" || tool === "NotebookRead") return "file-read";
  return "unknown";
}

/** The one-line "what the agent wants to do", from tool_name/tool_input. */
function approvalSummary(payload: ClaudeHookPayload): string {
  const tool = typeof payload.tool_name === "string" ? payload.tool_name : "tool";
  const input = toolInputRecord(payload);
  const str = (key: string): string | null =>
    typeof input[key] === "string" ? (input[key] as string) : null;
  if (tool === "Bash") return `Run  ${truncateMiddle(str("command") ?? "(command)", 80)}`;
  const filePath = str("file_path") ?? str("path") ?? str("notebook_path");
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit")
    return `Edit  ${truncateMiddle(filePath ?? "(file)", 72)}`;
  if (tool === "Read" || tool === "NotebookRead")
    return `Read  ${truncateMiddle(filePath ?? "(file)", 72)}`;
  return `${tool}${filePath ? `  ${truncateMiddle(filePath, 72)}` : ""}`;
}

function truncateMiddle(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${clean.slice(0, head)}…${clean.slice(clean.length - tail)}`;
}

/**
 * The three fixed choices on a hook-broker card (answered via the reply file).
 * The "Always" label/description states the ACTUAL persisted rule, not a vague
 * "this command" — because for Bash the rule is `Bash(<firstToken>:*)`
 * (approving `git status` allows all git commands; the label renders it as
 * "git *" for humans). The button must not promise narrower than it grants
 * (reviewer P2, trust boundary).
 */
function brokerApprovalChoices(kind: ApprovalKind, payload: ClaudeHookPayload): ApprovalChoice[] {
  const scope = alwaysAllowScopeLabel(kind, payload); // e.g. "git *", "edits", "reads"
  // encodedAs "reply-file": these choices answer on the hook channel — no
  // bytes ever touch the PTY (S6 review P3; the decision event says the
  // same, so the report's provenance is consistent end to end).
  return [
    { decision: "approve", label: "Approve", description: "Allow once", encodedAs: "reply-file" },
    {
      decision: "approve-always",
      label: scope ? `Always: ${scope}` : "Always",
      description: scope ? `Persist an allow rule for ${scope}` : "Always allow",
      encodedAs: "reply-file",
    },
    { decision: "deny", label: "Deny", description: "Reject this request", encodedAs: "reply-file" },
  ];
}

/** Human label for what "Always" actually persists — matches `alwaysAllowRule`. */
function alwaysAllowScopeLabel(kind: ApprovalKind, payload: ClaudeHookPayload): string | null {
  if (kind === "command") {
    const command = typeof toolInputRecord(payload).command === "string"
      ? (toolInputRecord(payload).command as string).trim()
      : "";
    const firstToken = command.split(/\s+/, 1)[0] ?? "";
    return firstToken ? `${firstToken} *` : null;
  }
  if (kind === "file-edit") return "edits";
  if (kind === "file-read") return "reads";
  return null;
}

/**
 * Build the PermissionRequest decision JSON the broker emits to the CLI
 * (P1-verified schema). "Always" adds a persistent allow rule via
 * updatedPermissions — next-turn semantics (Woody, 2026-07-02): the rule
 * persists so subsequent matching calls skip the prompt.
 */
function brokerDecisionJson(decision: ApprovalDecision, payload: ClaudeHookPayload): unknown {
  const out = (d: Record<string, unknown>): unknown => ({
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: d },
  });
  if (decision === "deny") {
    return out({ behavior: "deny" });
  }
  if (decision === "approve-always") {
    const rule = alwaysAllowRule(payload);
    return out(rule ? { behavior: "allow", updatedPermissions: [rule] } : { behavior: "allow" });
  }
  // approve / approve-for-session → allow once
  return out({ behavior: "allow" });
}

/** A conservative "always allow" rule from the tool call (tunable). */
function alwaysAllowRule(payload: ClaudeHookPayload): Record<string, unknown> | null {
  const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const input = toolInputRecord(payload);
  if (tool === "Bash") {
    const command = typeof input.command === "string" ? input.command.trim() : "";
    const firstToken = command.split(/\s+/, 1)[0] ?? "";
    if (!firstToken) return null;
    return {
      type: "addRules",
      // Claude's prefix syntax is COLON-star: `Bash(touch:*)` matches every
      // touch command; `Bash(touch *)` (space) is a literal exact-match that
      // never fires — the S6 rule-timing probe found the Always button had
      // been persisting exactly that dead form. With the colon form the rule
      // applies IMMEDIATELY (same-turn follow-up calls stop asking) —
      // p1-intercept always-variant, 2.1.198.
      rules: [{ toolName: "Bash", ruleContent: `${firstToken}:*` }],
      behavior: "allow",
      destination: "projectSettings",
    };
  }
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit") {
    return {
      type: "addRules",
      rules: [{ toolName: tool }],
      behavior: "allow",
      destination: "projectSettings",
    };
  }
  if (tool === "Read" || tool === "NotebookRead") {
    return {
      type: "addRules",
      rules: [{ toolName: tool }],
      behavior: "allow",
      destination: "projectSettings",
    };
  }
  return null;
}
