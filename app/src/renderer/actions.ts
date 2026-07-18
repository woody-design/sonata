// Late-binding actions seam (map §2.5; pulled forward from D4c to D0 by the
// program-brain amendment, execution log 2026-07-03). View modules attach
// handlers that call back into the shell — flows, mode switches, prompt-nav
// choreography. A static import of main.ts would cycle (main → view → main);
// the typed interface lives here, and main.ts binds the implementation once
// at boot, BEFORE the first render (boot order R4).
//
// Scope rule (C3 ruling, execution log): bare state assignments in view event
// handlers are grammar, not policy — when a view moves out of main.ts they
// route through this seam as shell-implemented actions, never as reading-core
// transitions. The interface holds ONLY what moved view code actually calls
// (D0 survey over the D1/D2 packet); D-mid extends it as further view
// families move. Survey notes: focusRun (named in the map's candidate list)
// has zero callers since the artifact strip retired — deferred dead-code
// list, not seamed; selectSession / startNewChat / executeSlashEntry become
// needed when D3 moves the sidebar and slash-picker families.

import type {
  ClaudeDefaultPermissionMode,
  ClaudePermissionMode,
  CodexPermissionMode,
  LaunchSpeedMode,
  ReadingSettings,
  ReasoningEffort,
  ResumePolicyId,
  RuntimeProvider,
  SlashCommandEntry,
} from "../shared/types";
import type { RenameCommitTrigger } from "../reading-core/transitions/rename";
import type { RenameFlowResult } from "../reading-core/rename-flow";
import type {
  ComposerAttachment,
  SettingsOverlayState,
  SidebarPrefs,
  SidebarRenameEditor,
  SlashPickerState,
  TaskViewState,
} from "../reading-core/state";

/** The two co-equal surfaces of a task: the crafted reading view and the raw
 *  terminal. Both ARE Sonata — the switch picks which lens is in front. */
export type ViewMode = "read" | "terminal";

