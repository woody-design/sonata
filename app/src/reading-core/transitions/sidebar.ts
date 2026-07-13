/**
 * Named state transitions for the sidebar (map §3.1, step C3d): menu
 * open/close, filter-section toggling, prefs patching, project collapse,
 * and the rename intents.
 *
 * Each transition performs exactly the mutations its shell handler performed
 * before extraction; the shell keeps the DOM rect reads (anchorRectOf), the
 * localStorage persistence for prefs/collapsed (ports), and the render
 * calls.
 */
import type {
  AnchorRect,
  FilterMenuSection,
  RendererState,
  SidebarDisclosureGroupKey,
  SidebarPrefs,
} from "../state";
import {
  SIDEBAR_DISCLOSURE_INCREMENT,
  SIDEBAR_INITIAL_VISIBLE_COUNT,
} from "../state";

export function openSessionMenu(
  state: RendererState,
  taskId: string,
  title: string,
  archived: boolean,
  anchor: AnchorRect,
): void {
  state.sidebar.menu = {
    kind: "session",
    taskId,
    title,
    archived,
    anchor,
  };
}

export function openProjectMenu(
  state: RendererState,
  path: string,
  name: string,
  archived: boolean,
  anchor: AnchorRect,
): void {
  state.sidebar.menu = {
    kind: "project",
    path,
    name,
    archived,
    anchor,
  };
}

export function openFilterMenu(state: RendererState, anchor: AnchorRect): void {
  state.sidebar.menu = {
    kind: "filter",
    anchor,
    openSection: null,
  };
}

/** Returns whether a menu was open — the shell renders only on change. */
export function closeSidebarMenu(state: RendererState): boolean {
  if (!state.sidebar.menu) {
    return false;
  }
  state.sidebar.menu = null;
  return true;
}

/** Open (or close, when already open) one filter row's submenu. Returns
 *  whether the filter menu was showing at all — the shell renders on true. */
export function toggleFilterMenuSection(
  state: RendererState,
  section: FilterMenuSection,
): boolean {
  if (state.sidebar.menu?.kind !== "filter") {
    return false;
  }
  state.sidebar.menu = {
    ...state.sidebar.menu,
    openSection: state.sidebar.menu.openSection === section ? null : section,
  };
  return true;
}

/** The prefs mutation behind setSidebarPrefs; the localStorage save stays in
 *  the shell (port). Every actual view-definition change resets disclosure;
 *  selecting the already-selected value is a true no-op and preserves it. */
export function patchSidebarPrefs(
  state: RendererState,
  patch: Partial<SidebarPrefs>,
): boolean {
  const keys = Object.keys(patch) as Array<keyof SidebarPrefs>;
  if (keys.every((key) => patch[key] === state.sidebar.prefs[key])) {
    return false;
  }
  state.sidebar.prefs = { ...state.sidebar.prefs, ...patch };
  resetSidebarDisclosure(state);
  return true;
}

/** Local Show more: store intent in exact +10 steps without clamping to the
 *  current corpus. Selectors alone clamp the rendered prefix. */
export function showMoreSidebarGroup(
  state: RendererState,
  key: SidebarDisclosureGroupKey,
): number {
  const current =
    state.sidebar.disclosure.groupVisibleLimits.get(key) ?? SIDEBAR_INITIAL_VISIBLE_COUNT;
  const next = current + SIDEBAR_DISCLOSURE_INCREMENT;
  state.sidebar.disclosure.groupVisibleLimits.set(key, next);
  return next;
}

/** Outer Show more changes only project visibility. */
export function showMoreSidebarProjects(state: RendererState): number {
  state.sidebar.disclosure.visibleProjectLimit += SIDEBAR_DISCLOSURE_INCREMENT;
  return state.sidebar.disclosure.visibleProjectLimit;
}

/** Outer Show less and every actual view-definition change share this reset. */
export function resetSidebarDisclosure(state: RendererState): boolean {
  const disclosure = state.sidebar.disclosure;
  const changed =
    disclosure.visibleProjectLimit !== SIDEBAR_INITIAL_VISIBLE_COUNT ||
    disclosure.groupVisibleLimits.size > 0;
  disclosure.visibleProjectLimit = SIDEBAR_INITIAL_VISIBLE_COUNT;
  disclosure.groupVisibleLimits.clear();
  return changed;
}

/** The collapse-set mutation; the localStorage save stays in the shell. */
export function toggleProjectCollapsed(state: RendererState, path: string): void {
  if (state.sidebar.collapsedProjects.has(path)) {
    state.sidebar.collapsedProjects.delete(path);
  } else {
    state.sidebar.collapsedProjects.add(path);
  }
}

export function startSessionRename(state: RendererState, taskId: string): void {
  state.sidebar.renamingSessionId = taskId;
}

export function endSessionRename(state: RendererState): void {
  state.sidebar.renamingSessionId = null;
}

export function startProjectRename(state: RendererState, path: string, currentName: string): void {
  state.sidebar.projectRenaming = { path, currentName };
}

export function endProjectRename(state: RendererState): void {
  state.sidebar.projectRenaming = null;
}
