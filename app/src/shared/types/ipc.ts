import type {
  ArtifactCandidate,
  ApprovalDecision,
  ClaudePermissionMode,
  CodexApprovalMode,
  CodexSandboxMode,
  DeliveryControlChange,
  LaunchSpeedMode,
  ReasoningEffort,
  RuntimeProvider,
  Task,
  TaskId,
} from "./domain";
import type { RuntimeEvent } from "./events";
import type { TranscriptBlock, TranscriptSourceRef } from "./transcript";
import type { RuntimeReportSummaryV1, RuntimeReportV1 } from "../schemas/runtime-report";

export const IPC_CHANNELS = {
  taskCreate: "task:create",
  taskOpen: "task:open",
  taskClose: "task:close",
  taskList: "task:list",
  promptSubmit: "prompt:submit",
  controlSet: "control:set",
  promptQueueCancel: "prompt-queue:cancel",
  promptQueueRetry: "prompt-queue:retry",
  approvalDecide: "approval:decide",
  runStop: "run:stop",
  terminalResize: "terminal:resize",
  reportRead: "report:read",
  transcriptRead: "transcript:read",
  artifactList: "artifact:list",
  artifactRead: "artifact:read",
  previewOpen: "preview:open",
  previewReviewedMark: "preview:reviewed:mark",
  previewStateRead: "preview:state:read",
  previewState: "preview:state",
  mainArtifactFocusRequest: "main:artifact:focus:request",
  mainArtifactFocus: "main:artifact:focus",
  inspectorOpen: "inspector:open",
  inspectorStateRead: "inspector:state:read",
  inspectorState: "inspector:state",
  workspaceTreeRead: "workspace:tree:read",
  workspaceFileRead: "workspace:file:read",
  workspaceOpenExternal: "workspace:open-external",
  workspaceOpenFolder: "workspace:open-folder",
  folderPick: "folder:pick",
  runtimeEvent: "runtime:event",
} as const;

export interface CreateTaskRequest {
  title?: string;
  provider: RuntimeProvider;
  cwd?: string;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  speedMode?: LaunchSpeedMode | null;
  sandbox?: CodexSandboxMode;
  approval?: CodexApprovalMode;
  permissionMode?: ClaudePermissionMode;
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
  taskId?: TaskId;
  cwd?: string;
  sandbox?: CodexSandboxMode;
  approval?: CodexApprovalMode;
  permissionMode?: ClaudePermissionMode;
  rows?: number;
  cols?: number;
}

export type OpenTaskResponse = CreateTaskResponse;

export interface CloseTaskRequest {
  taskId: TaskId;
}

export type ListTasksResponse = Task[];

export interface SubmitPromptRequest {
  taskId: TaskId;
  text: string;
}

export interface SetControlRequest {
  taskId: TaskId;
  change: DeliveryControlChange;
}

