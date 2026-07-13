/**
 * The Reading window's view-state model: the one mutable state atom
 * (`RendererState`) with per-task projections (`TaskViewState`), the factories
 * that build them, and the task-view/transcript operations that mutate them.
 *
 * reading-core layer rules: plain data in, plain data out — no DOM, no
 * Electron. The shell (renderer/main.ts) holds the singleton atom and passes
 * it to the ops that need it; mutation-in-place is deliberate (map R1 — the
 * reconcile engine depends on reference-identity semantics: upserts replace
 * changed blocks' refs, unchanged blocks keep theirs).
 */
import type {
  AttachmentKind,
  CliActivity,
  ClaudeDefaultPermissionMode,
  ClaudePermissionMode,
  ClaudeSettings,
  CodexSettings,
  DeliveryAttachment,
  DeliveryTaskState,
  LaunchSpeedMode,
  ReadingSettings,
  ReasoningEffort,
  ResumeSettings,
  RuntimeProvider,
  SessionIndexResponse,
  SlashCommandEntry,
  Task,
  UsageSnapshot,
} from "../shared/types";
import type {
  ApprovalDetectedEvent,
  OptionPromptDetectedEvent,
  TranscriptBlocksEvent,
} from "../shared/types/events";
import type {
  TranscriptBlock,
  TranscriptSourceRef,
} from "../shared/types/transcript";
import type { WorkingStatusState } from "../shared/types/working-status";
import type { RuntimeReportV1 } from "../shared/schemas";
import { cleanTerminalTranscript } from "../shared/terminal-transcript";
import { MAX_TRANSCRIPT_CHARS, MAX_TRANSCRIPT_RAW_CHARS } from "./config";

export interface RunTranscript {
  runId: string;
  rawText: string;
  text: string;
  truncated: boolean;
  receivedChars: number;
}

export interface OptionPromptReceiptLine {
  header: string;
  question: string;
  labels: string[];
}

export interface OptionPromptReceipt {
  toolUseId: string;
  lines: OptionPromptReceiptLine[];
  /** true once reconciled from the provider's own answer (verbatim labels);
   *  false while showing the optimistic local selection. */
  reconciled: boolean;
}

export interface TaskViewState {
  task: Task | null;
  /** A PTY runtime backs this view; dormant views are read-only until resumed. */
  live: boolean;
  report: RuntimeReportV1 | null;
  /** Unsent composer text, parked here while another session owns the DOM
   *  textarea (the attachments counterpart is pendingAttachments). */
  composerDraft: string;
  pendingApproval: ApprovalDetectedEvent["payload"] | null;
  /** A native AskUserQuestion awaiting an in-view answer (Slice 5). */
  pendingOptionPrompt: OptionPromptDetectedEvent["payload"] | null;
  /** In-progress single-select choice per question (option index; -1 = none). */
  optionPromptSelections: number[];
  /** Send-in-flight: keystrokes are being relayed; the card is frozen. */
  optionPromptBusy: boolean;
  /** The answered card frozen into a receipt — optimistic on send, then
   *  reconciled (verbatim labels) from the PostToolUse-driven resolved event. */
  optionPromptReceipt: OptionPromptReceipt | null;
  highlightedRunId: string | null;
  liveTranscriptRunId: string | null;
  runTranscripts: RunTranscript[];
  transcriptBlocks: Map<string, TranscriptBlock>;
  transcriptBlockOrder: string[];
  transcriptSources: TranscriptSourceRef[];
  deliveryState: DeliveryTaskState | null;
  pendingAttachments: ComposerAttachment[];
  usageSnapshot: UsageSnapshot | null;
  workingStatus: WorkingStatusState | null;
  /** Structured CLI activity (Slice 1): hooks-primary busy/idle/approval,
   *  with terminal-host signals as the safety net. Drives the sidebar
   *  indicator (approval now also fires from the PermissionRequest hook). */
  cliState: { activity: CliActivity; tool: string | null; approvalKind: string | null } | null;
  /** Remote Control (phone access) for this task. `active` is optimistic (we
   *  injected `/rc`); `url` is the session link scraped from the stream — the
   *  phone surface is Anthropic's Claude app, not a Duet-built UI. */
  /** `active`/`url`: the LIVE connected state (from `remote-control:state`). For a
   *  DORMANT view, `armedOverride` is the "will start with RC" desire — null =
   *  follow the global default (`state.remoteControlDefault`); true/false = user set. */
  remoteControl: { active: boolean; url: string | null; armedOverride: boolean | null };
  /** The pre-spawn resume moment is waiting for the user's choice. */
  resumeChoice: { idleMs: number | null; totalTokens: number | null; bridgeDismissed: boolean } | null;
  /** Attention banners (S5) — passive "in the Terminal" pointers. A dispatched
   *  slash command settled (its panel, if any, lives in the terminal); an
   *  approval card expired to the native panel. Display-only state: set/cleared
   *  from runtime events, never drives delivery or runs. */
  slashAttention: { runId: string; command: string } | null;
  approvalExpiredAttention: boolean;
  status: string;
  unread: boolean;
  /** A run finished while this session was not the focused view. */
  completedUnseen: boolean;
}

