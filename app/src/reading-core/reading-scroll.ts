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
