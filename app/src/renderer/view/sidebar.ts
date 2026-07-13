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
import type { ProjectGroup, SessionSummary } from "../../shared/types";
import { formatRelativeAge } from "../../reading-core/selectors/formatters";
import {
  applySidebarPrefs,
  sidebarDateBuckets,
  sidebarEntries,
  sidebarFiltersNonDefault,
  sidebarPrefsNonDefault,
  type SidebarEntry,
} from "../../reading-core/selectors/sidebar";
import {
  SIDEBAR_PREFS_DEFAULTS,
  anchorRectOf,
  taskViewForId,
  type FilterMenuSection,
  type RendererState,
  type SidebarMenuState,
  type SidebarPrefs,
  type TaskViewState,
} from "../../reading-core/state";
import * as sidebarTransitions from "../../reading-core/transitions/sidebar";
import { elements } from "../dom";
import { lucideIcon } from "./icons";
import { positionSidebarMenu } from "./popover-geometry";
import { actions } from "../actions";

/** The shell's state atom, bound once at boot for the sidebar's read paths. */
let state: RendererState;

export function initSidebarView(stateRef: RendererState): void {
  state = stateRef;
}

export function renderSidebar(): void {
  renderSidebarSections();
  renderSidebarMenu();
}

function renderSidebarSections(): void {
  elements.sidebarList.replaceChildren();
  const index = state.sessionIndex;
  if (!index) {
    return;
  }

  const allEntries = sidebarEntries(index);
  const entries = applySidebarPrefs(allEntries, state.sidebar.prefs);

  const focusedProject =
    state.sidebar.prefs.project !== null
      ? index.projects.find((project) => project.path === state.sidebar.prefs.project)
      : null;
  const headerTitle = focusedProject
    ? focusedProject.name
    : state.sidebar.prefs.groupBy === "project"
      ? "Projects"
      : "Sessions";
  elements.sidebarList.append(renderSidebarListHeader(headerTitle));

  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "sidebar-empty";
    empty.textContent = allEntries.length === 0 ? "No sessions yet" : "No sessions match the filters";
    elements.sidebarList.append(empty);
    return;
  }

  if (focusedProject || state.sidebar.prefs.groupBy === "none") {
    for (const entry of entries) {
      elements.sidebarList.append(renderSidebarSessionRow(entry.session));
    }
    return;
  }

  if (state.sidebar.prefs.groupBy === "date") {
    renderSidebarDateGroups(entries);
    return;
  }

  renderSidebarProjectGroups(entries);
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

function renderSidebarProjectGroups(entries: SidebarEntry[]): void {
  const index = state.sessionIndex;
  if (!index) {
    return;
  }
  // Rebuild groups from the FILTERED entries; empty groups disappear.
  for (const project of index.projects) {
    const sessions = entries
      .filter((entry) => entry.projectPath === project.path)
      .map((entry) => entry.session);
    if (sessions.length === 0) {
      continue;
    }
    elements.sidebarList.append(renderSidebarProject({ ...project, sessions }));
  }

  const chats = entries.filter((entry) => entry.projectPath === null);
  if (chats.length > 0) {
    elements.sidebarList.append(sidebarSectionLabel("Chats"));
    for (const entry of chats) {
      elements.sidebarList.append(renderSidebarSessionRow(entry.session));
    }
  }
}

function renderSidebarDateGroups(entries: SidebarEntry[]): void {
  for (const bucket of sidebarDateBuckets(entries)) {
    if (bucket.entries.length === 0) {
      continue;
    }
    elements.sidebarList.append(sidebarSectionLabel(bucket.label));
    for (const entry of bucket.entries) {
      elements.sidebarList.append(renderSidebarSessionRow(entry.session));
    }
  }
}

function sidebarSectionLabel(text: string): HTMLElement {
  const label = document.createElement("p");
  label.className = "sidebar-section-label";
  label.textContent = text;
  return label;
}

function renderSidebarProject(project: ProjectGroup): HTMLElement {
  const container = document.createElement("div");
  container.className = "sidebar-project";

  const header = document.createElement("div");
  header.className = "sidebar-project-header";

  if (state.sidebar.projectRenaming?.path === project.path) {
    header.append(renderProjectRenameInput(project.path, project.name));
    container.append(header);
    return container;
  }

  const expanded = !state.sidebar.collapsedProjects.has(project.path);

  const labelButton = document.createElement("button");
  labelButton.type = "button";
  labelButton.className = "sidebar-project-label";
  labelButton.title = project.path;
  labelButton.setAttribute("aria-expanded", String(expanded));
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
  const menuButton = sidebarIconButton(Ellipsis, `${project.name} actions`, (anchorElement) => {
    openSidebarMenuForProject(project, anchorElement);
  });
  const newChatButton = sidebarIconButton(Plus, `New chat in ${project.name}`, () => {
    actions.startNewChat(project.path);
  });
  rowActions.append(menuButton, newChatButton);

  header.append(labelButton, rowActions);
  container.append(header);

  if (expanded) {
    const list = document.createElement("div");
    list.className = "sidebar-project-sessions";
    for (const session of project.sessions) {
      list.append(renderSidebarSessionRow(session));
    }
    container.append(list);
  }
  return container;
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

  if (state.sidebar.renamingSessionId === task.id) {
    row.append(renderSidebarRenameInput(task.id, task.title));
    return row;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "sidebar-session-button";
  button.title = task.title;
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
  const menuButton = sidebarIconButton(Ellipsis, `${task.title} actions`, (anchorElement) => {
    openSidebarMenuForSession(task.id, task.title, session.archived, anchorElement);
  });
  menuButton.classList.add("sidebar-row-hover-action");
  trailing.append(menuButton);

  row.append(button, trailing);
  return row;
}

function renderSidebarRenameInput(taskId: string, currentTitle: string): HTMLElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "sidebar-rename-input";
  input.value = currentTitle;
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const title = input.value.trim();
      sidebarTransitions.endSessionRename(state);
      if (title && title !== currentTitle) {
        actions.renameSession(taskId, title);
      } else {
        renderSidebar();
      }
    }
    if (event.key === "Escape") {
      event.preventDefault();
      sidebarTransitions.endSessionRename(state);
      renderSidebar();
    }
  });
  input.addEventListener("blur", () => {
    if (state.sidebar.renamingSessionId === taskId) {
      sidebarTransitions.endSessionRename(state);
      renderSidebar();
    }
  });
  window.requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
  return input;
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
      spinner.title = "No sign of activity — check the terminal";
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
        ? "No sign of activity — check the terminal"
        : "Working";
  spinner.setAttribute("aria-label", spinner.title);
}

