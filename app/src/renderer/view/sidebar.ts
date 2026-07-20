// The sidebar (map §3.1 renderer/view/sidebar.ts, D3 — moved verbatim from
// main.ts): the session/project list with filter-shaped views, the three
// popup menus (session / project / filter), inline renames (T10/T11 focus
// rAFs verbatim inside), and the persistent-node spinner patch
// (updateSidebarSpinnerLiveness). State reads via the init-bound atom
// reference; policy mutations call reading-core transitions directly;
// flows and ports (session select/open, new chat, rename/archive/delete
// IPC, localStorage prefs) stay in the shell behind the actions seam.
// The sidebar chrome cluster (collapse, width, resizer drag T8) is boot
// wiring and stays in main.ts.

import {
  ChevronRight,
  Ellipsis,
  Folder,
  FolderOpen,
  ListFilter,
  LoaderCircle,
  Plus,
  X,
  type IconNode,
} from "lucide";
import type { SessionSummary, TagColor, TagDefinition, TagGroup } from "../../shared/types";
import { TAG_GROUPS } from "../../shared/types";
import { replaceTagSelection } from "../../shared/session-tags";
import {
  buildPointerGracePolygon,
  calculateCascadePlacement,
  pointerGraceProtects,
  type CascadePoint,
  type CascadeSide,
  type PointerGraceRegion,
} from "../../reading-core/cascade-menu";
import { formatRelativeAge } from "../../reading-core/selectors/formatters";
import { turnActivity } from "../../reading-core/selectors/runs";
import {
  sidebarDisclosureModel,
  sidebarFiltersNonDefault,
  sidebarPrefsNonDefault,
  type SidebarDisclosureModel,
  type SidebarDisclosureProject,
  type SidebarDisclosureProjectGroup,
  type SidebarDisclosureSessionGroup,
} from "../../reading-core/selectors/sidebar";
import {
  SIDEBAR_PREFS_DEFAULTS,
  anchorRectOf,
  isSessionLifecycleActive,
  taskViewForId,
  type FilterMenuSection,
  type RendererState,
  type SidebarDisclosureGroupKey,
  type SidebarMenuState,
  type SidebarPrefs,
  type TaskViewState,
} from "../../reading-core/state";
import * as sidebarTransitions from "../../reading-core/transitions/sidebar";
import { elements } from "../dom";
import { lucideIcon } from "./icons";
import { positionSidebarMenu } from "./popover-geometry";
import { actions } from "../actions";
import {
  renderProtectedRenameEditor,
  sidebarRenameEditorIsProtected,
} from "./rename-editor";
import { initSidebarHoverCard } from "./sidebar-hover-card";

/** The shell's state atom, bound once at boot for the sidebar's read paths. */
let state: RendererState;

