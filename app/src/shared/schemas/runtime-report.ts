import type {
  ApprovalDecision,
  ApprovalKind,
  ChangeKind,
  CompletionConfidence,
  CompletionSource,
  RunId,
  RunKind,
  RunStatus,
  TaskId,
} from "../types/domain";

export const RUNTIME_REPORT_SCHEMA_VERSION = 1 as const;
export const RUNTIME_REPORT_SCHEMA_ID = "duet.runtime-report.v1" as const;
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
}

export interface RuntimeLaunchReport {
  provider: "codex";
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
  title: string;
  status: RunStatus;
  statusReason?: string;
  lifecyclePhase: RunStatus;
  startedAt: string;
  endedAt: string | null;
  elapsedMs: number | null;
  completionSource: CompletionSource | null;
  completionConfidence: CompletionConfidence | null;
  completionHint?: unknown;
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
  action: "detected" | "decision";
  kind?: ApprovalKind;
  source?: string;
  decision?: ApprovalDecision;
  encodedAs?: "CSI-u Enter" | "Esc";
  previousKind?: ApprovalKind | null;
}

export interface RuntimeStopReport {
  ts: string;
  action: "interrupt" | "stopped";
  phase?: "interrupt";
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
  };
}
