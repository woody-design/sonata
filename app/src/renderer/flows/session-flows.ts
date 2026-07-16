// Session lifecycle flows (moved verbatim from main.ts at D4d): create /
// submit / resume / approve / stop / answer, the session-index read, sidebar
// session ops, activation and its composer-draft handover, and the
// window-opening flows. Mid-flow render() calls are BEHAVIOR — loading
// states paint at exact points — so call positions are preserved exactly.
// The state atom and the flows' outward calls into view modules, the
// scheduler, and the slash submit guard arrive init-bound from the
// composition root (one mechanism for every upward edge — flows import
// render/dom/reading-core, never view/scheduler/main).

import type {
  ApprovalDecision,
  LaunchSpeedMode,
  ReasoningEffort,
  RuntimeProvider,
} from "../../shared/types";
import {
  errorMessage,
  formatIdleDuration,
  formatTokenCount,
  providerLabel,
} from "../../reading-core/selectors/formatters";
import { optimisticReceiptLines } from "../../reading-core/selectors/composer";
import { dormantArmed } from "../../reading-core/selectors/runs";
import {
  activeTaskView as activeTaskViewOf,
  createTaskView,
  isSessionLifecycleActive,
  taskViewForId,
  upsertTaskView,
  type RendererState,
  type TaskViewState,
} from "../../reading-core/state";
import * as composerTransitions from "../../reading-core/transitions/composer";
import * as sessionTransitions from "../../reading-core/transitions/session";
import {
  claimSessionLifecycle,
  releaseSessionLifecycle,
  transitionSessionLifecycle,
} from "../../reading-core/transitions/session-lifecycle";
import * as renameTransitions from "../../reading-core/transitions/rename";
import type { ViewMode } from "../actions";
import { elements } from "../dom";
import { render } from "../render";
import { clearComposerAttachments, materializeAttachments } from "./attachments";

interface SessionFlowDeps {
  /** Sidebar menu close (view/sidebar) — session ops start by dismissing it. */
  closeSidebarMenu(): void;
  /** Prompt-nav exit choreography (view/prompt-nav). */
  exitPromptNav(options: { focusComposer: boolean; insertText?: string }): void;
  /** Targeted option-prompt repaint (view/approvals) — the busy state paints
   *  without a full render. */
  renderOptionPrompt(): void;
  /** Targeted sidebar repaint (view/sidebar) — the session-index refresh's
   *  cheap path. */
  renderSidebar(): void;
  /** Metadata-only index refreshes still update the CLI breadcrumb binding
   *  without forcing a full Reading render. */
  syncActiveTerminalTaskBinding(): void;
  /** T5/T6 teardown (scheduler) — activation clears hover timers. */
  clearUsagePopoverTimers(): void;
  /** The slash-command submit guard (main.ts slash-assistance satellite). */
  consumeSlashSubmitGuard(text: string): boolean;
}

let state: RendererState;
let deps: SessionFlowDeps;

/** Bound once by main.ts at boot, before the first render (R4). */
export function initSessionFlows(boundState: RendererState, boundDeps: SessionFlowDeps): void {
  state = boundState;
  deps = boundDeps;
}

function activeTaskView(): TaskViewState | null {
  return activeTaskViewOf(state);
}

export async function refreshSessionIndex(): Promise<void> {
  try {
    // Always fetch the full record; status filtering is a view decision.
    state.sessionIndex = await window.duetRuntime.readSessionIndex({ includeArchived: true });
    if (renameTargetDisappeared()) {
      renameTransitions.terminateRenameForMissingEntity(state);
      render();
      return;
    }
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
    deps.renderSidebar();
    deps.syncActiveTerminalTaskBinding();
  } catch (error) {
    console.debug("session index read failed", error);
  }
}

function renameTargetDisappeared(): boolean {
  const editor = state.sidebar.renameEditor;
  const index = state.sessionIndex;
  if (!editor || !index) {
    return false;
  }
  if (editor.kind === "project") {
    return !index.projects.some((project) => project.path === editor.path);
  }
  return ![
    ...index.chats,
    ...index.projects.flatMap((project) => project.sessions),
  ].some((session) => session.task.id === editor.taskId);
}

