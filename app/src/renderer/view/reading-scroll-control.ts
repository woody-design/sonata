// Run-list programmatic scroll writes, in ONE place (S6 A3). Every module that
// moves the reading scroller by code — status-strip's bottom pin, prompt-nav's
// jump-to-turn, the transcript's reply-top anchor (S3 D4) — routes through
// here, so the bottom-intent interaction is a structural invariant rather than
// a grep-enforced convention: a future scroll writer that reaches for
// elements.runList.scrollTop / a turn's scrollIntoView on its own is the one
// thing to look for, and it is wrong by construction.
//
// The two sanctioned scroll writers that do NOT live here are the intent's own
// machinery, not takeovers: the render finalize (view/transcript,
// planReadingFinalizeScroll's restore/tail-follow branches — both DEFER to a
// live ride) and the bottom-ride animation (view/reading-navigation — OWNS the
// ride). Everything else is a reader takeover of the tail and belongs here.

import { elements } from "../dom";
import {
  isReadingNearBottom,
  planReadingBlockAnchor,
  type ReadingBlockAnchor,
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

/** Align a run-list block's TOP EDGE with the reading line near the top of the
 *  viewport (S3 D4 — a new answer segment arrived and the reader is attending).
 *  The sibling of scrollReadingTurnIntoView, one level finer: prompt-nav jumps
 *  to a whole TURN, this jumps to one segment inside a turn's reply, because a
 *  long prompt must never push the reply it belongs to out of sight.
 *
 *  The DOM's whole part is here — measure the segment where it currently sits,
 *  then write what reading-core decided. The measurement is taken live and by
 *  selector at the call site, never from a held node: a streaming turn card is
 *  destroyed and rebuilt every ~160 ms, so any node reference older than this
 *  frame is a detached husk.
 *
 *  Clearing the intent first is the same takeover contract this module's other
 *  jump keeps. In practice there is nothing to clear — planReadingFinalizeScroll
 *  never asks for an anchor while a ride is live — but the primitive must be
 *  safe on its own terms, not only under its current caller. */
export function scrollReadingBlockToTop(target: HTMLElement): ReadingBlockAnchor {
  const runList = elements.runList;
  const blockTop =
    target.getBoundingClientRect().top - runList.getBoundingClientRect().top + runList.scrollTop;
  const anchor = planReadingBlockAnchor({
    blockTop,
    scrollHeight: runList.scrollHeight,
    clientHeight: runList.clientHeight,
  });
  bottomIntent.clear();
  runList.scrollTop = anchor.top;
  return anchor;
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