export function initSidebarView(stateRef: RendererState): void {
  state = stateRef;
  initSidebarHoverCard(stateRef);
  elements.sidebarMenuRoot.addEventListener("pointermove", (event) => {
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
  window.addEventListener("resize", closeDetachedTagCascade);
  sidebarScroller().addEventListener("scroll", closeDetachedTagCascade, { passive: true });
}

function closeDetachedTagCascade(): void {
  if (state.sidebar.menu?.kind === "session" && state.sidebar.menu.tagsOpen) {
    closeSidebarMenu();
  }
}

interface SidebarRenderOptions {
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

const OUTER_SHOW_LESS_FOCUS_KEY = "disclosure:outer:less";
const OUTER_SHOW_MORE_FOCUS_KEY = "disclosure:outer:more";
let lastRenderedPrefs: SidebarPrefs | null = null;

const TAG_GROUP_LABELS: Record<TagGroup, string> = {
  status: "Status",
  type: "Type",
  priority: "Priority",
};
const TAG_GROUP_COLORS: Record<TagGroup, TagColor> = {
  status: "blue",
  type: "purple",
  priority: "orange",
};
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

function resetCascadeController(): void {
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

function cancelCascadeTimers(): void {
  for (const timer of cascadeController.timers) {
    window.clearTimeout(timer);
  }
  cascadeController.timers.clear();
}

export function renderSidebar(options: SidebarRenderOptions = {}): void {
  renderSidebarRenameNotice();
  const editor = state.sidebar.renameEditor;
  if (editor && sidebarRenameEditorIsProtected(editor)) {
    // Background state continues to advance, but rebuilding the list here
    // would detach the browser's active composition/caret owner. Structural
    // changes that could hide this editor are queued by the actions seam.
    renderProtectedRenameEditor(editor, {
      surface: "sidebar",
      focusKey:
        editor.kind === "session"
          ? `${sessionFocusKey(editor.taskId)}:rename`
          : `${projectFocusKey(editor.path)}:rename`,
    });
    return;
  }
  const snapshot = captureSidebarRenderSnapshot();
  const prefsChanged =
    lastRenderedPrefs !== null && !sidebarPrefsEqual(lastRenderedPrefs, state.sidebar.prefs);
  renderSidebarSections();
  renderSidebarMenuContents();
  restoreSidebarRenderSnapshot(snapshot, {
    ...options,
    resetScroll: options.resetScroll ?? prefsChanged,
  });
  lastRenderedPrefs = { ...state.sidebar.prefs, tags: [...state.sidebar.prefs.tags] };
}

function renderSidebarRenameNotice(): void {
  const message =
    state.sidebar.renameNotice?.surface === "sidebar"
      ? state.sidebar.renameNotice.message
      : "";
  elements.sidebarRenameNotice.textContent = message;
  elements.sidebarRenameNotice.classList.toggle("hidden", !message);
}

function renderSidebarSections(): void {
  elements.sidebarList.replaceChildren();
  const index = state.sessionIndex;
  if (!index) {
    return;
  }

  const model = sidebarDisclosureModel(
    index,
    state.sidebar.prefs,
    state.sidebar.disclosure,
    Date.now(),
    state.tagDefinitions,
  );
  const focusedProject = index.projects.find(
    (project) => project.path === state.sidebar.prefs.project,
  );
  const headerTitle =
    model.mode === "focused"
      ? (focusedProject?.name ?? "Sessions")
      : model.mode === "project"
        ? "Projects"
        : "Sessions";
  elements.sidebarList.append(renderSidebarListHeader(headerTitle));

  if (model.entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "sidebar-empty";
    const hasAnySessions =
      index.chats.length > 0 || index.projects.some((project) => project.sessions.length > 0);
    empty.textContent = hasAnySessions ? "No sessions match the filters" : "No sessions yet";
    elements.sidebarList.append(empty);
    return;
  }

  const groups = document.createElement("div");
  groups.id = "sidebar-disclosure-groups";
  groups.className = "sidebar-disclosure-groups";

  if (model.mode === "project") {
    for (const projectGroup of model.visibleProjectGroups) {
      groups.append(renderSidebarProject(projectGroup));
    }
    for (const sessionGroup of model.sessionGroups) {
      groups.append(renderSidebarSessionGroup(sessionGroup, true));
    }
  } else {
    const showLabels = model.mode === "date";
    for (const sessionGroup of model.sessionGroups) {
      groups.append(renderSidebarSessionGroup(sessionGroup, showLabels));
    }
  }

  elements.sidebarList.append(groups);
  const outer = renderOuterDisclosure(model);
  if (outer) {
    elements.sidebarList.append(outer);
  }
}

function renderSidebarListHeader(title: string): HTMLElement {
  const header = document.createElement("div");
  header.className = "sidebar-list-header";
  const label = document.createElement("p");
  label.className = "sidebar-section-label";
  label.textContent = title;

  const filterButton = document.createElement("button");
  filterButton.type = "button";
  filterButton.id = "sidebar-filter";
  filterButton.className = "sidebar-icon-button sidebar-filter-button";
  filterButton.title = "Filter, group, and sort";
  filterButton.setAttribute("aria-label", "Filter, group, and sort sessions");
  filterButton.setAttribute("aria-haspopup", "menu");
  setSidebarFocusKey(filterButton, "filter");
  // Blue whenever anything departs from the default setup — the
  // persistent "your view is shaped" signal.
  filterButton.classList.toggle("active", sidebarPrefsNonDefault(state.sidebar.prefs));
  filterButton.append(lucideIcon(ListFilter, 14));
  filterButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (state.sidebar.menu?.kind === "filter") {
      closeSidebarMenu();
      return;
    }
    sidebarTransitions.openFilterMenu(state, anchorRectOf(event.currentTarget as HTMLElement));
    renderSidebarMenu();
    void actions.refreshTagDefinitions().catch(() => {
      // Keep the boot cache; opening the filter menu is a best-effort revalidation.
    });
  });

  header.append(label, filterButton);
  return header;
}

function sidebarSectionLabel(text: string): HTMLElement {
  const label = document.createElement("p");
  label.className = "sidebar-section-label";
  label.textContent = text;
  return label;
}

function renderSidebarSessionGroup(
  group: SidebarDisclosureSessionGroup,
  showLabel: boolean,
): HTMLElement {
  const container = document.createElement("div");
  container.className = "sidebar-session-group";
  container.dataset.disclosureGroupKey = group.key;
  if (showLabel) {
    container.append(sidebarSectionLabel(group.label));
  }

  const items = document.createElement("div");
  items.id = disclosureItemsId(group.key);
  items.className = "sidebar-disclosure-items";
  for (const entry of group.visibleEntries) {
    items.append(renderSidebarSessionRow(entry.session));
  }
  container.append(items);
  if (group.disclosure.canShowMore) {
    container.append(renderLocalShowMore(group, false));
  }
  return container;
}

function renderSidebarProject(group: SidebarDisclosureProjectGroup): HTMLElement {
  const project = group.project;
  const container = document.createElement("div");
  container.className = "sidebar-project";
  container.dataset.disclosureGroupKey = group.key;

  const header = document.createElement("div");
  header.className = "sidebar-project-header";

  const projectEditor = state.sidebar.renameEditor;
  if (
    projectEditor?.kind === "project" &&
    projectEditor.surface === "sidebar" &&
    projectEditor.path === project.path
  ) {
    header.append(
      renderProtectedRenameEditor(projectEditor, {
        surface: "sidebar",
        focusKey: `${projectFocusKey(projectEditor.path)}:rename`,
      }),
    );
    container.append(header);
    return container;
  }

  const expanded = !state.sidebar.collapsedProjects.has(project.path);

  const labelButton = document.createElement("button");
  labelButton.type = "button";
  labelButton.className = "sidebar-project-label";
  labelButton.title = project.path;
  labelButton.setAttribute("aria-expanded", String(expanded));
  setSidebarFocusKey(labelButton, projectFocusKey(project.path));
  labelButton.append(lucideIcon(expanded ? FolderOpen : Folder, 14));
  const name = document.createElement("span");
  name.className = "sidebar-project-name";
  name.textContent = project.name;
  labelButton.append(name);
  const chevron = document.createElement("span");
  chevron.className = "sidebar-project-chevron";
  chevron.classList.toggle("expanded", expanded);
  chevron.append(lucideIcon(ChevronRight, 12));
  labelButton.append(chevron);
  labelButton.addEventListener("click", () => {
    actions.toggleProjectCollapsed(project.path);
  });
  labelButton.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openSidebarMenuForProject(project, event.currentTarget as HTMLElement);
  });

  const rowActions = document.createElement("span");
  rowActions.className = "sidebar-row-actions";
  const menuButton = sidebarIconButton(
    Ellipsis,
    `${project.name} actions`,
    (anchorElement) => {
      openSidebarMenuForProject(project, anchorElement);
    },
    `${projectFocusKey(project.path)}:menu`,
  );
  const newChatButton = sidebarIconButton(
    Plus,
    `New task in ${project.name}`,
    () => {
      actions.startNewChat(project.path);
    },
    `${projectFocusKey(project.path)}:new-chat`,
  );
  newChatButton.disabled = isSessionLifecycleActive(state);
  rowActions.append(menuButton, newChatButton);

  header.append(labelButton, rowActions);
  container.append(header);

  if (expanded) {
    const list = document.createElement("div");
    list.className = "sidebar-project-sessions";
    const items = document.createElement("div");
    items.id = disclosureItemsId(group.key);
    items.className = "sidebar-disclosure-items";
    for (const entry of group.visibleEntries) {
      items.append(renderSidebarSessionRow(entry.session));
    }
    list.append(items);
    if (group.disclosure.canShowMore) {
      list.append(renderLocalShowMore(group, true));
    }
    container.append(list);
  }
  return container;
}

function renderLocalShowMore(
  group: SidebarDisclosureSessionGroup,
  projectSessionAlignment: boolean,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "sidebar-disclosure-action sidebar-disclosure-local";
  button.classList.toggle("project-sessions", projectSessionAlignment);
  button.textContent = "Show more";
  button.setAttribute(
    "aria-label",
    `Show ${group.disclosure.nextIncrementCount} more ${pluralize("session", group.disclosure.nextIncrementCount)} in ${group.label}`,
  );
  button.setAttribute("aria-controls", disclosureItemsId(group.key));
  setSidebarFocusKey(button, localShowMoreFocusKey(group.key));
  button.addEventListener("click", (event) => {
    const keyboardOrigin = event.detail === 0;
    const firstNewEntry = group.entries[group.disclosure.effectiveVisibleCount];
    const completesGroup =
      group.disclosure.effectiveVisibleCount + group.disclosure.nextIncrementCount >=
      group.disclosure.totalCount;
    void actions.prepareSidebarStructureChange().then((allowed) => {
      if (!allowed) {
        return;
      }
      sidebarTransitions.showMoreSidebarGroup(state, group.key);
      renderSidebar({
        ...(keyboardOrigin && completesGroup && firstNewEntry
          ? { preferredFocusKey: sessionFocusKey(firstNewEntry.session.task.id) }
          : {}),
        allowFallback: keyboardOrigin,
        revealPreferredFocus: keyboardOrigin && completesGroup,
      });
    });
  });
  return button;
}

