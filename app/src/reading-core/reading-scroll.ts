/** Pure scroll metrics used by Reading's tail-follow and navigation surfaces. */
export interface ReadingScrollMetrics {
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly clientHeight: number;
}

export const READING_BOTTOM_THRESHOLD_PX = 64;
export const READING_OVERFLOW_TOLERANCE_PX = 1;

/** scrollTop can be fractional while the height metrics are rounded. Preserve
 *  that precision and clamp overscroll/rubber-banding to a zero distance. */
export function readingDistanceFromBottom(element: ReadingScrollMetrics): number {
  return Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight);
}

export function isReadingNearBottom(
  element: ReadingScrollMetrics,
  threshold = READING_BOTTOM_THRESHOLD_PX,
): boolean {
  return readingDistanceFromBottom(element) <= Math.max(0, threshold);
}

export function readingHasOverflow(
  element: ReadingScrollMetrics,
  tolerance = READING_OVERFLOW_TOLERANCE_PX,
): boolean {
  // A one-pixel tolerance avoids rounded layout dimensions creating a control
  // that cannot move the viewport in practice.
  return element.scrollHeight - element.clientHeight > Math.max(0, tolerance);
}

// ——— Bottom intent ————————————————————————————————————————————————————————
// The reader activated scroll-to-bottom, asking to ride the smooth animation to
// the live edge. The intent guards that animation against its two killers: a
// render's finalize writing scrollTop (any programmatic scroll write aborts an
// in-flight smooth scroll — CSSOM), and content growth leaving the animation
// aimed short of the new bottom. `aimedHeight` is the scrollHeight the current
// animation targets; growth re-aims ONLY past it, so a ~160 ms render cadence
// never restarts the scroll on an unchanged target. `ridePeak` is the furthest
// scrollTop the ride has reached — the ride only ever advances toward the
// bottom, so a retreat past it (see readingBottomIntentTakenOver) means the
// reader steered. Intent is a smooth-scroll concept only — a reduced-motion
// (instant) jump has no animation to protect, and tail-follow already keeps an
// instant jump pinned.

export interface ReadingBottomIntent {
  readonly aimedHeight: number;
  readonly ridePeak: number;
}

/** The single live intent, created once at boot and shared by the render
 *  finalize (read) and the navigation surface (activate / advance / re-aim /
 *  clear). Kept in reading-core so both sibling view families reach it through
 *  the composition root rather than importing each other (the view-fence rule). */
export interface ReadingBottomIntentStore {
  activate(aimedHeight: number, scrollTop: number): void;
  advance(scrollTop: number): void;
  reaim(aimedHeight: number): void;
  clear(): void;
  current(): ReadingBottomIntent | null;
}

export function createReadingBottomIntentStore(): ReadingBottomIntentStore {
  let intent: ReadingBottomIntent | null = null;
  return {
    activate(aimedHeight, scrollTop) {
      intent = { aimedHeight, ridePeak: scrollTop };
    },
    advance(scrollTop) {
      // Extend the ride's furthest point so a later retreat reads as takeover.
      if (intent && scrollTop > intent.ridePeak) {
        intent = { ...intent, ridePeak: scrollTop };
      }
    },
    reaim(aimedHeight) {
      // Re-aim only refreshes a live intent's target; a stale call after a
      // clear must not resurrect the animation. The ride peak is preserved.
      if (intent) {
        intent = { ...intent, aimedHeight };
      }
    },
    clear() {
      intent = null;
    },
    current() {
      return intent;
    },
  };
}

/** The reader has taken over when the view retreats from the ride's furthest
 *  point by more than a margin. The smooth ride only ever advances toward the
 *  bottom (and streaming growth appends there, never retreating scrollTop), so
 *  a real retreat is always an external scroll — keyboard prompt-nav's
 *  scrollIntoView, a scrollbar-thumb drag, a wheel not otherwise caught. This
 *  is the direction-agnostic complement to the wheel/touch gesture clears:
 *  those fire on their own events; this catches the programmatic and drag
 *  scrolls that emit none. The margin absorbs sub-pixel jitter without swallowing
 *  a genuine jump (prompt-nav aligns a whole card to the top; a deliberate drag
 *  moves comparably). */
export function readingBottomIntentTakenOver(
  scrollTop: number,
  intent: ReadingBottomIntent,
  margin = READING_BOTTOM_THRESHOLD_PX,
): boolean {
  return scrollTop < intent.ridePeak - Math.max(0, margin);
}

