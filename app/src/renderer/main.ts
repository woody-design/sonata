import {
  CaseSensitive,
  Ellipsis,
  Eye,
  PanelLeft,
  Plus,
  Settings,
  Smartphone,
  SquareTerminal,
} from "lucide";
import "./styles.css";
import {
  normalizeClaudeSettings,
  normalizeCodexSettings,
  normalizeReadingSettings,
  normalizeResumeSettings,
  normalizeSonataSettings,
  isCliActionRequest,
  isCliReadinessFacts,
  isCliSetupRunSnapshot,
  isCliSetupRunState,
  type ClaudeDefaultPermissionMode,
  type ClaudeSettings,
  type CodexPermissionMode,
  type CodexSettings,
  type ReadingSettings,
  type ReasoningEffort,
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
import { clamp, errorMessage } from "../reading-core/selectors/formatters";
import { filteredSlashItems } from "../reading-core/selectors/composer";
import { normalizeSidebarTagIds } from "../reading-core/selectors/sidebar";
import {
  reasoningEffortForModel,
  reasoningOptionsForModel,
  speedOptionsForModel,
} from "../reading-core/config";
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
  createSessionTag,
  deleteTagDefinition,
  initTagFlows,
  refreshTagDefinitions,
  toggleSessionTag,
} from "./flows/tags";
import {
  applyClaudeControlSwitch,
  applyControlConfirmAnswer,
  applyStagedModelSwitch,
  initControlSwitchFlows,
} from "./flows/control-switch";
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
import {
  clearCodexResumableExit,
  clearTaskBanners,
  initBannersView,
  renderAttentionBanners,
  setCodexHooksMissing,
  setCodexResumableExit,
  setCodexUpdatePrompt,
} from "./view/banners";
import { initCliReadinessCardView } from "./view/cli-readiness-card";
import {
  applyTerminalWindowState,
  initChromeView,
  renderReadingPopover,
  renderRemoteControlPopover,
} from "./view/chrome";
import {
  currentSessionModelPair,
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
  renderSidebarMenu,
} from "./view/sidebar";
import { initUpdateButton } from "./view/update-button";
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
import { clearTaskChipCache, initTranscriptChips, transcriptChipTarget } from "./view/transcript-chips";
import { initQuoteComment } from "./view/quote-comment";
import { initReadingNavigation } from "./view/reading-navigation";
import { initReadingScrollControl } from "./view/reading-scroll-control";
import { createReadingBottomIntentStore } from "../reading-core/reading-scroll";

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
      tags: normalizeSidebarTagIds(raw.tags),
      groupBy: ["project", "date", "none"].includes(raw.groupBy as string)
        ? (raw.groupBy as SidebarPrefs["groupBy"])
        : SIDEBAR_PREFS_DEFAULTS.groupBy,
      sortBy: ["recency", "created", "alphabetical"].includes(raw.sortBy as string)
        ? (raw.sortBy as SidebarPrefs["sortBy"])
        : SIDEBAR_PREFS_DEFAULTS.sortBy,
    };
  } catch {
    return { ...SIDEBAR_PREFS_DEFAULTS, tags: [...SIDEBAR_PREFS_DEFAULTS.tags] };
  }
}

function setSidebarPrefs(patch: Partial<SidebarPrefs>): void {
  sidebarTransitions.patchSidebarPrefs(state, patch);
  saveSidebarPrefs();
  renderSidebar();
}