/** Plain snapshot of an element's viewport rect. The state model must stay
 *  DOM-type-free (reading-core purity, map §2.2); getBoundingClientRect already
 *  returns a static snapshot, so a plain field copy is semantically identical. */
export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** Captures an AnchorRect from anything that reports its viewport rect (an
 *  Element at runtime — typed structurally so this module never names a DOM
 *  type; the shell passes HTMLElements). */
export function anchorRectOf(element: {
  getBoundingClientRect(): {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  };
}): AnchorRect {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

/** Sidebar organization preferences. View state — persisted per machine. */
export interface SidebarPrefs {
  status: "active" | "archived" | "all";
  /** providerCwd of the focused project, or null for all. */
  project: string | null;
  activity: "1d" | "3d" | "7d" | "30d" | "all";
  groupBy: "project" | "date" | "none";
  sortBy: "recency" | "created" | "alphabetical";
}

export const SIDEBAR_PREFS_DEFAULTS: SidebarPrefs = {
  status: "active",
  project: null,
  activity: "all",
  groupBy: "project",
  sortBy: "recency",
};

export const SIDEBAR_INITIAL_VISIBLE_COUNT = 5;
export const SIDEBAR_DISCLOSURE_INCREMENT = 10;

export type SidebarDisclosureGroupKey =
  | `project:${string}`
  | "chats"
  | "date:today"
  | "date:yesterday"
  | "date:this-week"
  | "date:older"
  | "flat"
  | `focused:${string}`;

/** Ephemeral progressive-disclosure intent. Missing group keys mean the
 *  initial five. Stored limits deliberately remain unclamped so a user's
 *  expansion survives background insert/delete/reorder. */
export interface SidebarDisclosureState {
  visibleProjectLimit: number;
  groupVisibleLimits: Map<SidebarDisclosureGroupKey, number>;
}

export type SidebarMenuState =
  | { kind: "session"; taskId: string; title: string; archived: boolean; anchor: AnchorRect }
  | { kind: "project"; path: string; name: string; archived: boolean; anchor: AnchorRect }
  | { kind: "filter"; anchor: AnchorRect; openSection: FilterMenuSection | null };

export type FilterMenuSection = "status" | "project" | "activity" | "group" | "sort";

/** The sidebar UI cluster (map C3b): the open menu (session / project /
 *  filter), in-flight renames, and the persisted view prefs. localStorage
 *  load/save for `prefs` and `collapsedProjects` stays in the shell (ports);
 *  the shell hydrates both at boot. */
export interface SidebarState {
  menu: SidebarMenuState | null;
  renamingSessionId: string | null;
  projectRenaming: { path: string; currentName: string } | null;
  prefs: SidebarPrefs;
  collapsedProjects: Set<string>;
  disclosure: SidebarDisclosureState;
}

export interface RendererState {
  taskViews: TaskViewState[];
  activeTaskId: string | null;
  /** The authoritative session record (live runtimes for live sessions,
   *  manifests for dormant ones), read whole from the main process. The
   *  shell's refreshSessionIndex (IPC) writes it; the 150 ms refresh debounce
   *  (T2) stays shell-side. */
  sessionIndex: SessionIndexResponse | null;
  sidebar: SidebarState;
  taskDraft: TaskLaunchDraft;
  /** The user explicitly chose (or cleared) the New Chat folder this session. */
  taskDraftFolderTouched: boolean;
  /** New-chat composer attachments, materialized on first send (see ComposerAttachment). */
  draftAttachments: ComposerAttachment[];
  /** New Chat's parked composer text — a shared DOM textarea must never carry
   *  one owner's words into another. The live-session slot is
   *  TaskViewState.composerDraft; the shell's saveComposerDraft /
   *  restoreComposerDraft park and restore on ownership change. */
  newChatComposerDraft: string;
  composerMenu: ComposerMenuState | null;
  slashPicker: SlashPickerState | null;
  usagePopover: UsagePopoverState | null;
  readingSettings: ReadingSettings;
  readingPopoverOpen: boolean;
  readingPopoverAnchor: PopoverAnchor | null;
  remoteControlPopoverOpen: boolean;
  remoteControlPopoverAnchor: PopoverAnchor | null;
  /** Transient note shown in the RC popover (e.g. why Turn on was refused). */
  remoteControlNote: string | null;
  /** The global "auto-enable Remote Control" default (Claude settings). Seeds
   *  the New Chat draft AND newly-opened dormant sessions so both arm on start. */
  remoteControlDefault: boolean;
  /** The Settings "New Claude sessions start in" default, mirrored at boot and
   *  on Settings save. The New Chat access chip shows this until the user picks
   *  a per-session mode (taskDraft.permissionMode). */
  claudeDefaultPermissionMode: ClaudeDefaultPermissionMode;
  promptNav: PromptNavState | null;
  /** The Settings page (centered overlay) is open; null when closed. */
  settingsOverlay: SettingsOverlayState | null;
  busy: boolean;
  status: string;
}

export interface SettingsOverlayState {
  /** Snapshot read on open; null while the read is in flight. */
  resume: { settings: ResumeSettings; bridgeDismissed: boolean } | null;
  /** Duet-owned Claude launch policy; null while the read is in flight. */
  claude: { settings: ClaudeSettings } | null;
  /** Duet-owned Codex launch policy; null while the read is in flight. */
  codex: { settings: CodexSettings } | null;
  /** The resume-policy popup menu is showing. */
  policyMenuOpen: boolean;
  /** The default-permission-mode popup menu is showing. */
  approvalMenuOpen: boolean;
  /** The default-Codex-approval-mode popup menu is showing. */
  codexApprovalMenuOpen: boolean;
  /** The bridge restore write is in flight. */
  bridgeReverting: boolean;
  /** The last bridge restore failed (~/.claude.json untouched). */
  bridgeError: boolean;
}

export interface PromptNavState {
  taskId: string;
  turnKey: string;
  composerSelectionStart: number;
  composerSelectionEnd: number;
}

export interface ComposerMenuState {
  type: "add";
  anchor: PopoverAnchor;
}

export interface SlashPickerState {
  provider: RuntimeProvider;
  /** Listed entries for this provider; refreshed via IPC when the picker opens. */
  entries: SlashCommandEntry[];
  query: string;
  selectedIndex: number;
}

export interface UsagePopoverState {
  pinned: boolean;
}

export interface PopoverAnchor {
  left: number;
  top: number;
  width: number;
}

/** A composer attachment held until send (lazy). A path-less bitmap is held as a
 *  File and copied (createAttachment) on send; a reference is already a
 *  DeliveryAttachment (createReference, no copy) and passes through. Nothing
 *  touches disk until send — so removing a chip or abandoning the composer
 *  leaves no orphan, and there is no eager-copy cleanup to do. One shape for both
 *  a live task's pending list and the new-chat draft. previewUrl is a thumbnail
 *  (object URL for a bitmap, data URL for a referenced image) or null (icon). */
export interface ComposerAttachment {
  /** Opaque bitmap handle (a DOM `File` at runtime) or null. Typed `unknown`
   *  because the state model must stay DOM-type-free (reading-core purity, map
   *  §2.2): core state = plain data + opaque handles the core never looks
   *  inside. Only shell code (intake, materialize, object-URL lifecycle)
   *  narrows it back to `File`. */
  file: unknown;
  reference: DeliveryAttachment | null;
  previewUrl: string | null;
  name: string;
  kind: AttachmentKind;
}

/** Which draft dropdown is open on the New Chat composer. One menu at a time;
 *  every menu renders as a fixed portal above its chip (#task-settings-popover-root
 *  — position:fixed inside the #run-list scroller gets paint/hit-test clipped). */
export type TaskDraftMenuKind = "launch" | "provider" | "access" | "project";

export interface TaskLaunchDraft {
  provider: RuntimeProvider;
  cwd: string | null;
  menu: { kind: TaskDraftMenuKind; anchor: PopoverAnchor } | null;
  message: TaskEntryMessage | null;
  model: Record<RuntimeProvider, string | null>;
  reasoningEffort: Record<RuntimeProvider, ReasoningEffort | null>;
  speedMode: Record<RuntimeProvider, LaunchSpeedMode | null>;
  /** Claude permission mode for THIS session; null = follow the Settings
   *  default (state.claudeDefaultPermissionMode), so an untouched draft
   *  tracks a Settings change live. Sent with createTask only when set. */
  permissionMode: ClaudePermissionMode | null;
  /** New chat: arm Remote Control so the session spawns with `--remote-control`
   *  (Claude only). The "arm at session start" entry point. */
  remoteControl: boolean;
}

export interface TaskEntryMessage {
  tone: "info" | "error";
  text: string;
}

/** The boot-time state atom. `readingSettings` is a parameter because its
 *  source is a DOM read (the shell's bootReadingSettingsFromDom) — the one
 *  non-plain-data value in the initial state. */
export function createInitialState(readingSettings: ReadingSettings): RendererState {
  return {
    taskViews: [],
    activeTaskId: null,
    sessionIndex: null,
    sidebar: {
      menu: null,
      renamingSessionId: null,
      projectRenaming: null,
      prefs: { ...SIDEBAR_PREFS_DEFAULTS },
      collapsedProjects: new Set(),
      disclosure: {
        visibleProjectLimit: SIDEBAR_INITIAL_VISIBLE_COUNT,
        groupVisibleLimits: new Map(),
      },
    },
    taskDraft: {
      provider: "claude",
      cwd: null,
      menu: null,
      message: null,
      model: {
        codex: "gpt-5.6-sol",
        claude: "opus",
      },
      reasoningEffort: {
        codex: "xhigh",
        claude: "xhigh",
      },
      speedMode: {
        codex: "default",
        claude: null,
      },
      permissionMode: null,
      remoteControl: false,
    },
    taskDraftFolderTouched: false,
    draftAttachments: [],
    newChatComposerDraft: "",
    composerMenu: null,
    slashPicker: null,
    usagePopover: null,
    readingSettings,
    readingPopoverOpen: false,
    readingPopoverAnchor: null,
    remoteControlPopoverOpen: false,
    remoteControlPopoverAnchor: null,
    remoteControlNote: null,
    remoteControlDefault: false,
    claudeDefaultPermissionMode: "default",
    promptNav: null,
    settingsOverlay: null,
    busy: false,
    status: "Idle",
  };
}

export function createTaskView(task: Task, status: string, live = true): TaskViewState {
  const view: TaskViewState = {
    task,
    live,
    report: null,
    composerDraft: "",
    pendingApproval: null,
    pendingOptionPrompt: null,
    optionPromptSelections: [],
    optionPromptBusy: false,
    optionPromptReceipt: null,
    highlightedRunId: null,
    liveTranscriptRunId: null,
    runTranscripts: [],
    transcriptBlocks: new Map(),
    transcriptBlockOrder: [],
    transcriptSources: [],
    // active/url = live connected state; armedOverride = null means a dormant view
    // FOLLOWS the global default (so changing the default applies to it), until the
    // user toggles it. createTask sets active optimistically for a live armed spawn.
    remoteControl: { active: false, url: null, armedOverride: null },
    deliveryState: null,
    pendingAttachments: [],
    usageSnapshot: null,
    workingStatus: null,
    cliState: null,
    resumeChoice: null,
    slashAttention: null,
    approvalExpiredAttention: false,
    status,
    unread: false,
    completedUnseen: false,
  };
  return view;
}

export function upsertTaskView(state: RendererState, view: TaskViewState): void {
  const index = state.taskViews.findIndex((item) => item.task?.id === view.task?.id);
  if (index === -1) {
    state.taskViews = [...state.taskViews, view];
    return;
  }
  state.taskViews = state.taskViews.map((item, itemIndex) => (itemIndex === index ? view : item));
}

export function taskViewForId(state: RendererState, taskId: string): TaskViewState | null {
  return state.taskViews.find((view) => view.task?.id === taskId) ?? null;
}

/** The active task's view, or null in a New Chat. THE view-module state read
 *  (D-early ruling 1): views hold an init-bound state reference and call this
 *  helper — reads are a view's job; routing them through the actions seam
 *  would mislabel them as behaviors. */
export function activeTaskView(state: RendererState): TaskViewState | null {
  if (!state.activeTaskId) {
    return null;
  }
  return taskViewForId(state, state.activeTaskId);
}

export function applyTranscriptUpserts(
  view: TaskViewState,
  payload: TranscriptBlocksEvent["payload"],
): void {
  if (payload.reset) {
    for (const [id, block] of view.transcriptBlocks) {
      if (block.sourceId === payload.sourceId) {
        view.transcriptBlocks.delete(id);
      }
    }
    view.transcriptBlockOrder = view.transcriptBlockOrder.filter((id) =>
      view.transcriptBlocks.has(id),
    );
  }

  for (const block of payload.upserts) {
    if (!view.transcriptBlocks.has(block.id)) {
      view.transcriptBlockOrder.push(block.id);
    }
    view.transcriptBlocks.set(block.id, block);
  }
}

/** Returns whether the cleaned transcript now has visible text — the caller's
 *  render-scheduling condition (map §1.3 pty:data row: schedule the debounced
 *  transcript render only if the cleaned text is non-empty; the schedule call
 *  itself is the shell's, and becomes a directive at C2). */
export function appendLiveTranscript(view: TaskViewState, data: string): boolean {
  if (!view.liveTranscriptRunId) {
    return false;
  }

  const transcript = ensureRunTranscript(view, view.liveTranscriptRunId);
  transcript.receivedChars += data.length;
  const nextRawText = `${transcript.rawText}${data}`;
  transcript.truncated = transcript.truncated || nextRawText.length > MAX_TRANSCRIPT_RAW_CHARS;
  transcript.rawText = nextRawText.slice(-MAX_TRANSCRIPT_RAW_CHARS);

  const text = cleanTerminalTranscript(transcript.rawText, view.task?.provider);
  transcript.truncated = transcript.truncated || text.length > MAX_TRANSCRIPT_CHARS;
  transcript.text = text.slice(-MAX_TRANSCRIPT_CHARS);

  if (!transcript.text.trim()) {
    return false;
  }
  return true;
}

export function ensureRunTranscript(view: TaskViewState, runId: string): RunTranscript {
  let transcript = view.runTranscripts.find((item) => item.runId === runId);
  if (!transcript) {
    transcript = {
      runId,
      rawText: "",
      text: "",
      truncated: false,
      receivedChars: 0,
    };
    view.runTranscripts = [...view.runTranscripts, transcript];
  }
  return transcript;
}
