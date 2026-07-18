import {
  CaseSensitive,
  Ellipsis,
  Eye,
  PanelLeft,
  Plus,
  Smartphone,
  SquareTerminal,
} from "lucide";
import "./styles.css";
import {
  normalizeClaudeSettings,
  normalizeCodexSettings,
  normalizeReadingSettings,
  normalizeResumeSettings,
  isCliActionRequest,
  type ClaudeDefaultPermissionMode,
  type ClaudeSettings,
  type CodexPermissionMode,
  type CodexSettings,
  type ReadingSettings,
  type ResolvedReadingMode,
  type ResumePolicyId,
  type ResumeSettings,
} from "../shared/types";
import type {
  RuntimeProvider,
  SlashCommandEntry,
  SlashCommandsResponse,
} from "../shared/types";
import { classifySlashIntent } from "../shared/slash/intent";
import {
  clamp,
  errorMessage,
  providerLabel,
} from "../reading-core/selectors/formatters";
import { filteredSlashItems } from "../reading-core/selectors/composer";
import { reasoningOptionsForModel, speedOptionsForModel } from "../reading-core/config";
import {
  dormantArmed,
  hasActiveRun,
  remoteControlContext,
} from "../reading-core/selectors/runs";
import {
  SIDEBAR_PREFS_DEFAULTS,
  activeTaskView as activeTaskViewOf,
  createInitialState,
  isSessionLifecycleActive,
  optionPromptDraftAnswered,
  type ComposerMenuState,
  type PopoverAnchor,
  type RendererState,
  type SidebarPrefs,
  type TaskDraftMenuKind,
  type TaskViewState,
} from "../reading-core/state";
import { reduceRuntimeEvent } from "../reading-core/runtime-reducer";
import { appendToDraft } from "../reading-core/quote-comment";
import * as composerTransitions from "../reading-core/transitions/composer";
import * as popoverTransitions from "../reading-core/transitions/popovers";
import * as sessionTransitions from "../reading-core/transitions/session";
import * as sidebarTransitions from "../reading-core/transitions/sidebar";
import * as renameTransitions from "../reading-core/transitions/rename";
import { initActions } from "./actions";
import { elements, initDom } from "./dom";
import {
  composerStatusHint,
  hasFileTransfer,
  initAttachmentFlows,
  intakeFiles,
  pickAndAddReferences,
  removeComposerAttachment,
} from "./flows/attachments";
import {
  answerOptionPrompt,
  dismissOptionPrompt,
  archiveProjectFromSidebar,
  archiveSessionFromSidebar,
  decideApproval,
  deleteSessionFromSidebar,
  initSessionFlows,
  openFloatingPreview,
  pickTaskFolder,
  refreshReport,
  refreshSessionIndex,
  resolveResumeChoice,
  resumeTaskWithoutPrompt,
  selectSession,
  setViewMode,
  startNewChat,
  startCliWithoutPrompt,
  stopRun,
  submitPrompt,
  surfaceTerminalWindow,
  unarchiveSessionFromSidebar,
} from "./flows/session-flows";
import {
  commitActiveRename,
  completeRenameComposition,
  initRenameFlows,
  noteRenamePointerClickBoundary,
  noteRenamePointerDown,
  noteRenamePointerSettled,
  noteRenameWindowBlur,
  prepareSidebarStructureChange,
  runAfterRename,
  startProjectRename,
  startSessionRename,
} from "./flows/rename-flows";
import {
  initRender,
  performDirective,
  render,
  renderTranscriptStream,
  syncActiveTerminalTaskBinding,
} from "./render";
import {
  clearUsagePopoverCloseTimer,
  clearUsagePopoverTimers,
  initScheduler,
  scheduleSessionIndexRefresh,
  scheduleTranscriptRender,
  scheduleUsagePopoverClose,
  scheduleUsagePopoverOpen,
  startStripClockTicker,
} from "./scheduler";
import { initApprovalsView, renderOptionPrompt } from "./view/approvals";
import { initBannersView, renderAttentionBanners, setCodexHooksMissing } from "./view/banners";
import {
  applyTerminalWindowState,
  initChromeView,
  renderReadingPopover,
  renderRemoteControlPopover,
} from "./view/chrome";
import {
  initComposerView,
  renderComposerControls,
  renderComposerPopover,
} from "./view/composer";
import { initEntryView, renderTaskEntryPanel } from "./view/entry";
import { lucideIcon } from "./view/icons";
import { initTooltips } from "./view/tooltip";
import {
  exitPromptNav,
  handlePromptNavigationKeydown,
  initPromptNavView,
  restorePromptNavAfterRender,
  scheduleStickyPromptSync,
  scrollToPromptTurn,
} from "./view/prompt-nav";
import {
  closeSidebarMenu,
  initSidebarView,
  openSidebarMenuForSession,
  renderSidebar,
} from "./view/sidebar";
import {
  focusProtectedRenameEditor,
  initRenameEditorView,
  refreshProtectedRenameEditor,
  restoreRenameTabFocusIntent,
} from "./view/rename-editor";
import { initSettingsView } from "./view/settings";
import { positionSlashPicker, renderSlashPicker } from "./view/slash-picker";
import { initStatusStripView } from "./view/status-strip";
import { initTranscriptView } from "./view/transcript";
import { initTranscriptChips, transcriptChipTarget } from "./view/transcript-chips";
import { initQuoteComment } from "./view/quote-comment";
import { initReadingNavigation } from "./view/reading-navigation";