export interface Actions {
  // State reads deliberately absent (D-early ruling 1, normalized at
  // D-mid-0): views read through their init-bound state reference and the
  // reading-core activeTaskView(state) helper. Actions = behaviors only,
  // permanently.
  /** Surface switch — the single choke point every "open the terminal"
   *  caller goes through (approvals, banners, fallbacks, stall notices). */
  setViewMode(mode: ViewMode): void;
  /** Sticky-prompt rail header click: scroll the prompt's turn into view. */
  scrollToPromptTurn(turnKey: string): void;
  /** Post-render prompt-nav restore — first half of the finalize contract. */
  restorePromptNavAfterRender(): void;
  /** Sticky-header rAF coalesce (T4) — second half of the finalize contract. */
  scheduleStickyPromptSync(): void;
  /** Folder-picker flow (busy state + IPC dialog + render). */
  pickTaskFolder(): void;
  // — New Chat entry panel (view/entry.ts) handler mutations: bare draft
  //   assignments are grammar (C3 ruling) — implemented shell-side, each is
  //   the verbatim body of the handler it replaced plus the repaint. —
  chooseDraftProvider(provider: RuntimeProvider): void;
  chooseDraftFolder(path: string): void;
  clearDraftFolder(): void;
  setDraftReasoningEffort(provider: RuntimeProvider, value: ReasoningEffort | null): void;
  setDraftModel(provider: RuntimeProvider, value: string | null): void;
  setDraftSpeedMode(provider: RuntimeProvider, value: LaunchSpeedMode): void;
  /** Per-session access mode (the Settings triad; closes the access menu). */
  setDraftPermissionMode(mode: ClaudePermissionMode): void;
  /** Per-session Codex permission mode (the Codex twin; closes the access menu). */
  setDraftCodexPermissionMode(mode: CodexPermissionMode): void;
  // — Attention banners (view/banners.ts) dismiss mutations: bare
  //   assignments are grammar (C3 ruling) — implemented shell-side, each the
  //   verbatim body of the dismiss handler it replaced. —
  dismissSlashAttention(view: TaskViewState): void;
  /** Clear the mid-session control-switch pointer (needs-attention banner). */
  dismissControlSwitch(view: TaskViewState): void;
  // — Live session chips (mid-session switch): drive THIS Claude session's
  //   model/effort (S1 — `/model <id>` / `/effort <level>`) or permission mode
  //   (S2 — the Shift+Tab stepping engine). The receipt(s) drive the chips
  //   through the control-switch:state event, so these fire-and-forget. —
  switchSessionModel(view: TaskViewState, value: string): void;
  switchSessionEffort(view: TaskViewState, value: string): void;
  switchSessionPermission(view: TaskViewState, mode: string): void;
  //   Codex permission preset (S3 — the `/permissions` picker choreography).
  switchSessionCodexPermission(view: TaskViewState, mode: string): void;
  // — Option-prompt card (view/approvals.ts): select grammar + answer flow
  //   (IPC injection; optimistic receipt) —
  selectOptionPromptChoice(view: TaskViewState, questionIndex: number, optionIndex: number): void;
  /** Free-text draft for a (single-select) question — clears its picked option. */
  setOptionPromptText(view: TaskViewState, questionIndex: number, text: string): void;
  /** Stepper navigation (drawer S2): 0..N-1 = questions, N = Review. Clamped. */
  setOptionPromptStep(view: TaskViewState, step: number): void;
  /** "Done with this question": advance to the next UNANSWERED question, else
   *  Review (drawer S5 — one semantic for picks, multi Next, and text Next). */
  advanceOptionPromptStep(view: TaskViewState, fromIndex: number): void;
  answerOptionPrompt(): void;
  /** Dismiss the pending questions ("Chat about this") — decline + steer. */
  dismissOptionPrompt(): void;
  // — Sidebar (view/sidebar.ts): session/project flows and the
  //   localStorage-backed prefs/collapse ports. One action per handler
  //   (D-early ruling 3); the IPC bodies are verbatim shell-side. —
  selectSession(taskId: string): void;
  startNewChat(folder?: string | null): void;
  setSidebarPrefs(patch: Partial<SidebarPrefs>): void;
  toggleProjectCollapsed(path: string): void;
  startSessionRename(
    taskId: string,
    surface: "header" | "sidebar",
    original: string,
  ): void;
  startProjectRename(path: string, original: string): void;
  cancelRename(): void;
  commitRename(trigger: RenameCommitTrigger): Promise<RenameFlowResult>;
  /** Releases commit/continuation intents that arrived while an IME owned the
   * protected input. Identity keeps an old composition from waking a new edit. */
  completeRenameComposition(editor: SidebarRenameEditor): void;
  /** Resolves only after a Sidebar-origin editor is safely closed. Header
   *  editors do not block independent Sidebar view changes. */
  prepareSidebarStructureChange(): Promise<boolean>;
  revealSession(taskId: string): void;
  revealProject(path: string): void;
  archiveSessionFromSidebar(taskId: string): void;
  unarchiveSession(taskId: string): void;
  deleteSessionFromSidebar(taskId: string, title: string): void;
  archiveProject(path: string, archived: boolean): void;
  // — Slash picker (view/slash-picker.ts): the Enter/click dispatch flow
  //   (complete-or-execute semantics live in the shell) and the mousemove
  //   hover grammar (selection follow + composer-popover repaint). —
  executeSlashEntry(entry: SlashCommandEntry): void;
  hoverSlashOption(picker: SlashPickerState, index: number): void;
  // — Composer (view/composer.ts): attachment-removal port (object-URL
  //   revoke), the Add-menu reference-picker flow, the T5/T6 usage-popover
  //   hover timers, and the slash-picker composition into the popover root
  //   (sibling view families compose through main.ts — D-early ruling 2). —
  removeComposerAttachment(list: ComposerAttachment[], target: ComposerAttachment): void;
  pickReferencesFromAddMenu(): void;
  clearUsagePopoverCloseTimer(): void;
  scheduleUsagePopoverClose(): void;
  renderSlashPicker(picker: SlashPickerState): HTMLElement;
  positionSlashPicker(pickerElement: HTMLElement): void;
  // — Settings overlay (view/settings.ts): close transition, popup-menu
  //   grammar, and the instant-apply persist flows. —
  closeSettingsOverlay(): void;
  closeSettingsPopupMenus(overlay: SettingsOverlayState): void;
  toggleSettingsApprovalMenu(overlay: SettingsOverlayState): void;
  toggleSettingsCodexPermissionMenu(overlay: SettingsOverlayState): void;
  toggleSettingsPolicyMenu(overlay: SettingsOverlayState): void;
  persistDefaultPermissionMode(mode: ClaudeDefaultPermissionMode): void;
  persistCodexDefaultPermissionMode(mode: CodexPermissionMode): void;
  persistCodexAutoTrustProjectFolders(value: boolean): void;
  persistResumePolicy(policy: ResumePolicyId): void;
  setDefaultRemoteControl(value: boolean): void;
  restoreResumeBridge(): void;
  // — Chrome (view/chrome.ts): the reading-settings persist flow, the RC
  //   arm toggle (pre-spawn desire, draft or dormant), and the RC flows. —
  persistReadingSettings(settings: ReadingSettings): void;
  toggleRemoteControlArm(mode: "arm-draft" | "arm-dormant"): void;
  enableRemoteControl(): void;
  manageRemoteControl(): void;
}

/** The bound registry. Reading it before initActions() runs is a boot-order
 *  violation and throws at the call site (undefined member access). */
export let actions: Actions;

/** Bound once by main.ts at boot, before the first render (R4). */
export function initActions(impl: Actions): void {
  actions = impl;
}