function renderOuterDisclosure(model: SidebarDisclosureModel): HTMLElement | null {
  if (!model.outer.showLess && !model.outer.showMore) {
    return null;
  }
  const footer = document.createElement("div");
  footer.className = "sidebar-disclosure-footer";

  if (model.outer.showLess) {
    const showLess = document.createElement("button");
    showLess.type = "button";
    showLess.className = "sidebar-disclosure-action sidebar-disclosure-outer";
    showLess.textContent = "Show less";
    showLess.setAttribute(
      "aria-label",
      "Show less and reset all project and session lists to 5 items",
    );
    showLess.setAttribute("aria-controls", "sidebar-disclosure-groups");
    setSidebarFocusKey(showLess, OUTER_SHOW_LESS_FOCUS_KEY);
    showLess.addEventListener("click", (event) => {
      const keyboardOrigin = event.detail === 0;
      void actions.prepareSidebarStructureChange().then((allowed) => {
        if (!allowed) {
          return;
        }
        sidebarTransitions.resetSidebarDisclosure(state);
        const preferredFocusKey =
          model.mode === "project" && model.outer.eligibleProjectCount > 5
            ? OUTER_SHOW_MORE_FOCUS_KEY
            : firstModelRowFocusKey(model);
        renderSidebar({
          ...(keyboardOrigin && preferredFocusKey ? { preferredFocusKey } : {}),
          allowFallback: keyboardOrigin,
          revealPreferredFocus: keyboardOrigin,
        });
      });
    });
    footer.append(showLess);
  }

  if (model.outer.showMore) {
    const showMore = document.createElement("button");
    showMore.type = "button";
    showMore.className = "sidebar-disclosure-action sidebar-disclosure-outer";
    showMore.textContent = "Show more";
    showMore.setAttribute(
      "aria-label",
      `Show ${model.outer.projectVisibility.nextIncrementCount} more ${pluralize("project", model.outer.projectVisibility.nextIncrementCount)}`,
    );
    showMore.setAttribute("aria-controls", "sidebar-disclosure-groups");
    setSidebarFocusKey(showMore, OUTER_SHOW_MORE_FOCUS_KEY);
    showMore.addEventListener("click", (event) => {
      const keyboardOrigin = event.detail === 0;
      const firstNewProject =
        model.projectGroups[model.outer.projectVisibility.effectiveVisibleCount];
      const completesProjects =
        model.outer.projectVisibility.effectiveVisibleCount +
          model.outer.projectVisibility.nextIncrementCount >=
        model.outer.projectVisibility.totalCount;
      void actions.prepareSidebarStructureChange().then((allowed) => {
        if (!allowed) {
          return;
        }
        sidebarTransitions.showMoreSidebarProjects(state);
        renderSidebar({
          ...(keyboardOrigin && completesProjects && firstNewProject
            ? { preferredFocusKey: projectFocusKey(firstNewProject.project.path) }
            : {}),
          allowFallback: keyboardOrigin,
          revealPreferredFocus: keyboardOrigin && completesProjects,
        });
      });
    });
    footer.append(showMore);
  }

  return footer;
}

function firstModelRowFocusKey(model: SidebarDisclosureModel): string | null {
  const firstProject = model.visibleProjectGroups[0];
  if (firstProject) {
    return projectFocusKey(firstProject.project.path);
  }
  const firstSession = model.sessionGroups[0]?.visibleEntries[0];
  return firstSession ? sessionFocusKey(firstSession.session.task.id) : "filter";
}

function pluralize(noun: string, count: number): string {
  return count === 1 ? noun : `${noun}s`;
}

function disclosureItemsId(key: SidebarDisclosureGroupKey): string {
  return `sidebar-disclosure-items-${encodeURIComponent(key)}`;
}

function localShowMoreFocusKey(key: SidebarDisclosureGroupKey): string {
  return `disclosure:${key}:more`;
}

function projectFocusKey(path: string): string {
  return `project:${path}`;
}

function sessionFocusKey(taskId: string): string {
  return `session:${taskId}`;
}

function setSidebarFocusKey(element: HTMLElement, key: string): void {
  element.dataset.sidebarFocusKey = key;
}

function sidebarScroller(): HTMLElement {
  return elements.sidebarList.parentElement ?? elements.sidebarList;
}

function captureSidebarRenderSnapshot(): SidebarRenderSnapshot {
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

function restoreSidebarRenderSnapshot(
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

function sidebarPrefsEqual(left: SidebarPrefs, right: SidebarPrefs): boolean {
  return (
    left.status === right.status &&
    left.project === right.project &&
    left.activity === right.activity &&
    left.tags.length === right.tags.length &&
    left.tags.every((id, index) => id === right.tags[index]) &&
    left.groupBy === right.groupBy &&
    left.sortBy === right.sortBy
  );
}

function sidebarFocusTarget(key: string): HTMLElement | null {
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

function renderSidebarSessionRow(session: SessionSummary): HTMLElement {
  const task = session.task;
  const active = task.id === state.activeTaskId;
  const row = document.createElement("div");
  row.className = "sidebar-session";
  row.dataset.taskId = task.id;
  row.classList.toggle("active", active);
  // Distinguishes archived rows when the status filter mixes them in.
  row.classList.toggle("archived", session.archived);

  const sessionEditor = state.sidebar.renameEditor;
  if (
    sessionEditor?.kind === "session" &&
    sessionEditor.surface === "sidebar" &&
    sessionEditor.taskId === task.id
  ) {
    row.append(
      renderProtectedRenameEditor(sessionEditor, {
        surface: "sidebar",
        focusKey: `${sessionFocusKey(sessionEditor.taskId)}:rename`,
      }),
    );
    return row;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "sidebar-session-button";
  button.title = task.title;
  button.disabled = isSessionLifecycleActive(state);
  setSidebarFocusKey(button, sessionFocusKey(task.id));
  if (active) {
    button.setAttribute("aria-current", "page");
  }
  const title = document.createElement("span");
  title.className = "sidebar-session-title";
  title.textContent = task.title;
  button.append(title);
  button.addEventListener("click", () => {
    actions.selectSession(task.id);
  });
  button.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openSidebarMenuForSession(task.id, task.title, session.archived, event.currentTarget as HTMLElement);
  });

  const trailing = document.createElement("span");
  trailing.className = "sidebar-session-trailing";
  const indicator = sessionStatusIndicator(session);
  if (indicator) {
    trailing.append(indicator);
  } else {
    const time = document.createElement("span");
    time.className = "sidebar-session-time";
    time.textContent = formatRelativeAge(session.lastActivityAt);
    trailing.append(time);
  }
  const menuButton = sidebarIconButton(
    Ellipsis,
    `${task.title} actions`,
    (anchorElement) => {
      openSidebarMenuForSession(task.id, task.title, session.archived, anchorElement);
    },
    `${sessionFocusKey(task.id)}:menu`,
  );
  menuButton.classList.add("sidebar-row-hover-action");
  trailing.append(menuButton);

  row.append(button, trailing);
  return row;
}

function sessionStatusIndicator(session: SessionSummary): HTMLElement | null {
  if (!session.live || !session.liveStatus) {
    return null;
  }
  // Approval can be surfaced two ways now: the footer scrape (liveStatus) or
  // the PermissionRequest hook (cliState) — Slice 1 makes the hook primary,
  // the scrape the fallback, so either fires the dot.
  const cli = taskViewForId(state, session.task.id)?.cliState ?? null;
  if (session.liveStatus === "waiting-for-approval" || cli?.activity === "waiting-approval") {
    const dot = document.createElement("span");
    dot.className = "sidebar-session-attention";
    dot.title = cli?.tool ? `Waiting for approval — ${cli.tool}` : "Waiting for approval";
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", dot.title);
    return dot;
  }
  // The spinner reads the SAME turn-state derivation as the status strip (S1b):
  // a hydrated view spins while working OR while background subagents outlive
  // their launch turn; `liveStatus` stays the fallback for un-hydrated rows. The
  // waiting-approval attention dot is handled by the branch above and wins — this
  // branch is only reached once approval is ruled out, so `turnActivity`'s
  // working-includes-approval never double-counts here.
  if (
    ["running", "starting", "stopping"].includes(session.liveStatus) ||
    turnActivity(taskViewForId(state, session.task.id)) !== "idle"
  ) {
    const spinner = document.createElement("span");
    spinner.className = "sidebar-session-spinner";
    spinner.title = "Working";
    spinner.setAttribute("role", "img");
    // Evidence-driven, not a bare CSS loop: quiet/silent pause the animation
    // and lower opacity while preserving the row's current text color.
    const liveness = taskViewForId(state, session.task.id)?.workingStatus?.liveness ?? "fresh";
    if (liveness === "quiet") {
      spinner.classList.add("quiet");
      spinner.title = "No recent activity";
    } else if (liveness === "silent") {
      spinner.classList.add("silent");
      spinner.title = "No sign of activity — check the CLI";
    }
    spinner.setAttribute("aria-label", spinner.title);
    spinner.append(lucideIcon(LoaderCircle, 14));
    return spinner;
  }
  if (taskViewForId(state, session.task.id)?.completedUnseen) {
    const dot = document.createElement("span");
    dot.className = "sidebar-session-done";
    dot.title = "Finished while you were away";
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", dot.title);
    return dot;
  }
  return null;
}

// The persistent-node discipline for the sidebar spinner: a liveness change
// toggles the existing node's class in place. The only other way to reflect
// liveness — rebuilding the row — recreates the spinner <span>, restarting its
// CSS animation at 0% (the "irregular, interrupted" rotation). Active or
// background, the spinner already lives in the sidebar; we just patch it, and
// no-op when the row currently shows a different indicator (e.g. it just
// transitioned out of "running").
export function updateSidebarSpinnerLiveness(view: TaskViewState): void {
  const taskId = view.task?.id;
  if (!taskId) {
    return;
  }
  const row = Array.from(
    elements.sidebarList.querySelectorAll<HTMLElement>(".sidebar-session"),
  ).find((node) => node.dataset.taskId === taskId);
  const spinner = row?.querySelector<HTMLElement>(".sidebar-session-spinner") ?? null;
  if (!spinner) {
    return;
  }
  const liveness = view.workingStatus?.liveness ?? "fresh";
  spinner.classList.toggle("quiet", liveness === "quiet");
  spinner.classList.toggle("silent", liveness === "silent");
  spinner.title =
    liveness === "quiet"
      ? "No recent activity"
      : liveness === "silent"
        ? "No sign of activity — check the CLI"
        : "Working";
  spinner.setAttribute("aria-label", spinner.title);
}

function sidebarIconButton(
  iconNode: IconNode,
  label: string,
  onClick: (anchorElement: HTMLElement) => void,
  focusKey?: string,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "sidebar-icon-button";
  button.setAttribute("aria-label", label);
  button.title = label;
  if (focusKey) {
    setSidebarFocusKey(button, focusKey);
  }
  button.append(lucideIcon(iconNode, 14));
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick(event.currentTarget as HTMLElement);
  });
  return button;
}

