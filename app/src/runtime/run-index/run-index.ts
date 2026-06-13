import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TaskId } from "../../shared/types/domain";
import type { RunIndexEvent } from "../../shared/types/events";
import {
  freshRuntimeReportV1,
  RUNTIME_REPORT_SCHEMA_ID,
  RUNTIME_REPORT_SCHEMA_VERSION,
  type RuntimeApprovalReport,
  type RuntimeArtifactCandidateReport,
  type RuntimeFileChangeReport,
  type RuntimeReportSummaryV1,
  type RuntimeReportV1,
  type RuntimeRunReport,
} from "../../shared/schemas/runtime-report";

const ARTIFACT_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".md",
  ".markdown",
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".csv",
  ".tsv",
  ".xlsx",
  ".docx",
  ".pptx",
]);

export interface RunIndexOptions {
  taskId: TaskId;
  reportPath: string;
  loadExisting?: boolean;
}

export class RunIndex {
  private readonly taskId: TaskId;
  private readonly reportPath: string;
  private report: RuntimeReportV1;

  constructor(options: RunIndexOptions) {
    this.taskId = options.taskId;
    this.reportPath = options.reportPath;
    this.report = options.loadExisting
      ? readExistingReport(options.reportPath, options.taskId)
      : freshRuntimeReportV1(options.taskId);
    this.persist();
  }

  consume(event: RunIndexEvent): RuntimeReportSummaryV1 | null {
    switch (event.type) {
      case "task:started":
        this.report.runtime = {
          provider: event.payload.provider,
          model: event.payload.model,
          reasoningEffort: event.payload.reasoningEffort,
          speedMode: event.payload.speedMode,
          command: event.payload.command,
          args: event.payload.args,
          cwd: event.payload.cwd,
          rows: event.payload.rows,
          cols: event.payload.cols,
          startedAt: event.ts,
        };
        break;
      case "run:started":
        this.upsertRun(event.payload.id, {
          runId: event.payload.id,
          taskId: event.payload.taskId,
          kind: event.payload.kind,
          prompt: event.payload.prompt,
          title: event.payload.title,
          status: event.payload.status,
          lifecyclePhase: event.payload.lifecyclePhase,
          startedAt: event.payload.startedAt,
          endedAt: event.payload.endedAt,
          elapsedMs: event.payload.elapsedMs,
          completionSource: event.payload.completionSource,
          completionConfidence: event.payload.completionConfidence,
          approvalEvents: [],
          stopEvents: [],
          changedFiles: [],
          artifactCandidates: [],
          rawTerminalPointer: null,
        });
        break;
      case "run:updated":
        {
          const patch: Partial<RuntimeRunReport> = {
            taskId: event.payload.taskId,
            kind: event.payload.kind,
            prompt: event.payload.prompt,
            title: event.payload.title,
            status: event.payload.status,
            lifecyclePhase: event.payload.lifecyclePhase,
            startedAt: event.payload.startedAt,
            endedAt: event.payload.endedAt,
            elapsedMs: event.payload.elapsedMs,
            completionSource: event.payload.completionSource,
            completionConfidence: event.payload.completionConfidence,
            rawTerminalPointer: null,
          };
          if (event.payload.statusReason !== undefined) {
            patch.statusReason = event.payload.statusReason;
          }
          if (event.payload.completionHint !== undefined) {
            patch.completionHint = event.payload.completionHint;
          }
          if (event.payload.lastLifecycleHint !== undefined) {
            patch.lastLifecycleHint = event.payload.lastLifecycleHint;
          }
          if (event.payload.approvalKind !== undefined) {
            patch.approvalKind = event.payload.approvalKind;
          }
          if (event.payload.approvalDecision !== undefined) {
            patch.approvalDecision = event.payload.approvalDecision;
          }
          this.upsertRun(event.payload.id, patch);
        }
        break;
      case "approval:detected":
        {
          const approvalEvent: RuntimeApprovalReport = {
            ts: event.ts,
            action: "detected",
            kind: event.payload.kind,
            source: event.payload.source,
          };
          if (event.payload.resurfacedAfterDecision !== undefined) {
            approvalEvent.resurfacedAfterDecision = event.payload.resurfacedAfterDecision;
          }
          if (event.payload.previousDecision !== undefined) {
            approvalEvent.previousDecision = event.payload.previousDecision;
          }
          if (event.payload.decisionAgeMs !== undefined) {
            approvalEvent.decisionAgeMs = event.payload.decisionAgeMs;
          }
          if (event.payload.fingerprintHash !== undefined) {
            approvalEvent.fingerprintHash = event.payload.fingerprintHash;
          }
          if (event.payload.choices !== undefined) {
            approvalEvent.choices = event.payload.choices;
          }
          this.appendRunEvent(event.payload.runId, "approvalEvents", approvalEvent);
        }
        break;
      case "approval:decision":
        this.appendRunEvent(event.payload.runId, "approvalEvents", {
          ts: event.ts,
          action: "decision",
          decision: event.payload.decision,
          encodedAs: event.payload.encodedAs,
          previousKind: event.payload.previousKind,
        });
        break;
      case "approval:persisted":
        this.appendRunEvent(event.payload.runId, "approvalEvents", {
          ts: event.ts,
          action: "persisted",
          file: event.payload.file,
          rulesAdded: event.payload.rulesAdded,
        });
        break;
      case "run:stop-requested":
        this.appendRunEvent(event.payload.runId, "stopEvents", {
          ts: event.ts,
          action: "interrupt",
          phase: event.payload.phase,
          encodedAs: event.payload.encodedAs,
        });
        break;
      case "run:stopped":
        this.appendRunEvent(event.payload.runId, "stopEvents", {
          ts: event.ts,
          action: "stopped",
          interruptSent: event.payload.interruptSent,
          slashStopSent: event.payload.slashStopSent,
          slashStopReason: event.payload.slashStopReason,
        });
        break;
      case "file:changed":
        this.appendChangedFile(event);
        break;
      case "pty:exit":
      case "task:ready":
      case "task:accepts-input":
      case "working-status:updated":
      case "prompt:submitted":
      case "file:watching":
      case "file:watch-error":
        break;
      default:
        assertNever(event);
    }

    this.report.generatedAt = new Date().toISOString();
    this.persist();
    return this.summary();
  }

