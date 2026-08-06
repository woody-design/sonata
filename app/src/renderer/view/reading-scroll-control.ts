// Run-list programmatic scroll writes, in ONE place (S6 A3). Every module that
// moves the reading scroller by code — the status strip's mutation, prompt-nav's
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
  planReadingMutationScroll,
  type ReadingBlockAnchor,
  type ReadingBottomIntentStore,
} from "../../reading-core/reading-scroll";

let bottomIntent: ReadingBottomIntentStore;

/** Bound once by main.ts at boot with the shared bottom-intent instance. */
export function initReadingScrollControl(deps: { bottomIntent: ReadingBottomIntentStore }): void {
  bottomIntent = deps.bottomIntent;
}

// ——— The reading hold ——————————————————————————————————————————————————————
// Where a LANDED reply anchor left the view (S3 D4). This module owns it
// because this module owns the run list's scroll writes: the fact and the
// writes that invalidate it cannot drift apart if they live together.
//
// It is a POSITION, never a flag. Every consumer compares it against the live
// scrollTop (readingViewIsHeld), so a hold nobody cleared — the reader wheeled
// away, a smooth ride carried them off, a resize moved everything — simply
// stops matching and stops applying. The explicit releases below are for the
// writes that would otherwise land ON the held position and lie about it.
let holdTop: number | null = null;

/** The position a landed anchor owns, for the two planners that must respect
 *  it (render finalize, height-changing mutation). */
export function readingScrollHoldTop(): number | null {
  return holdTop;
}

/** Another writer is taking the view: whatever was held is not the reader's
 *  reading position any more. */
export function releaseReadingScrollHold(): void {
  holdTop = null;
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
  releaseReadingScrollHold();
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
 *  safe on its own terms, not only under its current caller.
 *
 *  A LANDED anchor becomes the reading hold; a clamped one releases it. The
 *  distinction is the whole difference between "the reader is parked on a reply"
 *  and "the reader is at the live edge with a short reply in view", and only the
 *  first is a position worth defending from the live-edge pins. */
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
  holdTop = anchor.satisfied ? anchor.top : null;
  return anchor;
}

/** Run `mutate` (which changes the run-list content/height — the status strip
 *  re-laying out at ~3Hz), then put the view back where the reader's own
 *  relationship to the content says it belongs: a held reading position wins,
 *  else a bottom-pinned view stays pinned to the live edge (the
 *  typing-indicator contract), else a reader scrolled up is left exactly where
 *  they are. The relationship is read BEFORE mutating and the decision is the
 *  surface's one precedence rule (planReadingMutationScroll), not a local one —
 *  this used to pin to the bottom unconditionally, which silently overrode a
 *  landed anchor whenever it happened to land within 64px of the bottom.
 *
 *  (A live smooth ride is heading to the bottom already; a near-bottom re-pin
 *  here only lands it instantly, which syncReadingNavigation then reads as
 *  arrival. A ride also never matches the hold, since it has moved the view.) */
export function withReadingScrollPreserved(mutate: () => void): void {
  const runList = elements.runList;
  const plan = planReadingMutationScroll({
    scrollTop: runList.scrollTop,
    holdTop,
    nearBottom: isReadingNearBottom(runList),
  });
  mutate();
  if (plan.kind === "bottom") {
    runList.scrollTop = runList.scrollHeight;
    return;
  }
  // Restore only if the mutation actually moved the view (a shrinking strip can
  // clamp scrollTop down). A same-value write would abort a smooth scroll.
  if (plan.kind === "hold" && runList.scrollTop !== plan.top) {
    runList.scrollTop = plan.top;
  }
}
