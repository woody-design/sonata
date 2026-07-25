import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import type {
  DeliveryAttachment,
  ReferenceResult,
  ApprovalDecision,
  ApprovalKind,
  ApprovalChoice,
  ClaudePermissionMode,
  CodexPermissionMode,
  CreateTaskRequest,
  CreateTaskResponse,
  LaunchSpeedMode,
  OpenTaskRequest,
  ReadSessionIndexRequest,
  ReadSlashCommandsRequest,
  ReadTranscriptResponse,
  ReasoningEffort,
  RenameProjectResponse,
  RenameSessionResponse,
  RunId,
  RunStatus,
  RuntimeEvent,
  RuntimeProvider,
  RuntimeReportUpdatedEvent,
  SessionIndexResponse,
  SessionSnapshotResponse,
  SlashCommandsResponse,
  TagDefinition,
  TagGroup,
  Task,
  TaskId,
  UsageSnapshot,
} from "../shared/types";
import { TaskNotFoundError, TaskNotLiveError } from "./errors";
import {
  codexPermissionModeFromTurnContext,
  isCodexPermissionMode,
  migrateCodexPermissionMode,
} from "../shared/types";
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
  type RuntimeReportSummaryV1,
  type RuntimeReportV1,
  type TaskManifestV1,
} from "../shared/schemas";
import {
  DeliveryController,
  ProviderTranscript,
  RunIndex,
  isRunIndexEvent,
  resolveRunForTurn,
  changedPathsFromToolUse,
  parseApplyPatchOps,
  TerminalHost,
  type StartTaskOptions,
  ClaudeStatuslineUsageWatcher,
  HookWatcher,
  claudeHooksDirectory,
  ApprovalWatcher,
  writeApprovalReply,
  type ApprovalAsk,
  approvalsDirectory,
  EXPIRED_PREFIX,
  codexBrokerDecisionJson,
  enableCodexAnswering,
  disableCodexAnswering,
  CliStateModel,
  parseClaudeStatuslinePayload,
  parseOptionPrompt,
  reconcileOptionPromptAnswers,
  optionPromptAnswerSequence,
  optionPromptDismissSequence,
  readClaudeResumeStats,
  StatusRegionTracker,
} from "../runtime";
import { buildSessionIndex } from "./session-index";
import { TaskMirror } from "./task-mirror";
import { SessionMetadataService } from "./session-metadata";
import { ensureClaudeProjectTrust, updateClaudeConfig } from "./claude-config";
import {
  projectRecordRoot,
  projectsDataDir,
  runtimeDir,
  sonataBinDir,
  attachmentsRootForTask,
} from "./sonata-paths";
import { listSlashCommands as discoverSlashCommands } from "./skills-discovery";
import type { ProjectsStore } from "./projects-store";
import type { TagsStore } from "./tags-store";
import type {
  ResumeSettingsStore,
  ClaudeSettingsStore,
  CodexSettingsStore,
  SonataSettingsStore,
} from "./settings-store";
import type { ClaudeSettings } from "../shared/types/claude-settings";
import type { CodexSettings } from "../shared/types/codex-settings";
import type { SonataSettings } from "../shared/types/sonata-settings";
import type { HookPayload, CliStateSnapshot } from "../shared/types/cli-signal";
import type { OptionPrompt, OptionPromptSelection } from "../shared/types/option-prompt";
import {
  RESUME_PROMPT_MIN_IDLE_MS,
  RESUME_PROMPT_MIN_TOKENS,
  type ResumeSettings,
} from "../shared/types/resume-settings";
import type {
  ClaudeControlSwitchKind,
  ClaudeControlSwitchResponse,
  PrepareResumeResponse,
  RemoteControlInjectResponse,
  ResumeSettingsResponse,
  RevertResumeBridgeResponse,
  TerminalReplaySnapshot,
} from "../shared/types/ipc";
import {
  adoptAutomaticSessionTitle,
  initialSessionTitle,
} from "../shared/session-title";
import os from "node:os";

// Undocumented but botmux-proven per-process levers (research §2.1). Both
// force the full-session path, which is exactly what we want: the panel
// never renders in the hidden PTY; Sonata owns the choice. Version-fragile —
// the ambient modal detector (slice B) remains the net if they drift.
const RESUME_PANEL_SUPPRESS_ENV: Record<string, string> = {
  CLAUDE_CODE_RESUME_THRESHOLD_MINUTES: "999999999",
  CLAUDE_CODE_RESUME_TOKEN_THRESHOLD: "999999999",
};
// Codex hooks-liveness window (S2; D4 overturned 2026-07-06 — hooks now bypass
// trust review, so they fire on every spawn): how long after the session's
// FIRST prompt submission (not spawn — SessionStart is lazy, arriving with
// the first UserPromptSubmit; probed 0.144.4/0.144.5) we wait for the
// `SessionStart` handshake before concluding the hook shim failed to fire
// (e.g. its interpreter isn't on PATH). Sized against the submit→handshake
// gap, not boot latency; a late handshake still clears it. Known blind spot,
// accepted: a broken shim in a session driven ONLY from the co-visible
// Terminal (no Sonata submission) is never probed — the spawn-anchored
// window that would have caught it false-alarmed every >12s pre-prompt pause.
const CODEX_HOOKS_LIVENESS_WINDOW_MS = 12_000;
const SUPPORTED_PROVIDERS = new Set<RuntimeProvider>(["codex", "claude"]);
const REASONING_EFFORTS = new Set<ReasoningEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
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
  tagsStore: TagsStore;
  resumeSettingsStore: ResumeSettingsStore;
  claudeSettingsStore: ClaudeSettingsStore;
  codexSettingsStore: CodexSettingsStore;
  sonataSettingsStore: SonataSettingsStore;
  /**
   * Dev-gated per-flush instrumentation sink (OBS S9 / P6), threaded into every
   * live RunIndex so a build-storm's flush duration + serialized size land in the
   * AD-2 tripwire evidence stream. Absent in normal use (the perf log is off).
   */
  onFlushMetrics?: (metric: { name: string; durationMs: number; bytes: number }) => void;
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
  /** How the LAST option prompt resolved (drawer S1) — the corroboration wait
   *  reads this to distinguish "the CLI accepted the answers" (PostToolUse,
   *  answered=true) from a fallback clear (Stop/pty-exit, answered=false) so a
   *  swallowed injection can never false-confirm as a sent answer. */
  lastOptionPromptResolution: { toolUseId: string; answered: boolean } | null;
  /**
   * Legacy-only compatibility: the last automatically applied undated title.
   * New tasks persist titleOrigin; old manifests deliberately retain their
   * process-local auto-title semantics instead of being migrated on resume.
   */
  autoTitle: string | null;
}

export class RuntimeController {
  private readonly sendEvent: (event: RuntimeEvent) => void;
  private readonly projectsStore: ProjectsStore;
  private readonly tagsStore: TagsStore;
  private readonly resumeSettingsStore: ResumeSettingsStore;
  private readonly claudeSettingsStore: ClaudeSettingsStore;
  private readonly codexSettingsStore: CodexSettingsStore;
  private readonly sonataSettingsStore: SonataSettingsStore;
  private readonly onFlushMetrics?: (metric: { name: string; durationMs: number; bytes: number }) => void;
  private readonly claudeUsageWatcher: ClaudeStatuslineUsageWatcher;
  /** Provider-neutral now (S2): the same sink layout (`runtimeDir/hooks`) serves
   *  Claude AND Codex, so ONE watcher observes both — routed to the task by the
   *  runtime dir it saw the payload under. */
  private readonly hookWatcher: HookWatcher;
  private readonly approvalWatcher: ApprovalWatcher;
  /** Codex hooks-liveness (S2): the SessionStart handshake is the effect-check
   *  that Codex's injected hooks are trusted and firing. Per codex task, a
   *  timer armed at spawn + a 3-state status: `pending` (window open), `missing`
   *  (banner raised), `alive` (handshake seen). Cleared on the handshake, PTY
   *  exit, or teardown. */
  private readonly codexHookLiveness = new Map<
    TaskId,
    { timer: NodeJS.Timeout | null; status: "pending" | "missing" | "alive" }
  >();
  /** Live hook-broker approvals awaiting a card answer, keyed by broker id →
   *  the task + payload needed to build the reply decision, plus the
   *  detected event built ONCE at ask arrival (its ts/runId are the honest
   *  arrival-time facts; re-sent verbatim when the card's turn comes). */
  private readonly pendingBrokerApprovals = new Map<
    string,
    { taskId: TaskId; payload: HookPayload; event: RuntimeEvent }
  >();
  /** Per task, the broker approvalId whose card is currently shown — enforces
   *  one card at a time; the rest queue (P3). */
  private readonly shownBrokerApproval = new Map<TaskId, string>();
  /** Per task: broker asks that TIMED OUT (id → detected kind) and degraded to
   *  the CLI's native card, awaiting conclusion at turn-end. For CLAUDE the
   *  scrape re-detects the native card and emits `approval:decision`
   *  (answered-natively) to release the delivery gate + expiry banner; CODEX
   *  has no scrape (S4 funeral), so nothing else would ever clear those — the
   *  keyed delivery gate would wedge every later send and the "Waiting in the
   *  terminal" banner would ride forever. We remember them here and conclude
   *  them at turn-end (the turn cannot end while a native card still blocks, so
   *  turn-end PROVES the card was resolved). Populated for codex only. */
  private readonly expiredBrokerApprovals = new Map<TaskId, Map<string, ApprovalKind>>();
  private readonly taskRuntimes = new Map<TaskId, ActiveTaskRuntime>();
  private readonly taskMirror = new TaskMirror(
    (task, storageRoot) => this.persistTaskManifest(task, storageRoot),
    (event) => this.sendEvent(event),
  );
  private readonly sessionMetadata: SessionMetadataService;
  private readonly usageSnapshots = new Map<TaskId, UsageSnapshot>();
  private readonly pendingClaudeUsage = new Map<string, UsageSnapshot>();
  private taskSeq = 0;
  private attachmentSeq = 0;

  constructor(options: RuntimeControllerOptions) {
    this.sendEvent = options.sendEvent;
    this.projectsStore = options.projectsStore;
    this.tagsStore = options.tagsStore;
    this.resumeSettingsStore = options.resumeSettingsStore;
    this.claudeSettingsStore = options.claudeSettingsStore;
    this.codexSettingsStore = options.codexSettingsStore;
    this.sonataSettingsStore = options.sonataSettingsStore;
    if (options.onFlushMetrics) {
      this.onFlushMetrics = options.onFlushMetrics;
    }
    this.claudeUsageWatcher = new ClaudeStatuslineUsageWatcher({
      onPayload: (payload, _filePath, mtimeMs) =>
        this.handleClaudeStatuslinePayload(payload, mtimeMs),
      onError: (error, filePath) => {
        console.debug(
          `[usage] skipped Claude statusline payload${filePath ? ` ${filePath}` : ""}: ${error.message}`,
        );
      },
    });
    this.hookWatcher = new HookWatcher({
      // The sink layout is provider-NEUTRAL: `runtimeDir/hooks` for both. Codex's
      // sink writes the identical tmp+rename `hook-*.json` protocol into the same
      // subdir (codexHooksDirectory computes the same path); claudeHooksDirectory
      // is reused here as that one resolver, not as a Claude-specific one.
      sinkDir: claudeHooksDirectory,
      onPayload: (payload, workspace) => this.handleHookPayload(payload, workspace),
      onError: (error, filePath) => {
        console.debug(
          `[signal] skipped hook payload${filePath ? ` ${filePath}` : ""}: ${error.message}`,
        );
      },
    });
    this.approvalWatcher = new ApprovalWatcher({
      onAsk: (ask, workspace) => this.handleApprovalAsk(ask, workspace),
      onExpired: (id, workspace) => this.handleApprovalExpired(id, workspace),
      onError: (error, filePath) => {
        console.debug(
          `[approval] skipped broker file${filePath ? ` ${filePath}` : ""}: ${error.message}`,
        );
      },
    });
    // Constructed in the body (not a field initializer): the service takes
    // `tagsStore` by value, which is assigned just above.
    this.sessionMetadata = new SessionMetadataService(
      {
        liveSession: (taskId) => this.taskRuntimes.get(taskId) ?? null,
        liveTasks: () => {
          const tasks = new Map<TaskId, Task>();
          for (const active of this.taskRuntimes.values()) {
            tasks.set(active.task.id, active.task);
          }
          return tasks;
        },
        requirePersistedSession: (taskId) => this.requirePersistedSession(taskId),
        manifestCandidates: () => this.taskManifestCandidates(),
        persistManifest: (task, storageRoot, reason, emitUpdate) =>
          this.persistTaskManifest(task, storageRoot, reason, emitUpdate),
        emitSessionsUpdated: (reason) => this.emitSessionsUpdated(reason),
        sendEvent: (event) => this.sendEvent(event),
        retireLiveSession: (session) => this.retireTaskRuntime(session as ActiveTaskRuntime),
      },
      this.tagsStore,
    );
  }

