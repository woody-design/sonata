import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import type {
  ArtifactCandidate,
  CreateTaskRequest,
  CreateTaskResponse,
  RuntimeEvent,
  RuntimeReportUpdatedEvent,
  Task,
  TaskId,
} from "../shared/types";
import type { RunIndexEvent } from "../shared/types/events";
import type { RuntimeReportV1 } from "../shared/schemas";
import { ArtifactPreview, RunIndex, TerminalHost } from "../runtime";

interface RuntimeControllerOptions {
  sendEvent: (event: RuntimeEvent) => void;
}

interface ActiveTaskRuntime {
  task: Task;
  terminalHost: TerminalHost;
  runIndex: RunIndex;
  reportPath: string;
}

export class RuntimeController {
  private readonly sendEvent: (event: RuntimeEvent) => void;
  private activeTask: ActiveTaskRuntime | null = null;
  private taskSeq = 0;

  constructor(options: RuntimeControllerOptions) {
    this.sendEvent = options.sendEvent;
  }

  createTask(request: CreateTaskRequest): CreateTaskResponse {
    if (request.provider !== "codex") {
      throw new Error("Only Codex is supported in the walking skeleton.");
    }

    this.disposeActiveTask();

    const now = new Date().toISOString();
    const taskId = this.nextTaskId();
    const cwd = path.resolve(request.cwd ?? this.defaultWorkspacePath(taskId));
    const reportPath = path.join(cwd, ".duet", "runtime-report.json");
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });

    const task: Task = {
      id: taskId,
      title: request.title?.trim() || "Walking Skeleton Task",
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

    this.activeTask = {
      task: { ...task, status: "running", updatedAt: new Date().toISOString() },
      terminalHost,
      runIndex,
      reportPath,
    };

    return {
      task: this.activeTask.task,
      runtime,
    };
  }

  openTask(taskId: TaskId): Task {
    if (!this.activeTask || this.activeTask.task.id !== taskId) {
      throw new Error("Only the active in-memory task can be opened in the walking skeleton.");
    }
    return this.activeTask.task;
  }

  submitPrompt(taskId: TaskId, text: string): void {
    const active = this.requireActiveTask(taskId);
    active.terminalHost.submitPrompt(text);
  }

  decideApproval(taskId: TaskId, decision: "approve" | "deny"): void {
    const active = this.requireActiveTask(taskId);
    if (decision === "approve") {
      active.terminalHost.sendApprove();
      return;
    }
    active.terminalHost.sendDeny();
  }

  async stopRun(taskId: TaskId, options: { inspectDelayMs?: number; forceSlashStop?: boolean }): Promise<void> {
    const active = this.requireActiveTask(taskId);
    await active.terminalHost.stopRun(options);
  }

  resizeTerminal(taskId: TaskId, cols: number, rows: number): void {
    const active = this.requireActiveTask(taskId);
    active.terminalHost.resize(cols, rows);
  }

  readReport(taskId: TaskId): RuntimeReportV1 {
    const active = this.requireActiveTask(taskId);
    return active.runIndex.read();
  }

  listArtifacts(taskId: TaskId): ArtifactCandidate[] {
    const active = this.requireActiveTask(taskId);
    return this.currentArtifactPreview(active).listArtifacts();
  }

  readArtifact(taskId: TaskId, relativePath: string): ReturnType<ArtifactPreview["readArtifact"]> {
    const active = this.requireActiveTask(taskId);
    return this.currentArtifactPreview(active).readArtifact(relativePath);
  }

  dispose(): void {
    this.disposeActiveTask();
  }

  private handleRuntimeEvent(event: RuntimeEvent, runIndex: RunIndex): void {
    this.sendEvent(event);

    if (event.type === "pty:data" || event.type === "report:updated") {
      return;
    }

    const summary = runIndex.consume(event as RunIndexEvent);
    if (!summary) {
      return;
    }

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
    const workspaceRoot = active.terminalHost.workspace ?? active.task.workingDirectory;
    return new ArtifactPreview({
      taskId: active.task.id,
      workspaceRoot,
      report: active.runIndex.read(),
    });
  }

  private requireActiveTask(taskId: TaskId): ActiveTaskRuntime {
    if (!this.activeTask || this.activeTask.task.id !== taskId) {
      throw new Error("No active runtime task matches the requested taskId.");
    }
    return this.activeTask;
  }

  private disposeActiveTask(): void {
    if (!this.activeTask) {
      return;
    }
    this.activeTask.terminalHost.dispose();
    this.activeTask = null;
  }

  private nextTaskId(): TaskId {
    return `task-${Date.now()}-${++this.taskSeq}`;
  }

  private defaultWorkspacePath(taskId: TaskId): string {
    const projectRoot = process.env.DUET_PROJECTS_DIR || path.join(app.getPath("documents"), "Duet Projects");
    return path.join(projectRoot, taskId);
  }
}
