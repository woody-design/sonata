// Paint orchestration (map §1.4, moved verbatim from main.ts at D4a): the
// full-render orchestrator, the transcript-streaming path, and the directive
// performer are one concern — every render-path CHOICE the reducer emits is
// performed here, and the §1.4 sub-render order is untouchable. main.ts (the
// composition root) binds the state atom and the outward call targets once at
// boot (initRender): the debounce schedulers (T2/T3 — main.ts until D4b, then
// scheduler.ts) and the report-refresh flow (main.ts until D4d, then flows/)
// arrive as init-bound deps so render never imports upward — flows and the
// scheduler may import render, never the reverse.

import {
  activeTaskView as activeTaskViewOf,
  taskViewForId,
  type RendererState,
  type TaskViewState,
} from "../reading-core/state";
import type { Directive } from "../reading-core/directives";
import { elements } from "./dom";
import {
  renderApproval,
  renderOptionPrompt,
  renderResumeChoice,
} from "./view/approvals";
import { renderAttentionBanners } from "./view/banners";
import { composerNotice } from "../reading-core/selectors/composer";
import {
  renderReadingPopover,
  renderRemoteControl,
  renderRemoteControlPopover,
} from "./view/chrome";
import {
  renderAttachmentStrip,
  renderComposerControls,
  renderComposerPopover,
  renderUsageIndicator,
} from "./view/composer";
import { renderTaskSettingsPopover } from "./view/entry";
import { renderSidebar, updateSidebarSpinnerLiveness } from "./view/sidebar";
import { renderSettingsOverlay } from "./view/settings";
import {
  reconcileProtectedRenameEditor,
  renderProtectedRenameEditor,
} from "./view/rename-editor";
import {
  renderStatusStrip,
  updateStatusStripStatusInPlace,
} from "./view/status-strip";
import { renderRuns } from "./view/transcript";
import { enhanceTranscriptChips } from "./view/transcript-chips";

interface RenderDeps {
  /** T3 — 160 ms transcript-stream debounce (scheduler side). */
  scheduleTranscriptRender(): void;
  /** T2 — 150 ms session-index debounce (scheduler side). */
  scheduleSessionIndexRefresh(): void;
  /** The report-refresh effect directive's flow (IPC read → markViewChanged). */
  refreshReport(taskId: string): Promise<void>;
}

let state: RendererState;
let deps: RenderDeps;

/** Bound once by main.ts at boot, before the first render (R4). */
export function initRender(boundState: RendererState, boundDeps: RenderDeps): void {
  state = boundState;
  deps = boundDeps;
}

function activeTaskView(): TaskViewState | null {
  return activeTaskViewOf(state);
}

// Dedup key for the terminal-window active-task relay (see
// pushActiveTerminalTask). Module state of this module: initialized at import
// time, so it exists before any render() call (the R4 boot order binds seams
// before the first render; this module loads before main.ts's body runs).
let lastPushedTerminalTask = "";

// Relay the active task (and its live-ness) to the terminal window, deduped so
// render()'s frequent calls don't spam IPC. The terminal window shows this
// task's terminal and forwards keystrokes only while it is live.
// (`lastPushedTerminalTask` is declared with the module state above.)
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

export function render(): void {
  const view = activeTaskView();
  pushActiveTerminalTask();
  // New chat: the centered greeting IS the scene's title — an empty header
  // (2026-07-04 redesign) instead of a third "New chat" label.
  renderHeaderTitle(view);
  renderRenameNotices();
  // The greeting + composer ride as one centered group on the empty surface;
  // the class flips the run column out of scroll layout (styles.css).
  elements.runColumn.classList.toggle("run-column-new-chat", !view);
  const notice = composerNotice(view?.status ?? state.status);
  elements.runtimeStatus.textContent = notice;
  elements.runtimeStatus.classList.toggle("hidden", notice === "");
  elements.openPreviewWindow.disabled = !view?.task || state.busy;
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
  enhanceTranscriptChips();
}

function renderHeaderTitle(view: TaskViewState | null): void {
  const editor = state.sidebar.renameEditor;
  if (
    editor?.kind === "session" &&
    editor.surface === "header" &&
    editor.taskId === view?.task?.id
  ) {
    const editorNode = renderProtectedRenameEditor(editor, { surface: "header" });
    if (elements.taskTitleSlot.firstElementChild !== editorNode) {
      elements.taskTitleSlot.replaceChildren(editorNode);
    }
    return;
  }

  reconcileProtectedRenameEditor(editor);
  if (elements.taskTitleSlot.firstElementChild !== elements.taskTitle) {
    elements.taskTitleSlot.replaceChildren(elements.taskTitle);
  }
  const title = view?.task?.title ?? "";
  if (elements.taskTitle.textContent !== title) {
    elements.taskTitle.textContent = title;
  }
}

function renderRenameNotices(): void {
  const notice = state.sidebar.renameNotice;
  const headerMessage = notice?.surface === "header" ? notice.message : "";
  const sidebarMessage = notice?.surface === "sidebar" ? notice.message : "";
  elements.headerRenameNotice.textContent = headerMessage;
  elements.headerRenameNotice.classList.toggle("hidden", !headerMessage);
  elements.sidebarRenameNotice.textContent = sidebarMessage;
  elements.sidebarRenameNotice.classList.toggle("hidden", !sidebarMessage);
}

// view.status is the point-of-action message channel; its editorial policy
// (action feedback ONLY, all lifecycle narration suppressed — 2026-07-04
// ruling) lives in reading-core as composerNotice, where the smoke pins it.

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
// Boundary note (S0.2 close-out, since retired by S1): renderRuns now
// keyed-reconciles the turn cards — reused nodes are never detached, so a
// text selection survives content batches (fenced by e2e transcript-
// selection). This path's remaining job is exactly the pairing above.
// (Comment corrected 2026-07-04 — it predated S1 and had gone stale.)
export function renderTranscriptStream(): void {
  renderRuns();
  enhanceTranscriptChips();
  renderStatusStrip();
}

export function performDirective(directive: Directive): void {
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
      deps.scheduleTranscriptRender();
      return;
    case "session-index-debounced":
      deps.scheduleSessionIndexRefresh();
      return;
    case "report-refresh":
      void deps.refreshReport(directive.taskId);
      return;
  }
}
