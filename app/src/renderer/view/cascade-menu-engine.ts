// Cascade interaction engine (S6 — extracted verbatim from view/sidebar.ts):
// the feature-agnostic hover/click/keyboard machinery for a multi-level popup
// cascade (trigger → child panels). Owns the hover-open / grace-polygon /
// close-on-leave timers, the roving-tabindex keyboard navigation (arrows,
// Home/End, typeahead, Escape, Tab, ArrowRight-to-open / ArrowLeft-to-close),
// and cascade-panel placement. The host feature (the sidebar) supplies its
// menu root, its repaint, its focus-by-key resolver, its Tab-out handler, and
// a hover-suppression predicate through initCascadeEngine — the engine never
// imports a sibling view family. The pure grace-polygon geometry stays in
// reading-core/cascade-menu (untouched).

import {
  buildPointerGracePolygon,
  calculateCascadePlacement,
  pointerGraceProtects,
  type CascadePoint,
  type CascadeSide,
  type PointerGraceRegion,
} from "../../reading-core/cascade-menu";
import { anchorRectOf } from "../../reading-core/state";

/** The host-supplied surface the engine drives. Bound once at boot (R4). */
export interface CascadeEngineDeps {
  /** The overlay container holding the root menu + detached cascade panels. */
  menuRoot: HTMLElement;
  /** Repaint the menu (optionally handing focus to a semantic key). */
  renderMenu(options?: { preferredFocusKey?: string }): void;
  /** Resolve a focus target by its semantic key (host focus scheme). */
  focusTarget(key: string): HTMLElement | null;
  /** Close the whole menu and move focus to the next/previous tab stop. */
  closeMenuForTab(reverse: boolean): void;
  /** Whether hover-driven open/close is currently suppressed (e.g. a text
   *  input owns the menu — pointer transitions must not steal it). */
  hoverSuppressed(): boolean;
}

const CASCADE_HOVER_OPEN_MS = 100;
const CASCADE_GRACE_MS = 300;
const CASCADE_CLOSE_MS = 150;

const cascadeController = {
  timers: new Set<number>(),
  previousPoint: null as CascadePoint | null,
  currentPoint: null as CascadePoint | null,
  grace: null as PointerGraceRegion | null,
  sides: new Map<string, CascadeSide>(),
};

const cascadeOpeners = new WeakMap<HTMLElement, (focusChild: boolean) => void>();

// A mouse left a cascade panel and a close is pending (m6). Deliberately NOT
// cleared by resetCascadeController, so it survives a background menu rebuild
// (a sessions-updated echo) that would otherwise wipe the scheduled close and
// strand the cascade open — rearmCascadeCloseIfPending re-establishes it. A
// keyboard-opened cascade never sets this, so it is never spuriously closed.
let closeArmed = false;

let deps: CascadeEngineDeps;

/** Bind the host surface and install the menu-root pointer tracking that keeps
 *  the grace polygon live. Call once at boot, before the first render (R4). */
export function initCascadeEngine(boundDeps: CascadeEngineDeps): void {
  deps = boundDeps;
  deps.menuRoot.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "mouse") {
      return;
    }
    cascadeController.previousPoint = cascadeController.currentPoint;
    cascadeController.currentPoint = { x: event.clientX, y: event.clientY };
    if (
      cascadeController.grace &&
      !pointerGraceProtects(
        cascadeController.grace,
        cascadeController.previousPoint,
        cascadeController.currentPoint,
        performance.now(),
      )
    ) {
      cascadeController.grace = null;
    }
  });
}

export function resetCascadeController(): void {
  for (const timer of cascadeController.timers) {
    window.clearTimeout(timer);
  }
  cascadeController.timers.clear();
  cascadeController.previousPoint = null;
  cascadeController.currentPoint = null;
  cascadeController.grace = null;
  cascadeController.sides.clear();
}

function scheduleCascadeAction(delay: number, action: () => void): number {
  const timer = window.setTimeout(() => {
    cascadeController.timers.delete(timer);
    action();
  }, delay);
  cascadeController.timers.add(timer);
  return timer;
}