export function openSidebarMenuForSession(
  taskId: string,
  title: string,
  archived: boolean,
  anchorElement: HTMLElement,
  renameSurface: "header" | "sidebar" = "sidebar",
): void {
  sidebarTransitions.openSessionMenu(
    state,
    taskId,
    title,
    archived,
    anchorRectOf(anchorElement),
    renameSurface,
  );
  renderSidebarMenu();
}

function openSidebarMenuForProject(
  project: SidebarDisclosureProject,
  anchorElement: HTMLElement,
): void {
  sidebarTransitions.openProjectMenu(
    state,
    project.path,
    project.name,
    project.archived,
    anchorRectOf(anchorElement),
  );
  renderSidebarMenu();
}

export function closeSidebarMenu(options: SidebarRenderOptions = {}): void {
  resetCascadeController();
  if (sidebarTransitions.closeSidebarMenu(state)) {
    renderSidebarMenu(options);
  }
}

export function renderSidebarMenu(options: SidebarRenderOptions = {}): void {
  const snapshot = captureSidebarRenderSnapshot();
  renderSidebarMenuContents();
  restoreSidebarRenderSnapshot(snapshot, options);
}

function renderSidebarMenuContents(): void {
  resetCascadeController();
  elements.sidebarMenuRoot.replaceChildren();
  const menu = state.sidebar.menu;
  if (!menu) {
    return;
  }

  const panel = document.createElement("div");
  panel.className = "sidebar-menu";
  panel.setAttribute("role", "menu");
  panel.dataset.sidebarMenuPanelId = "root";
  panel.dataset.sidebarMenuTriggerFocusKey =
    menu.kind === "filter"
      ? "filter"
      : menu.kind === "session"
        ? menu.renameSurface === "header"
          ? "header:session-menu"
          : `${sessionFocusKey(menu.taskId)}:menu`
        : `${projectFocusKey(menu.path)}:menu`;

  if (menu.kind === "filter") {
    renderSidebarFilterMenu(panel, menu);
    positionSidebarMenu(panel, menu.anchor);
    elements.sidebarMenuRoot.append(panel);
    return;
  }

  if (menu.kind === "session") {
    const tags = sessionTagSubmenuTrigger(menu);
    panel.append(
      sidebarMenuItem("Rename", () => {
        actions.startSessionRename(menu.taskId, menu.renameSurface, menu.title);
      }, "default", `menu:session:${menu.taskId}:rename`),
      sidebarMenuItem("Reveal in Finder", () => {
        actions.revealSession(menu.taskId);
      }, "default", `menu:session:${menu.taskId}:reveal`),
      tags,
      menu.archived
        ? sidebarMenuItem("Unarchive", () => {
            actions.unarchiveSession(menu.taskId);
          }, "default", `menu:session:${menu.taskId}:unarchive`)
        : sidebarMenuItem("Archive", () => {
            actions.archiveSessionFromSidebar(menu.taskId);
          }, "default", `menu:session:${menu.taskId}:archive`),
      sidebarMenuItem("Delete", () => {
        actions.deleteSessionFromSidebar(menu.taskId, menu.title);
      }, "danger", `menu:session:${menu.taskId}:delete`),
    );
    elements.sidebarMenuRoot.append(panel);
    const childPanels = renderSessionTagCascade(menu, tags);
    elements.sidebarMenuRoot.append(...childPanels);
    installMenuPanelKeyboard(panel, {
      level: "root",
      onEscape: () => closeSidebarMenu(
        panel.dataset.sidebarMenuTriggerFocusKey
          ? { preferredFocusKey: panel.dataset.sidebarMenuTriggerFocusKey }
          : {},
      ),
    });
    installCascadePanelIntent(panel, () => sidebarTransitions.closeSessionTags(state));
    layoutSessionTagCascade(menu, tags, childPanels);
  } else {
    panel.append(
      sidebarMenuItem("New task here", () => {
        actions.startNewChat(menu.path);
      }, "default", `menu:project:${menu.path}:new-chat`),
      sidebarMenuItem("Rename project", () => {
        actions.startProjectRename(menu.path, menu.name);
      }, "default", `menu:project:${menu.path}:rename`),
      sidebarMenuItem("Reveal in Finder", () => {
        actions.revealProject(menu.path);
      }, "default", `menu:project:${menu.path}:reveal`),
      sidebarMenuItem(menu.archived ? "Unarchive project" : "Archive project", () => {
        actions.archiveProject(menu.path, !menu.archived);
      }, menu.archived ? "default" : "danger", `menu:project:${menu.path}:archive`),
    );
    elements.sidebarMenuRoot.append(panel);
    installMenuPanelKeyboard(panel, {
      level: "root",
      onEscape: () => closeSidebarMenu(
        panel.dataset.sidebarMenuTriggerFocusKey
          ? { preferredFocusKey: panel.dataset.sidebarMenuTriggerFocusKey }
          : {},
      ),
    });
  }

  if (isSessionLifecycleActive(state)) {
    elements.sidebarMenuRoot.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
      button.disabled = true;
    });
  }

  if (menu.kind !== "session") {
    positionSidebarMenu(panel, menu.anchor);
  }
}

