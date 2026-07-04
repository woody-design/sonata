import {
  Check,
  ChevronDown,
  Copy,
  Ellipsis,
  Eye,
  PanelLeft,
  SearchCode,
  Smartphone,
  SquarePen,
  X,
} from "lucide";
import "./styles.css";
import {
  CLAUDE_DEFAULT_PERMISSION_MODE_OPTIONS,
  READING_MODE_IDS,
  READING_TEXT_STEPS,
  READING_THEME_IDS,
  RESUME_POLICY_IDS,
  RESUME_PROMPT_MIN_IDLE_MS,
  RESUME_PROMPT_MIN_TOKENS,
  isReadingTextStep,
  normalizeClaudeSettings,
  normalizeReadingSettings,
  normalizeResumeSettings,
  type ClaudeDefaultPermissionMode,
  type ClaudeSettings,
  type ReadingModeSetting,
  type ReadingSettings,
  type ReadingThemeId,
  type ResolvedReadingMode,
  type ResumePolicyId,
  type ResumeSettings,
} from "../shared/types";
import type {
  ApprovalDecision,
  CliActivity,
  AttachmentKind,
  DeliveryAttachment,
  ReferenceResult,
  DeliveryQueueItem,
  DeliveryTaskState,
  LaunchSpeedMode,
  ReasoningEffort,
  RuntimeProvider,
  SlashCommandEntry,
  SlashCommandsResponse,
} from "../shared/types";
import type {
  ApprovalDetectedEvent,
  OptionPromptDetectedEvent,
  TranscriptBlocksEvent,
} from "../shared/types/events";
import type {
  FocusArtifactInMainRequest,
  TerminalWindowState,
} from "../shared/types/ipc";
import type { WorkingStatusState } from "../shared/types/working-status";
import { classifySlashIntent } from "../shared/slash/intent";
import {
  clamp,
  condensedPromptText,
  errorMessage,
  fileExtension,
  formatIdleDuration,
  formatLiveElapsed,
  formatTokenCount,
  permissionModeLabel,
  providerLabel,
  readingModeLabel,
  readingThemeLabel,
  resumePolicyLabel,
  settingsDateLabel,
} from "../reading-core/selectors/formatters";
import {
  filteredSlashItems,
  optimisticReceiptLines,
} from "../reading-core/selectors/composer";
import {
  dormantArmed,
  hasActiveRun,
  remoteControlContext,
  remoteControlOn,
} from "../reading-core/selectors/runs";
import {
  SIDEBAR_PREFS_DEFAULTS,
  activeTaskView as activeTaskViewOf,
  createInitialState,
  createTaskView,
  taskViewForId,
  upsertTaskView,
  type ComposerAttachment,
  type ComposerMenuState,
  type PopoverAnchor,
  type PromptNavState,
  type RendererState,
  type SettingsOverlayState,
  type SidebarPrefs,
  type SlashPickerState,
  type TaskViewState,
} from "../reading-core/state";
import { reduceRuntimeEvent } from "../reading-core/runtime-reducer";
import type { Directive } from "../reading-core/directives";
import * as composerTransitions from "../reading-core/transitions/composer";
import * as popoverTransitions from "../reading-core/transitions/popovers";
import * as sessionTransitions from "../reading-core/transitions/session";
import * as sidebarTransitions from "../reading-core/transitions/sidebar";
import { initActions, type ViewMode } from "./actions";
import { elements, initDom } from "./dom";
import { initInvalidate } from "./invalidate";
import {
  initApprovalsView,
  renderApproval,
  renderOptionPrompt,
  renderResumeChoice,
} from "./view/approvals";
import { initBannersView, renderAttentionBanners } from "./view/banners";
import {
  initComposerView,
  renderAttachmentStrip,
  renderComposerControls,
  renderComposerPopover,
  renderUsageIndicator,
} from "./view/composer";
import { initEntryView, renderTaskEntryPanel, renderTaskSettingsPopover } from "./view/entry";
import { lucideIcon } from "./view/icons";
import { positionPopoverElement } from "./view/popover-geometry";
import {
  closeSidebarMenu,
  initSidebarView,
  openSidebarMenuForSession,
  renderSidebar,
  updateSidebarSpinnerLiveness,
} from "./view/sidebar";
import { positionSlashPicker, renderSlashPicker } from "./view/slash-picker";
import {
  initStatusStripView,
  renderStatusStrip,
  updateStatusStripStatusInPlace,
} from "./view/status-strip";
import { initTranscriptView, renderRuns } from "./view/transcript";


const readingModeQuery = window.matchMedia("(prefers-color-scheme: dark)");
let currentSystemReadingMode: ResolvedReadingMode = readingModeQuery.matches ? "dark" : "light";
// Dedup key for the terminal-window active-task relay (see pushActiveTerminalTask).
// Declared here — with the other early module state — so it is initialized before
// the first render() call (a later declaration lands in the temporal dead zone).
let lastPushedTerminalTask = "";

const state: RendererState = createInitialState(bootReadingSettingsFromDom());

let sessionIndexRefreshTimer: number | null = null;

function scheduleSessionIndexRefresh(): void {
  if (sessionIndexRefreshTimer !== null) {
    return;
  }
  sessionIndexRefreshTimer = window.setTimeout(() => {
    sessionIndexRefreshTimer = null;
    void refreshSessionIndex();
  }, 150);
}

async function refreshSessionIndex(): Promise<void> {
  try {
    // Always fetch the full record; status filtering is a view decision.
    state.sessionIndex = await window.duetRuntime.readSessionIndex({ includeArchived: true });
    // The boot screen IS a New Chat entry: preselect the last-used
    // folder until the user picks one themselves.
    if (
      !state.activeTaskId &&
      !state.taskDraftFolderTouched &&
      state.taskDraft.cwd === null &&
      state.sessionIndex.lastUsedFolder
    ) {
      state.taskDraft.cwd = state.sessionIndex.lastUsedFolder;
      render();
      return;
    }
    if (sessionTransitions.syncTaskViewsFromIndex(state, state.sessionIndex)) {
      render();
      return;
    }
    renderSidebar();
  } catch (error) {
    console.debug("session index read failed", error);
  }
}

const SIDEBAR_PREFS_KEY = "duet.sidebar.prefs";

state.sidebar.prefs = loadSidebarPrefs();

function loadSidebarPrefs(): SidebarPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(SIDEBAR_PREFS_KEY) ?? "{}") as Partial<SidebarPrefs>;
    return {
      status: ["active", "archived", "all"].includes(raw.status as string)
        ? (raw.status as SidebarPrefs["status"])
        : SIDEBAR_PREFS_DEFAULTS.status,
      project: typeof raw.project === "string" ? raw.project : null,
      activity: ["1d", "3d", "7d", "30d", "all"].includes(raw.activity as string)
        ? (raw.activity as SidebarPrefs["activity"])
        : SIDEBAR_PREFS_DEFAULTS.activity,
      groupBy: ["project", "date", "none"].includes(raw.groupBy as string)
        ? (raw.groupBy as SidebarPrefs["groupBy"])
        : SIDEBAR_PREFS_DEFAULTS.groupBy,
      sortBy: ["recency", "created", "alphabetical"].includes(raw.sortBy as string)
        ? (raw.sortBy as SidebarPrefs["sortBy"])
        : SIDEBAR_PREFS_DEFAULTS.sortBy,
    };
  } catch {
    return { ...SIDEBAR_PREFS_DEFAULTS };
  }
}

function setSidebarPrefs(patch: Partial<SidebarPrefs>): void {
  sidebarTransitions.patchSidebarPrefs(state, patch);
  try {
    localStorage.setItem(SIDEBAR_PREFS_KEY, JSON.stringify(state.sidebar.prefs));
  } catch {
    // View preference only.
  }
  renderSidebar();
}


const COLLAPSED_PROJECTS_KEY = "duet.sidebar.collapsed-projects";

state.sidebar.collapsedProjects = new Set<string>(loadCollapsedProjects());

function loadCollapsedProjects(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_PROJECTS_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((path) => typeof path === "string") : [];
  } catch {
    return [];
  }
}

function toggleProjectCollapsed(path: string): void {
  sidebarTransitions.toggleProjectCollapsed(state, path);
  try {
    localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...state.sidebar.collapsedProjects]));
  } catch {
    // View preference only.
  }
  renderSidebar();
}


async function archiveSessionFromSidebar(taskId: string): Promise<void> {
  try {
    await window.duetRuntime.archiveSession({ taskId, archived: true });
    // The main process stopped the PTY; drop the local view either way.
    removeTaskViewLocally(taskId);
  } catch (error) {
    state.status = errorMessage(error);
    render();
  }
}

async function deleteSessionFromSidebar(taskId: string, title: string): Promise<void> {
  const confirmed = window.confirm(
    `Delete "${title}"?\n\nThis removes the session from Duet. The provider transcript and your working folder are kept.`,
  );
  if (!confirmed) {
    return;
  }
  try {
    await window.duetRuntime.deleteSession({ taskId });
    removeTaskViewLocally(taskId);
  } catch (error) {
    state.status = errorMessage(error);
    render();
  }
}

function removeTaskViewLocally(taskId: string): void {
  if (sessionTransitions.removeTaskView(state, taskId)) {
    // The closed view's draft dies with it; the composer hands over to the
    // New Chat slot.
    restoreComposerDraft();
    // The terminal window disposes this task's xterm when it drops out of the
    // active-task broadcast's openTaskIds; nothing terminal-related lingers here.
  }
  render();
}

async function selectSession(taskId: string): Promise<void> {
  closeSidebarMenu();
  if (taskViewForId(state, taskId)) {
    activateTask(taskId);
    return;
  }

  // Dormant session: the read path is pure file reads — render the
  // transcript immediately, never spawn a PTY for browsing.
  state.busy = true;
  state.status = "Opening session";
  render();
  try {
    const snapshot = await window.duetRuntime.readSession({ taskId });
    const view = createTaskView(snapshot.task, snapshot.live ? "Ready" : "Idle", snapshot.live);
    view.report = snapshot.report;
    view.transcriptSources = snapshot.sources;
    for (const block of snapshot.blocks) {
      view.transcriptBlockOrder.push(block.id);
      view.transcriptBlocks.set(block.id, block);
    }
    upsertTaskView(state, view);
    activateTask(taskId);
  } catch (error) {
    state.status = errorMessage(error);
  } finally {
    state.busy = false;
    render();
  }
}

function startNewChat(folder?: string | null): void {
  closeSidebarMenu();
  exitPromptNav({ focusComposer: false });
  if (state.activeTaskId !== null) {
    saveComposerDraft();
    state.activeTaskId = null;
    restoreComposerDraft();
  }
  state.usagePopover = null;
  sessionTransitions.resetTaskDraftForNewChat(state, folder);
  render();
  elements.promptInput.focus();
}

function bootReadingSettingsFromDom(): ReadingSettings {
  const root = document.documentElement;
  return normalizeReadingSettings({
    theme: root.dataset.theme,
    mode: root.dataset.readingModeSetting,
    textStep: Number(root.dataset.textStep),
  });
}

applyReadingSettings(state.readingSettings);

initDom();

