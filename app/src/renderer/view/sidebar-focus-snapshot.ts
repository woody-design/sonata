// Sidebar focus/scroll snapshot-restore engine (S6 — extracted verbatim from
// view/sidebar.ts): the generic capture-before / restore-after mechanics that
// keep keyboard focus, caret/selection, list scroll offset, and per-panel menu
// scroll positions stable across a full list/menu rebuild. State-free DOM
// mechanics over the sidebar's `elements` containers and its data-sidebar-*
// focus-key convention — no renderer state, so it is a pure view leaf (imports
// only the DOM shell). The focus-key resolver is exported so the cascade engine
// can reach the same scheme through an injected dep.

import { elements } from "../dom";

export interface SidebarRenderOptions {
  /** Keyboard-only destination used when the activating disclosure control
   *  disappears. Normal rebuilds restore the captured semantic key. */
  preferredFocusKey?: string;
  allowFallback?: boolean;
  revealPreferredFocus?: boolean;
  resetScroll?: boolean;
}

interface SidebarRenderSnapshot {
  focusKey: string | null;
  fallbackFocusKeys: string[];
  focusOffsetTop: number | null;
  scrollTop: number;
  menuFocusOffsetTop: number | null;
  menuFocusPanelId: string | null;
  menuScrollTops: Record<string, number>;
  selectionStart: number | null;
  selectionEnd: number | null;
  selectionDirection: "forward" | "backward" | "none" | null;
}

export function sidebarScroller(): HTMLElement {
  return elements.sidebarList.parentElement ?? elements.sidebarList;
}

export function captureSidebarRenderSnapshot(): SidebarRenderSnapshot {
  const scroller = sidebarScroller();
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const activePanel = active?.closest<HTMLElement>("[data-sidebar-menu-panel-id]") ?? null;
  const activeInput = active instanceof HTMLInputElement ? active : null;
  const ownsFocus =
    active !== null &&
    (elements.sidebarList.contains(active) || elements.sidebarMenuRoot.contains(active));
  const menuScrollTops: Record<string, number> = {};
  for (const panel of Array.from(
    elements.sidebarMenuRoot.querySelectorAll<HTMLElement>("[data-sidebar-menu-panel-id]"),
  )) {
    const panelId = panel.dataset.sidebarMenuPanelId;
    if (panelId) {
      menuScrollTops[panelId] = panel.scrollTop;
    }
  }
  return {
    focusKey: ownsFocus ? (active.dataset.sidebarFocusKey ?? null) : null,
    fallbackFocusKeys: ownsFocus ? sidebarFallbackFocusKeys(active) : [],
    focusOffsetTop:
      ownsFocus && elements.sidebarList.contains(active)
        ? active.getBoundingClientRect().top - scroller.getBoundingClientRect().top
        : null,
    scrollTop: scroller.scrollTop,
    menuFocusOffsetTop:
      ownsFocus && activePanel?.contains(active)
        ? active.getBoundingClientRect().top - activePanel.getBoundingClientRect().top
        : null,
    menuFocusPanelId: activePanel?.dataset.sidebarMenuPanelId ?? null,
    menuScrollTops,
    selectionStart: ownsFocus ? (activeInput?.selectionStart ?? null) : null,
    selectionEnd: ownsFocus ? (activeInput?.selectionEnd ?? null) : null,
    selectionDirection: ownsFocus ? (activeInput?.selectionDirection ?? null) : null,
  };
}

export function restoreSidebarRenderSnapshot(
  snapshot: SidebarRenderSnapshot,
  options: SidebarRenderOptions,
): void {
  const scroller = sidebarScroller();
  scroller.scrollTop = options.resetScroll ? 0 : snapshot.scrollTop;
  for (const [panelId, scrollTop] of Object.entries(snapshot.menuScrollTops)) {
    const panel = elements.sidebarMenuRoot.querySelector<HTMLElement>(
      `[data-sidebar-menu-panel-id="${CSS.escape(panelId)}"]`,
    );
    if (panel) {
      panel.scrollTop = scrollTop;
    }
  }
  const desiredKey = options.preferredFocusKey ?? snapshot.focusKey;
  if (!desiredKey) {
    return;
  }

  let target = sidebarFocusTarget(desiredKey);
  let usingFallback = false;
  if (!target && snapshot.focusKey && options.allowFallback !== false) {
    target =
      snapshot.fallbackFocusKeys
        .map((key) => sidebarFocusTarget(key))
        .find((candidate): candidate is HTMLElement => candidate !== null) ??
      firstSidebarRowFocusTarget() ??
      sidebarFocusTarget("filter");
    usingFallback = target !== null;
  }
  if (!target) {
    return;
  }

  const revealHiddenMenuTrigger =
    target.classList.contains("sidebar-row-hover-action") &&
    getComputedStyle(target).visibility === "hidden";
  if (revealHiddenMenuTrigger) {
    // The ellipsis is paint-hidden off hover. Chromium refuses focus on a
    // visibility:hidden button, so reveal it for the focus handoff; once focus
    // lands, the row's existing :focus-within rule keeps it visible.
    target.style.visibility = "visible";
  }
  target.focus({ preventScroll: true });
  if (revealHiddenMenuTrigger) {
    target.style.removeProperty("visibility");
  }
  if (
    target instanceof HTMLInputElement &&
    snapshot.selectionStart !== null &&
    snapshot.selectionEnd !== null
  ) {
    target.setSelectionRange(
      snapshot.selectionStart,
      snapshot.selectionEnd,
      snapshot.selectionDirection ?? "none",
    );
  }
  const menu = snapshot.menuFocusPanelId
    ? elements.sidebarMenuRoot.querySelector<HTMLElement>(
        `[data-sidebar-menu-panel-id="${CSS.escape(snapshot.menuFocusPanelId)}"]`,
      )
    : null;
  if (
    !options.preferredFocusKey &&
    !usingFallback &&
    snapshot.menuFocusOffsetTop !== null &&
    menu?.contains(target)
  ) {
    const nextOffset =
      target.getBoundingClientRect().top - menu.getBoundingClientRect().top;
    menu.scrollTop += nextOffset - snapshot.menuFocusOffsetTop;
    return;
  }
  if (
    !options.preferredFocusKey &&
    !usingFallback &&
    !options.resetScroll &&
    snapshot.focusOffsetTop !== null &&
    elements.sidebarList.contains(target)
  ) {
    const nextOffset =
      target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop += nextOffset - snapshot.focusOffsetTop;
    return;
  }
  if (
    options.revealPreferredFocus ||
    usingFallback ||
    (options.resetScroll && elements.sidebarList.contains(target))
  ) {
    target.scrollIntoView({ block: "nearest" });
  }
}

