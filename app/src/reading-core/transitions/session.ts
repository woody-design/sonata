/**
 * Named state transitions for session ops (map §3.1, step C3d): following the
 * session index, closing views, the read receipt on focus, and the New Chat
 * launch-draft mutations (including the folder-touched latch).
 *
 * Each transition performs exactly the mutations its shell handler performed
 * before extraction; the shell keeps the IPC calls, the DOM park/restore of
 * the composer textarea, and the render calls.
 */
import type { RuntimeProvider, SessionIndexResponse, SessionSummary } from "../../shared/types";
import type { RendererState, TaskViewState } from "../state";
import { soleHealthyCliProvider } from "../../shared/types/cli-readiness";
import { reasoningEffortForModel, speedOptionsForModel } from "../config";
import { folderName } from "../selectors/formatters";

function isActiveView(state: RendererState, view: TaskViewState): boolean {
  return Boolean(view.task && view.task.id === state.activeTaskId);
}

/**
 * The index is the authoritative session record (live runtimes for live
 * sessions, manifests for dormant ones). Open views must follow it, or
 * a dormant rename updates the sidebar while the header keeps the old
 * title, and a dead PTY can leave the CLI rendering a stale live surface.
 * Returns true when the ACTIVE view changed and needs a full re-render.
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
    const taskChanged =
      incoming.title !== view.task.title ||
      incoming.titleOrigin !== view.task.titleOrigin ||
      Boolean(incoming.archived) !== Boolean(view.task.archived);
    const liveChanged = summary.live !== view.live;
    if (taskChanged) {
      const nextTask = {
        ...view.task,
        title: incoming.title,
        archived: incoming.archived ?? false,
      };
      if (incoming.titleOrigin === undefined) {
        delete nextTask.titleOrigin;
      } else {
        nextTask.titleOrigin = incoming.titleOrigin;
      }
      view.task = nextTask;
    }
    if (liveChanged) {
      view.live = summary.live;
    }
    if ((taskChanged || liveChanged) && isActiveView(state, view)) {
      activeViewChanged = true;
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

/** Switch-away eviction (OBS S8, F1): drop a plain dormant task view when the
 *  user leaves it, so browsing many sessions in one uptime stops accumulating
 *  their transcripts + reports (each run holds up to ~760 KB, never pruned)
 *  until app restart. The view re-hydrates transparently on return through the
 *  existing `selectSession` path — `readSession` rebuilds task/live/status/
 *  report/transcript from main-process truth, so a reopen is byte-equivalent to
 *  a first open. That equivalence is the whole safety argument: every field
 *  `selectSession` does NOT reconstruct is guarded below, so we only ever evict
 *  a view that carries nothing a reopen wouldn't restore.
 *
 *  Retain (return false) if ANY of these holds — over-retention only costs a
 *  little memory; under-retention silently loses user state, so the guards are
 *  deliberately conservative:
 *    - view missing, or it IS the active view (never evict what's on screen);
 *    - LIVE — a PTY/runtime backs it (the F1-accepted retention: unread cues +
 *      streaming state live here; `view.live` is the honest signal, synced from
 *      the session index — `Task` itself carries no liveness field);
 *    - an ATTENTION CUE the user hasn't consumed (`unread` / `completedUnseen`);
 *    - a PARKED DRAFT the user typed (composer text or pending attachments) —
 *      draft safety (ARCHITECTURE.md: drafts park on the view on ownership
 *      change; the caller parks the live textarea via saveComposerDraft BEFORE
 *      calling this, so the guard sees the freshest text);
 *    - an INTERACTION the user perceives as in-progress: a parked resume choice
 *      (its own contract is "switching away is the natural escape and returning
 *      shows the panel again" — eviction must not destroy it), a pending
 *      approval / option-prompt / receipt, an in-flight control switch, a slash
 *      "in the Terminal" pointer, or a queued delivery.
 *    - a per-dormant Remote Control desire (`armedOverride`) — a user setting
 *      `selectSession` does not rebuild.
 *
 *  Not guarded (intentionally, byte-equivalent to first-open anyway): the big
 *  `runTranscripts` blobs (releasing them is the point; dormant reading renders
 *  from report + blocks), `usageSnapshot`, `highlightedRunId`, and grown
 *  `observedPermissionModes` — a fresh `selectSession` open has none of these
 *  either, so losing them on eviction reproduces exactly first-open state.
 *
 *  Returns true when the view was evicted (the caller then clears that task's
 *  renderer-local caches). */