const readingModeQuery = window.matchMedia("(prefers-color-scheme: dark)");
let currentSystemReadingMode: ResolvedReadingMode = readingModeQuery.matches ? "dark" : "light";

const state: RendererState = createInitialState(bootReadingSettingsFromDom());

const SIDEBAR_PREFS_KEY = "sonata.sidebar.prefs";

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


const COLLAPSED_PROJECTS_KEY = "sonata.sidebar.collapsed-projects";

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
// side effects of new modules (R4). The referenced implementations are
// hoisted function declarations, so binding here (before their textual
// definitions) is safe.
initRender(state, {
  scheduleTranscriptRender: () => scheduleTranscriptRender(),
  scheduleSessionIndexRefresh: () => scheduleSessionIndexRefresh(),
  refreshReport: (taskId) => refreshReport(taskId),
});
initSessionFlows(state, {
  closeSidebarMenu: () => closeSidebarMenu(),
  exitPromptNav: (options) => exitPromptNav(options),
  renderOptionPrompt: () => renderOptionPrompt(),
  renderSidebar: () => renderSidebar(),
  syncActiveTerminalTaskBinding: () => syncActiveTerminalTaskBinding(),
  clearUsagePopoverTimers: () => clearUsagePopoverTimers(),
  consumeSlashSubmitGuard: (text) => consumeSlashSubmitGuard(text),
});
initAttachmentFlows(state);
initScheduler(state, {
  renderTranscriptStream: () => renderTranscriptStream(),
  refreshSessionIndex: () => refreshSessionIndex(),
  openUsagePopover: (pinned) => openUsagePopover(pinned),
  closeUsagePopover: () => closeUsagePopover(),
});
initEntryView(state);
initTranscriptView(state, { composeEntryPanel: renderTaskEntryPanel });
initTranscriptChips(state, {
  resolvePaths: (taskId, candidates) =>
    window.sonataRuntime.resolveWorkspacePaths({ taskId, candidates }).then((r) => r.existing),
});
initQuoteComment({
  appendToComposer: (paragraph) => {
    // D5 — append at the end (blank-line separated). Set the value, then run the
    // SAME post-input path as typing (D6 — no focus steal): the input event
    // drives renderComposerControls + syncSlashPicker (the listener at
    // main.ts's composer wiring below).
    elements.promptInput.value = appendToDraft(elements.promptInput.value, paragraph);
    elements.promptInput.dispatchEvent(new Event("input"));
  },
  // Identity of whose draft the shared textarea currently holds (same shape as
  // slashCommandsCacheKey): a live task by id, else the new-chat draft. A confirm
  // whose captured token no longer matches is dropped (cross-session guard).
  composerOwnerToken: () => {
    const view = activeTaskView();
    return view?.task ? `task:${view.task.id}` : "draft";
  },
});
initBannersView(state);
initStatusStripView(state);
initApprovalsView(state);
initSidebarView(state);
initRenameEditorView(state);
initRenameFlows(state, {
  refreshProtectedRenameEditor: (editor) => refreshProtectedRenameEditor(editor),
  focusProtectedRenameEditor: (editor) => focusProtectedRenameEditor(editor),
  restoreRenameTabFocusIntent: (editor) => restoreRenameTabFocusIntent(editor),
});
initComposerView(state);
initSettingsView(state);
initChromeView(state, { resolvedReadingMode: () => resolvedReadingMode() });
initPromptNavView(state, { isComposerComposing: () => composerIsComposing });
initReadingNavigation();
initActions({
  setViewMode: (mode) => setViewMode(mode),
  scrollToPromptTurn: (turnKey) => scrollToPromptTurn(turnKey),
  restorePromptNavAfterRender: () => restorePromptNavAfterRender(),
  scheduleStickyPromptSync: () => scheduleStickyPromptSync(),
  pickTaskFolder: () => {
    void pickTaskFolder();
  },
  // Entry-panel handler mutations, verbatim from their pre-D2 inline homes.
  chooseDraftProvider: (provider) => {
    state.taskDraft.provider = provider;
    state.taskDraft.message = null;
    state.taskDraft.menu = null;
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
  setDraftPermissionMode: (mode) => {
    state.taskDraft.permissionMode = mode;
    state.taskDraft.menu = null;
    render();
  },
  setDraftCodexPermissionMode: (mode) => {
    state.taskDraft.codexPermissionMode = mode;
    state.taskDraft.menu = null;
    render();
  },
  setDraftReasoningEffort: (provider, value) => {
    state.taskDraft.reasoningEffort[provider] = value;
    render();
  },
  setDraftModel: (provider, value) => {
    state.taskDraft.model[provider] = value;
    const reasoningEffort = state.taskDraft.reasoningEffort[provider];
    const effortStillSupported = reasoningOptionsForModel(provider, value).some(
      (option) => option.value === reasoningEffort,
    );
    if (!effortStillSupported) {
      // Max and Ultra are the model-gated tiers (codex). Extra High is the
      // nearest universally supported level, preserving the user's intent.
      state.taskDraft.reasoningEffort[provider] = "xhigh";
    }
    // Same unwind for the launch Speed knob: Claude Fast is Opus-only, so
    // switching Opus→non-Opus while Fast is selected leaves a combination the
    // model can't accept. Fall back to Standard (Standard is never gated, so
    // this only fires when `fast` no longer fits).
    const speedMode = state.taskDraft.speedMode[provider];
    const speedStillSupported = speedOptionsForModel(provider, value).some(
      (option) => option.value === speedMode,
    );
    if (!speedStillSupported) {
      state.taskDraft.speedMode[provider] = "default";
    }
    render();
  },
  setDraftSpeedMode: (provider, value) => {
    state.taskDraft.speedMode[provider] = value;
    render();
  },
  // Banner dismiss mutations, verbatim from their pre-D3 inline homes.
  // (approval-expired banner retired in drawer S2 — the drawer's expired
  // variant owns that state now.)
  dismissSlashAttention: (view) => {
    view.slashAttention = null;
    renderAttentionBanners(view);
  },
  dismissModelSwitch: (view) => {
    view.modelSwitch = null;
    renderAttentionBanners(view);
  },
  // Live session model chip (mid-session switch S1): inject `/model <id>` /
  // `/effort <level>` for this Claude session. Fire-and-forget — the pending
  // state and the receipt arrive on the model-switch:state event.
  switchSessionModel: (view, value) => {
    void applyClaudeControlSwitch(view, "model", value);
  },
  switchSessionEffort: (view, value) => {
    void applyClaudeControlSwitch(view, "effort", value);
  },
  // Option-prompt card: the select grammar (single-select picks, multi-select
  // toggles — drawer S1) and the answer flow.
  selectOptionPromptChoice: (view, questionIndex, optionIndex) => {
    const draft = view.optionPromptDrafts[questionIndex];
    const question = view.pendingOptionPrompt?.questions[questionIndex];
    if (!draft || !question) {
      return;
    }
    if (question.multiSelect) {
      draft.optionIndices = draft.optionIndices.includes(optionIndex)
        ? draft.optionIndices.filter((index) => index !== optionIndex)
        : [...draft.optionIndices, optionIndex];
    } else {
      draft.optionIndices = [optionIndex];
      draft.text = null;
      // Single-select picking answers the step — same advance semantic as
      // every other "done with this question" affordance (S5).
      view.optionPromptStep = nextOptionPromptStep(view, questionIndex);
    }
    draft.text = null; // picking an option supersedes a free-text draft
    renderOptionPrompt();
  },
  advanceOptionPromptStep: (view, fromIndex) => {
    view.optionPromptStep = nextOptionPromptStep(view, fromIndex);
    renderOptionPrompt();
  },
  setOptionPromptText: (view, questionIndex, text) => {
    const draft = view.optionPromptDrafts[questionIndex];
    const question = view.pendingOptionPrompt?.questions[questionIndex];
    if (!draft || !question || question.multiSelect) {
      return; // free-text is single-select-only (P9f)
    }
    draft.text = text;
    if (text.trim()) {
      draft.optionIndices = []; // typing supersedes the picked option
    }
    // NO re-render here: the input is live DOM; a full rebuild would drop
    // focus/caret every keystroke. The dependent affordances (Next button,
    // chevron state) refresh on the next render, and the step-advance path
    // re-renders anyway.
  },
  setOptionPromptStep: (view, step) => {
    const questionCount = view.pendingOptionPrompt?.questions.length ?? 0;
    view.optionPromptStep = Math.max(0, Math.min(step, questionCount));
    renderOptionPrompt();
  },
  answerOptionPrompt: () => {
    void answerOptionPrompt();
  },
  dismissOptionPrompt: () => {
    void dismissOptionPrompt();
  },
  // Sidebar flows and ports. Rename IPC stays Promise-based end-to-end; the
  // shared flow owns its single-flight lifecycle and canonical synchronization.
  selectSession: (taskId) => {
    runAfterRename(() => selectSession(taskId));
  },
  startNewChat: (folder) => {
    runAfterRename(() => startNewChat(folder));
  },
  setSidebarPrefs: (patch) => {
    runAfterRename(() => setSidebarPrefs(patch), { sidebarOnly: true });
  },
  toggleProjectCollapsed: (path) => {
    runAfterRename(() => toggleProjectCollapsed(path), { sidebarOnly: true });
  },
  startSessionRename: (taskId, surface, original) => {
    startSessionRename(taskId, surface, original);
  },
  startProjectRename: (path, original) => {
    startProjectRename(path, original);
  },
  cancelRename: () => {
    if (renameTransitions.cancelRename(state)) {
      render();
    }
  },
  commitRename: (trigger) => commitActiveRename(trigger),
  completeRenameComposition: (editor) => completeRenameComposition(editor),
  prepareSidebarStructureChange: () => prepareSidebarStructureChange(),
  revealSession: (taskId) => {
    void window.sonataRuntime.revealSession({ taskId });
  },
  revealProject: (path) => {
    void window.sonataRuntime.revealProject({ path });
  },
  archiveSessionFromSidebar: (taskId) => {
    runAfterRename(() => archiveSessionFromSidebar(taskId));
  },
  unarchiveSession: (taskId) => {
    runAfterRename(() => unarchiveSessionFromSidebar(taskId));
  },
  deleteSessionFromSidebar: (taskId, title) => {
    runAfterRename(() => deleteSessionFromSidebar(taskId, title));
  },
  archiveProject: (path, archived) => {
    runAfterRename(() => archiveProjectFromSidebar(path, archived));
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
  // Settings overlay (view/settings.ts): close transition, popup-menu
  // grammar (verbatim bodies), and the persist flows.
  closeSettingsOverlay: () => {
    closeSettingsOverlay();
  },
  closeSettingsPopupMenus: (overlay) => {
    overlay.policyMenuOpen = false;
    overlay.approvalMenuOpen = false;
    overlay.codexPermissionMenuOpen = false;
    render();
  },
  toggleSettingsApprovalMenu: (overlay) => {
    overlay.approvalMenuOpen = !overlay.approvalMenuOpen;
    render();
  },
  toggleSettingsCodexPermissionMenu: (overlay) => {
    overlay.codexPermissionMenuOpen = !overlay.codexPermissionMenuOpen;
    render();
  },
  toggleSettingsPolicyMenu: (overlay) => {
    overlay.policyMenuOpen = !overlay.policyMenuOpen;
    render();
  },
  persistDefaultPermissionMode: (mode) => {
    void persistDefaultPermissionMode(mode);
  },
  persistCodexDefaultPermissionMode: (mode) => {
    void persistCodexDefaultPermissionMode(mode);
  },
  persistCodexAutoTrustProjectFolders: (value) => {
    void persistCodexAutoTrustProjectFolders(value);
  },
  persistResumePolicy: (policy) => {
    void persistResumePolicy(policy);
  },
  setDefaultRemoteControl: (value) => {
    void setDefaultRemoteControl(value);
  },
  restoreResumeBridge: () => {
    void restoreResumeBridge();
  },
  // Chrome (view/chrome.ts): reading-settings persist flow, RC flows, and
  // the RC arm toggle (verbatim from its pre-D3 inline home).
  persistReadingSettings: (settings) => {
    void persistReadingSettings(settings);
  },
  toggleRemoteControlArm: (mode) => {
    if (mode === "arm-draft") {
      state.taskDraft.remoteControl = !state.taskDraft.remoteControl;
    } else {
      const view = activeTaskView();
      if (view) {
        view.remoteControl.armedOverride = !dormantArmed(view, state.remoteControlDefault);
      }
    }
    render();
  },
  enableRemoteControl: () => {
    void enableRemoteControl();
  },
  manageRemoteControl: () => {
    void manageRemoteControl();
  },
});

// Rename pointer-boundary grammar: registration is boot-time; the bodies live
// in flows/rename-flows (the controller owns the boundary state + waiters).
document.addEventListener(
  "pointerdown",
  (event) => {
    noteRenamePointerDown(event.pointerId);
  },
  true,
);
const finishRenamePointer = (event: PointerEvent): void => {
  noteRenamePointerSettled(event.pointerId);
};
window.addEventListener("pointerup", finishRenamePointer, true);
window.addEventListener("pointercancel", finishRenamePointer, true);
document.addEventListener(
  "click",
  () => {
    noteRenamePointerClickBoundary();
  },
  true,
);
window.addEventListener("blur", () => {
  noteRenameWindowBlur();
});

// T1 — the live-clock ticker (scheduler.ts), started at its original boot
// position.
startStripClockTicker();
let composerIsComposing = false;
let lastComposerCompositionEndAt = 0;
const COMPOSITION_END_SHORTCUT_GUARD_MS = 80;

elements.sidebarToggle.append(lucideIcon(PanelLeft));
elements.sidebarCollapse.append(lucideIcon(PanelLeft));
elements.sessionMenuTrigger.append(lucideIcon(Ellipsis));
elements.sessionMenuTrigger.dataset.sidebarFocusKey = "header:session-menu";
elements.readingSettings.append(lucideIcon(CaseSensitive));
elements.toggleTerminalWindow.append(lucideIcon(SquareTerminal));
elements.openPreviewWindow.append(lucideIcon(Eye));
elements.remoteControlToggle.append(lucideIcon(Smartphone));
elements.sidebarNewChat.querySelector(".sidebar-new-chat-icon")?.append(lucideIcon(Plus));
initTooltips();

const SIDEBAR_COLLAPSED_KEY = "sonata.sidebar.collapsed";

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

const SIDEBAR_WIDTH_KEY = "sonata.sidebar.width";
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
  runAfterRename(() => setSidebarCollapsed(true), { sidebarOnly: true });
});
elements.sidebarToggle.addEventListener("click", () => {
  const collapsed = !elements.sidebar.classList.contains("collapsed");
  runAfterRename(() => setSidebarCollapsed(collapsed), { sidebarOnly: true });
});

