import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import type {
  ArtifactCandidate,
  CreateTaskRequest,
  CreateTaskResponse,
  OpenTaskRequest,
  RuntimeEvent,
  RuntimeReportUpdatedEvent,
  Task,
  TaskId,
  WorkspaceFilePreviewResponse,
  WorkspaceTreeEntry,
} from "../shared/types";
import type { RunIndexEvent } from "../shared/types/events";
import {
  freshTaskManifestV1,
  TASK_MANIFEST_SCHEMA_ID,
  TASK_MANIFEST_SCHEMA_VERSION,
  type RuntimeReportV1,
  type TaskManifestV1,
} from "../shared/schemas";
import { ArtifactPreview, RunIndex, TerminalHost, WorkspacePreview } from "../runtime";

const DEFAULT_TASK_TITLE = "New Task";
const AUTO_TITLE_PLACEHOLDERS = new Set(["New Task", "Walking Skeleton Task"]);

interface RuntimeControllerOptions {
  sendEvent: (event: RuntimeEvent) => void;
}

interface ActiveTaskRuntime {
  task: Task;
  terminalHost: TerminalHost;
  runIndex: RunIndex;
  reportPath: string;
  runtime: ReturnType<TerminalHost["startTask"]>;
}

export class RuntimeController {
  private readonly sendEvent: (event: RuntimeEvent) => void;
  private readonly taskRuntimes = new Map<TaskId, ActiveTaskRuntime>();
  private taskSeq = 0;

  constructor(options: RuntimeControllerOptions) {
    this.sendEvent = options.sendEvent;
  }

  createTask(request: CreateTaskRequest): CreateTaskResponse {
    if (request.provider !== "codex") {
      throw new Error("Only Codex is supported in the walking skeleton.");
    }

    const now = new Date().toISOString();
    const taskId = this.nextTaskId();
    const cwd = path.resolve(request.cwd ?? this.defaultWorkspacePath(taskId));
    const reportPath = path.join(cwd, ".duet", "runtime-report.json");
    fs.mkdirSync(duetDirectory(cwd), { recursive: true });

    const task: Task = {
      id: taskId,
      title: request.title?.trim() || DEFAULT_TASK_TITLE,
      provider: "codex",
      runtimeSessionId: `runtime-${taskId}`,
      providerSessionRef: null,
      providerCwd: cwd,
      workingDirectory: cwd,
      status: "starting",
      createdAt: now,
      updatedAt: now,
    };

    const runIndex = new RunIndex({ taskId, reportPath });
    const terminalHost = new TerminalHost({
      taskId,
      defaultWorkspace: cwd,
      eventSink: (event) => this.handleRuntimeEvent(event, runIndex),
    });

    const startOptions = {
      cwd,
      sandbox: request.sandbox ?? "read-only",
      approval: request.approval ?? "on-request",
    };
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
      terminalHost,
      runIndex,
      reportPath,
      runtime,
    };
    this.taskRuntimes.set(activeTask.task.id, activeTask);
    this.persistTaskManifest(activeTask.task);

    return {
      task: activeTask.task,
      runtime,
    };
  }

  openTask(request: OpenTaskRequest): CreateTaskResponse {
    const cwd = this.resolveOpenTaskWorkspace(request);
    const manifest = this.readTaskManifest(cwd);
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

    const task = {
      ...manifest.task,
      workingDirectory: cwd,
      providerCwd: cwd,
      status: "running" as const,
      updatedAt: new Date().toISOString(),
    };
    const reportPath = path.join(cwd, ".duet", "runtime-report.json");
    const runIndex = new RunIndex({ taskId: task.id, reportPath, loadExisting: true });
    const terminalHost = new TerminalHost({
      taskId: task.id,
      defaultWorkspace: cwd,
      eventSink: (event) => this.handleRuntimeEvent(event, runIndex),
    });

    const runtime = terminalHost.startTask({
      cwd,
      sandbox: request.sandbox ?? "read-only",
      approval: request.approval ?? "on-request",
      ...(request.rows !== undefined ? { rows: request.rows } : {}),
      ...(request.cols !== undefined ? { cols: request.cols } : {}),
    });

    const activeTask = {
      task,
      terminalHost,
      runIndex,
      reportPath,
      runtime,
    };
    this.taskRuntimes.set(task.id, activeTask);
    this.persistTaskManifest(task);

    this.emitReportUpdated(runIndex);

    return {
      task,
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
    active.terminalHost.submitPrompt(text);
  }

  decideApproval(taskId: TaskId, decision: "approve" | "deny"): void {
    const active = this.requireTaskRuntime(taskId);
    if (decision === "approve") {
      active.terminalHost.sendApprove();
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
    if (event.type === "run:started") {
      this.updateTaskTitleFromRun(event.payload.taskId, event.payload.title);
    }

    this.sendEvent(event);

    if (event.type === "pty:data" || event.type === "report:updated") {
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
    this.persistTaskManifest(active.task);
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
    });
    active.terminalHost.dispose();
  }

  private nextTaskId(): TaskId {
    return `task-${Date.now()}-${++this.taskSeq}`;
  }

  private defaultWorkspacePath(taskId: TaskId): string {
    const projectRoot = process.env.DUET_PROJECTS_DIR || path.join(app.getPath("documents"), "Duet Projects");
    return path.join(projectRoot, taskId);
  }

  private resolveOpenTaskWorkspace(request: OpenTaskRequest): string {
    if (request.cwd) {
      return path.resolve(request.cwd);
    }
    if (request.taskId) {
      const candidate = this.defaultWorkspacePath(request.taskId);
      if (fs.existsSync(taskManifestPath(candidate))) {
        return candidate;
      }
    }
    return this.latestTaskWorkspace();
  }

  private latestTaskWorkspace(): string {
    const projectRoot = process.env.DUET_PROJECTS_DIR || path.join(app.getPath("documents"), "Duet Projects");
    const entries = fs.existsSync(projectRoot)
      ? fs.readdirSync(projectRoot, { withFileTypes: true })
      : [];
    const candidates = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(projectRoot, entry.name))
      .filter((workspace) => fs.existsSync(taskManifestPath(workspace)))
      .map((workspace) => ({
        workspace,
        mtimeMs: fs.statSync(taskManifestPath(workspace)).mtimeMs,
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const latest = candidates[0]?.workspace;
    if (!latest) {
      throw new Error("No persisted Duet Task was found.");
    }
    return latest;
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
      manifest.task.provider !== "codex"
    ) {
      throw new Error("Task manifest is not supported by this walking skeleton.");
    }
    return manifest;
  }

  private persistTaskManifest(task: Task): void {
    const manifest = freshTaskManifestV1(task);
    const manifestPath = taskManifestPath(task.workingDirectory);
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
