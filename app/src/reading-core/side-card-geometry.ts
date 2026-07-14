import type { AnchorRect } from "./state";

export interface SideCardSize {
  width: number;
  height: number;
}

export interface SideCardViewport {
  width: number;
  height: number;
}

export interface SideCardGeometry {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  placement: "right" | "left" | "clamped";
}

/**
 * Viewport-safe side-card placement. Dimensions are static measurements;
 * this module never reads DOM state, so every flip/clamp edge is deterministic.
 */
export function calculateSideCardGeometry(
  anchor: AnchorRect,
  card: SideCardSize,
  viewport: SideCardViewport,
  gap = 8,
  margin = 8,
): SideCardGeometry {
  assertFiniteRect(anchor);
  assertNonNegativeSize(card, "card");
  assertNonNegativeSize(viewport, "viewport");
  assertNonNegative(gap, "gap");
  assertNonNegative(margin, "margin");

  const width = Math.min(card.width, Math.max(0, viewport.width - margin * 2));
  const maximumLeft = Math.max(margin, viewport.width - margin - width);
  const preferredRight = anchor.right + gap;
  const preferredLeft = anchor.left - gap - width;

  let left: number;
  let placement: SideCardGeometry["placement"];
  if (preferredRight >= margin && preferredRight + width <= viewport.width - margin) {
    left = preferredRight;
    placement = "right";
  } else if (preferredLeft >= margin && preferredLeft + width <= viewport.width - margin) {
    left = preferredLeft;
    placement = "left";
  } else {
    left = clamp(preferredRight, margin, maximumLeft);
    placement = "clamped";
  }

  const maxHeight = Math.max(0, viewport.height - margin * 2);
  const renderedHeight = Math.min(card.height, maxHeight);
  const maximumTop = Math.max(margin, viewport.height - margin - renderedHeight);
  const top = clamp(anchor.top, margin, maximumTop);

  return { left, top, width, maxHeight, placement };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function assertFiniteRect(rect: AnchorRect): void {
  for (const [name, value] of Object.entries(rect)) {
    if (!Number.isFinite(value)) {
      throw new RangeError(`anchor.${name} must be finite.`);
    }
  }
}

function assertNonNegativeSize(size: SideCardSize, name: string): void {
  assertNonNegative(size.width, `${name}.width`);
  assertNonNegative(size.height, `${name}.height`);
}

function assertNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number.`);
  }
}