  createTask(request: CreateTaskRequest): CreateTaskResponse {
    assertSupportedProvider(request.provider);

    const creationInstant = new Date();
    const now = creationInstant.toISOString();
    const taskId = this.nextTaskId();
    const initialTitle = initialSessionTitle(request.title, creationInstant);
    // Sonata's own records live under ~/.sonata (hidden, Sonata-owned), keyed by taskId
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
      // born with was designated by the user in Sonata's own UI — picked in the
      // folder dialog, chosen from recents / a project row, carried over as
      // the last-used folder — or is the auto workspace Sonata itself just
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
    const launchSettings = normalizeLaunchSettings(request);
    // New sessions inherit the Sonata-owned default approval policy (Settings →
    // Approvals for Claude, Settings → Codex for Codex) unless the request
    // names one explicitly. This is the "set it once" that keeps a trusted
    // session from prompting on every tool call / command.
    const permissionRequest =
      request.provider === "claude" && request.permissionMode == null
        ? { ...request, permissionMode: this.claudeSettingsStore.read().defaultPermissionMode }
        : request.provider === "codex" && request.codexPermissionMode == null
          ? {
              ...request,
              codexPermissionMode: this.codexSettingsStore.read().defaultPermissionMode,
            }
          : request;
    const permissionSettings = normalizePermissionSettings(
      request.provider,
      permissionRequest,
    );

    if (request.cwd) {
      this.projectsStore.noteFolderUsed(providerCwd);
    }

    const task: Task = {
      id: taskId,
      ...initialTitle,
      provider: request.provider,
      model: launchSettings.model,
      reasoningEffort: launchSettings.reasoningEffort,
      speedMode: launchSettings.speedMode,
      codexPermissionMode: permissionSettings.codexPermissionMode,
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

    const runIndex = new RunIndex({
      taskId,
      reportPath,
      notify: (summary, runsChanged) => this.broadcastReportUpdated(summary, runsChanged),
      ...(this.onFlushMetrics ? { onFlushMetrics: this.onFlushMetrics } : {}),
    });
    // Pin a fresh Claude session to an id we choose, so the Task's binding is
    // known at birth — discovery confirms this exact id instead of guessing
    // the newest jsonl in the cwd. NO mtime fallback for EITHER provider now
    // (Claude 2026-07-03; Codex S2): two same-cwd sessions in concurrent
    // discovery could each adopt the OTHER's freshest transcript before either
    // had claimed its own — and persistTranscriptSources then anchored the
    // wrong identity permanently. Identity comes from the per-task hook
    // handshake (adoptTranscriptFromHook): identity-carrying, task-scoped,
    // never a guess. Codex cannot pin its id up front (no --session-id flag),
    // so it relies wholly on the SessionStart handshake — and the liveness
    // banner surfaces an untrusted session where that handshake never fires.
    const pinnedSessionId = request.provider === "claude" ? randomUUID() : undefined;
    // The task goes `running` the moment we spawn its PTY. updatedAt is stamped
    // here (just before startTask, folded into the shared assembly) rather than
    // just after — a sub-millisecond shift on a brand-new record.
    const runningTask: Task = {
      ...task,
      status: "running",
      updatedAt: new Date().toISOString(),
    };
    const ptyStartedAt = new Date().toISOString();
    const activeTask = this.assembleTaskRuntime({
      task: runningTask,
      storageRoot,
      providerCwd,
      runIndex,
      reportPath,
      expectedSessionId: pinnedSessionId ?? null,
      startOptions: this.buildStartOptions({
        provider: request.provider,
        taskId,
        cwd: providerCwd,
        model: launchSettings.model,
        reasoningEffort: launchSettings.reasoningEffort,
        speedMode: launchSettings.speedMode,
        permissionSettings,
        remoteControl: Boolean(request.remoteControl),
        sessionId: pinnedSessionId ?? null,
        pretrustCwd: this.codexPretrustCwd(request.provider, autoWorkspace, providerCwd),
        rows: request.rows,
        cols: request.cols,
      }),
    });
    activeTask.providerTranscript.startDiscovery(ptyStartedAt);

    return {
      task: activeTask.task,
      runtime: activeTask.runtime,
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
      codexPermissionMode: request.codexPermissionMode ?? task.codexPermissionMode,
      permissionMode: request.permissionMode ?? task.permissionMode,
    });
    const runningTask = {
      ...task,
      codexPermissionMode: permissionSettings.codexPermissionMode,
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
      notify: (summary, runsChanged) => this.broadcastReportUpdated(summary, runsChanged),
      ...(this.onFlushMetrics ? { onFlushMetrics: this.onFlushMetrics } : {}),
    });
    // Resume: discovery must confirm the resumed id by identity and never
    // fall back to the freshest jsonl — that fallback is exactly how a
    // hand-driven /resume to a sibling conversation hijacked the binding.
    // No-resume reopen (session gone / resume disabled) pins a fresh Claude id;
    // NEITHER provider gets an mtime fallback now (same same-cwd race as
    // createTask; the hook handshake is the safety net — Codex S2).
    const pinnedSessionId =
      !resumeRef && runningTask.provider === "claude" ? randomUUID() : undefined;
    // Sonata owns the resume moment (slice C): the interstitial is suppressed
    // per-spawn for every Claude resume — the choice happened (or the
    // policy applied) BEFORE the spawn, in Sonata's own UI, from Sonata's own
    // numbers. Per-spawn env, never a ~/.claude.json write.
    const claudeResume = runningTask.provider === "claude" && Boolean(resumeRef);
    const ptyStartedAt = new Date().toISOString();
    const activeTask = this.assembleTaskRuntime({
      task: runningTask,
      storageRoot,
      providerCwd,
      runIndex,
      reportPath,
      // Resume confirms the resumed id by identity; a no-resume reopen confirms
      // the freshly-pinned Claude id. Never an mtime fallback (same same-cwd
      // race as createTask; the hook handshake is the safety net — Codex S2).
      expectedSessionId: resumeRef ?? pinnedSessionId ?? null,
      startOptions: this.buildStartOptions({
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
        // A reopen adds no fresh trust gesture, but the ledger is idempotent: it
        // re-adds an already-trusted cwd under the same policy (auto-workspace, or
        // the opt-in setting) and carries forward every still-live grant.
        pretrustCwd: this.codexPretrustCwd(
          runningTask.provider,
          Boolean(runningTask.autoWorkspace),
          providerCwd,
        ),
        ...(claudeResume ? { extraEnv: RESUME_PANEL_SUPPRESS_ENV } : {}),
        rows: request.rows,
        cols: request.cols,
      }),
    });

    if (claudeResume && request.resumeMode === "summary") {
      // The panel's option 1, made explicit and receipted: /compact runs
      // first, ahead of anything the user queued, and shows up in the
      // delivery queue as its own item.
      activeTask.deliveryController.enqueue("/compact");
    }

    for (const source of persistedSources) {
      // Both CLIs append to the same session file on resume — the
      // re-attached chain tip must stay tailed for live updates.
      activeTask.providerTranscript.attachExistingSource(source, { tail: Boolean(resumeRef) });
    }
    activeTask.providerTranscript.startDiscovery(ptyStartedAt);

    this.emitReportUpdated(activeTask.runIndex);