function sessionTagSubmenuTrigger(
  menu: Extract<SidebarMenuState, { kind: "session" }>,
): HTMLButtonElement {
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.id = `sidebar-tags-trigger-${menu.taskId}`;
  trigger.className = "sidebar-menu-item sidebar-tag-submenu-trigger";
  trigger.setAttribute("role", "menuitem");
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", String(menu.tagsOpen));
  if (menu.tagsOpen) {
    trigger.setAttribute("aria-controls", "sidebar-tags-groups");
  }
  trigger.dataset.menuText = "Tags";
  setSidebarFocusKey(trigger, `menu:session:${menu.taskId}:tags`);
  const label = document.createElement("span");
  label.className = "sidebar-tag-row-label";
  label.textContent = "Tags";
  const chevron = document.createElement("span");
  chevron.className = "sidebar-tag-chevron";
  chevron.textContent = "›";
  chevron.setAttribute("aria-hidden", "true");
  trigger.append(label, chevron);
  wireCascadeTrigger({
    trigger,
    childPanelId: "sidebar-tags-groups",
    open: () => {
      const wasClosed = state.sidebar.menu?.kind === "session" && !state.sidebar.menu.tagsOpen;
      const changed = sidebarTransitions.openSessionTags(state);
      if (changed && wasClosed) {
        void actions.refreshTagDefinitions().catch(() => {
          // Keep the last renderer cache; the next closed→open retries the read.
        });
      }
      return changed;
    },
    childFocusKey: `menu:session:${menu.taskId}:tag-group:status`,
  });
  return trigger;
}

function renderSessionTagCascade(
  menu: Extract<SidebarMenuState, { kind: "session" }>,
  tagsTrigger: HTMLElement,
): HTMLElement[] {
  if (!menu.tagsOpen) {
    return [];
  }
  const panels: HTMLElement[] = [];
  const groupsPanel = createCascadePanel("sidebar-tags-groups", tagsTrigger.id);
  for (const group of TAG_GROUPS) {
    groupsPanel.append(renderTagGroupTrigger(menu, group));
  }
  installMenuPanelKeyboard(groupsPanel, {
    level: "groups",
    onEscape: () => {
      if (sidebarTransitions.closeSessionTags(state)) {
        renderSidebarMenu({ preferredFocusKey: `menu:session:${menu.taskId}:tags` });
      }
    },
  });
  installCascadePanelIntent(groupsPanel, () => sidebarTransitions.closeSessionTagGroup(state));
  panels.push(groupsPanel);

  if (menu.group) {
    const groupTrigger = groupsPanel.querySelector<HTMLElement>(
      `[data-tag-group="${menu.group}"]`,
    );
    if (groupTrigger) {
      const optionsPanel = renderTagOptionsPanel(menu, menu.group, groupTrigger.id);
      panels.push(optionsPanel);
    }
  }
  return panels;
}

function renderTagGroupTrigger(
  menu: Extract<SidebarMenuState, { kind: "session" }>,
  group: TagGroup,
): HTMLButtonElement {
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.id = `sidebar-tag-group-${menu.taskId}-${group}`;
  trigger.className = "sidebar-menu-item sidebar-tag-submenu-trigger";
  trigger.dataset.tagGroup = group;
  trigger.dataset.menuText = TAG_GROUP_LABELS[group];
  trigger.setAttribute("role", "menuitem");
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", String(menu.group === group));
  if (menu.group === group) {
    trigger.setAttribute("aria-controls", `sidebar-tag-options-${group}`);
  }
  setSidebarFocusKey(trigger, `menu:session:${menu.taskId}:tag-group:${group}`);

  const dot = tagDot(TAG_GROUP_COLORS[group]);
  const label = document.createElement("span");
  label.className = "sidebar-tag-row-label";
  label.textContent = TAG_GROUP_LABELS[group];
  const applied = sessionTask(menu.taskId)?.tags ?? [];
  const groupDefinitions = state.tagDefinitions.filter((definition) => definition.group === group);
  const groupIds = new Set(groupDefinitions.map((definition) => definition.id));
  const count = applied.filter((id) => groupIds.has(id)).length;
  const badge = document.createElement("span");
  badge.className = "sidebar-tag-count";
  badge.textContent = String(count);
  badge.setAttribute("aria-label", `${count} applied`);
  const chevron = document.createElement("span");
  chevron.className = "sidebar-tag-chevron";
  chevron.textContent = "›";
  chevron.setAttribute("aria-hidden", "true");
  trigger.append(dot, label, badge, chevron);

  wireCascadeTrigger({
    trigger,
    childPanelId: `sidebar-tag-options-${group}`,
    open: () => sidebarTransitions.openSessionTagGroup(state, group),
    childFocusKey: firstTagOptionFocusKey(menu.taskId, group),
  });
  return trigger;
}

function renderTagOptionsPanel(
  menu: Extract<SidebarMenuState, { kind: "session" }>,
  group: TagGroup,
  labelledBy: string,
): HTMLElement {
  const panel = createCascadePanel(`sidebar-tag-options-${group}`, labelledBy, false);
  const menuBody = document.createElement("div");
  menuBody.className = "sidebar-tag-option-menu";
  menuBody.setAttribute("role", "menu");
  menuBody.setAttribute("aria-labelledby", labelledBy);
  const definitions = state.tagDefinitions.filter((definition) => definition.group === group);
  const selected = new Set(sessionTask(menu.taskId)?.tags ?? []);
  for (const definition of definitions) {
    menuBody.append(renderTagOption(menu, definition, selected.has(definition.id)));
  }
  menuBody.append(filterMenuSeparator());
  if (menu.input?.group === group) {
    panel.append(renderTagInput(menu, group));
  } else {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "sidebar-menu-item sidebar-tag-add";
    add.setAttribute("role", "menuitem");
    add.setAttribute("aria-label", "Add tag");
    add.dataset.menuText = "Add tag";
    setSidebarFocusKey(add, `menu:session:${menu.taskId}:tag-add:${group}`);
    add.textContent = "+ Add tag";
    add.addEventListener("click", (event) => {
      event.stopPropagation();
      cancelCascadeTimers();
      if (sidebarTransitions.enterSessionTagInput(state, group)) {
        renderSidebarMenu({ preferredFocusKey: tagInputFocusKey(menu.taskId, group) });
      }
    });
    menuBody.append(add);
  }
  panel.prepend(menuBody);
  installMenuPanelKeyboard(menuBody, {
    level: "options",
    onEscape: () => {
      if (sidebarTransitions.closeSessionTagGroup(state)) {
        renderSidebarMenu({
          preferredFocusKey: `menu:session:${menu.taskId}:tag-group:${group}`,
        });
      }
    },
  });
  installCascadePanelIntent(panel, () => sidebarTransitions.closeSessionTagGroup(state));
  return panel;
}

