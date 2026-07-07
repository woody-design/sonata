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
  taskViewForId,
  upsertTaskView,
  type RendererState,
  type TaskViewState,
} from "../../reading-core/state";
import * as composerTransitions from "../../reading-core/transitions/composer";
import * as sessionTransitions from "../../reading-core/transitions/session";
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
  } catch (error) {
    console.debug("session index read failed", error);
  }
}

export async function archiveSessionFromSidebar(taskId: string): Promise<void> {
  try {
    await window.duetRuntime.archiveSession({ taskId, archived: true });
    // The main process stopped the PTY; drop the local view either way.
    removeTaskViewLocally(taskId);
  } catch (error) {
    state.status = errorMessage(error);
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

export async function selectSession(taskId: string): Promise<void> {
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

export function activateTask(taskId: string): void {
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
      sandbox: "read-only",
      // Per-session access mode (2026-07-04): only an explicit choice travels;
      // an untouched draft lets the main process apply the Settings default
      // itself (single source of truth for "what default means now"). Codex
      // approval now falls through here too — the main process fills it from
      // the Codex approval default (Settings → Codex).
      ...(provider === "claude" && state.taskDraft.permissionMode
        ? { permissionMode: state.taskDraft.permissionMode }
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

/** Re-entrancy guard: a send (materialize + submit) is in flight. Blocks a fast
 *  double-Enter from re-materializing the same attachments (duplicate blob +
 *  double delivery) on the live path, which — unlike new-chat/dormant — has no
 *  state.busy gate. */
let composerSending = false;

export async function submitPrompt(): Promise<void> {
  const view = activeTaskView();
  const text = elements.promptInput.value.trim();

  if (deps.consumeSlashSubmitGuard(text)) {
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

export async function resolveResumeChoice(mode: "full" | "summary"): Promise<void> {
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