  read(): RuntimeReportV1 {
    return this.report;
  }

  summary(): RuntimeReportSummaryV1 {
    return {
      taskId: this.taskId,
      reportPath: this.reportPath,
      runCount: this.report.runs.length,
      latestRun: this.report.runs[this.report.runs.length - 1] ?? null,
      rawTerminalPersisted: false,
      rawTerminalPointer: null,
    };
  }

  private upsertRun(runId: string | null, patch: Partial<RuntimeRunReport>): RuntimeRunReport | null {
    if (!runId) {
      return null;
    }

    let run = this.report.runs.find((item) => item.runId === runId);
    if (!run) {
      run = {
        runId,
        taskId: this.taskId,
        kind: "prompt",
        prompt: "",
        title: "",
        status: "active",
        lifecyclePhase: "active",
        startedAt: new Date().toISOString(),
        endedAt: null,
        elapsedMs: null,
        completionSource: null,
        completionConfidence: null,
        approvalEvents: [],
        stopEvents: [],
        changedFiles: [],
        artifactCandidates: [],
        rawTerminalPointer: null,
      };
      this.report.runs.push(run);
    }

    Object.assign(run, removeUndefined(patch), { rawTerminalPointer: null });
    return run;
  }

  private appendRunEvent<K extends "approvalEvents" | "stopEvents">(
    runId: string | null,
    key: K,
    value: RuntimeRunReport[K][number],
  ): void {
    const run = this.upsertRun(runId, {});
    if (!run) {
      return;
    }

    run[key] = [...run[key], value] as RuntimeRunReport[K];
  }

  private appendChangedFile(event: Extract<RunIndexEvent, { type: "file:changed" }>): void {
    const run = this.upsertRun(event.payload.runId, {});
    const change = fileChangeFromEvent(event);
    if (!run) {
      this.report.unassignedChanges = dedupeByPath([...this.report.unassignedChanges, change]);
      return;
    }

    run.changedFiles = dedupeByPath([...run.changedFiles, change]);

    if (isArtifactCandidate(change.path)) {
      run.artifactCandidates = dedupeByPath([
        ...run.artifactCandidates,
        {
          path: change.path,
          changeKind: change.changeKind,
          type: artifactType(change.path),
        },
      ]);
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.reportPath), { recursive: true });
    const tmpPath = `${this.reportPath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(this.report, null, 2)}\n`);
    fs.renameSync(tmpPath, this.reportPath);
  }
}

function fileChangeFromEvent(
  event: Extract<RunIndexEvent, { type: "file:changed" }>,
): RuntimeFileChangeReport {
  return {
    ts: event.ts,
    path: event.payload.path,
    absolutePath: redactHome(event.payload.absolutePath),
    changeKind: event.payload.changeKind,
    eventType: event.payload.eventType,
    type: event.payload.type,
    size: event.payload.size,
    sha256: event.payload.sha256,
  };
}

function isArtifactCandidate(filePath: string): boolean {
  return ARTIFACT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function artifactType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase().replace(".", "");
  return ext || "unknown";
}

function dedupeByPath<T extends { path: string }>(items: T[]): T[] {
  const byPath = new Map<string, T>();
  for (const item of items) {
    byPath.set(item.path, item);
  }
  return [...byPath.values()];
}

function removeUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function redactHome(value: string): string {
  return value.replace(os.homedir(), "~");
}

function assertNever(value: never): never {
  throw new Error(`Unhandled RunIndex event: ${JSON.stringify(value)}`);
}

function readExistingReport(reportPath: string, taskId: TaskId): RuntimeReportV1 {
  if (!fs.existsSync(reportPath)) {
    return freshRuntimeReportV1(taskId);
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(reportPath, "utf8")) as RuntimeReportV1;
    if (
      parsed.schemaId !== RUNTIME_REPORT_SCHEMA_ID ||
      parsed.version !== RUNTIME_REPORT_SCHEMA_VERSION
    ) {
      return freshRuntimeReportV1(taskId);
    }
    return {
      ...parsed,
      taskId,
      rawTerminalPointer: null,
      runs: parsed.runs.map((run) => ({ ...run, taskId, rawTerminalPointer: null })),
    };
  } catch {
    return freshRuntimeReportV1(taskId);
  }
}

export type { RuntimeArtifactCandidateReport, RuntimeReportV1 };