export interface PromptQueueItemRequest {
  taskId: TaskId;
  itemId: string;
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

export interface ReadTranscriptRequest {
  taskId: TaskId;
}

export interface ReadTranscriptResponse {
  sources: TranscriptSourceRef[];
  blocks: TranscriptBlock[];
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

export interface OpenPreviewRequest {
  taskId: TaskId;
  relativePath?: string;
}

export interface PreviewArtifactRef {
  taskId: TaskId;
  path: string;
}

export interface PreviewWindowTab extends PreviewArtifactRef {
  dirty: boolean;
  reviewed: boolean;
}

export interface PreviewWindowState {
  tabs: PreviewWindowTab[];
  selected: PreviewArtifactRef | null;
}

export interface MarkPreviewReviewedRequest {
  taskId: TaskId;
  relativePath: string;
}

export interface FocusArtifactInMainRequest {
  taskId: TaskId;
  relativePath?: string;
  runId?: string;
  mode: "artifact" | "run";
}

export type InspectorLens = "run" | "change" | "artifact" | "folder";

export interface OpenInspectorRequest {
  taskId: TaskId;
  lens?: InspectorLens;
}

export interface InspectorWindowState {
  taskId: TaskId | null;
  lens: InspectorLens;
}

export interface WorkspaceTreeRequest {
  taskId: TaskId;
}

export interface WorkspaceTreeEntry {
  path: string;
  name: string;
  type: "file" | "directory";
  depth: number;
  children?: WorkspaceTreeEntry[];
}

export interface WorkspaceFileReadRequest {
  taskId: TaskId;
  relativePath: string;
}

export interface WorkspaceFilePreviewResponse {
  path: string;
  extension: string;
  size: number;
  truncated: boolean;
  previewKind: PreviewKind;
  content?: string;
  dataUrl?: string;
}

export interface WorkspaceOpenFolderRequest {
  taskId: TaskId;
}

export type WorkspaceExternalOpenTarget = "folder" | "cursor";

export interface WorkspaceOpenExternalRequest {
  taskId: TaskId;
  target: WorkspaceExternalOpenTarget;
  relativePath?: string;
}

export interface WorkspaceOpenExternalResponse {
  target: WorkspaceExternalOpenTarget;
  path: string;
}

export interface FolderPickResponse {
  path: string | null;
}

export interface DuetRuntimeBridge {
  createTask(request: CreateTaskRequest): Promise<CreateTaskResponse>;
  openTask(request: OpenTaskRequest): Promise<OpenTaskResponse>;
  closeTask(request: CloseTaskRequest): Promise<void>;
  listTasks(): Promise<ListTasksResponse>;
  submitPrompt(request: SubmitPromptRequest): Promise<void>;
  setControl(request: SetControlRequest): Promise<void>;
  cancelQueuedPrompt(request: PromptQueueItemRequest): Promise<void>;
  retryQueuedPrompt(request: PromptQueueItemRequest): Promise<void>;
  decideApproval(request: ApprovalDecisionRequest): Promise<void>;
  stopRun(request: StopRunRequest): Promise<void>;
  resizeTerminal(request: ResizeTerminalRequest): Promise<void>;
  readReport(request: ReadReportRequest): Promise<RuntimeReportV1 | null>;
  readTranscript(request: ReadTranscriptRequest): Promise<ReadTranscriptResponse>;
  listArtifacts(request: ListArtifactsRequest): Promise<ArtifactCandidate[]>;
  readArtifact(request: ReadArtifactRequest): Promise<ArtifactPreviewResponse>;
  openPreview(request: OpenPreviewRequest): Promise<PreviewWindowState>;
  markPreviewReviewed(request: MarkPreviewReviewedRequest): Promise<PreviewWindowState>;
  readPreviewState(): Promise<PreviewWindowState>;
  onPreviewState(callback: (state: PreviewWindowState) => void): () => void;
  focusArtifactInMain(request: FocusArtifactInMainRequest): Promise<void>;
  onMainArtifactFocus(callback: (request: FocusArtifactInMainRequest) => void): () => void;
  openInspector(request: OpenInspectorRequest): Promise<InspectorWindowState>;
  readInspectorState(): Promise<InspectorWindowState>;
  readWorkspaceTree(request: WorkspaceTreeRequest): Promise<WorkspaceTreeEntry[]>;
  readWorkspaceFile(request: WorkspaceFileReadRequest): Promise<WorkspaceFilePreviewResponse>;
  openWorkspaceExternal(request: WorkspaceOpenExternalRequest): Promise<WorkspaceOpenExternalResponse>;
  openWorkspaceFolder(request: WorkspaceOpenFolderRequest): Promise<void>;
  pickFolder(): Promise<FolderPickResponse>;
  onInspectorState(callback: (state: InspectorWindowState) => void): () => void;
  onRuntimeEvent(callback: (event: RuntimeEvent) => void): () => void;
}

export interface RuntimeReportUpdatePayload {
  summary: RuntimeReportSummaryV1;
}
