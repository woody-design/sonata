import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import type {
  DeliveryAttachment,
  ArtifactCandidate,
  ApprovalDecision,
  ClaudePermissionMode,
  CodexApprovalMode,
  CodexPermissionPreset,
  CodexSandboxMode,
  CreateTaskRequest,
  CreateTaskResponse,
  DeliveryControlChange,
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
import type { RunIndexEvent } from "../shared/types/events";
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
  TerminalHost,
  WorkspacePreview,
  ClaudeStatuslineUsageWatcher,
  parseClaudeStatuslinePayload,
  type ResolveRunIdInput,
  StatusRegionTracker,
} from "../runtime";
import { buildSessionIndex } from "./session-index";
import { listSlashCommands as discoverSlashCommands } from "./skills-discovery";
import type { ProjectsStore } from "./projects-store";

const DEFAULT_TASK_TITLE = "New Task";
const AUTO_TITLE_PLACEHOLDERS = new Set(["New Task", "Walking Skeleton Task"]);
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
  /** Last automatically applied title (run prompt or provider session
   *  name). null = unknown provenance (e.g. reopened task) → never
   *  auto-rename. A user rename makes title diverge from this. */
  autoTitle: string | null;
}

export class RuntimeController {
  private readonly sendEvent: (event: RuntimeEvent) => void;
  private readonly projectsStore: ProjectsStore;
  private readonly claudeUsageWatcher: ClaudeStatuslineUsageWatcher;
  private readonly taskRuntimes = new Map<TaskId, ActiveTaskRuntime>();
  private readonly usageSnapshots = new Map<TaskId, UsageSnapshot>();
  private readonly pendingClaudeUsage = new Map<string, UsageSnapshot>();
  private taskSeq = 0;
  private attachmentSeq = 0;

  constructor(options: RuntimeControllerOptions) {
    this.sendEvent = options.sendEvent;
    this.projectsStore = options.projectsStore;
    this.claudeUsageWatcher = new ClaudeStatuslineUsageWatcher({
      onPayload: (payload, _filePath, mtimeMs) =>
        this.handleClaudeStatuslinePayload(payload, mtimeMs),
      onError: (error, filePath) => {
        console.debug(
          `[usage] skipped Claude statusline payload${filePath ? ` ${filePath}` : ""}: ${error.message}`,
        );
      },
    });
  }

  createTask(request: CreateTaskRequest): CreateTaskResponse {
    assertSupportedProvider(request.provider);

    const now = new Date().toISOString();
    const taskId = this.nextTaskId();
    const storageRoot = this.defaultWorkspacePath(taskId);
    const providerCwd = path.resolve(request.cwd ?? storageRoot);
    const reportPath = runtimeReportPath(storageRoot);
    fs.mkdirSync(duetDirectory(storageRoot), { recursive: true });
    const launchSettings = normalizeLaunchSettings(request.provider, request);
    const permissionSettings = normalizePermissionSettings(request.provider, request);

    if (request.cwd) {
      this.projectsStore.noteFolderUsed(providerCwd);
    }

    const task: Task = {
      id: taskId,
      title: request.title?.trim() || DEFAULT_TASK_TITLE,
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
      status: "starting",
      createdAt: now,
      updatedAt: now,
    };

    const runIndex = new RunIndex({ taskId, reportPath });
    const providerTranscript = this.createProviderTranscript(
      taskId,
      request.provider,
      providerCwd,
      runIndex,
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
      applyControlChange: (change) => this.applyControlChange(taskId, change),
      cleanupAttachments: (attachments) => this.cleanupAttachments(taskId, attachments),
    });
    const statusTracker = new StatusRegionTracker({
      taskId,
      provider: request.provider,
      eventSink: (event) => this.sendEvent(event),
    });

