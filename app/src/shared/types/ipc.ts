import type {
  ArtifactCandidate,
  ApprovalDecision,
  ClaudePermissionMode,
  CodexApprovalMode,
  CodexSandboxMode,
  DeliveryAttachment,
  ReferenceResult,
  LaunchSpeedMode,
  ReasoningEffort,
  RuntimeProvider,
  Task,
  TaskId,
} from "./domain";
import type { RuntimeEvent } from "./events";
import type { ReadingSettings, ResolvedReadingMode } from "./reading-settings";
import type { TerminalWindowSettings } from "./terminal-window-settings";
import type { ResumePolicyId, ResumeSettings } from "./resume-settings";
import type { ClaudeSettings } from "./claude-settings";
import type {
  ReadSessionIndexRequest,
  ReadSessionSnapshotRequest,
  SessionIndexResponse,
  SessionSnapshotResponse,
} from "./sessions";
import type { ReadSlashCommandsRequest, SlashCommandsResponse } from "./slash";
import type { TranscriptBlock, TranscriptSourceRef } from "./transcript";
import type { UsageSnapshot } from "./usage";
import type { RuntimeReportSummaryV1, RuntimeReportV1 } from "../schemas/runtime-report";

export const IPC_CHANNELS = {
  taskCreate: "task:create",
  taskOpen: "task:open",
  taskClose: "task:close",
  taskList: "task:list",
  sessionIndexRead: "session:index:read",
  sessionRead: "session:read",
  sessionRename: "session:rename",
  sessionArchive: "session:archive",
  sessionDelete: "session:delete",
  sessionReveal: "session:reveal",
  projectRename: "project:rename",
  projectArchive: "project:archive",
  projectReveal: "project:reveal",
  promptSubmit: "prompt:submit",
  attachmentCreate: "attachment:create",
  attachmentCreateReference: "attachment:create-reference",
  attachmentPick: "attachment:pick",
  approvalDecide: "approval:decide",
  optionPromptAnswer: "option-prompt:answer",
  runStop: "run:stop",
  terminalResize: "terminal:resize",
  terminalUserInput: "terminal:user-input",
  terminalOpenLink: "terminal:open-link",
  terminalReplay: "terminal:replay",
  clipboardReadText: "clipboard:read-text",
  reportRead: "report:read",
  transcriptRead: "transcript:read",
  usageRead: "usage:read",
  slashCommandsRead: "slash:commands:read",
  remoteControlInject: "remote-control:inject",
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
  terminalWindowSetOpen: "terminal-window:set-open",
  terminalWindowStateRead: "terminal-window:state:read",
  terminalWindowState: "terminal-window:state",
  terminalWindowSettingsRead: "terminal-window:settings:read",
  terminalWindowSettingsWrite: "terminal-window:settings:write",
  terminalActiveTaskSet: "terminal-active-task:set",
  terminalActiveTaskRead: "terminal-active-task:read",
  terminalActiveTask: "terminal-active-task",
  workspaceTreeRead: "workspace:tree:read",
  workspaceFileRead: "workspace:file:read",
  workspaceOpenExternal: "workspace:open-external",
  workspaceOpenFolder: "workspace:open-folder",
  folderPick: "folder:pick",
  readingSettingsRead: "reading-settings:read",
  resumePrepare: "resume:prepare",
  resumeSettingsRead: "resume-settings:read",
  resumeSettingsWrite: "resume-settings:write",
  resumeBridgeRevert: "resume:bridge:revert",
  claudeSettingsRead: "claude-settings:read",
  claudeSettingsWrite: "claude-settings:write",
  readingSettingsWrite: "reading-settings:write",
  readingSettingsReadSync: "reading-settings:read-sync",
  instanceLabelReadSync: "instance-label:read-sync",
  readingSystemModeChanged: "reading-settings:system-mode-changed",
  settingsOpen: "settings:open",
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
  /** Claude only: start the session with Remote Control on (spawn `--remote-control`). */
  remoteControl?: boolean;
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
  /**
   * The provider session was natively resumed (claude --resume /
   * codex resume) — the agent's memory continues. False on a fresh
   * spawn, including the fallback when the provider session is gone.
   */
  resumedProviderSession?: boolean;
}

export interface OpenTaskRequest {
  taskId?: TaskId;
  cwd?: string;
  sandbox?: CodexSandboxMode;
  approval?: CodexApprovalMode;
  permissionMode?: ClaudePermissionMode;
  /** Claude only: resume the session with Remote Control on (spawn `--remote-control`). */
  remoteControl?: boolean;
  /**
   * Natively resume the provider session when its file still exists
   * (default). Pass false to force a fresh provider session.
   */
  resume?: boolean;
  /**
   * How to resume a large dormant Claude session. "summary" auto-runs
   * /compact as the first delivery (the panel's option 1, made explicit);
   * absent/"full" resumes as-is — the native no-decision semantic. The
   * resume interstitial itself is suppressed per-spawn either way.
   */
  resumeMode?: "full" | "summary";
  rows?: number;
  cols?: number;
}

