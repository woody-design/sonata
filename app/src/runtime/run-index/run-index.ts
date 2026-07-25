import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunId, TaskId } from "../../shared/types/domain";
import type { ResolveRunIdInput } from "../provider-transcript";
import type { RunIndexEvent, RuntimeEvent } from "../../shared/types/events";
import { normalizePromptForMatch } from "../../shared/prompt-markers";
import { Projection, type ProjectionTimers } from "../projection";
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

/**
 * Trailing-debounce window for routine (non-critical) report mutations (OBS S2 /
 * incident F1). A build-output storm marks the report dirty at its own rate; the
 * actual write + broadcast fire at most once per this window. Critical lifecycle
 * events (run/approval/task boundaries) bypass it and flush immediately.
 */
export const DEFAULT_REPORT_TRAILING_MS = 1000;

export interface RunIndexOptions {
  taskId: TaskId;
  reportPath: string;
  loadExisting?: boolean;
  /**
   * Broadcast sink for the report:updated notification (OBS S2, D6 main half).
   * Fires ONLY from the flush closure, so write and broadcast share one
   * dirty-gated, time-bounded cadence — never per consumed event. Defaults to a
   * no-op (dormant/read-only RunIndexes that never notify anyone).
   */
  notify?: (summary: RuntimeReportSummaryV1) => void;
  /** Trailing-debounce window for routine mutations; defaults to {@link DEFAULT_REPORT_TRAILING_MS}. */
  trailingMs?: number;
  /** Projection timer seam — injected by the storm smoke to drive the clock by hand. */
  timers?: ProjectionTimers;
  /** Per-bucket caps for the bounded lists; defaults to {@link DEFAULT_REPORT_LIST_CAPS}. */
  caps?: ReportListCaps;
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
  private readonly caps: ReportListCaps;
  private readonly notify: (summary: RuntimeReportSummaryV1) => void;
  private readonly projection: Projection;
  private report: RuntimeReportV1;

  /**
   * The storm-prone lists (`changedFiles`/`artifactCandidates` per run, and the
   * top-level `unassignedChanges`) live as insertion-ordered `Map<path, entry>`
   * SSOTs, not as the report's arrays. An append is O(1) (`set` dedupes by path,
   * keeping the first-seen position) and caps in place (evict-oldest + bump
   * droppedCount) — killing the per-event `dedupeByPath` array rebuild that made
   * a build storm O(n²) (incident F3). The report's arrays are a cache
   * MATERIALIZED from these maps at read/flush time only.
   */
  private readonly changedFilesByRun = new Map<string, Map<string, RuntimeFileChangeReport>>();
  private readonly artifactsByRun = new Map<string, Map<string, RuntimeArtifactCandidateReport>>();
  private unassignedChangesMap = new Map<string, RuntimeFileChangeReport>();

  /**
   * Delete semantics (OBS S2). `discard()` seals WITHOUT the final write so a
   * session teardown that is about to `rmSync` the record dir does not first
   * re-write (resurrect) the report file. The flush closure honors this flag so
   * even the seal-driven flush is inert.
   */
  private discarded = false;

