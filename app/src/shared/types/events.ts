import type { NativeStatusRegion, WorkingLiveness } from "./working-status";
import type {
  ApprovalChoice,
  ApprovalDecision,
  ApprovalDecisionEncoding,
  ApprovalKind,
  ChangeKind,
  CompletionConfidence,
  CompletionHint,
  CompletionSource,
  DeliveryItemId,
  DeliveryQueueItem,
  DeliveryReceipt,
  DeliveryTaskState,
  LaunchSpeedMode,
  ReasoningEffort,
  RunId,
  RunKind,
  RunStatus,
  TaskId,
  Task,
  RuntimeProvider,
} from "./domain";
import type { TranscriptBlock, TranscriptSourceRef } from "./transcript";
import type { UsageSnapshot } from "./usage";

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
    provider: RuntimeProvider;
    model: string | null;
    reasoningEffort: ReasoningEffort | null;
    speedMode: LaunchSpeedMode | null;
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

export type TaskAcceptsInputEvent = BaseRuntimeEvent<
  "task:accepts-input",
  {
    taskId: TaskId;
    source: "idle-prompt-structural";
    confidence: CompletionConfidence;
  }
>;

export type WorkingStatusUpdatedEvent = BaseRuntimeEvent<
  "working-status:updated",
  {
    taskId: TaskId;
    native: NativeStatusRegion | null;
    liveness: WorkingLiveness;
    silentSince: string | null;
    capturedAt: string;
  }
>;

export type TaskUpdatedEvent = BaseRuntimeEvent<
  "task:updated",
  {
    taskId: TaskId;
    task: Task;
    reason: "verified-native-control" | "runtime-status";
  }
>;

export type PromptSubmittedEvent = BaseRuntimeEvent<
  "prompt:submitted",
  {
    taskId: TaskId;
    runId: RunId | null;
    kind: RunKind;
    chars: number;
    attachments: number;
  }
>;

export type DeliveryStateEvent = BaseRuntimeEvent<"delivery:state", DeliveryTaskState>;

export type DeliveryReceiptEvent = BaseRuntimeEvent<
  "delivery:receipt",
  {
    taskId: TaskId;
    itemId: DeliveryItemId;
    item: DeliveryQueueItem;
    receipt: DeliveryReceipt;
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
    completionHint?: CompletionHint;
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
    source: string;
    resurfacedAfterDecision?: boolean;
    previousDecision?: ApprovalDecision | null;
    decisionAgeMs?: number | null;
    fingerprintHash?: string | null;
    choices?: ApprovalChoice[];
  }
>;

export type ApprovalDecisionEvent = BaseRuntimeEvent<
  "approval:decision",
  {
    taskId: TaskId;
    runId: RunId | null;
    decision: ApprovalDecision;
    encodedAs: ApprovalDecisionEncoding;
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

export type TranscriptLocatedEvent = BaseRuntimeEvent<
  "transcript:located",
  {
    taskId: TaskId;
    source: TranscriptSourceRef;
  }
>;

export type TranscriptBlocksEvent = BaseRuntimeEvent<
  "transcript:blocks",
  {
    taskId: TaskId;
    sourceId: string;
    upserts: TranscriptBlock[];
    /** True when existing blocks of this source must be dropped before applying. */
    reset: boolean;
  }
>;

export type UsageUpdatedEvent = BaseRuntimeEvent<
  "usage:updated",
  {
    taskId: TaskId;
    snapshot: UsageSnapshot;
  }
>;

/**
 * The persisted session index changed (session created, renamed, archived,
 * deleted, or a project overlay edit). Carries no data — listeners re-read
 * the index via session:index:read.
 */
export type SessionsUpdatedEvent = BaseRuntimeEvent<
  "sessions:updated",
  {
    reason:
      | "session-created"
      | "session-updated"
      | "session-renamed"
      | "session-archived"
      | "session-deleted"
      | "project-updated";
  }
>;

export type ProductRuntimeEvent =
  | PtyExitEvent
  | TaskStartedEvent
  | TaskReadyEvent
  | TaskAcceptsInputEvent
  | WorkingStatusUpdatedEvent
  | TaskUpdatedEvent
  | PromptSubmittedEvent
  | DeliveryStateEvent
  | DeliveryReceiptEvent
  | RunStartedEvent
  | RunUpdatedEvent
  | RunStopRequestedEvent
  | RunStoppedEvent
  | ApprovalDetectedEvent
  | ApprovalDecisionEvent
  | FileWatchingEvent
  | FileWatchErrorEvent
  | FileChangedEvent
  | RuntimeReportUpdatedEvent
  | TranscriptLocatedEvent
  | TranscriptBlocksEvent
  | UsageUpdatedEvent
  | SessionsUpdatedEvent;

export type RuntimeEvent = TerminalDataEvent | ProductRuntimeEvent;

export type RunIndexEvent = Exclude<
  ProductRuntimeEvent,
  | RuntimeReportUpdatedEvent
  | TranscriptLocatedEvent
  | TranscriptBlocksEvent
  | UsageUpdatedEvent
  | SessionsUpdatedEvent
  | DeliveryStateEvent
  | DeliveryReceiptEvent
  | TaskUpdatedEvent
>;