export async function archiveSessionFromSidebar(taskId: string): Promise<void> {
  const ownerToken = claimSessionLifecycle(state, (token) => ({
    phase: "session-mutation",
    ownerToken: token,
    taskId,
    action: "archive",
  }));
  if (!ownerToken) {
    return;
  }
  render();
  try {
    await window.duetRuntime.archiveSession({ taskId, archived: true });
    // The main process stopped the PTY; drop the local view either way.
    removeTaskViewLocally(taskId);
  } catch (error) {
    state.status = errorMessage(error);
  } finally {
    releaseSessionLifecycle(state, ownerToken);
    render();
  }
}

export async function unarchiveSessionFromSidebar(taskId: string): Promise<void> {
  const ownerToken = claimSessionLifecycle(state, (token) => ({
    phase: "session-mutation",
    ownerToken: token,
    taskId,
    action: "unarchive",
  }));
  if (!ownerToken) {
    return;
  }
  render();
  try {
    await window.duetRuntime.archiveSession({ taskId, archived: false });
  } catch (error) {
    state.status = errorMessage(error);
  } finally {
    releaseSessionLifecycle(state, ownerToken);
    render();
  }
}

export async function deleteSessionFromSidebar(taskId: string, title: string): Promise<void> {
  const confirmed = window.confirm(
    `Delete "${title}"?\n\nThis removes the session from Duet. The provider transcript and your working folder are kept.`,
  );
  if (!confirmed) {
    return;
  }
  const ownerToken = claimSessionLifecycle(state, (token) => ({
    phase: "session-mutation",
    ownerToken: token,
    taskId,
    action: "delete",
  }));
  if (!ownerToken) {
    return;
  }
  render();
  try {
    await window.duetRuntime.deleteSession({ taskId });
    removeTaskViewLocally(taskId);
  } catch (error) {
    state.status = errorMessage(error);
  } finally {
    releaseSessionLifecycle(state, ownerToken);
    render();
  }
}

export async function archiveProjectFromSidebar(
  path: string,
  archived: boolean,
): Promise<void> {
  const ownerToken = claimSessionLifecycle(state, (token) => ({
    phase: "project-mutation",
    ownerToken: token,
    path,
    action: archived ? "archive" : "unarchive",
  }));
  if (!ownerToken) {
    return;
  }
  render();
  try {
    await window.duetRuntime.archiveProject({ path, archived });
    if (archived) {
      clearParkedResumeChoicesForArchivedProject(path);
    }
  } catch (error) {
    state.status = errorMessage(error);
  } finally {
    releaseSessionLifecycle(state, ownerToken);
    render();
  }
}

/** De-modalization lets a project be archived while one of its sessions holds a
 *  parked resume choice. `openTask` has no archived-project guard, so confirming
 *  that stale choice would respawn a runtime inside the just-archived project.
 *  Drop the parked choice on every affected view (narrow fix — project-archive
 *  view semantics are otherwise unchanged; unarchive re-derives the choice on the
 *  next resume attempt, so nothing is lost). */
function clearParkedResumeChoicesForArchivedProject(projectPath: string): void {
  const target = normalizeProjectPath(projectPath);
  for (const view of state.taskViews) {
    if (!view.resumeChoice || !view.task) {
      continue;
    }
    const cwd = normalizeProjectPath(view.task.providerCwd || view.task.workingDirectory);
    if (cwd === target) {
      view.resumeChoice = null;
      view.status = "Project archived";
    }
  }
}

