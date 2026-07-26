import type {
  ApprovalChoice,
  ApprovalDecision,
  ApprovalDecisionEncoding,
  ApprovalKind,
  ChangeKind,
  CompletionConfidence,
  CompletionHint,
  CompletionSource,
  LaunchSpeedMode,
  ReasoningEffort,
  RunId,
  RunKind,
  RunStatus,
  TaskId,
  RuntimeProvider,
} from "../types/domain";

export const RUNTIME_REPORT_SCHEMA_VERSION = 1 as const;
export const RUNTIME_REPORT_SCHEMA_ID = "sonata.runtime-report.v1" as const;
export const RAW_TERMINAL_POLICY = "raw-terminal-not-persisted-by-default" as const;

export interface RuntimeReportV1 {
  schemaId: typeof RUNTIME_REPORT_SCHEMA_ID;
  version: typeof RUNTIME_REPORT_SCHEMA_VERSION;
  generatedAt: string;
  taskId: TaskId;
  rawTerminalPolicy: typeof RAW_TERMINAL_POLICY;
  rawTerminalPointer: null;
  runtime: RuntimeLaunchReport | null;
  runs: RuntimeRunReport[];
  unassignedChanges: RuntimeFileChangeReport[];
  /** Approval events with no owning run — e.g. the workspace-trust screen,
   *  which fires during session setup before any run exists. Without this
   *  bucket they were dropped, leaving session-setup approvals with no
   *  forensic trail (2c). */
  unassignedApprovals: RuntimeApprovalReport[];
  /** Cumulative count of entries dropped from the bounded-list buckets,
   *  aggregated across every run's `changedFiles` / `artifactCandidates` and
   *  the top-level `unassignedChanges`. Two drop sources fold into the SAME
   *  per-bucket tally: the bounded-list caps (OBS S0) and the load-time
   *  retroactive ignore-filter compaction (OBS follow-up O1a) that drops entries
   *  today's `shouldIgnorePath` would reject at ingest. Recorded so removal of
   *  the build-noise lists is visible, never silent (incident F3). Additive and
   *  optional: reports written before S0 lack the key and readers must treat
   *  absent as all-zero. */
  droppedCounts?: RuntimeReportDroppedCounts;
}

/** Per-bucket cumulative drop tally for the bounded runtime-report lists. */
export interface RuntimeReportDroppedCounts {
  changedFiles: number;
  unassignedChanges: number;
  artifactCandidates: number;
}

export interface RuntimeLaunchReport {
  provider: RuntimeProvider;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  speedMode: LaunchSpeedMode | null;
  command: string;
  args: string[];
  cwd: string;
  rows: number;
  cols: number;
  startedAt: string;
}

export interface RuntimeRunReport {
  runId: RunId;
  taskId: TaskId;
  kind: RunKind;
  prompt: string;
  /** The CLI's prompt_id (UserPromptSubmit) — the exact run↔turn bridge;
   *  absent on pre-bridge records and idle-path runs whose hook echo was
   *  swallowed (those keep text/time matching). */
  promptId?: string | null;
  title: string;
  status: RunStatus;
  statusReason?: string;
  lifecyclePhase: RunStatus;
  startedAt: string;
  endedAt: string | null;
  elapsedMs: number | null;
  completionSource: CompletionSource | null;
  completionConfidence: CompletionConfidence | null;
  completionHint?: CompletionHint;
  lastLifecycleHint?: unknown;
  approvalKind?: ApprovalKind;
  approvalDecision?: ApprovalDecision;
  approvalEvents: RuntimeApprovalReport[];
  stopEvents: RuntimeStopReport[];
  changedFiles: RuntimeFileChangeReport[];
  artifactCandidates: RuntimeArtifactCandidateReport[];
  rawTerminalPointer: null;
}

export interface RuntimeApprovalReport {
  ts: string;
  action: "detected" | "decision" | "persisted";
  kind?: ApprovalKind;
  source?: string;
  resurfacedAfterDecision?: boolean;
  previousDecision?: ApprovalDecision | null;
  decisionAgeMs?: number | null;
  fingerprintHash?: string | null;
  choices?: ApprovalChoice[];
  decision?: ApprovalDecision;
  encodedAs?: ApprovalDecisionEncoding;
  previousKind?: ApprovalKind | null;
  /** action "persisted": what the provider wrote, observed via read-after-write. */
  file?: string;
  rulesAdded?: string[];
}

export interface RuntimeStopReport {
  ts: string;
  action: "interrupt" | "stopped";
  /** Additive in-place widening (still v1): `interrupt-retry` records the
   *  one-shot Esc resend fired when post-stop tool activity proved the first
   *  Esc was swallowed. Absent/`interrupt` semantics are unchanged. */
  phase?: "interrupt" | "interrupt-retry";
  encodedAs?: "Esc";
  interruptSent?: boolean;
  slashStopSent?: boolean;
  slashStopReason?: string;
}

export interface RuntimeFileChangeReport {
  ts: string;
  path: string;
  absolutePath: string;
  changeKind: ChangeKind;
  eventType: string;
  type: "file" | "directory" | "other" | "missing" | "error";
  size: number | null;
  sha256: string | null;
  /** Attribution channel (OBS S6 / D3). `"tool"` = a PostToolUse hook named the
   *  path — the semantic-first, primary source; `"reconcile"` = a bounded
   *  turn-boundary workspace-stat delta caught it (Bash-mediated / hook-invisible
   *  edits). Additive and optional: absent on reports written before S6, where
   *  entries were the retired filesystem-watcher's `file:changed` stream. */
  source?: "tool" | "reconcile";
  /** The tool that produced a `source: "tool"` change (e.g. `"Write"`,
   *  `"apply_patch"`) — forensic provenance. Absent for reconcile/legacy entries. */
  tool?: string;
}

export interface RuntimeArtifactCandidateReport {
  path: string;
  changeKind: ChangeKind;
  type: string;
}

export interface RuntimeReportSummaryV1 {
  taskId: TaskId;
  reportPath: string;
  runCount: number;
  latestRun: RuntimeRunReport | null;
  rawTerminalPersisted: false;
  rawTerminalPointer: null;
}

export function freshRuntimeReportV1(taskId: TaskId): RuntimeReportV1 {
  return {
    schemaId: RUNTIME_REPORT_SCHEMA_ID,
    version: RUNTIME_REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    taskId,
    rawTerminalPolicy: RAW_TERMINAL_POLICY,
    rawTerminalPointer: null,
    runtime: null,
    runs: [],
    unassignedChanges: [],
    unassignedApprovals: [],
  };
}
