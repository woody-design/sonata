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

// ——— The finalize decision ————————————————————————————————————————————————

export type ReadingFinalizeScroll =
  /** Leave scrollTop alone. */
  | { readonly kind: "none" }
  /** Write this absolute scrollTop. */
  | { readonly kind: "top"; readonly top: number };

/** What a render's finalize should do to the run list's scroll position — ONE
 *  decision point, so the precedence between its claimants is stated once and
 *  fenced once:
 *
 *  1. A TASK SWITCH owns the position outright. The incoming session's
 *     remembered place is the whole point of the render, and the outgoing DOM's
 *     nearBottom/previousScrollTop (which this branch replaces) described a
 *     transcript that no longer exists.
 *  2. A LIVE RIDE owns scrollTop until it arrives or the reader takes over —
 *     any write here would abort the smooth animation (CSSOM).
 *  3. Otherwise the tail-follow rule stands (resolveReadingFinalizeScrollTop). */
export function planReadingFinalizeScroll(input: {
  readonly taskSwitch: boolean;
  readonly switchSnapshot: ReadingScrollSnapshot | null;
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
  const top = resolveReadingFinalizeScrollTop(input);
  return top === null ? { kind: "none" } : { kind: "top", top };
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
