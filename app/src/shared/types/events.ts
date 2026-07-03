import type { NativeStatusRegion, WorkingLiveness } from "./working-status";
import type { CliActivity } from "./cli-signal";
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
import type { OptionPromptAnswers, OptionPromptQuestion } from "./option-prompt";
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
    /** 0-based index of this chunk in the mirror's ingest order. The terminal
     *  window stitches live chunks onto a mid-stream hydration snapshot with it
     *  (write iff seq >= snapshot.seq) — no loss, no duplication. The other
     *  consumers (transcript, inspector, idle heuristic, local-api) ignore it. */
    seq: number;
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

/** A quiescence-completed run returned the composer (fired only from
 *  `finishActiveRun`, terminal-idle-heuristic completions). Consumed by the
 *  cli-state busy→turn-ended fallback for turns with no Stop hook (slash,
 *  Esc-interrupt, codex). The between-runs poller that also fed this —
 *  along with the `task:accepts-input` boot announcement — was retired in
 *  S6 (starved by the idle TUI's control-only heartbeat; boot readiness is
 *  the delivery pump's structural poll). */
export type TaskReadyEvent = BaseRuntimeEvent<
  "task:ready",
  {
    taskId: TaskId;
    source: "terminal-idle-composer-heuristic";
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

/**
 * The unified CLI activity state changed (Slice 1, Layer 1). Fed primarily by
 * Claude hooks (busy/idle/approval transitions) with terminal-host signals as
 * the safety net. The renderer subscribes to drive the working indicator from a
 * structured signal instead of the 3Hz glyph scrape. UI-agnostic by design.
 */
export type CliStateChangedEvent = BaseRuntimeEvent<
  "cli-state:changed",
  {
    taskId: TaskId;
    activity: CliActivity;
    tool: string | null;
    approvalKind: string | null;
    source: string;
    changedAt: string;
  }
>;

export type TaskUpdatedEvent = BaseRuntimeEvent<
  "task:updated",
  {
    taskId: TaskId;
    task: Task;
    reason: "runtime-status";
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

/**
 * Remote Control (phone access) state for a task changed. v1 rides Claude
 * Code's native `/remote-control`: `active` is tracked optimistically (we
 * injected `/rc`, verified to work mid-stream); `url` is the session link
 * scraped from the stream — the one datum with no hook/structured channel,
 * matched by its stable format, never the surrounding prose. The phone surface
 * is Anthropic's claude.ai/code + Claude app, not a Duet-built UI.
 */
export type RemoteControlStateEvent = BaseRuntimeEvent<
  "remote-control:state",
  {
    taskId: TaskId;
    active: boolean;
    url: string | null;
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
    /** How the card's answer reaches the CLI: "reply" = the hook broker (S2,
     *  Claude) — Duet writes reply-<approvalId>.json; "keys" = the scraped
     *  native panel (Codex + the broker's timeout fallback). Absent ⇒ "keys". */
    answerVia?: "reply" | "keys";
    /** The broker's id — the reply file to write when answerVia === "reply". */
    approvalId?: string | null;
    /** The one-line "what the agent wants to do", derived from the hook's
     *  tool_name/tool_input (e.g. "Run `touch x`"). The card shows THIS instead
     *  of the low-level panel encodings. Absent for scrape cards. */
    summary?: string | null;
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
    /** The broker ask this decision resolves (reply-channel answers). Absent
     *  on scrape/native decisions — those resolve the RENDERED panel, keyed
     *  by the delivery gate's scrape sentinel (S6 review P1). */
    approvalId?: string | null;
  }
>;

/** A hook-broker approval timed out (S2) — the CLI is falling back to its native
 *  panel, which the scrape will surface next. NOT a decision: nothing was
 *  answered. The hook card clears, but the "user still owes an answer" truth
 *  (cli-state waiting-approval, delivery blocked) is deliberately preserved
 *  until the native panel is answered (reviewer P1/P2). */
export type ApprovalExpiredEvent = BaseRuntimeEvent<
  "approval:expired",
  { taskId: TaskId; approvalId: string }
>;

/** Receipt for a persisted allow: observed (read-after-write diff of the
 *  provider's own settings file), never promised. Not emitted when no
 *  write is observed — honest absence. */
export type ApprovalPersistedEvent = BaseRuntimeEvent<
  "approval:persisted",
  {
    taskId: TaskId;
    runId: RunId | null;
    file: string;
    rulesAdded: string[];
  }
>;

/**
 * Claude's native `AskUserQuestion` (multiple-choice) tool surfaced as an
 * in-view card (Slice 5). `detected` carries the parsed questions (from the
 * PreToolUse hook's `tool_input`); `resolved` carries the verbatim answers
 * (from the PostToolUse hook's `tool_response.answers`) — or null when the
 * prompt was cancelled / the turn ended unanswered. Detection is structured
 * (the hook), not scraped; the floor stays a valid alternative answer surface.
 */
export type OptionPromptDetectedEvent = BaseRuntimeEvent<
  "option-prompt:detected",
  {
    taskId: TaskId;
    toolUseId: string;
    questions: OptionPromptQuestion[];
  }
>;

export type OptionPromptResolvedEvent = BaseRuntimeEvent<
  "option-prompt:resolved",
  {
    taskId: TaskId;
    toolUseId: string;
    answers: OptionPromptAnswers | null;
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
  | WorkingStatusUpdatedEvent
  | CliStateChangedEvent
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
  | ApprovalExpiredEvent
  | ApprovalPersistedEvent
  | OptionPromptDetectedEvent
  | OptionPromptResolvedEvent
  | RemoteControlStateEvent
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
  | CliStateChangedEvent
  | DeliveryStateEvent
  | DeliveryReceiptEvent
  | TaskUpdatedEvent
  | RemoteControlStateEvent
  | OptionPromptDetectedEvent
  | OptionPromptResolvedEvent
>;