// ── Boot sequence (map R4) ───────────────────────────────────────────────────
// Module evaluation order is load-bearing: state atom → shell template →
// `elements` registry → seam binding (here) → icon/pref hydrates + listener
// binding → runtime subscriptions → async hydrates → first render(). The
// seams MUST be bound before the first render — moved view modules call them
// mid-render — and extraction never moves initialization into import-time
// side effects of new modules (R4; the TDZ landmine is documented at
// `lastPushedTerminalTask`). The referenced implementations are hoisted
// function declarations, so binding here (before their textual definitions)
// is safe.
initInvalidate(render);
initEntryView(state);
initTranscriptView(state);
initBannersView(state);
initStatusStripView(state);
initApprovalsView(state);
initSidebarView(state);
initComposerView(state);
initActions({
  setViewMode: (mode) => setViewMode(mode),
  scrollToPromptTurn: (turnKey) => scrollToPromptTurn(turnKey),
  restorePromptNavAfterRender: () => restorePromptNavAfterRender(),
  scheduleStickyPromptSync: () => scheduleStickyPromptSync(),
  renderTaskEntryPanel: () => renderTaskEntryPanel(),
  pickTaskFolder: () => {
    void pickTaskFolder();
  },
  // Entry-panel handler mutations, verbatim from their pre-D2 inline homes.
  chooseDraftProvider: (provider) => {
    state.taskDraft.provider = provider;
    state.taskDraft.message = null;
    render();
  },
  chooseDraftFolder: (path) => {
    sessionTransitions.chooseDraftFolder(state, path);
    render();
  },
  clearDraftFolder: () => {
    sessionTransitions.clearDraftFolder(state);
    render();
  },
  setLaunchSettingsOpen: (open, anchor) => {
    state.taskDraft.settingsOpen = open;
    state.taskDraft.settingsAnchor = anchor;
    render();
  },
  setDraftReasoningEffort: (provider, value) => {
    state.taskDraft.reasoningEffort[provider] = value;
    render();
  },
  setDraftModel: (provider, value) => {
    state.taskDraft.model[provider] = value;
    render();
  },
  setCodexSpeedMode: (value) => {
    state.taskDraft.speedMode.codex = value;
    render();
  },
  // Banner dismiss mutations, verbatim from their pre-D3 inline homes.
  dismissApprovalExpiredAttention: (view) => {
    view.approvalExpiredAttention = false;
    renderAttentionBanners(view);
  },
  dismissSlashAttention: (view) => {
    view.slashAttention = null;
    renderAttentionBanners(view);
  },
  // Option-prompt card: the select grammar (verbatim from its pre-D3 inline
  // home) and the answer flow.
  selectOptionPromptChoice: (view, questionIndex, optionIndex) => {
    view.optionPromptSelections[questionIndex] = optionIndex;
    renderOptionPrompt();
  },
  answerOptionPrompt: () => {
    void answerOptionPrompt();
  },
  // Sidebar flows and ports. The IPC menu-item bodies are verbatim from
  // their pre-D3 inline homes (fire-and-forget with the status/render
  // error catch); prefs/collapse carry the localStorage port.
  selectSession: (taskId) => {
    void selectSession(taskId);
  },
  startNewChat: (folder) => {
    startNewChat(folder);
  },
  setSidebarPrefs: (patch) => {
    setSidebarPrefs(patch);
  },
  toggleProjectCollapsed: (path) => {
    toggleProjectCollapsed(path);
  },
  renameSession: (taskId, title) => {
    void window.duetRuntime
      .renameSession({ taskId, title })
      .catch((error) => {
        state.status = errorMessage(error);
        render();
      });
  },
  renameProject: (path, displayName) => {
    void window.duetRuntime
      .renameProject({ path, displayName })
      .catch((error) => {
        state.status = errorMessage(error);
        render();
      });
  },
  revealSession: (taskId) => {
    void window.duetRuntime.revealSession({ taskId });
  },
  revealProject: (path) => {
    void window.duetRuntime.revealProject({ path });
  },
  archiveSessionFromSidebar: (taskId) => {
    void archiveSessionFromSidebar(taskId);
  },
  unarchiveSession: (taskId) => {
    void window.duetRuntime
      .archiveSession({ taskId, archived: false })
      .catch((error) => {
        state.status = errorMessage(error);
        render();
      });
  },
  deleteSessionFromSidebar: (taskId, title) => {
    void deleteSessionFromSidebar(taskId, title);
  },
  archiveProject: (path, archived) => {
    void window.duetRuntime
      .archiveProject({ path, archived })
      .catch((error) => {
        state.status = errorMessage(error);
        render();
      });
  },
  // Slash picker (view/slash-picker.ts): dispatch flow + hover grammar
  // (verbatim from its pre-D3 inline home).
  executeSlashEntry: (entry) => {
    executeSlashEntry(entry);
  },
  hoverSlashOption: (picker, index) => {
    if (picker.selectedIndex !== index) {
      picker.selectedIndex = index;
      renderComposerPopover();
    }
  },
  // Composer (view/composer.ts): the attachment-removal port (object-URL
  // revoke), the Add-menu reference-picker flow (verbatim body), the T5/T6
  // usage-popover hover timers, and the slash-picker composition (main.ts
  // composes sibling view families — D-early ruling 2).
  removeComposerAttachment: (list, target) => {
    removeComposerAttachment(list, target);
  },
  pickReferencesFromAddMenu: () => {
    state.composerMenu = null;
    render();
    void pickAndAddReferences();
  },
  clearUsagePopoverCloseTimer: () => {
    clearUsagePopoverCloseTimer();
  },
  scheduleUsagePopoverClose: () => {
    scheduleUsagePopoverClose();
  },
  renderSlashPicker: (picker) => renderSlashPicker(picker),
  positionSlashPicker: (pickerElement) => {
    positionSlashPicker(pickerElement);
  },
});

const USAGE_POPOVER_OPEN_DELAY_MS = 150;
const USAGE_POPOVER_CLOSE_DELAY_MS = 180;


// Ticks the live clocks (status strip + work-trace agent rows) without
// re-rendering the transcript.
window.setInterval(() => {
  elements.statusStrip
    .querySelectorAll<HTMLElement>(
      ".strip-status-elapsed[data-started-at], .strip-agent-elapsed[data-started-at]",
    )
    .forEach((node) => {
      node.textContent = formatLiveElapsed(node.dataset.startedAt ?? null);
    });
  elements.statusStrip
    .querySelectorAll<HTMLElement>(".strip-stall-elapsed[data-silent-since]")
    .forEach((node) => {
      node.textContent = formatLiveElapsed(node.dataset.silentSince ?? null);
    });
}, 1000);
let transcriptRenderTimer: number | null = null;
let stickyPromptSyncFrame: number | null = null;
let composerIsComposing = false;
let lastComposerCompositionEndAt = 0;
/** Re-entrancy guard: a send (materialize + submit) is in flight. Blocks a fast
 *  double-Enter from re-materializing the same attachments (duplicate blob +
 *  double delivery) on the live path, which — unlike new-chat/dormant — has no
 *  state.busy gate. */
let composerSending = false;
let usagePopoverOpenTimer: number | null = null;
let usagePopoverCloseTimer: number | null = null;
const COMPOSITION_END_SHORTCUT_GUARD_MS = 80;
const PROMPT_NAV_DOM_TASK_ID = "__active-transcript-dom__";
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const SUPPORTED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

elements.sidebarToggle.append(lucideIcon(PanelLeft));
elements.sidebarCollapse.append(lucideIcon(PanelLeft));
elements.sessionMenuTrigger.append(lucideIcon(Ellipsis));
elements.openPreviewWindow.append(lucideIcon(Eye));
elements.openInspectorWindow.append(lucideIcon(SearchCode));
elements.remoteControlToggle.append(lucideIcon(Smartphone));
elements.sidebarNewChat.querySelector(".sidebar-new-chat-icon")?.append(lucideIcon(SquarePen));

const SIDEBAR_COLLAPSED_KEY = "duet.sidebar.collapsed";

function setSidebarCollapsed(collapsed: boolean): void {
  elements.sidebar.classList.toggle("collapsed", collapsed);
  elements.sidebarResizer.classList.toggle("hidden", collapsed);
  // Drives the collapsed-only CSS: the main header reserves the traffic-light
  // corner (the lights float over the main pane once the sidebar is gone) and
  // the header's expand button appears (the in-sidebar collapse button is hidden
  // with the sidebar).
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // Cosmetic state only.
  }
}

const SIDEBAR_WIDTH_KEY = "duet.sidebar.width";
const SIDEBAR_WIDTH_DEFAULT = 236;
const SIDEBAR_WIDTH_MIN = 180;
const SIDEBAR_WIDTH_MAX = 420;

function applySidebarWidth(width: number | null): void {
  if (width === null) {
    elements.sidebar.style.removeProperty("width");
    elements.sidebar.style.removeProperty("flex-basis");
    return;
  }
  const clamped = Math.round(clamp(width, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX));
  elements.sidebar.style.width = `${clamped}px`;
  elements.sidebar.style.flexBasis = `${clamped}px`;
}

function persistSidebarWidth(width: number | null): void {
  try {
    if (width === null) {
      localStorage.removeItem(SIDEBAR_WIDTH_KEY);
    } else {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(width)));
    }
  } catch {
    // View preference only.
  }
}

try {
  const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  if (Number.isFinite(stored) && stored > 0) {
    applySidebarWidth(stored);
  }
} catch {
  // Default width stays.
}

elements.sidebarResizer.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) {
    return;
  }
  event.preventDefault();
  const resizer = event.currentTarget as HTMLElement;
  resizer.setPointerCapture(event.pointerId);
  document.body.classList.add("sidebar-resizing");
  let frame = 0;
  let lastWidth = elements.sidebar.getBoundingClientRect().width;

  const onMove = (moveEvent: PointerEvent): void => {
    lastWidth = moveEvent.clientX;
    if (frame) {
      return;
    }
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      applySidebarWidth(lastWidth);
    });
  };
  const onUp = (): void => {
    resizer.removeEventListener("pointermove", onMove);
    resizer.removeEventListener("pointerup", onUp);
    resizer.removeEventListener("pointercancel", onUp);
    document.body.classList.remove("sidebar-resizing");
    if (frame) {
      window.cancelAnimationFrame(frame);
      frame = 0;
    }
    applySidebarWidth(lastWidth);
    persistSidebarWidth(clamp(lastWidth, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX));
  };
  resizer.addEventListener("pointermove", onMove);
  resizer.addEventListener("pointerup", onUp);
  resizer.addEventListener("pointercancel", onUp);
});

elements.sidebarResizer.addEventListener("dblclick", () => {
  applySidebarWidth(null);
  persistSidebarWidth(null);
});

try {
  setSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1");
} catch {
  // Default stays expanded.
}

elements.sidebarCollapse.addEventListener("click", () => {
  setSidebarCollapsed(true);
});
elements.sidebarToggle.addEventListener("click", () => {
  setSidebarCollapsed(!elements.sidebar.classList.contains("collapsed"));
});

elements.sidebarNewChat.addEventListener("click", () => {
  startNewChat();
});

elements.sessionMenuTrigger.addEventListener("click", (event) => {
  event.stopPropagation();
  const view = activeTaskView();
  if (view?.task) {
    openSidebarMenuForSession(
      view.task.id,
      view.task.title,
      Boolean(view.task.archived),
      event.currentTarget as HTMLElement,
    );
  }
});

elements.openPreviewWindow.addEventListener("click", () => {
  void openFloatingPreview();
});

elements.openInspectorWindow.addEventListener("click", () => {
  void openFloatingInspector();
});

// The terminal satellite window's toggle. Unlike the icon window-openers, it's
// a labelled button that flips between "Open Terminal" and "Close Terminal".
// The label tracks the window's real state — the toggle and an OS-close both
// drive the broadcast this subscribes to — so it stays honest either way.
function applyTerminalWindowState(state: TerminalWindowState): void {
  const button = elements.toggleTerminalWindow;
  button.textContent = state.open ? "Close Terminal" : "Open Terminal";
  button.setAttribute("aria-pressed", state.open ? "true" : "false");
  button.title = state.open ? "Close the terminal window" : "Open the terminal window";
}

elements.toggleTerminalWindow.addEventListener("click", () => {
  const open = elements.toggleTerminalWindow.getAttribute("aria-pressed") === "true";
  void window.duetRuntime.setTerminalWindowOpen(!open).then(applyTerminalWindowState);
});

window.duetRuntime.onTerminalWindowState(applyTerminalWindowState);
void window.duetRuntime.readTerminalWindowState().then(applyTerminalWindowState);

// Ctrl+` opens/focuses the terminal window (repurposed from VS Code's terminal
// binding — devs reach for it without thinking). Capture phase + stopPropagation
// so it fires even while an xterm holds focus and never leaks a backtick.
document.addEventListener(
  "keydown",
  (event) => {
    if (event.key !== "`" || !event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    // Repurposed from the old in-pane toggle: open/focus the terminal window.
    surfaceTerminalWindow();
  },
  true,
);

elements.readingSettings.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleReadingPopover(event.currentTarget as HTMLElement);
});

elements.remoteControlToggle.addEventListener("click", (event) => {
  event.stopPropagation();
  if (remoteControlContext(activeTaskView(), state.taskDraft.provider).mode === "unavailable") {
    return;
  }
  toggleRemoteControlPopover(event.currentTarget as HTMLElement);
});

elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitPrompt();
});

elements.promptInput.addEventListener("input", () => {
  renderComposerControls();
  syncSlashPicker();
});

elements.promptInput.addEventListener("focus", () => {
  renderComposerControls();
});

elements.promptInput.addEventListener("blur", () => {
  composerIsComposing = false;
  renderComposerControls();
});

elements.promptInput.addEventListener("compositionstart", () => {
  composerIsComposing = true;
});

elements.promptInput.addEventListener("compositionend", () => {
  composerIsComposing = false;
  lastComposerCompositionEndAt = performance.now();
  renderComposerControls();
  syncSlashPicker();
});

elements.addAttachment.addEventListener("click", (event) => {
  toggleComposerMenu("add", event.currentTarget as HTMLElement);
});

elements.composer.addEventListener("paste", (event) => {
  const files = Array.from(event.clipboardData?.files ?? []);
  if (files.length === 0) {
    return;
  }
  event.preventDefault();
  void intakeFiles(files);
});

elements.composer.addEventListener("dragover", (event) => {
  if (hasFileTransfer(event.dataTransfer)) {
    event.preventDefault();
  }
});

elements.composer.addEventListener("drop", (event) => {
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length === 0) {
    return;
  }
  event.preventDefault();
  void intakeFiles(files);
});

elements.usageIndicator.addEventListener("mouseenter", () => {
  scheduleUsagePopoverOpen();
});

elements.usageIndicator.addEventListener("mouseleave", () => {
  scheduleUsagePopoverClose();
});

elements.usageIndicator.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleUsagePopover();
});

elements.usageIndicator.addEventListener("focus", () => {
  if (state.usagePopover?.pinned) {
    return;
  }
  scheduleUsagePopoverOpen();
});

elements.usageIndicator.addEventListener("blur", () => {
  scheduleUsagePopoverClose();
});

elements.promptInput.addEventListener("keydown", (event) => {
  if (isComposerCompositionShortcut(event)) {
    return;
  }

  if (handleSlashPickerKeydown(event)) {
    return;
  }

  if (
    event.key === "Escape" &&
    elements.promptInput.value.trim().length === 0 &&
    hasActiveRun(activeTaskView())
  ) {
    event.preventDefault();
    void stopRun();
    return;
  }

  if (event.key !== "Enter" || event.shiftKey) {
    return;
  }
  const submitView = activeTaskView();
  const attachmentCount = submitView ? submitView.pendingAttachments.length : state.draftAttachments.length;
  if (elements.promptInput.value.trim().length === 0 && attachmentCount === 0) {
    return;
  }
  event.preventDefault();
  elements.composer.requestSubmit();
});

elements.sendPrompt.addEventListener("click", () => {
  if (hasActiveRun(activeTaskView())) {
    void stopRun();
    return;
  }
  void submitPrompt();
});

async function hydrateReadingSettings(): Promise<void> {
  try {
    const settings = normalizeReadingSettings(await window.duetRuntime.readReadingSettings());
    state.readingSettings = settings;
    applyReadingSettings(settings);
    renderReadingPopover();
  } catch (error) {
    state.status = errorMessage(error);
    render();
  }
}

/** Seed the global "Auto-enable Remote Control" default (and the New Chat draft
 *  it arms) from Claude settings on boot — awaited before the session index makes
 *  dormant sessions clickable, so a dormant view never arms from a stale default. */