function sidebarIconButton(
  iconNode: IconNode,
  label: string,
  onClick: (anchorElement: HTMLElement) => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "sidebar-icon-button";
  button.setAttribute("aria-label", label);
  button.title = label;
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
): void {
  sidebarTransitions.openSessionMenu(state, taskId, title, archived, anchorRectOf(anchorElement));
  renderSidebarMenu();
}

function openSidebarMenuForProject(project: ProjectGroup, anchorElement: HTMLElement): void {
  sidebarTransitions.openProjectMenu(
    state,
    project.path,
    project.name,
    project.archived,
    anchorRectOf(anchorElement),
  );
  renderSidebarMenu();
}

export function closeSidebarMenu(): void {
  if (sidebarTransitions.closeSidebarMenu(state)) {
    renderSidebarMenu();
  }
}

function renderSidebarMenu(): void {
  elements.sidebarMenuRoot.replaceChildren();
  const menu = state.sidebar.menu;
  if (!menu) {
    return;
  }

  const panel = document.createElement("div");
  panel.className = "sidebar-menu";
  panel.setAttribute("role", "menu");

  if (menu.kind === "filter") {
    renderSidebarFilterMenu(panel, menu);
    positionSidebarMenu(panel, menu.anchor);
    elements.sidebarMenuRoot.append(panel);
    return;
  }

  if (menu.kind === "session") {
    panel.append(
      sidebarMenuItem("Rename", () => {
        sidebarTransitions.startSessionRename(state, menu.taskId);
        renderSidebar();
      }),
      sidebarMenuItem("Reveal in Finder", () => {
        actions.revealSession(menu.taskId);
      }),
      menu.archived
        ? sidebarMenuItem("Unarchive", () => {
            actions.unarchiveSession(menu.taskId);
          })
        : sidebarMenuItem("Archive", () => {
            actions.archiveSessionFromSidebar(menu.taskId);
          }),
      sidebarMenuItem("Delete", () => {
        actions.deleteSessionFromSidebar(menu.taskId, menu.title);
      }, "danger"),
    );
  } else {
    panel.append(
      sidebarMenuItem("New chat here", () => {
        actions.startNewChat(menu.path);
      }),
      sidebarMenuItem("Rename project", () => {
        startProjectRename(menu.path, menu.name);
      }),
      sidebarMenuItem("Reveal in Finder", () => {
        actions.revealProject(menu.path);
      }),
      sidebarMenuItem(menu.archived ? "Unarchive project" : "Archive project", () => {
        actions.archiveProject(menu.path, !menu.archived);
      }, menu.archived ? "default" : "danger"),
    );
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
          filterMenuOption(statusLabels[value], state.sidebar.prefs.status === value, () =>
            actions.setSidebarPrefs({ status: value }),
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
        filterMenuOption("All projects", state.sidebar.prefs.project === null, () =>
          actions.setSidebarPrefs({ project: null }),
        ),
        ...projects.map((project) =>
          filterMenuOption(project.name, state.sidebar.prefs.project === project.path, () =>
            actions.setSidebarPrefs({ project: project.path }),
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
          filterMenuOption(activityLabels[value], state.sidebar.prefs.activity === value, () =>
            actions.setSidebarPrefs({ activity: value }),
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
          filterMenuOption(groupLabels[value], state.sidebar.prefs.groupBy === value, () =>
            actions.setSidebarPrefs({ groupBy: value }),
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
          filterMenuOption(sortLabels[value], state.sidebar.prefs.sortBy === value, () =>
            actions.setSidebarPrefs({ sortBy: value }),
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
  });
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

function filterMenuOption(label: string, selected: boolean, onSelect: () => void): HTMLElement {
  const option = document.createElement("button");
  option.type = "button";
  option.className = "sidebar-menu-item sidebar-filter-option";
  option.setAttribute("role", "menuitemradio");
  option.setAttribute("aria-checked", String(selected));
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
): HTMLButtonElement {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "sidebar-menu-item";
  item.classList.toggle("danger", tone === "danger");
  item.setAttribute("role", "menuitem");
  item.textContent = label;
  item.addEventListener("click", () => {
    closeSidebarMenu();
    onSelect();
  });
  return item;
}

function startProjectRename(path: string, currentName: string): void {
  sidebarTransitions.startProjectRename(state, path, currentName);
  renderSidebar();
}

function renderProjectRenameInput(path: string, currentName: string): HTMLElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "sidebar-rename-input";
  input.value = currentName;
  const finish = (commit: boolean): void => {
    const nextName = input.value.trim();
    sidebarTransitions.endProjectRename(state);
    if (commit && nextName && nextName !== currentName) {
      actions.renameProject(path, nextName);
    } else {
      renderSidebar();
    }
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => {
    if (state.sidebar.projectRenaming?.path === path) {
      finish(false);
    }
  });
  window.requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
  return input;
}
