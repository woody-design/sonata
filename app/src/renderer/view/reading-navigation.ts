import { ArrowDown } from "lucide";
import { elements } from "../dom";
import {
  isReadingNearBottom,
  readingHasOverflow,
} from "../../reading-core/reading-scroll";
import { lucideIcon } from "./icons";

let syncFrame: number | null = null;
let resizeObserver: ResizeObserver | null = null;
let contentMutationObserver: MutationObserver | null = null;
const observedContentChildren = new Set<HTMLElement>();

function focusComposerAfterNavigation(): void {
  const target = elements.promptInput.disabled ? elements.composer : elements.promptInput;
  target.focus({ preventScroll: true });
}

export function initReadingNavigation(): void {
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

  elements.scrollToBottom.addEventListener("click", () => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