async function hydrateClaudeDefaults(): Promise<void> {
  try {
    const settings = normalizeClaudeSettings(await window.duetRuntime.readClaudeSettings());
    state.remoteControlDefault = settings.defaultRemoteControl;
    state.taskDraft.remoteControl = settings.defaultRemoteControl;
    render();
  } catch {
    // Best-effort: the New Chat default just stays off.
  }
}

function applyReadingSettings(nextSettings: ReadingSettings): void {
  const settings = normalizeReadingSettings(nextSettings);
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.dataset.mode = resolvedReadingMode(settings);
  root.dataset.readingModeSetting = settings.mode;
  root.dataset.textStep = String(settings.textStep);
}

function resolvedReadingMode(settings = state.readingSettings): ResolvedReadingMode {
  if (settings.mode === "light" || settings.mode === "dark") {
    return settings.mode;
  }
  return currentSystemReadingMode;
}

function toggleReadingPopover(anchor: HTMLElement): void {
  popoverTransitions.toggleReadingPopover(state, () => popoverAnchorFromElement(anchor));
  render();
}

function closeReadingPopover(): void {
  popoverTransitions.closeReadingPopover(state);
  renderReadingPopover();
}

function syncReadingPopoverAnchor(): void {
  popoverTransitions.setReadingPopoverAnchor(
    state,
    popoverAnchorFromElement(elements.readingSettings),
  );
}

function popoverAnchorFromElement(anchor: HTMLElement): PopoverAnchor {
  const rect = anchor.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.bottom + 8,
    width: rect.width,
  };
}

function renderReadingPopover(): void {
  elements.readingSettings.classList.toggle("active", state.readingPopoverOpen);
  elements.readingSettings.setAttribute("aria-expanded", String(state.readingPopoverOpen));
  elements.readingPopoverRoot.replaceChildren();
  if (!state.readingPopoverOpen) {
    return;
  }
  elements.readingPopoverRoot.append(renderReadingSettingsPopover());
}

function renderReadingSettingsPopover(): HTMLElement {
  const popover = document.createElement("div");
  popover.className = "reading-settings-popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Reading Controls");
  positionReadingPopover(popover);
  popover.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  popover.append(
    renderReadingThemeSection(),
    renderReadingModeSection(),
    renderReadingSizeSection(),
  );
  return popover;
}

function positionReadingPopover(popover: HTMLElement): void {
  const anchor = state.readingPopoverAnchor;
  const viewportPadding = 14;
  const width = Math.min(360, window.innerWidth - viewportPadding * 2);
  const top = anchor?.top ?? viewportPadding;
  const left = anchor
    ? Math.min(
        window.innerWidth - width - viewportPadding,
        Math.max(viewportPadding, anchor.left + anchor.width - width),
      )
    : viewportPadding;

  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  popover.style.width = `${width}px`;
  popover.style.maxHeight = `${Math.max(260, window.innerHeight - top - viewportPadding)}px`;
}

// ── Remote Control popover ──────────────────────────────────────────────────
// Same model as the reading ("Aa") popover: the header button only opens this
// popover; the on/off ACTION lives inside it. ON injects `/rc` (works mid-turn);
// the on-state surfaces the scraped session URL (copy) + routes Disconnect/QR to
// claude's own native panel via the Terminal view (fragility-free management).

function toggleRemoteControlPopover(anchor: HTMLElement): void {
  popoverTransitions.toggleRemoteControlPopover(state, () => popoverAnchorFromElement(anchor));
  render();
}

function closeRemoteControlPopover(): void {
  popoverTransitions.closeRemoteControlPopover(state);
  renderRemoteControlPopover();
}

/** The header button's persistent on/off indication (active fill = "on") and
 *  availability. Mirrors the reading button's split: state here, popover content
 *  in renderRemoteControlPopover. */
function renderRemoteControl(): void {
  const ctx = remoteControlContext(activeTaskView(), state.taskDraft.provider);
  const on = remoteControlOn(
    ctx,
    activeTaskView(),
    state.taskDraft.remoteControl,
    state.remoteControlDefault,
  );
  elements.remoteControlToggle.classList.toggle("remote-on", on);
  elements.remoteControlToggle.disabled = ctx.mode === "unavailable";
  elements.remoteControlToggle.title =
    ctx.mode === "unavailable"
      ? "Remote control (Claude only)"
      : on
        ? "Remote control · on"
        : "Remote control";
}

function remoteControlPopoverHeader(statusText: string, on: boolean): HTMLElement {
  const header = document.createElement("div");
  header.className = "remote-control-popover-header";
  const title = document.createElement("span");
  title.className = "remote-control-popover-title";
  title.textContent = "Remote control";
  const status = document.createElement("span");
  status.className = "remote-control-popover-status";
  status.classList.toggle("on", on);
  status.textContent = statusText;
  header.append(title, status);
  return header;
}

function renderRemoteControlPopover(): void {
  elements.remoteControlToggle.setAttribute(
    "aria-expanded",
    String(state.remoteControlPopoverOpen),
  );
  elements.remoteControlPopoverRoot.replaceChildren();
  if (!state.remoteControlPopoverOpen) {
    return;
  }
  elements.remoteControlPopoverRoot.append(renderRemoteControlPopoverContent());
}

function renderRemoteControlPopoverContent(): HTMLElement {
  const popover = document.createElement("div");
  popover.className = "remote-control-popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Remote control");
  positionPopoverElement(popover, state.remoteControlPopoverAnchor, 320);
  popover.addEventListener("click", (event) => event.stopPropagation());

  // No live PTY yet (New Chat or a dormant session): the button ARMS the spawn
  // flag; the session connects the moment it starts/resumes.
  const armCtx = remoteControlContext(activeTaskView(), state.taskDraft.provider);
  if (armCtx.mode === "arm-draft" || armCtx.mode === "arm-dormant") {
    const armed = remoteControlOn(
      armCtx,
      activeTaskView(),
      state.taskDraft.remoteControl,
      state.remoteControlDefault,
    );
    popover.append(remoteControlPopoverHeader(armed ? "Armed" : "Off", armed));
    const armDesc = document.createElement("p");
    armDesc.className = "remote-control-popover-desc";
    armDesc.textContent = armed
      ? "Remote control will be on when this session starts — open it in the Claude app on your phone."
      : "Start this session with remote control on, so you can see and steer it from the Claude app on your phone.";
    popover.append(armDesc);
    const arm = document.createElement("button");
    arm.type = "button";
    arm.className = armed
      ? "remote-control-popover-action"
      : "remote-control-popover-action primary";
    arm.textContent = armed ? "Turn off" : "Turn on";
    arm.addEventListener("click", () => {
      if (armCtx.mode === "arm-draft") {
        state.taskDraft.remoteControl = !state.taskDraft.remoteControl;
      } else {
        const view = activeTaskView();
        if (view) {
          view.remoteControl.armedOverride = !dormantArmed(view, state.remoteControlDefault);
        }
      }
      render();
    });
    popover.append(arm);
    return popover;
  }

  const rc = activeTaskView()?.remoteControl ?? { active: false, url: null };
  popover.append(remoteControlPopoverHeader(rc.active ? "On" : "Off", rc.active));

  const desc = document.createElement("p");
  desc.className = "remote-control-popover-desc";

  if (!rc.active) {
    desc.textContent = "See and steer this session from the Claude app on your phone.";
    popover.append(desc);
    const turnOn = document.createElement("button");
    turnOn.type = "button";
    turnOn.className = "remote-control-popover-action primary";
    turnOn.textContent = "Turn on";
    turnOn.addEventListener("click", () => void enableRemoteControl());
    popover.append(turnOn);
    if (state.remoteControlNote) {
      const note = document.createElement("p");
      note.className = "remote-control-popover-note";
      note.textContent = state.remoteControlNote;
      popover.append(note);
    }
    return popover;
  }

  desc.textContent = "Open Claude on your phone, or use the link below.";
  popover.append(desc);

  if (rc.url) {
    const urlRow = document.createElement("div");
    urlRow.className = "remote-control-popover-url-row";
    const urlText = document.createElement("span");
    urlText.className = "remote-control-popover-url";
    urlText.textContent = rc.url;
    urlText.title = rc.url;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "remote-control-popover-copy";
    copy.title = "Copy link";
    copy.append(lucideIcon(Copy, 14));
    copy.addEventListener("click", () => {
      const url = rc.url;
      if (!url) {
        return;
      }
      void navigator.clipboard.writeText(url).catch(() => {});
      copy.classList.add("copied");
      window.setTimeout(() => copy.classList.remove("copied"), 1200);
    });
    urlRow.append(urlText, copy);
    popover.append(urlRow);
  } else {
    const connecting = document.createElement("p");
    connecting.className = "remote-control-popover-desc";
    connecting.textContent = "Connecting…";
    popover.append(connecting);
  }

  const manage = document.createElement("button");
  manage.type = "button";
  manage.className = "remote-control-popover-action";
  manage.textContent = "Manage / disconnect in terminal →";
  manage.addEventListener("click", () => void manageRemoteControl());
  popover.append(manage);
  return popover;
}

/** Turn RC on. The main process injects `/rc` and emits remote-control:state
 *  (optimistic active), which re-renders the popover to the on-state; the URL
 *  fills in when scraped. A refusal (an open approval/modal panel would eat the
 *  command) leaves us off and explains why. */
async function enableRemoteControl(): Promise<void> {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }
  state.remoteControlNote = null;
  try {
    const result = await window.duetRuntime.injectRemoteControl({ taskId: view.task.id });
    if (!result.ok) {
      state.remoteControlNote =
        result.reason === "panel-open"
          ? "Claude is waiting on something in the terminal — answer that first."
          : result.reason === "busy"
            ? "Claude is mid-delivery — try again in a moment."
            : "Couldn't enable remote control.";
      renderRemoteControlPopover();
    }
  } catch (error) {
    // The PTY can exit between opening the popover and clicking (the session
    // ended) — the IPC then rejects. Surface the error in the popover note.
    state.remoteControlNote = errorMessage(error);
    renderRemoteControlPopover();
  }
}

/** Manage an active RC session: inject `/rc` to open claude's own panel
 *  (Disconnect / Show QR / Continue), then switch to Terminal so the user acts
 *  in it. The native panel — not a Duet-driven menu — is the honest,
 *  fragility-free management surface. */
async function manageRemoteControl(): Promise<void> {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }
  closeRemoteControlPopover();
  try {
    const result = await window.duetRuntime.injectRemoteControl({ taskId: view.task.id });
    if (result.ok) {
      setViewMode("terminal");
    }
  } catch {
    // PTY gone between popover-open and click — nothing to manage; stay put.
  }
}

function renderReadingThemeSection(): HTMLElement {
  const grid = document.createElement("div");
  grid.className = "reading-theme-grid";
  for (const theme of READING_THEME_IDS) {
    grid.append(renderReadingThemeCard(theme));
  }
  return readingSettingSection("Theme", grid);
}

function renderReadingThemeCard(theme: ReadingThemeId): HTMLElement {
  const selected = state.readingSettings.theme === theme;
  const button = document.createElement("button");
  button.className = "reading-theme-card";
  button.classList.toggle("selected", selected);
  button.type = "button";
  button.dataset.theme = theme;
  button.dataset.mode = resolvedReadingMode();
  button.setAttribute("aria-label", `${readingThemeLabel(theme)} theme`);
  button.setAttribute("aria-pressed", String(selected));
  button.addEventListener("click", () => {
    void persistReadingSettings({
      ...state.readingSettings,
      theme,
    });
  });

  const name = document.createElement("span");
  name.className = "reading-theme-name";
  name.textContent = readingThemeLabel(theme);

  const sample = document.createElement("span");
  sample.className = "reading-theme-sample";
  sample.textContent = "Aa";

  const lines = document.createElement("span");
  lines.className = "reading-theme-lines";
  lines.append(document.createElement("i"), document.createElement("i"));

  const current = document.createElement("span");
  current.className = "reading-theme-current";
  current.textContent = selected ? "current" : "";

  button.append(name, sample, lines, current);
  return button;
}

function renderReadingModeSection(): HTMLElement {
  const group = document.createElement("div");
  group.className = "reading-segmented";
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", "Mode");

  for (const mode of READING_MODE_IDS) {
    const selected = state.readingSettings.mode === mode;
    const button = document.createElement("button");
    button.className = "reading-segment";
    button.classList.toggle("selected", selected);
    button.type = "button";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(selected));
    button.textContent = readingModeLabel(mode);
    button.addEventListener("click", () => {
      void persistReadingSettings({
        ...state.readingSettings,
        mode,
      });
    });
    group.append(button);
  }

  return readingSettingSection("Mode", group);
}

function renderReadingSizeSection(): HTMLElement {
  const stepper = document.createElement("div");
  stepper.className = "reading-size-stepper";
  const currentIndex = READING_TEXT_STEPS.indexOf(state.readingSettings.textStep);
  const previous = currentIndex > 0 ? READING_TEXT_STEPS[currentIndex - 1] : undefined;
  const next = currentIndex >= 0 && currentIndex < READING_TEXT_STEPS.length - 1
    ? READING_TEXT_STEPS[currentIndex + 1]
    : undefined;

  const decrease = document.createElement("button");
  decrease.className = "reading-size-button";
  decrease.type = "button";
  decrease.disabled = previous === undefined;
  decrease.setAttribute("aria-label", "Decrease text size");
  decrease.textContent = "A-";
  decrease.addEventListener("click", () => {
    if (isReadingTextStep(previous)) {
      void persistReadingSettings({
        ...state.readingSettings,
        textStep: previous,
      });
    }
  });

  const value = document.createElement("strong");
  value.className = "reading-size-value";
  value.textContent = String(state.readingSettings.textStep);

  const increase = document.createElement("button");
  increase.className = "reading-size-button";
  increase.type = "button";
  increase.disabled = next === undefined;
  increase.setAttribute("aria-label", "Increase text size");
  increase.textContent = "A+";
  increase.addEventListener("click", () => {
    if (isReadingTextStep(next)) {
      void persistReadingSettings({
        ...state.readingSettings,
        textStep: next,
      });
    }
  });

  stepper.append(decrease, value, increase);
  return readingSettingSection("Size", stepper);
}

