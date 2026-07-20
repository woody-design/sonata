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
// never restarts the scroll on an unchanged target. Intent is a smooth-scroll
// concept only — a reduced-motion (instant) jump has no animation to protect,
// and tail-follow already keeps an instant jump pinned.

export interface ReadingBottomIntent {
  readonly aimedHeight: number;
}

/** The single live intent, created once at boot and shared by the render
 *  finalize (read) and the navigation surface (activate / re-aim / clear).
 *  Kept in reading-core so both sibling view families reach it through the
 *  composition root rather than importing each other (the view-fence rule). */
export interface ReadingBottomIntentStore {
  activate(aimedHeight: number): void;
  reaim(aimedHeight: number): void;
  clear(): void;
  current(): ReadingBottomIntent | null;
}

export function createReadingBottomIntentStore(): ReadingBottomIntentStore {
  let intent: ReadingBottomIntent | null = null;
  return {
    activate(aimedHeight) {
      intent = { aimedHeight };
    },
    reaim(aimedHeight) {
      // Re-aim only refreshes a live intent; a stale call after a clear must
      // not resurrect the animation.
      if (intent) {
        intent = { aimedHeight };
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