function renderTagOption(
  menu: Extract<SidebarMenuState, { kind: "session" }>,
  definition: TagDefinition,
  selected: boolean,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "sidebar-tag-option-wrap";
  wrap.setAttribute("role", "none");
  const option = document.createElement("button");
  option.type = "button";
  option.className = "sidebar-menu-item sidebar-tag-option";
  option.dataset.menuText = definition.label;
  option.dataset.tagId = definition.id;
  option.setAttribute("role", "menuitemcheckbox");
  option.setAttribute("aria-checked", String(selected));
  setSidebarFocusKey(option, tagOptionFocusKey(menu.taskId, definition.id));
  const label = document.createElement("span");
  label.className = "sidebar-tag-row-label";
  label.textContent = definition.label;
  option.append(tagDot(definition.color), label);
  if (selected) {
    const check = document.createElement("span");
    check.className = "sidebar-tag-check";
    check.textContent = "✓";
    check.setAttribute("aria-hidden", "true");
    option.append(check);
  }
  option.addEventListener("click", (event) => {
    event.stopPropagation();
    cancelCascadeTimers();
    const next = replaceTagSelection(
      sessionTask(menu.taskId)?.tags ?? [],
      definition.id,
      state.tagDefinitions,
    );
    void actions.setSessionTags(menu.taskId, next).catch((error) => {
      state.status = error instanceof Error ? error.message : String(error);
    });
    renderSidebarMenu({ preferredFocusKey: tagOptionFocusKey(menu.taskId, definition.id) });
  });
  wrap.append(option);

  if (!definition.builtin) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "sidebar-tag-delete";
    remove.setAttribute("role", "menuitem");
    remove.setAttribute("aria-label", `Delete ${definition.label}`);
    remove.dataset.menuText = `Delete ${definition.label}`;
    setSidebarFocusKey(remove, `menu:session:${menu.taskId}:tag-delete:${definition.id}`);
    remove.append(lucideIcon(X, 13));
    remove.addEventListener("click", async (event) => {
      event.stopPropagation();
      cancelCascadeTimers();
      const fallback = deletionFallbackFocusKey(menu.taskId, definition);
      try {
        await actions.deleteTag(definition.id);
        renderSidebarMenu({ preferredFocusKey: fallback, allowFallback: true });
      } catch (error) {
        state.status = error instanceof Error ? error.message : String(error);
      }
    });
    wrap.append(remove);
  }
  return wrap;
}

function renderTagInput(
  menu: Extract<SidebarMenuState, { kind: "session" }>,
  group: TagGroup,
): HTMLElement {
  const editor = document.createElement("div");
  editor.className = "sidebar-tag-editor";
  editor.setAttribute("role", "group");
  editor.setAttribute("aria-label", `Add ${TAG_GROUP_LABELS[group]} tag`);
  const input = document.createElement("input");
  input.type = "text";
  input.className = "sidebar-tag-input";
  input.placeholder = "Tag name";
  input.value = menu.input?.draft ?? "";
  input.setAttribute("aria-label", `New ${TAG_GROUP_LABELS[group]} tag name`);
  input.setAttribute("aria-invalid", String(Boolean(menu.input?.error)));
  setSidebarFocusKey(input, tagInputFocusKey(menu.taskId, group));
  input.addEventListener("input", () => {
    sidebarTransitions.updateSessionTagInput(state, { draft: input.value, error: null });
  });
  input.addEventListener("compositionstart", () => {
    sidebarTransitions.updateSessionTagInput(state, { composing: true });
  });
  input.addEventListener("compositionend", () => {
    sidebarTransitions.updateSessionTagInput(state, { composing: false, draft: input.value });
  });
  input.addEventListener("keydown", async (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (sidebarTransitions.cancelSessionTagInput(state)) {
        renderSidebarMenu({
          preferredFocusKey: `menu:session:${menu.taskId}:tag-add:${group}`,
        });
      }
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      closeSidebarMenuForTab(event.shiftKey);
      return;
    }
    if (
      event.key !== "Enter" ||
      event.isComposing ||
      event.keyCode === 229 ||
      state.sidebar.menu?.kind !== "session" ||
      state.sidebar.menu.input?.composing
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const draft = input.value.trim();
    sidebarTransitions.updateSessionTagInput(state, { draft: input.value, error: null });
    if (!draft) {
      return;
    }
    try {
      const definition = await actions.createTag(draft, group);
      const next = replaceTagSelection(
        sessionTask(menu.taskId)?.tags ?? [],
        definition.id,
        state.tagDefinitions,
      );
      await actions.setSessionTags(menu.taskId, next);
      sidebarTransitions.cancelSessionTagInput(state);
      renderSidebarMenu({ preferredFocusKey: tagOptionFocusKey(menu.taskId, definition.id) });
    } catch (error) {
      sidebarTransitions.updateSessionTagInput(state, {
        draft: input.value,
        error: error instanceof Error ? error.message : String(error),
      });
      renderSidebarMenu({ preferredFocusKey: tagInputFocusKey(menu.taskId, group) });
    }
  });
  editor.append(input);
  if (menu.input?.error) {
    const error = document.createElement("p");
    error.className = "sidebar-tag-input-error";
    error.setAttribute("role", "alert");
    error.textContent = menu.input.error;
    editor.append(error);
  }
  return editor;
}

const cascadeOpeners = new WeakMap<HTMLElement, (focusChild: boolean) => void>();