export interface PrepareResumeRequest {
  taskId: TaskId;
}

export interface PrepareResumeResponse {
  /** True ⇒ policy is "ask" and the session crosses the cost thresholds —
   *  the renderer shows the inline choice before any spawn. */
  needsChoice: boolean;
  policy: ResumePolicyId;
  overThreshold: boolean;
  /** ms since the transcript's last timestamped entry; null if unknown. */
  idleMs: number | null;
  /** Last usage-line token total (the panel's own estimate); null if unknown. */
  totalTokens: number | null;
  /** Claude's own resume warning is globally off (the temporary bridge). */
  bridgeDismissed: boolean;
}

export interface ResumeSettingsResponse {
  settings: ResumeSettings;
  bridgeDismissed: boolean;
}

export interface RevertResumeBridgeResponse {
  cleared: boolean;
}

export type OpenTaskResponse = CreateTaskResponse;

export interface CloseTaskRequest {
  taskId: TaskId;
}

export type ListTasksResponse = Task[];

export interface RenameSessionRequest {
  taskId: TaskId;
  title: string;
}

export interface ArchiveSessionRequest {
  taskId: TaskId;
  archived: boolean;
}

export interface DeleteSessionRequest {
  taskId: TaskId;
}

export interface RevealSessionRequest {
  taskId: TaskId;
}

export interface RenameProjectRequest {
  path: string;
  displayName: string | null;
}

export interface ArchiveProjectRequest {
  path: string;
  archived: boolean;
}

export interface RevealProjectRequest {
  path: string;
}

export interface SubmitPromptRequest {
  taskId: TaskId;
  text: string;
  attachments?: DeliveryAttachment[];
}

export interface CreateAttachmentRequest {
  taskId: TaskId;
  originalName: string;
  mediaType: string;
  bytes: ArrayBuffer;
}

/** Reference user paths by absolute path (no copy). taskId-independent — works
 *  in a new chat before a session exists. */
export interface CreateReferenceRequest {
  paths: string[];
}

export interface ApprovalDecisionRequest {
  taskId: TaskId;
  decision: ApprovalDecision;
  /** Set for a hook-broker card (S2) — the reply is written to this id instead
   *  of replaying native keys. Absent ⇒ the scrape/keys path. */
  approvalId?: string | null;
}

export interface OptionPromptAnswerRequest {
  taskId: TaskId;
  /** The pending prompt's `tool_use_id` — guards against answering a stale card. */
  toolUseId: string;
  /** Single-select: the chosen option index per question, in question order. */
  optionIndices: number[];
}

export interface RemoteControlInjectRequest {
  taskId: TaskId;
}

/** Result of injecting `/remote-control`. `panel-open` means an approval
 *  panel would have swallowed the command, so nothing was sent. */
export type RemoteControlInjectResponse =
  | { ok: true }
  | { ok: false; reason: "no-process" | "panel-open" | "busy" };

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

export interface TerminalUserInputRequest {
  taskId: TaskId;
  data: string;
}

export interface TerminalReplayRequest {
  taskId: TaskId;
}

/**
 * A snapshot of a task's terminal, produced by the main-process headless
 * mirror. `data` is a SerializeAddon string (text + SGR/cursor as escape
 * sequences); a reopening terminal window writes it into a fresh xterm sized to
 * {cols, rows} BEFORE calling open(), then tails live output. Null when the
 * task has no live terminal to replay.
 */
export interface TerminalReplaySnapshot {
  data: string;
  cols: number;
  rows: number;
  /** Number of live `pty:data` chunks the mirror had ingested when `data` was
   *  serialized (== the seq of the first chunk NOT yet in `data`). A hydrating
   *  renderer writes a buffered live chunk iff its seq >= this value — exactly
   *  the tail the snapshot doesn't already contain. */
  seq: number;
}

export interface OpenTerminalLinkRequest {
  url: string;
}

export interface OpenTerminalLinkResponse {
  // false when the URL's scheme is not on the allowlist — the renderer can then
  // surface a quiet "blocked" hint instead of silently doing nothing.
  opened: boolean;
}