function readingSettingSection(label: string, content: HTMLElement): HTMLElement {
  const section = document.createElement("section");
  section.className = "reading-setting-section";
  const heading = document.createElement("p");
  heading.className = "reading-setting-heading";
  heading.textContent = label;
  section.append(heading, content);
  return section;
}

async function persistReadingSettings(nextSettings: ReadingSettings): Promise<void> {
  const settings = normalizeReadingSettings(nextSettings);
  state.readingSettings = settings;
  applyReadingSettings(settings);
  renderReadingPopover();

  try {
    const persisted = normalizeReadingSettings(await window.duetRuntime.writeReadingSettings(settings));
    state.readingSettings = persisted;
    applyReadingSettings(persisted);
  } catch (error) {
    state.status = errorMessage(error);
  } finally {
    render();
  }
}

// --- Settings page (centered overlay) ---------------------------------------
// The review door for moment-born policy. Two doors, one state: the resume
// chooser writes the same store this page revises. Instant-apply, no OK.

function openSettingsOverlay(): void {
  if (!popoverTransitions.openSettingsOverlay(state)) {
    return;
  }
  render();
  elements.settingsOverlayRoot.querySelector<HTMLElement>(".settings-window")?.focus();
  void refreshSettingsOverlay();
}

function closeSettingsOverlay(): void {
  popoverTransitions.closeSettingsOverlay(state);
  render();
}

async function refreshSettingsOverlay(): Promise<void> {
  try {
    const [resumeResponse, claudeResponse] = await Promise.all([
      window.duetRuntime.readResumeSettings(),
      window.duetRuntime.readClaudeSettings(),
    ]);
    if (!state.settingsOverlay) {
      return;
    }
    state.settingsOverlay.resume = {
      settings: normalizeResumeSettings(resumeResponse.settings),
      bridgeDismissed: resumeResponse.bridgeDismissed,
    };
    state.settingsOverlay.claude = {
      settings: normalizeClaudeSettings(claudeResponse),
    };
  } catch (error) {
    state.status = errorMessage(error);
  }
  render();
}

async function persistDefaultPermissionMode(mode: ClaudeDefaultPermissionMode): Promise<void> {
  const overlay = state.settingsOverlay;
  if (!overlay?.claude) {
    return;
  }
  overlay.approvalMenuOpen = false;
  if (overlay.claude.settings.defaultPermissionMode === mode) {
    render();
    return;
  }
  const next: ClaudeSettings = { ...overlay.claude.settings, defaultPermissionMode: mode };
  overlay.claude.settings = next;
  render();
  try {
    const persisted = normalizeClaudeSettings(await window.duetRuntime.writeClaudeSettings(next));
    if (state.settingsOverlay?.claude) {
      state.settingsOverlay.claude.settings = persisted;
    }
  } catch (error) {
    state.status = errorMessage(error);
  }
  render();
}

async function persistResumePolicy(policy: ResumePolicyId): Promise<void> {
  const overlay = state.settingsOverlay;
  if (!overlay?.resume) {
    return;
  }
  if (overlay.resume.settings.policy === policy) {
    overlay.policyMenuOpen = false;
    render();
    return;
  }
  // A revision here retires the moment-born attribution line: the page
  // becomes the last author and the history line has done its job.
  const next: ResumeSettings = {
    policy,
    provenance: { source: "settings", at: new Date().toISOString() },
  };
  overlay.resume.settings = next;
  overlay.policyMenuOpen = false;
  render();
  try {
    const persisted = normalizeResumeSettings(await window.duetRuntime.writeResumeSettings(next));
    if (state.settingsOverlay?.resume) {
      state.settingsOverlay.resume.settings = persisted;
    }
  } catch (error) {
    state.status = errorMessage(error);
  }
  render();
}

async function restoreResumeBridge(): Promise<void> {
  const overlay = state.settingsOverlay;
  if (!overlay?.resume || overlay.bridgeReverting) {
    return;
  }
  overlay.bridgeReverting = true;
  overlay.bridgeError = false;
  render();
  let cleared = false;
  try {
    cleared = (await window.duetRuntime.revertResumeBridge()).cleared;
  } catch {
    cleared = false;
  }
  if (state.settingsOverlay) {
    if (state.settingsOverlay.resume) {
      state.settingsOverlay.resume.bridgeDismissed = !cleared;
    }
    state.settingsOverlay.bridgeError = !cleared;
    state.settingsOverlay.bridgeReverting = false;
  }
  render();
}

function renderSettingsOverlay(): void {
  const overlay = state.settingsOverlay;
  const active = document.activeElement;
  const keepFocus =
    overlay !== null &&
    (active === document.body || elements.settingsOverlayRoot.contains(active));
  elements.settingsOverlayRoot.replaceChildren();
  if (!overlay) {
    return;
  }

  const scrim = document.createElement("div");
  scrim.className = "settings-overlay";
  scrim.addEventListener("mousedown", (event) => {
    if (event.target === scrim) {
      closeSettingsOverlay();
    }
  });

  const dialog = document.createElement("div");
  dialog.className = "settings-window";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "Duet Settings");
  dialog.tabIndex = -1;
  dialog.addEventListener("mousedown", (event) => {
    const outsidePopup =
      event.target instanceof Element && !event.target.closest(".settings-popup-wrap");
    if (outsidePopup && (overlay.policyMenuOpen || overlay.approvalMenuOpen)) {
      overlay.policyMenuOpen = false;
      overlay.approvalMenuOpen = false;
      render();
    }
  });

  dialog.append(
    renderSettingsHeader(),
    renderApprovalsSettingsGroup(overlay),
    renderRemoteControlSettingsGroup(overlay),
    renderSessionsSettingsGroup(overlay),
    renderClaudeSettingsGroup(overlay),
  );
  scrim.append(dialog);
  elements.settingsOverlayRoot.append(scrim);
  if (keepFocus) {
    dialog.focus();
  }
}

function renderSettingsHeader(): HTMLElement {
  const header = document.createElement("header");
  header.className = "settings-header";

  const title = document.createElement("h2");
  title.className = "settings-title";
  title.textContent = "Settings";

  const close = document.createElement("button");
  close.className = "settings-close";
  close.type = "button";
  close.setAttribute("aria-label", "Close settings");
  close.append(lucideIcon(X));
  close.addEventListener("click", () => {
    closeSettingsOverlay();
  });

  header.append(title, close);
  return header;
}

function renderApprovalsSettingsGroup(overlay: SettingsOverlayState): HTMLElement {
  const group = document.createElement("section");
  group.className = "settings-group";
  group.setAttribute("aria-label", "Approvals");

  const heading = document.createElement("p");
  heading.className = "settings-group-heading";
  heading.textContent = "Approvals";

  const box = document.createElement("div");
  box.className = "settings-box";

  const row = document.createElement("div");
  row.className = "settings-row";
  const copy = document.createElement("div");
  copy.className = "settings-row-copy";
  const title = document.createElement("span");
  title.className = "settings-row-title";
  title.textContent = "New Claude sessions start in";
  copy.append(title);
  row.append(copy, renderDefaultPermissionModePopup(overlay));
  box.append(row);

  const footnote = document.createElement("p");
  footnote.className = "settings-footnote";
  footnote.textContent =
    "Mirrors Claude's Shift+Tab modes. Auto approves every step through Claude's own safety classifier — far fewer prompts, with a guardrail. You can still switch any single session from its permission chip.";

  group.append(heading, box, footnote);
  return group;
}

function renderRemoteControlSettingsGroup(overlay: SettingsOverlayState): HTMLElement {
  const group = document.createElement("section");
  group.className = "settings-group";
  group.setAttribute("aria-label", "Remote control");

  const heading = document.createElement("p");
  heading.className = "settings-group-heading";
  heading.textContent = "Remote control";

  const box = document.createElement("div");
  box.className = "settings-box";
  const row = document.createElement("div");
  row.className = "settings-row";

  const copy = document.createElement("div");
  copy.className = "settings-row-copy";
  const title = document.createElement("span");
  title.className = "settings-row-title";
  title.textContent = "Auto-enable Remote Control";
  copy.append(title);
  row.append(copy);

  const on = overlay.claude?.settings.defaultRemoteControl ?? false;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "settings-toggle";
  toggle.classList.toggle("on", on);
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", String(on));
  toggle.disabled = !overlay.claude;
  toggle.textContent = on ? "On" : "Off";
  toggle.addEventListener("click", () => {
    void setDefaultRemoteControl(!on);
  });
  const trailing = document.createElement("div");
  trailing.className = "settings-row-trailing";
  trailing.append(toggle);
  row.append(trailing);

  box.append(row);

  const footnote = document.createElement("p");
  footnote.className = "settings-footnote";
  footnote.textContent =
    "New and resumed Claude sessions come up reachable from the Claude app on your phone. You can still turn it off for any single session.";

  group.append(heading, box, footnote);
  return group;
}

async function setDefaultRemoteControl(value: boolean): Promise<void> {
  const overlay = state.settingsOverlay;
  if (!overlay?.claude || overlay.claude.settings.defaultRemoteControl === value) {
    return;
  }
  const next: ClaudeSettings = { ...overlay.claude.settings, defaultRemoteControl: value };
  overlay.claude.settings = next;
  // Reflect the new default immediately: the New Chat draft (header button) and
  // the default that newly-opened dormant sessions arm from.
  state.remoteControlDefault = value;
  state.taskDraft.remoteControl = value;
  render();
  try {
    const persisted = normalizeClaudeSettings(await window.duetRuntime.writeClaudeSettings(next));
    if (state.settingsOverlay?.claude) {
      state.settingsOverlay.claude.settings = persisted;
    }
    state.remoteControlDefault = persisted.defaultRemoteControl;
    state.taskDraft.remoteControl = persisted.defaultRemoteControl;
  } catch (error) {
    state.status = errorMessage(error);
  }
  render();
}

function renderDefaultPermissionModePopup(overlay: SettingsOverlayState): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "settings-popup-wrap";

  const button = document.createElement("button");
  button.className = "settings-popup";
  button.type = "button";
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", String(overlay.approvalMenuOpen));
  button.disabled = !overlay.claude;
  const label = document.createElement("span");
  label.textContent = overlay.claude
    ? permissionModeLabel(overlay.claude.settings.defaultPermissionMode)
    : "Loading…";
  button.append(label, lucideIcon(ChevronDown, 14));
  button.addEventListener("click", () => {
    overlay.approvalMenuOpen = !overlay.approvalMenuOpen;
    render();
  });
  wrap.append(button);

  if (overlay.approvalMenuOpen && overlay.claude) {
    const menu = document.createElement("div");
    menu.className = "settings-popup-menu";
    menu.setAttribute("role", "menu");
    for (const mode of CLAUDE_DEFAULT_PERMISSION_MODE_OPTIONS) {
      const selected = overlay.claude.settings.defaultPermissionMode === mode;
      const option = document.createElement("button");
      option.className = "settings-popup-option";
      option.classList.toggle("selected", selected);
      option.type = "button";
      option.setAttribute("role", "menuitemradio");
      option.setAttribute("aria-checked", String(selected));
      const check = document.createElement("span");
      check.className = "settings-popup-option-check";
      if (selected) {
        check.append(lucideIcon(Check, 13));
      }
      const optionLabel = document.createElement("span");
      optionLabel.className = "settings-popup-option-label";
      optionLabel.textContent = permissionModeLabel(mode);
      option.append(check, optionLabel);
      option.addEventListener("click", () => {
        void persistDefaultPermissionMode(mode);
      });
      menu.append(option);
    }
    wrap.append(menu);
  }

  return wrap;
}

function renderSessionsSettingsGroup(overlay: SettingsOverlayState): HTMLElement {
  const group = document.createElement("section");
  group.className = "settings-group";
  group.setAttribute("aria-label", "Sessions");

  const heading = document.createElement("p");
  heading.className = "settings-group-heading";
  heading.textContent = "Sessions";

  const box = document.createElement("div");
  box.className = "settings-box";

  const row = document.createElement("div");
  row.className = "settings-row";

  const copy = document.createElement("div");
  copy.className = "settings-row-copy";
  const title = document.createElement("span");
  title.className = "settings-row-title";
  title.textContent = "Resuming a large dormant session";
  copy.append(title);

  // Apple's provenance grammar (Login Items "Added by …"): state on the
  // row, one quiet line of attribution — only while the value is
  // moment-born. Reading settings never carry this; they have no moment.
  const provenance = overlay.resume?.settings.provenance;
  if (provenance?.source === "moment") {
    const note = document.createElement("span");
    note.className = "settings-row-note";
    note.textContent = `Set from the resume chooser · ${settingsDateLabel(provenance.at)}`;
    copy.append(note);
  }

  row.append(copy, renderResumePolicyPopup(overlay));
  box.append(row);

  const footnote = document.createElement("p");
  footnote.className = "settings-footnote";
  footnote.textContent = `Applies when a Claude session has been idle for over ${Math.round(
    RESUME_PROMPT_MIN_IDLE_MS / 60_000,
  )} minutes and holds about ${formatTokenCount(RESUME_PROMPT_MIN_TOKENS)} tokens or more.`;

  group.append(heading, box, footnote);
  return group;
}

