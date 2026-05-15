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
} from "./domain";

export interface BaseRuntimeEvent<TType extends string, TPayload> {
  type: TType;
  payload: TPayload;
  ts: string;
}

export type TerminalDataEvent = BaseRuntimeEvent<
  "pty:data",
  {
    taskId: TaskId;
    data: string;
  }
>;

export type PtyExitEvent = BaseRuntimeEvent<
  "pty:exit",
  {
    taskId: TaskId;
    runId: RunId | null;
    exitCode: number | null;
    signal: number | null;
    elapsedMs: number | null;
  }
>;

export type TaskStartedEvent = BaseRuntimeEvent<
  "task:started",
  {
    taskId: TaskId;
    command: string;
    args: string[];
    cwd: string;
    rows: number;
    cols: number;
    persistence: "raw-terminal-memory-only";
  }
>;

export type TaskReadyEvent = BaseRuntimeEvent<
  "task:ready",
  {
    taskId: TaskId;
    source: "terminal-idle-composer-heuristic";
    confidence: CompletionConfidence;
  }
>;

export type PromptSubmittedEvent = BaseRuntimeEvent<
  "prompt:submitted",
  {
    taskId: TaskId;
    runId: RunId | null;
    kind: RunKind;
    chars: number;
  }
>;

export type RunStartedEvent = BaseRuntimeEvent<
  "run:started",
  {
    taskId: TaskId;
    id: RunId;
    kind: RunKind;
    prompt: string;
    title: string;
    status: RunStatus;
    lifecyclePhase: RunStatus;
    startedAt: string;
    endedAt: string | null;
    elapsedMs: number | null;
    completionSource: CompletionSource | null;
    completionConfidence: CompletionConfidence | null;
  }
>;

export type RunUpdatedEvent = BaseRuntimeEvent<
  "run:updated",
  RunStartedEvent["payload"] & {
    statusReason?: string;
    completionHint?: unknown;
    lastLifecycleHint?: unknown;
    approvalKind?: ApprovalKind;
    approvalDecision?: ApprovalDecision;
  }
>;

export type RunStopRequestedEvent = BaseRuntimeEvent<
  "run:stop-requested",
  {
    taskId: TaskId;
    runId: RunId | null;
    phase: "interrupt";
    encodedAs: "Esc";
  }
>;

export type RunStoppedEvent = BaseRuntimeEvent<
  "run:stopped",
  {
    taskId: TaskId;
    runId: RunId | null;
    interruptSent: boolean;
    slashStopSent: boolean;
    slashStopReason: string;
  }
>;

export type ApprovalDetectedEvent = BaseRuntimeEvent<
  "approval:detected",
  {
    taskId: TaskId;
    runId: RunId | null;
    kind: ApprovalKind;
    source: "native Codex PTY approval screen";
  }
>;

export type ApprovalDecisionEvent = BaseRuntimeEvent<
  "approval:decision",
  {
    taskId: TaskId;
    runId: RunId | null;
    decision: ApprovalDecision;
    encodedAs: "CSI-u Enter" | "Esc";
    previousKind: ApprovalKind | null;
  }
>;

export type FileWatchingEvent = BaseRuntimeEvent<
  "file:watching",
  {
    taskId: TaskId;
    cwd: string;
    mode: "fs.watch" | "polling";
    reason?: string;
  }
>;

export type FileWatchErrorEvent = BaseRuntimeEvent<
  "file:watch-error",
  {
    taskId: TaskId;
    cwd: string;
    mode: "fs.watch" | "polling";
    error: string;
  }
>;

export type FileChangedEvent = BaseRuntimeEvent<
  "file:changed",
  {
    taskId: TaskId;
    runId: RunId | null;
    path: string;
    absolutePath: string;
    eventType: string;
    changeKind: ChangeKind;
    type: "file" | "directory" | "other" | "missing" | "error";
    size: number | null;
    mtimeMs: number | null;
    sha256: string | null;
  }
>;

export type RuntimeReportUpdatedEvent = BaseRuntimeEvent<
  "report:updated",
  {
    taskId: TaskId;
    reportPath: string;
    runCount: number;
    latestRunId: RunId | null;
    rawTerminalPersisted: false;
    rawTerminalPointer: null;
  }
>;

export type ProductRuntimeEvent =
  | PtyExitEvent
  | TaskStartedEvent
  | TaskReadyEvent
  | PromptSubmittedEvent
  | RunStartedEvent
  | RunUpdatedEvent
  | RunStopRequestedEvent
  | RunStoppedEvent
  | ApprovalDetectedEvent
  | ApprovalDecisionEvent
  | FileWatchingEvent
  | FileWatchErrorEvent
  | FileChangedEvent
  | RuntimeReportUpdatedEvent;

export type RuntimeEvent = TerminalDataEvent | ProductRuntimeEvent;

export type RunIndexEvent = Exclude<ProductRuntimeEvent, RuntimeReportUpdatedEvent>;