  constructor(options: RunIndexOptions) {
    this.taskId = options.taskId;
    this.reportPath = options.reportPath;
    this.caps = options.caps ?? DEFAULT_REPORT_LIST_CAPS;
    this.notify = options.notify ?? (() => {});
    this.report = options.loadExisting
      ? readExistingReport(options.reportPath, options.taskId)
      : freshRuntimeReportV1(options.taskId);
    this.hydrateMaps();
    this.projection = new Projection({
      name: `run-index:${options.taskId}`,
      flush: () => this.flushReport(),
      trailingMs: options.trailingMs ?? DEFAULT_REPORT_TRAILING_MS,
      ...(options.timers ? { timers: options.timers } : {}),
    });
    // Materialize the report at birth (this is also S0's load-time compaction
    // write for a bloated resumed report). Direct write, NOT through the
    // projection: construction must not broadcast report:updated.
    this.writeReport();
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
        return this.markMutated(true);
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
        return this.markMutated(true);
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
        return this.markMutated(false);
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
        return this.markMutated(true);
      case "approval:decision":
        this.recordApprovalEvent(event.payload.runId, {
          ts: event.ts,
          action: "decision",
          decision: event.payload.decision,
          encodedAs: event.payload.encodedAs,
          previousKind: event.payload.previousKind,
        });
        return this.markMutated(true);
      case "approval:persisted":
        this.recordApprovalEvent(event.payload.runId, {
          ts: event.ts,
          action: "persisted",
          file: event.payload.file,
          rulesAdded: event.payload.rulesAdded,
        });
        return this.markMutated(true);
      case "run:stop-requested":
        this.appendRunEvent(event.payload.runId, "stopEvents", {
          ts: event.ts,
          action: "interrupt",
          phase: event.payload.phase,
          encodedAs: event.payload.encodedAs,
        });
        return this.markMutated(false);
      case "run:stopped":
        this.appendRunEvent(event.payload.runId, "stopEvents", {
          ts: event.ts,
          action: "stopped",
          interruptSent: event.payload.interruptSent,
          slashStopSent: event.payload.slashStopSent,
          slashStopReason: event.payload.slashStopReason,
        });
        return this.markMutated(true);
      case "file:changed":
        this.appendChangedFile(event);
        return this.markMutated(false);
      case "pty:exit":
        // The PTY died — a lifecycle barrier, but NOT a mutation: the branch
        // records nothing (O2: never markCritical a clean projection, which
        // would force-write an unchanged report). Flush any pending routine tail
        // NOW so the on-disk report is current at exit. This runs synchronously
        // BEFORE the deferred retire→dispose(seal) (retire is queueMicrotask'd),
        // and flushNow clears dirty, so the subsequent seal finds nothing to
        // flush — exactly one flush, no double-write, no lost tail. flushNow is a
        // no-op when clean or already sealed (a straggler post-teardown pty:exit).
        this.projection.flushNow();
        return null;
      case "task:ready":
      case "working-status:updated":
      case "prompt:submitted":
      case "file:watching":
      case "file:watch-error":
      // A broker approval timed out to the native panel — the request is still
      // pending (the native decision updates run state later), so the index
      // records nothing here.
      case "approval:expired":
        // Pure no-ops: mutate nothing, mark nothing, bump no generatedAt, write
        // nothing (incident F1 — these fall-throughs used to trigger a full
        // synchronous rewrite on every spinner tick).
        return null;
      default:
        assertNever(event);
    }
  }

  /**
   * Stamp `generatedAt` for a real content mutation and drive the projection's
   * cadence: critical lifecycle events flush immediately; routine mutations arm
   * the trailing window. Returns the summary so the controller can keep its
   * per-event task-status sync (run:started/run:updated) coupled to the mutation,
   * NOT to the flush cadence.
   */
  private markMutated(critical: boolean): RuntimeReportSummaryV1 {
    this.report.generatedAt = new Date().toISOString();
    if (critical) {
      this.projection.markCritical();
    } else {
      this.projection.markDirty();
    }
    return this.summary();
  }

  read(): RuntimeReportV1 {
    this.materialize();
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
      this.capMapAppend(
        this.unassignedChangesMap,
        change.path,
        change,
        this.caps.unassignedChanges,
        "unassignedChanges",
      );
      return;
    }

    this.capMapAppend(
      this.changedFilesFor(run.runId),
      change.path,
      change,
      this.caps.changedFiles,
      "changedFiles",
    );

    if (isArtifactCandidate(change.path)) {
      this.capMapAppend(
        this.artifactsFor(run.runId),
        change.path,
        { path: change.path, changeKind: change.changeKind, type: artifactType(change.path) },
        this.caps.artifactCandidates,
        "artifactCandidates",
      );
    }
  }

  private changedFilesFor(runId: string): Map<string, RuntimeFileChangeReport> {
    let map = this.changedFilesByRun.get(runId);
    if (!map) {
      map = new Map();
      this.changedFilesByRun.set(runId, map);
    }
    return map;
  }

  private artifactsFor(runId: string): Map<string, RuntimeArtifactCandidateReport> {
    let map = this.artifactsByRun.get(runId);
    if (!map) {
      map = new Map();
      this.artifactsByRun.set(runId, map);
    }
    return map;
  }

  /**
   * Append into a bounded, insertion-ordered, path-keyed map. `set` dedupes by
   * path in place (first-seen position preserved, latest value wins — the exact
   * semantics of the old `dedupeByPath`), so a re-changed file does not grow the
   * list. When the map exceeds its cap, evict oldest-first and accumulate the
   * drop into `droppedCounts` — once per actually-dropped entry, never a re-cap
   * of a still-growing array (the S0 trim-in-place carry-over, satisfied here by
   * construction: the live structure is never allowed past the cap).
   */
  private capMapAppend<T>(
    map: Map<string, T>,
    key: string,
    value: T,
    cap: number,
    bucket: keyof RuntimeReportDroppedCounts,
  ): void {
    map.set(key, value);
    while (map.size > cap) {
      const oldest = map.keys().next().value as string;
      map.delete(oldest);
      this.bumpDropped(bucket);
    }
  }

  private bumpDropped(bucket: keyof RuntimeReportDroppedCounts): void {
    if (!this.report.droppedCounts) {
      this.report.droppedCounts = { changedFiles: 0, unassignedChanges: 0, artifactCandidates: 0 };
    }
    this.report.droppedCounts[bucket] += 1;
  }

  /** Seed the path-keyed maps from a loaded/fresh report's arrays (see maps' doc). */
  private hydrateMaps(): void {
    for (const run of this.report.runs) {
      this.changedFilesByRun.set(
        run.runId,
        new Map(run.changedFiles.map((change) => [change.path, change])),
      );
      this.artifactsByRun.set(
        run.runId,
        new Map(run.artifactCandidates.map((artifactCandidate) => [artifactCandidate.path, artifactCandidate])),
      );
    }
    this.unassignedChangesMap = new Map(
      this.report.unassignedChanges.map((change) => [change.path, change]),
    );
  }

  /** Project the path-keyed map SSOTs back into the report's arrays (the persisted shape). */
  private materialize(): void {
    for (const run of this.report.runs) {
      const changed = this.changedFilesByRun.get(run.runId);
      if (changed) {
        run.changedFiles = [...changed.values()];
      }
      const artifacts = this.artifactsByRun.get(run.runId);
      if (artifacts) {
        run.artifactCandidates = [...artifacts.values()];
      }
    }
    this.report.unassignedChanges = [...this.unassignedChangesMap.values()];
  }

  /**
   * Normal teardown: flush any pending dirty tail, then seal permanently inert
   * (OBS S2). Post-seal, every mark/flush is a no-op — a late straggler event
   * (e.g. the killed PTY's async `pty:exit`) can no longer re-create the report
   * file, and with it the task's record dir, after the session was deleted. The
   * straggler guard the old `disposed` flag enforced by hand is now structural,
   * owned by Projection.seal.
   */
  dispose(): void {
    this.projection.seal();
  }

  /**
   * Delete teardown: seal WITHOUT the final write. `deleteSession` disposes the
   * RunIndex and then `rmSync`s the record dir; a flush-then-seal here would
   * re-write the report file microseconds before it is removed (a pointless write
   * of a doomed file — and, if the ordering ever changed, an outright
   * resurrection). `discarded` makes the seal-driven flush inert, so the write
   * never happens while sealing still reaches permanent inertness.
   */
  discard(): void {
    this.discarded = true;
    this.projection.seal();
  }

  /**
   * The projection's flush closure: write + notify, one dirty-gated cadence
   * (D6 main half). Materialize the maps into the report arrays, write compact
   * JSON (no pretty-print — >2× smaller, incident F3), then broadcast. MUST NOT
   * mark the projection (S1 review O1: unguarded flush→mark recursion). Inert
   * under `discard()`.
   */
  private flushReport(): void {
    if (this.discarded) {
      return;
    }
    this.writeReport();
    this.notify(this.summary());
  }

  private writeReport(): void {
    this.materialize();
    fs.mkdirSync(path.dirname(this.reportPath), { recursive: true });
    const tmpPath = `${this.reportPath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(this.report)}\n`);
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
