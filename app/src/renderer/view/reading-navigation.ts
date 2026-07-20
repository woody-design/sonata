import { ArrowDown } from "lucide";
import { elements } from "../dom";
import {
  isReadingNearBottom,
  readingHasOverflow,
  stepReadingBottomIntent,
  type ReadingBottomIntentStore,
} from "../../reading-core/reading-scroll";
import { activeTaskView, type RendererState } from "../../reading-core/state";
import { lucideIcon } from "./icons";

let state: RendererState;
/** The scroll-to-bottom intent, shared with the render finalize (created once at
 *  boot). This surface owns its whole lifecycle: activate on click, re-aim on
 *  growth, clear on arrival / a takeover gesture / a task switch. */
let bottomIntent: ReadingBottomIntentStore;
/** Last active task the surface synced against — a change means the transcript
 *  was replaced under any running animation, so a lingering intent is stale. */
let lastTaskId: string | null = null;
let syncFrame: number | null = null;
let resizeObserver: ResizeObserver | null = null;
let contentMutationObserver: MutationObserver | null = null;
const observedContentChildren = new Set<HTMLElement>();

function focusComposerAfterNavigation(): void {
  const target = elements.promptInput.disabled ? elements.composer : elements.promptInput;
  target.focus({ preventScroll: true });
}

export function initReadingNavigation(
  stateRef: RendererState,
  deps: { bottomIntent: ReadingBottomIntentStore },
): void {
  state = stateRef;
  bottomIntent = deps.bottomIntent;
  const runList = elements.runList;
  elements.scrollToBottom.replaceChildren(lucideIcon(ArrowDown, 20));

  const scheduleSync = (): void => {
    if (syncFrame !== null) {
      return;
    }
    syncFrame = requestAnimationFrame(() => {
      syncFrame = null;
      syncReadingNavigation();
    });
  };

  runList.addEventListener("scroll", scheduleSync, { passive: true });
  window.addEventListener("resize", scheduleSync);
  runList.addEventListener("load", scheduleSync, true);
  runList.addEventListener("toggle", scheduleSync, true);

  resizeObserver = new ResizeObserver(scheduleSync);
  // The scroller catches viewport changes. The flex siblings catch every
  // source that can shrink/expand that viewport without touching transcript.
  for (const target of [
    runList,
    elements.composer,
    elements.resumeChoice,
    elements.approvalBanner,
    elements.optionPromptCard,
    elements.attentionBannerRoot,
  ]) {
    resizeObserver.observe(target);
  }

  const syncObservedContentChildren = (): void => {
    const nextChildren = new Set(
      Array.from(runList.children).filter(
        (child): child is HTMLElement => child instanceof HTMLElement,
      ),
    );
    for (const child of observedContentChildren) {
      if (!nextChildren.has(child)) {
        resizeObserver?.unobserve(child);
        observedContentChildren.delete(child);
      }
    }
    for (const child of nextChildren) {
      if (!observedContentChildren.has(child)) {
        resizeObserver?.observe(child);
        observedContentChildren.add(child);
      }
    }
  };

  contentMutationObserver = new MutationObserver((records) => {
    // Nested streaming/status mutations only change an already-observed direct
    // child's size: schedule O(1), never rescan a long transcript. Reconcile
    // can change the direct child set; one batched delta update handles that.
    if (records.some((record) => record.target === runList)) {
      syncObservedContentChildren();
    }
    scheduleSync();
  });
  contentMutationObserver.observe(runList, { childList: true, subtree: true });
  syncObservedContentChildren();
  scheduleSync();

  // A takeover gesture retires the intent: the reader is steering now, so the
  // animation must not fight them or snap them back. Wheel and touch are the
  // reliable cancel signals for a Chromium scroller — the smooth animation
  // itself emits only `scroll` events (never wheel/touch), and after activation
  // focus lives in the Composer, so the scroller never receives scroll keys.
  const cancelBottomIntent = (): void => {
    bottomIntent.clear();
  };
  runList.addEventListener("wheel", cancelBottomIntent, { passive: true });
  runList.addEventListener("touchstart", cancelBottomIntent, { passive: true });

  elements.scrollToBottom.addEventListener("click", () => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Intent guards a smooth animation only; a reduced-motion jump is instant,
    // has no animation to protect, and is already held by tail-follow.
    if (reduceMotion) {
      bottomIntent.clear();
    } else {
      bottomIntent.activate(runList.scrollHeight);
    }
    runList.scrollTo({
      top: runList.scrollHeight,
      behavior: reduceMotion ? "auto" : "smooth",
    });
    focusComposerAfterNavigation();
    scheduleSync();
  });
}

export function syncReadingNavigation(): void {
  const runList = elements.runList;

  // A task/view switch replaces the transcript under any running animation:
  // retire a lingering intent so it cannot chase the new content's bottom.
  const taskId = activeTaskView(state)?.task?.id ?? null;
  if (taskId !== lastTaskId) {
    lastTaskId = taskId;
    bottomIntent.clear();
  }

  // Ride the intent to the live edge. This runs on every scroll tick and render
  // settle, so arrival clears promptly and growth re-aims at the new bottom —
  // but only past the aimed height, so an unchanged target never restarts the
  // scroll (createReadingBottomIntentStore.reaim records each new aim).
  const intent = bottomIntent.current();
  if (intent) {
    const step = stepReadingBottomIntent(runList, intent);
    if (step.kind === "arrived") {
      bottomIntent.clear();
    } else if (step.kind === "reaim") {
      bottomIntent.reaim(step.top);
      runList.scrollTo({ top: step.top, behavior: "smooth" });
    }
  }

  const visible = readingHasOverflow(runList) && !isReadingNearBottom(runList);
  if (!visible && document.activeElement === elements.scrollToBottom) {
    // The control disappears at its destination. Never strand keyboard focus
    // in display:none if content/layout changes hide it before activation.
    focusComposerAfterNavigation();
  }
  elements.scrollToBottom.classList.toggle("hidden", !visible);
  elements.scrollToBottom.setAttribute("aria-hidden", String(!visible));
  elements.scrollToBottom.tabIndex = visible ? 0 : -1;
}