elements.sidebarNewChat.addEventListener("click", () => {
  runAfterRename(() => startNewChat());
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
      "header",
    );
  }
});

elements.openPreviewWindow.addEventListener("click", () => {
  void openFloatingPreview();
});

elements.toggleTerminalWindow.addEventListener("click", () => {
  const open = elements.toggleTerminalWindow.getAttribute("aria-pressed") === "true";
  void window.sonataRuntime.setTerminalWindowOpen(!open).then(applyTerminalWindowState);
});

window.sonataRuntime.onTerminalWindowState(applyTerminalWindowState);
void window.sonataRuntime.readTerminalWindowState().then(applyTerminalWindowState);

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

/** The drawer's advance semantic (S5): the next UNANSWERED question after
 *  `fromIndex`, else the Review step — so edits from Review return to Review
 *  (single-select picks, multi-select Next, and free-text Next all share it;
 *  the header chevrons stay strictly linear by contrast). */
function nextOptionPromptStep(view: TaskViewState, fromIndex: number): number {
  const questions = view.pendingOptionPrompt?.questions ?? [];
  for (let i = fromIndex + 1; i < questions.length; i++) {
    if (!optionPromptDraftAnswered(questions[i] ?? { multiSelect: false }, view.optionPromptDrafts[i])) {
      return i;
    }
  }
  return questions.length; // Review
}

elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  // While a drawer owns the slot the composer is hidden — an implicit form
  // submission (e.g. Enter in a drawer input) must never send the parked
  // draft into the TUI's open form (S2 review B2; defense in depth with the
  // drawer inputs' own preventDefault).
  if (elements.composer.classList.contains("drawer-active")) {
    return;
  }
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

// New Chat launch chips (2026-07-04 redesign): each toggles its draft menu.
// The model/permission chips are shared with live sessions, where they render
// disabled (display-only) — a disabled button never fires, so no mode guard.
// Bare draft assignment in a handler is grammar (C3 ruling): shell-side.
// stopPropagation is load-bearing: render() rebuilds the chip's children, so
// by the time the bubble reaches the document click-away the original target
// is detached and closest(".composer-chip") no longer matches — the menu
// would close in the same click that opened it.
function toggleDraftMenuFromChip(kind: TaskDraftMenuKind, event: MouseEvent): void {
  if (isSessionLifecycleActive(state)) {
    return;
  }
  event.stopPropagation();
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  state.taskDraft.menu =
    state.taskDraft.menu?.kind === kind
      ? null
      : { kind, anchor: { left: rect.left, top: rect.top, width: rect.width } };
  // One popover family at a time: displace the Add menu / slash picker
  // (external review P2, 2026-07-04). The usage popover is task-only, so it
  // can never coexist with a draft chip.
  state.composerMenu = null;
  composerTransitions.closeSlashPicker(state);
  render();
}