function saveSidebarPrefs(): void {
  try {
    localStorage.setItem(SIDEBAR_PREFS_KEY, JSON.stringify(state.sidebar.prefs));
  } catch {
    // View preference only.
  }
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
  clearTaskViewCaches: (taskId) => {
    clearTaskChipCache(taskId);
    clearTaskBanners(taskId);
  },
});
initAttachmentFlows(state);
initTagFlows(state, {
  renderSidebar: () => renderSidebar(),
  renderSidebarMenu: () => renderSidebarMenu(),
  saveSidebarPrefs: () => saveSidebarPrefs(),
});
initControlSwitchFlows(state, {
  currentSessionModelPair: (view, provider) => currentSessionModelPair(view, provider),
});
initScheduler(state, {
  renderTranscriptStream: () => renderTranscriptStream(),
  refreshSessionIndex: () => refreshSessionIndex(),
  openUsagePopover: (pinned) => openUsagePopover(pinned),
  closeUsagePopover: () => closeUsagePopover(),
});
initEntryView(state);
// One scroll-to-bottom intent, shared by the render finalize (transcript) and
// the navigation surface — two sibling view families that cannot import each
// other, so the composition root hands both the same instance.
const readingBottomIntent = createReadingBottomIntentStore();
initTranscriptView(state, {
  composeEntryPanel: renderTaskEntryPanel,
  bottomIntent: readingBottomIntent,
});
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
initCliReadinessCardView(state);
initStatusStripView(state);
initApprovalsView(state);
initSidebarView(state);
initUpdateButton({
  onUpdaterState: (callback) => window.sonataRuntime.onUpdaterState(callback),
  readUpdaterState: () => window.sonataRuntime.readUpdaterState(),
  requestUpdaterRestart: () => window.sonataRuntime.requestUpdaterRestart(),
});
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
initReadingNavigation({ bottomIntent: readingBottomIntent });
initReadingScrollControl({ bottomIntent: readingBottomIntent });
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
  // The readiness card's two actions. No local state change and no optimistic
  // repaint: main publishes the run's `running` phase before it opens the CLI
  // window, and that push repaints the card — so the only authority on "is a run
  // in flight" is the process that owns the pty. A rejected invoke (the guard, or
  // no main window) leaves the card exactly as it was, which is honest: nothing
  // started.
  installCli: (provider) => {
    void window.sonataRuntime
      .startCliSetupRun({ kind: "install", provider })
      .catch(() => {});
  },
  startCliLogin: (provider) => {
    void window.sonataRuntime.startCliSetupRun({ kind: "start", provider }).catch(() => {});
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
  dismissControlSwitch: (view) => {
    view.controlSwitch = null;
    // A full render, not just the banner: clearing the switch pointer also
    // re-enables the send button (gated on view.controlSwitch — review fix A), so
    // the composer must repaint too, or send would stay disabled until the next
    // unrelated render.
    render();
  },
  // The codex resumable-exit banner's action (SL-6). The SAME entry point the
  // CLI window's "Resume task" button relays through (`onCliAction`), so there is
  // exactly one dormant-resume path — and for codex that path already spawns
  // `codex resume <session-id>` against the task's own rollout (openTask →
  // buildStartOptions → codexArgs), which is what makes the banner's promise
  // true. Fire-and-forget: the flow owns its own guards.
  resumeTask: (taskId) => {
    void resumeTaskWithoutPrompt(taskId);
  },
  // Live session PERMISSION chips (mid-session switch): immediate-apply single-axis
  // switches — claude via the Shift+Tab stepping engine (S2; `from` = the current
  // mode, the return-home anchor), codex via the `/permissions` picker (S3; `from`
  // = the current preset, to skip a no-op). Fire-and-forget — the receipt(s) arrive
  // on the control-switch:state event.
  switchSessionPermission: (view, mode) => {
    void applyClaudeControlSwitch(view, "permission", mode, view.task?.permissionMode ?? undefined);
  },
  switchSessionCodexPermission: (view, mode) => {
    void applyClaudeControlSwitch(
      view,
      "codex-permission",
      mode,
      view.task?.codexPermissionMode ?? undefined,
    );
  },
  // STAGED model+effort menu (S7 Part 1). Row clicks only STAGE the pair (no CLI);
  // Save applies the changed axes as ONE logical switch. Staging just mutates the
  // open menu's staged pair and re-renders (Save enables when it differs from
  // current). Cancel / Esc / outside-click discard by closing the menu.
  stageSessionModel: (value) => {
    if (popoverTransitions.stageSessionModel(state, value)) {
      render();
    }
  },
  stageSessionEffort: (value) => {
    if (popoverTransitions.stageSessionEffort(state, value)) {
      render();
    }
  },
  saveStagedModelSwitch: (view) => {
    void applyStagedModelSwitch(view);
  },
  closeSessionMenu: () => {
    state.composerMenu = null;
    render();
  },
  answerControlConfirm: (rowNumber) => {
    void applyControlConfirmAnswer(rowNumber);
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
  refreshTagDefinitions: () => refreshTagDefinitions(),
  toggleSessionTag: (taskId, tagId) => toggleSessionTag(taskId, tagId),
  createSessionTag: (taskId, label, group) => createSessionTag(taskId, label, group),
  deleteTag: (id) => deleteTagDefinition(id),
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
    overlay.claudeModelMenuOpen = false;
    overlay.codexModelMenuOpen = false;
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
  // The Default-model group menus flip their own open state, exactly like the
  // picker toggles above (outside-click / Esc closes all via
  // closeSettingsPopupMenus).
  toggleSettingsClaudeModelMenu: (overlay) => {
    overlay.claudeModelMenuOpen = !overlay.claudeModelMenuOpen;
    render();
  },
  toggleSettingsCodexModelMenu: (overlay) => {
    overlay.codexModelMenuOpen = !overlay.codexModelMenuOpen;
    render();
  },
  persistDefaultPermissionMode: (mode) => {
    void persistDefaultPermissionMode(mode);
  },
  persistCodexDefaultPermissionMode: (mode) => {
    void persistCodexDefaultPermissionMode(mode);
  },
  persistDefaultModel: (provider, model) => {
    persistDefaultModel(provider, model);
  },
  persistDefaultReasoningEffort: (provider, effort) => {
    persistDefaultReasoningEffort(provider, effort);
  },
  persistCodexAutoTrustProjectFolders: (value) => {
    void persistCodexAutoTrustProjectFolders(value);
  },
  persistCodexKeepUpToDate: (value) => {
    void persistCodexKeepUpToDate(value);
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
elements.sidebarSettings.append(lucideIcon(Settings));
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

// The sidebar footer's Settings entry — the same overlay the app menu (Cmd+,)
// opens, now visibly reachable. Routed through runAfterRename like every other
// sidebar button: the overlay covers the whole window, so an open sidebar
// rename editor must commit first rather than be stranded behind it.
elements.sidebarSettings.addEventListener("click", () => {
  runAfterRename(() => openSettingsOverlay(), { sidebarOnly: true });
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
  // The New Chat readiness card is showing (S2): the draft's provider has no CLI
  // to spawn, or one that is not signed in. Sending would create a task whose pty
  // dies or hangs on a first-run screen and whose prompt then queues in silence —
  // the exact failure this program exists to replace. The class is the same gate
  // shape the drawer uses above, and it also covers plain Enter, which reaches
  // here through requestSubmit() rather than through the disabled send button.
  if (elements.composer.classList.contains("cli-readiness-active")) {
    return;
  }
  void submitPrompt();
});

elements.promptInput.addEventListener("input", () => {
  renderComposerControls();
  syncSlashPicker();
});

// Caret tracking for the token-at-cursor picker: moving INTO a "/" token must
// open it and moving out must close it, and neither is an input event.
// Chromium fires `selectionchange` on the document for textareas, so one
// document listener covers arrow keys, clicks, Home/End and drag-selection
// alike. It also fires on typing — the signature check makes that a no-op, so
// a keystroke still repaints the popover exactly once.
document.addEventListener("selectionchange", () => {
  if (document.activeElement !== elements.promptInput) {
    return;
  }
  if (slashSyncSignature() === lastSlashSyncSignature) {
    return;
  }
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

/** Toggle the live session's model+effort switch menu — Claude's `/model`+
 *  `/effort` menu (S1, `session-model`) or Codex's `/model` two-level picker menu
 *  (S4, `session-codex-model`), selected by the session's provider. Mirrors
 *  toggleDraftMenuFromChip's stopPropagation reasoning: render() rebuilds the chip
 *  mid-click, so without it the document click-away closes the menu in the same
 *  click that opened it. One composer-popover family at a time. */
function toggleSessionModelMenuFromChip(event: MouseEvent, provider: RuntimeProvider): void {
  event.stopPropagation();
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const menuType = provider === "codex" ? "session-codex-model" : "session-model";
  const view = activeTaskView();
  state.composerMenu =
    state.composerMenu?.type === menuType
      ? null
      : {
          type: menuType,
          anchor: { left: rect.left, top: rect.top, width: rect.width },
          // Seed the staged pair to the session's current (model, effort) — a row
          // click restages, Save applies the changed axes (S7 Part 1).
          staged: view ? { ...currentSessionModelPair(view, provider) } : { model: null, effort: null },
        };
  state.taskDraft.menu = null;
  composerTransitions.closeSlashPicker(state);
  render();
}

/** Toggle the live session's permission switch menu — Claude's Shift+Tab menu
 *  (S2, `session-access`) or Codex's `/permissions`-preset menu (S3,
 *  `session-codex-access`), selected by the session's provider. Same one-popover
 *  discipline as toggleSessionModelMenuFromChip. */
function toggleSessionAccessMenuFromChip(event: MouseEvent, provider: RuntimeProvider): void {
  event.stopPropagation();
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const menuType = provider === "codex" ? "session-codex-access" : "session-access";
  state.composerMenu =
    state.composerMenu?.type === menuType
      ? null
      : {
          type: menuType,
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
  // A live session's model chip opens the session model+effort switch menu —
  // Claude's `/model`+`/effort` menu (S1) or Codex's `/model` two-level picker
  // menu (S4), keyed off the session's provider. The chip is disabled off-idle /
  // mid-switch, so a click here always fires on an idle session. New Chat's chip
  // opens the draft launch menu.
  const view = activeTaskView();
  if (view?.task) {
    toggleSessionModelMenuFromChip(event, view.task.provider);
    return;
  }
  toggleDraftMenuFromChip("launch", event);
});
elements.permissionChip.addEventListener("click", (event) => {
  // A live session's access chip opens the permission switch menu — Claude's
  // Shift+Tab menu (S2) or Codex's `/permissions`-preset menu (S3), keyed off the
  // session's provider. The chip is disabled off-idle / mid-switch, so a click
  // here always fires on an idle session. New Chat's chip opens the draft access
  // menu.
  const view = activeTaskView();
  if (view?.task) {
    toggleSessionAccessMenuFromChip(event, view.task.provider);
    return;
  }
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
    // Mirror the Claude launch defaults; the New Chat draft is seeded ONCE from
    // all three mirrors after every hydration settles (see the boot block), so
    // an empty-task CLI action never launches from a half-seeded draft.
    state.defaultModel.claude = settings.defaultModel;
    state.defaultReasoningEffort.claude = settings.defaultReasoningEffort;
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
    // Mirror the Codex launch defaults; the draft is seeded once post-settle
    // (see hydrateClaudeDefaults' note and the boot block).
    state.defaultModel.codex = settings.defaultModel;
    state.defaultReasoningEffort.codex = settings.defaultReasoningEffort;
    render();
  } catch {
    // Best-effort: the chip just shows Codex's own "Ask for approval" default.
  }
}

/** Mirror the last-used provider — the record a real session START writes in
 *  main (S3/L3), not a setting anyone picks here. The New Chat draft's provider
 *  is seeded from this mirror (and from the readiness facts below) once every
 *  launch hydration settles (see the boot block), so no render here — nothing
 *  visible changes until that collective seed. */
async function hydrateLastUsedProvider(): Promise<void> {
  try {
    const settings = normalizeSonataSettings(await window.sonataRuntime.readSonataSettings());
    state.lastUsedProvider = settings.lastUsedProvider;
  } catch {
    // Best-effort: the draft falls back to the runtime seed (the sole usable
    // CLI, else Claude), exactly as on a machine that has never started one.
  }
}

/** True once main has pushed readiness facts (see the subscription below). */
let cliReadinessPushed = false;

/** Mirror the CLI readiness facts (S1) for the draft-provider seed's tiebreak.
 *  The pull half: the first probe can land before this window exists or after
 *  it, so a window hydrates once and then follows the push. Revalidated at this
 *  boundary even though main built the payload — `isCliReadinessFacts` exists
 *  precisely so a garbled message can never reach a consumer as a fact. */
async function hydrateCliReadiness(): Promise<void> {
  try {
    const facts = await window.sonataRuntime.readCliReadiness();
    // A push that raced this read wins: it is strictly newer, and the pull can
    // resolve with the snapshot from before it.
    if (!cliReadinessPushed && isCliReadinessFacts(facts)) {
      state.cliReadiness = facts;
    }
  } catch {
    // Best-effort: the facts stay unknown, which is the permissive state — the
    // seed then falls through to Claude instead of acting on a non-observation.
  }
}

/** True once main has pushed a setup-run state (same race latch as the facts). */
let cliSetupRunPushed = false;

/** Mirror the CLI setup run (S2). A run can outlive this window — the app was
 *  quit and relaunched while an installer kept going (main deliberately does not
 *  kill it) — so a fresh window must be able to learn that one is still in flight
 *  rather than offer an Install button for a machine that is mid-install. */
async function hydrateCliSetupRun(): Promise<void> {
  try {
    const snapshot = await window.sonataRuntime.readCliSetupRun();
    if (!cliSetupRunPushed && isCliSetupRunSnapshot(snapshot)) {
      state.cliSetupRun = snapshot.run;
    }
  } catch {
    // Best-effort: null is the normal state, and it only costs the "Installing…"
    // narration on a run this window did not start.
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

// ── Default model settings (copy-at-entry) ─────────────────────────────────
// These persist flows update the launch-default MIRRORS (state.defaultModel /
// defaultReasoningEffort), which seed the NEXT new chat — they deliberately do
// NOT touch the currently-open taskDraft (copy-at-entry: a Settings change never
// retro-applies to a draft already in the composer). This is the conscious
// asymmetry with the permission-mode defaults, which the draft follows live
// through its null slot.

/** The combined Claude model+effort popover's instant-apply write. A patch
 *  carries the ONE axis the user just picked; a model change clamps a now-gated
 *  effort through `reasoningEffortForModel` (a gated Max/Ultra never survives a
 *  model switch). The menu stays open across picks (no menu-boolean toggle
 *  here). */
async function persistClaudeDefaultModelEffort(patch: {
  model?: string;
  effort?: ReasoningEffort;
}): Promise<void> {
  const overlay = state.settingsOverlay;
  if (!overlay?.claude) {
    return;
  }
  const current = overlay.claude.settings;
  const model = patch.model ?? current.defaultModel;
  const effort = reasoningEffortForModel(
    "claude",
    model,
    patch.effort ?? current.defaultReasoningEffort,
  );
  if (current.defaultModel === model && current.defaultReasoningEffort === effort) {
    render();
    return;
  }
  const next: ClaudeSettings = {
    ...current,
    defaultModel: model,
    defaultReasoningEffort: effort,
  };
  overlay.claude.settings = next;
  state.defaultModel.claude = model;
  state.defaultReasoningEffort.claude = effort;
  render();
  try {
    const persisted = normalizeClaudeSettings(await window.sonataRuntime.writeClaudeSettings(next));
    if (state.settingsOverlay?.claude) {
      state.settingsOverlay.claude.settings = persisted;
    }
    state.defaultModel.claude = persisted.defaultModel;
    state.defaultReasoningEffort.claude = persisted.defaultReasoningEffort;
  } catch (error) {
    state.status = errorMessage(error);
  }
  render();
}

/** The Codex twin of persistClaudeDefaultModelEffort — the second store's write
 *  path (Codex settings carry different neighbours, so the flow is separate,
 *  matching the permission-mode default's claude/codex split). */
async function persistCodexDefaultModelEffort(patch: {
  model?: string;
  effort?: ReasoningEffort;
}): Promise<void> {
  const overlay = state.settingsOverlay;
  if (!overlay?.codex) {
    return;
  }
  const current = overlay.codex.settings;
  const model = patch.model ?? current.defaultModel;
  const effort = reasoningEffortForModel(
    "codex",
    model,
    patch.effort ?? current.defaultReasoningEffort,
  );
  if (current.defaultModel === model && current.defaultReasoningEffort === effort) {
    render();
    return;
  }
  const next: CodexSettings = {
    ...current,
    defaultModel: model,
    defaultReasoningEffort: effort,
  };
  overlay.codex.settings = next;
  state.defaultModel.codex = model;
  state.defaultReasoningEffort.codex = effort;
  render();
  try {
    const persisted = normalizeCodexSettings(await window.sonataRuntime.writeCodexSettings(next));
    if (state.settingsOverlay?.codex) {
      state.settingsOverlay.codex.settings = persisted;
    }
    state.defaultModel.codex = persisted.defaultModel;
    state.defaultReasoningEffort.codex = persisted.defaultReasoningEffort;
  } catch (error) {
    state.status = errorMessage(error);
  }
  render();
}

/** Route a provider-neutral default model pick to the right store flow. */
function persistDefaultModel(provider: RuntimeProvider, model: string): void {
  if (provider === "claude") {
    void persistClaudeDefaultModelEffort({ model });
  } else {
    void persistCodexDefaultModelEffort({ model });
  }
}

/** Route a provider-neutral default effort pick to the right store flow. */
function persistDefaultReasoningEffort(provider: RuntimeProvider, effort: ReasoningEffort): void {
  if (provider === "claude") {
    void persistClaudeDefaultModelEffort({ effort });
  } else {
    void persistCodexDefaultModelEffort({ effort });
  }
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

async function persistCodexKeepUpToDate(value: boolean): Promise<void> {
  const overlay = state.settingsOverlay;
  if (!overlay?.codex) {
    return;
  }
  if (overlay.codex.settings.keepCodexUpToDate === value) {
    return;
  }
  const next: CodexSettings = { ...overlay.codex.settings, keepCodexUpToDate: value };
  overlay.codex.settings = next;
  render();
  try {
    const persisted = normalizeCodexSettings(await window.sonataRuntime.writeCodexSettings(next));
    if (state.settingsOverlay?.codex) {
      state.settingsOverlay.codex.settings = persisted;
    }
    // No renderer-mirror sync (same reasoning as the trust flag): this drives a
    // background job and a codex spawn flag in the main process, and no draft
    // atom follows it. The main side re-reads the store on every evaluation, so
    // the toggle takes effect on the next cycle and the next spawn — no restart.
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
    return;
  }
  // An in-page anchor (`#…`) or another scheme (`mailto:`, etc.) is out of scope
  // — leave it swallowed as before. A relative or absolute FILE path routes
  // through the Preview seam for the active task: main normalizes an absolute
  // path inside the workspace to relative and routes by kind (previewable tab /
  // browser / Quick Look); an absolute path outside the workspace is a no-op.
  if (!href || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return;
  }
  // marked percent-encodes non-ASCII / spaced destinations (`报告.md` →
  // `%E6%8A%A5%E5%91%8A.md`), so decode before routing — otherwise a link to an
  // EXISTING CJK/spaced file statSync-misses into a FALSE tombstone (a worse
  // three-truths lie than the old silent swallow). Mirrors the Preview window's
  // routeDocLink, which decodes url.pathname; a malformed `%` sequence throws
  // URIError → fall back to the raw href.
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(href);
  } catch {
    relativePath = href;
  }
  const taskId = activeTaskView()?.task?.id;
  if (taskId) {
    void window.sonataRuntime.openPreview({ taskId, relativePath }).catch(() => {});
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
  if (state.composerMenu) {
    // Esc discards an open composer menu — for the staged model+effort menu (S7
    // Part 1) this drops the staged pair without touching the CLI, matching the
    // Cancel button and outside-click; the same close is the natural gesture for
    // the add / access menus (outside-click already dismisses them).
    event.preventDefault();
    state.composerMenu = null;
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

// The push half of the readiness mirror (S1's L6 pair).
//
// It repaints (S2) and it must NOT re-seed (D6 — S3's rule stands). Those two are
// compatible because they are different questions: the seed decides what the NEXT
// New Chat opens on and runs only from `seedTaskDraftFromLaunchDefaults`, while
// this render only re-reads state that already changed. So a machine that heals
// while a draft is open drops the card and restores the composer — on the draft's
// own provider, never on one Sonata picked for the user.
window.sonataRuntime.onCliReadinessChanged((facts) => {
  if (isCliReadinessFacts(facts)) {
    cliReadinessPushed = true;
    state.cliReadiness = facts;
    render();
  }
});

// The setup run's push (S2): every phase change — a run starting, an install
// failing, a run clearing because the facts went green — repaints the card.
window.sonataRuntime.onCliSetupRunChanged((run) => {
  if (isCliSetupRunState(run)) {
    cliSetupRunPushed = true;
    state.cliSetupRun = run;
    render();
  }
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
  // Codex boot "Update available!" gate (S4) — same renderer-local banner family
  // as hooks-liveness. Set on detection; cleared on the task's pty:exit (a fresh
  // session re-detects if still stuck), which still flows to the reducer below.
  if (event.type === "codex-update-prompt:detected") {
    setCodexUpdatePrompt(event.payload.taskId, true);
    renderAttentionBanners();
    return;
  }
  if (event.type === "pty:exit") {
    setCodexUpdatePrompt(event.payload.taskId, false);
    renderAttentionBanners();
  }
  // A codex session ended outside Sonata's lifecycle, conversation intact (SL-6) — same
  // renderer-local banner family. Set on the classified exit; cleared when the
  // task starts a session again (`task:started`, below), so a resume — from this
  // banner, the CLI window's button, or simply sending a message — retires it.
  // NOT cleared on `pty:exit`: that is the event that raises it.
  if (event.type === "codex-session-exit:resumable") {
    setCodexResumableExit(event.payload.taskId, event.payload.midTurn);
    renderAttentionBanners();
    return;
  }
  if (event.type === "task:started") {
    clearCodexResumableExit(event.payload.taskId);
    renderAttentionBanners();
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
void refreshTagDefinitions().catch(() => {
  // Best-effort boot cache. Opening Tags retries the authoritative read.
});
// The launch projection: Claude (RC + permission + model/effort), Codex
// (permission + model/effort), the last-used provider, and the CLI readiness
// facts all feed the New Chat draft (copy-at-entry). The fifth read — the CLI
// setup run (S2) — feeds the readiness CARD rather than the draft, and rides here
// so the first paint cannot show an Install button for a machine an installer this
// window did not start is already working on. Gate `launchSettingsHydrated`, the
// ONE draft seed, and the first index refresh on
// ALL FIVE settling — the flag's contract is that an empty-task CLI action never
// races an in-flight projection, which only holds if every input the seed reads
// is in before it flips. This also keeps the Claude ordering constraint (the RC
// default must be in place before the index makes dormant sessions clickable):
// allSettled resolves no earlier than Claude's own read, and the index refresh
// runs strictly after it. allSettled never rejects (each hydrate swallows its own
// error), so the seed always runs.
//
// The readiness read does NOT wait for a probe — it returns whatever main knows
// now, `unknown` included. So the first draft on a fresh install can still open
// on Claude before the facts land; the next New Chat gets the tiebreak, and an
// open draft is never switched underneath the user (D6).
void Promise.allSettled([
  hydrateClaudeDefaults(),
  hydrateCodexDefaults(),
  hydrateLastUsedProvider(),
  hydrateCliReadiness(),
  hydrateCliSetupRun(),
]).then(() => {
  sessionTransitions.seedTaskDraftFromLaunchDefaults(state);
  state.launchSettingsHydrated = true;
  render();
  void refreshSessionIndex();
});

render();

// The shell's zero-arg convenience over the reading-core helper (the logic
// moved to state.ts at D-mid-0 so views and shell share one definition).
function activeTaskView(): TaskViewState | null {
  return activeTaskViewOf(state);
}


// --- Slash command picker -------------------------------------------------
//
// Input assistance over a pure passthrough pipe. Two rules, and everything
// here follows from them (2026-07-27, decisions 3–4):
//
// 1. VERBATIM, ALWAYS. Submit performs NO slash interpretation — no guard, no
//    confirm, no hint. Prompts are delivered by typing into the provider's
//    PTY, so what the composer submits must reach the CLI exactly as if the
//    user had typed it in a terminal. An unknown "/foo" erroring locally in
//    the CLI is the user's own choice, same as in a terminal. (The retired
//    double-Enter guard bought a typo warning at the price of that parity —
//    and misfired on every pasted absolute path.)
// 2. THE PICKER IS TYPING ASSISTANCE. It tracks the "/" token AT THE CURSOR,
//    so it also helps mid-prompt ("…rewrite this using /architect"). Both
//    CLIs execute commands only at line start, so a mid-prompt token is plain
//    text to them: selecting there INSERTS and never submits. Only when the
//    token is the whole input do the Enter-execute semantics apply.

const SLASH_COMMANDS_CACHE_TTL_MS = 10_000;
const slashCommandsCache = new Map<string, { at: number; response: SlashCommandsResponse }>();
/** Esc/outside-click dismissal is scoped to ONE token (its start offset + its
 *  text), not the whole draft: editing that token, or moving the caret to a
 *  different one, is a fresh ask and reopens the picker. */
let slashPickerDismissedToken: SlashToken | null = null;
/** The (caret, value) pair the last syncSlashPicker acted on. The caret
 *  tracker fires on typing too, so this keeps the second sync of a keystroke
 *  from repainting the popover; a real caret move always differs. */
let lastSlashSyncSignature: string | null = null;

/** The "/" token the caret sits in — two spans, deliberately different
 *  (ratified 2026-07-27, Slack/VS Code completion semantics):
 *
 *  - `start`→`end` is the WHOLE whitespace-delimited run. Completion replaces
 *    all of it, so finishing "/stat|usx" leaves a clean "/status " with no
 *    tail residue; the whole-input test compares against it too, so a caret
 *    parked mid-word does not silently downgrade execute to complete.
 *  - `query` is only the part BEFORE the caret — typeahead filters by what
 *    you have typed, not by what sits to the right of the caret. */
interface SlashToken {
  start: number;
  end: number;
  text: string;
  query: string;
}

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

/**
 * The "/" token the caret sits in, or null when the caret is not in one.
 * Three conditions, all necessary:
 *
 * - the selection is COLLAPSED — a range selection has no single insertion
 *   point to complete into;
 * - the run of non-whitespace ending at the caret matches /^\/\S*$/;
 * - that run begins at the input start or right after whitespace — "src/lib"
 *   is a path, not a command token, and the CLIs read it as text too.
 *
 * The run is then extended PAST the caret to the next whitespace, giving the
 * full token; see SlashToken for why the two spans differ.
 */
function slashTokenAtCursor(): SlashToken | null {
  const input = elements.promptInput;
  const caret = input.selectionStart;
  if (caret === null || caret !== input.selectionEnd) {
    return null;
  }
  const query = /(?:^|\s)(\/\S*)$/.exec(input.value.slice(0, caret))?.[1];
  if (query === undefined) {
    return null;
  }
  const tail = /^\S*/.exec(input.value.slice(caret))?.[0] ?? "";
  return { start: caret - query.length, end: caret + tail.length, text: query + tail, query };
}

/** Whether the token IS the draft — the only case where Enter on a picker
 *  entry may execute instead of insert (decision 4). Compares the whole run,
 *  so a caret parked mid-word still counts; trimmed, so surrounding
 *  whitespace does not turn a lone "/status" into a mid-prompt token. */
function slashTokenIsWholeInput(token: SlashToken): boolean {
  return elements.promptInput.value.trim() === token.text;
}

function sameSlashToken(a: SlashToken | null, b: SlashToken | null): boolean {
  return a !== null && b !== null && a.start === b.start && a.text === b.text;
}

function syncSlashPicker(): void {
  if (composerIsComposing) {
    return;
  }
  const token = slashTokenAtCursor();
  lastSlashSyncSignature = slashSyncSignature();
  if (!sameSlashToken(token, slashPickerDismissedToken)) {
    slashPickerDismissedToken = null;
  }
  const shouldOpen =
    token !== null && slashPickerDismissedToken === null && !elements.promptInput.disabled;
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
    token.query.slice(1).toLowerCase(),
    () => cachedSlashCommands()?.entries ?? [],
  );
  refreshSlashCommands();
  if (displacedDraftMenu) {
    render();
    return;
  }
  renderComposerPopover();
}

/** The (caret, value) pair as one comparable string. The separator is NUL
 *  because it is the one character that cannot appear in typed text — without a
 *  separator, caret 5 + "1ello" and caret 51 + "ello" share a signature and
 *  syncSlashPicker skips a repaint it owed. Written as the ESCAPE `\u0000`,
 *  never as a literal byte: a literal NUL makes ripgrep classify this whole file
 *  as binary and silently skip it while WALKING a directory (an explicitly named
 *  file still matches), which is how a dangling reference survives a removal
 *  sweep — CLI readiness S3 review, P1. */
function slashSyncSignature(): string {
  return `${elements.promptInput.selectionStart}\u0000${elements.promptInput.value}`;
}

function closeSlashPicker(dismissCurrentToken: boolean): void {
  if (dismissCurrentToken) {
    slashPickerDismissedToken = slashTokenAtCursor();
  }
  if (composerTransitions.closeSlashPicker(state)) {
    renderComposerPopover();
  }
}

/** Returns whether there was a selection to move — false on the empty state,
 *  where the arrow key belongs to the caret instead. */
function moveSlashSelection(delta: number): boolean {
  if (!composerTransitions.moveSlashSelection(state, delta)) {
    return false;
  }
  renderComposerPopover();
  return true;
}

function selectedSlashEntry(): SlashCommandEntry | null {
  const picker = state.slashPicker;
  if (!picker) {
    return null;
  }
  return filteredSlashItems(picker)[picker.selectedIndex] ?? null;
}

/** Write the entry's canonical invocation over the caret's token — the WHOLE
 *  token run, and only it; the rest of the draft is untouched. With the token
 *  spanning the whole input this is the old whole-value fill, as the
 *  degenerate case. */
function completeSlashEntry(entry: SlashCommandEntry): void {
  const input = elements.promptInput;
  const token = slashTokenAtCursor();
  // No token (the picker outliving its trigger — defensive): insert at the
  // caret rather than overwrite a draft the user is still holding.
  const caret = input.selectionStart ?? input.value.length;
  const start = token?.start ?? caret;
  const end = token?.end ?? caret;
  const tail = input.value.slice(end);
  // Exactly one space separates the invocation from what follows: ours when
  // the run ends the line (or butts against a newline), the existing one
  // otherwise — replacing the whole run must not leave a double space behind.
  const separator = /^[^\S\n]/.test(tail) ? "" : " ";
  input.value = `${input.value.slice(0, start)}${entry.invocation}${separator}${tail}`;
  const nextCaret = start + entry.invocation.length + 1;
  input.focus({ preventScroll: true });
  input.setSelectionRange(nextCaret, nextCaret);
  lastSlashSyncSignature = slashSyncSignature();
  composerTransitions.closeSlashPicker(state);
  renderComposerPopover();
  renderComposerControls();
}

/** The picker's selection semantic, shared by Enter and by an option click. */
function executeSlashEntry(entry: SlashCommandEntry): void {
  const token = slashTokenAtCursor();
  if (token === null || !slashTokenIsWholeInput(token)) {
    // Mid-prompt: pure insertion assist. Submitting here would send a draft
    // the user is still writing, and the CLI would read the token as text
    // anyway (commands dispatch only at line start) — so there is nothing to
    // execute, only text to complete (decision 4).
    completeSlashEntry(entry);
    return;
  }
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
  // Arrows only belong to the picker while it HAS options. On the "No
  // commands" empty state — reachable since the picker tracks a token
  // anywhere in the draft, e.g. a pasted path inside a multi-line prompt —
  // swallowing them would freeze vertical caret movement until Esc.
  if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
    if (!moveSlashSelection(1)) {
      return false;
    }
    event.preventDefault();
    return true;
  }
  if (event.key === "ArrowUp" || (event.key === "p" && event.ctrlKey)) {
    if (!moveSlashSelection(-1)) {
      return false;
    }
    event.preventDefault();
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
    // Nothing matched the query (the empty state is showing): Enter is not the
    // picker's to take. Fall through and submit the draft verbatim — a pasted
    // path or an unknown command goes to the CLI exactly as typed (rule 1).
  }
  return false;
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