/** The scrollTop a render's finalize should write, or null to leave scrollTop
 *  untouched. A live bottom intent suppresses the write entirely (the animation
 *  owns scrollTop until it arrives or the reader takes over); otherwise the
 *  tail-follow rule stands — pin to the bottom when near it, else hold the prior
 *  position — but a same-value write is skipped because it, too, aborts a smooth
 *  scroll. */
export function resolveReadingFinalizeScrollTop(input: {
  readonly nearBottom: boolean;
  readonly previousScrollTop: number;
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly hasBottomIntent: boolean;
}): number | null {
  if (input.hasBottomIntent) {
    return null;
  }
  const target = input.nearBottom ? input.scrollHeight : input.previousScrollTop;
  return target === input.scrollTop ? null : target;
}

// ——— Per-session scroll memory (S3 D3) ——————————————————————————————————————
// Switching sessions replaces the whole transcript, so the outgoing DOM's
// scroll position is gone the moment the reconcile runs. Reading — as opposed
// to monitoring — means a session you return to opens where you left it. The
// snapshot is taken at the switch-away moment (before teardown) and consumed on
// the way back in.
//
// RENDERER-RUN LIFETIME ONLY, never persisted to disk: a reading position is a
// property of one sitting with the app, not of the session. This is a design
// ruling, not an omission.
//
// It deliberately does NOT live on TaskViewState: `evictDormantTaskView`
// (transitions/session.ts) drops the view of a plain dormant session the moment
// you switch away from it — exactly the session whose position we just promised
// to remember — so a snapshot stored there would be destroyed by the very act
// that created it.

export interface ReadingScrollSnapshot {
  readonly scrollTop: number;
  readonly nearBottom: boolean;
}

/** The reading positions of the sessions visited this run, keyed by task id.
 *  Created once at boot and shared by the switch flow (which remembers) and the
 *  render finalize (which restores) — the two never import each other, so the
 *  composition root hands both the same instance, exactly as it does for the
 *  bottom intent. */
export interface ReadingScrollMemoryStore {
  remember(taskId: string, snapshot: ReadingScrollSnapshot): void;
  /** One-shot: a snapshot answers exactly one return. A switch-in with nothing
   *  remembered opens at the bottom, which is also the honest answer when a
   *  switch-away path failed to record one — better than restoring a position
   *  from an older visit. */
  take(taskId: string | null): ReadingScrollSnapshot | null;
  /** The session is gone (closed / archived / deleted): so is its position. */
  forget(taskId: string): void;
}

export function createReadingScrollMemoryStore(): ReadingScrollMemoryStore {
  const snapshots = new Map<string, ReadingScrollSnapshot>();
  return {
    remember(taskId, snapshot) {
      snapshots.set(taskId, snapshot);
    },
    take(taskId) {
      if (taskId === null) {
        return null;
      }
      const snapshot = snapshots.get(taskId) ?? null;
      snapshots.delete(taskId);
      return snapshot;
    },
    forget(taskId) {
      snapshots.delete(taskId);
    },
  };
}

/** Where a task switch should leave the incoming transcript. `nearBottom` wins
 *  over the raw offset: a reader who left a session at its live edge wants the
 *  NEW live edge, not the pixel where the old one used to be. A raw offset is
 *  clamped into the incoming content's range (the transcript can be shorter
 *  than it was — a re-hydrated dormant view, a compaction), while the bottom
 *  case returns scrollHeight, the codebase's pin-to-bottom idiom (the DOM
 *  clamps it). No snapshot ⇒ the bottom: a session opened for the first time
 *  this run opens at its newest reply. */
export function planTaskSwitchScroll(
  snapshot: ReadingScrollSnapshot | null,
  metrics: { readonly scrollHeight: number; readonly clientHeight: number },
): number {
  if (snapshot === null || snapshot.nearBottom) {
    return metrics.scrollHeight;
  }
  const maxScrollTop = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  return Math.min(Math.max(0, snapshot.scrollTop), maxScrollTop);
}

// ——— Reply-top anchoring (S3 D4) ——————————————————————————————————————————
// The monitoring model pins the view to the live edge and lets the reader chase
// a moving tail. The reading model puts each new answer segment's TOP edge at
// the top of the viewport and then holds still, so the reader reads from the
// beginning of what arrived, at their own pace.
//
// HOW SEGMENTS ARRIVE, measured — this is the fact the whole design rests on
// (S3 review 1). An assistant answer segment is minted WHOLE: one complete
// `assistant-text` block per provider record (codex-normalizer.ts:306-327,
// claude-normalizer.ts:305-321), and no producer ever re-emits an id with more
// text. MEASURED over the pinned real-session corpus (tests/fixtures/
// runtime-events, 26 recorded scenarios / 5450 events / 87 `transcript:blocks`
// events): 38 distinct assistant-text ids, and 0 of them were emitted more than
// once. There is no delta path in either normalizer.
//
// Two consequences, and they are what keep this simple:
//   · an anchor is applied ONCE, on the render where its segment appears, and
//     is never carried forward. A segment tall enough to fill the viewport
//     lands at the reading line on that single application; a shorter one is
//     clamped to the bottom — where it is entirely visible anyway, because it
//     is short and it is all there. Nothing about it will grow, so there is
//     nothing to converge toward.
//   · therefore an anchor may never move the view in response to content that
//     is NOT its own segment. A carried-forward anchor would eventually be
//     "satisfied" by the next turn's prompt bubble arriving below it and drag
//     the reader BACKWARDS to the top of the previous reply.

