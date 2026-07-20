// Popover positioning that is pure of state (map §3.1, D1): anchor shapes in,
// style writes out — no reads of the state atom. The positioners that read
// state (reading popover, composer menu, launch settings) or live element
// geometry (slash picker, usage popover) stay with their view families and
// move in D2/D3.

import type { AnchorRect, PopoverAnchor } from "../../reading-core/state";
import { calculateCascadePlacement } from "../../reading-core/cascade-menu";

const SIDEBAR_HOVER_CARD_WIDTH = 320;
const SIDEBAR_HOVER_CARD_GAP = 8;
const SIDEBAR_HOVER_CARD_MARGIN = 8;

export function positionPopoverElement(
  popover: HTMLElement,
  anchor: PopoverAnchor | null,
  maxWidth: number,
): void {
  const viewportPadding = 14;
  const width = Math.min(maxWidth, window.innerWidth - viewportPadding * 2);
  const top = anchor?.top ?? viewportPadding;
  const left = anchor
    ? Math.min(
        window.innerWidth - width - viewportPadding,
        Math.max(viewportPadding, anchor.left + anchor.width - width),
      )
    : viewportPadding;
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  popover.style.width = `${width}px`;
  popover.style.maxHeight = `${Math.max(180, window.innerHeight - top - viewportPadding)}px`;
}

export function positionSidebarMenu(panel: HTMLElement, anchor: AnchorRect): void {
  panel.style.position = "fixed";
  panel.style.left = `${Math.round(anchor.left)}px`;
  panel.style.top = `${Math.round(anchor.bottom + 4)}px`;
  window.requestAnimationFrame(() => {
    const rect = panel.getBoundingClientRect();
    const overflowX = rect.right - (window.innerWidth - 8);
    if (overflowX > 0) {
      panel.style.left = `${Math.round(rect.left - overflowX)}px`;
    }
    const belowTop = anchor.bottom + 4;
    const belowSpace = Math.max(0, window.innerHeight - belowTop - 8);
    const aboveBottom = anchor.top - 4;
    const aboveSpace = Math.max(0, aboveBottom - 8);
    if (rect.height > belowSpace) {
      const useAbove = aboveSpace > belowSpace;
      const available = useAbove ? aboveSpace : belowSpace;
      panel.style.maxHeight = `${Math.floor(available)}px`;
      panel.style.top = useAbove
        ? `${Math.round(Math.max(8, aboveBottom - Math.min(rect.height, available)))}px`
        : `${Math.round(belowTop)}px`;
    }
  });
}

/** Side placement shared with the cascade policy: prefer right, flip left,
 *  then shift and size within the viewport. Call after the card is mounted. */
export function positionSidebarHoverCard(panel: HTMLElement, anchor: AnchorRect): void {
  panel.style.position = "fixed";
  panel.style.width = `${Math.min(
    SIDEBAR_HOVER_CARD_WIDTH,
    Math.max(0, window.innerWidth - SIDEBAR_HOVER_CARD_MARGIN * 2),
  )}px`;
  panel.style.maxHeight = `${Math.max(
    0,
    window.innerHeight - SIDEBAR_HOVER_CARD_MARGIN * 2,
  )}px`;
  const measured = panel.getBoundingClientRect();
  const placement = calculateCascadePlacement(
    anchor,
    { width: measured.width, height: measured.height },
    { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight },
    SIDEBAR_HOVER_CARD_GAP,
    SIDEBAR_HOVER_CARD_MARGIN,
  );
  panel.style.left = `${Math.round(placement.left)}px`;
  panel.style.top = `${Math.round(placement.top)}px`;
  panel.style.maxHeight = `${Math.floor(placement.availableHeight)}px`;
}

/**
 * Center a fixed-position element horizontally over an anchor rect and float it
 * just ABOVE the anchor, clamped to the viewport. If there is no room above (the
 * anchor sits near the top edge), it flips below. Used by the Quote & Comment
 * trigger and its input bar, whose anchor is the first visual line horizontally
 * and the full text selection vertically — a shape the below-anchor /
 * side-anchor positioners above do not fit. Reads live element + window
 * geometry, writes style out; call after the element is mounted so its measured
 * size is real.
 */
export function positionCenteredAbove(
  element: HTMLElement,
  anchor: AnchorRect,
  gap = 8,
  margin = 8,
): void {
  element.style.position = "fixed";
  const size = element.getBoundingClientRect();
  const centerX = anchor.left + anchor.width / 2;
  const left = Math.min(
    window.innerWidth - size.width - margin,
    Math.max(margin, centerX - size.width / 2),
  );
  const above = anchor.top - gap - size.height;
  const below = anchor.bottom + gap;
  const maxTop = Math.max(margin, window.innerHeight - size.height - margin);
  let top: number;
  if (above >= margin && above <= maxTop) {
    top = above;
  } else if (below >= margin && below <= maxTop) {
    top = below;
  } else {
    // Neither side can contain the floating element (for example, a long text
    // selection spans most of the viewport). Choose the side with more room,
    // then shift the result fully on-screen. Overlap is preferable to making
    // the comment control unreachable.
    const aboveSpace = anchor.top - gap - margin;
    const belowSpace = window.innerHeight - margin - gap - anchor.bottom;
    const preferred = aboveSpace >= belowSpace ? above : below;
    top = Math.min(maxTop, Math.max(margin, preferred));
  }
  element.style.left = `${Math.round(left)}px`;
  element.style.top = `${Math.round(top)}px`;
}
