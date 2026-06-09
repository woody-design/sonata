import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import type {
  ArtifactCandidate,
  ApprovalDecision,
  ClaudePermissionMode,
  CodexApprovalMode,
  CodexSandboxMode,
  CreateTaskRequest,
  CreateTaskResponse,
  LaunchSpeedMode,
  OpenTaskRequest,
  ReadTranscriptResponse,
  ReasoningEffort,
  RunId,
  RuntimeEvent,
  RuntimeProvider,
  RuntimeReportUpdatedEvent,
  Task,
  TaskId,
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
  type ResolveRunIdInput,
} from "../runtime";

const DEFAULT_TASK_TITLE = "New Task";
const AUTO_TITLE_PLACEHOLDERS = new Set(["New Task", "Walking Skeleton Task"]);
const SUPPORTED_PROVIDERS = new Set<RuntimeProvider>(["codex", "claude"]);
const REASONING_EFFORTS = new Set<ReasoningEffort>(["low", "medium", "high", "xhigh", "max"]);
const CODEX_SANDBOX_MODES = new Set<CodexSandboxMode>(["read-only", "workspace-write"]);
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
}

export class RuntimeController {
  private readonly sendEvent: (event: RuntimeEvent) => void;
  private readonly taskRuntimes = new Map<TaskId, ActiveTaskRuntime>();
  private taskSeq = 0;

  constructor(options: RuntimeControllerOptions) {
    this.sendEvent = options.sendEvent;
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
    };
    this.taskRuntimes.set(activeTask.task.id, activeTask);
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
    };
    this.taskRuntimes.set(runningTask.id, activeTask);
    this.persistTaskManifest(runningTask, storageRoot);

    for (const source of this.readTranscriptSources(storageRoot)) {
      providerTranscript.attachExistingSource(source);
    }
    providerTranscript.startDiscovery(ptyStartedAt);

    this.emitReportUpdated(runIndex);

    return {
      task: runningTask,
      runtime,
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

  submitPrompt(taskId: TaskId, text: string): void {
    const active = this.requireTaskRuntime(taskId);
    active.deliveryController.enqueue(text);
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
  }

  private handleRuntimeEvent(event: RuntimeEvent, runIndex: RunIndex): void {
    this.taskRuntimes.get(event.payload.taskId)?.deliveryController.handleRuntimeEvent(event);

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
      event.type === "delivery:receipt"
    ) {
      return;
    }

    const summary = runIndex.consume(event as RunIndexEvent);
    if (!summary) {
      return;
    }

    this.emitReportUpdated(runIndex);
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
    this.persistTaskManifest(active.task, active.storageRoot);
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
    active.terminalHost.dispose();
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