function normalizeProjectPath(value: string): string {
  return value.replace(/[/\\]+$/, "");
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

export async function selectSession(taskId: string): Promise<void> {
  if (isSessionLifecycleActive(state)) {
    return;
  }
  deps.closeSidebarMenu();
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

export function startNewChat(folder?: string | null): void {
  if (isSessionLifecycleActive(state)) {
    return;
  }
  deps.closeSidebarMenu();
  deps.exitPromptNav({ focusComposer: false });
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

export function activateTask(taskId: string, lifecycleOwnerToken?: string): void {
  const lifecycle = state.sessionLifecycle;
  if (
    lifecycle.phase !== "idle" &&
    lifecycle.ownerToken !== lifecycleOwnerToken
  ) {
    return;
  }
  const view = taskViewForId(state, taskId);
  if (!view) {
    return;
  }
  const switching = state.activeTaskId !== taskId;
  if (switching) {
    saveComposerDraft();
    deps.exitPromptNav({ focusComposer: false });
    state.usagePopover = null;
    deps.clearUsagePopoverTimers();
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

/** Return focus to the composer after a draft-moving phase disabled (and thus
 *  blurred) it — but ONLY when it held focus at claim AND focus is still
 *  orphaned exactly as a disable leaves it (on <body>/<html>, or nowhere). A
 *  user who moved focus to another control during the held window (Reading
 *  Settings, a sidebar row — none of which are lifecycle-disabled) still owns
 *  it; never yank it back from them. Idle + enabled are required so we never
 *  fight the render that re-enables the input. */
function repairComposerFocusIfOrphaned(hadFocus: boolean): void {
  const active = document.activeElement;
  const orphaned = active === null || active === document.body || active === document.documentElement;
  if (
    hadFocus &&
    orphaned &&
    !isSessionLifecycleActive(state) &&
    !elements.promptInput.disabled
  ) {
    elements.promptInput.focus({ preventScroll: true });
  }
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
  lifecycleOwnerToken: string,
  options: { cwd?: string | null } = {},
): Promise<{ taskId: string; view: TaskViewState } | null> {
  const providerName = providerLabel(provider);
  state.busy = true;
  state.status = `Starting ${providerName}`;
  state.taskDraft.menu = null;
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
      // Per-session access mode (2026-07-04): only an explicit choice travels;
      // an untouched draft lets the main process apply the Settings default
      // itself (single source of truth for "what default means now"). Each
      // provider carries its own permission field — an untouched draft omits
      // it so the main process fills from the matching Settings default.
      ...(provider === "claude" && state.taskDraft.permissionMode
        ? { permissionMode: state.taskDraft.permissionMode }
        : {}),
      ...(provider === "codex" && state.taskDraft.codexPermissionMode
        ? { codexPermissionMode: state.taskDraft.codexPermissionMode }
        : {}),
      ...(provider === "claude" && state.taskDraft.remoteControl ? { remoteControl: true } : {}),
    });
    const view = createTaskView(response.task, `${providerName} PTY ${response.runtime.pid}`);
    if (provider === "claude" && state.taskDraft.remoteControl) {
      // Spawned with --remote-control: reflect "on" immediately; the scraped URL
      // confirms and fills the link a beat later (~1.2s).
      view.remoteControl.active = true;
    }
    upsertTaskView(state, view);
    activateTask(response.task.id, lifecycleOwnerToken);
    void hydrateTranscript(response.task.id);
    void hydrateUsage(response.task.id);
    return { taskId: response.task.id, view };
  } catch (error) {
    const message = errorMessage(error);
    state.status = message;
    state.taskDraft.message = {
      tone: "error",
      text: message,
    };
    return null;
  } finally {
    state.busy = false;
    render();
  }
}

export async function submitPrompt(): Promise<void> {
  const view = activeTaskView();
  const text = elements.promptInput.value.trim();

  if (deps.consumeSlashSubmitGuard(text)) {
    return;
  }
  if (isSessionLifecycleActive(state)) {
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

  const ownerToken = claimSessionLifecycle(state, (token) => {
    if (!view) {
      return { phase: "starting", ownerToken: token, sendAfterStart: true };
    }
    if (!view.live && view.task) {
      return {
        phase: "preparing-resume",
        ownerToken: token,
        taskId: view.task.id,
        sendAfterResume: true,
        promptText: text,
      };
    }
    return {
      phase: "sending",
      ownerToken: token,
      taskId: view.task?.id ?? null,
    };
  });
  if (!ownerToken) {
    return;
  }

  // Focus repair (D1) applies only to the draft-moving dormant-resume branch —
  // the live path never disables the input, and the new-chat path is not repaired
  // (the caller re-focuses after creation). Captured before the disabling render.
  const composerHadFocus = document.activeElement === elements.promptInput;
  let enteredDormantResume = false;
  // D2 optimistic clear: on the live path the composer is emptied synchronously
  // (direct-manipulation feedback), and the raw value is held so an error can
  // restore it without destroying anything typed since.
  let liveSendRawInput: string | null = null;
  render();
  try {
    if (!view) {
      // New chat: the first message (text and/or attachments) creates the session.
      await createSessionFromComposer(text, ownerToken);
    } else if (!view.live) {
      // Dormant session: lazy spawn + native resume, then queue the message.
      // When resume needs a choice, resumeSession releases the claim itself and
      // leaves the panel on the view; the finally-release below is then a no-op.
      enteredDormantResume = true;
      await resumeSession(view, { sendAfterResume: true, promptText: text }, ownerToken);
    } else if (view.task) {
      const taskId = view.task.id;
      // Clear before the first await so the send reads as instant; keep the raw
      // (untrimmed) value for error restore.
      liveSendRawInput = elements.promptInput.value;
      elements.promptInput.value = "";
      view.status = "Queued";
      render();
      const attachments = await materializeAttachments(view.pendingAttachments, taskId);
      await window.duetRuntime.submitPrompt({ taskId, text, attachments });
      clearComposerAttachments(view.pendingAttachments);
    }
  } catch (error) {
    if (view?.task) {
      view.status = errorMessage(error);
    } else {
      state.status = errorMessage(error);
    }
    if (liveSendRawInput !== null) {
      // D2 restore invariant: no error path may destroy user text. If the input
      // is empty the sent text goes back verbatim; if the user typed something
      // during the window, prepend the sent text to what they typed.
      const current = elements.promptInput.value;
      elements.promptInput.value = current ? `${liveSendRawInput}${current}` : liveSendRawInput;
    }
  } finally {
    // Release is idempotent: when resumeSession already released on the needs-
    // choice path (state now idle) this is a no-op; otherwise it ends the flight.
    releaseSessionLifecycle(state, ownerToken);
    render();
    // Draft-moving freeze blurred the composer; return focus once idle+enabled.
    // On the needs-choice path the lifecycle is now idle and the composer
    // enabled, so focus returns to it — the panel is shown and editable (WYSIWYG).
    if (enteredDormantResume) {
      repairComposerFocusIfOrphaned(composerHadFocus);
    }
  }
}

async function createSessionFromComposer(text: string, ownerToken: string): Promise<void> {
  const created = await createTask(
    state.taskDraft.provider,
    ownerToken,
    { cwd: state.taskDraft.cwd },
  );
  if (!created?.view.task) {
    // Creation failed; createTask already surfaced the error.
    return;
  }
  const { view, taskId } = created;
  // Deferred creation is an ownership handover: this draft now belongs to the
  // session it just created. createTask→activateTask parked the still-visible
  // text into the New Chat slot a moment ago — consume it, or the next New
  // Chat resurrects an already-sent prompt.
  state.newChatComposerDraft = "";
  try {
    // The session now exists — materialize the held draft (copy bitmaps, pass
    // references through) and deliver with the first prompt.
    const attachments = await materializeAttachments(state.draftAttachments, taskId);
    await window.duetRuntime.submitPrompt({ taskId, text, attachments });
    view.composerDraft = "";
    if (state.activeTaskId === taskId) {
      elements.promptInput.value = "";
    }
    clearComposerAttachments(state.draftAttachments);
  } catch (error) {
    view.status = errorMessage(error);
    // The session was created but delivery failed — don't lose the user's
    // words or attachments. The text goes back into the composer the user is
    // now standing in (the new task's), visible and retriable; the attachment
    // draft moves into the task's pending list the same way (keep their
    // preview URLs; don't revoke).
    view.composerDraft = text;
    if (state.activeTaskId === taskId) {
      elements.promptInput.value = text;
    }
    view.pendingAttachments.push(...state.draftAttachments);
    state.draftAttachments.length = 0;
  } finally {
    render();
  }
}

export async function startCliWithoutPrompt(): Promise<void> {
  if (
    state.activeTaskId !== null ||
    state.busy ||
    !state.launchSettingsHydrated ||
    isSessionLifecycleActive(state)
  ) {
    return;
  }
  const ownerToken = claimSessionLifecycle(state, (token) => ({
    phase: "starting",
    ownerToken: token,
    sendAfterStart: false,
  }));
  if (!ownerToken) {
    return;
  }
  const draftText = elements.promptInput.value;
  const composerHadFocus = document.activeElement === elements.promptInput;
  render();
  try {
    const created = await createTask(
      state.taskDraft.provider,
      ownerToken,
      { cwd: state.taskDraft.cwd },
    );
    if (!created) {
      return;
    }
    const { taskId, view } = created;
    view.composerDraft = draftText;
    view.pendingAttachments.push(...state.draftAttachments);
    state.draftAttachments.length = 0;
    state.newChatComposerDraft = "";
    if (state.activeTaskId === taskId) {
      elements.promptInput.value = draftText;
    }
  } catch (error) {
    state.status = errorMessage(error);
  } finally {
    releaseSessionLifecycle(state, ownerToken);
    render();
    // The `starting` freeze blurred the composer if it held focus; return it.
    repairComposerFocusIfOrphaned(composerHadFocus);
  }
}

export async function resumeTaskWithoutPrompt(expectedTaskId: string): Promise<void> {
  const view = activeTaskView();
  if (
    !view?.task ||
    view.task.id !== expectedTaskId ||
    view.live ||
    state.busy ||
    isSessionLifecycleActive(state)
  ) {
    return;
  }
  const ownerToken = claimSessionLifecycle(state, (token) => ({
    phase: "preparing-resume",
    ownerToken: token,
    taskId: expectedTaskId,
    sendAfterResume: false,
    promptText: "",
  }));
  if (!ownerToken) {
    return;
  }
  const composerHadFocus = document.activeElement === elements.promptInput;
  render();
  try {
    // needs-choice releases the claim inside resumeSession and parks the panel
    // on the view; the finally-release below is then a no-op.
    await resumeSession(view, { sendAfterResume: false, promptText: "" }, ownerToken);
  } catch (error) {
    view.status = errorMessage(error);
  } finally {
    releaseSessionLifecycle(state, ownerToken);
    render();
    // The draft-moving freeze blurred the composer; return focus once idle and
    // enabled (idle after either the direct resume or a needs-choice release).
    repairComposerFocusIfOrphaned(composerHadFocus);
  }
}

async function resumeSession(
  view: TaskViewState,
  intent: { sendAfterResume: boolean; promptText: string },
  ownerToken: string,
): Promise<void> {
  if (!view.task) {
    return;
  }
  const taskId = view.task.id;

  // The resume moment (D3): for a large dormant Claude session with policy
  // "ask", the first send CONVERTS into a choice. The choice is pure view
  // state — we park it on the view (with the sendAfterResume intent bit) and
  // RELEASE the claim so the app stays fully interactive; switching away is the
  // natural escape and returning shows the panel again. `resolveResumeChoice`
  // claims a fresh lifecycle at confirm time. The prompt text is NOT stored: it
  // is read from the composer at confirm (WYSIWYG).
  let resumeMode: "full" | "summary" | undefined;
  const preparation = await window.duetRuntime.prepareResume({ taskId });
  if (preparation.needsChoice) {
    view.resumeChoice = {
      idleMs: preparation.idleMs,
      totalTokens: preparation.totalTokens,
      bridgeDismissed: preparation.bridgeDismissed,
      sendAfterResume: intent.sendAfterResume,
    };
    view.status = "Choose how to resume";
    releaseSessionLifecycle(state, ownerToken);
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

  transitionSessionLifecycle(state, ownerToken, {
    phase: "resuming",
    ownerToken,
    taskId,
    sendAfterResume: intent.sendAfterResume,
    promptText: intent.promptText,
  });
  await openDormantSessionAndSend(
    view,
    intent.promptText,
    resumeMode,
    intent.sendAfterResume,
  );
}

async function openDormantSessionAndSend(
  view: TaskViewState,
  text: string,
  resumeMode: "full" | "summary" | undefined,
  sendAfterResume: boolean,
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
      ? sendAfterResume
        ? "Resumed — your message will send when the agent is ready"
        : "Resumed"
      : "Couldn't restore the agent's memory — continuing as a new session; the history above stays readable";
    if (sendAfterResume) {
      // The session is live now — materialize the held items (copy bitmaps,
      // pass references through) and deliver.
      const attachments = await materializeAttachments(view.pendingAttachments, taskId);
      if (text || attachments.length > 0) {
        await window.duetRuntime.submitPrompt({ taskId, text, attachments });
        view.composerDraft = "";
        if (state.activeTaskId === taskId) {
          elements.promptInput.value = "";
        }
        clearComposerAttachments(view.pendingAttachments);
      }
    }
    void hydrateUsage(taskId);
  } catch (error) {
    view.status = errorMessage(error);
  } finally {
    state.busy = false;
    render();
  }
}

export async function resolveResumeChoice(mode: "full" | "summary"): Promise<void> {
  const view = activeTaskView();
  if (!view?.task || !view.resumeChoice) {
    return;
  }
  const taskId = view.task.id;
  const sendAfterResume = view.resumeChoice.sendAfterResume;
  // WYSIWYG: for a composer-initiated (sendAfterResume) choice the prompt is
  // whatever the composer shows right now — read it at confirm time. A bare
  // "Resume task" (sendAfterResume=false) sends nothing and never touches the
  // draft or attachments (the no-prompt invariant), so its prompt is empty.
  const promptText = sendAfterResume ? elements.promptInput.value.trim() : "";
  // Claim a fresh lifecycle SYNCHRONOUSLY, before any await — that claim IS the
  // double-click protection: the second click finds the lifecycle active
  // (claim returns null) and returns.
  const ownerToken = claimSessionLifecycle(state, (token) => ({
    phase: "resuming",
    ownerToken: token,
    taskId,
    sendAfterResume,
    promptText,
  }));
  if (!ownerToken) {
    return;
  }
  // Clear the panel + remember checkbox only after the claim succeeds.
  const remember = elements.resumeRemember.checked;
  view.resumeChoice = null;
  elements.resumeRemember.checked = false;
  render();

  try {
    if (remember) {
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
    await openDormantSessionAndSend(view, promptText, mode, sendAfterResume);
  } finally {
    releaseSessionLifecycle(state, ownerToken);
    render();
  }
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

export async function decideApproval(decision: ApprovalDecision): Promise<void> {
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

export async function stopRun(): Promise<void> {
  // Mutual exclusion (D1): with the blanket keydown guard gone, Escape→stopRun
  // is reachable during an active lifecycle. Drop it — a stop must never race a
  // create/send/resume/mutation. No legitimate long-lived stop-during-lifecycle
  // path exists (draft-moving phases disable the input so Escape can't fire;
  // sending/attaching/mutation windows are ms-scale), so this is at worst a
  // silent, immediately-retryable drop.
  if (isSessionLifecycleActive(state)) {
    return;
  }
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

export async function refreshReport(taskId = state.activeTaskId): Promise<void> {
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

export async function answerOptionPrompt(): Promise<void> {
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
  deps.renderOptionPrompt();
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

export async function pickTaskFolder(): Promise<void> {
  state.busy = true;
  state.status = "Choosing Task Folder";
  state.taskDraft.menu = null;
  state.taskDraft.message = null;
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

export async function openFloatingPreview(): Promise<void> {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }

  await window.duetRuntime.openPreview({ taskId: view.task.id });
}

/** Switch the active task's surface (Read ⇄ Terminal). Per-task: only the active
 *  task is touched. Leaving Terminal hands the keys back — control must never be
 *  held where the human can't type (model Y). Entering Terminal attaches + fits
 *  the xterm once the pane is visible. */
export function surfaceTerminalWindow(): void {
  void window.duetRuntime.setTerminalWindowOpen(true).catch(() => {});
}

export function setViewMode(mode: ViewMode): void {
  // The terminal is its own window now: "switch to terminal" opens and focuses
  // it, and there is no in-pane Read/Terminal switch to toggle. Keeping this as
  // the single choke point lets every "surface the terminal" caller (approvals,
  // modals, slash commands, the delivery queue) keep working unchanged.
  if (mode === "terminal") {
    surfaceTerminalWindow();
  }
}
