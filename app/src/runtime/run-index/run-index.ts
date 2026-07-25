import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunId, TaskId } from "../../shared/types/domain";
import type { ResolveRunIdInput } from "../provider-transcript";
import type { RunIndexEvent, RuntimeEvent } from "../../shared/types/events";
import { normalizePromptForMatch } from "../../shared/prompt-markers";
import {
  freshRuntimeReportV1,
  RUNTIME_REPORT_SCHEMA_ID,
  RUNTIME_REPORT_SCHEMA_VERSION,
  type RuntimeApprovalReport,
  type RuntimeArtifactCandidateReport,
  type RuntimeFileChangeReport,
  type RuntimeReportDroppedCounts,
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

/** Per-bucket caps for the bounded runtime-report lists (OBS S0). */
export interface ReportListCaps {
  changedFiles: number;
  unassignedChanges: number;
  artifactCandidates: number;
}

/**
 * The build-noise lists grow one entry per changed path and dominated the 26 MB
 * field reports (54k entries). Keep the most-recent tail per bucket — 500 file
 * changes / 200 artifact candidates is generous forensic context without the
 * unbounded storm cost (incident F3).
 */
export const DEFAULT_REPORT_LIST_CAPS: ReportListCaps = {
  changedFiles: 500,
  unassignedChanges: 500,
  artifactCandidates: 200,
};

/**
 * Cap the append-ordered noise lists to their most-recent entries, accumulating
 * a per-bucket dropped count into `report.droppedCounts` so truncation is
 * visible, never silent (incident F3). Pure and side-effect-free: returns a new
 * report and mutates neither the input nor its lists. S0 applies it at load time
 * (`readExistingReport`) to compact the existing bloated reports; S2 reuses it at
 * flush time to bound growth at the source.
 *
 * Idempotent by construction: a list already within its cap drops nothing, so
 * `capReportLists(capReportLists(r))` equals `capReportLists(r)` — the counts do
 * not double, which also makes repeated flush-time caps of a growing report sum
 * correctly (each call adds only the entries it actually removes).
 */
export function capReportLists(
  report: RuntimeReportV1,
  caps: ReportListCaps = DEFAULT_REPORT_LIST_CAPS,
): RuntimeReportV1 {
  const dropped: RuntimeReportDroppedCounts = {
    changedFiles: report.droppedCounts?.changedFiles ?? 0,
    unassignedChanges: report.droppedCounts?.unassignedChanges ?? 0,
    artifactCandidates: report.droppedCounts?.artifactCandidates ?? 0,
  };

  const tail = <T>(list: T[], cap: number): T[] =>
    list.length > cap ? list.slice(list.length - cap) : list;

  const runs = report.runs.map((run) => {
    const changedOverflow = Math.max(0, run.changedFiles.length - caps.changedFiles);
    const artifactOverflow = Math.max(0, run.artifactCandidates.length - caps.artifactCandidates);
    if (changedOverflow === 0 && artifactOverflow === 0) {
      return run;
    }
    dropped.changedFiles += changedOverflow;
    dropped.artifactCandidates += artifactOverflow;
    return {
      ...run,
      changedFiles: tail(run.changedFiles, caps.changedFiles),
      artifactCandidates: tail(run.artifactCandidates, caps.artifactCandidates),
    };
  });

  dropped.unassignedChanges += Math.max(0, report.unassignedChanges.length - caps.unassignedChanges);

  return {
    ...report,
    runs,
    unassignedChanges: tail(report.unassignedChanges, caps.unassignedChanges),
    droppedCounts: dropped,
  };
}

export interface RunIndexOptions {
  taskId: TaskId;
  reportPath: string;
  loadExisting?: boolean;
}

/**
 * The event types `RunIndex.consume` handles — the ALLOWLIST that guards the
 * consume boundary in `RuntimeController.handleRuntimeEvent`. Only events whose
 * type is in this set may cross into `consume`; everything else (renderer-facing
 * UI/state events like `remote-control:state`, plus events delivered on other
 * paths) is skipped before it can reach `consume`'s `default: assertNever` and
 * crash the main process.
 *
 * `satisfies Record<RunIndexEvent["type"], true>` makes the list provably exact
 * at compile time — adding a type to `RunIndexEvent` (or un-excluding one) forces
 * a matching entry here, and removing one is rejected as an excess key. Paired
 * with `consume`'s `assertNever` default, the two checks keep the boundary sound
 * with no unsafe cast: `consume` only ever sees real `RunIndexEvent`s.
 */
const RUN_INDEX_EVENT_TYPES = {
  "pty:exit": true,
  "task:started": true,
  "task:ready": true,
  "working-status:updated": true,
  "prompt:submitted": true,
  "run:started": true,
  "run:updated": true,
  "run:stop-requested": true,
  "run:stopped": true,
  "approval:detected": true,
  "approval:decision": true,
  "approval:expired": true,
  "approval:persisted": true,
  "file:watching": true,
  "file:watch-error": true,
  "file:changed": true,
} satisfies Record<RunIndexEvent["type"], true>;

/**
 * Runtime type-guard for the allowlist above. Replaces the unsafe
 * `event as RunIndexEvent` cast at the consume boundary so a forgotten or
 * newly-added renderer-facing event can no longer slip through to `assertNever`.
 */
export function isRunIndexEvent(event: RuntimeEvent): event is RunIndexEvent {
  return Object.prototype.hasOwnProperty.call(RUN_INDEX_EVENT_TYPES, event.type);
}

export class RunIndex {
  private readonly taskId: TaskId;
  private readonly reportPath: string;
  private report: RuntimeReportV1;
  private disposed = false;

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
          promptId: event.payload.promptId ?? null,
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
            ...(event.payload.promptId != null ? { promptId: event.payload.promptId } : {}),
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
          this.recordApprovalEvent(event.payload.runId, approvalEvent);
        }
        break;
      case "approval:decision":
        this.recordApprovalEvent(event.payload.runId, {
          ts: event.ts,
          action: "decision",
          decision: event.payload.decision,
          encodedAs: event.payload.encodedAs,
          previousKind: event.payload.previousKind,
        });
        break;
      case "approval:persisted":
        this.recordApprovalEvent(event.payload.runId, {
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
      case "working-status:updated":
      case "prompt:submitted":
      case "file:watching":
      case "file:watch-error":
      // A broker approval timed out to the native panel — the request is still
      // pending (the native decision updates run state later), so the index
      // records nothing here.
      case "approval:expired":
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

  /**
   * Approvals can fire with no owning run — the workspace-trust screen
   * appears during session setup, before the first run begins. Routing
   * them to a run via upsertRun(null) silently dropped them (the empty
   * approvalEvents in the 148-approval incident report). Mirror the
   * unassignedChanges bucket so every approval leaves a trail.
   */
  private recordApprovalEvent(runId: string | null, value: RuntimeApprovalReport): void {
    const run = this.upsertRun(runId, {});
    if (!run) {
      this.report.unassignedApprovals = [...this.report.unassignedApprovals, value];
      return;
    }
    run.approvalEvents = [...run.approvalEvents, value];
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

  /**
   * Stop persisting. A disposed run must never write again — otherwise a late
   * straggler event (e.g. the killed PTY's async `pty:exit`) would re-create the
   * report file, and with it the task's record dir, AFTER the session was deleted.
   * The on-event report is already up to date at dispose time; nothing after it
   * matters.
   */
  dispose(): void {
    this.disposed = true;
  }

  private persist(): void {
    if (this.disposed) {
      return;
    }
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
    // Compact on load: the existing 26 MB / 11 MB field reports carry tens of
    // thousands of build-noise entries. Capping here means the next persist
    // rewrites them bounded, so a resume no longer parses (or re-writes) a
    // multi-MB file (OBS S0 / incident §7 last bullet).
    return capReportLists({
      ...parsed,
      taskId,
      rawTerminalPointer: null,
      // Field added in 2c; reports written before it lack the key.
      unassignedApprovals: parsed.unassignedApprovals ?? [],
      runs: parsed.runs.map((run) => ({ ...run, taskId, rawTerminalPointer: null })),
    });
  } catch {
    return freshRuntimeReportV1(taskId);
  }
}

export type { RuntimeArtifactCandidateReport, RuntimeReportV1 };

/**
 * Match a transcript turn to the Run that caused it. Exact first: the CLI's
 * prompt_id (stamped onto hook-begun runs, S6+) equals the turn's promptId —
 * identity beats every heuristic, and an identity verdict is FINAL: when the
 * matched run is already assigned this is the same turn re-anchoring
 * (promptIds are unique per turn), so we return it rather than falling
 * through to the text pass, which could steal a different same-text run
 * (review 2026-07-03). Fallback: prompt-text equality inside a time window
 * (pre-bridge records, idle-path runs whose hook echo was swallowed) —
 * window per anchor kind, see ResolveRunIdInput.textWindowMs.
 */
export function resolveRunForTurn(runIndex: RunIndex, input: ResolveRunIdInput): RunId | null {
  if (input.promptId) {
    for (const run of runIndex.read().runs) {
      if (run.promptId && run.promptId === input.promptId) {
        return run.runId;
      }
    }
  }
  // Read through the CLI's `[Image #N]` decoration on BOTH sides: the turn text
  // (transcript `user-message`) carries the markers, the run prompt (raw typed
  // text Sonata stored) does not. Without this, an image prompt whose promptId
  // never bridged (the stage-1 miss above) fell through to an un-attributed run
  // and a second husk card (2026-07-05). Same canonical rule as the delivery
  // matcher and the hook back-stamp guards.
  const text = normalizePromptForMatch(input.text);
  const windowMs = input.textWindowMs ?? 15 * 60_000;
  let best: { runId: RunId; distance: number } | null = null;
  for (const run of runIndex.read().runs) {
    if (input.assigned.has(run.runId)) {
      continue;
    }
    // Identity outranks text even in the fallback: when the anchor carries a
    // promptId and the candidate run carries a DIFFERENT one, they are two
    // different turns by definition — text similarity must not pair them.
    // Prevents an early text match (record won the hook race) from latching
    // a wrong id-bearing sibling before the true run arrives (review
    // 2026-07-03). Runs without a promptId (pre-bridge, swallowed echoes)
    // stay text-matchable.
    if (input.promptId && run.promptId && run.promptId !== input.promptId) {
      continue;
    }
    const prompt = normalizePromptForMatch(run.prompt);
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
    if (distance > windowMs) {
      continue;
    }
    if (!best || distance < best.distance) {
      best = { runId: run.runId, distance };
    }
  }
  return best?.runId ?? null;
}
