/**
 * Named state transitions for session ops (map §3.1, step C3d): following the
 * session index, closing views, the read receipt on focus, and the New Chat
 * launch-draft mutations (including the folder-touched latch).
 *
 * Each transition performs exactly the mutations its shell handler performed
 * before extraction; the shell keeps the IPC calls, the DOM park/restore of
 * the composer textarea, and the render calls.
 */
import type { SessionIndexResponse, SessionSummary } from "../../shared/types";
import type { RendererState, TaskViewState } from "../state";
import { folderName } from "../selectors/formatters";

function isActiveView(state: RendererState, view: TaskViewState): boolean {
  return Boolean(view.task && view.task.id === state.activeTaskId);
}

/**
 * The index is the authoritative session record (live runtimes for live
 * sessions, manifests for dormant ones). Open views must follow it, or
 * a dormant rename updates the sidebar while the header keeps the old
 * title. Returns true when the ACTIVE view changed and needs a full
 * re-render.
 */
export function syncTaskViewsFromIndex(
  state: RendererState,
  index: SessionIndexResponse,
): boolean {
  const summaries = new Map<string, SessionSummary>();
  for (const project of index.projects) {
    for (const session of project.sessions) {
      summaries.set(session.task.id, session);
    }
  }
  for (const session of index.chats) {
    summaries.set(session.task.id, session);
  }

  let activeViewChanged = false;
  for (const view of state.taskViews) {
    if (!view.task) {
      continue;
    }
    const summary = summaries.get(view.task.id);
    if (!summary) {
      continue;
    }
    const incoming = summary.task;
    if (
      incoming.title !== view.task.title ||
      Boolean(incoming.archived) !== Boolean(view.task.archived)
    ) {
      view.task = { ...view.task, title: incoming.title, archived: incoming.archived ?? false };
      if (isActiveView(state, view)) {
        activeViewChanged = true;
      }
    }
  }
  return activeViewChanged;
}

/** Drop a task view. Returns true when it was the ACTIVE view — the closed
 *  view's draft dies with it, so the shell hands the composer over to the
 *  New Chat slot (restoreComposerDraft, a DOM write). */
export function removeTaskView(state: RendererState, taskId: string): boolean {
  state.taskViews = state.taskViews.filter((item) => item.task?.id !== taskId);
  if (state.activeTaskId === taskId) {
    state.activeTaskId = null;
    state.usagePopover = null;
    return true;
  }
  return false;
}

/** The read receipt: focusing a view consumes its unread and
 *  finished-while-away cues. */
export function markViewSeen(view: TaskViewState): void {
  view.unread = false;
  view.completedUnseen = false;
}

/** The New Chat entry reset: seed the folder (explicit pick wins and sets the
 *  touched latch; otherwise fall back to the index's last-used folder until
 *  the user has picked one), clear the message, and re-seed Remote Control. */
export function resetTaskDraftForNewChat(state: RendererState, folder?: string | null): void {
  if (folder) {
    state.taskDraft.cwd = folder;
    state.taskDraftFolderTouched = true;
  } else if (!state.taskDraftFolderTouched) {
    state.taskDraft.cwd = state.sessionIndex?.lastUsedFolder ?? state.taskDraft.cwd;
  }
  state.taskDraft.message = null;
  // Each New Chat starts from the global default, so a per-chat toggle never
  // leaks into the next one ("Auto-enable Remote Control" means NEW sessions
  // come up on, regardless of what the previous draft was set to).
  state.taskDraft.remoteControl = state.remoteControlDefault;
}

/** A known project chosen from the quick row. */
export function chooseDraftFolder(state: RendererState, path: string): void {
  state.taskDraft.cwd = path;
  state.taskDraftFolderTouched = true;
  state.taskDraft.message = null;
}

/** Back to the default Duet workspace — an explicit clear also counts as
 *  touching the folder. */
export function clearDraftFolder(state: RendererState): void {
  state.taskDraft.cwd = null;
  state.taskDraftFolderTouched = true;
  state.taskDraft.message = {
    tone: "info",
    text: "Using the default Duet workspace for new Tasks.",
  };
}

/** The folder dialog returned a path (pickTaskFolder flow). */
export function applyPickedTaskFolder(state: RendererState, path: string): void {
  state.taskDraft.cwd = path;
  state.taskDraftFolderTouched = true;
  state.status = `Selected ${folderName(path)}`;
  state.taskDraft.message = {
    tone: "info",
    text: `Selected ${folderName(path)}.`,
  };
}