/** How far below the scroller's top edge an anchored segment's first line
 *  lands. Two fixed obstructions sit at the very top of the run list and would
 *  otherwise swallow that line: the 24px scroll-edge mask fade (`.run-list`),
 *  and the sticky prompt pill (`.sticky-prompt-header`, min-height 34px,
 *  border-box) — which appears precisely in the state an anchor creates, since
 *  the anchored reply's own prompt has just been scrolled off the top. The
 *  inset clears the pill with a small breath, so the pill reads as a header
 *  ABOVE the reply rather than a lid over it. */
export const READING_ANCHOR_TOP_INSET_PX = 40;

/** How far the view may sit from where a landed anchor put it and still count
 *  as "the reader has not moved". Sub-pixel: scrollTop is fractional while the
 *  height metrics are rounded, and scroll anchoring can adjust by a hair. Any
 *  deliberate scroll is an order of magnitude larger (one wheel notch ≈
 *  40–120px), so this stays strict — a reader who nudged the view up to re-read
 *  a line has moved, and must not be pulled back. */
export const READING_ANCHOR_HOLD_TOLERANCE_PX = 4;

/** Is the view still exactly where a LANDED anchor put it? `holdTop` is that
 *  position, or null when no anchor owns the view (none has landed, or another
 *  scroll has since taken it). The hold is a POSITION, never a flag, so it can
 *  never go stale: the moment the reader scrolls, or a ride moves the view, the
 *  comparison stops matching and the hold is inert without anyone clearing it.
 *
 *  This is ONE predicate with three callers, which is what keeps the surface's
 *  scroll rules a single rule: the render finalize (a held view is not
 *  tail-followed), the height-changing status-strip mutation (a held view is not
 *  bottom-pinned), and the attending test below. */
export function readingViewIsHeld(input: {
  readonly scrollTop: number;
  readonly holdTop: number | null;
  readonly tolerance?: number;
}): boolean {
  if (input.holdTop === null) {
    return false;
  }
  const tolerance = Math.max(0, input.tolerance ?? READING_ANCHOR_HOLD_TOLERANCE_PX);
  return Math.abs(input.scrollTop - input.holdTop) <= tolerance;
}

/** Is the reader still attending to the live edge of the conversation?
 *  Position IS the evidence — no wheel listeners, no scrolled-away flags:
 *  either the view sits where a landed anchor left it, or it is near the bottom
 *  (which covers the state before any anchor has fired, an explicit
 *  scroll-to-bottom ride's destination, and a clamped anchor, which leaves the
 *  view exactly where tail-follow would have). Anything else means the reader is
 *  reading somewhere of their own choosing, and nothing may move their view. */
export function readingReaderIsAttending(input: {
  readonly scrollTop: number;
  readonly nearBottom: boolean;
  readonly holdTop: number | null;
  readonly tolerance?: number;
}): boolean {
  return input.nearBottom || readingViewIsHeld(input);
}

export interface ReadingAnchorTargetPlan {
  /** The segment to anchor, or null when nothing new was appended. */
  readonly anchorKey: string | null;
  /** The seen set to carry into the next render — always exactly the segments
   *  present now, so it stays bounded and a removed segment cannot linger. */
  readonly seen: ReadonlySet<string>;
}

