import type {
  ApprovalDecision,
  ClaudePermissionMode,
  CodexPermissionMode,
  DeliveryAttachment,
  ReferenceResult,
  LaunchSpeedMode,
  ReasoningEffort,
  RuntimeProvider,
  Task,
  TaskId,
} from "./domain";
import type { TagDefinition, TagGroup } from "./tags";
import type { RuntimeEvent } from "./events";
import type { ReadingSettings, ResolvedReadingMode } from "./reading-settings";
import type { TerminalWindowSettings } from "./terminal-window-settings";
import type { ResumePolicyId, ResumeSettings } from "./resume-settings";
import type { ClaudeSettings } from "./claude-settings";
import type { CodexSettings } from "./codex-settings";
import type { SonataSettings } from "./sonata-settings";
import type {
  ReadSessionIndexRequest,
  ReadSessionSnapshotRequest,
  SessionIndexResponse,
  SessionSnapshotResponse,
} from "./sessions";
import type { OptionPromptSelection } from "./option-prompt";
import type { ReadSlashCommandsRequest, SlashCommandsResponse } from "./slash";
import type { TranscriptBlock, TranscriptSourceRef } from "./transcript";
import type { UpdaterState } from "./updater";
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
  sessionSetTags: "session:setTags",
  sessionDelete: "session:delete",
  sessionReveal: "session:reveal",
  tagsList: "tags:list",
  tagsCreate: "tags:create",
  tagsDelete: "tags:delete",
  projectRename: "project:rename",
  projectArchive: "project:archive",
  projectReveal: "project:reveal",
  promptSubmit: "prompt:submit",
  attachmentCreate: "attachment:create",
  attachmentCreateReference: "attachment:create-reference",
  attachmentPick: "attachment:pick",
  approvalDecide: "approval:decide",
  optionPromptAnswer: "option-prompt:answer",
  optionPromptDismiss: "option-prompt:dismiss",
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
  claudeControlSwitch: "claude-control:switch",
  // Staged claude model+effort Save (S7 Part 1): apply the changed axes as ONE
  // logical switch (`/model X` then `/effort Y`, the cache-miss drawer relaying
  // any confirm between them). Codex staged Save reuses claudeControlSwitch's
  // `codex-model` kind (its two-level picker already sets the pair in one run).
  claudeStagedSwitch: "claude-control:staged",
  // Answer a PARKED recognized-confirm dialog (S7 Part 2): relay the user's chosen
  // row back to the choreography, which navigates+Enters it. The ONLY answer
  // channel for a parked dialog (a drawer dismiss maps to the Cancel row).
  controlConfirmAnswer: "control-confirm:answer",
  // Preview window (2026-07 redesign, three-truths model §6). `previewOpen`
  // opens/focuses the window and binds a task (optionally opening a tab);
  // `previewBinding` is main's push of the bound task's session; the transition
  // channels are the renderer's named mutations of session truth.
  previewOpen: "preview:open",
  previewBinding: "preview:binding",
  previewBindingRead: "preview:binding:read",
  previewClose: "preview:close",
  previewActivate: "preview:activate",
  previewReorder: "preview:reorder",
  previewSetScroll: "preview:set-scroll",
  previewSetPanel: "preview:set-panel",
  terminalWindowSetOpen: "terminal-window:set-open",
  terminalWindowStateRead: "terminal-window:state:read",
  terminalWindowState: "terminal-window:state",
  terminalWindowSettingsRead: "terminal-window:settings:read",
  terminalWindowSettingsWrite: "terminal-window:settings:write",
  terminalActiveTaskSet: "terminal-active-task:set",
  terminalActiveTaskRead: "terminal-active-task:read",
  terminalActiveTask: "terminal-active-task",
  cliActionRequest: "cli-action:request",
  cliAction: "cli-action",
  // WorkspaceFiles seam (§6.1): classified single-file read, one-level dir read,
  // stat, and the batched chip-mention resolver — the renderer never sniffs
  // bytes, classification and existence resolution run in main.
  workspaceReadDoc: "workspace:read-doc",
  workspaceReadDir: "workspace:read-dir",
  workspaceStat: "workspace:stat",
  workspaceResolvePaths: "workspace:resolve-paths",
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
  codexSettingsRead: "codex-settings:read",
  codexSettingsWrite: "codex-settings:write",
  sonataSettingsRead: "sonata-settings:read",
  sonataSettingsWrite: "sonata-settings:write",
  readingSettingsWrite: "reading-settings:write",
  readingSettingsReadSync: "reading-settings:read-sync",
  instanceLabelReadSync: "instance-label:read-sync",
  readingSystemModeChanged: "reading-settings:system-mode-changed",
  // Full reading-settings push (theme/mode/textStep) so satellites that follow
  // the reading appearance (Preview) re-stamp when the user changes it (R6). The
  // system-mode channel above only covers the auto→light/dark flip.
  readingSettingsChanged: "reading-settings:changed",
  settingsOpen: "settings:open",
  notificationActivateTask: "notification:activate-task",
  runtimeEvent: "runtime:event",
  // Auto-update (S1). `updaterState` is main's push of the renderer-facing state
  // (nothing-actionable vs staged) to every window on each meaningful change;
  // `updaterStateRead` hydrates a late-created window; `updaterRestart` requests
  // install-on-restart (acts only when an update is staged).
  updaterState: "updater:state",
  updaterStateRead: "updater:state:read",
  updaterRestart: "updater:restart",
} as const;