    return {
      task: activeTask.task,
      runtime: activeTask.runtime,
      resumedProviderSession: Boolean(resumeRef),
    };
  }

  /**
   * The assembly choreography shared by createTask and openTask: build the
   * provider transcript, terminal host, delivery controller, status tracker and
   * CLI-state model on one running task, spawn the PTY, register + watch +
   * persist the runtime. This is the ONE construction site for TerminalHost /
   * DeliveryController — any future constructor-injection (settings, tags) is
   * threaded here, not duplicated across the two entry points. The callers own
   * only their own deltas (the pinned/resume session id, the start options they
   * built) and the post-assembly work: startDiscovery is caller-driven so
   * openTask can attach its resumed sources first.
   */
  private assembleTaskRuntime(params: {
    task: Task;
    storageRoot: string;
    providerCwd: string;
    runIndex: RunIndex;
    reportPath: string;
    expectedSessionId: string | null;
    startOptions: StartTaskOptions;
  }): ActiveTaskRuntime {
    const { task, storageRoot, providerCwd, runIndex, reportPath, expectedSessionId, startOptions } =
      params;
    const providerTranscript = this.createProviderTranscript(
      task.id,
      task.provider,
      providerCwd,
      runIndex,
      {
        expectedSessionId,
        allowMtimeFallback: false,
      },
    );
    const terminalHost = new TerminalHost({
      taskId: task.id,
      provider: task.provider,
      defaultWorkspace: providerCwd,
      eventSink: (event) => this.handleRuntimeEvent(event, runIndex),
    });
    const deliveryController = new DeliveryController({
      taskId: task.id,
      provider: task.provider,
      terminalHost,
      eventSink: (event) => this.sendEvent(event),
      hasLiveTranscriptSource: () => providerTranscript.hasLiveSource(),
    });
    const statusTracker = new StatusRegionTracker({
      taskId: task.id,
      provider: task.provider,
      eventSink: (event) => this.sendEvent(event),
    });
    const cliState = new CliStateModel((snapshot) => this.emitCliState(task.id, snapshot));

    const runtime = terminalHost.startTask(startOptions);

    const activeTask: ActiveTaskRuntime = {
      task,
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
      lastOptionPromptResolution: null,
      autoTitle: null,
    };
    this.taskRuntimes.set(activeTask.task.id, activeTask);
    this.watchClaudeUsage(activeTask);
    this.watchHooks(activeTask);
    this.persistTaskManifest(activeTask.task, activeTask.storageRoot);
    return activeTask;
  }

  closeTask(taskId: TaskId): void {
    const active = this.requireTaskRuntime(taskId);
    this.retireTaskRuntime(active);
  }

  /**
   * Pre-spawn resume context (slice C): whether the resume moment needs
   * the inline choice, with the cost numbers the native panel would have
   * shown — computed from Sonata's own data before any PTY exists.
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

  readCodexSettings(): CodexSettings {
    return this.codexSettingsStore.read();
  }

  writeCodexSettings(settings: unknown): CodexSettings {
    return this.codexSettingsStore.write(settings);
  }

  readSonataSettings(): SonataSettings {
    return this.sonataSettingsStore.read();
  }

  writeSonataSettings(settings: unknown): SonataSettings {
    return this.sonataSettingsStore.write(settings);
  }

  /**
   * Removes the temporary `resumeReturnDismissed: true` bridge from
   * ~/.claude.json, only on an explicit click. Inside Sonata the panel is
   * suppressed per-spawn regardless; this restores Claude's own warning
   * for terminals OUTSIDE Sonata. Rides the shared `updateClaudeConfig`
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

  // Tags / rename / archive facade → SessionMetadataService (thin IPC delegation).
  renameSession(taskId: TaskId, title: string): RenameSessionResponse {
    return this.sessionMetadata.renameSession(taskId, title);
  }

  archiveSession(taskId: TaskId, archived: boolean): void {
    this.sessionMetadata.archiveSession(taskId, archived);
  }

  setSessionTags(taskId: TaskId, tagIds: string[]): void {
    this.sessionMetadata.setSessionTags(taskId, tagIds);
  }

  listTags(): TagDefinition[] {
    return this.sessionMetadata.listTags();
  }

  createTag(label: string, group: TagGroup): TagDefinition {
    return this.sessionMetadata.createTag(label, group);
  }

  deleteTag(id: string): void {
    this.sessionMetadata.deleteTag(id);
  }

  deleteSession(taskId: TaskId): void {
    const live = this.taskRuntimes.get(taskId);
    if (live) {
      // Discard the report on teardown: the record dir is removed just below, so
      // flushing it first would only re-write a file we are about to delete.
      this.retireTaskRuntime(live, { discardReport: true });
    }
    const record = this.persistedSessionRecord(taskId);
    if (record) {
      // storageRoot is Sonata's own hidden record dir — remove it wholesale, with
      // the task's Sonata-owned attachment and runtime subtrees. The agent's working
      // directory (providerCwd) is the user's VISIBLE work — a chosen folder or a
      // generated ~/Documents/Sonata workspace — and is NEVER touched (C4). The CLI
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

  /**
   * Kick off a mid-session Claude `/model` / `/effort` (S1) or `permission` (S2)
   * switch. A live PTY is required — a dormant session has nothing to drive. The
   * provider gate lives in the TerminalHost (codex refuses: an inline `/model`
   * arg burns a turn, and codex has no Shift+Tab cycle); the receipt(s) drive the
   * `control-switch:state` event, not this return. `from` is the permission
   * origin (the session's current mode) — the stepping engine's return-home
   * anchor; ignored for model/effort.
   */
  switchClaudeControl(
    taskId: TaskId,
    kind: ClaudeControlSwitchKind,
    value: string,
    from?: string,
  ): ClaudeControlSwitchResponse {
    const active = this.requireLiveTaskRuntime(taskId);
    return active.terminalHost.injectClaudeControlSwitch(kind, value, from);
  }

  /** Apply a STAGED claude model+effort Save (S7 Part 1) — the changed axes as one
   *  logical switch. A live PTY is required. */
  switchClaudeStaged(
    taskId: TaskId,
    model: string | null,
    effort: string | null,
  ): ClaudeControlSwitchResponse {
    const active = this.requireLiveTaskRuntime(taskId);
    return active.terminalHost.startClaudeStagedSwitch(model, effort);
  }

  /** Relay the user's chosen row for a PARKED recognized-confirm dialog (S7 Part 2)
   *  to the choreography (which navigates+Enters it). No-op if no dialog is parked. */
  answerControlConfirm(taskId: TaskId, rowNumber: number): void {
    const active = this.taskRuntimes.get(taskId);
    active?.terminalHost.answerParkedControlConfirm(rowNumber);
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

  renameProject(folderPath: string, displayName: string | null): RenameProjectResponse {
    const resolved = path.resolve(folderPath);
    const canonicalDisplayName = displayName?.trim() || null;
    this.projectsStore.setDisplayName(resolved, canonicalDisplayName);
    this.emitSessionsUpdated("project-updated");
    return {
      path: resolved,
      displayName: canonicalDisplayName,
      name: canonicalDisplayName ?? path.basename(resolved),
    };
  }

  archiveProject(folderPath: string, archived: boolean): void {
    const resolved = path.resolve(folderPath);
    if (archived) {
      // Stop any live sessions working in this folder before hiding it.
      for (const active of [...this.taskRuntimes.values()]) {
        if (pathsEqual(taskProviderCwd(active.task, active.storageRoot), resolved)) {
          this.retireTaskRuntime(active);
        }
      }
    }
    this.projectsStore.setArchived(resolved, archived);
    this.emitSessionsUpdated("project-updated");
  }

  submitPrompt(taskId: TaskId, text: string, attachments: DeliveryAttachment[] = []): void {
    const active = this.requireLiveTaskRuntime(taskId);
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
      // Orphan-reply guard (reviewer C2): if the broker already self-expired in
      // the poll gap (its `expired-<id>.json` is on disk), its native card is now
      // the live surface and no broker will ever read a reply. Writing one would
      // let Sonata record a decision the CLI never received and release the delivery
      // gate over a wedged turn. Leave the pending entry so the watcher's expiry
      // path (handleApprovalExpired) clears the card + raises the banner; the user
      // answers the native card in the Terminal. (The broker's own final
      // reply-check closes the symmetric window on its side.)
      if (this.brokerAlreadyExpired(taskId, approvalId)) {
        return;
      }
      this.pendingBrokerApprovals.delete(approvalId);
      // The decision JSON shape is the one true per-provider seam of the
      // approval channel (plan §2): Claude carries persistent-rule vocabulary
      // (`updatedPermissions`/`addRules`), Codex honors only `behavior:
      // allow|deny` (its "Always" rule support is an UNVERIFIED open probe — see
      // codex-approvals.ts). The broker echoes whatever Sonata writes verbatim.
      const decisionJson =
        active.task.provider === "codex"
          ? codexBrokerDecisionJson(decision)
          : brokerDecisionJson(decision, pending.payload);
      writeApprovalReply(runtimeDir(taskId), approvalId, decisionJson);
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
      // Critical event: consume flushes immediately (markCritical), and the
      // flush's notify sink broadcasts report:updated — no explicit emit here.
      active.runIndex.consume(decisionEvent);
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
    // Fallback: the scraped native panel — Claude only. Codex answers
    // exclusively via the broker reply channel (S4 funeral): the scrape that
    // surfaced a codex card is retired, so a codex task reaching here has no
    // scraped native card to replay keys against, and CSI-u/Arrow are Claude's
    // panel grammar (wrong for codex). Ignore rather than corrupt its TUI — the
    // native card, if any, is answered by the user in the Terminal.
    if (active.task.provider !== "claude") {
      console.warn(
        `[approval] ignoring non-broker ${decision} for ${active.task.provider} task ${taskId}: no scraped native card to answer (broker is the sole channel)`,
      );
      return;
    }
    if (decision === "approve" || decision === "approve-for-session" || decision === "approve-always") {
      active.terminalHost.sendApprovalDecision(decision);
      return;
    }
    active.terminalHost.sendDeny();
  }

  /** True iff the broker for this ask already wrote its expired marker (it gave
   *  up before Sonata answered) — the synchronous signal that a reply would be
   *  orphaned. The watcher consumes+deletes the marker on its next poll, so this
   *  is a narrow window; the broker's own final reply-check covers the other side. */
  private brokerAlreadyExpired(taskId: TaskId, approvalId: string): boolean {
    const expiredPath = path.join(
      approvalsDirectory(runtimeDir(taskId)),
      `${EXPIRED_PREFIX}${approvalId}.json`,
    );
    try {
      return fs.existsSync(expiredPath);
    } catch {
      return false;
    }
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
      if (!isHookCapable(active.task.provider) || !pathsEqual(runtimeDir(active.task.id), resolved)) {
        continue;
      }
      const provider = active.task.provider;
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
          // Sonata run — the same attribution the scrape path records.
          runId: active.terminalHost.activeRunId(),
          kind,
          source: "hook-broker",
          answerVia: "reply",
          approvalId: ask.id,
          summary: approvalSummary(ask.payload, provider),
          detail: approvalDetail(ask.payload),
          choices: brokerApprovalChoices(kind, ask.payload, provider),
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
      // Critical event: consume flushes immediately (markCritical), and the
      // flush's notify sink broadcasts report:updated — no explicit emit here.
      active.runIndex.consume(event);
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
      // Critical event: consume flushes immediately (markCritical), and the
      // flush's notify sink broadcasts report:updated — no explicit emit here.
      active.runIndex.consume(decisionEvent);
      if (this.shownBrokerApproval.get(active.task.id) === id) {
        // Only the SHOWN ask concerns the renderer — clearing a card the
        // user never saw would flash a phantom "Approval denied".
        this.shownBrokerApproval.delete(active.task.id);
        this.sendEvent(decisionEvent);
      }
    }
  }

  private rememberExpiredBrokerApproval(taskId: TaskId, id: string, kind: ApprovalKind): void {
    let byId = this.expiredBrokerApprovals.get(taskId);
    if (!byId) {
      byId = new Map();
      this.expiredBrokerApprovals.set(taskId, byId);
    }
    byId.set(id, kind);
  }

  /**
   * Conclude a codex task's TIMED-OUT broker asks at turn-end. The broker gave
   * up and the CLI's native card took over; a turn cannot end while a native
   * card still blocks the tool call, so reaching turn-end PROVES the user
   * resolved it. One `approval:decision(answered-natively)` per expired ask
   * repairs all three consumers through their existing contracts: the keyed
   * delivery gate releases (approvalId path, delivery-controller), the reducer
   * clears the drawer's expired state + the "Waiting in the CLI" status,
   * and the run-index records a balanced decision row for the earlier detected
   * ask. Covers BOTH turn-end paths (Stop hook AND the D6 quiescence net) —
   * called from the turn-terminal branch of handleRuntimeEvent for both. Idempotent:
   * the per-task map is cleared, so a re-emitted turn-end is a no-op.
   */
  private concludeExpiredBrokerApprovals(active: ActiveTaskRuntime, runId: RunId | null): void {
    const expired = this.expiredBrokerApprovals.get(active.task.id);
    if (!expired || expired.size === 0) {
      return;
    }
    this.expiredBrokerApprovals.delete(active.task.id);
    for (const [approvalId, kind] of expired) {
      const decisionEvent: RuntimeEvent = {
        type: "approval:decision",
        payload: {
          taskId: active.task.id,
          runId: runId ?? active.terminalHost.activeRunId(),
          decision: "answered-natively",
          encodedAs: "native-keys",
          previousKind: kind,
          approvalId,
        },
        ts: new Date().toISOString(),
      };
      active.deliveryController.handleRuntimeEvent(decisionEvent); // release the keyed gate
      this.sendEvent(decisionEvent); // reducer clears the expiry banner + status
      // Critical event: consume flushes immediately (markCritical), and the
      // flush's notify sink broadcasts report:updated — no explicit emit here.
      active.runIndex.consume(decisionEvent);
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
   * A broker gave up (timeout) — the CLI's native panel is taking over. Clear
   * the hook card, but emit `approval:expired` (NOT a false "answered-natively"
   * decision): nothing was answered, so cli-state stays waiting-approval and the
   * delivery gate stays blocked (reviewer P1/P2).
   *
   * Provider asymmetry after the S4 funeral: for CLAUDE the scrape re-detects
   * the native card, so we arm the one-shot resurface recognition below to keep
   * it from double-notifying. For CODEX the approval scrape is retired — the
   * native card is answered by the user in the Terminal and is never re-scraped
   * into a Sonata card, so no resurface arming is needed (nor possible to trip):
   * the expired banner is the whole of Sonata's post-expiry role.
   */
  private handleApprovalExpired(id: string, workspace: string): void {
    const pending = this.pendingBrokerApprovals.get(id);
    this.pendingBrokerApprovals.delete(id);
    const resolved = path.resolve(workspace);
    for (const active of this.taskRuntimes.values()) {
      if (!isHookCapable(active.task.provider) || !pathsEqual(runtimeDir(active.task.id), resolved)) {
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
      // Arm the scrape's resurface recognition (reviewer C1) — Claude only. The
      // native card that appears when this broker gave up IS the same request
      // the user was already notified about; without this, Claude's scrape
      // re-detects it as a FRESH approval → a duplicate needs-you notification
      // (the policy's "stay quiet after a decision" promise silently unmet,
      // since a timeout is not a decision and the broker ask set no scrape
      // fingerprint). The mark suppresses the second notification and records
      // the row as a resurface. Codex has no approval scrape (S4), so there is
      // nothing to arm — the field would never be read.
      if (active.task.provider === "claude") {
        active.terminalHost.noteBrokerApprovalExpiry();
      } else {
        // Codex: no scrape will ever re-detect this native card to conclude it
        // (S4 funeral). Remember the ask (with its kind for the report row) so
        // the turn-end hook releases the keyed delivery gate + the expiry
        // banner — otherwise every later send wedges Queued and a stale
        // "Waiting in the terminal" rides the healthy session forever.
        this.rememberExpiredBrokerApproval(active.task.id, id, classifyApprovalKind(pending.payload));
      }
      if (this.shownBrokerApproval.get(active.task.id) === id) {
        // Only the SHOWN ask's expiry concerns the renderer — a hidden
        // queued ask expiring must not clear someone else's live card
        // (S6 review P2); its native panel is surfaced by Claude's scrape or,
        // for codex, left to the user in the Terminal.
        this.shownBrokerApproval.delete(active.task.id);
        this.sendEvent(expiredEvent); // renderer clears the hook card + raises the banner
      }
      this.surfaceNextBrokerApproval(active); // a concurrent queued approval, if any
      return;
    }
  }

  async stopRun(taskId: TaskId, options: { inspectDelayMs?: number; forceSlashStop?: boolean }): Promise<void> {
    const active = this.requireTaskRuntime(taskId);
    const { canceledPendingPromptWrite, promptReachedComposer } =
      await active.terminalHost.stopRun(options);
    // Stop reaches the delivery layer too: disarm the Enter-retry ladder and,
    // when the stop aborted this send's undelivered bytes, report the item
    // honestly instead of letting it ride the 45s receipt timeout —
    // distinguishing "nothing reached the CLI" from "text/paths pasted, Enter
    // not sent".
    active.deliveryController.handleStopRequested({
      promptWriteCanceled: canceledPendingPromptWrite,
      promptReachedComposer,
    });
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

  workspacePath(taskId: TaskId): string {
    const active = this.requireTaskRuntime(taskId);
    return this.workspaceRoot(active);
  }

  dispose(): void {
    for (const active of [...this.taskRuntimes.values()]) {
      this.retireTaskRuntime(active);
    }
    this.usageSnapshots.clear();
    this.pendingClaudeUsage.clear();
    this.claudeUsageWatcher.dispose();
    this.hookWatcher.dispose();
    this.approvalWatcher.dispose();
    this.pendingBrokerApprovals.clear();
  }

  private handleRuntimeEvent(event: RuntimeEvent, runIndex: RunIndex): void {
    // Runtime event sinks outlive an explicit teardown briefly: node-pty
    // reports the killed process through an asynchronous onExit callback. If
    // the persistent task is reopened before that callback arrives, taskId now
    // names a NEW runtime. Fence by the source RunIndex (our generation token),
    // not taskId alone, or the old pty:exit/final run events can mutate and
    // retire the replacement runtime. No current entry is allowed because
    // startTask emits its initial events synchronously before create/open has
    // installed the freshly constructed ActiveTaskRuntime in the map.
    const sourceTaskId = runIndex.summary().taskId;
    const currentRuntime = this.taskRuntimes.get(sourceTaskId);
    if (currentRuntime && currentRuntime.runIndex !== runIndex) {
      return;
    }

    if (event.type === "usage:updated") {
      this.publishUsageSnapshot(event.payload.taskId, event.payload.snapshot);
      this.maybeApplyProviderSessionName(event.payload.taskId, event.payload.snapshot.sessionName);
      return;
    }
    if (event.type === "run:reconciled") {
      // Controller-internal (OBS S6 / D3): the terminal-host's turn-boundary
      // workspace delta feeds the run-index's changedFiles. Like
      // codex-turn-context:observed, it names no renderer state (no surface reads
      // changedFiles — S3), so it is consumed here and NEVER broadcast — honoring
      // D5 (main never serializes an event a window provably ignores). Fenced by
      // the source-RunIndex generation check above, so a straggler from a retired
      // runtime is dropped, not recorded onto a replacement.
      runIndex.consume(event);
      return;
    }
    if (event.type === "codex-turn-context:observed") {
      // Item E: the codex rollout's per-turn turn_context is the lazy SSOT for
      // model/effort/permission — reconcile the mirrors a NATIVE switch left
      // stale. Controller-internal (emits task:updated, never forwarded to the
      // renderer), so it early-returns like usage:updated.
      const runtime = this.taskRuntimes.get(event.payload.taskId);
      if (runtime) {
        this.reconcileCodexTurnContext(runtime, event.payload);
      }
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

    // Mid-session CODEX permission switch settled (S3): the `/permissions` picker
    // receipt is codex's confirmation channel — unlike claude, there is NO
    // hook-payload permission mirror, so the settled event legitimately WRITES the
    // session's mode here (the asymmetry documented on ControlSwitchStateEvent).
    // Claude's model/effort/permission `settled` never lands here — its axes' own
    // SSOTs (statusline / hook payload) drive the chip; only codex-permission does.
    // A `cancelled` settle (S7 — the user chose No / Cancel on a parked confirm)
    // changed NOTHING CLI-side, so it must NOT write the mirror (it would flip the
    // chip to a Full Access that was declined). It still clears the pending
    // affordance in the reducer; here we simply skip the state write.
    if (
      event.type === "control-switch:state" &&
      event.payload.kind === "codex-permission" &&
      event.payload.phase === "settled" &&
      !event.payload.cancelled &&
      eventRuntime
    ) {
      this.applyCodexPermissionSwitchReceipt(eventRuntime, event.payload.value);
    }

    // Mid-session CODEX model/effort switch settled (S4): the same asymmetry as
    // codex-permission — codex has NO statusline/hook mirror for its model or
    // reasoning, so the `/model` picker receipt is the confirmation channel. The
    // settled event carries the receipt's own (model, effort) pair; write BOTH to
    // the task so the composer's model chip (which reads task.model +
    // task.reasoningEffort for codex — no statusline) follows. Claude's
    // model/effort `settled` never lands here — its statusline drives the chip.
    if (
      event.type === "control-switch:state" &&
      (event.payload.kind === "codex-model" || event.payload.kind === "codex-effort") &&
      event.payload.phase === "settled" &&
      eventRuntime
    ) {
      this.applyCodexModelSwitchReceipt(
        eventRuntime,
        event.payload.codexModel ?? null,
        event.payload.codexEffort ?? null,
      );
    }

    // Codex hooks-liveness arms at the FIRST submission of a session, not at
    // spawn: SessionStart arrives together with the first UserPromptSubmit
    // (lazy — probed 0.144.4/0.144.5), so only a submission puts the shim on
    // the clock. The map guard keeps later submissions from re-arming a
    // window the handshake already resolved; pty:exit deletes the entry, so a
    // reopened session arms afresh on its own first submission.
    if (
      event.type === "prompt:submitted" &&
      eventRuntime?.task.provider === "codex" &&
      !this.codexHookLiveness.has(eventRuntime.task.id)
    ) {
      this.armCodexHooksLiveness(eventRuntime);
    }

    // Turn-terminal signals drive two broker-approval release paths with
    // DIFFERENT scopes. `abortPendingBrokerApprovals` orphans still-PENDING asks
    // — a live holding hook blocks the turn, so a normal hook-Stop completion
    // can't coexist with one; it fires only on Sonata's ■/Esc (run:stopped), the
    // quiescence run-closer (completed + terminal-idle-heuristic), or the PTY
    // dying. `concludeExpiredBrokerApprovals` handles EXPIRED codex asks — the
    // broker already gave up and the native card was answered in the Terminal,
    // which let the turn RESUME and then end via EITHER path (hook-Stop OR
    // quiescence), so it must also fire on a hook-Stop completion (the retired
    // scrape was these asks' only clearer — S4 event-flow gap).
    if (eventRuntime) {
      const isPendingTurnEnd =
        event.type === "run:stopped" ||
        event.type === "pty:exit" ||
        (event.type === "run:updated" &&
          (event.payload.status === "stopped" ||
            (event.payload.status === "completed" &&
              event.payload.completionSource === "terminal-idle-heuristic")));
      const isExpiredTurnEnd =
        isPendingTurnEnd ||
        (event.type === "run:updated" &&
          event.payload.status === "completed" &&
          event.payload.completionSource === "hook-stop");
      if (isExpiredTurnEnd) {
        const terminalRunId =
          event.type === "run:stopped"
            ? event.payload.runId
            : event.type === "run:updated"
              ? event.payload.id
              : null;
        this.concludeExpiredBrokerApprovals(eventRuntime, terminalRunId);
        if (isPendingTurnEnd) {
          this.abortPendingBrokerApprovals(eventRuntime, terminalRunId);
        }
      }
    }

    if (event.type === "pty:exit" && eventRuntime) {
      // The PTY died — retire any codex hooks-liveness window so the trust
      // banner never shows (or is cleared) over a dead terminal. No-op for
      // Claude (no entry) and for a codex task whose handshake already landed.
      this.retireCodexHooksLiveness(event.payload.taskId);

      // TerminalHost emits pty:exit from inside node-pty's onExit callback and
      // then finishes the active run. Retire on the next microtask so that
      // callback can publish its final run event first. Removing the runtime
      // makes the session index authoritative (`live: false`) and lets a later
      // openTask construct a new host instead of returning a dead one.
      queueMicrotask(() => {
        if (this.taskRuntimes.get(event.payload.taskId) === eventRuntime) {
          this.retireTaskRuntime(eventRuntime);
        }
      });
    }

    if (event.type === "pty:exit" && eventRuntime?.pendingOptionPrompt) {
      // The PTY died with a question still open — clear the card (no receipt).
      const toolUseId = eventRuntime.pendingOptionPrompt.toolUseId;
      eventRuntime.pendingOptionPrompt = null;
      eventRuntime.lastOptionPromptResolution = { toolUseId, answered: false };
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

    // report:updated now rides the projection flush (notify sink), gated by the
    // same dirty+debounce as the write (D6). The per-event task-status sync stays
    // coupled to the MUTATION, not the flush cadence (a truthy summary means the
    // event mutated) — task status is not the report broadcast.
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
    if (!active) {
      return;
    }
    const adoption = adoptAutomaticSessionTitle(
      active.task,
      title,
      "first-prompt",
      active.autoTitle,
    );
    if (!adoption) {
      return;
    }

    active.task = {
      ...active.task,
      ...adoption,
      updatedAt: new Date().toISOString(),
    };
    active.autoTitle = adoption.title;
    this.persistTaskManifest(active.task, active.storageRoot);
  }

  /**
   * Claude's statusline carries a provider-generated session title. It only
   * ever replaces an AUTOMATIC title. New tasks persist that ownership; legacy
   * tasks retain the old placeholder/last-auto runtime seam. A user rename
   * persists user ownership and wins forever. Like manual rename, this is
   * metadata: updatedAt stays untouched.
   */
  private maybeApplyProviderSessionName(taskId: TaskId, sessionName: string | null | undefined): void {
    const active = this.taskRuntimes.get(taskId);
    if (!active) {
      return;
    }
    const adoption = adoptAutomaticSessionTitle(
      active.task,
      sessionName,
      "provider",
      active.autoTitle,
    );
    if (!adoption) {
      return;
    }
    active.task = { ...active.task, ...adoption };
    active.autoTitle = adoption.title;
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
    this.broadcastReportUpdated(runIndex.summary());
  }

  /**
   * Broadcast report:updated from a summary. Wired as each live RunIndex's
   * `notify` sink (OBS S2, D6 main half) so the broadcast fires ONLY from the
   * projection flush — write and notify share one dirty-gated, time-bounded
   * cadence, never per consumed event. Still called directly at open/reopen for
   * the initial "here's the current report" nudge.
   */
  private broadcastReportUpdated(summary: RuntimeReportSummaryV1, runsChanged = true): void {
    const reportEvent: RuntimeReportUpdatedEvent = {
      type: "report:updated",
      payload: {
        taskId: summary.taskId,
        reportPath: summary.reportPath,
        runCount: summary.runCount,
        latestRunId: summary.latestRun?.runId ?? null,
        rawTerminalPersisted: false,
        rawTerminalPointer: null,
        // OBS S3: false only for a file:changed-only flush (nothing the renderer
        // reads changed) so the renderer skips the full-report refetch. The
        // direct open/reopen nudge defaults true — the initial load must refetch.
        runsChanged,
      },
      ts: new Date().toISOString(),
    };
    this.sendEvent(reportEvent);
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

  /**
   * Like requireTaskRuntime, but distinguishes "never existed" from "exists
   * on disk, just not live right now" — the difference the Local API renders
   * as taskNotFound (-32001) vs taskNotLive (-32002). Used only where a
   * dormant session is a meaningful, recoverable state for the caller (a
   * companion that can openTask first): submitPrompt targets a running PTY,
   * so a persisted-but-dormant task is a distinct, actionable answer rather
   * than a not-found. The missing-task branch keeps requireTaskRuntime's
   * exact error type and message, so callers that only ever act on live
   * tasks (the renderer) see byte-identical behavior.
   */
  private requireLiveTaskRuntime(taskId: TaskId): ActiveTaskRuntime {
    const active = this.taskRuntimes.get(taskId);
    if (active) {
      return active;
    }
    if (this.persistedSessionRecord(taskId)) {
      throw new TaskNotLiveError(
        "The requested task exists but is not live; open it before submitting.",
      );
    }
    throw new TaskNotFoundError("No runtime task matches the requested taskId.");
  }

  private disposeTaskRuntime(
    active: ActiveTaskRuntime,
    options: { discardReport?: boolean } = {},
  ): void {
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
    // `discard` (delete path) seals WITHOUT a final write, so we never re-write
    // the report file the caller is about to rmSync; every other teardown flushes
    // the pending tail then seals.
    if (options.discardReport) {
      active.runIndex.discard();
    } else {
      active.runIndex.dispose();
    }
    this.unwatchClaudeUsage(active);
    this.unwatchHooks(active);
    this.usageSnapshots.delete(active.task.id);
    // Broker-approval bookkeeping is keyed by the PERSISTENT taskId, so it
    // survives a close and a stale `shownBrokerApproval` slot would suppress
    // EVERY future card on reopen (surfaceBrokerApproval sees the id still
    // "shown"). Clear all three maps for the task (pending is keyed by broker
    // id → walk by taskId). Mirrors the S2 stale-liveness-banner fix.
    for (const [id, pending] of this.pendingBrokerApprovals) {
      if (pending.taskId === active.task.id) {
        this.pendingBrokerApprovals.delete(id);
      }
    }
    this.shownBrokerApproval.delete(active.task.id);
    this.expiredBrokerApprovals.delete(active.task.id);
  }

  /**
   * Atomically remove a live runtime from the authoritative map before its
   * resources are torn down. A killed PTY may report a late pty:exit; with the
   * map cleared first that event cannot retire the runtime twice or resurrect
   * live state while close/archive/delete is already in progress.
   */
  private retireTaskRuntime(
    active: ActiveTaskRuntime,
    options: { discardReport?: boolean } = {},
  ): void {
    if (this.taskRuntimes.get(active.task.id) !== active) {
      return;
    }
    this.taskRuntimes.delete(active.task.id);
    this.disposeTaskRuntime(active, options);
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

  private watchHooks(active: ActiveTaskRuntime): void {
    // Hook-capable providers feed the same sink + approvals layout (S3), so both
    // get watched. The broker's hold-and-answer path is armed per provider:
    // Codex's broker shim is inert-until-marker (D4), so dropping the
    // answering-enabled marker here — exactly when Sonata's card wiring goes live —
    // is what turns its native-card fallback into the Reading approval channel.
    if (isHookCapable(active.task.provider)) {
      this.hookWatcher.watchWorkspace(runtimeDir(active.task.id));
      this.approvalWatcher.watchWorkspace(runtimeDir(active.task.id));
    }
    if (active.task.provider === "codex") {
      enableCodexAnswering(runtimeDir(active.task.id));
      // Hooks-liveness is NOT armed here: codex emits SessionStart lazily —
      // with the first UserPromptSubmit, not at boot (probed at 0.144.4 AND
      // 0.144.5, spikes/codex-boot-input-window/sessionstart-ab.mjs), so a
      // spawn-anchored window false-alarms whenever the user pauses >12s
      // before their first prompt. The window arms on the first
      // `prompt:submitted` instead (handleRuntimeEvent).
    }
  }

  private unwatchHooks(active: ActiveTaskRuntime): void {
    if (isHookCapable(active.task.provider)) {
      this.hookWatcher.unwatchWorkspace(runtimeDir(active.task.id));
      this.approvalWatcher.unwatchWorkspace(runtimeDir(active.task.id));
    }
    if (active.task.provider === "codex") {
      disableCodexAnswering(runtimeDir(active.task.id));
      this.clearCodexHooksLiveness(active.task.id);
    }
  }

  /**
   * Arm the Codex hooks-liveness check (S2; D4 overturned — hooks bypass trust,
   * so they fire on every spawn). Armed at the session's FIRST prompt
   * submission (SessionStart is lazy — it arrives with the first
   * UserPromptSubmit, not at boot; probed 0.144.4/0.144.5): if no
   * `SessionStart` handshake arrives within the window from that submission,
   * the hook shim failed to fire (e.g. interpreter not on PATH) — raise the
   * "hooks aren't running" banner. The timer is unref'd: it must never keep
   * the process alive on its own.
   */
  private armCodexHooksLiveness(active: ActiveTaskRuntime): void {
    const taskId = active.task.id;
    this.clearCodexHooksLiveness(taskId);
    const timer = setTimeout(() => {
      const entry = this.codexHookLiveness.get(taskId);
      // Only a still-`pending` window raises the banner: if a handshake or a PTY
      // exit already resolved it, this fired-but-not-yet-dequeued callback is a
      // no-op (the same-tick race clearTimeout cannot unwind).
      if (!entry || entry.status !== "pending") {
        return;
      }
      entry.timer = null;
      entry.status = "missing";
      this.emitCodexHooksLiveness(taskId, "missing");
    }, CODEX_HOOKS_LIVENESS_WINDOW_MS);
    timer.unref?.();
    this.codexHookLiveness.set(taskId, { timer, status: "pending" });
  }

  /**
   * The handshake arrived (`SessionStart`) — Codex's hooks are trusted and
   * firing. Cancel the pending window and clear the banner UNCONDITIONALLY:
   * emitting `live` on every handshake (not only when THIS entry raised the
   * banner) makes the renderer's missing-set self-correcting — a reopen after a
   * prior close, whose old missing-flag the renderer still holds, is cleared by
   * the fresh session's own handshake. Idempotent for the common fast path.
   */
  private noteCodexHooksAlive(active: ActiveTaskRuntime): void {
    const taskId = active.task.id;
    const entry = this.codexHookLiveness.get(taskId);
    if (!entry) {
      // A handshake BEFORE any armed window (a resumed session can declare
      // SessionStart at boot, ahead of the first submission that would arm
      // it). Record it as alive so the later first `prompt:submitted` does
      // not arm a window no second SessionStart would ever resolve, and emit
      // `live` so a stale banner from a prior session of this task clears
      // (the self-correction property below).
      this.codexHookLiveness.set(taskId, { timer: null, status: "alive" });
      this.emitCodexHooksLiveness(taskId, "live");
      return;
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.status = "alive";
    this.emitCodexHooksLiveness(taskId, "live");
  }

  /**
   * The PTY died (crash/quit). Retire the liveness window so the trust-ceremony
   * banner never appears over — or is cleared off — a dead terminal. On pty:exit
   * the runtime OBJECT is retired (`retireTaskRuntime`, next microtask above); it
   * is the task RECORD that survives and stays reopenable. This fires from the
   * pty:exit path, not unwatchHooks.
   */
  private retireCodexHooksLiveness(taskId: TaskId): void {
    const entry = this.codexHookLiveness.get(taskId);
    if (!entry) {
      return;
    }
    if (entry.status === "missing") {
      this.emitCodexHooksLiveness(taskId, "live"); // clear the shown banner
    }
    this.clearCodexHooksLiveness(taskId);
  }

  private clearCodexHooksLiveness(taskId: TaskId): void {
    const entry = this.codexHookLiveness.get(taskId);
    if (entry?.timer) {
      clearTimeout(entry.timer);
    }
    this.codexHookLiveness.delete(taskId);
  }

  private emitCodexHooksLiveness(taskId: TaskId, status: "missing" | "live"): void {
    this.sendEvent({
      type: "cli-hooks:liveness",
      payload: { taskId, status },
      ts: new Date().toISOString(),
    });
  }

  /**
   * Route a hook payload to its task by the runtime dir it was observed under
   * (D8) — ownership, not inference. The per-task sink dir travels via the
   * environment, so sink-dir ownership IS the nonce: two same-cwd tasks never
   * cross-adopt. The hook fires only after the PTY is up, by which point the
   * task is registered, so unmatched payloads are simply dropped.
   */
  private handleHookPayload(payload: HookPayload, workspace: string): void {
    const resolved = path.resolve(workspace);
    for (const active of this.taskRuntimes.values()) {
      if (!pathsEqual(runtimeDir(active.task.id), resolved)) {
        continue;
      }
      if (isHookCapable(active.task.provider)) {
        this.applyHookToTask(active, payload);
      }
      return;
    }
  }

  /**
   * One converged hook handler for every hook-capable provider (S3). Codex GA'd
   * a hook contract that clones Claude's field-for-field (plan §2), so the SPINE
   * is shared — identity handshake, cli-state, and the run lifecycle all speak
   * the standard schema — and only the genuine per-provider edges branch. This
   * collapses the S1/S2 two-handler fork (the convergence license recorded at
   * the S2 gate).
   *
   * `PermissionRequest` is DELIBERATELY absent here for BOTH providers: it is
   * owned by the broker shim, so it arrives via the ApprovalWatcher →
   * `handleApprovalAsk` (which drives cli-state to waiting-approval), never the
   * sink. Everything else routes below.
   */
  private applyHookToTask(active: ActiveTaskRuntime, payload: HookPayload): void {
    const provider = active.task.provider;
    const event = payload.hook_event_name;

    // Codex subagent lifecycle (S6): SubagentStart/Stop describe a CHILD agent,
    // not the parent turn — SubagentStart's `transcript_path` even points at the
    // child's own rollout (verified 0.144.4). Keep them entirely OFF the main-turn
    // spine (no source adoption, no cli-state, no run lifecycle) and feed only the
    // transcript roster the status strip renders. Claude derives its roster from
    // the session file, so this is Codex-only — Claude also sinks SubagentStop,
    // but for it that stays a cli-state no-op on the normal path below.
    if (provider === "codex" && (event === "SubagentStart" || event === "SubagentStop")) {
      active.providerTranscript.applySubagentEvent(payload);
      return;
    }

    // Identity handshake — both providers, every event (a session id can change
    // under a live PTY: /clear, native resume). Idempotent.
    this.adoptTranscriptFromHook(active, payload);

    // CLI-state — the schema-agnostic primary signal for busy/idle/turn-end.
    active.cliState.applyHook(payload);

    // Stop-Esc corroboration (both providers): a tool STARTING after a stop
    // was requested proves the turn survived the Esc — the terminal host
    // resends it once. PreToolUse only; AskUserQuestion is excluded (a
    // question to the human is not runaway work, and an Esc into its option
    // prompt has unprobed semantics).
    if (event === "PreToolUse" && payload.tool_name !== "AskUserQuestion") {
      active.terminalHost.noteToolActivityAfterStop();
    }

    // Semantic change attribution (OBS S6 / D3): a PostToolUse from a file-
    // mutating tool names the paths it changed — the primary `changedFiles`
    // source, replacing the retired filesystem-watcher stream. Bash and other
    // opaque tools name no path here; the turn-boundary reconcile is their net.
    if (event === "PostToolUse") {
      this.recordToolChangesFromHook(active, payload);
    }

    // Plan §4's "capability-driven, not provider-name-driven" applies to the
    // DISPATCH/watch gates (now `isHookCapable`). The three edges below are a
    // different class: each encodes a SPECIFIC Claude-only capability — a
    // permission-mode vocabulary, the `AskUserQuestion` tool, and the
    // `StopFailure` event — that a `=== "claude"` gate auto-excludes any future
    // provider from anyway. Minting three predicates for a two-provider world is
    // premature abstraction; the capability is named in each comment instead.
    //
    // Permission-mode display and AskUserQuestion option-prompts: Codex's
    // permission model is sandbox + approval-policy (Reading does not surface it
    // as `permissionMode`), and `AskUserQuestion` has no verified Codex
    // equivalent — both skipped for Codex, declared, not force-mapped.
    if (provider === "claude") {
      this.applyHookPermissionMode(active, payload);
      this.handleOptionPromptHook(active, payload);
    }

    // The Codex hooks-liveness effect-check: a `SessionStart` handshake proves
    // Codex's injected hooks are trusted and firing (untrusted hooks are
    // silently skipped — the only detector is the handshake's presence).
    if (provider === "codex" && event === "SessionStart") {
      this.noteCodexHooksAlive(active);
    }

    // `SessionStart` is the CLI's own boot declaration (startup, resume, /clear)
    // — it opens the delivery boot latch structurally for BOTH providers. The
    // idle-prompt scrape cannot do this for a resumed session whose history
    // repaint reads as activity-after-prompt forever (Claude ≥2.1.186; the same
    // starvation class applies to a resumed Codex TUI), so the latch would
    // starve and queued resume messages never deliver. Opening it only ever
    // makes `acceptsPromptInput` MORE permissive earlier; the busy/panel guards
    // still protect delivery.
    if (event === "SessionStart") {
      active.terminalHost.noteHookSessionStart();
      // Re-arm the delivery boot grace: startup, resume, AND /clear all repaint
      // the composer through the same Enter-swallow window class. This is what
      // protects a post-/clear write-through send (which completes as a
      // native-queue receipt, arming no Enter-retry) and the resume repaint.
      active.deliveryController.noteSessionBoundary();
    }

    // `UserPromptSubmit` is the authoritative "a turn is starting" signal — the
    // CLI just began (or dequeued) a prompt. Begin the run from it (no-op if the
    // idle-send path already began one). This is what makes mid-turn
    // write-through honest: a queued send's run starts when the CLI dequeues it,
    // not when Sonata wrote the bytes. Symmetric with the Stop-hook completion.
    if (event === "UserPromptSubmit") {
      const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
      // Authoritative submission proof: corroborate the echo-retry ladder from
      // UPS (fast) rather than the slow transcript-adoption chain, so a
      // genuinely-submitted first message never earns a wasteful — or, if the
      // model raced an option-prompt onto the screen, dangerous — rung-0 Enter.
      // A stuck send fires no UPS, so this never suppresses a real heal.
      active.deliveryController.notePromptSubmittedByCli(prompt);
      active.terminalHost.beginRunFromHook(prompt, {
        // The run↔turn bridge: Claude's `prompt_id` == the transcript's
        // promptId/turnKey (2026-07-03 loop-wakeup fix). Codex carries `turn_id`
        // instead, and as of S5 its normalizer keys turnKey off exactly that
        // rollout `turn_id` (task_started), so a Codex Run now anchors by
        // identity like Claude's — provider-transcript treats a non-`turn-N`
        // turnKey as a promptId and matches it against `run.promptId`. Both
        // ids share the `019f…` UUID namespace (hook payload == rollout).
        promptId:
          provider === "claude" && typeof payload.prompt_id === "string"
            ? payload.prompt_id
            : provider === "codex" && typeof payload.turn_id === "string"
              ? payload.turn_id
              : null,
      });
    }

    // `Stop` is the authoritative "turn ended" signal — complete the active run
    // from it (structured truth) instead of waiting on the composer-idle scrape,
    // which lagged and could be fooled. Additive: the terminal-host heuristic
    // stays as the fallback (and is Codex's ONLY turn-failure net — D6 — since
    // Codex has no StopFailure event).
    if (event === "Stop") {
      active.terminalHost.completeRunFromTurnEnd();
      // The parent turn's Stop also clears any Codex subagent still marked
      // running (a dropped SubagentStop) — Codex subagents are awaited within
      // their launch turn, so none legitimately outlive it. `turn_id` names
      // which turn's stragglers to settle; Claude's file-derived roster is
      // untouched (no turn_id on its Stop, and the guard gates it out anyway).
      if (provider === "codex" && typeof payload.turn_id === "string" && payload.turn_id) {
        active.providerTranscript.settleSubagentTurn(payload.turn_id);
      }
    }

    // `StopFailure` is the turn's other honest ending on CLAUDE: the API errored
    // after retries and Stop will never fire (probed S6). Complete with the
    // structured error. Codex emits no such event (verified) — the quiescence
    // `task:ready` net (D6) is its turn-failure fallback; do not synthesize one.
    if (provider === "claude" && event === "StopFailure") {
      const error =
        typeof payload.error === "string" && payload.error.trim()
          ? payload.error.trim()
          : "API error";
      active.terminalHost.completeRunFromTurnEnd({ errorExcerpt: error });
    }
  }

  /**
   * Feed the run-index the file changes a PostToolUse named (OBS S6 / D3). The
   * per-provider tool→path extraction is pure (`changedPathsFromToolUse`); here we
   * normalize each path to the report's relative-path convention against the SAME
   * workspace cwd the terminal-host uses for its reconcile paths — so the two
   * channels' relative keys collide and the run-index dedups reconcile against
   * tool attribution correctly. Attributed to the run active at hook arrival.
   */
  private recordToolChangesFromHook(active: ActiveTaskRuntime, payload: HookPayload): void {
    const changes = changedPathsFromToolUse(payload);
    if (changes.length === 0) {
      return;
    }
    const cwd =
      active.terminalHost.workspace ?? (typeof payload.cwd === "string" && payload.cwd ? payload.cwd : null);
    if (!cwd) {
      return;
    }
    const tool = typeof payload.tool_name === "string" ? payload.tool_name : "tool";
    // No post-completion grace window is needed: hooks are consumed IN ORDER
    // (hook-watcher.ts:100-104, serial + synchronous), so run N's PostToolUse is
    // processed before its Stop reaches finishActiveRun(N) — `activeRun` is still
    // run N here. (A hook racing past its own Stop would fall to unassigned; the
    // turn-boundary reconcile is the backstop.)
    const runId = active.terminalHost.activeRunId();
    const entries = changes.map((change) => {
      const absolutePath = path.isAbsolute(change.path) ? change.path : path.resolve(cwd, change.path);
      const relativePath = path.relative(cwd, absolutePath) || path.basename(absolutePath);
      return { path: relativePath, absolutePath, changeKind: change.changeKind, tool };
    });
    active.runIndex.recordToolChanges(runId, entries);
  }

  /**
   * The transcript identity handshake, both providers (S2). Every hook payload
   * names its session (`session_id` + `transcript_path` — Claude's session
   * jsonl, Codex's rollout jsonl; both base envelope fields, verified codex
   * 0.142.5), and the per-task hook sink already routed it to THIS task — so
   * the binding is ownership, not inference. This is what replaced the locator's
   * mtime fallback (Claude 2026-07-03; Codex S2): it binds a fresh session the
   * moment its first hook fires, and follows a session id CHANGING under a live
   * PTY (/clear, native /resume) that a spawn-pinned id can never track.
   * adoptSource is idempotent, so the per-event cost is a set lookup.
   */
  private adoptTranscriptFromHook(active: ActiveTaskRuntime, payload: HookPayload): void {
    const sessionId =
      typeof payload.session_id === "string" && payload.session_id ? payload.session_id : null;
    const transcriptPath =
      typeof payload.transcript_path === "string" && payload.transcript_path
        ? payload.transcript_path
        : null;
    if (!sessionId || !transcriptPath) {
      return;
    }
    // A hook-owned rebind is a SANCTIONED identity update — the CLI itself is
    // declaring which session this PTY now is (/clear, native /resume), not a
    // locator guessing by recency (which the persist-time CAS rightly keeps
    // blocking). Update the manifest ref BEFORE adopting the source, so the
    // CAS sees current === latest, and everything keyed by providerSessionRef
    // (statusline usage flush, session-name adoption) follows the live
    // session instead of splitting from the transcript.
    if (active.task.providerSessionRef !== sessionId) {
      active.task = {
        ...active.task,
        providerSessionRef: sessionId,
        updatedAt: new Date().toISOString(),
      };
      this.persistTaskManifest(active.task, active.storageRoot);
      this.sendEvent({
        type: "task:updated",
        payload: { taskId: active.task.id, task: active.task, reason: "runtime-status" },
        ts: new Date().toISOString(),
      });
      // Pending statusline usage is a Claude-only concern (Codex has no
      // statusline sink); harmless but pointless for Codex, so gate it.
      if (active.task.provider === "claude") {
        this.flushPendingClaudeUsage(active);
      }
    }
    // The transcript file can trail the hook by a beat. Both providers now
    // re-adopt on every later hook (they fire per tool call / turn), so hand the
    // CLI-declared id to discovery, which binds it by identity the moment the
    // rollout/jsonl lands (no mtime guess). The providerSessionRef was already
    // persisted above, so the manifest is correct either way; this recovers the
    // transcript SOURCE.
    if (!fs.existsSync(transcriptPath)) {
      active.providerTranscript.setExpectedSessionId(sessionId);
      active.providerTranscript.ensureDiscovery();
      return;
    }
    const provider = active.task.provider;
    active.providerTranscript.adoptSource({
      sourceId: `${provider}:${sessionId}`,
      provider,
      format: provider === "codex" ? "codex-rollout-jsonl" : "claude-session-jsonl",
      path: transcriptPath,
      providerSessionId: sessionId,
      locatedAt: new Date().toISOString(),
    });
  }

  /**
   * Keep the displayed permission mode current from hook payloads — the state
   * SSOT for permission mode. Every hook event carries `permission_mode`, so a
   * switch is reflected on the next hook activity (lazily — not instantly on the
   * keypress); the statusline payload has no mode field, so hooks are the only
   * structured source.
   *
   * Contract §2 note: the clause once read "mid-session switching lives in the
   * Terminal; Reading only DISPLAYS the mode." Amended 2026-07-18 (Mid-session
   * Switch Program, Woody approved — product-thinking/2026-07-18-midsession-
   * switch-v0.md): Reading may now also DRIVE the switch, by stepping the native
   * Shift+Tab cycle (S2) and reading the TUI mode line as a *choreography receipt*.
   * That does NOT move the SSOT — this reconcile stays authoritative; the mode
   * line is receipt-only and never writes task.permissionMode. Terminal-native
   * Shift+Tab / /permissions continue to land here on the next hook, unchanged.
   */
  private applyHookPermissionMode(active: ActiveTaskRuntime, payload: HookPayload): void {
    const mode = payload.permission_mode;
    if (typeof mode !== "string" || !CLAUDE_PERMISSION_MODES.has(mode as ClaudePermissionMode)) {
      return;
    }
    // TaskMirror owns the metadata write: updatedAt stays put (a mode display
    // refresh is not activity), persist, emit one task:updated only if the mode
    // actually moved.
    this.taskMirror.apply(active, { permissionMode: mode as ClaudePermissionMode });
  }

  /**
   * Mirror a settled mid-session CODEX permission switch onto the task record
   * (S3). Codex is the ASYMMETRIC case: it has no hook-payload permission mirror
   * (claude rides `permission_mode` on every hook — applyHookPermissionMode
   * above), so the `/permissions` picker's own confirm receipt is the ONLY
   * confirmation channel. The terminal-host's picker choreography emits the
   * settled `control-switch:state` only after reading that receipt, so writing
   * `task.codexPermissionMode` here is receipt-corroborated, not optimistic.
   * updatedAt stays put (a mode refresh is metadata, like rename/archive — same
   * rule as applyHookPermissionMode) so the sidebar ordering doesn't jump.
   */
  private applyCodexPermissionSwitchReceipt(active: ActiveTaskRuntime, value: string): void {
    if (!isCodexPermissionMode(value)) {
      return;
    }
    // Receipt-corroborated (the picker read its own confirm), so this write is
    // not optimistic. TaskMirror keeps updatedAt frozen and emits only on change.
    this.taskMirror.apply(active, { codexPermissionMode: value });
  }

  /**
   * Mirror a settled mid-session CODEX model/effort switch onto the task record
   * (S4). Codex has NO statusline/hook mirror for its model or reasoning (unlike
   * claude, whose statusline follows a `/model` switch — sessionModelSummaryLabel),
   * so the `/model` picker's own `• Model changed to <model> <effort>` receipt is
   * the ONLY confirmation channel. The terminal-host emits the settled event with
   * the receipt's own values, so writing BOTH task.model and task.reasoningEffort
   * here is receipt-corroborated, not optimistic. The picker forces a (model,
   * effort) pair, so both are always present and always written together — this
   * also captures any codex-side effort reset a model change might carry. Only a
   * recognized reasoning id is written; a garbage effort leaves both fields alone.
   * updatedAt stays put (a chip refresh is metadata, like rename/archive — same
   * rule as applyHookPermissionMode) so the sidebar ordering doesn't jump.
   */
  private applyCodexModelSwitchReceipt(
    active: ActiveTaskRuntime,
    model: string | null,
    effort: ReasoningEffort | null,
  ): void {
    const nextModel = model && model.trim().length > 0 ? model : active.task.model;
    const nextEffort =
      effort && REASONING_EFFORTS.has(effort) ? effort : active.task.reasoningEffort;
    // Model + effort are always written together (the picker forces the pair);
    // TaskMirror no-ops when neither moved and keeps updatedAt frozen.
    this.taskMirror.apply(active, { model: nextModel, reasoningEffort: nextEffort });
  }

  /**
   * Reconcile a codex task's mirrors (model, reasoning effort, permission mode)
   * from the rollout's per-turn `turn_context` (item E — mid-session switch S5).
   * This is the LAZY SSOT that backstops the picker-receipt fast paths
   * (applyCodexModelSwitchReceipt / applyCodexPermissionSwitchReceipt above): a
   * NATIVE switch — the user typing `/model` or `/permissions` directly in the
   * co-visible Terminal — earns no receipt and leaves those mirrors stale, since
   * codex (unlike claude's statusline/hook feed) exposes these axes ONLY in the
   * rollout. Reading them back from turn_context corrects the drift, and removes
   * the staleness the S4 codex-model switch's effort-preservation depends on (it
   * reads task.reasoningEffort to hold effort at picker level 2 — a stale mirror
   * would push a stale effort onto the live CLI).
   *
   * Same write discipline as the receipt reconcilers: mirror in place with a
   * frozen updatedAt (a runtime-status refresh is metadata, not activity — the
   * sidebar ordering must not jump), persist, and emit ONE task:updated only when
   * something actually changed. Every field is validated/mapped before it lands:
   * effort against REASONING_EFFORTS; the permission mode through
   * codexPermissionModeFromTurnContext, which reconciles ONLY an unambiguous
   * projection (in practice just full-access) — the rollout can't tell ask-for-
   * approval from approve-for-me (they share a projection; the reviewer axis that
   * splits them isn't a trustworthy per-turn signal), so those pairs preserve the
   * current mirror rather than corrupt a receipt-set value. Model/effort round-trip
   * cleanly and are the axes this reconcile actually needed. Codex-only by
   * construction (turn_context is a codex rollout record), but guarded regardless.
   */
  private reconcileCodexTurnContext(
    active: ActiveTaskRuntime,
    context: {
      model: string | null;
      effort: string | null;
      approvalPolicy: string | null;
      sandboxPolicy: string | null;
    },
  ): void {
    if (active.task.provider !== "codex") {
      return;
    }
    const nextModel =
      context.model && context.model.trim().length > 0 ? context.model : active.task.model;
    const nextEffort =
      context.effort && REASONING_EFFORTS.has(context.effort as ReasoningEffort)
        ? (context.effort as ReasoningEffort)
        : active.task.reasoningEffort;
    // The rollout carries (sandbox, approval) but NOT the reviewer axis that
    // separates ask-for-approval from approve-for-me (they share the same
    // (workspace-write, on-request) projection). So reconcile the permission mode
    // ONLY when the pair uniquely identifies a triad member — in practice just
    // full-access's (danger-full-access, never). An ambiguous or non-representable
    // pair returns null and keeps the current mirror (fail-safe — never guess a
    // mode from indistinguishable state; a mislabelled access level is worse than a
    // stale one). See codexPermissionModeFromTurnContext for the full boundary; the
    // S3 picker-receipt fast path still reconciles every Sonata-driven switch.
    const reconciledMode = codexPermissionModeFromTurnContext(
      context.sandboxPolicy,
      context.approvalPolicy,
    );
    const nextMode = reconciledMode ?? active.task.codexPermissionMode;
    // Same metadata-write discipline as the receipt reconcilers above: TaskMirror
    // mirrors in place with a frozen updatedAt, persists, and emits ONE
    // task:updated only when model, effort, or the permission mode actually moved.
    this.taskMirror.apply(active, {
      model: nextModel,
      reasoningEffort: nextEffort,
      codexPermissionMode: nextMode,
    });
  }

  /**
   * Surface / reconcile a native AskUserQuestion (Slice 5) from the hooks sonata
   * already injects. Phase 0: `PreToolUse` carries the questions structurally,
   * `PostToolUse` carries the verbatim answers. `Stop` with a prompt still open
   * means it was cancelled (or finished without a PostToolUse) → clear the card.
   * Detection is structured, not scraped; the floor stays a valid alternative.
   */
  private handleOptionPromptHook(active: ActiveTaskRuntime, payload: HookPayload): void {
    const event = typeof payload.hook_event_name === "string" ? payload.hook_event_name : "";
    const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";

    if (tool === "AskUserQuestion" && event === "PreToolUse") {
      const toolUseId = typeof payload.tool_use_id === "string" ? payload.tool_use_id : null;
      const prompt = parseOptionPrompt(toolUseId, payload.tool_input);
      if (!prompt) {
        return; // malformed input → fall through to the floor, never a broken card
      }
      // Drawer S1: every question kind is card-answerable (single-select,
      // multi-select toggles, free-text on single-select) via the verified
      // 2.1.212 grammar; free-text on a multiSelect question stays terminal-
      // answered (probe P9f: the digit path mis-answers there).
      active.pendingOptionPrompt = prompt;
      active.lastOptionPromptResolution = null;
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
      const answers = reconcileOptionPromptAnswers(payload.tool_response);
      active.pendingOptionPrompt = null;
      // answered=true ONLY with a real answers object — a PostToolUse without
      // one (e.g. a decline reaching PostToolUse in some future CLI) must not
      // corroborate a Send.
      active.lastOptionPromptResolution = { toolUseId, answered: answers !== null };
      this.sendEvent({
        type: "option-prompt:resolved",
        payload: {
          taskId: active.task.id,
          toolUseId,
          answers,
        },
        ts: new Date().toISOString(),
      });
      return;
    }

    if (event === "Stop" && active.pendingOptionPrompt) {
      const toolUseId = active.pendingOptionPrompt.toolUseId;
      active.pendingOptionPrompt = null;
      active.lastOptionPromptResolution = { toolUseId, answered: false };
      this.sendEvent({
        type: "option-prompt:resolved",
        payload: { taskId: active.task.id, toolUseId, answers: null },
        ts: new Date().toISOString(),
      });
    }
  }

  /**
   * Answer a pending AskUserQuestion by playing back the verified key sequence
   * (full grammar since drawer S1: single-select, multi-select, free-text).
   * Guards on the `toolUseId` so a stale card (already answered, cancelled, or
   * superseded by a newer prompt) is a no-op rather than a mis-injection.
   *
   * CORROBORATED, not optimistic (drawer S1): resolves only after the CLI's own
   * PostToolUse cleared the pending prompt (`option-prompt:resolved` has then
   * already been emitted). If the injection is swallowed (TUI repaint, upstream
   * drift) this THROWS instead of letting the renderer show a receipt for an
   * answer the CLI never received — the failure the field reported as
   * "selected but nothing was sent".
   */
  async answerOptionPrompt(
    taskId: TaskId,
    toolUseId: string,
    selections: OptionPromptSelection[],
  ): Promise<void> {
    const active = this.requireTaskRuntime(taskId);
    const prompt = active.pendingOptionPrompt;
    if (!prompt || prompt.toolUseId !== toolUseId) {
      return;
    }
    const keys = optionPromptAnswerSequence(prompt.questions, selections);
    await active.terminalHost.sendOptionPromptAnswer(keys);
    const outcome = await this.waitForOptionPromptClear(active, toolUseId, 6_000);
    // Only an ANSWERED resolution confirms the Send. A fallback clear (Stop,
    // pty-exit, a terminal-side decline racing the card) reaches the renderer
    // as `answers: null` — reporting success there would be the exact fake-
    // success class this slice exists to kill (reviewer finding 4).
    if (outcome !== "answered") {
      throw new Error("The CLI did not confirm the answer — check the CLI, then try again.");
    }
  }

  /**
   * Dismiss a pending AskUserQuestion (the drawer's ✕): injects the synthetic
   * "Chat about this" digit, which declines every question instantly and ends
   * the turn cleanly (probe P7/P9d/P9e — incl. multiSelect-first forms). The
   * decline itself fires NO PostToolUse; the prompt clears on the turn's Stop.
   * The window covers the model's short post-decline reply. On TIMEOUT (the
   * model kept working past the window) the prompt is cleared LOCALLY: the
   * decline itself is near-certain (same injection path every answer uses) and
   * an un-frozen stale card would let a later Send inject digits into the live
   * composer — the worse failure direction. The residual risk (dismiss digit
   * swallowed AND window exceeded) leaves the form open in the CLI, where the
   * turn stays visibly busy.
   */
  async dismissOptionPrompt(taskId: TaskId, toolUseId: string): Promise<void> {
    const active = this.requireTaskRuntime(taskId);
    const prompt = active.pendingOptionPrompt;
    if (!prompt || prompt.toolUseId !== toolUseId) {
      return;
    }
    const keys = optionPromptDismissSequence(prompt.questions);
    await active.terminalHost.sendOptionPromptAnswer(keys);
    const outcome = await this.waitForOptionPromptClear(active, toolUseId, 45_000);
    if (outcome === "timeout") {
      if (active.pendingOptionPrompt?.toolUseId === toolUseId) {
        active.pendingOptionPrompt = null;
        active.lastOptionPromptResolution = { toolUseId, answered: false };
        this.sendEvent({
          type: "option-prompt:resolved",
          payload: { taskId: active.task.id, toolUseId, answers: null },
          ts: new Date().toISOString(),
        });
      }
    }
  }

  /** Poll until the pending prompt with `toolUseId` clears, then report HOW it
   *  resolved: "answered" (PostToolUse with real answers), "cleared" (fallback:
   *  Stop / pty-exit / decline — `option-prompt:resolved` carried null), or
   *  "timeout". The distinction is load-bearing for Send corroboration. */
  private async waitForOptionPromptClear(
    active: ActiveTaskRuntime,
    toolUseId: string,
    timeoutMs: number,
  ): Promise<"answered" | "cleared" | "timeout"> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pending = active.pendingOptionPrompt;
      if (!pending || pending.toolUseId !== toolUseId) {
        const resolution = active.lastOptionPromptResolution;
        return resolution?.toolUseId === toolUseId && resolution.answered ? "answered" : "cleared";
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return "timeout";
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
        // it just spawned. The other sanctioned binding write is the
        // hook-owned rebind in adoptTranscriptFromHook (the CLI declaring its
        // own session after /clear or a native /resume); it updates the ref
        // BEFORE the source attaches, so it never reaches this branch.
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
          `[sonata] suppressed session rebind for ${active.task.id}: bound=${current} located=${latest.providerSessionId}`,
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
      codexPermissionMode: CodexPermissionMode | null;
      permissionMode: ClaudePermissionMode | null;
    };
    remoteControl: boolean;
    resumeRef?: string | null;
    sessionId?: string | null;
    extraEnv?: Record<string, string>;
    rows?: number | undefined;
    cols?: number | undefined;
    /** Codex only: the cwd this spawn adds to the trust ledger, or null. The
     *  policy that computes it lives in the callers (createTask/openTask). */
    pretrustCwd?: string | null;
  }): StartTaskOptions {
    // Per-task hook binding travels via env (D4): Codex hooks inherit the spawn
    // env, so the frozen shim commands read SONATA_RUNTIME_DIR to find THIS task's
    // sink — sink-dir ownership is the nonce that keeps two same-cwd tasks
    // isolated. Force the binding for BOTH providers: Sonata itself may have been
    // launched inside a Codex session, and a Claude child must not inherit that
    // parent task's SONATA_RUNTIME_DIR. The forced binding follows caller overlays
    // (e.g. Claude's resume-panel suppression), so no call site can replace it.
    //
    // SONATA_NODE rides the exact SAME proven env channel (probe P1/caveat 2):
    // every injected hook/broker/statusline command runs its shim via
    // `ELECTRON_RUN_AS_NODE=1 "${SONATA_NODE:-node}"` (SONATA_INTERPRETER_PREFIX),
    // binding the shims to Sonata's OWN bundled runtime instead of an undeclared
    // host `node`. It is env-KEYED, never inlined into the command text, so an app
    // path with spaces/quotes needs no shell-quoting guard — the value is carried
    // out-of-band and the sole expansion site (in the prefix) is double-quoted.
    // ELECTRON_RUN_AS_NODE deliberately stays INLINE in the command strings and is
    // NOT set here: an env-level ELECTRON_RUN_AS_NODE would poison any Electron
    // binary the CLI's own children spawn, silently turning them into node too.
    const extraEnv: Record<string, string> = {
      ...(args.extraEnv ?? {}),
      SONATA_RUNTIME_DIR: runtimeDir(args.taskId),
      SONATA_NODE: process.execPath,
    };
    return {
      cwd: args.cwd,
      // Claude's hooks/usage/settings live HERE (D8) — Sonata-owned, outside the
      // agent's working directory, so nothing Sonata writes into the user's repo
      // and the hook watcher (also keyed by runtimeDir) keeps seeing them —
      // on fresh spawn and resume alike.
      runtimeDir: runtimeDir(args.taskId),
      model: args.model,
      reasoningEffort: args.reasoningEffort,
      speedMode: args.speedMode,
      ...(args.provider === "claude"
        ? {
            permissionMode: args.permissionSettings.permissionMode ?? "default",
            // The PermissionRequest broker is always constructed (approvalWatcher
            // above), so Claude runs broker-ON. Declared EXPLICITLY (not left to
            // the default) so terminal-host arms the S4b R1 broker-ON gate: the
            // grid scrape must not surface a native card the broker owns.
            // Settings injection is unchanged (it already read this as broker-on).
            approvalBroker: true,
          }
        : {
            codexPermissionMode:
              args.permissionSettings.codexPermissionMode ?? "ask-for-approval",
          }),
      ...(args.provider === "claude" && args.remoteControl ? { remoteControl: true } : {}),
      // Codex hook injection (S2): buildArgs writes the profile+shims and adds
      // `-p sonata`. The controller supplies the Sonata-home shim dir because it
      // owns Sonata-home; the codex edge owns the profile-file location. It also
      // supplies `pretrustCwd` (the trust-ledger policy) — the mechanism that folds
      // it in lives in the codex edge.
      ...(args.provider === "codex"
        ? { codexHookPaths: { binDir: sonataBinDir(), pretrustCwd: args.pretrustCwd ?? null } }
        : {}),
      ...(args.resumeRef ? { resumeRef: args.resumeRef } : {}),
      // --session-id pins a fresh session only; --resume already owns the id.
      ...(!args.resumeRef && args.sessionId ? { sessionId: args.sessionId } : {}),
      ...(Object.keys(extraEnv).length > 0 ? { extraEnv } : {}),
      ...(args.rows !== undefined ? { rows: args.rows } : {}),
      ...(args.cols !== undefined ? { cols: args.cols } : {}),
    };
  }

  /**
   * The cwd a codex spawn pre-trusts in its profile trust ledger, or null. Policy
   * (Woody, 2026-07-18): a Sonata-created task dir is ALWAYS pre-trusted — Sonata
   * just made the empty dir, so codex's trust question is vacuous. A user-chosen
   * project dir is pre-trusted ONLY when the user opted in via
   * `autoTrustProjectFolders`; the default keeps codex's directory-trust dialog
   * (its prompt-injection defense) rendering in the co-visible Terminal. Non-codex
   * providers never carry a ledger. This is the single home of the policy;
   * codex-runtime-settings is mechanism.
   */
  private codexPretrustCwd(
    provider: RuntimeProvider,
    autoWorkspace: boolean,
    providerCwd: string,
  ): string | null {
    if (provider !== "codex") {
      return null;
    }
    if (autoWorkspace) {
      return providerCwd;
    }
    return this.codexSettingsStore.read().autoTrustProjectFolders ? providerCwd : null;
  }

  private autoWorkspacePath(taskId: TaskId): string {
    // The user's VISIBLE work for a project-less session — kept cleanly separate
    // from Sonata's hidden records (P1). The folder name is display-only; the stored
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
    return process.env.SONATA_WORKSPACES_DIR || path.join(app.getPath("documents"), "Sonata");
  }

  private normalizeDeliveryAttachments(
    active: ActiveTaskRuntime,
    attachments: DeliveryAttachment[],
  ): DeliveryAttachment[] {
    const attachmentDirectory = `${attachmentsRootForTask(active.task.id)}${path.sep}`;
    return attachments.map((attachment) => {
      const resolved = path.resolve(attachment.path);
      if (attachment.provenance === "blob") {
        // Sonata-owned blob: MUST live inside the per-task attachments dir and be a
        // real image. (No space-reject — delivery double-quotes the path now.)
        if (!resolved.startsWith(attachmentDirectory)) {
          throw new Error("Attachment path was not a generated Sonata attachment path.");
        }
        if (!fs.existsSync(resolved)) {
          throw new Error(`Attachment file is missing: ${attachment.originalName}`);
        }
        if (!normalizeImageMediaType(attachment.mediaType, attachment.originalName, fs.readFileSync(resolved))) {
          throw new Error(`Attachment is not a supported image: ${attachment.originalName}`);
        }
        return { ...attachment, path: resolved };
      }
      // Referenced: the user's own path, anywhere. It MUST exist; Sonata NEVER reads
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
      throw new Error("No persisted Sonata Task was found for the selected folder.");
    }
    return this.latestTaskStorageRoot();
  }

  private latestTaskStorageRoot(): string {
    const candidates = this.taskManifestCandidates()
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const latest = candidates[0]?.storageRoot;
    if (!latest) {
      throw new TaskNotFoundError("No persisted Sonata Task was found.");
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
    // Migrate the Codex permission vocabulary at the single manifest-read seam,
    // so every downstream reader (reopen, listTasks, archive) sees one clean
    // `codexPermissionMode` and the retired (sandbox, approval) axis fields are
    // never carried forward into a new write.
    return { ...manifest, task: migrateTaskPermissionRecord(manifest.task) };
  }

  private persistTaskManifest(
    task: Task,
    storageRoot: string,
    reason: "session-updated" | "session-renamed" = "session-updated",
    emitUpdate = true,
  ): void {
    const manifest = freshTaskManifestV1(task);
    const manifestPath = taskManifestPath(storageRoot);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    const tmpPath = `${manifestPath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.renameSync(tmpPath, manifestPath);
    if (emitUpdate) {
      this.emitSessionsUpdated(reason);
    }
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
        const manifest = this.readTaskManifest(direct);
        // Trust the direct path only when the record it holds is actually
        // THIS task's. projectRecordRoot is a bare path.join, so a crafted or
        // stale taskId can land on a different task's record dir; without this
        // guard that mismatched record would be returned as "persisted" — a
        // wrong answer for every caller (a bogus dormant snapshot, a rename or
        // archive against the wrong task, a delete of the wrong record dir, and
        // -32002 taskNotLive where -32001 taskNotFound is correct). On mismatch,
        // fall through to the id-matched candidates scan exactly like an
        // unreadable manifest does.
        if (manifest.task.id === taskId) {
          return { storageRoot: direct, manifest };
        }
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

// Records live DIRECTLY under the task's record root (~/.sonata/data/projects/
// <taskId>/) — no nested `.sonata`, which was redundant once the whole tree is
// Sonata-owned and hidden (C6).

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

/** Providers whose sessions Sonata injects hooks into (Claude via `--settings`,
 *  Codex via `-p sonata`). Both currently, but a named capability — not a
 *  provider list — so a future non-hook provider is opted OUT by default. */
function isHookCapable(provider: RuntimeProvider): boolean {
  return provider === "claude" || provider === "codex";
}

/**
 * Fold a persisted task record's Codex permission onto the single
 * `codexPermissionMode` field and drop the retired (sandbox, approval) axis
 * keys a pre-swap manifest carried, so they are never written back. Runs once,
 * at the manifest-read seam.
 */
function migrateTaskPermissionRecord(task: Task): Task {
  const codexPermissionMode = migrateCodexPermissionMode(
    task as unknown as Record<string, unknown>,
  );
  const { sandbox: _sandbox, approval: _approval, ...rest } = task as unknown as Record<
    string,
    unknown
  > & { sandbox?: unknown; approval?: unknown };
  void _sandbox;
  void _approval;
  return { ...(rest as unknown as Task), codexPermissionMode };
}

function normalizeTaskForProviderCwd(task: Task, providerCwd: string): Task {
  const launchSettings = normalizeLaunchSettings(task);
  // The manifest-read seam already migrated the permission record; validate the
  // resulting mode (idempotent) so a hand-built task in a test is also clamped.
  const permissionSettings = normalizePermissionSettings(task.provider, {
    permissionMode: task.permissionMode,
    codexPermissionMode: task.codexPermissionMode,
  });
  return {
    ...task,
    model: launchSettings.model,
    reasoningEffort: launchSettings.reasoningEffort,
    speedMode: launchSettings.speedMode,
    codexPermissionMode: permissionSettings.codexPermissionMode,
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

function normalizeLaunchSettings(request: {
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  speedMode?: LaunchSpeedMode | null;
}): { model: string | null; reasoningEffort: ReasoningEffort | null; speedMode: LaunchSpeedMode | null } {
  const model = request.model?.trim() || null;
  const requestedReasoningEffort = request.reasoningEffort ?? null;
  const reasoningEffort = REASONING_EFFORTS.has(requestedReasoningEffort as ReasoningEffort)
    ? (requestedReasoningEffort as ReasoningEffort)
    : null;
  // Speed applies to both providers now (Codex via `-c service_tier=priority`,
  // Claude via `fastMode` in the injected `--settings`). The per-model Fast gate
  // is enforced in the launch UI; here we only validate the enum.
  const speedMode =
    request.speedMode === "default" || request.speedMode === "fast" ? request.speedMode : null;

  return {
    model,
    reasoningEffort,
    speedMode,
  };
}

function normalizePermissionSettings(
  provider: RuntimeProvider,
  request: {
    codexPermissionMode?: CodexPermissionMode | null;
    permissionMode?: ClaudePermissionMode | null;
  },
): {
  codexPermissionMode: CodexPermissionMode | null;
  permissionMode: ClaudePermissionMode | null;
} {
  if (provider === "claude") {
    const permissionMode = CLAUDE_PERMISSION_MODES.has(
      request.permissionMode as ClaudePermissionMode,
    )
      ? (request.permissionMode as ClaudePermissionMode)
      : "default";
    return {
      codexPermissionMode: null,
      permissionMode,
    };
  }

  // The controller boundary accepts only the three new values; a raw axis value
  // or the retired `on-failure` never survives to the spawn seam.
  const codexPermissionMode = isCodexPermissionMode(request.codexPermissionMode)
    ? request.codexPermissionMode
    : "ask-for-approval";
  return {
    codexPermissionMode,
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

function toolInputRecord(payload: HookPayload): Record<string, unknown> {
  const input = payload.tool_input;
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/** Map the hook's tool to Sonata's ApprovalKind (mirrors the scrape grammar). */
export function classifyApprovalKind(payload: HookPayload): ApprovalKind {
  const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
  if (tool === "Bash") return "command";
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit")
    return "file-edit";
  if (tool === "Read" || tool === "NotebookRead") return "file-read";
  return "unknown";
}

/** The one-line "what the agent wants to do", from tool_name/tool_input.
 *  Codex's `tool_input.description` is ready-made human approval copy ("Do you
 *  want to allow writing …?") — render it verbatim when present (older Codex
 *  builds still send it; probe-verified 0.142.5). Claude payloads have no such
 *  field, so they keep the tool-derived summary below; the description
 *  preference is Codex-scoped to leave Claude's card copy byte-identical.
 *
 *  Codex 0.144.4 dropped `description`: a write approval now arrives as
 *  `tool_name: "apply_patch"` carrying only `tool_input.command` (the raw patch
 *  envelope). Without a branch it fell through to the generic tail and rendered
 *  a bare "apply_patch" with no file names — so we parse the envelope's file-op
 *  lines for a human summary (probe P2, spikes/codex-hooks-probe/probe-0144). */
/** The raw subject of an ask — full command or file path — for the drawer's
 *  code block (drawer S2). Soft 400 cap; null when the payload has no single
 *  subject (kind-only asks like workspace-trust / dangerous-bypass). */
export function approvalDetail(payload: HookPayload): string | null {
  const input = toolInputRecord(payload);
  const str = (key: string): string | null =>
    typeof input[key] === "string" && (input[key] as string).trim()
      ? (input[key] as string)
      : null;
  const subject =
    str("command") ?? str("file_path") ?? str("path") ?? str("notebook_path");
  if (!subject) {
    return null;
  }
  return subject.length > 400 ? `${subject.slice(0, 399)}…` : subject;
}

export function approvalSummary(payload: HookPayload, provider: RuntimeProvider): string {
  const input = toolInputRecord(payload);
  const str = (key: string): string | null =>
    typeof input[key] === "string" ? (input[key] as string) : null;
  if (provider === "codex") {
    const description = str("description");
    if (description && description.trim()) {
      return truncateMiddle(description, 120);
    }
  }
  const tool = typeof payload.tool_name === "string" ? payload.tool_name : "tool";
  if (tool === "Bash") return `Run  ${truncateMiddle(str("command") ?? "(command)", 80)}`;
  // Codex apply_patch: derive the op + path(s) from the patch envelope. Claude
  // never emits this tool, so the branch is inert for Claude payloads.
  if (tool === "apply_patch") return summarizeApplyPatch(str("command") ?? "");
  const filePath = str("file_path") ?? str("path") ?? str("notebook_path");
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit")
    return `Edit  ${truncateMiddle(filePath ?? "(file)", 72)}`;
  if (tool === "Read" || tool === "NotebookRead")
    return `Read  ${truncateMiddle(filePath ?? "(file)", 72)}`;
  return `${tool}${filePath ? `  ${truncateMiddle(filePath, 72)}` : ""}`;
}

/**
 * Summarize an OpenAI apply_patch envelope in the same voice as the tool
 * branches above (`Edit  <path>`, truncated). We read ONLY the file-op header
 * lines of the patch grammar — never the hunk body:
 *   `*** Add File: <path>`    → Add
 *   `*** Update File: <path>` → Edit   (a following `*** Move to:` is ignored;
 *                                       the summary names the file being changed)
 *   `*** Delete File: <path>` → Delete
 * The `***` is anchored at column 0 (no leading trim): hunk context lines carry
 * a single-space prefix, so a body line that literally reads `*** Update File:
 * decoy.ts` is NOT a header and must not inflate the op count. Single file →
 * `<Verb>  <path>`; multiple → first op + ` (+N more)`. A malformed/empty
 * envelope falls back to a bare `Apply patch` — never throws.
 */
function summarizeApplyPatch(envelope: string): string {
  // Same file-op grammar as the semantic change-attribution extractor (OBS S6):
  // single-sourced in `parseApplyPatchOps` so the two consumers can never drift.
  const ops = parseApplyPatchOps(envelope);
  const first = ops[0];
  if (!first) return "Apply patch";
  const verb = first.verb === "Add" ? "Add" : first.verb === "Delete" ? "Delete" : "Edit";
  const label = `${verb}  ${truncateMiddle(first.path, 72)}`;
  return ops.length === 1 ? label : `${label} (+${ops.length - 1} more)`;
}

function truncateMiddle(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${clean.slice(0, head)}…${clean.slice(clean.length - tail)}`;
}

/**
 * The choices on a hook-broker card (answered via the reply file). The "Always"
 * label/description states the ACTUAL persisted rule, not a vague "this command"
 * — because for Bash the rule is `Bash(<firstToken>:*)` (approving `git status`
 * allows all git commands; the label renders it as "git *" for humans). The
 * button must not promise narrower than it grants (reviewer P2, trust boundary).
 *
 * Codex omits "Always": its decision protocol honors only `behavior: allow|deny`
 * — persistent-rule support (`updatedPermissions`) is an UNVERIFIED open probe
 * (see codex-approvals.ts), so we never offer a button we cannot honor.
 */
export function brokerApprovalChoices(
  kind: ApprovalKind,
  payload: HookPayload,
  provider: RuntimeProvider,
): ApprovalChoice[] {
  // encodedAs "reply-file": these choices answer on the hook channel — no
  // bytes ever touch the PTY (S6 review P3; the decision event says the
  // same, so the report's provenance is consistent end to end).
  const approve: ApprovalChoice = {
    decision: "approve",
    label: "Approve",
    description: "Allow once",
    encodedAs: "reply-file",
  };
  const deny: ApprovalChoice = {
    decision: "deny",
    label: "Deny",
    description: "Reject this request",
    encodedAs: "reply-file",
  };
  if (provider === "codex") {
    return [approve, deny];
  }
  const scope = alwaysAllowScopeLabel(kind, payload); // e.g. "git *", "edits", "reads"
  return [
    approve,
    {
      decision: "approve-always",
      // Plain label (Woody, 2026-07-17); the tooltip keeps the ACTUAL persisted
      // rule scope so the button still never promises narrower than it grants
      // (reviewer P2, trust boundary — the detail moved, it didn't disappear).
      label: "Always approve",
      description: scope ? `Always approve ${scope} — saves an allow rule` : "Always allow",
      encodedAs: "reply-file",
    },
    deny,
  ];
}

/** Human label for what "Always" actually persists — matches `alwaysAllowRule`. */
function alwaysAllowScopeLabel(kind: ApprovalKind, payload: HookPayload): string | null {
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
function brokerDecisionJson(decision: ApprovalDecision, payload: HookPayload): unknown {
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
function alwaysAllowRule(payload: HookPayload): Record<string, unknown> | null {
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
