// Popover positioning that is pure of state (map §3.1, D1): anchor shapes in,
// style writes out — no reads of the state atom. The positioners that read
// state (reading popover, composer menu, launch settings) or live element
// geometry (slash picker, usage popover) stay with their view families and
// move in D2/D3.

import type { AnchorRect, PopoverAnchor } from "../../reading-core/state";

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
