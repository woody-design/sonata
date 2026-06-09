export type TaskId = string;
export type RunId = string;
export type RuntimeSessionId = string;
export type ProviderSessionRef = string;
export type ArtifactId = string;
export type ApprovalId = string;

export type RuntimeProvider = "codex" | "claude";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type LaunchSpeedMode = "default" | "fast";
export type CodexSandboxMode = "read-only" | "workspace-write";
export type CodexApprovalMode = "never" | "on-request";
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
  | "terminal-idle-heuristic"
  | "unknown";

export type CompletionConfidence = "high" | "medium" | "low";

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

export type ApprovalKind = "workspace-trust" | "file-read" | "file-edit" | "command" | "unknown";
export type ApprovalRisk = "file-read" | "file-write" | "network" | "mixed" | "unknown";
export type ApprovalDecision = "approve" | "approve-for-session" | "deny";
export type ApprovalDecisionEncoding = "CSI-u Enter" | "ArrowDown + CSI-u Enter" | "Esc";

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
