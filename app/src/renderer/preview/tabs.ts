import { lucideIcon } from "../view/icons";
import { X } from "lucide";
import {
  basename,
  disambiguators,
  iconForPath,
  type PreviewDeps,
  type PreviewViewState,
} from "./state";

/**
 * The tab strip (§5.2 + §4). Every open is a new tab; an already-open path
 * focuses. The behaviors that keep browser-pure semantics livable: min-width
 * then horizontal scroll (never shrink-to-sliver), close on hover+active,
 * middle-click close, and — the pressure valve — a LAYOUT FREEZE while the
 * pointer stays in the strip after a close, so serial closing is click-click-
 * click in place. The context menu portals to <body> so the strip's own
 * overflow can't clip it.
 */

const MIN_TAB_WIDTH = 120;

let deps: PreviewDeps | null = null;
let stripEl: HTMLElement | null = null;
let currentState: PreviewViewState | null = null;
let pointerInStrip = false;
let contextMenu: HTMLElement | null = null;

export function initTabs(strip: HTMLElement, bound: PreviewDeps): void {
  deps = bound;
  stripEl = strip;
  strip.addEventListener("mouseenter", () => {
    pointerInStrip = true;
  });
  strip.addEventListener("mouseleave", () => {
    pointerInStrip = false;
    // Unfreeze: the pointer left the strip, so reflowing to natural widths can
    // no longer yank a close button out from under the cursor.
    if (currentState?.frozenWidths) {
      currentState.frozenWidths = null;
      renderTabs(currentState, strip);
    }
  });
  document.addEventListener("click", closeContextMenu);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeContextMenu();
    }
  });
  window.addEventListener("blur", closeContextMenu);
}

export function renderTabs(state: PreviewViewState, strip: HTMLElement): void {
  currentState = state;
  stripEl = strip;
  strip.replaceChildren();

  const session = state.binding.session;
  const tabs = session?.tabs ?? [];
  const active = session?.activePath ?? null;
  const dirLabels = disambiguators(session);

  for (const tab of tabs) {
    strip.append(buildTab(tab.path, tab.path === active, state, dirLabels));
  }

  applyFreeze(state, strip);
  // Crowded ⇒ tabs sit at min-width and the strip scrolls; inactive, un-hovered
  // tabs then hide their close (no misclick traps on a sliver).
  const crowded = !state.frozenWidths && tabs.length * MIN_TAB_WIDTH > strip.clientWidth;
  strip.classList.toggle("crowded", crowded);
}

function buildTab(
  path: string,
  isActive: boolean,
  state: PreviewViewState,
  dirLabels: Map<string, string>,
): HTMLElement {
  const el = document.createElement("div");
  el.className = "preview-tab";
  el.dataset.path = path;
  el.dataset.active = String(isActive);
  el.setAttribute("role", "tab");
  el.setAttribute("aria-selected", String(isActive));
  el.title = path;
  if (isActive) {
    el.classList.add("active");
  }

  const icon = document.createElement("span");
  icon.className = "preview-tab-icon";
  icon.append(lucideIcon(iconForPath(path), 14));

  const label = document.createElement("span");
  label.className = "preview-tab-label";
  label.textContent = basename(path);

  el.append(icon, label);

  const dir = dirLabels.get(path);
  if (dir) {
    const dirEl = document.createElement("span");
    dirEl.className = "preview-tab-dir";
    dirEl.textContent = dir;
    el.append(dirEl);
  }

  // Dirty dot: a background tab whose file changed. The active tab never dots —
  // it just updates (R5). View truth, cleared on focus.
  if (!isActive && state.dirty.has(path)) {
    const dot = document.createElement("span");
    dot.className = "preview-tab-dot";
    dot.setAttribute("aria-label", "Updated");
    el.append(dot);
  }

  const close = document.createElement("button");
  close.type = "button";
  close.className = "preview-tab-close";
  close.setAttribute("aria-label", `Close ${basename(path)}`);
  close.append(lucideIcon(X, 12));
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    closeTab(path);
  });
  el.append(close);

  el.addEventListener("click", () => deps?.activate(path));
  el.addEventListener("mousedown", (event) => {
    if (event.button === 1) {
      // Middle-click closes (browser convention); preventDefault stops autoscroll.
      event.preventDefault();
      closeTab(path);
    }
  });
  el.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openContextMenu(path, event.clientX, event.clientY);
  });

  return el;
}

/** Close a tab, freezing the strip's current widths first when the pointer is
 *  still inside it — the render that follows the transition then keeps every
 *  survivor where it was. */
function closeTab(path: string): void {
  if (pointerInStrip && currentState && stripEl) {
    const widths = new Map<string, number>();
    for (const el of Array.from(stripEl.querySelectorAll<HTMLElement>(".preview-tab"))) {
      if (el.dataset.path) {
        widths.set(el.dataset.path, el.getBoundingClientRect().width);
      }
    }
    currentState.frozenWidths = widths;
  }
  closeContextMenu();
  deps?.close(path);
}

function applyFreeze(state: PreviewViewState, strip: HTMLElement): void {
  const frozen = state.frozenWidths;
  strip.classList.toggle("frozen", Boolean(frozen));
  if (!frozen) {
    return;
  }
  for (const el of Array.from(strip.querySelectorAll<HTMLElement>(".preview-tab"))) {
    const width = el.dataset.path ? frozen.get(el.dataset.path) : undefined;
    if (typeof width === "number") {
      el.style.flex = "0 0 auto";
      el.style.width = `${width}px`;
    }
  }
}

// ── Context menu (§4: Close / Close Others / Close to the Right) ──────────────

function openContextMenu(path: string, x: number, y: number): void {
  closeContextMenu();
  const session = currentState?.binding.session;
  const tabs = session?.tabs ?? [];
  const index = tabs.findIndex((tab) => tab.path === path);
  const hasOthers = tabs.length > 1;
  const hasRight = index >= 0 && index < tabs.length - 1;

  const menu = document.createElement("div");
  menu.className = "preview-context-menu";
  menu.append(
    menuItem("Close", true, () => deps?.close(path)),
    menuItem("Close Others", hasOthers, () => deps?.closeOthers(path)),
    menuItem("Close to the Right", hasRight, () => deps?.closeToRight(path)),
  );
  // Portal to <body> so the strip's overflow-x can neither clip nor scroll it.
  document.body.append(menu);
  contextMenu = menu;

  // Clamp into the viewport (a right-edge tab must not push the menu off-screen).
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}

function menuItem(label: string, enabled: boolean, action: () => void): HTMLElement {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "preview-context-item";
  item.textContent = label;
  item.disabled = !enabled;
  if (enabled) {
    item.addEventListener("click", () => {
      closeContextMenu();
      action();
    });
  }
  return item;
}

function closeContextMenu(): void {
  contextMenu?.remove();
  contextMenu = null;
}