/** Toggle the live session's model+effort switch menu (S1). Mirrors
 *  toggleDraftMenuFromChip's stopPropagation reasoning: render() rebuilds the
 *  chip mid-click, so without it the document click-away closes the menu in the
 *  same click that opened it. One composer-popover family at a time. */
function toggleSessionModelMenuFromChip(event: MouseEvent): void {
  event.stopPropagation();
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  state.composerMenu =
    state.composerMenu?.type === "session-model"
      ? null
      : {
          type: "session-model",
          anchor: { left: rect.left, top: rect.top, width: rect.width },
        };
  state.taskDraft.menu = null;
  composerTransitions.closeSlashPicker(state);
  render();
}

elements.providerChip.addEventListener("click", (event) => {
  toggleDraftMenuFromChip("provider", event);
});
elements.modelChip.addEventListener("click", (event) => {
  // A live session's model chip opens the session model+effort switch menu (S1,
  // Claude only — the chip is disabled/read-only otherwise, so a click here on a
  // codex or busy session never fires). New Chat's chip opens the draft launch
  // menu. The disabled attribute gates busy/off-idle, so no extra guard here.
  const view = activeTaskView();
  if (view?.task) {
    toggleSessionModelMenuFromChip(event);
    return;
  }
  toggleDraftMenuFromChip("launch", event);
});
elements.permissionChip.addEventListener("click", (event) => {
  toggleDraftMenuFromChip("access", event);
});
elements.projectChip.addEventListener("click", (event) => {
  toggleDraftMenuFromChip("project", event);
});

elements.composer.addEventListener("paste", (event) => {
  if (isSessionLifecycleActive(state)) {
    return;
  }
  // Drawer-active: the attachment strip is hidden — a file landing here would
  // become an invisible attachment that surprise-sends later (S2 review N12).
  if (elements.composer.classList.contains("drawer-active")) {
    return;
  }
  const files = Array.from(event.clipboardData?.files ?? []);
  if (files.length === 0) {
    return;
  }
  event.preventDefault();
  void intakeFiles(files);
});