function renderResumePolicyPopup(overlay: SettingsOverlayState): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "settings-popup-wrap";

  const button = document.createElement("button");
  button.className = "settings-popup";
  button.type = "button";
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", String(overlay.policyMenuOpen));
  button.disabled = !overlay.resume;
  const label = document.createElement("span");
  label.textContent = overlay.resume
    ? resumePolicyLabel(overlay.resume.settings.policy)
    : "Loading…";
  button.append(label, lucideIcon(ChevronDown, 14));
  button.addEventListener("click", () => {
    overlay.policyMenuOpen = !overlay.policyMenuOpen;
    render();
  });
  wrap.append(button);

  if (overlay.policyMenuOpen && overlay.resume) {
    const menu = document.createElement("div");
    menu.className = "settings-popup-menu";
    menu.setAttribute("role", "menu");
    for (const policy of RESUME_POLICY_IDS) {
      const selected = overlay.resume.settings.policy === policy;
      const option = document.createElement("button");
      option.className = "settings-popup-option";
      option.classList.toggle("selected", selected);
      option.type = "button";
      option.setAttribute("role", "menuitemradio");
      option.setAttribute("aria-checked", String(selected));
      const check = document.createElement("span");
      check.className = "settings-popup-option-check";
      if (selected) {
        check.append(lucideIcon(Check, 13));
      }
      const optionLabel = document.createElement("span");
      optionLabel.className = "settings-popup-option-label";
      optionLabel.textContent = resumePolicyLabel(policy);
      option.append(check, optionLabel);
      option.addEventListener("click", () => {
        void persistResumePolicy(policy);
      });
      menu.append(option);
    }
    wrap.append(menu);
  }

  return wrap;
}

function renderClaudeSettingsGroup(overlay: SettingsOverlayState): HTMLElement {
  const group = document.createElement("section");
  group.className = "settings-group";
  group.setAttribute("aria-label", "Claude");

  const heading = document.createElement("p");
  heading.className = "settings-group-heading";
  heading.textContent = "Claude";

  // The territory declaration: provider passthrough is an IA axis, worn
  // visibly but quietly — Duet renders Claude's state, never owns it.
  const territory = document.createElement("p");
  territory.className = "settings-territory-note";
  territory.textContent =
    "Claude Code's own state. Duet shows it here and never changes it without you.";

  const box = document.createElement("div");
  box.className = "settings-box";
  const row = document.createElement("div");
  row.className = "settings-row";

  const copy = document.createElement("div");
  copy.className = "settings-row-copy";
  const title = document.createElement("span");
  title.className = "settings-row-title";
  title.textContent = "Claude's own resume warning";
  copy.append(title);

  const resume = overlay.resume;
  if (overlay.bridgeError) {
    const note = document.createElement("span");
    note.className = "settings-row-note settings-row-note-error";
    note.textContent = "Couldn't update ~/.claude.json — check it manually.";
    copy.append(note);
  } else if (resume?.bridgeDismissed) {
    const note = document.createElement("span");
    note.className = "settings-row-note";
    note.textContent =
      "Turned off by Duet's earlier bridge. Restoring affects terminals outside Duet.";
    copy.append(note);
  }
  row.append(copy);

  const trailing = document.createElement("div");
  trailing.className = "settings-row-trailing";
  const value = document.createElement("span");
  value.className = "settings-value";
  value.textContent = !resume ? "—" : resume.bridgeDismissed ? "Off" : "On";
  trailing.append(value);
  if (resume?.bridgeDismissed) {
    const restore = document.createElement("button");
    restore.className = "secondary settings-restore";
    restore.type = "button";
    restore.disabled = overlay.bridgeReverting;
    restore.textContent = overlay.bridgeReverting ? "Restoring…" : "Restore";
    restore.addEventListener("click", () => {
      void restoreResumeBridge();
    });
    trailing.append(restore);
  }
  row.append(trailing);

  box.append(row);
  group.append(heading, territory, box);
  return group;
}

function handlePromptNavigationKeydown(event: KeyboardEvent): void {
  if (event.isComposing || composerIsComposing || event.keyCode === 229) {
    return;
  }

  if (state.promptNav) {
    if (hasStackedUiOpen()) {
      return;
    }
    if (isPromptNavArrow(event)) {
      event.preventDefault();
      event.stopPropagation();
      movePromptNav(event.key === "ArrowUp" ? -1 : 1);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      exitPromptNav({ focusComposer: true });
      return;
    }
    if (isPrintablePromptNavTyping(event)) {
      event.preventDefault();
      event.stopPropagation();
      exitPromptNav({ focusComposer: true, insertText: event.key });
    }
    return;
  }

  if (!isPromptNavEntryShortcut(event) || hasStackedUiOpen() || !isPromptNavEntryContext(event.target)) {
    return;
  }
  if (enterPromptNav()) {
    event.preventDefault();
    event.stopPropagation();
  }
}

function isPromptNavEntryShortcut(event: KeyboardEvent): boolean {
  return (
    event.key === "ArrowUp" &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  );
}

function isPromptNavArrow(event: KeyboardEvent): boolean {
  const arrow = event.key === "ArrowUp" || event.key === "ArrowDown";
  if (!arrow || event.ctrlKey || event.altKey || event.shiftKey) {
    return false;
  }
  return true;
}

function isPrintablePromptNavTyping(event: KeyboardEvent): boolean {
  return event.key.length === 1 && !event.metaKey && !event.ctrlKey;
}

function isPromptNavEntryContext(target: EventTarget | null): boolean {
  const node = target instanceof Node ? target : null;
  if (!node) {
    return false;
  }
  return (
    elements.composer.contains(node) ||
    elements.runList.contains(node) ||
    document.activeElement === document.body
  );
}

function hasStackedUiOpen(): boolean {
  return Boolean(
    state.readingPopoverOpen ||
      state.composerMenu ||
      state.taskDraft.settingsOpen ||
      state.settingsOverlay,
  );
}

function enterPromptNav(): boolean {
  const targets = promptNavTargets();
  const target = targets.at(-1) ?? null;
  if (!target) {
    return false;
  }
  const selection = composerSelectionSnapshot();
  state.promptNav = {
    taskId: activePromptNavTaskId(),
    turnKey: target.dataset.turnKey ?? "",
    composerSelectionStart: selection.start,
    composerSelectionEnd: selection.end,
  };
  return selectPromptNavTarget(target, { scroll: true });
}

function movePromptNav(delta: -1 | 1): void {
  const targets = promptNavTargets();
  if (targets.length === 0 || !state.promptNav) {
    exitPromptNav({ focusComposer: false });
    return;
  }

  const currentIndex = targets.findIndex((target) => target.dataset.turnKey === state.promptNav?.turnKey);
  const index = currentIndex === -1 ? targets.length - 1 : currentIndex;
  const nextIndex = index + delta;
  if (nextIndex < 0) {
    selectPromptNavTarget(targets[0], { scroll: false });
    return;
  }
  if (nextIndex >= targets.length) {
    exitPromptNav({ focusComposer: true });
    return;
  }
  selectPromptNavTarget(targets[nextIndex], { scroll: true });
}

function selectPromptNavTarget(
  target: HTMLElement | undefined,
  options: { scroll: boolean },
): boolean {
  if (!target) {
    return false;
  }
  const turnKey = target.dataset.turnKey;
  if (!turnKey) {
    return false;
  }
  const previous = state.promptNav;
  const selection = previous ?? {
    composerSelectionStart: elements.promptInput.selectionStart ?? elements.promptInput.value.length,
    composerSelectionEnd: elements.promptInput.selectionEnd ?? elements.promptInput.value.length,
  };
  state.promptNav = {
    taskId: activePromptNavTaskId(),
    turnKey,
    composerSelectionStart: selection.composerSelectionStart,
    composerSelectionEnd: selection.composerSelectionEnd,
  };
  syncPromptNavDomSelection();
  if (options.scroll) {
    target.scrollIntoView({ block: "start", inline: "nearest", behavior: "auto" });
  }
  target.focus({ preventScroll: true });
  return true;
}

function exitPromptNav(options: { focusComposer: boolean; insertText?: string }): void {
  const previous = state.promptNav;
  if (!previous) {
    return;
  }
  state.promptNav = null;
  syncPromptNavDomSelection();
  if (!options.focusComposer) {
    return;
  }
  focusComposerFromPromptNav(previous);
  if (options.insertText !== undefined) {
    insertTextIntoComposer(options.insertText);
  }
}

function focusComposerFromPromptNav(nav: PromptNavState): void {
  if (elements.promptInput.disabled) {
    return;
  }
  elements.promptInput.focus({ preventScroll: true });
  const start = clamp(nav.composerSelectionStart, 0, elements.promptInput.value.length);
  const end = clamp(nav.composerSelectionEnd, start, elements.promptInput.value.length);
  elements.promptInput.setSelectionRange(start, end);
}

function insertTextIntoComposer(text: string): void {
  if (elements.promptInput.disabled) {
    return;
  }
  const start = elements.promptInput.selectionStart ?? elements.promptInput.value.length;
  const end = elements.promptInput.selectionEnd ?? start;
  elements.promptInput.setRangeText(text, start, end, "end");
  elements.promptInput.dispatchEvent(new Event("input", { bubbles: true }));
}

function restorePromptNavAfterRender(): void {
  const nav = state.promptNav;
  if (!nav) {
    return;
  }
  if (nav.taskId !== activePromptNavTaskId()) {
    state.promptNav = null;
    return;
  }
  const target = findPromptNavTarget(nav.turnKey);
  if (!target) {
    state.promptNav = null;
    return;
  }
  syncPromptNavDomSelection();
  target.focus({ preventScroll: true });
}

function syncPromptNavDomSelection(): void {
  const nav = state.promptNav;
  for (const target of promptNavTargets()) {
    const selected =
      nav !== null &&
      nav.taskId === activePromptNavTaskId() &&
      target.dataset.turnKey === nav.turnKey;
    target.classList.toggle("prompt-nav-selected", selected);
    if (selected) {
      target.setAttribute("aria-current", "true");
    } else {
      target.removeAttribute("aria-current");
    }
  }
}

function promptNavTargets(): HTMLElement[] {
  return Array.from(elements.runList.querySelectorAll<HTMLElement>(".turn-prompt"));
}

function findPromptNavTarget(turnKey: string): HTMLElement | null {
  return promptNavTargets().find((target) => target.dataset.turnKey === turnKey) ?? null;
}

function activePromptNavTaskId(): string {
  return state.activeTaskId ?? PROMPT_NAV_DOM_TASK_ID;
}

function composerSelectionSnapshot(): { start: number; end: number } {
  const fallback = elements.promptInput.value.length;
  return {
    start: elements.promptInput.selectionStart ?? fallback,
    end: elements.promptInput.selectionEnd ?? fallback,
  };
}

function scheduleStickyPromptSync(): void {
  if (stickyPromptSyncFrame !== null) {
    return;
  }
  stickyPromptSyncFrame = window.requestAnimationFrame(() => {
    stickyPromptSyncFrame = null;
    syncStickyPromptHeader();
  });
}

function syncStickyPromptHeader(): void {
  const header = elements.runList.querySelector<HTMLButtonElement>(".sticky-prompt-header");
  if (!header) {
    return;
  }
  const candidate = stickyPromptCandidate();
  if (!candidate) {
    hideStickyPromptHeader(header);
    return;
  }

  const listRect = elements.runList.getBoundingClientRect();
  const promptRect = candidate.prompt.getBoundingClientRect();
  if (promptRect.bottom > listRect.top) {
    hideStickyPromptHeader(header);
    return;
  }

  const text = condensedPromptText(candidate.prompt.textContent ?? "");
  header.textContent = text;
  header.title = text;
  header.dataset.turnKey = candidate.card.dataset.turnKey ?? "";
  header.classList.remove("hidden");
}

function hideStickyPromptHeader(header: HTMLButtonElement): void {
  header.classList.add("hidden");
  header.textContent = "";
  header.title = "";
  delete header.dataset.turnKey;
}

function stickyPromptCandidate(): { card: HTMLElement; prompt: HTMLElement } | null {
  const listRect = elements.runList.getBoundingClientRect();
  if (listRect.height <= 0) {
    return null;
  }
  const eyeY = listRect.top + Math.min(96, listRect.height * 0.28);
  const cards = Array.from(elements.runList.querySelectorAll<HTMLElement>(".turn-card"));

  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (rect.top <= eyeY && rect.bottom > eyeY) {
      const prompt = card.querySelector<HTMLElement>(".turn-prompt");
      return prompt ? { card, prompt } : null;
    }
  }

  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (rect.top < listRect.bottom && rect.bottom > listRect.top) {
      const prompt = card.querySelector<HTMLElement>(".turn-prompt");
      if (prompt && prompt.getBoundingClientRect().bottom <= listRect.top) {
        return { card, prompt };
      }
    }
  }

  return null;
}

function scrollToPromptTurn(turnKey: string): void {
  const target = findPromptNavTarget(turnKey);
  target?.scrollIntoView({ block: "start", inline: "nearest", behavior: "auto" });
  scheduleStickyPromptSync();
}

elements.runList.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const anchor = target.closest("a[href]");
  if (!anchor) {
    return;
  }
  event.preventDefault();
  const href = anchor.getAttribute("href") ?? "";
  if (/^https?:\/\//i.test(href)) {
    window.open(href);
  }
});

elements.runList.addEventListener("scroll", () => {
  scheduleStickyPromptSync();
});

elements.runList.addEventListener(
  "toggle",
  () => {
    scheduleStickyPromptSync();
  },
  true,
);

elements.approveApproval.addEventListener("click", () => {
  void decideApproval("approve");
});

elements.approveSessionApproval.addEventListener("click", () => {
  // The middle button mirrors the panel's own option 2 — its decision is
  // whatever the parsed choice carries (session-scoped or persistent).
  const middleChoice = activeTaskView()?.pendingApproval?.choices?.find(
    (choice) => choice.decision === "approve-always" || choice.decision === "approve-for-session",
  );
  void decideApproval(middleChoice?.decision ?? "approve-for-session");
});

elements.denyApproval.addEventListener("click", () => {
  void decideApproval("deny");
});

elements.resumeFull.addEventListener("click", () => {
  void resolveResumeChoice("full");
});

elements.resumeSummary.addEventListener("click", () => {
  void resolveResumeChoice("summary");
});

