import type { AnchorRect } from "./state";

export interface CascadePoint {
  x: number;
  y: number;
}

export type CascadeSide = "left" | "right";

export interface CascadePlacement {
  side: CascadeSide;
  left: number;
  top: number;
  availableHeight: number;
}

export interface PointerGraceRegion {
  polygon: readonly CascadePoint[];
  side: CascadeSide;
  expiresAt: number;
}

export function calculateCascadePlacement(
  anchor: AnchorRect,
  panel: { width: number; height: number },
  viewport: { left: number; top: number; right: number; bottom: number },
  gap = 4,
  padding = 8,
): CascadePlacement {
  const rightLeft = anchor.right + gap;
  const leftLeft = anchor.left - gap - panel.width;
  const rightSpace = viewport.right - padding - rightLeft;
  const leftSpace = anchor.left - gap - (viewport.left + padding);
  const rightFits = panel.width <= rightSpace;
  const leftFits = panel.width <= leftSpace;
  const side: CascadeSide = rightFits || (!leftFits && rightSpace >= leftSpace) ? "right" : "left";
  const preferredLeft = side === "right" ? rightLeft : leftLeft;
  const minLeft = viewport.left + padding;
  const maxLeft = Math.max(minLeft, viewport.right - padding - panel.width);
  const left = clamp(preferredLeft, minLeft, maxLeft);
  const minTop = viewport.top + padding;
  const maxTop = Math.max(minTop, viewport.bottom - padding - Math.min(panel.height, viewport.bottom - viewport.top - padding * 2));
  const top = clamp(anchor.top, minTop, maxTop);
  const availableHeight = Math.max(0, viewport.bottom - padding - top);
  return { side, left, top, availableHeight };
}

export function buildPointerGracePolygon(
  exit: CascadePoint,
  child: AnchorRect,
  side: CascadeSide,
  bleed = 5,
): readonly CascadePoint[] {
  const nearX = side === "right" ? child.left : child.right;
  const farX = side === "right" ? child.right : child.left;
  const originX = exit.x + (side === "right" ? bleed : -bleed);
  return [
    { x: originX, y: exit.y },
    { x: nearX, y: child.top },
    { x: farX, y: child.top },
    { x: farX, y: child.bottom },
    { x: nearX, y: child.bottom },
  ];
}

export function pointInPolygon(point: CascadePoint, polygon: readonly CascadePoint[]): boolean {
  let inside = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
    const a = polygon[current]!;
    const b = polygon[previous]!;
    const crosses =
      (a.y > point.y) !== (b.y > point.y) &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) {
      inside = !inside;
    }
  }
  return inside;
}

export function pointerGraceProtects(
  region: PointerGraceRegion | null,
  previous: CascadePoint | null,
  current: CascadePoint,
  now: number,
): boolean {
  if (!region || !previous || now > region.expiresAt) {
    return false;
  }
  const deltaX = current.x - previous.x;
  const movingTowardChild = region.side === "right" ? deltaX > 0 : deltaX < 0;
  return movingTowardChild && pointInPolygon(current, region.polygon);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