export function sidebarFocusTarget(key: string): HTMLElement | null {
  if (key === "header:session-menu") {
    return elements.sessionMenuTrigger;
  }
  const candidates = [
    ...Array.from(
      elements.sidebarList.querySelectorAll<HTMLElement>("[data-sidebar-focus-key]"),
    ),
    ...Array.from(
      elements.sidebarMenuRoot.querySelectorAll<HTMLElement>("[data-sidebar-focus-key]"),
    ),
  ];
  return candidates.find((candidate) => candidate.dataset.sidebarFocusKey === key) ?? null;
}

function firstSidebarRowFocusTarget(): HTMLElement | null {
  return elements.sidebarList.querySelector<HTMLElement>(
    ".sidebar-project-label, .sidebar-session-button",
  );
}

function sidebarFallbackFocusKeys(active: HTMLElement): string[] {
  const keys: string[] = [];
  const pushKey = (element: HTMLElement | null): void => {
    const key = element?.dataset.sidebarFocusKey;
    if (key && key !== active.dataset.sidebarFocusKey && !keys.includes(key)) {
      keys.push(key);
    }
  };

  const menu = active.closest<HTMLElement>(".sidebar-menu");
  if (menu) {
    const triggerKey = menu.dataset.sidebarMenuTriggerFocusKey;
    if (triggerKey) {
      keys.push(triggerKey);
    }
    return keys;
  }

  const sessionRow = active.closest<HTMLElement>(".sidebar-session");
  if (sessionRow) {
    const sessionButton = sessionRow.querySelector<HTMLElement>(".sidebar-session-button");
    const items = sessionRow.closest<HTMLElement>(".sidebar-disclosure-items");
    const rows = items
      ? Array.from(items.querySelectorAll<HTMLElement>(":scope > .sidebar-session"))
      : [];
    const index = rows.indexOf(sessionRow);
    for (let distance = 1; index >= 0 && distance < rows.length; distance += 1) {
      pushKey(rows[index + distance]?.querySelector<HTMLElement>(".sidebar-session-button") ?? null);
      pushKey(rows[index - distance]?.querySelector<HTMLElement>(".sidebar-session-button") ?? null);
    }
    pushKey(
      sessionRow
        .closest<HTMLElement>(".sidebar-project")
        ?.querySelector<HTMLElement>(".sidebar-project-label") ?? null,
    );
    const globalRows = Array.from(
      elements.sidebarList.querySelectorAll<HTMLElement>(
        ".sidebar-project-label, .sidebar-session-button",
      ),
    );
    const globalIndex = sessionButton ? globalRows.indexOf(sessionButton) : -1;
    for (
      let distance = 1;
      globalIndex >= 0 && distance < globalRows.length;
      distance += 1
    ) {
      pushKey(globalRows[globalIndex + distance] ?? null);
      pushKey(globalRows[globalIndex - distance] ?? null);
    }
    return keys;
  }

  const project = active.closest<HTMLElement>(".sidebar-project");
  if (project) {
    const projects = Array.from(
      elements.sidebarList.querySelectorAll<HTMLElement>(".sidebar-project"),
    );
    const index = projects.indexOf(project);
    for (let distance = 1; index >= 0 && distance < projects.length; distance += 1) {
      pushKey(
        projects[index + distance]?.querySelector<HTMLElement>(".sidebar-project-label") ?? null,
      );
      pushKey(
        projects[index - distance]?.querySelector<HTMLElement>(".sidebar-project-label") ?? null,
      );
    }
  }
  return keys;
}