/** Which answer segment (if any) a render should anchor, given the segments
 *  present in document order and the ones the previous render saw.
 *
 * Anchor the segment that follows the last SEEN one; with nothing seen yet,
 * that is simply the first segment there is; and when segments WERE seen but
 * none of them survives, the transcript was replaced rather than appended — so
 * re-seed and anchor nothing. Those three clauses cover every case the surface
 * produces:
 *   · the first reply into an empty session — seen is empty, so its one segment
 *     anchors, which is right: it is new content arriving in front of a reader;
 *   · the ordinary append — the segment after the last seen one anchors, and
 *     each further segment of a multi-segment turn anchors on its own render;
 *   · several segments in one batch — the FIRST new one, because that is the
 *     boundary between what the reader has read and what they have not; the
 *     rest are marked seen behind it rather than anchoring in a cascade;
 *   · a wholesale replacement (a re-located provider source replays the history
 *     under fresh ids) — nothing seen survives, so it re-seeds instead of
 *     throwing the reader at the top of their own history. (A `reset` upsert
 *     that replays the SAME source keeps its ids, which are deterministic, so
 *     it does not even reach this clause.)
 *
 * Entering a session is NOT one of these cases and never reaches here: the
 * caller seeds the seen set from the incoming transcript on a task switch, so
 * the render that shows you a session cannot also move you inside it.
 *
 * KNOWN NARROW EDGE (review 1, accepted): the empty-seen clause has a second
 * reading — if a wholesale replacement ever landed as TWO renders, one emptying
 * the transcript and one refilling it, the refill would look like a first reply
 * and anchor the session's oldest segment. No such two-step path exists today
 * (hydrateTranscript clears and repopulates within one synchronous call, with no
 * render between), which is why this is a comment and not a guard. */
export function planReadingAnchorTarget(
  blockKeys: readonly string[],
  seen: ReadonlySet<string>,
): ReadingAnchorTargetPlan {
  const nextSeen = new Set(blockKeys);
  if (seen.size === 0) {
    return { anchorKey: blockKeys[0] ?? null, seen: nextSeen };
  }
  let lastSeenIndex = -1;
  for (let index = blockKeys.length - 1; index >= 0; index -= 1) {
    if (seen.has(blockKeys[index]!)) {
      lastSeenIndex = index;
      break;
    }
  }
  if (lastSeenIndex === -1) {
    return { anchorKey: null, seen: nextSeen };
  }
  return { anchorKey: blockKeys[lastSeenIndex + 1] ?? null, seen: nextSeen };
}

export interface ReadingBlockAnchor {
  readonly top: number;
  /** True when the segment's top edge actually reached the reading line; false
   *  when the scroller ran out of range first and the write was clamped to the
   *  bottom.
   *
   *  This decides whether the resulting position is a READING POSITION worth
   *  protecting from the near-bottom pins (see readingViewIsHeld) — it is NOT a
   *  lifetime: a clamped anchor is not retried later, because the segment that
   *  wanted the room is whole and will never grow into it. A clamped anchor
   *  leaves the view exactly where tail-follow would have put it, on a segment
   *  short enough to be wholly visible there, so there is nothing to protect and
   *  following the live edge remains the right behavior. */
  readonly satisfied: boolean;
}

/** The scrollTop that puts a segment's top edge at the viewport's reading line.
 *  `blockTop` is the segment's offset in the scroller's content coordinates. */
export function planReadingBlockAnchor(input: {
  readonly blockTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly inset?: number;
}): ReadingBlockAnchor {
  const inset = Math.max(0, input.inset ?? READING_ANCHOR_TOP_INSET_PX);
  const maxScrollTop = Math.max(0, input.scrollHeight - input.clientHeight);
  const desired = input.blockTop - inset;
  return {
    top: Math.min(Math.max(0, desired), maxScrollTop),
    satisfied: desired <= maxScrollTop,
  };
}

// ——— The finalize decision ————————————————————————————————————————————————

export type ReadingFinalizeScroll =
  /** Leave scrollTop alone. */
  | { readonly kind: "none" }
  /** Write this absolute scrollTop. */
  | { readonly kind: "top"; readonly top: number }
  /** Measure this segment and align its top edge (planReadingBlockAnchor). */
  | { readonly kind: "anchor"; readonly blockKey: string };