elements.resumeBridgeRevert.addEventListener("click", () => {
  elements.resumeBridgeRevert.disabled = true;
  void window.duetRuntime
    .revertResumeBridge()
    .then((result) => {
      const view = activeTaskView();
      if (view?.resumeChoice) {
        view.resumeChoice = { ...view.resumeChoice, bridgeDismissed: !result.cleared };
      }
      if (view) {
        view.status = result.cleared
          ? "Claude's own resume warning is back on (outside Duet)"
          : "Couldn't update ~/.claude.json — check it manually";
      }
      render();
    })
    .finally(() => {
      elements.resumeBridgeRevert.disabled = false;
    });
});

window.addEventListener("resize", () => {
  if (state.readingPopoverOpen) {
    syncReadingPopoverAnchor();
    renderReadingPopover();
  }
  scheduleStickyPromptSync();
});

document.addEventListener("keydown", handlePromptNavigationKeydown, true);

document.addEventListener(
  "mousedown",
  () => {
    if (!state.promptNav) {
      return;
    }
    exitPromptNav({ focusComposer: false });
  },
  true,
);

document.addEventListener("click", (event) => {
  const target = event.target;
  if (
    !(target instanceof Element) ||
    target.closest(".reading-settings-trigger") ||
    target.closest(".reading-settings-popover") ||
    target.closest("#remote-control-toggle") ||
    target.closest(".remote-control-popover") ||
    target.closest(".task-settings-wrap") ||
    target.closest(".task-settings-popover") ||
    target.closest(".composer-chip") ||
    target.closest("#add-attachment") ||
    target.closest(".composer-menu") ||
    target.closest(".usage-indicator") ||
    target.closest(".usage-popover") ||
    target.closest(".slash-picker") ||
    target.closest("#prompt-input")
  ) {
    return;
  }
  if (state.composerMenu) {
    state.composerMenu = null;
    render();
  }
  if (state.slashPicker) {
    closeSlashPicker(true);
  }
  if (state.taskDraft.settingsOpen) {
    state.taskDraft.settingsOpen = false;
    state.taskDraft.settingsAnchor = null;
    render();
  }
  if (state.readingPopoverOpen) {
    closeReadingPopover();
  }
  if (state.remoteControlPopoverOpen) {
    closeRemoteControlPopover();
  }
  if (state.usagePopover) {
    closeUsagePopover();
  }
  if (state.sidebar.menu && !target.closest(".sidebar-menu")) {
    closeSidebarMenu();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") {
    return;
  }
  if (state.settingsOverlay) {
    event.preventDefault();
    if (state.settingsOverlay.policyMenuOpen) {
      state.settingsOverlay.policyMenuOpen = false;
      render();
      return;
    }
    closeSettingsOverlay();
    return;
  }
  if (state.readingPopoverOpen) {
    event.preventDefault();
    closeReadingPopover();
    elements.readingSettings.focus();
    return;
  }
  if (state.remoteControlPopoverOpen) {
    event.preventDefault();
    closeRemoteControlPopover();
    elements.remoteControlToggle.focus();
    return;
  }
  if (state.usagePopover) {
    event.preventDefault();
    closeUsagePopover();
    elements.usageIndicator.focus();
  }
});

readingModeQuery.addEventListener("change", () => {
  applySystemReadingMode(readingModeQuery.matches ? "dark" : "light");
});

window.duetRuntime.onReadingSystemModeChanged((mode) => {
  applySystemReadingMode(mode);
});

window.duetRuntime.onSettingsOpen(() => {
  openSettingsOverlay();
});

function applySystemReadingMode(mode: ResolvedReadingMode): void {
  currentSystemReadingMode = mode;
  if (state.readingSettings.mode !== "auto") {
    return;
  }
  applyReadingSettings(state.readingSettings);
  renderReadingPopover();
}

// The runtime-event entry point (map C2): the reducer owns every mutation and
// render-path CHOICE (§1.3 policy-as-data, corpus-fenced); the shell performs
// the returned directive list 1:1, in order. No logic beyond the mapping
// lives here — a directive's payload already carries the reducer's decisions.
window.duetRuntime.onRuntimeEvent((event) => {
  for (const directive of reduceRuntimeEvent(state, event)) {
    performDirective(directive);
  }
});

function performDirective(directive: Directive): void {
  switch (directive.kind) {
    case "full":
      render();
      return;
    case "unread-only":
    case "none":
      // State-only outcomes: the reducer already applied any mutation
      // (unread-only = markViewChanged's background branch).
      return;
    case "sidebar":
      renderSidebar();
      return;
    case "strip-in-place": {
      const view = taskViewForId(state, directive.taskId);
      if (view) {
        updateStatusStripStatusInPlace(view);
      }
      return;
    }
    case "strip-full": {
      const view = taskViewForId(state, directive.taskId);
      if (!view) {
        return;
      }
      updateSidebarSpinnerLiveness(view);
      if (directive.statusStrip) {
        renderStatusStrip(view);
      }
      return;
    }
    case "usage-in-place": {
      const view = taskViewForId(state, directive.taskId);
      if (!view) {
        return;
      }
      renderUsageIndicator(view);
      if (directive.chipChanged) {
        renderComposerControls(view);
      }
      if (directive.popoverOpen) {
        renderComposerPopover(view);
      }
      return;
    }
    case "transcript-debounced":
      scheduleTranscriptRender();
      return;
    case "session-index-debounced":
      scheduleSessionIndexRefresh();
      return;
    case "report-refresh":
      void refreshReport(directive.taskId);
      return;
  }
}

window.duetRuntime.onMainArtifactFocus((request) => {
  focusArtifactFromPreview(request);
});

// A clicked native notification lands us on its task (the window was already
// raised in the main process). selectSession, not activateTask: the task may
// not be materialized yet (opened via the Local API, or not yet hydrated after
// a reload) — runtime events for an unloaded view are dropped, so activateTask
// alone would no-op. selectSession loads the session first, then activates.
window.duetRuntime.onNotificationActivateTask((taskId) => {
  void selectSession(taskId);
});

void hydrateReadingSettings();
// Load the RC default BEFORE the session index makes dormant sessions clickable:
// a dormant view arms from `state.remoteControlDefault` at creation, so the
// default must be in place first (otherwise a fast click arms from a stale off).
void hydrateClaudeDefaults().finally(() => {
  void refreshSessionIndex();
});

render();

async function hydrateTranscript(taskId: string): Promise<void> {
  const view = taskViewForId(state, taskId);
  if (!view?.task) {
    return;
  }
  const response = await window.duetRuntime.readTranscript({ taskId });
  view.transcriptSources = response.sources;
  view.transcriptBlocks = new Map();
  view.transcriptBlockOrder = [];
  for (const block of response.blocks) {
    view.transcriptBlockOrder.push(block.id);
    view.transcriptBlocks.set(block.id, block);
  }
  markViewChanged(view);
}

async function hydrateUsage(taskId: string): Promise<void> {
  const view = taskViewForId(state, taskId);
  if (!view?.task) {
    return;
  }
  view.usageSnapshot = await window.duetRuntime.readUsage({ taskId });
  markViewChanged(view);
}

// The shell's zero-arg convenience over the reading-core helper (the logic
// moved to state.ts at D-mid-0 so views and shell share one definition).
function activeTaskView(): TaskViewState | null {
  return activeTaskViewOf(state);
}

function activateTask(taskId: string): void {
  const view = taskViewForId(state, taskId);
  if (!view) {
    return;
  }
  const switching = state.activeTaskId !== taskId;
  if (switching) {
    saveComposerDraft();
    exitPromptNav({ focusComposer: false });
    state.usagePopover = null;
    clearUsagePopoverTimers();
  }
  state.activeTaskId = taskId;
  if (switching) {
    restoreComposerDraft();
  }
  sessionTransitions.markViewSeen(view);
  render();
}

// The composer text is per-session state, exactly like the attachments beside
// it (pendingAttachments) — a shared DOM textarea must never carry one
// session's words into another. While a session is active the DOM stays the
// live truth (send/slash/reference paths write it directly); these two hooks
// park and restore it at the only moments the composer changes owners. New
// Chat (no active task) has its own slot (state.newChatComposerDraft).

function saveComposerDraft(): void {
  composerTransitions.parkComposerDraft(state, elements.promptInput.value);
}

function restoreComposerDraft(): void {
  const view = activeTaskView();
  elements.promptInput.value = view ? view.composerDraft : state.newChatComposerDraft;
}

function markViewChanged(view: TaskViewState): void {
  if (isActiveView(view)) {
    render();
    return;
  }
  view.unread = true;
}

function isActiveView(view: TaskViewState): boolean {
  return Boolean(view.task && view.task.id === state.activeTaskId);
}

async function createTask(
  provider: RuntimeProvider,
  options: { cwd?: string | null } = {},
): Promise<void> {
  const providerName = providerLabel(provider);
  state.busy = true;
  state.status = `Starting ${providerName}`;
  state.taskDraft.settingsOpen = false;
  state.taskDraft.settingsAnchor = null;
  state.taskDraft.message = {
    tone: "info",
    text: `Starting ${providerName} Task...`,
  };
  render();

  try {
    const launchSettings = taskLaunchSettings(provider);
    const response = await window.duetRuntime.createTask({
      provider,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      model: launchSettings.model,
      reasoningEffort: launchSettings.reasoningEffort,
      speedMode: launchSettings.speedMode,
      approval: "on-request",
      sandbox: "read-only",
      ...(provider === "claude" && state.taskDraft.remoteControl ? { remoteControl: true } : {}),
    });
    const view = createTaskView(response.task, `${providerName} PTY ${response.runtime.pid}`);
    if (provider === "claude" && state.taskDraft.remoteControl) {
      // Spawned with --remote-control: reflect "on" immediately; the scraped URL
      // confirms and fills the link a beat later (~1.2s).
      view.remoteControl.active = true;
    }
    upsertTaskView(state, view);
    activateTask(response.task.id);
    void hydrateTranscript(response.task.id);
    void hydrateUsage(response.task.id);
  } catch (error) {
    const message = errorMessage(error);
    state.status = message;
    state.taskDraft.message = {
      tone: "error",
      text: message,
    };
  } finally {
    state.busy = false;
    render();
  }
}

async function submitPrompt(): Promise<void> {
  const view = activeTaskView();
  const text = elements.promptInput.value.trim();

  if (consumeSlashSubmitGuard(text)) {
    return;
  }
  // A send is already in flight — drop this one (a fast double-Enter would
  // otherwise re-materialize the same attachments: duplicate blob + double send).
  if (composerSending) {
    return;
  }
  // Nothing-to-send checks first, so the guard is never held for a no-op.
  if (!view) {
    if (!text && state.draftAttachments.length === 0) {
      return;
    }
  } else if (!view.task) {
    return;
  } else if (!text && view.pendingAttachments.length === 0) {
    view.status = "Type a message before sending";
    render();
    return;
  }

  composerSending = true;
  try {
    if (!view) {
      // New chat: the first message (text and/or attachments) creates the session.
      await createSessionFromComposer(text);
    } else if (!view.live) {
      // Dormant session: lazy spawn + native resume, then queue the message.
      await resumeSessionAndSend(view, text);
    } else if (view.task) {
      const taskId = view.task.id;
      view.status = "Queued";
      render();
      const attachments = await materializeAttachments(view.pendingAttachments, taskId);
      await window.duetRuntime.submitPrompt({ taskId, text, attachments });
      elements.promptInput.value = "";
      clearComposerAttachments(view.pendingAttachments);
    }
  } catch (error) {
    if (view?.task) {
      view.status = errorMessage(error);
    } else {
      state.status = errorMessage(error);
    }
  } finally {
    composerSending = false;
    render();
  }
}

async function createSessionFromComposer(text: string): Promise<void> {
  await createTask(state.taskDraft.provider, { cwd: state.taskDraft.cwd });
  const view = activeTaskView();
  if (!view?.task) {
    // Creation failed; createTask already surfaced the error.
    return;
  }
  // Deferred creation is an ownership handover: this draft now belongs to the
  // session it just created. createTask→activateTask parked the still-visible
  // text into the New Chat slot a moment ago — consume it, or the next New
  // Chat resurrects an already-sent prompt.
  state.newChatComposerDraft = "";
  try {
    // The session now exists — materialize the held draft (copy bitmaps, pass
    // references through) and deliver with the first prompt.
    const attachments = await materializeAttachments(state.draftAttachments, view.task.id);
    await window.duetRuntime.submitPrompt({ taskId: view.task.id, text, attachments });
    elements.promptInput.value = "";
    clearComposerAttachments(state.draftAttachments);
  } catch (error) {
    view.status = errorMessage(error);
    // The session was created but delivery failed — don't lose the user's
    // words or attachments. The text goes back into the composer the user is
    // now standing in (the new task's), visible and retriable; the attachment
    // draft moves into the task's pending list the same way (keep their
    // preview URLs; don't revoke).
    elements.promptInput.value = text;
    view.pendingAttachments.push(...state.draftAttachments);
    state.draftAttachments.length = 0;
  } finally {
    render();
  }
}

async function resumeSessionAndSend(view: TaskViewState, text: string): Promise<void> {
  if (!view.task) {
    return;
  }
  const taskId = view.task.id;

  // The resume moment (slice C): for a large dormant Claude session with
  // policy "ask", the first send CONVERTS into the choice — the message
  // stays composed and sends right after the user decides.
  let resumeMode: "full" | "summary" | undefined;
  try {
    const preparation = await window.duetRuntime.prepareResume({ taskId });
    if (preparation.needsChoice) {
      view.resumeChoice = {
        idleMs: preparation.idleMs,
        totalTokens: preparation.totalTokens,
        bridgeDismissed: preparation.bridgeDismissed,
      };
      view.status = "Choose how to resume";
      render();
      return;
    }
    if (preparation.overThreshold && preparation.policy !== "ask") {
      resumeMode = preparation.policy;
      // The applied default stays visible — a receipt, not a silent policy.
      view.status =
        preparation.policy === "full"
          ? `Resuming in full (your default · ⌘, to change) — ${resumeCostLabel(preparation.idleMs, preparation.totalTokens)}`
          : `Resuming from summary (your default · ⌘, to change) — /compact runs first`;
      render();
    }
  } catch {
    // Preparation is best-effort context; resume itself proceeds.
  }

  await openDormantSessionAndSend(view, text, resumeMode);
}

