export type TaskId = string;
export type RunId = string;
export type DeliveryItemId = string;
export type RuntimeSessionId = string;
export type ProviderSessionRef = string;
export type ArtifactId = string;
export type ApprovalId = string;

export type RuntimeProvider = "codex" | "claude";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type LaunchSpeedMode = "default" | "fast";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalMode = "never" | "on-request";
export type CodexPermissionPreset = "askForApproval" | "approveForMe" | "fullAccess";
export type ClaudePermissionMode =
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "default"
  | "dontAsk"
  | "plan";

export type TaskStatus =
  | "new"
  | "starting"
  | "running"
  | "waiting-for-approval"
  | "stopping"
  | "stopped"
  | "failed"
  | "idle";

export interface Task {
  id: TaskId;
  title: string;
  provider: RuntimeProvider;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  speedMode: LaunchSpeedMode | null;
  sandbox: CodexSandboxMode | null;
  approval: CodexApprovalMode | null;
  permissionMode: ClaudePermissionMode | null;
  runtimeSessionId: RuntimeSessionId;
  providerSessionRef: ProviderSessionRef | null;
  providerCwd: string;
  workingDirectory: string;
  status: TaskStatus;
  /** Session is hidden from the default sidebar list. Absent on old manifests. */
  archived?: boolean;
  /**
   * True when Duet generated the working directory itself — a project-less
   * "chat" — rather than the user choosing a folder. Set explicitly at creation
   * and read for sidebar grouping (chat vs project) and deletion policy. Replaces
   * the old "is providerCwd inside the central storage root?" inference, which D7
   * dissolved by moving the auto-workspace cwd to a visible ~/Documents/Duet/<slug>.
   * Absent on pre-D7 manifests → treat as false (a chosen project).
   */
  autoWorkspace?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeSession {
  id: RuntimeSessionId;
  taskId: TaskId;
  provider: RuntimeProvider;
  providerSessionRef: ProviderSessionRef | null;
  providerCwd: string;
  livePtyProcess: PtyProcessState | null;
  createdAt: string;
  updatedAt: string;
}

export interface PtyProcessState {
  pid: number;
  command: string;
  args: string[];
  cwd: string;
  startedAt: string;
  cols: number;
  rows: number;
}

export type RunKind = "prompt" | "slash";

export type RunStatus =
  | "active"
  | "waiting-for-approval"
  | "resumed-after-approval"
  | "stopping"
  | "stopped"
  | "approval-denied"
  | "pty-exited"
  | "completed"
  | "failed";

export type CompletionSource =
  | "manual-control"
  | "native-control"
  | "pty-exit"
  | "hook-stop"
  | "terminal-idle-heuristic"
  | "unknown";

export type CompletionConfidence = "high" | "medium" | "low";

export interface CompletionHint {
  source?: CompletionSource;
  confidence?: CompletionConfidence;
  signals?: Record<string, boolean>;
  errorExcerpt?: string;
  [key: string]: unknown;
}

export type DeliveryItemStatus = "queued" | "delivering" | "delivered" | "undelivered";
export type DeliveryItemKind = "prompt" | "control";
export type DeliveryReceiptSource =
  | "provider-transcript"
  | "pty-composer-echo"
  | "native-control"
  // A mid-turn write-through send: the bytes were written and the CLI native-
  // queued it (P2/P6) → sent. Its transcript block arrives only at dequeue, so
  // this is the receipt at hand-off time (no 45s undelivered timer).
  | "native-queue";

/** Who owns the bytes. `blob` = Duet copied them into the per-task attachments
 *  dir (deleted with the chip/session). `referenced` = the user's own path, never
 *  copied and NEVER deleted by Duet. */
export type AttachmentProvenance = "blob" | "referenced";

/** Decides the delivery channel and the chip's visual. `image` chips natively as
 *  [Image #N]; `file`/`folder` are delivered as a path mention in the prompt text. */
export type AttachmentKind = "image" | "file" | "folder";

export interface DeliveryAttachment {
  id: string;
  path: string;
  originalName: string;
  mediaType: string;
  size: number;
  provenance: AttachmentProvenance;
  kind: AttachmentKind;
}

/** A referenced path plus a chip preview. previewDataUrl is a capped thumbnail
 *  data URL for an image reference; null for files/folders or oversize images
 *  (the chip falls back to a kind icon). Kept off DeliveryAttachment so the wire
 *  type never carries preview bytes. */
export interface ReferenceResult {
  attachment: DeliveryAttachment;
  previewDataUrl: string | null;
}

export type DeliveryControlChange =
  | {
      kind: "permission";
      label: string;
      codex: {
        preset: CodexPermissionPreset;
        sandbox: CodexSandboxMode;
        approval: CodexApprovalMode;
      } | null;
      claude: {
        permissionMode: ClaudePermissionMode;
      } | null;
    }
  | {
      kind: "model";
      label: string;
      model: string | null;
      reasoningEffort: ReasoningEffort | null;
    };

export interface DeliveryReceipt {
  source: DeliveryReceiptSource;
  receivedAt: string;
  runId: RunId | null;
  sourceId: string | null;
  blockId: string | null;
  backfilled: boolean;
}

export interface DeliveryQueueItem {
  id: DeliveryItemId;
  taskId: TaskId;
  kind: DeliveryItemKind;
  text: string;
  control: DeliveryControlChange | null;
  attachments: DeliveryAttachment[];
  status: DeliveryItemStatus;
  enqueuedAt: string;
  deliveringAt: string | null;
  runId: RunId | null;
  receipt: DeliveryReceipt | null;
  failureReason: string | null;
}

export interface DeliveryTaskState {
  taskId: TaskId;
  provider: RuntimeProvider;
  deliverable: boolean;
  activeRun: boolean;
  approvalActive: boolean;
  /** A native interactive panel owns the screen — delivery is blocked by
   *  state, not by the idle-prompt heuristic (P1b 2026-06-12). */
  modalActive: boolean;
  idleComposer: boolean;
  acceptsInput: boolean;
  queue: DeliveryQueueItem[];
}

export interface CompletionEvidence {
  source: CompletionSource;
  confidence: CompletionConfidence;
  hint?: unknown;
}

export interface Run {
  id: RunId;
  taskId: TaskId;
  kind: RunKind;
  prompt: string;
  title: string;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  elapsedMs: number | null;
  completion: CompletionEvidence | null;
  approvalIds: ApprovalId[];
  artifactIds: ArtifactId[];
  changedFilePaths: string[];
  rawTerminalPointer: null;
}

export type ApprovalKind =
  | "workspace-trust"
  | "file-read"
  | "file-edit"
  | "command"
  // The native "Bypass Permissions mode" warning interstitial — a mode
  // acceptance, not a tool approval. Its safe default is "No, exit"; Duet
  // mirrors that (deny is the primary action, accept is a deliberate opt-in).
  | "dangerous-bypass"
  | "unknown";
export type ApprovalRisk = "file-read" | "file-write" | "network" | "mixed" | "unknown";
/** "answered-natively": the human resolved the screen with their own keys
 *  (take-over) — observed from screen evidence, not sent by Duet.
 *  "approve-always": the panel's native persistent option ("don't ask
 *  again…") — Claude writes its own allow rule; Duet receipts the write. */
export type ApprovalDecision =
  | "approve"
  | "approve-for-session"
  | "approve-always"
  | "deny"
  | "answered-natively";
export type ApprovalDecisionEncoding =
  | "CSI-u Enter"
  | "ArrowDown + CSI-u Enter"
  | "digit 1"
  | "digit 2"
  | "digit 3"
  | "CR"
  | "Esc"
  | "native-keys";

export interface ApprovalChoice {
  decision: ApprovalDecision;
  label: string;
  description: string;
  encodedAs: ApprovalDecisionEncoding;
}

export interface ApprovalState {
  id: ApprovalId;
  taskId: TaskId;
  runId: RunId | null;
  kind: ApprovalKind;
  risk: ApprovalRisk;
  source: "native-pty-approval-screen";
  detectedAt: string;
  decidedAt: string | null;
  decision: ApprovalDecision | null;
}

export type ChangeKind = "added" | "modified" | "deleted";

export interface ChangedFile {
  path: string;
  changeKind: ChangeKind;
  eventType: string;
  type: "file" | "directory" | "other" | "missing" | "error";
  size: number | null;
  sha256: string | null;
  updatedAt: string;
}

export type ArtifactKind =
  | "html"
  | "markdown"
  | "pdf"
  | "image"
  | "spreadsheet"
  | "document"
  | "presentation"
  | "text"
  | "unknown";

export interface ArtifactCandidate {
  id: ArtifactId;
  taskId: TaskId;
  runId: RunId;
  path: string;
  kind: ArtifactKind;
  changeKind: ChangeKind;
  title: string;
  updatedAt: string;
}