elements.composer.addEventListener("dragover", (event) => {
  if (isSessionLifecycleActive(state)) {
    return;
  }
  if (hasFileTransfer(event.dataTransfer)) {
    event.preventDefault();
  }
});

elements.composer.addEventListener("drop", (event) => {
  if (isSessionLifecycleActive(state)) {
    return;
  }
  // Drawer-active: the attachment strip is hidden — a file landing here would
  // become an invisible attachment that surprise-sends later (S2 review N12).
  if (elements.composer.classList.contains("drawer-active")) {
    return;
  }
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
  // No blanket lifecycle guard here (D1): for draft-moving phases the input is
  // disabled, so keydown never fires; for `sending`/`attaching`/mutation phases
  // the grammar must run normally — plain Enter is still preventDefault'd and
  // routed to submitPrompt, whose claim guard drops the double-send, so no
  // stray newline and no second submission slips through.
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
  // Plain Enter is the send key — always suppress the browser's newline BEFORE
  // the nothing-to-send check. With the D2 optimistic clear the composer can be
  // empty mid-send, so a fast second Enter would otherwise fall through to the
  // early return and the browser default would insert a stray "\n" that the
  // next message starts with.
  event.preventDefault();
  const submitView = activeTaskView();
  const attachmentCount = submitView ? submitView.pendingAttachments.length : state.draftAttachments.length;
  if (elements.promptInput.value.trim().length === 0 && attachmentCount === 0) {
    return;
  }
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
    const settings = normalizeReadingSettings(await window.sonataRuntime.readReadingSettings());
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
    const settings = normalizeClaudeSettings(await window.sonataRuntime.readClaudeSettings());
    state.remoteControlDefault = settings.defaultRemoteControl;
    state.taskDraft.remoteControl = settings.defaultRemoteControl;
    state.claudeDefaultPermissionMode = settings.defaultPermissionMode;
    render();
  } catch {
    // Best-effort: the New Chat default just stays off.
  }
}

/** Mirror the Codex permission default (Settings → Codex) into renderer state
 *  at boot — the Codex twin of hydrateClaudeDefaults. An untouched New Chat
 *  draft (codexPermissionMode null) shows THIS value on its access chip while
 *  the draft provider is Codex; without the mirror the chip would wear the
 *  local initial default until the user opened Settings. */