async function openDormantSessionAndSend(
  view: TaskViewState,
  text: string,
  resumeMode: "full" | "summary" | undefined,
): Promise<void> {
  if (!view.task) {
    return;
  }
  const taskId = view.task.id;
  state.busy = true;
  if (!view.status.startsWith("Resuming")) {
    view.status = "Resuming session";
  }
  render();
  try {
    const response = await window.duetRuntime.openTask({
      taskId,
      ...(resumeMode ? { resumeMode } : {}),
      ...(view.task.provider === "claude" && dormantArmed(view, state.remoteControlDefault)
        ? { remoteControl: true }
        : {}),
    });
    view.task = response.task;
    view.live = true;
    view.resumeChoice = null;
    view.status = response.resumedProviderSession
      ? "Resumed — your message will send when the agent is ready"
      : "Couldn't restore the agent's memory — continuing as a new session; the history above stays readable";
    // The session is live now — materialize the held items (copy bitmaps, pass
    // references through) and deliver.
    const attachments = await materializeAttachments(view.pendingAttachments, taskId);
    if (text || attachments.length > 0) {
      await window.duetRuntime.submitPrompt({ taskId, text, attachments });
      elements.promptInput.value = "";
      clearComposerAttachments(view.pendingAttachments);
    }
    void hydrateUsage(taskId);
  } catch (error) {
    view.status = errorMessage(error);
  } finally {
    state.busy = false;
    render();
  }
}

async function resolveResumeChoice(mode: "full" | "summary"): Promise<void> {
  const view = activeTaskView();
  if (!view?.task || !view.resumeChoice) {
    return;
  }
  if (elements.resumeRemember.checked) {
    // The moment is where the setting is born; the chooser collapses for
    // future resumes and the policy lives in Duet's own settings store.
    // Provenance marks the birth so the Settings page can attribute it.
    try {
      await window.duetRuntime.writeResumeSettings({
        policy: mode,
        provenance: { source: "moment", at: new Date().toISOString() },
      });
    } catch {
      // Remembering is best-effort; the chosen resume still proceeds.
    }
  }
  view.resumeChoice = null;
  elements.resumeRemember.checked = false;
  const text = elements.promptInput.value.trim();
  await openDormantSessionAndSend(view, text, mode);
}

function resumeCostLabel(idleMs: number | null, totalTokens: number | null): string {
  const parts: string[] = [];
  if (idleMs !== null) {
    parts.push(`idle ${formatIdleDuration(idleMs)}`);
  }
  if (totalTokens !== null) {
    parts.push(`~${formatTokenCount(totalTokens)} tokens`);
  }
  return parts.join(" · ") || "size unknown";
}

async function decideApproval(decision: ApprovalDecision): Promise<void> {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }

  state.busy = true;
  render();
  try {
    await window.duetRuntime.decideApproval({
      taskId: view.task.id,
      decision,
      approvalId: view.pendingApproval?.approvalId ?? null,
    });
  } catch (error) {
    view.status = errorMessage(error);
  } finally {
    state.busy = false;
    render();
  }
}

async function stopRun(): Promise<void> {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }

  view.status = "Stopped";
  render();
  try {
    await window.duetRuntime.stopRun({ taskId: view.task.id, inspectDelayMs: 6000 });
  } catch (error) {
    view.status = errorMessage(error);
  } finally {
    render();
  }
}

async function refreshReport(taskId = state.activeTaskId): Promise<void> {
  if (!taskId) {
    return;
  }
  const view = taskViewForId(state, taskId);
  if (!view?.task) {
    return;
  }

  view.report = await window.duetRuntime.readReport({ taskId: view.task.id });
  markViewChanged(view);
}


// Relay the active task (and its live-ness) to the terminal window, deduped so
// render()'s frequent calls don't spam IPC. The terminal window shows this
// task's terminal and forwards keystrokes only while it is live.
// (`lastPushedTerminalTask` is declared with the early module state above.)
function pushActiveTerminalTask(): void {
  const taskId = state.activeTaskId ?? null;
  const live = Boolean(activeTaskView()?.live);
  const openTaskIds = state.taskViews
    .map((view) => view.task?.id)
    .filter((id): id is string => Boolean(id));
  const key = `${taskId}:${live}:${openTaskIds.join(",")}`;
  if (key === lastPushedTerminalTask) {
    return;
  }
  lastPushedTerminalTask = key;
  void window.duetRuntime.setActiveTerminalTask({ taskId, live, openTaskIds }).catch(() => {});
}

function render(): void {
  const view = activeTaskView();
  pushActiveTerminalTask();
  elements.taskTitle.textContent = view?.task?.title ?? "New chat";
  const composerStatus = composerStatusText(view);
  elements.runtimeStatus.textContent = composerStatus;
  elements.runtimeStatus.classList.toggle("hidden", composerStatus === "");
  elements.openPreviewWindow.disabled = !view?.task || state.busy;
  elements.openInspectorWindow.disabled = !view?.task || state.busy;
  elements.sessionMenuTrigger.classList.toggle("hidden", !view?.task);
  elements.sidebarNewChat.disabled = state.busy;
  renderReadingPopover();
  renderRemoteControl();
  renderRemoteControlPopover();
  renderTaskSettingsPopover();
  renderSettingsOverlay();
  renderAttachmentStrip(view);
  renderComposerControls(view);
  renderComposerPopover(view);

  renderSidebar();
  renderApproval();
  renderOptionPrompt();
  renderResumeChoice();
  renderAttentionBanners(view);
  renderStatusStrip(view);
  renderRuns();
}

// --- Slash command picker -------------------------------------------------
//
// Input assistance over a pure passthrough pipe: the picker helps discover
// and complete commands, but typed text always reaches the PTY verbatim.
// The only submit-time interventions are safety guards backed by probe
// evidence (spikes/slash-probes): bare "/" and unmatched prefixes dispatch
// the CLI's first popup item when blind-injected, so they never leave duet
// without confirmation; bare native-menu commands (/model, /permissions)
// open the duet menu instead of an invisible TUI panel.

const SLASH_COMMANDS_CACHE_TTL_MS = 10_000;
const slashCommandsCache = new Map<string, { at: number; response: SlashCommandsResponse }>();
let slashPickerDismissedValue: string | null = null;
let pendingUnknownSlashText: string | null = null;

function composerSlashProvider(): RuntimeProvider {
  return activeTaskView()?.task?.provider ?? state.taskDraft.provider;
}

function slashCommandsCacheKey(): string {
  const view = activeTaskView();
  if (view?.task) {
    return `task:${view.task.id}`;
  }
  return `draft:${state.taskDraft.provider}:${state.taskDraft.cwd ?? ""}`;
}

function cachedSlashCommands(): SlashCommandsResponse | null {
  const cached = slashCommandsCache.get(slashCommandsCacheKey());
  return cached ? cached.response : null;
}

function refreshSlashCommands(): void {
  const key = slashCommandsCacheKey();
  const cached = slashCommandsCache.get(key);
  if (cached && Date.now() - cached.at < SLASH_COMMANDS_CACHE_TTL_MS) {
    return;
  }
  const view = activeTaskView();
  const request = view?.task
    ? { taskId: view.task.id }
    : { provider: state.taskDraft.provider, ...(state.taskDraft.cwd ? { cwd: state.taskDraft.cwd } : {}) };
  void window.duetRuntime
    .readSlashCommands(request)
    .then((response) => {
      slashCommandsCache.set(key, { at: Date.now(), response });
      if (state.slashPicker && slashCommandsCacheKey() === key) {
        composerTransitions.installSlashEntries(state, response.entries);
        renderComposerPopover();
      }
    })
    .catch(() => {
      // Discovery is assistance, not a gate — typing still works without it.
    });
}

function syncSlashPicker(): void {
  if (composerIsComposing) {
    return;
  }
  const value = elements.promptInput.value;
  if (value !== slashPickerDismissedValue) {
    slashPickerDismissedValue = null;
  }
  if (value !== pendingUnknownSlashText) {
    pendingUnknownSlashText = null;
  }
  const shouldOpen =
    /^\/\S*$/.test(value) && slashPickerDismissedValue === null && !elements.promptInput.disabled;
  if (!shouldOpen) {
    if (composerTransitions.closeSlashPicker(state)) {
      renderComposerPopover();
    }
    return;
  }
  composerTransitions.openOrRefreshSlashPicker(
    state,
    composerSlashProvider(),
    value.slice(1).toLowerCase(),
    () => cachedSlashCommands()?.entries ?? [],
  );
  refreshSlashCommands();
  renderComposerPopover();
}

function closeSlashPicker(dismissCurrentValue: boolean): void {
  if (dismissCurrentValue) {
    slashPickerDismissedValue = elements.promptInput.value;
  }
  if (composerTransitions.closeSlashPicker(state)) {
    renderComposerPopover();
  }
}

function moveSlashSelection(delta: number): void {
  if (composerTransitions.moveSlashSelection(state, delta)) {
    renderComposerPopover();
  }
}

function selectedSlashEntry(): SlashCommandEntry | null {
  const picker = state.slashPicker;
  if (!picker) {
    return null;
  }
  return filteredSlashItems(picker)[picker.selectedIndex] ?? null;
}

/** Fill the entry's canonical invocation into the composer without executing. */
function completeSlashEntry(entry: SlashCommandEntry): void {
  elements.promptInput.value = `${entry.invocation} `;
  elements.promptInput.focus({ preventScroll: true });
  elements.promptInput.setSelectionRange(
    elements.promptInput.value.length,
    elements.promptInput.value.length,
  );
  composerTransitions.closeSlashPicker(state);
  renderComposerPopover();
  renderComposerControls();
}

function executeSlashEntry(entry: SlashCommandEntry): void {
  if (classifySlashIntent(entry) === "skill") {
    // Skills complete instead of executing: a premature skill invocation
    // costs a full model turn, while a second Enter on an args-less skill
    // costs nothing.
    completeSlashEntry(entry);
    return;
  }
  // Passthrough (everything else): an argument hint still completes (let the
  // user add args) rather than firing a turn prematurely; otherwise execute
  // directly, matching the CLIs' own Enter-dispatches semantics. A command
  // that opens a panel opens it in the co-visible terminal window (S3).
  if (entry.argumentHint) {
    completeSlashEntry(entry);
    return;
  }
  elements.promptInput.value = entry.invocation;
  composerTransitions.closeSlashPicker(state);
  renderComposerPopover();
  void submitPrompt();
}

function handleSlashPickerKeydown(event: KeyboardEvent): boolean {
  const picker = state.slashPicker;
  if (!picker || composerIsComposing) {
    return false;
  }
  if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
    event.preventDefault();
    moveSlashSelection(1);
    return true;
  }
  if (event.key === "ArrowUp" || (event.key === "p" && event.ctrlKey)) {
    event.preventDefault();
    moveSlashSelection(-1);
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeSlashPicker(true);
    return true;
  }
  if (event.key === "Tab" && !event.shiftKey) {
    const entry = selectedSlashEntry();
    if (entry) {
      event.preventDefault();
      completeSlashEntry(entry);
      return true;
    }
    return false;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    const entry = selectedSlashEntry();
    if (entry) {
      event.preventDefault();
      executeSlashEntry(entry);
      return true;
    }
    // No match: fall through to the normal submit path; the submit guard
    // owns the unknown-command caution.
  }
  return false;
}

/**
 * Submit-time guard for "/" texts. Returns true when the submit should stop
 * here. Everything known submits verbatim (S3): a panel command opens its
 * panel in the co-visible terminal window. Two local niceties survive: the
 * bare-"/" hint, and a double-Enter confirm on unknown commands (most often a
 * typo; the CLI reports a real unknown locally without involving the model).
 */
function consumeSlashSubmitGuard(text: string): boolean {
  if (!text.startsWith("/")) {
    pendingUnknownSlashText = null;
    return false;
  }
  if (text === "/") {
    composerStatusHint("Type a command name after “/” — Esc to dismiss");
    return true;
  }
  const registry = cachedSlashCommands();
  if (!registry || registry.provider !== composerSlashProvider()) {
    // No registry yet: stay out of the way. The CLI reports unknown
    // commands locally without involving the model.
    refreshSlashCommands();
    return false;
  }
  const token = text.slice(1).split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  const known = registry.entries.some((candidate) => candidate.name.toLowerCase() === token);
  if (known || pendingUnknownSlashText === text) {
    pendingUnknownSlashText = null;
    return false;
  }
  pendingUnknownSlashText = text;
  composerStatusHint(
    `Unknown ${providerLabel(composerSlashProvider())} command — press Enter again to send it anyway`,
  );
  return true;
}

function composerStatusHint(text: string): void {
  const view = activeTaskView();
  if (view) {
    view.status = text;
  } else {
    state.taskDraft.message = { tone: "info", text };
  }
  render();
}


function toggleComposerMenu(type: ComposerMenuState["type"], anchor: HTMLElement): void {
  clearUsagePopoverTimers();
  const rect = anchor.getBoundingClientRect();
  popoverTransitions.toggleComposerMenu(state, type, {
    left: rect.left,
    top: rect.top,
    width: rect.width,
  });
  render();
}

function scheduleUsagePopoverOpen(): void {
  clearUsagePopoverCloseTimer();
  if (usagePopoverOpenTimer !== null) {
    window.clearTimeout(usagePopoverOpenTimer);
  }
  usagePopoverOpenTimer = window.setTimeout(() => {
    usagePopoverOpenTimer = null;
    openUsagePopover(false);
  }, USAGE_POPOVER_OPEN_DELAY_MS);
}