export interface ClipboardReadTextResponse {
  text: string;
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

export interface ReadUsageRequest {
  taskId: TaskId;
}

export type ReadUsageResponse = UsageSnapshot | null;

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

/**
 * The live open/closed state of the terminal satellite window, broadcast to
 * every window so the main-window toggle button's label tracks reality
 * (OS-close and the toggle both update it). This is the runtime signal derived
 * from the actual window; the persisted preference lives in
 * terminal-window-settings.json.
 */
export interface TerminalWindowState {
  open: boolean;
}

/**
 * Which task the terminal window should show, and whether it has a live PTY
 * (so the window knows whether to forward keystrokes). Owned by the main
 * window — the selected-task concept is its UI state — and relayed to the
 * terminal window through the main process.
 */
export interface TerminalActiveTaskState {
  taskId: TaskId | null;
  live: boolean;
  /** Every open task's id. The terminal window keeps a live xterm per task for
   *  instant switching and disposes any whose task has closed. */
  openTaskIds: TaskId[];
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
  readSessionIndex(request?: ReadSessionIndexRequest): Promise<SessionIndexResponse>;
  readSession(request: ReadSessionSnapshotRequest): Promise<SessionSnapshotResponse>;
  renameSession(request: RenameSessionRequest): Promise<void>;
  archiveSession(request: ArchiveSessionRequest): Promise<void>;
  deleteSession(request: DeleteSessionRequest): Promise<void>;
  revealSession(request: RevealSessionRequest): Promise<void>;
  renameProject(request: RenameProjectRequest): Promise<void>;
  archiveProject(request: ArchiveProjectRequest): Promise<void>;
  revealProject(request: RevealProjectRequest): Promise<void>;
  submitPrompt(request: SubmitPromptRequest): Promise<void>;
  createAttachment(request: CreateAttachmentRequest): Promise<DeliveryAttachment>;
  createReference(request: CreateReferenceRequest): Promise<ReferenceResult[]>;
  /** Native file/folder picker (Add button); returns chosen absolute paths. */
  pickReferences(): Promise<string[]>;
  /** Electron's replacement for File.path — the absolute path of a dragged/pasted
   *  File, or "" for a path-less clipboard bitmap. Synchronous. */
  getPathForFile(file: File): string;
  decideApproval(request: ApprovalDecisionRequest): Promise<void>;
  answerOptionPrompt(request: OptionPromptAnswerRequest): Promise<void>;
  stopRun(request: StopRunRequest): Promise<void>;
  resizeTerminal(request: ResizeTerminalRequest): Promise<void>;
  writeTerminalUserInput(request: TerminalUserInputRequest): Promise<void>;
  replayTerminal(request: TerminalReplayRequest): Promise<TerminalReplaySnapshot | null>;
  openTerminalLink(request: OpenTerminalLinkRequest): Promise<OpenTerminalLinkResponse>;
  readClipboardText(): Promise<ClipboardReadTextResponse>;
  readReport(request: ReadReportRequest): Promise<RuntimeReportV1 | null>;
  readTranscript(request: ReadTranscriptRequest): Promise<ReadTranscriptResponse>;
  readUsage(request: ReadUsageRequest): Promise<ReadUsageResponse>;
  readSlashCommands(request: ReadSlashCommandsRequest): Promise<SlashCommandsResponse>;
  injectRemoteControl(
    request: RemoteControlInjectRequest,
  ): Promise<RemoteControlInjectResponse>;
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
  setTerminalWindowOpen(open: boolean): Promise<TerminalWindowState>;
  readTerminalWindowState(): Promise<TerminalWindowState>;
  onTerminalWindowState(callback: (state: TerminalWindowState) => void): () => void;
  readTerminalWindowSettings(): Promise<TerminalWindowSettings>;
  writeTerminalWindowSettings(settings: TerminalWindowSettings): Promise<TerminalWindowSettings>;
  setActiveTerminalTask(state: TerminalActiveTaskState): Promise<void>;
  readActiveTerminalTask(): Promise<TerminalActiveTaskState>;
  onActiveTerminalTask(callback: (state: TerminalActiveTaskState) => void): () => void;
  readWorkspaceTree(request: WorkspaceTreeRequest): Promise<WorkspaceTreeEntry[]>;
  readWorkspaceFile(request: WorkspaceFileReadRequest): Promise<WorkspaceFilePreviewResponse>;
  openWorkspaceExternal(request: WorkspaceOpenExternalRequest): Promise<WorkspaceOpenExternalResponse>;
  openWorkspaceFolder(request: WorkspaceOpenFolderRequest): Promise<void>;
  pickFolder(): Promise<FolderPickResponse>;
  readReadingSettings(): Promise<ReadingSettings>;
  writeReadingSettings(settings: ReadingSettings): Promise<ReadingSettings>;
  prepareResume(request: PrepareResumeRequest): Promise<PrepareResumeResponse>;
  readResumeSettings(): Promise<ResumeSettingsResponse>;
  writeResumeSettings(settings: ResumeSettings): Promise<ResumeSettings>;
  revertResumeBridge(): Promise<RevertResumeBridgeResponse>;
  readClaudeSettings(): Promise<ClaudeSettings>;
  writeClaudeSettings(settings: ClaudeSettings): Promise<ClaudeSettings>;
  onReadingSystemModeChanged(callback: (mode: ResolvedReadingMode) => void): () => void;
  /** The app menu's "Settings…" (⌘,) asks the main window to open the page. */
  onSettingsOpen(callback: () => void): () => void;
  onInspectorState(callback: (state: InspectorWindowState) => void): () => void;
  onRuntimeEvent(callback: (event: RuntimeEvent) => void): () => void;
}

export interface RuntimeReportUpdatePayload {
  summary: RuntimeReportSummaryV1;
}
