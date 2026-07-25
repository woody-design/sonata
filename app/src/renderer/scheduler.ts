// The scheduling layer (map §1.5, moved verbatim from main.ts at D4b): every
// timer here keeps its exact delay, coalescing, and clear-guard semantics —
// timing code is untouchable (equivalence contract layer 3). This module owns
// T1 (1 s strip clocks), T2 (150 ms session-index debounce), T3 (160 ms
// transcript debounce), and T5/T6 (usage-popover hover open/close), plus
// their timer-id satellites. Fire targets are init-bound deps from the
// composition root (main.ts) — the scheduler is timing glue and imports no
// paint or flow module, so it can never cycle with the layers that call it.
// (T4 lives in view/prompt-nav, T7/T9–T13 render-local in their view
// modules, T8 closure-local in main.ts's resizer wiring, G1/G2 with their
// owners — §1.5's dispositions.)

import { formatLiveElapsed } from "../reading-core/selectors/formatters";
import type { RendererState } from "../reading-core/state";
import { elements } from "./dom";

interface SchedulerDeps {
  /** T3's fire target — the transcript-streaming render path (render.ts). */
  renderTranscriptStream(): void;
  /** T2's fire target — the session-index read flow. */
  refreshSessionIndex(): Promise<void>;
  /** T5's fire target — hover-open is never pinned. */
  openUsagePopover(pinned: boolean): void;
  /** T6's fire target. */
  closeUsagePopover(): void;
}

let state: RendererState;
let deps: SchedulerDeps;

/** Bound once by main.ts at boot, before the first render (R4). */
export function initScheduler(boundState: RendererState, boundDeps: SchedulerDeps): void {
  state = boundState;
  deps = boundDeps;
}

// Ticks the live clocks (status strip + work-trace agent rows) without
// re-rendering the transcript. (T1 — started by main.ts at its original boot
// position.)
export function startStripClockTicker(): void {
  window.setInterval(() => {
    // Idle fast-path (OBS S5 / F9): the strip carries live-clock nodes ONLY
    // while visible — renderStatusStrip adds `hidden` and clears every clock
    // node once the turn is idle (view/status-strip.ts). With zero live runs
    // this DOMTokenList membership check is the whole tick: no querySelectorAll
    // subtree walk, so the permanent 1 s timer costs ~nothing when nothing runs.
    if (elements.statusStrip.classList.contains("hidden")) {
      return;
    }
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
}

let sessionIndexRefreshTimer: number | null = null;

export function scheduleSessionIndexRefresh(): void {
  if (sessionIndexRefreshTimer !== null) {
    return;
  }
  sessionIndexRefreshTimer = window.setTimeout(() => {
    sessionIndexRefreshTimer = null;
    void deps.refreshSessionIndex();
  }, 150);
}

let transcriptRenderTimer: number | null = null;

export function scheduleTranscriptRender(): void {
  if (transcriptRenderTimer !== null) {
    return;
  }
  transcriptRenderTimer = window.setTimeout(() => {
    transcriptRenderTimer = null;
    deps.renderTranscriptStream();
  }, 160);
}

const USAGE_POPOVER_OPEN_DELAY_MS = 150;
const USAGE_POPOVER_CLOSE_DELAY_MS = 180;

let usagePopoverOpenTimer: number | null = null;
let usagePopoverCloseTimer: number | null = null;

export function scheduleUsagePopoverOpen(): void {
  clearUsagePopoverCloseTimer();
  if (usagePopoverOpenTimer !== null) {
    window.clearTimeout(usagePopoverOpenTimer);
  }
  usagePopoverOpenTimer = window.setTimeout(() => {
    usagePopoverOpenTimer = null;
    deps.openUsagePopover(false);
  }, USAGE_POPOVER_OPEN_DELAY_MS);
}

export function scheduleUsagePopoverClose(): void {
  clearUsagePopoverOpenTimer();
  if (state.usagePopover?.pinned) {
    return;
  }
  clearUsagePopoverCloseTimer();
  usagePopoverCloseTimer = window.setTimeout(() => {
    usagePopoverCloseTimer = null;
    deps.closeUsagePopover();
  }, USAGE_POPOVER_CLOSE_DELAY_MS);
}

export function clearUsagePopoverTimers(): void {
  clearUsagePopoverOpenTimer();
  clearUsagePopoverCloseTimer();
}

function clearUsagePopoverOpenTimer(): void {
  if (usagePopoverOpenTimer !== null) {
    window.clearTimeout(usagePopoverOpenTimer);
    usagePopoverOpenTimer = null;
  }
}

export function clearUsagePopoverCloseTimer(): void {
  if (usagePopoverCloseTimer !== null) {
    window.clearTimeout(usagePopoverCloseTimer);
    usagePopoverCloseTimer = null;
  }
}