function scheduleUsagePopoverClose(): void {
  clearUsagePopoverOpenTimer();
  if (state.usagePopover?.pinned) {
    return;
  }
  clearUsagePopoverCloseTimer();
  usagePopoverCloseTimer = window.setTimeout(() => {
    usagePopoverCloseTimer = null;
    closeUsagePopover();
  }, USAGE_POPOVER_CLOSE_DELAY_MS);
}

function toggleUsagePopover(): void {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }
  clearUsagePopoverTimers();
  if (state.usagePopover?.pinned) {
    closeUsagePopover();
    return;
  }
  openUsagePopover(true);
}

function openUsagePopover(pinned: boolean): void {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }
  popoverTransitions.openUsagePopover(state, pinned);
  render();
}

function closeUsagePopover(): void {
  clearUsagePopoverTimers();
  if (!popoverTransitions.closeUsagePopover(state)) {
    return;
  }
  render();
}

function clearUsagePopoverTimers(): void {
  clearUsagePopoverOpenTimer();
  clearUsagePopoverCloseTimer();
}

function clearUsagePopoverOpenTimer(): void {
  if (usagePopoverOpenTimer !== null) {
    window.clearTimeout(usagePopoverOpenTimer);
    usagePopoverOpenTimer = null;
  }
}

function clearUsagePopoverCloseTimer(): void {
  if (usagePopoverCloseTimer !== null) {
    window.clearTimeout(usagePopoverCloseTimer);
    usagePopoverCloseTimer = null;
  }
}

async function pickAndAddReferences(): Promise<void> {
  let paths: string[];
  try {
    paths = await window.duetRuntime.pickReferences();
  } catch (error) {
    setComposerStatus(activeTaskView(), errorMessage(error));
    return;
  }
  if (paths.length > 0) {
    await addReferences(paths);
  }
}

// Route dropped/pasted Files by the one fact that matters: does it already have
// a path on disk? A real Electron file (drag/paste of a file, or the picker)
// has a path → REFERENCE it (no copy). A path-less image (clipboard bitmap /
// screenshot) has no path → COPY it. webUtils.getPathForFile returns "" for a
// bitmap — that is the discriminator.
async function intakeFiles(files: File[]): Promise<void> {
  if (files.length === 0) {
    return;
  }
  const bitmaps: File[] = [];
  const referencePaths: string[] = [];
  for (const file of files) {
    const filePath = window.duetRuntime.getPathForFile(file);
    if (filePath) {
      referencePaths.push(filePath);
    } else if (isSupportedImageFile(file)) {
      bitmaps.push(file);
    }
  }
  if (referencePaths.length === 0 && bitmaps.length === 0) {
    // We prevented the default paste/drop but found nothing attachable (e.g. a
    // path-less, unsupported clipboard item) — say so instead of doing nothing.
    setComposerStatus(activeTaskView(), "Nothing attachable here — try a file, folder, or image.");
    return;
  }
  if (referencePaths.length > 0) {
    await addReferences(referencePaths);
  }
  if (bitmaps.length > 0) {
    addBitmaps(bitmaps);
  }
}

/** The composer attachment list for the current surface: a live task's pending
 *  list, or the new-chat draft. */
function composerAttachmentList(): ComposerAttachment[] {
  const view = activeTaskView();
  return view?.task ? view.pendingAttachments : state.draftAttachments;
}

// Path-less image bitmaps (screenshots, copied images) → held as a File and
// copied into the blob dir only on send (lazy). Chipped with a thumbnail.
function addBitmaps(files: File[]): void {
  const list = composerAttachmentList();
  for (const file of files) {
    list.push({
      file,
      reference: null,
      previewUrl: URL.createObjectURL(file),
      name: file.name,
      kind: "image",
    });
  }
  render();
}

// User paths (dragged/pasted files, picked files/folders) → referenced by
// absolute path, never copied. createReference classifies + returns a capped
// thumbnail for images; files/folders fall back to a kind icon.
async function addReferences(paths: string[]): Promise<void> {
  let references: ReferenceResult[];
  try {
    references = await window.duetRuntime.createReference({ paths });
  } catch (error) {
    setComposerStatus(activeTaskView(), errorMessage(error));
    return;
  }
  const list = composerAttachmentList();
  for (const { attachment, previewDataUrl } of references) {
    list.push({
      file: null,
      reference: attachment,
      previewUrl: previewDataUrl,
      name: attachment.originalName,
      kind: attachment.kind,
    });
  }
  // createReference skips paths that vanished / are inaccessible — don't drop them
  // silently (Invariant 5): say how many made it.
  if (references.length < paths.length) {
    setComposerStatus(
      activeTaskView(),
      `Attached ${references.length} of ${paths.length} — the rest were unavailable.`,
    );
    return;
  }
  render();
}

/** Surface a composer status on the active view, or globally for a new chat. */
// view.status is the point-of-action message channel — errors, receipts
// ("Allow rule saved…", resume-default receipts), hints, delivery states. It
// renders as a slim line inside the composer (setComposerStatus was always
// named for it; until 2026-07-03 it rendered as a header chrome pill). Pure
// activity mirrors are suppressed: the status strip and the sidebar spinner
// already say "working"/"idle", and repeating them near the send button was
// the header chip's noise all over again. Suppression is value-based on the
// handful of mirror strings (inlined — module-level render() runs before any
// later const initializes) — a new status value SHOWS by default.
function composerStatusText(view: TaskViewState | null): string {
  const status = view?.status ?? state.status;
  if (
    status === "Idle" ||
    status === "Ready" ||
    status === "Running" ||
    status.endsWith(" is working")
  ) {
    return "";
  }
  // The spawn receipt ("Claude PTY 12345") is boot plumbing, not a message.
  if (/^\S+ PTY \d+$/.test(status)) {
    return "";
  }
  return status;
}

function setComposerStatus(view: TaskViewState | null, message: string): void {
  if (view?.task) {
    view.status = message;
  } else {
    state.status = message;
  }
  render();
}

/** Remove a held composer attachment. Renderer-only: nothing is on disk yet — a
 *  bitmap is copied only on send, a reference is never copied — so dropping the
 *  chip (and revoking any object URL) is the entire removal. Never touches a
 *  user's original (Invariant 4). */
function removeComposerAttachment(list: ComposerAttachment[], target: ComposerAttachment): void {
  const index = list.indexOf(target);
  if (index === -1) {
    return;
  }
  const [removed] = list.splice(index, 1);
  if (removed?.previewUrl) {
    URL.revokeObjectURL(removed.previewUrl);
  }
  render();
}

function clearComposerAttachments(list: ComposerAttachment[]): void {
  for (const item of list) {
    if (item.previewUrl) {
      URL.revokeObjectURL(item.previewUrl);
    }
  }
  list.length = 0;
}

/** Turn the held items into DeliveryAttachments for the prompt: a bitmap is
 *  copied into the (now live) task's blob dir; a reference passes through (never
 *  copied). The runtime is always live by the time this runs (createTask /
 *  openTask have spawned it). */
async function materializeAttachments(
  items: ComposerAttachment[],
  taskId: string,
): Promise<DeliveryAttachment[]> {
  const attachments: DeliveryAttachment[] = [];
  for (const item of items) {
    if (item.reference) {
      attachments.push(item.reference);
    } else if (item.file) {
      // Narrow the opaque handle back to File (shell-side; see ComposerAttachment.file).
      const file = item.file as File;
      const bytes = await file.arrayBuffer();
      attachments.push(
        await window.duetRuntime.createAttachment({
          taskId,
          originalName: file.name,
          mediaType: file.type,
          bytes,
        }),
      );
    }
  }
  return attachments;
}

function isSupportedImageFile(file: File): boolean {
  return SUPPORTED_IMAGE_MIME_TYPES.has(file.type) || SUPPORTED_IMAGE_EXTENSIONS.has(fileExtension(file.name));
}

function hasFileTransfer(dataTransfer: DataTransfer | null): boolean {
  return Array.from(dataTransfer?.items ?? []).some((item) => item.kind === "file");
}


async function answerOptionPrompt(): Promise<void> {
  const view = activeTaskView();
  const prompt = view?.pendingOptionPrompt ?? null;
  if (!view?.task || !prompt) {
    return;
  }
  const selections = view.optionPromptSelections;
  if (
    selections.length !== prompt.questions.length ||
    selections.some((selection) => selection < 0)
  ) {
    return; // not every question answered yet
  }

  view.optionPromptBusy = true;
  renderOptionPrompt();
  try {
    await window.duetRuntime.answerOptionPrompt({
      taskId: view.task.id,
      toolUseId: prompt.toolUseId,
      optionIndices: [...selections],
    });
    // Optimistic receipt from the local choice; the resolved event upgrades it
    // to the provider's verbatim labels (receipt-by-observation).
    view.optionPromptReceipt = {
      toolUseId: prompt.toolUseId,
      reconciled: false,
      lines: optimisticReceiptLines(prompt, selections),
    };
    view.pendingOptionPrompt = null;
    view.optionPromptBusy = false;
    view.status = "Answer sent";
    markViewChanged(view);
  } catch (error) {
    view.optionPromptBusy = false;
    view.status = errorMessage(error);
    markViewChanged(view);
  }
}


async function pickTaskFolder(): Promise<void> {
  state.busy = true;
  state.status = "Choosing Task Folder";
  state.taskDraft.settingsOpen = false;
  state.taskDraft.settingsAnchor = null;
  state.taskDraft.message = {
    tone: "info",
    text: "Choose the folder where this Task should run.",
  };
  render();

  try {
    const response = await window.duetRuntime.pickFolder();
    if (response.path) {
      sessionTransitions.applyPickedTaskFolder(state, response.path);
    }
  } catch (error) {
    const message = errorMessage(error);
    state.status = message;
    state.taskDraft.message = {
      tone: "error",
      text: message,
    };
  } finally {
    state.busy = false;
    render();
  }
}

function taskLaunchSettings(provider: RuntimeProvider): {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  speedMode: LaunchSpeedMode | null;
} {
  return {
    model: state.taskDraft.model[provider],
    reasoningEffort: state.taskDraft.reasoningEffort[provider],
    speedMode: state.taskDraft.speedMode[provider],
  };
}

function scheduleTranscriptRender(): void {
  if (transcriptRenderTimer !== null) {
    return;
  }
  transcriptRenderTimer = window.setTimeout(() => {
    transcriptRenderTimer = null;
    renderTranscriptStream();
  }, 160);
}

// The transcript-streaming render path — decoupled from full render() so a
// content batch never rebuilds the sidebar (which would restart the spinner's
// CSS animation on every batch). Refresh only what new transcript content can
// change: the reading surface (renderRuns), and the status strip's
// transcript-derived pieces (the running-agent roster and the derived
// "current step" fallback — its agents area is signature-guarded, so a batch
// that doesn't change roster membership never restarts the dots). Run
// lifecycle, approvals, delivery, usage, and status each arrive as their own
// events and render themselves, so nothing else goes stale between batches.
//
// Boundary (S0.2 close-out): this closes the *spinner* during streaming, NOT
// the *selection* — renderRuns still replaceChildren the whole runList, so a
// selection is cleared on each content batch. Selection-surviving incremental
// run rendering is S1.
function renderTranscriptStream(): void {
  renderRuns();
  renderStatusStrip();
}

async function openFloatingPreview(): Promise<void> {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }

  await window.duetRuntime.openPreview({ taskId: view.task.id });
}

async function openFloatingInspector(): Promise<void> {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }

  await window.duetRuntime.openInspector({
    taskId: view.task.id,
  });
}


/** Switch the active task's surface (Read ⇄ Terminal). Per-task: only the active
 *  task is touched. Leaving Terminal hands the keys back — control must never be
 *  held where the human can't type (model Y). Entering Terminal attaches + fits
 *  the xterm once the pane is visible. */
function surfaceTerminalWindow(): void {
  void window.duetRuntime.setTerminalWindowOpen(true).catch(() => {});
}

function setViewMode(mode: ViewMode): void {
  // The terminal is its own window now: "switch to terminal" opens and focuses
  // it, and there is no in-pane Read/Terminal switch to toggle. Keeping this as
  // the single choke point lets every "surface the terminal" caller (approvals,
  // modals, slash commands, the delivery queue) keep working unchanged.
  if (mode === "terminal") {
    surfaceTerminalWindow();
  }
}


// "Show in main" from the Preview window: activate the task and, when the
// request names a run, highlight and scroll to it. The artifact-strip scroll
// target retired with the strip (2026-07-03).
function focusArtifactFromPreview(request: FocusArtifactInMainRequest): void {
  const view = taskViewForId(state, request.taskId);
  if (!view?.task) {
    return;
  }

  if (state.activeTaskId !== request.taskId) {
    saveComposerDraft();
    state.activeTaskId = request.taskId;
    restoreComposerDraft();
  }
  view.unread = false;
  if (request.runId) {
    view.highlightedRunId = request.runId;
  }
  render();

  queueMicrotask(() => {
    if (request.runId) {
      scrollRunIntoView(request.runId);
    }
  });
}

function focusRun(runId: string): void {
  const view = activeTaskView();
  if (view) {
    view.highlightedRunId = runId;
  }
  render();
  queueMicrotask(() => {
    scrollRunIntoView(runId);
  });
}

function scrollRunIntoView(runId: string): void {
  const runCard = Array.from(elements.runList.querySelectorAll<HTMLElement>(".turn-card")).find(
    (item) => item.dataset.runId === runId,
  );
  runCard?.scrollIntoView({ block: "center" });
}

function focusComposer(): void {
  elements.promptInput.focus();
}

function isComposerCompositionShortcut(event: KeyboardEvent): boolean {
  if (event.key !== "Enter" && event.key !== "Escape") {
    return false;
  }
  if (event.isComposing || composerIsComposing || event.keyCode === 229) {
    return true;
  }
  return performance.now() - lastComposerCompositionEndAt < COMPOSITION_END_SHORTCUT_GUARD_MS;
}