function createCascadePanel(id: string, labelledBy: string, menuRole = true): HTMLElement {
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

function wireCascadeTrigger(options: {
  trigger: HTMLElement;
  childPanelId: string;
  open: () => boolean;
  childFocusKey: string;
}): void {
  const activate = (focusChild: boolean): void => {
    cancelCascadeTimers();
    cascadeController.grace = null;
    if (options.open()) {
      renderSidebarMenu(focusChild ? { preferredFocusKey: options.childFocusKey } : {});
    } else if (focusChild) {
      sidebarFocusTarget(options.childFocusKey)?.focus({ preventScroll: true });
    }
  };
  cascadeOpeners.set(options.trigger, activate);
  options.trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    activate(event.detail === 0);
  });
  options.trigger.addEventListener("pointerenter", (event) => {
    if (
      event.pointerType !== "mouse" ||
      (state.sidebar.menu?.kind === "session" && state.sidebar.menu.input)
    ) {
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

function installCascadePanelIntent(panel: HTMLElement, closeDescendants: () => boolean): void {
  panel.addEventListener("pointerenter", (event) => {
    if (event.pointerType === "mouse") {
      cancelCascadeTimers();
      cascadeController.grace = null;
    }
  });
  panel.addEventListener("pointerleave", (event) => {
    if (
      event.pointerType !== "mouse" ||
      (state.sidebar.menu?.kind === "session" && state.sidebar.menu.input)
    ) {
      return;
    }
    scheduleCascadeAction(CASCADE_CLOSE_MS, () => {
      if (
        elements.sidebarMenuRoot.querySelector<HTMLElement>("[data-sidebar-cascade-panel]:hover") ||
        elements.sidebarMenuRoot.querySelector<HTMLElement>("[data-sidebar-menu-panel-id=\"root\"]:hover")
      ) {
        return;
      }
      if (closeDescendants()) {
        renderSidebarMenu();
      }
    });
  });
}

function installMenuPanelKeyboard(
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
      closeSidebarMenuForTab(event.shiftKey);
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

function layoutSessionTagCascade(
  menu: Extract<SidebarMenuState, { kind: "session" }>,
  tagsTrigger: HTMLElement,
  panels: readonly HTMLElement[],
): void {
  positionSidebarMenu(
    elements.sidebarMenuRoot.querySelector<HTMLElement>("[data-sidebar-menu-panel-id=\"root\"]")!,
    menu.anchor,
  );
  const groups = panels.find((panel) => panel.id === "sidebar-tags-groups");
  if (!groups) {
    return;
  }
  positionCascadePanel(groups, tagsTrigger);
  if (menu.group) {
    const options = panels.find((panel) => panel.id === `sidebar-tag-options-${menu.group}`);
    const groupTrigger = groups.querySelector<HTMLElement>(`[data-tag-group="${menu.group}"]`);
    if (options && groupTrigger) {
      positionCascadePanel(options, groupTrigger);
    }
  }
}

function positionCascadePanel(panel: HTMLElement, anchor: HTMLElement): void {
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

function closeSidebarMenuForTab(reverse: boolean): void {
  const triggerKey = elements.sidebarMenuRoot
    .querySelector<HTMLElement>("[data-sidebar-menu-panel-id=\"root\"]")
    ?.dataset.sidebarMenuTriggerFocusKey;
  const trigger = triggerKey ? sidebarFocusTarget(triggerKey) : null;
  const outside = Array.from(
    document.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex=\"-1\"])",
    ),
  ).filter((element) => !elements.sidebarMenuRoot.contains(element) && element.offsetParent !== null);
  const triggerIndex = trigger ? outside.indexOf(trigger) : -1;
  const destination =
    triggerIndex >= 0
      ? outside[triggerIndex + (reverse ? -1 : 1)] ?? trigger
      : trigger ?? outside[reverse ? outside.length - 1 : 0] ?? null;
  closeSidebarMenu();
  destination?.focus({ preventScroll: true });
}

function sessionTask(taskId: string): SessionSummary["task"] | null {
  const index = state.sessionIndex;
  if (!index) {
    return taskViewForId(state, taskId)?.task ?? null;
  }
  return (
    index.chats.find((session) => session.task.id === taskId)?.task ??
    index.projects.flatMap((project) => project.sessions).find((session) => session.task.id === taskId)?.task ??
    taskViewForId(state, taskId)?.task ??
    null
  );
}

function tagDot(color: TagColor): HTMLElement {
  const dot = document.createElement("span");
  dot.className = "tag-dot";
  dot.dataset.tagColor = color;
  dot.setAttribute("aria-hidden", "true");
  return dot;
}

function firstTagOptionFocusKey(taskId: string, group: TagGroup): string {
  const first = state.tagDefinitions.find((definition) => definition.group === group);
  return first ? tagOptionFocusKey(taskId, first.id) : `menu:session:${taskId}:tag-add:${group}`;
}

function tagOptionFocusKey(taskId: string, tagId: string): string {
  return `menu:session:${taskId}:tag-option:${tagId}`;
}

function tagInputFocusKey(taskId: string, group: TagGroup): string {
  return `menu:session:${taskId}:tag-input:${group}`;
}

function deletionFallbackFocusKey(taskId: string, definition: TagDefinition): string {
  const group = state.tagDefinitions.filter((candidate) => candidate.group === definition.group);
  const index = group.findIndex((candidate) => candidate.id === definition.id);
  const sibling = group[index + 1] ?? group[index - 1];
  return sibling
    ? tagOptionFocusKey(taskId, sibling.id)
    : `menu:session:${taskId}:tag-add:${definition.group}`;
}

function renderSidebarFilterMenu(
  panel: HTMLElement,
  menu: Extract<SidebarMenuState, { kind: "filter" }>,
): void {
  panel.classList.add("sidebar-filter-menu");

  const statusLabels: Record<SidebarPrefs["status"], string> = {
    active: "Active",
    archived: "Archived",
    all: "All",
  };
  const activityLabels: Record<SidebarPrefs["activity"], string> = {
    "1d": "1d",
    "3d": "3d",
    "7d": "7d",
    "30d": "30d",
    all: "All",
  };
  const groupLabels: Record<SidebarPrefs["groupBy"], string> = {
    project: "Project",
    date: "Date",
    none: "None",
  };
  const sortLabels: Record<SidebarPrefs["sortBy"], string> = {
    recency: "Recency",
    created: "Created time",
    alphabetical: "Alphabetically",
  };
  const projects = state.sessionIndex?.projects ?? [];
  const projectValueLabel =
    state.sidebar.prefs.project === null
      ? "All"
      : (projects.find((project) => project.path === state.sidebar.prefs.project)?.name ?? "1 project");

  panel.append(
    filterMenuRow(
      menu,
      "status",
      "Show",
      statusLabels[state.sidebar.prefs.status],
      state.sidebar.prefs.status !== SIDEBAR_PREFS_DEFAULTS.status,
      () =>
        (["active", "archived", "all"] as const).map((value) =>
          filterMenuOption(
            statusLabels[value],
            state.sidebar.prefs.status === value,
            () => actions.setSidebarPrefs({ status: value }),
            `menu:filter:status:${value}`,
          ),
        ),
    ),
    filterMenuRow(
      menu,
      "project",
      "Project",
      projectValueLabel,
      state.sidebar.prefs.project !== SIDEBAR_PREFS_DEFAULTS.project,
      () => [
        filterMenuOption(
          "All projects",
          state.sidebar.prefs.project === null,
          () => actions.setSidebarPrefs({ project: null }),
          "menu:filter:project:all",
        ),
        ...projects.map((project) =>
          filterMenuOption(
            project.name,
            state.sidebar.prefs.project === project.path,
            () => actions.setSidebarPrefs({ project: project.path }),
            `menu:filter:project:${project.path}`,
          ),
        ),
      ],
    ),
    filterMenuRow(
      menu,
      "activity",
      "Last activity",
      activityLabels[state.sidebar.prefs.activity],
      state.sidebar.prefs.activity !== SIDEBAR_PREFS_DEFAULTS.activity,
      () =>
        (["1d", "3d", "7d", "30d", "all"] as const).map((value) =>
          filterMenuOption(
            activityLabels[value],
            state.sidebar.prefs.activity === value,
            () => actions.setSidebarPrefs({ activity: value }),
            `menu:filter:activity:${value}`,
          ),
        ),
    ),
    filterMenuRow(
      menu,
      "tags",
      "Tags",
      state.sidebar.prefs.tags.length === 0
        ? "All"
        : `${state.sidebar.prefs.tags.length} selected`,
      state.sidebar.prefs.tags.length > 0,
      () => renderTagFilterGroups(),
    ),
    filterMenuSeparator(),
    filterMenuRow(
      menu,
      "group",
      "Group by",
      groupLabels[state.sidebar.prefs.groupBy],
      state.sidebar.prefs.groupBy !== SIDEBAR_PREFS_DEFAULTS.groupBy,
      () =>
        (["date", "project", "none"] as const).map((value) =>
          filterMenuOption(
            groupLabels[value],
            state.sidebar.prefs.groupBy === value,
            () => actions.setSidebarPrefs({ groupBy: value }),
            `menu:filter:group:${value}`,
          ),
        ),
    ),
    filterMenuRow(
      menu,
      "sort",
      "Sort by",
      sortLabels[state.sidebar.prefs.sortBy],
      state.sidebar.prefs.sortBy !== SIDEBAR_PREFS_DEFAULTS.sortBy,
      () =>
        (["alphabetical", "created", "recency"] as const).map((value) =>
          filterMenuOption(
            sortLabels[value],
            state.sidebar.prefs.sortBy === value,
            () => actions.setSidebarPrefs({ sortBy: value }),
            `menu:filter:sort:${value}`,
          ),
        ),
    ),
    filterMenuSeparator(),
  );

  // Always present at the bottom; disabled when there is nothing to clear.
  const clear = sidebarMenuItem("Clear filters", () => {
    actions.setSidebarPrefs({
      status: SIDEBAR_PREFS_DEFAULTS.status,
      project: SIDEBAR_PREFS_DEFAULTS.project,
      activity: SIDEBAR_PREFS_DEFAULTS.activity,
      tags: [...SIDEBAR_PREFS_DEFAULTS.tags],
    });
  }, "default", "menu:filter:clear");
  clear.disabled = !sidebarFiltersNonDefault(state.sidebar.prefs);
  panel.append(clear);
}

function renderTagFilterGroups(): HTMLElement[] {
  return TAG_GROUPS.map((group) => {
    const section = document.createElement("div");
    section.className = "sidebar-tag-filter-group";
    section.setAttribute("role", "group");
    const headingId = `sidebar-tag-filter-heading-${group}`;
    section.setAttribute("aria-labelledby", headingId);

    const heading = document.createElement("div");
    heading.id = headingId;
    heading.className = "sidebar-tag-filter-heading";
    heading.textContent = TAG_GROUP_LABELS[group];
    section.append(heading);

    for (const definition of state.tagDefinitions) {
      if (definition.group === group) {
        section.append(filterTagMenuOption(definition));
      }
    }
    return section;
  });
}

function filterTagMenuOption(definition: TagDefinition): HTMLElement {
  const selected = state.sidebar.prefs.tags.includes(definition.id);
  const option = document.createElement("button");
  option.type = "button";
  option.className = "sidebar-menu-item sidebar-filter-option sidebar-tag-filter-option";
  option.dataset.tagId = definition.id;
  option.setAttribute("role", "menuitemcheckbox");
  option.setAttribute("aria-checked", String(selected));
  setSidebarFocusKey(option, `menu:filter:tags:${definition.id}`);

  const label = document.createElement("span");
  label.className = "sidebar-filter-label";
  label.textContent = definition.label;
  option.append(tagDot(definition.color), label);
  if (selected) {
    const check = document.createElement("span");
    check.className = "sidebar-filter-check";
    check.textContent = "✓";
    check.setAttribute("aria-hidden", "true");
    option.append(check);
  }
  option.addEventListener("click", (event) => {
    event.stopPropagation();
    const next = selected
      ? state.sidebar.prefs.tags.filter((id) => id !== definition.id)
      : [...state.sidebar.prefs.tags, definition.id];
    actions.setSidebarPrefs({ tags: next });
  });
  return option;
}

function filterMenuRow(
  menu: Extract<SidebarMenuState, { kind: "filter" }>,
  section: FilterMenuSection,
  label: string,
  value: string,
  nonDefault: boolean,
  buildOptions: () => HTMLElement[],
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "sidebar-filter-row-wrap";

  const row = document.createElement("button");
  row.type = "button";
  row.className = "sidebar-menu-item sidebar-filter-row";
  row.classList.toggle("open", menu.openSection === section);
  // Same accent as the entry icon: the menu shows WHERE the blue
  // state comes from.
  row.classList.toggle("non-default", nonDefault);
  row.setAttribute("role", "menuitem");
  row.setAttribute("aria-haspopup", "menu");
  setSidebarFocusKey(row, `menu:filter:${section}`);
  const labelSpan = document.createElement("span");
  labelSpan.className = "sidebar-filter-label";
  labelSpan.textContent = label;
  const valueSpan = document.createElement("span");
  valueSpan.className = "sidebar-filter-value";
  valueSpan.textContent = value;
  const chevron = document.createElement("span");
  chevron.className = "sidebar-filter-chevron";
  chevron.textContent = "›";
  row.append(labelSpan, valueSpan, chevron);
  row.addEventListener("click", (event) => {
    event.stopPropagation();
    if (sidebarTransitions.toggleFilterMenuSection(state, section)) {
      renderSidebarMenu();
    }
  });
  wrap.append(row);

  if (menu.openSection === section) {
    const submenu = document.createElement("div");
    submenu.className = "sidebar-filter-submenu";
    submenu.setAttribute("role", "menu");
    submenu.append(...buildOptions());
    wrap.append(submenu);
  }
  return wrap;
}

function filterMenuOption(
  label: string,
  selected: boolean,
  onSelect: () => void,
  focusKey: string,
): HTMLElement {
  const option = document.createElement("button");
  option.type = "button";
  option.className = "sidebar-menu-item sidebar-filter-option";
  option.setAttribute("role", "menuitemradio");
  option.setAttribute("aria-checked", String(selected));
  setSidebarFocusKey(option, focusKey);
  const labelSpan = document.createElement("span");
  labelSpan.className = "sidebar-filter-label";
  labelSpan.textContent = label;
  option.append(labelSpan);
  if (selected) {
    const check = document.createElement("span");
    check.className = "sidebar-filter-check";
    check.textContent = "✓";
    option.append(check);
  }
  option.addEventListener("click", (event) => {
    event.stopPropagation();
    onSelect();
  });
  return option;
}

function filterMenuSeparator(): HTMLElement {
  const separator = document.createElement("div");
  separator.className = "sidebar-menu-separator";
  separator.setAttribute("role", "separator");
  return separator;
}

function sidebarMenuItem(
  label: string,
  onSelect: () => void,
  tone: "default" | "danger" = "default",
  focusKey?: string,
): HTMLButtonElement {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "sidebar-menu-item";
  item.classList.toggle("danger", tone === "danger");
  item.setAttribute("role", "menuitem");
  item.textContent = label;
  if (focusKey) {
    setSidebarFocusKey(item, focusKey);
  }
  item.addEventListener("click", (event) => {
    closeSidebarMenu({ allowFallback: event.detail === 0 });
    onSelect();
  });
  return item;
}