export function cancelCascadeTimers(): void {
  for (const timer of cascadeController.timers) {
    window.clearTimeout(timer);
  }
  cascadeController.timers.clear();
}

export function createCascadePanel(id: string, labelledBy: string, menuRole = true): HTMLElement {
  const panel = document.createElement("div");
  panel.id = id;
  panel.className = "sidebar-menu sidebar-cascade-panel";
  if (menuRole) {
    panel.setAttribute("role", "menu");
    panel.setAttribute("aria-labelledby", labelledBy);
  }
  panel.dataset.sidebarCascadePanel = "true";
  panel.dataset.sidebarMenuPanelId = id;
  return panel;
}

export function wireCascadeTrigger(options: {
  trigger: HTMLElement;
  childPanelId: string;
  open: () => boolean;
  childFocusKey: string;
}): void {
  const activate = (focusChild: boolean): void => {
    cancelCascadeTimers();
    cascadeController.grace = null;
    closeArmed = false; // a fresh open supersedes any pending mouse-driven close
    if (options.open()) {
      deps.renderMenu(focusChild ? { preferredFocusKey: options.childFocusKey } : {});
    } else if (focusChild) {
      deps.focusTarget(options.childFocusKey)?.focus({ preventScroll: true });
    }
  };
  cascadeOpeners.set(options.trigger, activate);
  options.trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    activate(event.detail === 0);
  });
  options.trigger.addEventListener("pointerenter", (event) => {
    if (event.pointerType !== "mouse" || deps.hoverSuppressed()) {
      return;
    }
    const point = { x: event.clientX, y: event.clientY };
    if (
      pointerGraceProtects(
        cascadeController.grace,
        cascadeController.previousPoint,
        point,
        performance.now(),
      )
    ) {
      return;
    }
    cancelCascadeTimers();
    scheduleCascadeAction(CASCADE_HOVER_OPEN_MS, () => activate(false));
  });
  options.trigger.addEventListener("pointerleave", (event) => {
    if (event.pointerType !== "mouse") {
      return;
    }
    const child = document.getElementById(options.childPanelId);
    const side = cascadeController.sides.get(options.childPanelId);
    if (!child || !side) {
      return;
    }
    cascadeController.grace = {
      polygon: buildPointerGracePolygon(
        { x: event.clientX, y: event.clientY },
        anchorRectOf(child),
        side,
      ),
      side,
      expiresAt: performance.now() + CASCADE_GRACE_MS,
    };
  });
}

export function installCascadePanelIntent(
  panel: HTMLElement,
  closeDescendants: () => boolean,
): void {
  panel.addEventListener("pointerenter", (event) => {
    if (event.pointerType === "mouse") {
      cancelCascadeTimers();
      cascadeController.grace = null;
      closeArmed = false; // mouse is back inside the cascade — cancel the pending close
    }
  });
  panel.addEventListener("pointerleave", (event) => {
    if (event.pointerType !== "mouse" || deps.hoverSuppressed()) {
      return;
    }
    closeArmed = true;
    scheduleCascadeAction(CASCADE_CLOSE_MS, () => {
      closeArmed = false;
      if (pointerOverCascade()) {
        return;
      }
      if (closeDescendants()) {
        deps.renderMenu();
      }
    });
  });
}

function pointerOverCascade(): boolean {
  return Boolean(
    deps.menuRoot.querySelector<HTMLElement>("[data-sidebar-cascade-panel]:hover") ||
      deps.menuRoot.querySelector<HTMLElement>("[data-sidebar-menu-panel-id=\"root\"]:hover"),
  );
}

/** After a background rebuild wiped the cascade timers (resetCascadeController
 *  runs at the top of every menu rebuild, including a sessions-updated echo),
 *  re-establish a pending mouse-driven close — otherwise the echo cancels the
 *  scheduled close and strands the cascade open under a pointer that already
 *  left (m6). Only re-arms when a close was actually pending; a keyboard-opened
 *  cascade never armed one, and the fire-time hover check keeps a mouse that is
 *  still inside from being closed. Caller passes the collapse for its deepest
 *  open level. */