export interface CreateTaskRequest {
  title?: string;
  provider: RuntimeProvider;
  cwd?: string;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  speedMode?: LaunchSpeedMode | null;
  /** Codex only: the launch permission preset. Absent → the main process fills
   *  it from the Codex default (Settings → Codex). */
  codexPermissionMode?: CodexPermissionMode;
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
  /** Codex only: override the launch permission preset for this reopen. Absent
   *  → the persisted task's mode carries over. */
  codexPermissionMode?: CodexPermissionMode;
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

export interface RenameSessionResponse {
  task: Task;
}

export interface ArchiveSessionRequest {
  taskId: TaskId;
  archived: boolean;
}

export interface SetSessionTagsRequest {
  taskId: TaskId;
  tagIds: string[];
}

export interface CreateTagRequest {
  label: string;
  group: TagGroup;
}

export interface DeleteTagRequest {
  id: string;
}

export type ListTagsResponse = TagDefinition[];
export type CreateTagResponse = TagDefinition;

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

export interface RenameProjectResponse {
  path: string;
  /** Canonical persisted override; null means use the folder basename. */
  displayName: string | null;
  /** Canonical display value for immediate renderer synchronization. */
  name: string;
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
  /** One selection per question, in question order (drawer S1: single-select,
   *  multi-select, and free-text all travel through this shape). */
  selections: OptionPromptSelection[];
}

export interface OptionPromptDismissRequest {
  taskId: TaskId;
  /** The pending prompt's `tool_use_id` — guards against dismissing a stale card. */
  toolUseId: string;
}

export interface RemoteControlInjectRequest {
  taskId: TaskId;
}

/** Result of injecting `/remote-control`. `panel-open` means an approval
 *  panel would have swallowed the command, so nothing was sent. */
export type RemoteControlInjectResponse =
  | { ok: true }
  | { ok: false; reason: "no-process" | "panel-open" | "busy" };

/** Which axis a mid-session switch drives. Claude: `/model <id>` / `/effort
 *  <level>` typed-command injection (S1), or `permission` via the Shift+Tab
 *  stepping engine (S2). Codex: `codex-permission` via the `/permissions` picker
 *  choreography (S3 — a three-row text-matched picker, arrows + Enter, receipt
 *  watch), and `codex-model` / `codex-effort` via the `/model` TWO-level picker
 *  choreography (S4 — level 1 = curated model rows, level 2 = reasoning rows,
 *  both text-matched; the non-selected dimension is preserved by landing on the
 *  level's `(current)`-marked row). The kind is provider-gated at both layers:
 *  the three `codex-*` kinds reach only a codex session; `model`/`effort`/
 *  `permission` only a claude session. (The `Claude` prefix in the type/method
 *  names predates S3 — one shared switch pipeline now carries both providers;
 *  not a parallel system. Renaming is deferred to S5.) */
export type ClaudeControlSwitchKind =
  | "model"
  | "effort"
  | "permission"
  | "codex-permission"
  | "codex-model"
  | "codex-effort";

export interface ClaudeControlSwitchRequest {
  taskId: TaskId;
  kind: ClaudeControlSwitchKind;
  /** model/effort: the `/model` alias (e.g. `sonnet`) or `/effort` level (e.g.
   *  `high`) to inject. permission: the TARGET `ClaudePermissionMode` id (e.g.
   *  `plan`). codex-permission: the TARGET `CodexPermissionMode` id (e.g.
   *  `approve-for-me`). codex-model: the TARGET curated model slug (e.g.
   *  `gpt-5.6-luna`) — the picker's level-1 target. codex-effort: the TARGET
   *  reasoning id (`low|medium|high|xhigh`) — the picker's level-2 target.
   *  Sourced from Sonata's curated lists / the session's reachable modes, never
   *  free text. */
  value: string;
  /** The session's current value for the axis, per kind:
   *   - permission / codex-permission: the mode the session is in NOW
   *     (`task.permissionMode` / `task.codexPermissionMode`). Claude uses it as the
   *     Shift+Tab return-home anchor; codex uses it to skip a no-op switch.
   *   - **codex-model: REQUIRED — the session's current reasoning effort**
   *     (`task.reasoningEffort`). This is the ONLY source of the effort to PRESERVE
   *     at picker level 2: MEASURED that codex drops the level-2 `(current)` marker
   *     after a model change (it resets to the new model's default), so the effort
   *     cannot ride that marker — the engine navigates level 2 to this explicit
   *     value's row. Omitting it (or a non-v1 effort — Native Default / Max / Ultra,
   *     which has no v1 row) makes the switch roll back to needs-attention BY
   *     DESIGN. A contract refactor MUST keep threading it or every codex model
   *     switch 100%-rolls-back.
   *   - model / effort / codex-effort: ignored. (codex-effort preserves the model
   *     via level-1's `(current)` marker, which IS reliable — the model is
   *     unchanged, so it is still a marked, visible row.) */
  from?: string;
}

/** Result of KICKING OFF a mid-session Claude control switch — the receipt(s)
 *  themselves arrive later on the `control-switch:state` event stream, never
 *  here. `wrong-provider` guards the provider seam both ways (a claude kind on a
 *  codex session — inline `/model` args burn a turn, codex has no Shift+Tab
 *  cycle — AND a `codex-permission` kind on a claude session); `not-idle` = a
 *  turn is live (switching
 *  is idle-only, no queueing); `busy` = a Sonata write (or a prior switch) is
 *  still in flight; `panel-open` = an approval screen would swallow the input;
 *  `invalid` = the caller passed a value the engine can't act on (a non-mode /
 *  non-target id, or an empty staged pair) — a caller bug, not a CLI state (kept
 *  distinct from `busy` so the notice names the real cause). */
export type ClaudeControlSwitchResponse =
  | { ok: true }
  | {
      ok: false;
      reason: "no-process" | "panel-open" | "busy" | "not-idle" | "wrong-provider" | "invalid";
    };

/** A STAGED claude model+effort Save (S7 Part 1). `model` / `effort` carry ONLY
 *  the axes that CHANGED from the session's current pair (null = unchanged); the
 *  engine runs the changed axes as one logical switch (model first, effort queued).
 *  The renderer's Save is disabled when clean, so at least one is non-null. */
export interface ClaudeStagedSwitchRequest {
  taskId: TaskId;
  model: string | null;
  effort: string | null;
}

/** Answer a PARKED recognized-confirm dialog (S7 Part 2). `rowNumber` is the
 *  1-based CLI row the user chose in the drawer (a dismiss maps to the dialog's
 *  Cancel row). Fire-and-forget — the settle arrives on control-switch:state. */
export interface ControlConfirmAnswerRequest {
  taskId: TaskId;
  rowNumber: number;
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
  /** Main-process-monotonic TerminalHost identity. Replay and buffered live
   *  chunks may only be stitched within the newest represented generation. */
  generation: number;
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

/** Open/focus the Preview window and bind a task. A bare `taskId` (the header
 *  Eye button) shows that task's restored tabs or its empty state; a
 *  `relativePath` also opens-or-focuses that tab. */
export interface OpenPreviewRequest {
  taskId: TaskId;
  relativePath?: string;
}

// ── Preview window: three-truths model (§6.0) ────────────────────────────────
// Disk truth is observed (WorkspaceFiles), never stored. Session truth (below)
// is owned by main and durable. View truth (dirty set, tree expansion, filter)
// lives only in the renderer and never crosses this IPC.

/** A tab is a CLAIM on a disk path within one task — not a copy of disk state.
 *  Ordered in the strip; keyed by `path` within the bound task's session. */
export interface PreviewTab {
  path: string;
}

/** Session truth: what the user is reading in ONE task's Preview. No
 *  dirty/reviewed/content/existence fields — those are disk or view truth. */
export interface PreviewSession {
  taskId: TaskId;
  tabs: PreviewTab[];
  activePath: string | null;
  /** path → reader scrollTop (px), restored on activation and across restart. */
  scroll: Record<string, number>;
  panelOpen: boolean;
}

/** Main's push to the Preview window: the bound task's session plus the sliver
 *  of disk context the chrome needs. A null session ⇒ unbound (no active task) ⇒
 *  the global empty state. */
export interface PreviewBinding {
  taskId: TaskId | null;
  /** Basename of the bound task's workspace cwd — the breadcrumb root label. */
  projectDirName: string | null;
  session: PreviewSession | null;
}

// Named transitions (renderer → main), each on the bound task; a stale taskId
// (a transition that races a rebind) is ignored by main.
export interface PreviewCloseRequest {
  taskId: TaskId;
  path: string;
}
export interface PreviewActivateRequest {
  taskId: TaskId;
  path: string;
}
export interface PreviewReorderRequest {
  taskId: TaskId;
  /** The tabs' paths in their new order. */
  paths: string[];
}
export interface PreviewSetScrollRequest {
  taskId: TaskId;
  path: string;
  scroll: number;
}
export interface PreviewSetPanelRequest {
  taskId: TaskId;
  open: boolean;
}

// ── WorkspaceFiles seam (§6.1) ───────────────────────────────────────────────

/** Document classification runs in MAIN (the renderer never sniffs bytes). The
 *  ladder: absent → empty → binary (NUL in first 8000B) → too-large → by
 *  extension (markdown/html/image) → text. */
export type PreviewDocumentKind =
  | "markdown"
  | "text"
  | "html"
  | "image"
  | "binary"
  | "too-large"
  | "empty"
  | "absent";

export interface PreviewDocument {
  path: string;
  name: string;
  extension: string;
  size: number;
  kind: PreviewDocumentKind;
  /** text/markdown/html payload (head-sliced when `truncated`). */
  text?: string;
  /** a too-large file was head-sliced to the preview cap. */
  truncated?: boolean;
}

export interface WorkspaceDirEntry {
  path: string;
  name: string;
  type: "file" | "directory";
  /** Dot-prefixed / macOS-hidden — shown de-emphasized, interaction unchanged (R4). */
  hidden: boolean;
}

export interface WorkspaceStatResult {
  exists: boolean;
  isFile: boolean;
  isDirectory: boolean;
  size: number;
}

export interface WorkspaceReadDocRequest {
  taskId: TaskId;
  relativePath: string;
}

/** One-level directory read. Omit `relativePath` (or "") for the workspace root. */
export interface WorkspaceReadDirRequest {
  taskId: TaskId;
  relativePath?: string;
}

/** Batch-resolve path-like inline-code mentions from an assistant reply against
 *  disk truth (S4 transcript chips). Candidates may be workspace-relative or
 *  absolute; the answer returns the workspace-relative paths of the ones that
 *  are real files — an absolute inside the root is relativized, and anything
 *  outside the root, a non-file, or nonexistent is simply omitted. Capped per
 *  call (WorkspaceFiles.resolvePaths) so a chatty reply can't fan out an
 *  unbounded stat storm. */
export interface WorkspaceResolvePathsRequest {
  taskId: TaskId;
  candidates: string[];
}
export interface WorkspaceResolvePathsResult {
  existing: string[];
}

export interface WorkspaceStatRequest {
  taskId: TaskId;
  relativePath: string;
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
  projectName: string;
  sessionTitle: string;
  emptySurface: CliEmptySurface;
}

export type CliEmptySurface =
  | { kind: "none" }
  | {
      kind: "fresh";
      phase: "ready" | "starting";
      disabledReason?: string;
    }
  | {
      kind: "dormant";
      phase: "ready" | "preparing" | "resuming";
      taskId: TaskId;
      disabledReason?: string;
    }
  | { kind: "resume-choice"; taskId: TaskId };

export type CliActionRequest =
  | { action: "start"; expectedTaskId: null }
  | { action: "resume"; expectedTaskId: TaskId };

export function isCliActionRequest(value: unknown): value is CliActionRequest {
  if (!isUnknownRecord(value) || !hasOnlyKeys(value, ["action", "expectedTaskId"])) {
    return false;
  }
  if (value.action === "start") {
    return value.expectedTaskId === null;
  }
  return value.action === "resume" && isNonEmptyString(value.expectedTaskId);
}

export function isTerminalActiveTaskState(value: unknown): value is TerminalActiveTaskState {
  if (
    !isUnknownRecord(value) ||
    !hasOnlyKeys(value, [
      "taskId",
      "live",
      "openTaskIds",
      "projectName",
      "sessionTitle",
      "emptySurface",
    ])
  ) {
    return false;
  }
  if (value.taskId !== null && !isNonEmptyString(value.taskId)) {
    return false;
  }
  if (
    typeof value.live !== "boolean" ||
    !Array.isArray(value.openTaskIds) ||
    !value.openTaskIds.every(isNonEmptyString) ||
    new Set(value.openTaskIds).size !== value.openTaskIds.length ||
    !isNonEmptyString(value.projectName) ||
    !isNonEmptyString(value.sessionTitle) ||
    !isCliEmptySurface(value.emptySurface)
  ) {
    return false;
  }
  if (value.taskId === null) {
    return value.live === false && value.emptySurface.kind === "fresh";
  }
  if (!value.openTaskIds.includes(value.taskId)) {
    return false;
  }
  return value.live
    ? value.emptySurface.kind === "none"
    : (
        (value.emptySurface.kind === "dormant" ||
          value.emptySurface.kind === "resume-choice") &&
        value.emptySurface.taskId === value.taskId
      );
}

function isCliEmptySurface(value: unknown): value is CliEmptySurface {
  if (!isUnknownRecord(value) || typeof value.kind !== "string") {
    return false;
  }
  if (value.kind === "none") {
    return hasOnlyKeys(value, ["kind"]);
  }
  const validDisabledReason =
    value.disabledReason === undefined || typeof value.disabledReason === "string";
  if (value.kind === "fresh") {
    return (
      hasOnlyKeys(value, ["kind", "phase", "disabledReason"]) &&
      (value.phase === "ready" || value.phase === "starting") &&
      validDisabledReason
    );
  }
  if (value.kind === "dormant") {
    return (
      hasOnlyKeys(value, ["kind", "phase", "taskId", "disabledReason"]) &&
      (value.phase === "ready" || value.phase === "preparing" || value.phase === "resuming") &&
      isNonEmptyString(value.taskId) &&
      validDisabledReason
    );
  }
  return (
    value.kind === "resume-choice" &&
    hasOnlyKeys(value, ["kind", "taskId"]) &&
    isNonEmptyString(value.taskId)
  );
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
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

export interface SonataRuntimeBridge {
  createTask(request: CreateTaskRequest): Promise<CreateTaskResponse>;
  openTask(request: OpenTaskRequest): Promise<OpenTaskResponse>;
  closeTask(request: CloseTaskRequest): Promise<void>;
  listTasks(): Promise<ListTasksResponse>;
  readSessionIndex(request?: ReadSessionIndexRequest): Promise<SessionIndexResponse>;
  readSession(request: ReadSessionSnapshotRequest): Promise<SessionSnapshotResponse>;
  renameSession(request: RenameSessionRequest): Promise<RenameSessionResponse>;
  archiveSession(request: ArchiveSessionRequest): Promise<void>;
  setSessionTags(request: SetSessionTagsRequest): Promise<void>;
  deleteSession(request: DeleteSessionRequest): Promise<void>;
  revealSession(request: RevealSessionRequest): Promise<void>;
  listTags(): Promise<ListTagsResponse>;
  createTag(request: CreateTagRequest): Promise<CreateTagResponse>;
  deleteTag(request: DeleteTagRequest): Promise<void>;
  renameProject(request: RenameProjectRequest): Promise<RenameProjectResponse>;
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
  /** Dismiss the pending option prompt ("Chat about this") — declines every
   *  question; the user's next composer message flows as normal steering. */
  dismissOptionPrompt(request: OptionPromptDismissRequest): Promise<void>;
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
  /** Kick off a mid-session Claude `/model` / `/effort` / `permission` switch.
   *  Resolves once the drive is on its way; the receipt(s) (settled / failed /
   *  needs-attention) arrive asynchronously on the `control-switch:state`
   *  event. */
  switchClaudeControl(
    request: ClaudeControlSwitchRequest,
  ): Promise<ClaudeControlSwitchResponse>;
  /** Apply a STAGED claude model+effort Save (S7 Part 1) as one logical switch —
   *  only the changed axes, the cache-miss drawer relaying any confirm between the
   *  two commands. Codex staged Save reuses `switchClaudeControl` with `codex-model`. */
  switchClaudeStaged(
    request: ClaudeStagedSwitchRequest,
  ): Promise<ClaudeControlSwitchResponse>;
  /** Answer a PARKED recognized-confirm dialog (S7 Part 2) — relay the user's
   *  chosen row to the choreography (navigate+Enter). Fire-and-forget. */
  answerControlConfirm(request: ControlConfirmAnswerRequest): Promise<void>;
  // Preview window (three-truths model §6). `openPreview` opens/focuses + binds
  // (+ optional tab); the transition methods mutate session truth in main, which
  // echoes the updated binding back through `onPreviewBinding`.
  openPreview(request: OpenPreviewRequest): Promise<void>;
  readPreviewBinding(): Promise<PreviewBinding>;
  closePreviewTab(request: PreviewCloseRequest): Promise<void>;
  activatePreviewTab(request: PreviewActivateRequest): Promise<void>;
  reorderPreviewTabs(request: PreviewReorderRequest): Promise<void>;
  setPreviewScroll(request: PreviewSetScrollRequest): Promise<void>;
  setPreviewPanel(request: PreviewSetPanelRequest): Promise<void>;
  onPreviewBinding(callback: (binding: PreviewBinding) => void): () => void;
  readWorkspaceDoc(request: WorkspaceReadDocRequest): Promise<PreviewDocument>;
  readWorkspaceDir(request: WorkspaceReadDirRequest): Promise<WorkspaceDirEntry[]>;
  statWorkspacePath(request: WorkspaceStatRequest): Promise<WorkspaceStatResult>;
  resolveWorkspacePaths(
    request: WorkspaceResolvePathsRequest,
  ): Promise<WorkspaceResolvePathsResult>;
  setTerminalWindowOpen(open: boolean): Promise<TerminalWindowState>;
  readTerminalWindowState(): Promise<TerminalWindowState>;
  onTerminalWindowState(callback: (state: TerminalWindowState) => void): () => void;
  readTerminalWindowSettings(): Promise<TerminalWindowSettings>;
  writeTerminalWindowSettings(settings: TerminalWindowSettings): Promise<TerminalWindowSettings>;
  setActiveTerminalTask(state: TerminalActiveTaskState): Promise<void>;
  readActiveTerminalTask(): Promise<TerminalActiveTaskState>;
  onActiveTerminalTask(callback: (state: TerminalActiveTaskState) => void): () => void;
  requestCliAction(request: CliActionRequest): Promise<void>;
  onCliAction(callback: (request: CliActionRequest) => void): () => void;
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
  readCodexSettings(): Promise<CodexSettings>;
  writeCodexSettings(settings: CodexSettings): Promise<CodexSettings>;
  readSonataSettings(): Promise<SonataSettings>;
  writeSonataSettings(settings: SonataSettings): Promise<SonataSettings>;
  onReadingSystemModeChanged(callback: (mode: ResolvedReadingMode) => void): () => void;
  /** Full reading-settings push so satellites that follow the reading appearance
   *  (Preview) re-stamp theme/mode/textStep when the user changes it (R6). */
  onReadingSettingsChanged(callback: (settings: ReadingSettings) => void): () => void;
  /** The app menu's "Settings…" (⌘,) asks the main window to open the page. */
  onSettingsOpen(callback: () => void): () => void;
  /** A clicked native notification asks the main window to select its task. */
  onNotificationActivateTask(callback: (taskId: TaskId) => void): () => void;
  onRuntimeEvent(callback: (event: RuntimeEvent) => void): () => void;
  // Auto-update (S1). The subscribe/read pair hydrates the sidebar button (S2):
  // subscribe for live pushes, read once to catch a state set before the window
  // (or its listener) existed. `requestUpdaterRestart` is a no-op unless an
  // update is staged.
  onUpdaterState(callback: (state: UpdaterState) => void): () => void;
  readUpdaterState(): Promise<UpdaterState>;
  requestUpdaterRestart(): Promise<void>;
}

export interface RuntimeReportUpdatePayload {
  summary: RuntimeReportSummaryV1;
}