/** What a render's finalize should do to the run list's scroll position — ONE
 *  decision point, so the precedence between the claimants is stated once and
 *  fenced once:
 *
 *  1. A TASK SWITCH owns the position outright. The incoming session's
 *     remembered place is the whole point of the render, and the outgoing DOM's
 *     nearBottom/previousScrollTop (which this branch replaces) described a
 *     transcript that no longer exists.
 *  2. An EXPLICIT RIDE beats an automatic anchor. The reader pressed
 *     scroll-to-bottom; an anchor firing mid-ride would abort their animation
 *     (any programmatic write does) and take them somewhere they did not ask to
 *     go. The ride arrives, and being at the bottom is itself attending — so
 *     the NEXT segment anchors, no bookkeeping required.
 *  3. A SEGMENT THAT APPEARED IN THIS RENDER, while the reader is attending.
 *     This render or never: a segment is whole when it arrives, so an anchor
 *     carried into a later render could only ever be "satisfied" by somebody
 *     else's content and would drag the reader backwards into old replies.
 *  4. A HELD VIEW is left alone — even near the bottom. This is where the
 *     surface stops being a monitor: once a segment's top edge is at the
 *     reading line, that position belongs to the reader, and the growth below
 *     it is not something to chase. NOTE this branch is load-bearing for a
 *     narrow band that looks harmless and is not: satisfaction only requires
 *     `desired <= maxScrollTop`, so a landed anchor can leave the view 0..64px
 *     from the bottom — inside `nearBottom`. Without this clause the very next
 *     render tail-follows it to the bottom and the anchored segment's first
 *     lines slide up under the mask fade and the sticky pill. (The sibling half
 *     of the same hazard, the status strip's own pin, is settled by
 *     planReadingMutationScroll with the same predicate.)
 *  5. Otherwise the tail-follow rule stands (resolveReadingFinalizeScrollTop).
 *
 *  Clauses 3 and 4 both ask about the reader's position BEFORE this render
 *  touched anything (`previousScrollTop`) — the question in both is what the
 *  reader was doing, not where the reconcile happened to leave the scroller. */
export function planReadingFinalizeScroll(input: {
  readonly taskSwitch: boolean;
  readonly switchSnapshot: ReadingScrollSnapshot | null;
  /** A segment that appeared in THIS render (planReadingAnchorTarget), or null. */
  readonly anchorKey: string | null;
  /** Where a landed anchor left the view, or null if none owns it. */
  readonly holdTop: number | null;
  readonly hasBottomIntent: boolean;
  readonly nearBottom: boolean;
  readonly previousScrollTop: number;
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}): ReadingFinalizeScroll {
  if (input.taskSwitch) {
    const top = planTaskSwitchScroll(input.switchSnapshot, input);
    return top === input.scrollTop ? { kind: "none" } : { kind: "top", top };
  }
  if (input.hasBottomIntent) {
    return { kind: "none" };
  }
  const reader = {
    scrollTop: input.previousScrollTop,
    nearBottom: input.nearBottom,
    holdTop: input.holdTop,
  };
  if (input.anchorKey !== null && readingReaderIsAttending(reader)) {
    return { kind: "anchor", blockKey: input.anchorKey };
  }
  if (readingViewIsHeld(reader)) {
    return { kind: "none" };
  }
  const top = resolveReadingFinalizeScrollTop(input);
  return top === null ? { kind: "none" } : { kind: "top", top };
}

/** The same precedence, asked by the OTHER writer on this scroller: a mutation
 *  that changes the run list's height without being a render — the status
 *  strip, which is the list's last child and re-lays out at ~3Hz during a turn.
 *
 *  It was a fifth claimant sitting outside the rule above ("pin to the bottom if
 *  near it", unconditionally), which is exactly how a landed anchor in the
 *  0..64px band got dragged to the bottom between two renders. It now asks the
 *  same question with the same predicate: a held reading position outranks the
 *  live-edge pin; otherwise the live edge stays in sight as before; otherwise a
 *  reader scrolled away is left alone. */
export type ReadingMutationScroll =
  | { readonly kind: "none" }
  | { readonly kind: "hold"; readonly top: number }
  | { readonly kind: "bottom" };

export function planReadingMutationScroll(input: {
  readonly scrollTop: number;
  readonly holdTop: number | null;
  readonly nearBottom: boolean;
}): ReadingMutationScroll {
  if (readingViewIsHeld(input)) {
    return { kind: "hold", top: input.holdTop! };
  }
  return input.nearBottom ? { kind: "bottom" } : { kind: "none" };
}

/** What the bottom-intent animation should do after a layout/scroll settle:
 *  arrival ends it (near bottom → clear), fresh growth re-aims it at the new
 *  bottom, everything else holds so the animation keeps running untouched. */
export type ReadingBottomIntentStep =
  | { readonly kind: "hold" }
  | { readonly kind: "reaim"; readonly top: number }
  | { readonly kind: "arrived" };

export function stepReadingBottomIntent(
  metrics: ReadingScrollMetrics,
  intent: ReadingBottomIntent,
  threshold = READING_BOTTOM_THRESHOLD_PX,
): ReadingBottomIntentStep {
  // Arrival wins over growth: once inside the threshold the reader is at the
  // live edge, and tail-follow takes over from here.
  if (isReadingNearBottom(metrics, threshold)) {
    return { kind: "arrived" };
  }
  if (metrics.scrollHeight > intent.aimedHeight) {
    return { kind: "reaim", top: metrics.scrollHeight };
  }
  return { kind: "hold" };
}
