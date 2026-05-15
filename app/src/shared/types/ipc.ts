import type {
  ArtifactCandidate,
  ApprovalDecision,
  RuntimeProvider,
  Task,
  TaskId,
} from "./domain";
import type { RuntimeEvent } from "./events";
import type { RuntimeReportSummaryV1, RuntimeReportV1 } from "../schemas/runtime-report";

export const IPC_CHANNELS = {
  taskCreate: "task:create",
  taskOpen: "task:open",
  promptSubmit: "prompt:submit",
  approvalDecide: "approval:decide",
  runStop: "run:stop",
  terminalResize: "terminal:resize",
  reportRead: "report:read",
  artifactList: "artifact:list",
  artifactRead: "artifact:read",
  runtimeEvent: "runtime:event",
} as const;

export interface CreateTaskRequest {
  title?: string;
  provider: RuntimeProvider;
  cwd?: string;
  sandbox?: "read-only" | "workspace-write";
  approval?: "never" | "on-request";
  rows?: number;
  cols?: number;
}

export interface CreateTaskResponse {
  task: Task;
  runtime: {
    pid: number;
    command: string;
    args: string[];
    cwd: string;
  };
}

export interface OpenTaskRequest {
  taskId: TaskId;
}

export interface SubmitPromptRequest {
  taskId: TaskId;
  text: string;
}

export interface ApprovalDecisionRequest {
  taskId: TaskId;
  decision: ApprovalDecision;
}

export interface StopRunRequest {
  taskId: TaskId;
  inspectDelayMs?: number;
  forceSlashStop?: boolean;
}

export interface ResizeTerminalRequest {
  taskId: TaskId;
  cols: number;
  rows: number;
}

export interface ReadReportRequest {
  taskId: TaskId;
}

export interface ListArtifactsRequest {
  taskId: TaskId;
}

export interface ReadArtifactRequest {
  taskId: TaskId;
  relativePath: string;
}

export type PreviewKind = "html" | "text" | "image" | "metadata";

export interface ArtifactPreviewResponse {
  path: string;
  extension: string;
  size: number;
  truncated: boolean;
  previewKind: PreviewKind;
  content?: string;
  dataUrl?: string;
  rawTerminalPointer: null;
}

export interface DuetRuntimeBridge {
  createTask(request: CreateTaskRequest): Promise<CreateTaskResponse>;
  openTask(request: OpenTaskRequest): Promise<Task>;
  submitPrompt(request: SubmitPromptRequest): Promise<void>;
  decideApproval(request: ApprovalDecisionRequest): Promise<void>;
  stopRun(request: StopRunRequest): Promise<void>;
  resizeTerminal(request: ResizeTerminalRequest): Promise<void>;
  readReport(request: ReadReportRequest): Promise<RuntimeReportV1 | null>;
  listArtifacts(request: ListArtifactsRequest): Promise<ArtifactCandidate[]>;
  readArtifact(request: ReadArtifactRequest): Promise<ArtifactPreviewResponse>;
  onRuntimeEvent(callback: (event: RuntimeEvent) => void): () => void;
}

export interface RuntimeReportUpdatePayload {
  summary: RuntimeReportSummaryV1;
}