    const startOptions = {
      cwd: providerCwd,
      sandbox: permissionSettings.sandbox ?? "read-only",
      approval: permissionSettings.approval ?? "on-request",
      model: launchSettings.model,
      reasoningEffort: launchSettings.reasoningEffort,
      speedMode: launchSettings.speedMode,
      ...(request.provider === "claude"
        ? { permissionMode: permissionSettings.permissionMode ?? "default" }
        : {}),
    };
    const ptyStartedAt = new Date().toISOString();
    const runtime = terminalHost.startTask({
      ...startOptions,
      ...(request.rows !== undefined ? { rows: request.rows } : {}),
      ...(request.cols !== undefined ? { cols: request.cols } : {}),
    });

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
      autoTitle: null,
    };
    this.taskRuntimes.set(activeTask.task.id, activeTask);
    this.watchClaudeUsage(activeTask);
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
    };
    const reportPath = runtimeReportPath(storageRoot);
    const runIndex = new RunIndex({
      taskId: runningTask.id,
      reportPath,
      loadExisting: true,
    });
    const providerTranscript = this.createProviderTranscript(
      runningTask.id,
      runningTask.provider,
      providerCwd,
      runIndex,
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
      applyControlChange: (change) => this.applyControlChange(runningTask.id, change),
    });
    const statusTracker = new StatusRegionTracker({
      taskId: runningTask.id,
      provider: runningTask.provider,
      eventSink: (event) => this.sendEvent(event),
    });

    const ptyStartedAt = new Date().toISOString();
    const runtime = terminalHost.startTask({
      cwd: providerCwd,
      sandbox: permissionSettings.sandbox ?? "read-only",
      approval: permissionSettings.approval ?? "on-request",
      model: runningTask.model,
      reasoningEffort: runningTask.reasoningEffort,
      speedMode: runningTask.speedMode,
      ...(runningTask.provider === "claude"
        ? { permissionMode: permissionSettings.permissionMode ?? "default" }
        : {}),
      ...(resumeRef ? { resumeRef } : {}),
      ...(request.rows !== undefined ? { rows: request.rows } : {}),
      ...(request.cols !== undefined ? { cols: request.cols } : {}),
    });

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
      autoTitle: null,
    };
    this.taskRuntimes.set(runningTask.id, activeTask);
    this.watchClaudeUsage(activeTask);
    this.persistTaskManifest(runningTask, storageRoot);

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
      taskStorageRoot: this.taskStorageRoot(),
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
      const providerCwd = taskProviderCwd(record.manifest.task, record.storageRoot);
      const insideCentralRoot = isPathInside(this.taskStorageRoot(), record.storageRoot);
      if (pathsEqual(providerCwd, record.storageRoot)) {
        // Auto-workspace session: the storage root doubles as the working
        // folder and may hold agent-created artifacts. Keep any content
        // beyond .duet; never silently destroy work products.
        if (insideCentralRoot && !hasContentBesidesDuet(record.storageRoot)) {
          fs.rmSync(record.storageRoot, { recursive: true, force: true });
        } else {
          fs.rmSync(duetDirectory(record.storageRoot), { recursive: true, force: true });
        }
      } else if (insideCentralRoot) {
        // User-picked folder: the storage root holds only Duet records.
        // The user's working folder and the provider transcript stay.
        fs.rmSync(record.storageRoot, { recursive: true, force: true });
      } else {
        // Legacy manifest living inside a user folder: remove only .duet.
        fs.rmSync(duetDirectory(record.storageRoot), { recursive: true, force: true });
      }
    }
    this.emitSessionsUpdated("session-deleted");
  }

  async dismissModal(taskId: TaskId): Promise<{ cleared: boolean }> {
    const active = this.requireTaskRuntime(taskId);
    const cleared = await active.terminalHost.dismissModal();
    return { cleared };
  }

  setTerminalUserControl(taskId: TaskId, requestedActive: boolean): { active: boolean } {
    const active = this.requireTaskRuntime(taskId);
    return { active: active.terminalHost.setUserControl(requestedActive) };
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
    active.deliveryController.enqueue(text, this.normalizeDeliveryAttachments(active, attachments));
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
    const attachmentDirectory = attachmentsDirectory(active.storageRoot);
    fs.mkdirSync(attachmentDirectory, { recursive: true });
    const attachmentPath = path.join(attachmentDirectory, filename);
    fs.writeFileSync(attachmentPath, bytes, { flag: "wx" });
    return {
      id,
      path: attachmentPath,
      originalName: input.originalName.trim() || filename,
      mediaType,
      size: bytes.length,
    };
  }

  deleteAttachment(taskId: TaskId, attachmentId: string): void {
    const active = this.requireTaskRuntime(taskId);
    const attachmentDirectory = attachmentsDirectory(active.storageRoot);
    const files = fs.existsSync(attachmentDirectory) ? fs.readdirSync(attachmentDirectory) : [];
    for (const file of files) {
      if (file.startsWith(`${attachmentId}.`)) {
        fs.rmSync(path.join(attachmentDirectory, file), { force: true });
      }
    }
  }

  setControl(taskId: TaskId, change: DeliveryControlChange): void {
    const active = this.requireTaskRuntime(taskId);
    active.deliveryController.enqueueControl(normalizeControlChange(active.task.provider, change));
  }

  cancelQueuedPrompt(taskId: TaskId, itemId: string): void {
    const active = this.requireTaskRuntime(taskId);
    active.deliveryController.cancel(itemId);
  }

  retryQueuedPrompt(taskId: TaskId, itemId: string): void {
    const active = this.requireTaskRuntime(taskId);
    active.deliveryController.retry(itemId);
  }

  decideApproval(taskId: TaskId, decision: ApprovalDecision): void {
    const active = this.requireTaskRuntime(taskId);
    if (decision === "approve") {
      active.terminalHost.sendApprove();
      return;
    }
    if (decision === "approve-for-session") {
      active.terminalHost.sendApproveForSession();
      return;
    }
    active.terminalHost.sendDeny();
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
  }

  private async applyControlChange(taskId: TaskId, change: DeliveryControlChange): Promise<void> {
    const active = this.requireTaskRuntime(taskId);
    const normalized = normalizeControlChange(active.task.provider, change);
    await active.terminalHost.applyControlChange(normalized);

    active.task = applyVerifiedControlToTask(active.task, normalized);
    this.persistTaskManifest(active.task, active.storageRoot);
    this.sendEvent({
      type: "task:updated",
      payload: {
        taskId,
        task: active.task,
        reason: "verified-native-control",
      },
      ts: new Date().toISOString(),
    });
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

    if (
      event.type === "pty:data" ||
      event.type === "report:updated" ||
      event.type === "transcript:blocks" ||
      event.type === "delivery:state" ||
      event.type === "delivery:receipt" ||
      event.type === "terminal:user-control"
    ) {
      return;
    }

    const summary = runIndex.consume(event as RunIndexEvent);
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
      throw new Error("No runtime task matches the requested taskId.");
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
    this.unwatchClaudeUsage(active);
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
      this.claudeUsageWatcher.watchWorkspace(active.task.providerCwd);
    }
  }

  private unwatchClaudeUsage(active: ActiveTaskRuntime): void {
    if (active.task.provider === "claude") {
      this.claudeUsageWatcher.unwatchWorkspace(active.task.providerCwd);
    }
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
  ): ProviderTranscript {
    return new ProviderTranscript({
      taskId,
      provider,
      providerCwd,
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
    if (latest && active.task.providerSessionRef !== latest.providerSessionId) {
      active.task = {
        ...active.task,
        providerSessionRef: latest.providerSessionId,
        updatedAt: new Date().toISOString(),
      };
      this.persistTaskManifest(active.task, active.storageRoot);
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

  private defaultWorkspacePath(taskId: TaskId): string {
    return path.join(this.taskStorageRoot(), taskId);
  }

  private taskStorageRoot(): string {
    return process.env.DUET_PROJECTS_DIR || path.join(app.getPath("documents"), "Duet Projects");
  }

  private normalizeDeliveryAttachments(
    active: ActiveTaskRuntime,
    attachments: DeliveryAttachment[],
  ): DeliveryAttachment[] {
    const attachmentDirectory = `${attachmentsDirectory(active.storageRoot)}${path.sep}`;
    return attachments.map((attachment) => {
      const resolved = path.resolve(attachment.path);
      if (!resolved.startsWith(attachmentDirectory) || resolved.includes(" ")) {
        throw new Error("Attachment path was not a generated Duet attachment path.");
      }
      if (!fs.existsSync(resolved)) {
        throw new Error(`Attachment file is missing: ${attachment.originalName}`);
      }
      if (!normalizeImageMediaType(attachment.mediaType, attachment.originalName, fs.readFileSync(resolved))) {
        throw new Error(`Attachment is not a supported image: ${attachment.originalName}`);
      }
      return {
        ...attachment,
        path: resolved,
      };
    });
  }

  private cleanupAttachments(_taskId: TaskId, attachments: DeliveryAttachment[]): void {
    for (const attachment of attachments) {
      fs.rmSync(attachment.path, { force: true });
    }
  }

  private resolveOpenTaskStorageRoot(request: OpenTaskRequest): string {
    if (request.taskId) {
      const candidate = this.defaultWorkspacePath(request.taskId);
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
      if (fs.existsSync(taskManifestPath(cwd))) {
        return cwd;
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
      throw new Error("No persisted Duet Task was found.");
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
    const projectRoot = this.taskStorageRoot();
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
      throw new Error("Task manifest was not found.");
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
    const direct = this.defaultWorkspacePath(taskId);
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
      throw new Error("No persisted session matches the requested taskId.");
    }
    return record;
  }
}

function duetDirectory(cwd: string): string {
  return path.join(cwd, ".duet");
}

function taskManifestPath(cwd: string): string {
  return path.join(duetDirectory(cwd), "task.json");
}

function runtimeReportPath(cwd: string): string {
  return path.join(duetDirectory(cwd), "runtime-report.json");
}

function transcriptSourcesPath(cwd: string): string {
  return path.join(duetDirectory(cwd), "transcript-sources.json");
}

function attachmentsDirectory(cwd: string): string {
  return path.join(duetDirectory(cwd), "attachments");
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

const SUPPORTED_IMAGE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const IMAGE_EXTENSION_MEDIA_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

function resolveRunForTurn(runIndex: RunIndex, input: ResolveRunIdInput): RunId | null {
  const text = input.text.trim();
  let best: { runId: RunId; distance: number } | null = null;
  for (const run of runIndex.read().runs) {
    if (input.assigned.has(run.runId)) {
      continue;
    }
    const prompt = run.prompt.trim();
    const matches =
      prompt === text || (input.command !== null && prompt.startsWith(input.command));
    if (!matches) {
      continue;
    }
    const startedMs = Date.parse(run.startedAt);
    if (Number.isNaN(startedMs) || Number.isNaN(input.tsMs)) {
      continue;
    }
    const distance = Math.abs(startedMs - input.tsMs);
    if (distance > 15 * 60_000) {
      continue;
    }
    if (!best || distance < best.distance) {
      best = { runId: run.runId, distance };
    }
  }
  return best?.runId ?? null;
}

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
  };
}

function hasUsageData(snapshot: UsageSnapshot): boolean {
  return Boolean(snapshot.context || snapshot.limits.length > 0);
}

function pathsEqual(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function hasContentBesidesDuet(folder: string): boolean {
  try {
    return fs
      .readdirSync(folder)
      .some((entry) => entry !== ".duet" && entry !== ".DS_Store");
  } catch {
    return false;
  }
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

function normalizeControlChange(
  provider: RuntimeProvider,
  change: DeliveryControlChange,
): DeliveryControlChange {
  if (change.kind === "model") {
    const launchSettings = normalizeLaunchSettings(provider, {
      model: change.model,
      reasoningEffort: change.reasoningEffort,
      speedMode: null,
    });
    if (!launchSettings.model && !launchSettings.reasoningEffort) {
      throw new Error("Choose a model or reasoning value before applying a model control.");
    }
    return {
      kind: "model",
      label: change.label.trim() || "Model",
      model: launchSettings.model,
      reasoningEffort: launchSettings.reasoningEffort,
    };
  }

  if (provider === "claude") {
    const permissionMode = change.claude?.permissionMode;
    if (permissionMode === "bypassPermissions" || permissionMode === "dontAsk") {
      throw new Error(`Claude permission mode ${permissionMode} is not available mid-session.`);
    }
    if (!permissionMode || !CLAUDE_PERMISSION_MODES.has(permissionMode)) {
      throw new Error("Choose a supported Claude permission mode.");
    }
    return {
      kind: "permission",
      label: change.label.trim() || claudePermissionLabel(permissionMode),
      codex: null,
      claude: { permissionMode },
    };
  }

  const codex = change.codex;
  if (!codex || !CODEX_SANDBOX_MODES.has(codex.sandbox) || !CODEX_APPROVAL_MODES.has(codex.approval)) {
    throw new Error("Choose a supported Codex permission preset.");
  }
  return {
    kind: "permission",
    label: change.label.trim() || codexPermissionLabel(codex.preset),
    codex,
    claude: null,
  };
}

function applyVerifiedControlToTask(task: Task, change: DeliveryControlChange): Task {
  const now = new Date().toISOString();
  if (change.kind === "model") {
    return {
      ...task,
      model: change.model,
      reasoningEffort: change.reasoningEffort,
      updatedAt: now,
    };
  }

  if (task.provider === "claude" && change.claude) {
    return {
      ...task,
      permissionMode: change.claude.permissionMode,
      updatedAt: now,
    };
  }

  if (task.provider === "codex" && change.codex) {
    return {
      ...task,
      sandbox: change.codex.sandbox,
      approval: change.codex.approval,
      updatedAt: now,
    };
  }

  return task;
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

function codexPermissionLabel(preset: CodexPermissionPreset): string {
  if (preset === "approveForMe") {
    return "Approve for me";
  }
  if (preset === "fullAccess") {
    return "Full Access";
  }
  return "Ask for approval";
}

function claudePermissionLabel(mode: ClaudePermissionMode): string {
  if (mode === "acceptEdits") {
    return "acceptEdits";
  }
  return mode;
}