export function evictDormantTaskView(state: RendererState, taskId: string): boolean {
  const view = state.taskViews.find((item) => item.task?.id === taskId);
  if (!view || !view.task) {
    return false;
  }
  if (isActiveView(state, view)) {
    return false;
  }
  if (view.live) {
    return false;
  }
  if (view.unread || view.completedUnseen) {
    return false;
  }
  if (view.composerDraft.trim() !== "" || view.pendingAttachments.length > 0) {
    return false;
  }
  if (
    view.resumeChoice !== null ||
    view.pendingApproval !== null ||
    view.pendingOptionPrompt !== null ||
    view.optionPromptReceipt !== null ||
    view.controlSwitch !== null ||
    view.slashAttention !== null ||
    view.deliveryState !== null
  ) {
    return false;
  }
  if (view.remoteControl.armedOverride !== null) {
    return false;
  }
  state.taskViews = state.taskViews.filter((item) => item.task?.id !== taskId);
  return true;
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
  state.taskDraft.menu = null;
  // Each New Chat starts from the global defaults, so a per-chat choice never
  // leaks into the next one ("Auto-enable Remote Control" means NEW sessions
  // come up on, regardless of what the previous draft was set to; the access
  // chip falls back to the Settings default the same way).
  state.taskDraft.remoteControl = state.remoteControlDefault;
  state.taskDraft.permissionMode = null;
  state.taskDraft.codexPermissionMode = null;
  // Default model/effort are copy-at-entry (unlike permission mode's live-follow
  // null slot): re-seed both providers' model/effort from the launch-default
  // mirrors, and the provider from the last-used rule, so each New Chat starts
  // from what the previous one taught rather than from this draft's leftovers.
  // Effort clamps through the model's gating (a hand-edited JSON pairing a
  // gated tier with a model that can't accept it never survives into the draft).
  seedTaskDraftFromLaunchDefaults(state);
}

/**
 * The New Chat draft's provider — LAST-USED semantics, not a stored preference
 * (CLI readiness D5/L3). Three terms, in order:
 *
 * 1. `lastUsedProvider` — the provider the last session actually started on. A
 *    person who works in Codex opens on Codex without ever having said so.
 * 2. Otherwise the ONE provider that could serve a session, if the readiness
 *    facts single one out. This is the fresh-install courtesy: on a machine with
 *    only Codex installed, the first draft should not open on a Claude that
 *    isn't there. Permissive by construction (`unknown` counts as usable), so it
 *    fires only on a fact Sonata actually observed.
 * 3. Otherwise Claude — both usable, both broken, or nothing probed yet.
 *
 * Terms 2 and 3 are computed FRESH at every seeding moment and never written to
 * disk. That is the whole point of the rule: a seeded guess that persisted would
 * become a sticky wrong answer ("seeded claude on a codex-only machine"), and
 * only a real session start earns the record (main's `createTask`).
 */
function draftProviderSeed(state: RendererState): RuntimeProvider {
  return state.lastUsedProvider ?? soleHealthyCliProvider(state.cliReadiness) ?? "claude";
}

/** Copy the launch seeds (provider + per-provider model/effort) into the New Chat
 *  draft. Shared by boot hydration and every new-chat reset — the single seeding
 *  point for copy-at-entry. */
export function seedTaskDraftFromLaunchDefaults(state: RendererState): void {
  state.taskDraft.provider = draftProviderSeed(state);
  for (const provider of ["claude", "codex"] as const satisfies readonly RuntimeProvider[]) {
    const model = state.defaultModel[provider];
    state.taskDraft.model[provider] = model;
    state.taskDraft.reasoningEffort[provider] = reasoningEffortForModel(
      provider,
      model,
      state.defaultReasoningEffort[provider],
    );
    // Same unwind as setDraftModel (renderer/main.ts): a Fast carried over from
    // a prior draft must not survive onto a seeded model that can't accept it
    // (Claude Fast is Opus-only). Speed itself has no Settings default (out of
    // scope) — this only keeps the seeded pair launch-valid.
    const speedMode = state.taskDraft.speedMode[provider];
    const speedSupported = speedOptionsForModel(provider, model).some(
      (option) => option.value === speedMode,
    );
    if (!speedSupported) {
      state.taskDraft.speedMode[provider] = "default";
    }
  }
}

/** A known project chosen from the project menu — choosing closes it. */
export function chooseDraftFolder(state: RendererState, path: string): void {
  state.taskDraft.cwd = path;
  state.taskDraftFolderTouched = true;
  state.taskDraft.message = null;
  state.taskDraft.menu = null;
}

/** Back to the default Sonata workspace — an explicit clear also counts as
 *  touching the folder. The greeting and the project chip both restate the
 *  choice, so no draft message (2026-07-04: state speaks once, in place). */
export function clearDraftFolder(state: RendererState): void {
  state.taskDraft.cwd = null;
  state.taskDraftFolderTouched = true;
  state.taskDraft.message = null;
  state.taskDraft.menu = null;
}

/** The folder dialog returned a path (pickTaskFolder flow). */
export function applyPickedTaskFolder(state: RendererState, path: string): void {
  state.taskDraft.cwd = path;
  state.taskDraftFolderTouched = true;
  state.status = `Selected ${folderName(path)}`;
  state.taskDraft.message = null;
}