async function hydrateCodexDefaults(): Promise<void> {
  try {
    const settings = normalizeCodexSettings(await window.sonataRuntime.readCodexSettings());
    state.codexDefaultPermissionMode = settings.defaultPermissionMode;
    render();
  } catch {
    // Best-effort: the chip just shows Codex's own "Ask for approval" default.
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

/** Drive a mid-session Claude model/effort switch (S1). Close the menu at once;
 *  the pending state and the receipt (settled / failed / needs-attention) drive
 *  the chip through the model-switch:state event. A refusal (a rare idle-gate
 *  race — the chip is disabled off-idle) surfaces as a one-line composer notice. */
async function applyClaudeControlSwitch(
  view: TaskViewState,
  kind: "model" | "effort",
  value: string,
): Promise<void> {
  const task = view.task;
  if (!task) {
    return;
  }
  state.composerMenu = null;
  render();
  try {
    const result = await window.sonataRuntime.switchClaudeControl({
      taskId: task.id,
      kind,
      value,
    });
    if (!result.ok) {
      view.status = controlSwitchRefusalCopy(kind, result.reason);
      render();
    }
  } catch (error) {
    view.status = errorMessage(error);
    render();
  }
}

/** One-line reason a switch couldn't be kicked off (idle-gate races + PTY loss).
 *  User-facing, no CLI internals — the composer-notice register. */
function controlSwitchRefusalCopy(
  kind: "model" | "effort",
  reason: "no-process" | "panel-open" | "busy" | "not-idle" | "wrong-provider",
): string {
  const axis = kind === "model" ? "model" : "reasoning";
  switch (reason) {
    case "not-idle":
      return `Finish the current turn before switching ${axis}.`;
    case "busy":
      return "Claude is mid-action — try again in a moment.";
    case "panel-open":
      return "Claude is waiting on something in the CLI — answer that first.";
    case "no-process":
      return `This session isn't running — reopen it to switch ${axis}.`;
    default:
      return `Couldn't switch ${axis}.`;
  }
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
    const result = await window.sonataRuntime.injectRemoteControl({ taskId: view.task.id });
    if (!result.ok) {
      state.remoteControlNote =
        result.reason === "panel-open"
          ? "Claude is waiting on something in the CLI — answer that first."
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
 *  in it. The native panel — not a Sonata-driven menu — is the honest,
 *  fragility-free management surface. */
async function manageRemoteControl(): Promise<void> {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }
  closeRemoteControlPopover();
  try {
    const result = await window.sonataRuntime.injectRemoteControl({ taskId: view.task.id });
    if (result.ok) {
      setViewMode("terminal");
    }
  } catch {
    // PTY gone between popover-open and click — nothing to manage; stay put.
  }
}

async function persistReadingSettings(nextSettings: ReadingSettings): Promise<void> {
  const settings = normalizeReadingSettings(nextSettings);
  state.readingSettings = settings;
  applyReadingSettings(settings);
  renderReadingPopover();

  try {
    const persisted = normalizeReadingSettings(await window.sonataRuntime.writeReadingSettings(settings));
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
    const [resumeResponse, claudeResponse, codexResponse] = await Promise.all([
      window.sonataRuntime.readResumeSettings(),
      window.sonataRuntime.readClaudeSettings(),
      window.sonataRuntime.readCodexSettings(),
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
    state.settingsOverlay.codex = {
      settings: normalizeCodexSettings(codexResponse),
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
    const persisted = normalizeClaudeSettings(await window.sonataRuntime.writeClaudeSettings(next));
    if (state.settingsOverlay?.claude) {
      state.settingsOverlay.claude.settings = persisted;
    }
    // Keep the renderer mirror live: an untouched New Chat draft
    // (permissionMode null) shows THIS value on its access chip — without
    // the sync the chip wears the stale default until relaunch
    // (external review P2, 2026-07-04).
    state.claudeDefaultPermissionMode = persisted.defaultPermissionMode;
  } catch (error) {
    state.status = errorMessage(error);
  }
  render();
}

async function persistCodexDefaultPermissionMode(mode: CodexPermissionMode): Promise<void> {
  const overlay = state.settingsOverlay;
  if (!overlay?.codex) {
    return;
  }
  overlay.codexPermissionMenuOpen = false;
  if (overlay.codex.settings.defaultPermissionMode === mode) {
    render();
    return;
  }
  const next: CodexSettings = { ...overlay.codex.settings, defaultPermissionMode: mode };
  overlay.codex.settings = next;
  render();
  try {
    const persisted = normalizeCodexSettings(await window.sonataRuntime.writeCodexSettings(next));
    if (state.settingsOverlay?.codex) {
      state.settingsOverlay.codex.settings = persisted;
    }
    // Keep the renderer mirror live: an untouched New Chat draft
    // (codexPermissionMode null) shows THIS value on its access chip while the
    // draft provider is Codex — mirroring the Claude default's sync above.
    state.codexDefaultPermissionMode = persisted.defaultPermissionMode;
  } catch (error) {
    state.status = errorMessage(error);
  }
  render();
}

async function persistCodexAutoTrustProjectFolders(value: boolean): Promise<void> {
  const overlay = state.settingsOverlay;
  if (!overlay?.codex) {
    return;
  }
  if (overlay.codex.settings.autoTrustProjectFolders === value) {
    return;
  }
  const next: CodexSettings = { ...overlay.codex.settings, autoTrustProjectFolders: value };
  overlay.codex.settings = next;
  render();
  try {
    const persisted = normalizeCodexSettings(await window.sonataRuntime.writeCodexSettings(next));
    if (state.settingsOverlay?.codex) {
      state.settingsOverlay.codex.settings = persisted;
    }
    // No renderer-mirror sync here (unlike the permission-mode default): the
    // trust flag drives codex spawn args in the main process, not any New Chat
    // access chip, so there is no draft-following atom to keep live.
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
    const persisted = normalizeResumeSettings(await window.sonataRuntime.writeResumeSettings(next));
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
    cleared = (await window.sonataRuntime.revertResumeBridge()).cleared;
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
    const persisted = normalizeClaudeSettings(await window.sonataRuntime.writeClaudeSettings(next));
    if (state.settingsOverlay?.claude) {
      state.settingsOverlay.claude.settings = persisted;
    }
    state.remoteControlDefault = persisted.defaultRemoteControl;
    state.taskDraft.remoteControl = persisted.defaultRemoteControl;
    state.claudeDefaultPermissionMode = persisted.defaultPermissionMode;
  } catch (error) {
    state.status = errorMessage(error);
  }
  render();
}

// Open a transcript file chip's file in the Preview window. Trust ONLY the
// module-owned chip registry (transcriptChipTarget), never the raw data-chip-*
// attribute — raw assistant HTML could forge one past DOMPurify. openPreview
// binds/focuses the window and opens-or-focuses the tab (dedup in the bridge); a
// stale chip (file since deleted) opens into a tombstone, the correct
// three-truths projection, not an error.
elements.runList.addEventListener("click", (event) => {
  const chipTarget = transcriptChipTarget(event.target);
  if (chipTarget) {
    // Consume the click so a chip nested inside a markdown link never ALSO
    // triggers the anchor's default navigation (the main window's will-navigate
    // guard would swallow it, but the chip should own its own activation).
    event.preventDefault();
    void window.sonataRuntime.openPreview(chipTarget).catch(() => {});
    return;
  }
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

// Keyboard activation for the focusable chips (role=button, tabindex=0).
elements.runList.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }
  const chipTarget = transcriptChipTarget(event.target);
  if (!chipTarget) {
    return;
  }
  event.preventDefault();
  void window.sonataRuntime.openPreview(chipTarget).catch(() => {});
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
  // Capture the originating view synchronously: the choice is de-modalized, so
  // the user can switch tasks during the await and activeTaskView() would then
  // resolve to the wrong view. Update THIS view after the await, iff its choice
  // still exists (object-identity survival check).
  const originView = activeTaskView();
  void window.sonataRuntime
    .revertResumeBridge()
    .then((result) => {
      if (originView?.resumeChoice) {
        originView.resumeChoice = { ...originView.resumeChoice, bridgeDismissed: !result.cleared };
      }
      if (originView) {
        originView.status = result.cleared
          ? "Claude's own resume warning is back on (outside Sonata)"
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
  if (state.taskDraft.menu) {
    state.taskDraft.menu = null;
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
  if (state.taskDraft.menu) {
    event.preventDefault();
    state.taskDraft.menu = null;
    render();
    elements.promptInput.focus();
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

window.sonataRuntime.onReadingSystemModeChanged((mode) => {
  applySystemReadingMode(mode);
});

window.sonataRuntime.onSettingsOpen(() => {
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
window.sonataRuntime.onRuntimeEvent((event) => {
  // Codex hooks-liveness is display-only shell chrome, handled OUTSIDE the
  // reading-core reducer (renderer-local banner store, never a view field).
  // renderAttentionBanners() re-reads the ACTIVE view, so a background task's
  // liveness change is recorded now and painted when it becomes active.
  if (event.type === "cli-hooks:liveness") {
    setCodexHooksMissing(event.payload.taskId, event.payload.status === "missing");
    renderAttentionBanners();
    return;
  }
  for (const directive of reduceRuntimeEvent(state, event)) {
    performDirective(directive);
  }
});

// A clicked native notification lands us on its task (the window was already
// raised in the main process). selectSession, not activateTask: the task may
// not be materialized yet (opened via the Local API, or not yet hydrated after
// a reload) — runtime events for an unloaded view are dropped, so activateTask
// alone would no-op. selectSession loads the session first, then activates.
window.sonataRuntime.onNotificationActivateTask((taskId) => {
  runAfterRename(() => selectSession(taskId));
});

window.sonataRuntime.onCliAction((request) => {
  // The main process validates both sender and shape; Reading validates the
  // shape again at its own trust boundary and the flow revalidates current
  // selection/liveness before claiming lifecycle ownership.
  if (!isCliActionRequest(request)) {
    return;
  }
  if (request.action === "start") {
    if (state.activeTaskId === request.expectedTaskId) {
      void startCliWithoutPrompt();
    }
    return;
  }
  void resumeTaskWithoutPrompt(request.expectedTaskId);
});

void hydrateReadingSettings();
// Load the RC default BEFORE the session index makes dormant sessions clickable:
// a dormant view arms from `state.remoteControlDefault` at creation, so the
// default must be in place first (otherwise a fast click arms from a stale off).
void hydrateClaudeDefaults().finally(() => {
  state.launchSettingsHydrated = true;
  render();
  void refreshSessionIndex();
});
// The Codex permission default only feeds the New Chat access chip label (no
// dormant-arming ordering constraint like Claude's RC default), so it hydrates
// independently and never gates the session index.
void hydrateCodexDefaults();

render();

// The shell's zero-arg convenience over the reading-core helper (the logic
// moved to state.ts at D-mid-0 so views and shell share one definition).
function activeTaskView(): TaskViewState | null {
  return activeTaskViewOf(state);
}


// --- Slash command picker -------------------------------------------------
//
// Input assistance over a pure passthrough pipe: the picker helps discover
// and complete commands, but typed text always reaches the PTY verbatim.
// The only submit-time interventions are safety guards backed by probe
// evidence (spikes/slash-probes): bare "/" and unmatched prefixes dispatch
// the CLI's first popup item when blind-injected, so they never leave sonata
// without confirmation; bare native-menu commands (/model, /permissions)
// open the sonata menu instead of an invisible TUI panel.

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
  void window.sonataRuntime
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
  // Opening the picker displaces a draft chip menu (its portal lives outside
  // the composer popover root) — escalate to a full render to unpaint it.
  const displacedDraftMenu = state.taskDraft.menu !== null;
  composerTransitions.openOrRefreshSlashPicker(
    state,
    composerSlashProvider(),
    value.slice(1).toLowerCase(),
    () => cachedSlashCommands()?.entries ?? [],
  );
  refreshSlashCommands();
  if (displacedDraftMenu) {
    render();
    return;
  }
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


function isComposerCompositionShortcut(event: KeyboardEvent): boolean {
  if (event.key !== "Enter" && event.key !== "Escape") {
    return false;
  }
  if (event.isComposing || composerIsComposing || event.keyCode === 229) {
    return true;
  }
  return performance.now() - lastComposerCompositionEndAt < COMPOSITION_END_SHORTCUT_GUARD_MS;
}
