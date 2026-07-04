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
  renderStatusStrip,
  updateStatusStripStatusInPlace,
} from "./view/status-strip";
import { renderRuns } from "./view/transcript";

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
