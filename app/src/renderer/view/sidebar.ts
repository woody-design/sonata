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
  type IconNode,
} from "lucide";
import type { SessionSummary } from "../../shared/types";
import { formatRelativeAge } from "../../reading-core/selectors/formatters";
import {
  sidebarDisclosureModel,
  sidebarFiltersNonDefault,
  sidebarPrefsNonDefault,
  type SidebarDisclosureModel,
  type SidebarDisclosureProject,
  type SidebarDisclosureProjectGroup,
  type SidebarDisclosureSessionGroup,
  type SidebarEntry,
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

/** The shell's state atom, bound once at boot for the sidebar's read paths. */
let state: RendererState;

export function initSidebarView(stateRef: RendererState): void {
  state = stateRef;
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
  menuScrollTop: number | null;
}

const OUTER_SHOW_LESS_FOCUS_KEY = "disclosure:outer:less";
const OUTER_SHOW_MORE_FOCUS_KEY = "disclosure:outer:more";
let lastRenderedPrefs: SidebarPrefs | null = null;

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
  lastRenderedPrefs = { ...state.sidebar.prefs };
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

  const model = sidebarDisclosureModel(index, state.sidebar.prefs, state.sidebar.disclosure);
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
    items.append(renderSidebarSessionRow(entry));
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
      items.append(renderSidebarSessionRow(entry));
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
  const menu = elements.sidebarMenuRoot.querySelector<HTMLElement>(".sidebar-menu");
  const ownsFocus =
    active !== null &&
    (elements.sidebarList.contains(active) || elements.sidebarMenuRoot.contains(active));
  return {
    focusKey: ownsFocus ? (active.dataset.sidebarFocusKey ?? null) : null,
    fallbackFocusKeys: ownsFocus ? sidebarFallbackFocusKeys(active) : [],
    focusOffsetTop:
      ownsFocus && elements.sidebarList.contains(active)
        ? active.getBoundingClientRect().top - scroller.getBoundingClientRect().top
        : null,
    scrollTop: scroller.scrollTop,
    menuFocusOffsetTop:
      ownsFocus && menu?.contains(active)
        ? active.getBoundingClientRect().top - menu.getBoundingClientRect().top
        : null,
    menuScrollTop: menu?.scrollTop ?? null,
  };
}

function restoreSidebarRenderSnapshot(
  snapshot: SidebarRenderSnapshot,
  options: SidebarRenderOptions,
): void {
  const scroller = sidebarScroller();
  scroller.scrollTop = options.resetScroll ? 0 : snapshot.scrollTop;
  const menu = elements.sidebarMenuRoot.querySelector<HTMLElement>(".sidebar-menu");
  if (menu && snapshot.menuScrollTop !== null) {
    menu.scrollTop = snapshot.menuScrollTop;
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

  target.focus({ preventScroll: true });
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

function renderSidebarSessionRow(entry: SidebarEntry): HTMLElement {
  const session = entry.session;
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
  if (["running", "starting", "stopping"].includes(session.liveStatus) || cli?.activity === "busy") {
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
  if (sidebarTransitions.closeSidebarMenu(state)) {
    renderSidebarMenu(options);
  }
}

function renderSidebarMenu(options: SidebarRenderOptions = {}): void {
  const snapshot = captureSidebarRenderSnapshot();
  renderSidebarMenuContents();
  restoreSidebarRenderSnapshot(snapshot, options);
}

function renderSidebarMenuContents(): void {
  elements.sidebarMenuRoot.replaceChildren();
  const menu = state.sidebar.menu;
  if (!menu) {
    return;
  }

  const panel = document.createElement("div");
  panel.className = "sidebar-menu";
  panel.setAttribute("role", "menu");
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
    panel.append(
      sidebarMenuItem("Rename", () => {
        actions.startSessionRename(menu.taskId, menu.renameSurface, menu.title);
      }, "default", `menu:session:${menu.taskId}:rename`),
      sidebarMenuItem("Reveal in Finder", () => {
        actions.revealSession(menu.taskId);
      }, "default", `menu:session:${menu.taskId}:reveal`),
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
  }

  if (isSessionLifecycleActive(state)) {
    panel.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
      button.disabled = true;
    });
  }

  positionSidebarMenu(panel, menu.anchor);
  elements.sidebarMenuRoot.append(panel);
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
      "Status",
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
    });
  }, "default", "menu:filter:clear");
  clear.disabled = !sidebarFiltersNonDefault(state.sidebar.prefs);
  panel.append(clear);
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