export function rearmCascadeCloseIfPending(closeDescendants: () => boolean): void {
  if (!closeArmed) {
    return;
  }
  scheduleCascadeAction(CASCADE_CLOSE_MS, () => {
    closeArmed = false;
    if (pointerOverCascade()) {
      return;
    }
    if (closeDescendants()) {
      deps.renderMenu();
    }
  });
}

export function installMenuPanelKeyboard(
  panel: HTMLElement,
  options: { level: "root" | "groups" | "options"; onEscape: () => void },
): void {
  const initialItems = menuPanelItems(panel);
  initialItems.forEach((item, index) => {
    item.tabIndex = index === 0 ? 0 : -1;
  });
  let typeahead = "";
  let typeaheadTimer: number | null = null;
  panel.addEventListener("focusin", (event) => {
    if (!(event.target instanceof HTMLElement) || event.target instanceof HTMLInputElement) {
      return;
    }
    for (const item of menuPanelItems(panel)) {
      item.tabIndex = item === event.target ? 0 : -1;
    }
  });
  panel.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement) {
      return;
    }
    const items = menuPanelItems(panel);
    if (items.length === 0) {
      return;
    }
    const active = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[role^=menuitem]") : null;
    const index = Math.max(0, items.indexOf(active ?? items[0]!));
    let target: HTMLElement | null = null;
    if (event.key === "ArrowDown") {
      target = items[(index + 1) % items.length] ?? null;
    } else if (event.key === "ArrowUp") {
      target = items[(index - 1 + items.length) % items.length] ?? null;
    } else if (event.key === "Home") {
      target = items[0] ?? null;
    } else if (event.key === "End") {
      target = items.at(-1) ?? null;
    } else if (event.key === "ArrowRight" && active) {
      const opener = cascadeOpeners.get(active);
      if (opener) {
        event.preventDefault();
        event.stopPropagation();
        opener(true);
      }
      return;
    } else if (event.key === "ArrowLeft" && options.level !== "root") {
      event.preventDefault();
      event.stopPropagation();
      options.onEscape();
      return;
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      options.onEscape();
      return;
    } else if (event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      deps.closeMenuForTab(event.shiftKey);
      return;
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      typeahead += event.key.toLocaleLowerCase();
      if (typeaheadTimer !== null) {
        window.clearTimeout(typeaheadTimer);
      }
      typeaheadTimer = window.setTimeout(() => {
        typeahead = "";
        typeaheadTimer = null;
      }, 700);
      target =
        [...items.slice(index + 1), ...items.slice(0, index + 1)].find((item) =>
          (item.dataset.menuText ?? "").toLocaleLowerCase().startsWith(typeahead),
        ) ?? null;
    }
    if (target) {
      event.preventDefault();
      event.stopPropagation();
      target.focus({ preventScroll: true });
    }
  });
}

function menuPanelItems(panel: HTMLElement): HTMLElement[] {
  return Array.from(
    panel.querySelectorAll<HTMLElement>("[role=menuitem], [role=menuitemcheckbox]"),
  ).filter((item) => !item.hasAttribute("disabled"));
}

export function positionCascadePanel(panel: HTMLElement, anchor: HTMLElement): void {
  panel.style.maxHeight = "";
  const rect = panel.getBoundingClientRect();
  const placement = calculateCascadePlacement(
    anchorRectOf(anchor),
    { width: rect.width, height: rect.height },
    { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight },
  );
  panel.style.left = `${Math.round(placement.left)}px`;
  panel.style.top = `${Math.round(placement.top)}px`;
  panel.style.maxHeight = `${Math.floor(placement.availableHeight)}px`;
  panel.dataset.cascadeSide = placement.side;
  const chevron = anchor.querySelector<HTMLElement>(".sidebar-tag-chevron");
  if (chevron) {
    chevron.textContent = placement.side === "left" ? "‹" : "›";
  }
  cascadeController.sides.set(panel.id, placement.side);
}
