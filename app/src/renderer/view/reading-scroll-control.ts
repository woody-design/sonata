// Run-list programmatic scroll writes, in ONE place (S6 A3). Every module that
// moves the reading scroller by code — status-strip's bottom pin, prompt-nav's
// jump-to-turn — routes through here, so the bottom-intent interaction is a
// structural invariant rather than a grep-enforced convention: a future scroll
// writer that reaches for elements.runList.scrollTop / a turn's scrollIntoView
// on its own is the one thing to look for, and it is wrong by construction.
//
// The two sanctioned scroll writers that do NOT live here are the intent's own
// machinery, not takeovers: the render finalize (view/transcript,
// resolveReadingFinalizeScrollTop — DEFERS to a live ride) and the bottom-ride
// animation (view/reading-navigation — OWNS the ride). Everything else is a
// reader takeover of the tail and belongs to this module.

import { elements } from "../dom";
import {
  isReadingNearBottom,
  type ReadingBottomIntentStore,
} from "../../reading-core/reading-scroll";

let bottomIntent: ReadingBottomIntentStore;

/** Bound once by main.ts at boot with the shared bottom-intent instance. */
export function initReadingScrollControl(deps: { bottomIntent: ReadingBottomIntentStore }): void {
  bottomIntent = deps.bottomIntent;
}

/** Jump a run-list turn into view programmatically (prompt-nav entry/move,
 *  sticky-header click). This is a reader takeover of the tail: a programmatic
 *  scroll aborts an in-flight smooth bottom ride (CSSOM) but emits no
 *  wheel/touch event, so syncReadingNavigation would re-aim the now-dead ride at
 *  the new bottom and yank the reader back (A1/A2). Clear the intent first, then
 *  scroll. */
export function scrollReadingTurnIntoView(
  target: HTMLElement,
  options: ScrollIntoViewOptions,
): void {
  bottomIntent.clear();
  target.scrollIntoView(options);
}

/** Run `mutate` (which changes the run-list content/height), keeping a
 *  bottom-pinned view pinned to the live edge afterwards — the typing-indicator
 *  contract: the live edge stays in sight. Reads the pin BEFORE mutating,
 *  restores it after; a reader scrolled up is left exactly where they are. (A
 *  live smooth ride is heading to the bottom already; a near-bottom re-pin here
 *  only lands it instantly, which syncReadingNavigation then reads as arrival.) */
export function withReadingBottomPin(mutate: () => void): void {
  const runList = elements.runList;
  const nearBottom = isReadingNearBottom(runList);
  mutate();
  if (nearBottom) {
    runList.scrollTop = runList.scrollHeight;
  }
}
