import { ArrowDown } from "lucide";
import { elements } from "../dom";
import {
  isReadingNearBottom,
  readingBottomIntentTakenOver,
  readingHasOverflow,
  stepReadingBottomIntent,
  type ReadingBottomIntentStore,
} from "../../reading-core/reading-scroll";
import { lucideIcon } from "./icons";

/** The scroll-to-bottom intent, shared with the render finalize (created once at
 *  boot). This surface activates it on click and drives its live phase —
 *  re-aim on growth, clear on arrival or reader takeover; the task-switch clear
 *  lives in the transcript render, ahead of finalize (D-F2). */
let bottomIntent: ReadingBottomIntentStore;
let syncFrame: number | null = null;
let resizeObserver: ResizeObserver | null = null;
let contentMutationObserver: MutationObserver | null = null;
const observedContentChildren = new Set<HTMLElement>();

function focusComposerAfterNavigation(): void {
  const target = elements.promptInput.disabled ? elements.composer : elements.promptInput;
  target.focus({ preventScroll: true });
}

export function initReadingNavigation(deps: { bottomIntent: ReadingBottomIntentStore }): void {
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

  // A takeover gesture retires the intent immediately: the reader is steering
  // now, so the animation must not fight them or snap them back. Wheel and touch
  // fire on their own events (the smooth animation itself emits only `scroll`);
  // programmatic and drag scrolls that emit neither are caught by the
  // displacement check in syncReadingNavigation.
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
      bottomIntent.activate(runList.scrollHeight, runList.scrollTop);
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

  // Drive the intent's live phase. This runs on every scroll tick and render
  // settle. A retreat from the ride's furthest point is the reader taking over
  // via a scroll that emits no wheel/touch event (keyboard prompt-nav's
  // scrollIntoView, a scrollbar drag) — clear before it can re-aim and yank
  // them back. Otherwise extend the ride, then arrival clears and growth
  // re-aims at the new bottom (only past the aimed height, so an unchanged
  // target never restarts the scroll).
  const intent = bottomIntent.current();
  if (intent) {
    if (readingBottomIntentTakenOver(runList.scrollTop, intent)) {
      bottomIntent.clear();
    } else {
      bottomIntent.advance(runList.scrollTop);
      const step = stepReadingBottomIntent(runList, intent);
      if (step.kind === "arrived") {
        bottomIntent.clear();
      } else if (step.kind === "reaim") {
        bottomIntent.reaim(step.top);
        runList.scrollTo({ top: step.top, behavior: "smooth" });
      }
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
