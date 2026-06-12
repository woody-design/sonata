import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import DOMPurify from "dompurify";
import {
  createElement as createLucideIcon,
  ChevronRight,
  Ellipsis,
  Eye,
  Folder,
  FolderOpen,
  ListFilter,
  LoaderCircle,
  PanelLeft,
  Plus,
  SearchCode,
  SquarePen,
  SquareTerminal,
  type IconNode,
} from "lucide";
import { marked } from "marked";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import {
  READING_MODE_IDS,
  READING_TEXT_STEPS,
  READING_THEME_IDS,
  isReadingTextStep,
  normalizeReadingSettings,
  type ReadingModeSetting,
  type ReadingSettings,
  type ReadingThemeId,
  type ResolvedReadingMode,
} from "../shared/types";
import type {
  ApprovalDecision,
  ArtifactCandidate,
  ClaudePermissionMode,
  CodexApprovalMode,
  CodexPermissionPreset,
  CodexSandboxMode,
  DeliveryControlChange,
  DeliveryAttachment,
  DeliveryQueueItem,
  DeliveryTaskState,
  LaunchSpeedMode,
  ReasoningEffort,
  ProjectGroup,
  RuntimeProvider,
  SessionIndexResponse,
  SessionSummary,
  Task,
  UsageSnapshot,
} from "../shared/types";
import type { ApprovalDetectedEvent, TranscriptBlocksEvent } from "../shared/types/events";
import type { FocusArtifactInMainRequest, PreviewWindowTab } from "../shared/types/ipc";
import type {
  PlanBlock,
  ToolCallBlock,
  TranscriptBlock,
  TranscriptSourceRef,
} from "../shared/types/transcript";
import type { NativeStatusRegion, WorkingStatusState } from "../shared/types/working-status";
import type { RuntimeReportV1, RuntimeRunReport } from "../shared/schemas";
import { cleanTerminalTranscript } from "../shared/terminal-transcript";

interface RunTranscript {
  runId: string;
  rawText: string;
  text: string;
  truncated: boolean;
  receivedChars: number;
}

interface TaskViewState {
  task: Task | null;
  /** A PTY runtime backs this view; dormant views are read-only until resumed. */
  live: boolean;
  report: RuntimeReportV1 | null;
  artifacts: ArtifactCandidate[];
  selectedArtifactPath: string | null;
  pendingApproval: ApprovalDetectedEvent["payload"] | null;
  highlightedRunId: string | null;
  liveTranscriptRunId: string | null;
  runTranscripts: RunTranscript[];
  transcriptBlocks: Map<string, TranscriptBlock>;
  transcriptBlockOrder: string[];
  transcriptSources: TranscriptSourceRef[];
  terminalBuffer: string;
  runtimeReady: boolean;
  composerObserved: boolean;
  deliveryState: DeliveryTaskState | null;
  pendingAttachments: ComposerAttachment[];
  usageSnapshot: UsageSnapshot | null;
  workingStatus: WorkingStatusState | null;
  status: string;
  unread: boolean;
}

interface ReadingTurn {
  key: string;
  runId: string | null;
  run: RuntimeRunReport | null;
  blocks: TranscriptBlock[];
  fallbackText: string | null;
  tsMs: number;
}

interface RendererState {
  taskViews: TaskViewState[];
  activeTaskId: string | null;
  previewTabs: PreviewWindowTab[];
  taskDraft: TaskLaunchDraft;
  terminalOpen: boolean;
  composerMenu: ComposerMenuState | null;
  usagePopover: UsagePopoverState | null;
  readingSettings: ReadingSettings;
  readingPopoverOpen: boolean;
  readingPopoverAnchor: PopoverAnchor | null;
  promptNav: PromptNavState | null;
  busy: boolean;
  status: string;
}

interface PromptNavState {
  taskId: string;
  turnKey: string;
  composerSelectionStart: number;
  composerSelectionEnd: number;
}

interface ComposerMenuState {
  type: "add" | "permission" | "model";
  anchor: PopoverAnchor;
}

interface UsagePopoverState {
  pinned: boolean;
}

interface PopoverAnchor {
  left: number;
  top: number;
  width: number;
}

interface ComposerAttachment {
  attachment: DeliveryAttachment;
  previewUrl: string;
}

interface TaskLaunchDraft {
  provider: RuntimeProvider;
  cwd: string | null;
  settingsOpen: boolean;
  settingsAnchor: { left: number; top: number; width: number } | null;
  message: TaskEntryMessage | null;
  model: Record<RuntimeProvider, string | null>;
  reasoningEffort: Record<RuntimeProvider, ReasoningEffort | null>;
  speedMode: Record<RuntimeProvider, LaunchSpeedMode | null>;
}

interface TaskEntryMessage {
  tone: "info" | "error";
  text: string;
}

const readingModeQuery = window.matchMedia("(prefers-color-scheme: dark)");
let currentSystemReadingMode: ResolvedReadingMode = readingModeQuery.matches ? "dark" : "light";

const state: RendererState = {
  taskViews: [],
  activeTaskId: null,
  previewTabs: [],
  taskDraft: {
    provider: "codex",
    cwd: null,
    settingsOpen: false,
    settingsAnchor: null,
    message: null,
    model: {
      codex: "gpt-5.5",
      claude: "opus",
    },
    reasoningEffort: {
      codex: "xhigh",
      claude: "xhigh",
    },
    speedMode: {
      codex: "default",
      claude: null,
    },
  },
  terminalOpen: false,
  composerMenu: null,
  usagePopover: null,
  readingSettings: bootReadingSettingsFromDom(),
  readingPopoverOpen: false,
  readingPopoverAnchor: null,
  promptNav: null,
  busy: false,
  status: "Idle",
};

let sessionIndex: SessionIndexResponse | null = null;
let sessionIndexRefreshTimer: number | null = null;

function scheduleSessionIndexRefresh(): void {
  if (sessionIndexRefreshTimer !== null) {
    return;
  }
  sessionIndexRefreshTimer = window.setTimeout(() => {
    sessionIndexRefreshTimer = null;
    void refreshSessionIndex();
  }, 150);
}

/** The user explicitly chose (or cleared) the New Chat folder this session. */
let taskDraftFolderTouched = false;

async function refreshSessionIndex(): Promise<void> {
  try {
    // Always fetch the full record; status filtering is a view decision.
    sessionIndex = await window.duetRuntime.readSessionIndex({ includeArchived: true });
    // The boot screen IS a New Chat entry: preselect the last-used
    // folder until the user picks one themselves.
    if (
      !state.activeTaskId &&
      !taskDraftFolderTouched &&
      state.taskDraft.cwd === null &&
      sessionIndex.lastUsedFolder
    ) {
      state.taskDraft.cwd = sessionIndex.lastUsedFolder;
      render();
      return;
    }
    if (syncTaskViewsFromIndex(sessionIndex)) {
      render();
      return;
    }
    renderSidebar();
  } catch (error) {
    console.debug("session index read failed", error);
  }
}

/**
 * The index is the authoritative session record (live runtimes for live
 * sessions, manifests for dormant ones). Open views must follow it, or
 * a dormant rename updates the sidebar while the header keeps the old
 * title. Returns true when the ACTIVE view changed and needs a full
 * re-render.
 */
function syncTaskViewsFromIndex(index: SessionIndexResponse): boolean {
  const summaries = new Map<string, SessionSummary>();
  for (const project of index.projects) {
    for (const session of project.sessions) {
      summaries.set(session.task.id, session);
    }
  }
  for (const session of index.chats) {
    summaries.set(session.task.id, session);
  }

  let activeViewChanged = false;
  for (const view of state.taskViews) {
    if (!view.task) {
      continue;
    }
    const summary = summaries.get(view.task.id);
    if (!summary) {
      continue;
    }
    const incoming = summary.task;
    if (
      incoming.title !== view.task.title ||
      Boolean(incoming.archived) !== Boolean(view.task.archived)
    ) {
      view.task = { ...view.task, title: incoming.title, archived: incoming.archived ?? false };
      if (isActiveView(view)) {
        activeViewChanged = true;
      }
    }
  }
  return activeViewChanged;
}

type SidebarMenuState =
  | { kind: "session"; taskId: string; title: string; archived: boolean; anchor: DOMRect }
  | { kind: "project"; path: string; name: string; archived: boolean; anchor: DOMRect }
  | { kind: "filter"; anchor: DOMRect; openSection: FilterMenuSection | null };

type FilterMenuSection = "status" | "project" | "activity" | "group" | "sort";

let sidebarMenu: SidebarMenuState | null = null;
let renamingSessionId: string | null = null;

/** Sidebar organization preferences. View state — persisted per machine. */
interface SidebarPrefs {
  status: "active" | "archived" | "all";
  /** providerCwd of the focused project, or null for all. */
  project: string | null;
  activity: "1d" | "3d" | "7d" | "30d" | "all";
  groupBy: "project" | "date" | "none";
  sortBy: "recency" | "created" | "alphabetical";
}

const SIDEBAR_PREFS_DEFAULTS: SidebarPrefs = {
  status: "active",
  project: null,
  activity: "all",
  groupBy: "project",
  sortBy: "recency",
};
const SIDEBAR_PREFS_KEY = "duet.sidebar.prefs";

let sidebarPrefs: SidebarPrefs = loadSidebarPrefs();

function loadSidebarPrefs(): SidebarPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(SIDEBAR_PREFS_KEY) ?? "{}") as Partial<SidebarPrefs>;
    return {
      status: ["active", "archived", "all"].includes(raw.status as string)
        ? (raw.status as SidebarPrefs["status"])
        : SIDEBAR_PREFS_DEFAULTS.status,
      project: typeof raw.project === "string" ? raw.project : null,
      activity: ["1d", "3d", "7d", "30d", "all"].includes(raw.activity as string)
        ? (raw.activity as SidebarPrefs["activity"])
        : SIDEBAR_PREFS_DEFAULTS.activity,
      groupBy: ["project", "date", "none"].includes(raw.groupBy as string)
        ? (raw.groupBy as SidebarPrefs["groupBy"])
        : SIDEBAR_PREFS_DEFAULTS.groupBy,
      sortBy: ["recency", "created", "alphabetical"].includes(raw.sortBy as string)
        ? (raw.sortBy as SidebarPrefs["sortBy"])
        : SIDEBAR_PREFS_DEFAULTS.sortBy,
    };
  } catch {
    return { ...SIDEBAR_PREFS_DEFAULTS };
  }
}

function setSidebarPrefs(patch: Partial<SidebarPrefs>): void {
  sidebarPrefs = { ...sidebarPrefs, ...patch };
  try {
    localStorage.setItem(SIDEBAR_PREFS_KEY, JSON.stringify(sidebarPrefs));
  } catch {
    // View preference only.
  }
  renderSidebar();
}

function sidebarPrefsNonDefault(): boolean {
  return (
    sidebarPrefs.status !== SIDEBAR_PREFS_DEFAULTS.status ||
    sidebarPrefs.project !== SIDEBAR_PREFS_DEFAULTS.project ||
    sidebarPrefs.activity !== SIDEBAR_PREFS_DEFAULTS.activity ||
    sidebarPrefs.groupBy !== SIDEBAR_PREFS_DEFAULTS.groupBy ||
    sidebarPrefs.sortBy !== SIDEBAR_PREFS_DEFAULTS.sortBy
  );
}

function sidebarFiltersNonDefault(): boolean {
  return (
    sidebarPrefs.status !== SIDEBAR_PREFS_DEFAULTS.status ||
    sidebarPrefs.project !== SIDEBAR_PREFS_DEFAULTS.project ||
    sidebarPrefs.activity !== SIDEBAR_PREFS_DEFAULTS.activity
  );
}

function renderSidebar(): void {
  renderSidebarSections();
  renderSidebarMenu();
}

interface SidebarEntry {
  session: SessionSummary;
  /** null = auto-workspace session ("Chats"). */
  projectPath: string | null;
  projectName: string | null;
  projectArchived: boolean;
}

function sidebarEntries(index: SessionIndexResponse): SidebarEntry[] {
  const entries: SidebarEntry[] = [];
  for (const project of index.projects) {
    for (const session of project.sessions) {
      entries.push({
        session,
        projectPath: project.path,
        projectName: project.name,
        projectArchived: project.archived,
      });
    }
  }
  for (const session of index.chats) {
    entries.push({ session, projectPath: null, projectName: null, projectArchived: false });
  }
  return entries;
}

const ACTIVITY_WINDOW_MS: Record<Exclude<SidebarPrefs["activity"], "all">, number> = {
  "1d": 24 * 3_600_000,
  "3d": 3 * 24 * 3_600_000,
  "7d": 7 * 24 * 3_600_000,
  "30d": 30 * 24 * 3_600_000,
};

function applySidebarPrefs(entries: SidebarEntry[]): SidebarEntry[] {
  const prefs = sidebarPrefs;
  const now = Date.now();
  const filtered = entries.filter((entry) => {
    const archived = entry.session.archived || entry.projectArchived;
    if (prefs.status === "active" && archived) {
      return false;
    }
    if (prefs.status === "archived" && !archived) {
      return false;
    }
    if (prefs.project !== null && entry.projectPath !== prefs.project) {
      return false;
    }
    if (prefs.activity !== "all") {
      const ageMs = now - Date.parse(entry.session.lastActivityAt);
      if (!(ageMs <= ACTIVITY_WINDOW_MS[prefs.activity])) {
        return false;
      }
    }
    return true;
  });

  // Sort applies WITHIN groups; group order is fixed by the grouping
  // (projects by latest activity, date buckets chronologically).
  filtered.sort((a, b) => {
    if (prefs.sortBy === "alphabetical") {
      return a.session.task.title.localeCompare(b.session.task.title);
    }
    if (prefs.sortBy === "created") {
      return b.session.task.createdAt.localeCompare(a.session.task.createdAt);
    }
    return b.session.lastActivityAt.localeCompare(a.session.lastActivityAt);
  });
  return filtered;
}

function renderSidebarSections(): void {
  elements.sidebarList.replaceChildren();
  const index = sessionIndex;
  if (!index) {
    return;
  }

  const allEntries = sidebarEntries(index);
  const entries = applySidebarPrefs(allEntries);

  const focusedProject =
    sidebarPrefs.project !== null
      ? index.projects.find((project) => project.path === sidebarPrefs.project)
      : null;
  const headerTitle = focusedProject
    ? focusedProject.name
    : sidebarPrefs.groupBy === "project"
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

  if (focusedProject || sidebarPrefs.groupBy === "none") {
    for (const entry of entries) {
      elements.sidebarList.append(renderSidebarSessionRow(entry.session));
    }
    return;
  }

  if (sidebarPrefs.groupBy === "date") {
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
  filterButton.classList.toggle("active", sidebarPrefsNonDefault());
  filterButton.append(lucideIcon(ListFilter, 14));
  filterButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (sidebarMenu?.kind === "filter") {
      closeSidebarMenu();
      return;
    }
    sidebarMenu = {
      kind: "filter",
      anchor: (event.currentTarget as HTMLElement).getBoundingClientRect(),
      openSection: null,
    };
    renderSidebarMenu();
  });

  header.append(label, filterButton);
  return header;
}

function renderSidebarProjectGroups(entries: SidebarEntry[]): void {
  const index = sessionIndex;
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
  const buckets: Array<{ label: string; entries: SidebarEntry[] }> = [
    { label: "Today", entries: [] },
    { label: "Yesterday", entries: [] },
    { label: "This week", entries: [] },
    { label: "Older", entries: [] },
  ];
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();
  const dayMs = 24 * 3_600_000;
  for (const entry of entries) {
    const ts = Date.parse(entry.session.lastActivityAt);
    const bucket =
      ts >= todayMs ? 0 : ts >= todayMs - dayMs ? 1 : ts >= todayMs - 6 * dayMs ? 2 : 3;
    buckets[bucket]?.entries.push(entry);
  }
  for (const bucket of buckets) {
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

const COLLAPSED_PROJECTS_KEY = "duet.sidebar.collapsed-projects";

const collapsedProjects = new Set<string>(loadCollapsedProjects());

function loadCollapsedProjects(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_PROJECTS_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((path) => typeof path === "string") : [];
  } catch {
    return [];
  }
}

function toggleProjectCollapsed(path: string): void {
  if (collapsedProjects.has(path)) {
    collapsedProjects.delete(path);
  } else {
    collapsedProjects.add(path);
  }
  try {
    localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...collapsedProjects]));
  } catch {
    // View preference only.
  }
  renderSidebar();
}

function renderSidebarProject(project: ProjectGroup): HTMLElement {
  const container = document.createElement("div");
  container.className = "sidebar-project";

  const header = document.createElement("div");
  header.className = "sidebar-project-header";

  if (projectRenaming?.path === project.path) {
    header.append(renderProjectRenameInput(project.path, project.name));
    container.append(header);
    return container;
  }

  const expanded = !collapsedProjects.has(project.path);

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
    toggleProjectCollapsed(project.path);
  });
  labelButton.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openSidebarMenuForProject(project, event.currentTarget as HTMLElement);
  });

  const actions = document.createElement("span");
  actions.className = "sidebar-row-actions";
  const menuButton = sidebarIconButton(Ellipsis, `${project.name} actions`, (anchorElement) => {
    openSidebarMenuForProject(project, anchorElement);
  });
  const newChatButton = sidebarIconButton(Plus, `New chat in ${project.name}`, () => {
    startNewChat(project.path);
  });
  actions.append(menuButton, newChatButton);

  header.append(labelButton, actions);
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
  const row = document.createElement("div");
  row.className = "sidebar-session";
  row.dataset.taskId = task.id;
  row.classList.toggle("active", task.id === state.activeTaskId);
  // Distinguishes archived rows when the status filter mixes them in.
  row.classList.toggle("archived", session.archived);

  if (renamingSessionId === task.id) {
    row.append(renderSidebarRenameInput(task.id, task.title));
    return row;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = "sidebar-session-button";
  button.title = task.title;
  const title = document.createElement("span");
  title.className = "sidebar-session-title";
  title.textContent = task.title;
  button.append(title);
  button.addEventListener("click", () => {
    void selectSession(task.id);
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
      renamingSessionId = null;
      if (title && title !== currentTitle) {
        void window.duetRuntime
          .renameSession({ taskId, title })
          .catch((error) => {
            state.status = errorMessage(error);
            render();
          });
      } else {
        renderSidebar();
      }
    }
    if (event.key === "Escape") {
      event.preventDefault();
      renamingSessionId = null;
      renderSidebar();
    }
  });
  input.addEventListener("blur", () => {
    if (renamingSessionId === taskId) {
      renamingSessionId = null;
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
  if (session.liveStatus === "waiting-for-approval") {
    const dot = document.createElement("span");
    dot.className = "sidebar-session-attention";
    dot.title = "Waiting for approval";
    return dot;
  }
  if (["running", "starting", "stopping"].includes(session.liveStatus)) {
    const spinner = document.createElement("span");
    spinner.className = "sidebar-session-spinner";
    spinner.title = "Working";
    // Evidence-driven, not a bare CSS loop: the animation pauses when the
    // task's PTY goes quiet and turns amber when stall suspicion fires.
    const liveness = taskViewForId(session.task.id)?.workingStatus?.liveness ?? "fresh";
    if (liveness === "quiet") {
      spinner.classList.add("quiet");
      spinner.title = "No recent activity";
    } else if (liveness === "silent") {
      spinner.classList.add("silent");
      spinner.title = "No sign of activity — check the terminal";
    }
    spinner.append(lucideIcon(LoaderCircle, 14));
    return spinner;
  }
  return null;
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

function openSidebarMenuForSession(
  taskId: string,
  title: string,
  archived: boolean,
  anchorElement: HTMLElement,
): void {
  sidebarMenu = {
    kind: "session",
    taskId,
    title,
    archived,
    anchor: anchorElement.getBoundingClientRect(),
  };
  renderSidebarMenu();
}

function openSidebarMenuForProject(project: ProjectGroup, anchorElement: HTMLElement): void {
  sidebarMenu = {
    kind: "project",
    path: project.path,
    name: project.name,
    archived: project.archived,
    anchor: anchorElement.getBoundingClientRect(),
  };
  renderSidebarMenu();
}

function closeSidebarMenu(): void {
  if (sidebarMenu) {
    sidebarMenu = null;
    renderSidebarMenu();
  }
}

function renderSidebarMenu(): void {
  elements.sidebarMenuRoot.replaceChildren();
  const menu = sidebarMenu;
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
        renamingSessionId = menu.taskId;
        renderSidebar();
      }),
      sidebarMenuItem("Reveal in Finder", () => {
        void window.duetRuntime.revealSession({ taskId: menu.taskId });
      }),
      menu.archived
        ? sidebarMenuItem("Unarchive", () => {
            void window.duetRuntime
              .archiveSession({ taskId: menu.taskId, archived: false })
              .catch((error) => {
                state.status = errorMessage(error);
                render();
              });
          })
        : sidebarMenuItem("Archive", () => {
            void archiveSessionFromSidebar(menu.taskId);
          }),
      sidebarMenuItem("Delete", () => {
        void deleteSessionFromSidebar(menu.taskId, menu.title);
      }, "danger"),
    );
  } else {
    panel.append(
      sidebarMenuItem("New chat here", () => {
        startNewChat(menu.path);
      }),
      sidebarMenuItem("Rename project", () => {
        startProjectRename(menu.path, menu.name);
      }),
      sidebarMenuItem("Reveal in Finder", () => {
        void window.duetRuntime.revealProject({ path: menu.path });
      }),
      sidebarMenuItem(menu.archived ? "Unarchive project" : "Archive project", () => {
        void window.duetRuntime
          .archiveProject({ path: menu.path, archived: !menu.archived })
          .catch((error) => {
            state.status = errorMessage(error);
            render();
          });
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
  const projects = sessionIndex?.projects ?? [];
  const projectValueLabel =
    sidebarPrefs.project === null
      ? "All"
      : (projects.find((project) => project.path === sidebarPrefs.project)?.name ?? "1 project");

  panel.append(
    filterMenuRow(
      menu,
      "status",
      "Status",
      statusLabels[sidebarPrefs.status],
      sidebarPrefs.status !== SIDEBAR_PREFS_DEFAULTS.status,
      () =>
        (["active", "archived", "all"] as const).map((value) =>
          filterMenuOption(statusLabels[value], sidebarPrefs.status === value, () =>
            setSidebarPrefs({ status: value }),
          ),
        ),
    ),
    filterMenuRow(
      menu,
      "project",
      "Project",
      projectValueLabel,
      sidebarPrefs.project !== SIDEBAR_PREFS_DEFAULTS.project,
      () => [
        filterMenuOption("All projects", sidebarPrefs.project === null, () =>
          setSidebarPrefs({ project: null }),
        ),
        ...projects.map((project) =>
          filterMenuOption(project.name, sidebarPrefs.project === project.path, () =>
            setSidebarPrefs({ project: project.path }),
          ),
        ),
      ],
    ),
    filterMenuRow(
      menu,
      "activity",
      "Last activity",
      activityLabels[sidebarPrefs.activity],
      sidebarPrefs.activity !== SIDEBAR_PREFS_DEFAULTS.activity,
      () =>
        (["1d", "3d", "7d", "30d", "all"] as const).map((value) =>
          filterMenuOption(activityLabels[value], sidebarPrefs.activity === value, () =>
            setSidebarPrefs({ activity: value }),
          ),
        ),
    ),
    filterMenuSeparator(),
    filterMenuRow(
      menu,
      "group",
      "Group by",
      groupLabels[sidebarPrefs.groupBy],
      sidebarPrefs.groupBy !== SIDEBAR_PREFS_DEFAULTS.groupBy,
      () =>
        (["date", "project", "none"] as const).map((value) =>
          filterMenuOption(groupLabels[value], sidebarPrefs.groupBy === value, () =>
            setSidebarPrefs({ groupBy: value }),
          ),
        ),
    ),
    filterMenuRow(
      menu,
      "sort",
      "Sort by",
      sortLabels[sidebarPrefs.sortBy],
      sidebarPrefs.sortBy !== SIDEBAR_PREFS_DEFAULTS.sortBy,
      () =>
        (["alphabetical", "created", "recency"] as const).map((value) =>
          filterMenuOption(sortLabels[value], sidebarPrefs.sortBy === value, () =>
            setSidebarPrefs({ sortBy: value }),
          ),
        ),
    ),
    filterMenuSeparator(),
  );

  // Always present at the bottom; disabled when there is nothing to clear.
  const clear = sidebarMenuItem("Clear filters", () => {
    setSidebarPrefs({
      status: SIDEBAR_PREFS_DEFAULTS.status,
      project: SIDEBAR_PREFS_DEFAULTS.project,
      activity: SIDEBAR_PREFS_DEFAULTS.activity,
    });
  });
  clear.disabled = !sidebarFiltersNonDefault();
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
    if (sidebarMenu?.kind === "filter") {
      sidebarMenu = {
        ...sidebarMenu,
        openSection: sidebarMenu.openSection === section ? null : section,
      };
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

function positionSidebarMenu(panel: HTMLElement, anchor: DOMRect): void {
  panel.style.position = "fixed";
  panel.style.left = `${Math.round(anchor.left)}px`;
  panel.style.top = `${Math.round(anchor.bottom + 4)}px`;
  window.requestAnimationFrame(() => {
    const rect = panel.getBoundingClientRect();
    const overflowX = rect.right - (window.innerWidth - 8);
    if (overflowX > 0) {
      panel.style.left = `${Math.round(rect.left - overflowX)}px`;
    }
    const overflowY = rect.bottom - (window.innerHeight - 8);
    if (overflowY > 0) {
      panel.style.top = `${Math.round(anchor.top - rect.height - 4)}px`;
    }
  });
}

let projectRenaming: { path: string; currentName: string } | null = null;

function startProjectRename(path: string, currentName: string): void {
  projectRenaming = { path, currentName };
  renderSidebar();
}

function renderProjectRenameInput(path: string, currentName: string): HTMLElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "sidebar-rename-input";
  input.value = currentName;
  const finish = (commit: boolean): void => {
    const nextName = input.value.trim();
    projectRenaming = null;
    if (commit && nextName && nextName !== currentName) {
      void window.duetRuntime
        .renameProject({ path, displayName: nextName })
        .catch((error) => {
          state.status = errorMessage(error);
          render();
        });
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
    if (projectRenaming?.path === path) {
      finish(false);
    }
  });
  window.requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
  return input;
}

async function archiveSessionFromSidebar(taskId: string): Promise<void> {
  try {
    await window.duetRuntime.archiveSession({ taskId, archived: true });
    // The main process stopped the PTY; drop the local view either way.
    removeTaskViewLocally(taskId);
  } catch (error) {
    state.status = errorMessage(error);
    render();
  }
}

async function deleteSessionFromSidebar(taskId: string, title: string): Promise<void> {
  const confirmed = window.confirm(
    `Delete "${title}"?\n\nThis removes the session from Duet. The provider transcript and your working folder are kept.`,
  );
  if (!confirmed) {
    return;
  }
  try {
    await window.duetRuntime.deleteSession({ taskId });
    removeTaskViewLocally(taskId);
  } catch (error) {
    state.status = errorMessage(error);
    render();
  }
}

function removeTaskViewLocally(taskId: string): void {
  state.taskViews = state.taskViews.filter((item) => item.task?.id !== taskId);
  if (state.activeTaskId === taskId) {
    state.activeTaskId = null;
    state.usagePopover = null;
    terminal.clear();
  }
  render();
}

async function selectSession(taskId: string): Promise<void> {
  closeSidebarMenu();
  if (taskViewForId(taskId)) {
    activateTask(taskId);
    return;
  }

  // Dormant session: the read path is pure file reads — render the
  // transcript immediately, never spawn a PTY for browsing.
  state.busy = true;
  state.status = "Opening session";
  render();
  try {
    const snapshot = await window.duetRuntime.readSession({ taskId });
    const view = createTaskView(snapshot.task, snapshot.live ? "Ready" : "Idle", snapshot.live);
    view.report = snapshot.report;
    view.transcriptSources = snapshot.sources;
    for (const block of snapshot.blocks) {
      view.transcriptBlockOrder.push(block.id);
      view.transcriptBlocks.set(block.id, block);
    }
    upsertTaskView(view);
    activateTask(taskId);
  } catch (error) {
    state.status = errorMessage(error);
  } finally {
    state.busy = false;
    render();
  }
}

function startNewChat(folder?: string | null): void {
  closeSidebarMenu();
  exitPromptNav({ focusComposer: false });
  state.activeTaskId = null;
  state.usagePopover = null;
  if (folder) {
    state.taskDraft.cwd = folder;
    taskDraftFolderTouched = true;
  } else if (!taskDraftFolderTouched) {
    state.taskDraft.cwd = sessionIndex?.lastUsedFolder ?? state.taskDraft.cwd;
  }
  state.taskDraft.message = null;
  render();
  elements.promptInput.focus();
}

function formatRelativeAge(iso: string): string {
  const thenMs = Date.parse(iso);
  if (!Number.isFinite(thenMs)) {
    return "";
  }
  const deltaMs = Math.max(0, Date.now() - thenMs);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) {
    return "now";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d`;
  }
  const weeks = Math.floor(days / 7);
  if (weeks < 5) {
    return `${weeks}w`;
  }
  const months = Math.floor(days / 30);
  if (months < 12) {
    return `${months}mo`;
  }
  return `${Math.floor(days / 365)}y`;
}

function bootReadingSettingsFromDom(): ReadingSettings {
  const root = document.documentElement;
  return normalizeReadingSettings({
    theme: root.dataset.theme,
    mode: root.dataset.readingModeSetting,
    textStep: Number(root.dataset.textStep),
  });
}

const appElement = document.querySelector<HTMLDivElement>("#app");

if (!appElement) {
  throw new Error("Renderer mount point was not found.");
}

applyReadingSettings(state.readingSettings);

appElement.innerHTML = `
  <section class="shell" aria-label="Duet">
    <aside id="sidebar" class="sidebar" aria-label="Sessions">
      <div class="sidebar-top">
        <span class="chrome-mark">Duet</span>
        <button id="sidebar-new-chat" class="sidebar-new-chat" type="button" title="New chat">
          <span class="sidebar-new-chat-icon"></span><span>New chat</span>
        </button>
      </div>
      <nav id="sidebar-sections" class="sidebar-sections" aria-label="Session list">
        <div id="sidebar-list"></div>
      </nav>
    </aside>
    <div id="sidebar-resizer" class="sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="Resize sidebar" title="Drag to resize · double-click to reset"></div>
    <div class="main-pane">
    <header class="task-chrome">
      <div class="chrome-left">
        <button id="sidebar-toggle" class="chrome-icon-button" type="button" title="Toggle sidebar" aria-label="Toggle sidebar"></button>
        <h1 id="task-title" class="header-title">No active session</h1>
        <button id="session-menu-trigger" class="chrome-icon-button session-menu-trigger hidden" type="button" title="Session actions" aria-haspopup="menu" aria-label="Session actions"></button>
      </div>
      <div class="topbar-actions chrome-actions">
        <span id="runtime-status" class="status">Idle</span>
        <button
          id="reading-settings"
          class="secondary reading-settings-trigger"
          type="button"
          aria-haspopup="dialog"
          aria-expanded="false"
          title="Reading Controls"
        >Aa</button>
        <button id="open-preview-window" class="chrome-icon-button" type="button" title="Preview" aria-label="Open Preview"></button>
        <button id="open-inspector-window" class="chrome-icon-button" type="button" title="Inspector" aria-label="Open Inspector"></button>
        <button id="toggle-terminal" class="chrome-icon-button" type="button" title="Terminal" aria-label="Toggle Terminal"></button>
      </div>
    </header>
    <div id="reading-popover-root"></div>

    <section class="workspace">
      <section class="run-column" aria-label="Run reading surface">
        <div id="approval-banner" class="approval-banner hidden">
          <div class="approval-copy">
            <div class="approval-heading">
              <p class="eyebrow">Approval</p>
              <span id="approval-kind-badge" class="approval-kind-badge">Unknown</span>
            </div>
            <strong id="approval-title">Native approval requested</strong>
            <p id="approval-summary" class="approval-summary"></p>
            <div id="approval-context" class="approval-context"></div>
          </div>
          <div class="approval-actions">
            <button id="deny-approval" class="secondary" type="button">Deny</button>
            <button id="approve-session-approval" class="secondary hidden" type="button">Allow Session</button>
            <button id="approve-approval" class="primary" type="button">Approve</button>
          </div>
        </div>

        <section class="workflow-strip" aria-label="Task workflow state">
          <div class="workflow-copy">
            <p class="eyebrow">Task</p>
            <strong id="workflow-headline">Start or open a Task</strong>
          </div>
          <div id="workflow-facts" class="workflow-facts"></div>
        </section>

        <section id="artifact-strip" class="artifact-strip hidden" aria-label="Artifact candidates">
          <div class="artifact-strip-header">
            <div>
              <p class="eyebrow">Artifacts</p>
              <strong>Review in Preview</strong>
            </div>
            <button id="open-selected-preview" class="secondary" type="button">Open Preview</button>
          </div>
          <div id="artifact-list" class="artifact-list"></div>
        </section>

        <div id="run-list" class="run-list"></div>

        <section id="terminal-drawer" class="terminal-drawer hidden" aria-label="Terminal trust layer">
          <div class="terminal-drawer-header">
            <div>
              <p class="eyebrow">Terminal</p>
              <strong>Trust / debug mirror</strong>
            </div>
            <button id="close-terminal" class="secondary" type="button">Close</button>
          </div>
          <div id="terminal"></div>
        </section>

        <section id="delivery-queue" class="delivery-queue hidden" aria-label="Queued messages"></section>

        <form id="composer" class="composer">
          <textarea id="prompt-input" rows="1" placeholder="Start or open a Task"></textarea>
          <div id="attachment-strip" class="attachment-strip hidden" aria-label="Image attachments"></div>
          <div class="composer-control-row">
            <div class="composer-control-left">
              <button id="add-attachment" class="composer-icon-button" type="button" aria-label="Add photos & files">+</button>
              <button id="permission-chip" class="composer-chip hidden" type="button"></button>
            </div>
            <div class="composer-actions">
              <button id="model-chip" class="composer-chip hidden" type="button"></button>
              <button
                id="usage-indicator"
                class="usage-indicator empty"
                type="button"
                aria-label="Usage data"
                aria-haspopup="dialog"
                aria-expanded="false"
                disabled
              >
                <svg class="usage-ring" viewBox="0 0 20 20" aria-hidden="true">
                  <circle class="usage-ring-track" cx="10" cy="10" r="7.5"></circle>
                  <circle class="usage-ring-fill" cx="10" cy="10" r="7.5" pathLength="100"></circle>
                </svg>
              </button>
              <button
                id="send-prompt"
                class="primary send-button"
                type="button"
                disabled
                aria-label="Send prompt"
              >↑</button>
            </div>
          </div>
          <div id="composer-popover-root"></div>
          <input
            id="attachment-picker"
            class="hidden"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
          />
        </form>
      </section>
    </section>
    </div>
    <div id="sidebar-menu-root"></div>
  </section>
`;

const elements = {
  taskTitle: getElement<HTMLHeadingElement>("task-title"),
  runtimeStatus: getElement<HTMLSpanElement>("runtime-status"),
  readingSettings: getElement<HTMLButtonElement>("reading-settings"),
  readingPopoverRoot: getElement<HTMLDivElement>("reading-popover-root"),
  openPreviewWindow: getElement<HTMLButtonElement>("open-preview-window"),
  openInspectorWindow: getElement<HTMLButtonElement>("open-inspector-window"),
  toggleTerminal: getElement<HTMLButtonElement>("toggle-terminal"),
  sidebar: getElement<HTMLElement>("sidebar"),
  sidebarResizer: getElement<HTMLDivElement>("sidebar-resizer"),
  sidebarNewChat: getElement<HTMLButtonElement>("sidebar-new-chat"),
  sidebarList: getElement<HTMLDivElement>("sidebar-list"),
  sidebarToggle: getElement<HTMLButtonElement>("sidebar-toggle"),
  sidebarMenuRoot: getElement<HTMLDivElement>("sidebar-menu-root"),
  sessionMenuTrigger: getElement<HTMLButtonElement>("session-menu-trigger"),
  approvalBanner: getElement<HTMLDivElement>("approval-banner"),
  approvalKindBadge: getElement<HTMLSpanElement>("approval-kind-badge"),
  approvalTitle: getElement<HTMLElement>("approval-title"),
  approvalSummary: getElement<HTMLParagraphElement>("approval-summary"),
  approvalContext: getElement<HTMLDivElement>("approval-context"),
  denyApproval: getElement<HTMLButtonElement>("deny-approval"),
  approveSessionApproval: getElement<HTMLButtonElement>("approve-session-approval"),
  approveApproval: getElement<HTMLButtonElement>("approve-approval"),
  workflowHeadline: getElement<HTMLElement>("workflow-headline"),
  workflowFacts: getElement<HTMLDivElement>("workflow-facts"),
  runList: getElement<HTMLDivElement>("run-list"),
  artifactStrip: getElement<HTMLElement>("artifact-strip"),
  artifactList: getElement<HTMLDivElement>("artifact-list"),
  openSelectedPreview: getElement<HTMLButtonElement>("open-selected-preview"),
  deliveryQueue: getElement<HTMLElement>("delivery-queue"),
  composer: getElement<HTMLFormElement>("composer"),
  promptInput: getElement<HTMLTextAreaElement>("prompt-input"),
  attachmentStrip: getElement<HTMLDivElement>("attachment-strip"),
  addAttachment: getElement<HTMLButtonElement>("add-attachment"),
  attachmentPicker: getElement<HTMLInputElement>("attachment-picker"),
  permissionChip: getElement<HTMLButtonElement>("permission-chip"),
  modelChip: getElement<HTMLButtonElement>("model-chip"),
  usageIndicator: getElement<HTMLButtonElement>("usage-indicator"),
  composerPopoverRoot: getElement<HTMLDivElement>("composer-popover-root"),
  sendPrompt: getElement<HTMLButtonElement>("send-prompt"),
  terminalDrawer: getElement<HTMLElement>("terminal-drawer"),
  closeTerminal: getElement<HTMLButtonElement>("close-terminal"),
  terminal: getElement<HTMLDivElement>("terminal"),
};

const terminalFontFamily = getComputedStyle(document.documentElement)
  .getPropertyValue("--font-mono")
  .trim();

const USAGE_CONTEXT_HIGH_USED_PERCENT = 80;
const USAGE_POPOVER_OPEN_DELAY_MS = 150;
const USAGE_POPOVER_CLOSE_DELAY_MS = 180;

const terminal = new Terminal({
  convertEol: true,
  cursorBlink: false,
  fontFamily: terminalFontFamily || "SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 12,
  theme: {
    background: "#141414",
    foreground: "#f0eee7",
  },
});
const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);
terminal.open(elements.terminal);
fitTerminal();

const pendingReadyTaskIds = new Set<string>();
// Ticks the derived status row's clock without re-rendering the transcript.
window.setInterval(() => {
  elements.runList
    .querySelectorAll<HTMLElement>(".turn-status-elapsed[data-started-at]")
    .forEach((node) => {
      node.textContent = formatLiveElapsed(node.dataset.startedAt ?? null);
    });
  elements.runList
    .querySelectorAll<HTMLElement>(".turn-status-stall-elapsed[data-silent-since]")
    .forEach((node) => {
      node.textContent = formatLiveElapsed(node.dataset.silentSince ?? null);
    });
}, 1000);
const workTraceOpenByTurnKey = new Map<string, boolean>();
let transcriptRenderTimer: number | null = null;
let stickyPromptSyncFrame: number | null = null;
let composerIsComposing = false;
let lastComposerCompositionEndAt = 0;
let usagePopoverOpenTimer: number | null = null;
let usagePopoverCloseTimer: number | null = null;
const MAX_TRANSCRIPT_CHARS = 120_000;
const MAX_TRANSCRIPT_RAW_CHARS = 260_000;
const MAX_TERMINAL_BUFFER_CHARS = 80_000;
const COMPOSITION_END_SHORTCUT_GUARD_MS = 80;
const AUTO_TITLE_PLACEHOLDERS = new Set(["New Task", "Walking Skeleton Task"]);
const MODEL_OPTIONS: Record<RuntimeProvider, Array<{ label: string; value: string | null }>> = {
  codex: [
    { label: "GPT-5.5", value: "gpt-5.5" },
    { label: "GPT-5.4", value: "gpt-5.4" },
    { label: "GPT-5.4-Mini", value: "gpt-5.4-mini" },
    { label: "GPT-5.3-Codex-Spark", value: "gpt-5.3-codex-spark" },
    { label: "Native Default", value: null },
  ],
  claude: [
    { label: "Fable 5", value: "fable" },
    { label: "Opus 4.8", value: "opus" },
    { label: "Sonnet 4.6", value: "sonnet" },
    { label: "Haiku 4.5", value: "haiku" },
    { label: "Native Default", value: null },
  ],
};
const SESSION_MODEL_OPTIONS: Record<RuntimeProvider, Array<{ label: string; value: string }>> = {
  codex: MODEL_OPTIONS.codex.filter((option): option is { label: string; value: string } => Boolean(option.value)),
  claude: MODEL_OPTIONS.claude.filter((option): option is { label: string; value: string } => Boolean(option.value)),
};
const PROMPT_NAV_DOM_TASK_ID = "__active-transcript-dom__";
const REASONING_OPTIONS: Record<RuntimeProvider, Array<{ label: string; value: ReasoningEffort | null }>> = {
  codex: [
    { label: "Low", value: "low" },
    { label: "Medium", value: "medium" },
    { label: "High", value: "high" },
    { label: "Extra High", value: "xhigh" },
    { label: "Native Default", value: null },
  ],
  claude: [
    { label: "Low", value: "low" },
    { label: "Medium", value: "medium" },
    { label: "High", value: "high" },
    { label: "Extra High", value: "xhigh" },
    { label: "Max", value: "max" },
    { label: "Native Default", value: null },
  ],
};
const CODEX_PERMISSION_OPTIONS: Array<{
  label: string;
  preset: CodexPermissionPreset;
  sandbox: CodexSandboxMode;
  approval: CodexApprovalMode;
}> = [
  { label: "Ask for approval", preset: "askForApproval", sandbox: "workspace-write", approval: "on-request" },
  { label: "Approve for me", preset: "approveForMe", sandbox: "workspace-write", approval: "never" },
  { label: "Full Access", preset: "fullAccess", sandbox: "danger-full-access", approval: "never" },
];
const CLAUDE_PERMISSION_OPTIONS: Array<{ label: string; value: ClaudePermissionMode }> = [
  { label: "default", value: "default" },
  { label: "acceptEdits", value: "acceptEdits" },
  { label: "plan", value: "plan" },
];
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const SUPPORTED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

function lucideIcon(node: IconNode, size = 16): SVGElement {
  const svg = createLucideIcon(node);
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  return svg;
}

elements.sidebarToggle.append(lucideIcon(PanelLeft));
elements.sessionMenuTrigger.append(lucideIcon(Ellipsis));
elements.openPreviewWindow.append(lucideIcon(Eye));
elements.openInspectorWindow.append(lucideIcon(SearchCode));
elements.toggleTerminal.append(lucideIcon(SquareTerminal));
elements.sidebarNewChat.querySelector(".sidebar-new-chat-icon")?.append(lucideIcon(SquarePen));

const SIDEBAR_COLLAPSED_KEY = "duet.sidebar.collapsed";

function setSidebarCollapsed(collapsed: boolean): void {
  elements.sidebar.classList.toggle("collapsed", collapsed);
  elements.sidebarResizer.classList.toggle("hidden", collapsed);
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // Cosmetic state only.
  }
  window.requestAnimationFrame(fitTerminal);
}

const SIDEBAR_WIDTH_KEY = "duet.sidebar.width";
const SIDEBAR_WIDTH_DEFAULT = 236;
const SIDEBAR_WIDTH_MIN = 180;
const SIDEBAR_WIDTH_MAX = 420;

function applySidebarWidth(width: number | null): void {
  if (width === null) {
    elements.sidebar.style.removeProperty("width");
    elements.sidebar.style.removeProperty("flex-basis");
    return;
  }
  const clamped = Math.round(clamp(width, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX));
  elements.sidebar.style.width = `${clamped}px`;
  elements.sidebar.style.flexBasis = `${clamped}px`;
}

function persistSidebarWidth(width: number | null): void {
  try {
    if (width === null) {
      localStorage.removeItem(SIDEBAR_WIDTH_KEY);
    } else {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(width)));
    }
  } catch {
    // View preference only.
  }
}

try {
  const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  if (Number.isFinite(stored) && stored > 0) {
    applySidebarWidth(stored);
  }
} catch {
  // Default width stays.
}

elements.sidebarResizer.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) {
    return;
  }
  event.preventDefault();
  const resizer = event.currentTarget as HTMLElement;
  resizer.setPointerCapture(event.pointerId);
  document.body.classList.add("sidebar-resizing");
  let frame = 0;
  let lastWidth = elements.sidebar.getBoundingClientRect().width;

  const onMove = (moveEvent: PointerEvent): void => {
    lastWidth = moveEvent.clientX;
    if (frame) {
      return;
    }
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      applySidebarWidth(lastWidth);
      fitTerminal();
    });
  };
  const onUp = (): void => {
    resizer.removeEventListener("pointermove", onMove);
    resizer.removeEventListener("pointerup", onUp);
    resizer.removeEventListener("pointercancel", onUp);
    document.body.classList.remove("sidebar-resizing");
    if (frame) {
      window.cancelAnimationFrame(frame);
      frame = 0;
    }
    applySidebarWidth(lastWidth);
    persistSidebarWidth(clamp(lastWidth, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX));
    window.requestAnimationFrame(fitTerminal);
  };
  resizer.addEventListener("pointermove", onMove);
  resizer.addEventListener("pointerup", onUp);
  resizer.addEventListener("pointercancel", onUp);
});

elements.sidebarResizer.addEventListener("dblclick", () => {
  applySidebarWidth(null);
  persistSidebarWidth(null);
  window.requestAnimationFrame(fitTerminal);
});

try {
  setSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1");
} catch {
  // Default stays expanded.
}

elements.sidebarToggle.addEventListener("click", () => {
  setSidebarCollapsed(!elements.sidebar.classList.contains("collapsed"));
});

elements.sidebarNewChat.addEventListener("click", () => {
  startNewChat();
});

elements.sessionMenuTrigger.addEventListener("click", (event) => {
  event.stopPropagation();
  const view = activeTaskView();
  if (view?.task) {
    openSidebarMenuForSession(
      view.task.id,
      view.task.title,
      Boolean(view.task.archived),
      event.currentTarget as HTMLElement,
    );
  }
});

elements.openPreviewWindow.addEventListener("click", () => {
  void openFloatingPreview();
});

elements.openInspectorWindow.addEventListener("click", () => {
  void openFloatingInspector();
});

elements.toggleTerminal.addEventListener("click", () => {
  setTerminalOpen(!state.terminalOpen);
});

elements.readingSettings.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleReadingPopover(event.currentTarget as HTMLElement);
});

elements.closeTerminal.addEventListener("click", () => {
  setTerminalOpen(false);
});

elements.openSelectedPreview.addEventListener("click", () => {
  void openFloatingPreview();
});

elements.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitPrompt();
});

elements.promptInput.addEventListener("input", () => {
  renderComposerControls();
});

elements.promptInput.addEventListener("focus", () => {
  renderComposerControls();
});

elements.promptInput.addEventListener("blur", () => {
  composerIsComposing = false;
  renderComposerControls();
});

elements.promptInput.addEventListener("compositionstart", () => {
  composerIsComposing = true;
});

elements.promptInput.addEventListener("compositionend", () => {
  composerIsComposing = false;
  lastComposerCompositionEndAt = performance.now();
  renderComposerControls();
});

elements.addAttachment.addEventListener("click", (event) => {
  toggleComposerMenu("add", event.currentTarget as HTMLElement);
});

elements.attachmentPicker.addEventListener("change", () => {
  const files = Array.from(elements.attachmentPicker.files ?? []);
  elements.attachmentPicker.value = "";
  void addAttachmentFiles(files);
});

elements.composer.addEventListener("paste", (event) => {
  const files = Array.from(event.clipboardData?.files ?? []).filter(isSupportedImageFile);
  if (files.length === 0) {
    return;
  }
  event.preventDefault();
  void addAttachmentFiles(files);
});

elements.composer.addEventListener("dragover", (event) => {
  if (hasImageTransfer(event.dataTransfer)) {
    event.preventDefault();
  }
});

elements.composer.addEventListener("drop", (event) => {
  const files = Array.from(event.dataTransfer?.files ?? []).filter(isSupportedImageFile);
  if (files.length === 0) {
    return;
  }
  event.preventDefault();
  void addAttachmentFiles(files);
});

elements.permissionChip.addEventListener("click", (event) => {
  toggleComposerMenu("permission", event.currentTarget as HTMLElement);
});

elements.modelChip.addEventListener("click", (event) => {
  toggleComposerMenu("model", event.currentTarget as HTMLElement);
});

elements.usageIndicator.addEventListener("mouseenter", () => {
  scheduleUsagePopoverOpen();
});

elements.usageIndicator.addEventListener("mouseleave", () => {
  scheduleUsagePopoverClose();
});

elements.usageIndicator.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleUsagePopover();
});

elements.usageIndicator.addEventListener("focus", () => {
  if (state.usagePopover?.pinned) {
    return;
  }
  scheduleUsagePopoverOpen();
});

elements.usageIndicator.addEventListener("blur", () => {
  scheduleUsagePopoverClose();
});

elements.promptInput.addEventListener("keydown", (event) => {
  if (isComposerCompositionShortcut(event)) {
    return;
  }

  if (event.key === "Escape" && elements.promptInput.value.trim().length === 0 && hasActiveRun()) {
    event.preventDefault();
    void stopRun();
    return;
  }

  if (event.key !== "Enter" || event.shiftKey) {
    return;
  }
  if (elements.promptInput.value.trim().length === 0 && (activeTaskView()?.pendingAttachments.length ?? 0) === 0) {
    return;
  }
  event.preventDefault();
  elements.composer.requestSubmit();
});

elements.sendPrompt.addEventListener("click", () => {
  if (hasActiveRun()) {
    void stopRun();
    return;
  }
  void submitPrompt();
});

async function hydrateReadingSettings(): Promise<void> {
  try {
    const settings = normalizeReadingSettings(await window.duetRuntime.readReadingSettings());
    state.readingSettings = settings;
    applyReadingSettings(settings);
    renderReadingPopover();
  } catch (error) {
    state.status = errorMessage(error);
    render();
  }
}

function applyReadingSettings(nextSettings: ReadingSettings): void {
  const settings = normalizeReadingSettings(nextSettings);
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.dataset.mode = resolvedReadingMode(settings);
  root.dataset.readingModeSetting = settings.mode;
  root.dataset.textStep = String(settings.textStep);
}

function resolvedReadingMode(settings = state.readingSettings): ResolvedReadingMode {
  if (settings.mode === "light" || settings.mode === "dark") {
    return settings.mode;
  }
  return currentSystemReadingMode;
}

function toggleReadingPopover(anchor: HTMLElement): void {
  const willOpen = !state.readingPopoverOpen;
  state.readingPopoverOpen = willOpen;
  state.readingPopoverAnchor = willOpen ? popoverAnchorFromElement(anchor) : null;
  if (willOpen) {
    state.composerMenu = null;
    state.taskDraft.settingsOpen = false;
    state.taskDraft.settingsAnchor = null;
  }
  render();
}

function closeReadingPopover(): void {
  state.readingPopoverOpen = false;
  state.readingPopoverAnchor = null;
  renderReadingPopover();
}

function syncReadingPopoverAnchor(): void {
  state.readingPopoverAnchor = popoverAnchorFromElement(elements.readingSettings);
}

function popoverAnchorFromElement(anchor: HTMLElement): PopoverAnchor {
  const rect = anchor.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.bottom + 8,
    width: rect.width,
  };
}

function renderReadingPopover(): void {
  elements.readingSettings.classList.toggle("active", state.readingPopoverOpen);
  elements.readingSettings.setAttribute("aria-expanded", String(state.readingPopoverOpen));
  elements.readingPopoverRoot.replaceChildren();
  if (!state.readingPopoverOpen) {
    return;
  }
  elements.readingPopoverRoot.append(renderReadingSettingsPopover());
}

function renderReadingSettingsPopover(): HTMLElement {
  const popover = document.createElement("div");
  popover.className = "reading-settings-popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Reading Controls");
  positionReadingPopover(popover);
  popover.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  popover.append(
    renderReadingThemeSection(),
    renderReadingModeSection(),
    renderReadingSizeSection(),
  );
  return popover;
}

function positionReadingPopover(popover: HTMLElement): void {
  const anchor = state.readingPopoverAnchor;
  const viewportPadding = 14;
  const width = Math.min(360, window.innerWidth - viewportPadding * 2);
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
  popover.style.maxHeight = `${Math.max(260, window.innerHeight - top - viewportPadding)}px`;
}

function renderReadingThemeSection(): HTMLElement {
  const grid = document.createElement("div");
  grid.className = "reading-theme-grid";
  for (const theme of READING_THEME_IDS) {
    grid.append(renderReadingThemeCard(theme));
  }
  return readingSettingSection("Theme", grid);
}

function renderReadingThemeCard(theme: ReadingThemeId): HTMLElement {
  const selected = state.readingSettings.theme === theme;
  const button = document.createElement("button");
  button.className = "reading-theme-card";
  button.classList.toggle("selected", selected);
  button.type = "button";
  button.dataset.theme = theme;
  button.dataset.mode = resolvedReadingMode();
  button.setAttribute("aria-label", `${readingThemeLabel(theme)} theme`);
  button.setAttribute("aria-pressed", String(selected));
  button.addEventListener("click", () => {
    void persistReadingSettings({
      ...state.readingSettings,
      theme,
    });
  });

  const name = document.createElement("span");
  name.className = "reading-theme-name";
  name.textContent = readingThemeLabel(theme);

  const sample = document.createElement("span");
  sample.className = "reading-theme-sample";
  sample.textContent = "Aa";

  const lines = document.createElement("span");
  lines.className = "reading-theme-lines";
  lines.append(document.createElement("i"), document.createElement("i"));

  const current = document.createElement("span");
  current.className = "reading-theme-current";
  current.textContent = selected ? "current" : "";

  button.append(name, sample, lines, current);
  return button;
}

function renderReadingModeSection(): HTMLElement {
  const group = document.createElement("div");
  group.className = "reading-segmented";
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", "Mode");

  for (const mode of READING_MODE_IDS) {
    const selected = state.readingSettings.mode === mode;
    const button = document.createElement("button");
    button.className = "reading-segment";
    button.classList.toggle("selected", selected);
    button.type = "button";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(selected));
    button.textContent = readingModeLabel(mode);
    button.addEventListener("click", () => {
      void persistReadingSettings({
        ...state.readingSettings,
        mode,
      });
    });
    group.append(button);
  }

  return readingSettingSection("Mode", group);
}

function renderReadingSizeSection(): HTMLElement {
  const stepper = document.createElement("div");
  stepper.className = "reading-size-stepper";
  const currentIndex = READING_TEXT_STEPS.indexOf(state.readingSettings.textStep);
  const previous = currentIndex > 0 ? READING_TEXT_STEPS[currentIndex - 1] : undefined;
  const next = currentIndex >= 0 && currentIndex < READING_TEXT_STEPS.length - 1
    ? READING_TEXT_STEPS[currentIndex + 1]
    : undefined;

  const decrease = document.createElement("button");
  decrease.className = "reading-size-button";
  decrease.type = "button";
  decrease.disabled = previous === undefined;
  decrease.setAttribute("aria-label", "Decrease text size");
  decrease.textContent = "A-";
  decrease.addEventListener("click", () => {
    if (isReadingTextStep(previous)) {
      void persistReadingSettings({
        ...state.readingSettings,
        textStep: previous,
      });
    }
  });

  const value = document.createElement("strong");
  value.className = "reading-size-value";
  value.textContent = String(state.readingSettings.textStep);

  const increase = document.createElement("button");
  increase.className = "reading-size-button";
  increase.type = "button";
  increase.disabled = next === undefined;
  increase.setAttribute("aria-label", "Increase text size");
  increase.textContent = "A+";
  increase.addEventListener("click", () => {
    if (isReadingTextStep(next)) {
      void persistReadingSettings({
        ...state.readingSettings,
        textStep: next,
      });
    }
  });

  stepper.append(decrease, value, increase);
  return readingSettingSection("Size", stepper);
}

function readingSettingSection(label: string, content: HTMLElement): HTMLElement {
  const section = document.createElement("section");
  section.className = "reading-setting-section";
  const heading = document.createElement("p");
  heading.className = "reading-setting-heading";
  heading.textContent = label;
  section.append(heading, content);
  return section;
}

async function persistReadingSettings(nextSettings: ReadingSettings): Promise<void> {
  const settings = normalizeReadingSettings(nextSettings);
  state.readingSettings = settings;
  applyReadingSettings(settings);
  renderReadingPopover();

  try {
    const persisted = normalizeReadingSettings(await window.duetRuntime.writeReadingSettings(settings));
    state.readingSettings = persisted;
    applyReadingSettings(persisted);
  } catch (error) {
    state.status = errorMessage(error);
  } finally {
    render();
  }
}

function readingThemeLabel(theme: ReadingThemeId): string {
  if (theme === "paper") {
    return "Paper";
  }
  if (theme === "calm") {
    return "Calm";
  }
  if (theme === "focus") {
    return "Focus";
  }
  return "Duet";
}

function readingModeLabel(mode: ReadingModeSetting): string {
  if (mode === "light") {
    return "Light";
  }
  if (mode === "dark") {
    return "Dark";
  }
  return "Auto";
}

function handlePromptNavigationKeydown(event: KeyboardEvent): void {
  if (event.isComposing || composerIsComposing || event.keyCode === 229) {
    return;
  }

  if (state.promptNav) {
    if (hasStackedUiOpen()) {
      return;
    }
    if (isPromptNavArrow(event)) {
      event.preventDefault();
      event.stopPropagation();
      movePromptNav(event.key === "ArrowUp" ? -1 : 1);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      exitPromptNav({ focusComposer: true });
      return;
    }
    if (isPrintablePromptNavTyping(event)) {
      event.preventDefault();
      event.stopPropagation();
      exitPromptNav({ focusComposer: true, insertText: event.key });
    }
    return;
  }

  if (!isPromptNavEntryShortcut(event) || hasStackedUiOpen() || !isPromptNavEntryContext(event.target)) {
    return;
  }
  if (enterPromptNav()) {
    event.preventDefault();
    event.stopPropagation();
  }
}

function isPromptNavEntryShortcut(event: KeyboardEvent): boolean {
  return (
    event.key === "ArrowUp" &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  );
}

function isPromptNavArrow(event: KeyboardEvent): boolean {
  const arrow = event.key === "ArrowUp" || event.key === "ArrowDown";
  if (!arrow || event.ctrlKey || event.altKey || event.shiftKey) {
    return false;
  }
  return true;
}

function isPrintablePromptNavTyping(event: KeyboardEvent): boolean {
  return event.key.length === 1 && !event.metaKey && !event.ctrlKey;
}

function isPromptNavEntryContext(target: EventTarget | null): boolean {
  const node = target instanceof Node ? target : null;
  if (!node) {
    return false;
  }
  return (
    elements.composer.contains(node) ||
    elements.runList.contains(node) ||
    document.activeElement === document.body
  );
}

function hasStackedUiOpen(): boolean {
  return Boolean(state.readingPopoverOpen || state.composerMenu || state.taskDraft.settingsOpen);
}

function enterPromptNav(): boolean {
  const targets = promptNavTargets();
  const target = targets.at(-1) ?? null;
  if (!target) {
    return false;
  }
  const selection = composerSelectionSnapshot();
  state.promptNav = {
    taskId: activePromptNavTaskId(),
    turnKey: target.dataset.turnKey ?? "",
    composerSelectionStart: selection.start,
    composerSelectionEnd: selection.end,
  };
  return selectPromptNavTarget(target, { scroll: true });
}

function movePromptNav(delta: -1 | 1): void {
  const targets = promptNavTargets();
  if (targets.length === 0 || !state.promptNav) {
    exitPromptNav({ focusComposer: false });
    return;
  }

  const currentIndex = targets.findIndex((target) => target.dataset.turnKey === state.promptNav?.turnKey);
  const index = currentIndex === -1 ? targets.length - 1 : currentIndex;
  const nextIndex = index + delta;
  if (nextIndex < 0) {
    selectPromptNavTarget(targets[0], { scroll: false });
    return;
  }
  if (nextIndex >= targets.length) {
    exitPromptNav({ focusComposer: true });
    return;
  }
  selectPromptNavTarget(targets[nextIndex], { scroll: true });
}

function selectPromptNavTarget(
  target: HTMLElement | undefined,
  options: { scroll: boolean },
): boolean {
  if (!target) {
    return false;
  }
  const turnKey = target.dataset.turnKey;
  if (!turnKey) {
    return false;
  }
  const previous = state.promptNav;
  const selection = previous ?? {
    composerSelectionStart: elements.promptInput.selectionStart ?? elements.promptInput.value.length,
    composerSelectionEnd: elements.promptInput.selectionEnd ?? elements.promptInput.value.length,
  };
  state.promptNav = {
    taskId: activePromptNavTaskId(),
    turnKey,
    composerSelectionStart: selection.composerSelectionStart,
    composerSelectionEnd: selection.composerSelectionEnd,
  };
  syncPromptNavDomSelection();
  if (options.scroll) {
    target.scrollIntoView({ block: "start", inline: "nearest", behavior: "auto" });
  }
  target.focus({ preventScroll: true });
  return true;
}

function exitPromptNav(options: { focusComposer: boolean; insertText?: string }): void {
  const previous = state.promptNav;
  if (!previous) {
    return;
  }
  state.promptNav = null;
  syncPromptNavDomSelection();
  if (!options.focusComposer) {
    return;
  }
  focusComposerFromPromptNav(previous);
  if (options.insertText !== undefined) {
    insertTextIntoComposer(options.insertText);
  }
}

function focusComposerFromPromptNav(nav: PromptNavState): void {
  if (elements.promptInput.disabled) {
    return;
  }
  elements.promptInput.focus({ preventScroll: true });
  const start = clamp(nav.composerSelectionStart, 0, elements.promptInput.value.length);
  const end = clamp(nav.composerSelectionEnd, start, elements.promptInput.value.length);
  elements.promptInput.setSelectionRange(start, end);
}

function insertTextIntoComposer(text: string): void {
  if (elements.promptInput.disabled) {
    return;
  }
  const start = elements.promptInput.selectionStart ?? elements.promptInput.value.length;
  const end = elements.promptInput.selectionEnd ?? start;
  elements.promptInput.setRangeText(text, start, end, "end");
  elements.promptInput.dispatchEvent(new Event("input", { bubbles: true }));
}

function restorePromptNavAfterRender(): void {
  const nav = state.promptNav;
  if (!nav) {
    return;
  }
  if (nav.taskId !== activePromptNavTaskId()) {
    state.promptNav = null;
    return;
  }
  const target = findPromptNavTarget(nav.turnKey);
  if (!target) {
    state.promptNav = null;
    return;
  }
  syncPromptNavDomSelection();
  target.focus({ preventScroll: true });
}

function syncPromptNavDomSelection(): void {
  const nav = state.promptNav;
  for (const target of promptNavTargets()) {
    const selected =
      nav !== null &&
      nav.taskId === activePromptNavTaskId() &&
      target.dataset.turnKey === nav.turnKey;
    target.classList.toggle("prompt-nav-selected", selected);
    if (selected) {
      target.setAttribute("aria-current", "true");
    } else {
      target.removeAttribute("aria-current");
    }
  }
}

function promptNavTargets(): HTMLElement[] {
  return Array.from(elements.runList.querySelectorAll<HTMLElement>(".turn-prompt"));
}

function findPromptNavTarget(turnKey: string): HTMLElement | null {
  return promptNavTargets().find((target) => target.dataset.turnKey === turnKey) ?? null;
}

function activePromptNavTaskId(): string {
  return state.activeTaskId ?? PROMPT_NAV_DOM_TASK_ID;
}

function composerSelectionSnapshot(): { start: number; end: number } {
  const fallback = elements.promptInput.value.length;
  return {
    start: elements.promptInput.selectionStart ?? fallback,
    end: elements.promptInput.selectionEnd ?? fallback,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function scheduleStickyPromptSync(): void {
  if (stickyPromptSyncFrame !== null) {
    return;
  }
  stickyPromptSyncFrame = window.requestAnimationFrame(() => {
    stickyPromptSyncFrame = null;
    syncStickyPromptHeader();
  });
}

function syncStickyPromptHeader(): void {
  const header = elements.runList.querySelector<HTMLButtonElement>(".sticky-prompt-header");
  if (!header) {
    return;
  }
  const candidate = stickyPromptCandidate();
  if (!candidate) {
    hideStickyPromptHeader(header);
    return;
  }

  const listRect = elements.runList.getBoundingClientRect();
  const promptRect = candidate.prompt.getBoundingClientRect();
  if (promptRect.bottom > listRect.top) {
    hideStickyPromptHeader(header);
    return;
  }

  const text = condensedPromptText(candidate.prompt.textContent ?? "");
  header.textContent = text;
  header.title = text;
  header.dataset.turnKey = candidate.card.dataset.turnKey ?? "";
  header.classList.remove("hidden");
}

function hideStickyPromptHeader(header: HTMLButtonElement): void {
  header.classList.add("hidden");
  header.textContent = "";
  header.title = "";
  delete header.dataset.turnKey;
}

function stickyPromptCandidate(): { card: HTMLElement; prompt: HTMLElement } | null {
  const listRect = elements.runList.getBoundingClientRect();
  if (listRect.height <= 0) {
    return null;
  }
  const eyeY = listRect.top + Math.min(96, listRect.height * 0.28);
  const cards = Array.from(elements.runList.querySelectorAll<HTMLElement>(".turn-card"));

  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (rect.top <= eyeY && rect.bottom > eyeY) {
      const prompt = card.querySelector<HTMLElement>(".turn-prompt");
      return prompt ? { card, prompt } : null;
    }
  }

  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (rect.top < listRect.bottom && rect.bottom > listRect.top) {
      const prompt = card.querySelector<HTMLElement>(".turn-prompt");
      if (prompt && prompt.getBoundingClientRect().bottom <= listRect.top) {
        return { card, prompt };
      }
    }
  }

  return null;
}

function scrollToPromptTurn(turnKey: string): void {
  const target = findPromptNavTarget(turnKey);
  target?.scrollIntoView({ block: "start", inline: "nearest", behavior: "auto" });
  scheduleStickyPromptSync();
}

function condensedPromptText(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed || "(empty prompt)";
}

elements.runList.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const anchor = target.closest("a[href]");
  if (!anchor) {
    return;
  }
  event.preventDefault();
  const href = anchor.getAttribute("href") ?? "";
  if (/^https?:\/\//i.test(href)) {
    window.open(href);
  }
});

elements.runList.addEventListener("scroll", () => {
  scheduleStickyPromptSync();
});

elements.runList.addEventListener(
  "toggle",
  () => {
    scheduleStickyPromptSync();
  },
  true,
);

elements.approveApproval.addEventListener("click", () => {
  void decideApproval("approve");
});

elements.approveSessionApproval.addEventListener("click", () => {
  void decideApproval("approve-for-session");
});

elements.denyApproval.addEventListener("click", () => {
  void decideApproval("deny");
});

window.addEventListener("resize", () => {
  fitTerminal();
  if (state.readingPopoverOpen) {
    syncReadingPopoverAnchor();
    renderReadingPopover();
  }
  scheduleStickyPromptSync();
});

document.addEventListener("keydown", handlePromptNavigationKeydown, true);

document.addEventListener(
  "mousedown",
  () => {
    if (!state.promptNav) {
      return;
    }
    exitPromptNav({ focusComposer: false });
  },
  true,
);

document.addEventListener("click", (event) => {
  const target = event.target;
  if (
    !(target instanceof Element) ||
    target.closest(".reading-settings-trigger") ||
    target.closest(".reading-settings-popover") ||
    target.closest(".task-settings-wrap") ||
    target.closest(".composer-chip") ||
    target.closest(".composer-menu") ||
    target.closest(".usage-indicator") ||
    target.closest(".usage-popover")
  ) {
    return;
  }
  if (state.composerMenu) {
    state.composerMenu = null;
    render();
  }
  if (state.taskDraft.settingsOpen) {
    state.taskDraft.settingsOpen = false;
    state.taskDraft.settingsAnchor = null;
    render();
  }
  if (state.readingPopoverOpen) {
    closeReadingPopover();
  }
  if (state.usagePopover) {
    closeUsagePopover();
  }
  if (sidebarMenu && !target.closest(".sidebar-menu")) {
    closeSidebarMenu();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") {
    return;
  }
  if (state.readingPopoverOpen) {
    event.preventDefault();
    closeReadingPopover();
    elements.readingSettings.focus();
    return;
  }
  if (state.usagePopover) {
    event.preventDefault();
    closeUsagePopover();
    elements.usageIndicator.focus();
  }
});

readingModeQuery.addEventListener("change", () => {
  applySystemReadingMode(readingModeQuery.matches ? "dark" : "light");
});

window.duetRuntime.onReadingSystemModeChanged((mode) => {
  applySystemReadingMode(mode);
});

function applySystemReadingMode(mode: ResolvedReadingMode): void {
  currentSystemReadingMode = mode;
  if (state.readingSettings.mode !== "auto") {
    return;
  }
  applyReadingSettings(state.readingSettings);
  renderReadingPopover();
}

window.duetRuntime.onRuntimeEvent((event) => {
  if (event.type === "pty:data") {
    const view = taskViewForId(event.payload.taskId);
    if (!view) {
      return;
    }
    appendTerminalBuffer(view, event.payload.data);
    if (isActiveView(view)) {
      terminal.write(event.payload.data);
    }
    appendLiveTranscript(view, event.payload.data);
    return;
  }

  if (event.type === "sessions:updated") {
    scheduleSessionIndexRefresh();
    return;
  }

  const view = taskViewForId(event.payload.taskId);
  if (!view) {
    if (event.type === "task:ready") {
      pendingReadyTaskIds.add(event.payload.taskId);
    }
    return;
  }

  if (event.type === "run:started") {
    updateTaskTitleFromRun(view, event.payload.title);
    view.liveTranscriptRunId = event.payload.id;
    view.runtimeReady = false;
    view.status = "Running";
    ensureRunTranscript(view, event.payload.id);
    markViewChanged(view);
    return;
  }

  if (event.type === "run:updated") {
    if (!isActiveRunStatus(event.payload.status) && view.liveTranscriptRunId === event.payload.id) {
      view.liveTranscriptRunId = null;
    }
    markViewChanged(view);
    return;
  }

  if (event.type === "approval:detected") {
    view.pendingApproval = event.payload;
    view.runtimeReady = false;
    view.status = "Waiting for approval";
    markViewChanged(view);
    return;
  }

  if (event.type === "approval:decision") {
    view.pendingApproval = null;
    view.status = event.payload.decision === "deny" ? "Approval denied" : "Approval sent";
    markViewChanged(view);
    return;
  }

  if (event.type === "delivery:state") {
    view.deliveryState = event.payload;
    view.status = deliveryStatusLabel(view, event.payload);
    markViewChanged(view);
    return;
  }

  if (event.type === "delivery:receipt") {
    view.status = event.payload.receipt.backfilled ? "Receipt backfilled" : "Delivered";
    markViewChanged(view);
    return;
  }

  if (event.type === "usage:updated") {
    view.usageSnapshot = event.payload.snapshot;
    markViewChanged(view);
    return;
  }

  if (event.type === "working-status:updated") {
    const previousLiveness = view.workingStatus?.liveness ?? "fresh";
    view.workingStatus = {
      native: event.payload.native,
      liveness: event.payload.liveness,
      silentSince: event.payload.silentSince,
      capturedAt: event.payload.capturedAt,
    };
    if (event.payload.liveness !== previousLiveness) {
      // Liveness transitions are rare and the sidebar shows them for
      // BACKGROUND sessions too. Status ticks are not unread content, so
      // this never touches the unread flag.
      if (isActiveView(view)) {
        render();
      } else {
        renderSidebar();
      }
      return;
    }
    // Native relay arrives at ~3Hz — update the live row in place; fall back
    // to a full render only when the row does not exist yet or the content
    // needs turn context (derived mode).
    if (!updateLiveStatusRowInPlace(view)) {
      markViewChanged(view);
    }
    return;
  }

  if (event.type === "task:ready") {
    view.runtimeReady = true;
    view.composerObserved = true;
    view.status = hasActiveRun(view) ? view.status : "Ready";
    markViewChanged(view);
    return;
  }

  if (event.type === "task:updated") {
    view.task = event.payload.task;
    view.status = event.payload.reason === "verified-native-control"
      ? "Settings updated"
      : taskStatusLabel(event.payload.task);
    markViewChanged(view);
    return;
  }

  if (event.type === "run:stopped") {
    view.runtimeReady = true;
    view.status = "Stopped";
    markViewChanged(view);
  }

  if (event.type === "transcript:located") {
    view.transcriptSources = [
      ...view.transcriptSources.filter(
        (source) => source.sourceId !== event.payload.source.sourceId,
      ),
      event.payload.source,
    ];
    markViewChanged(view);
    return;
  }

  if (event.type === "transcript:blocks") {
    applyTranscriptUpserts(view, event.payload);
    if (isActiveView(view)) {
      scheduleTranscriptRender();
    } else {
      view.unread = true;
    }
    return;
  }

  if (event.type === "report:updated") {
    void refreshReport(event.payload.taskId);
  }
});

window.duetRuntime.onPreviewState((previewState) => {
  state.previewTabs = previewState.tabs;
  render();
});

window.duetRuntime.onMainArtifactFocus((request) => {
  focusArtifactFromPreview(request);
});

void window.duetRuntime.readPreviewState().then((previewState) => {
  state.previewTabs = previewState.tabs;
  render();
});

void hydrateReadingSettings();
void refreshSessionIndex();

render();

function createTaskView(task: Task, status: string, live = true): TaskViewState {
  const view: TaskViewState = {
    task,
    live,
    report: null,
    artifacts: [],
    selectedArtifactPath: null,
    pendingApproval: null,
    highlightedRunId: null,
    liveTranscriptRunId: null,
    runTranscripts: [],
    transcriptBlocks: new Map(),
    transcriptBlockOrder: [],
    transcriptSources: [],
    terminalBuffer: "",
    runtimeReady: false,
    composerObserved: false,
    deliveryState: null,
    pendingAttachments: [],
    usageSnapshot: null,
    workingStatus: null,
    status,
    unread: false,
  };
  applyPendingRuntimeState(view);
  return view;
}

function applyTranscriptUpserts(
  view: TaskViewState,
  payload: TranscriptBlocksEvent["payload"],
): void {
  if (payload.reset) {
    for (const [id, block] of view.transcriptBlocks) {
      if (block.sourceId === payload.sourceId) {
        view.transcriptBlocks.delete(id);
      }
    }
    view.transcriptBlockOrder = view.transcriptBlockOrder.filter((id) =>
      view.transcriptBlocks.has(id),
    );
  }

  for (const block of payload.upserts) {
    if (!view.transcriptBlocks.has(block.id)) {
      view.transcriptBlockOrder.push(block.id);
    }
    view.transcriptBlocks.set(block.id, block);
  }
}

async function hydrateTranscript(taskId: string): Promise<void> {
  const view = taskViewForId(taskId);
  if (!view?.task) {
    return;
  }
  const response = await window.duetRuntime.readTranscript({ taskId });
  view.transcriptSources = response.sources;
  view.transcriptBlocks = new Map();
  view.transcriptBlockOrder = [];
  for (const block of response.blocks) {
    view.transcriptBlockOrder.push(block.id);
    view.transcriptBlocks.set(block.id, block);
  }
  markViewChanged(view);
}

async function hydrateUsage(taskId: string): Promise<void> {
  const view = taskViewForId(taskId);
  if (!view?.task) {
    return;
  }
  view.usageSnapshot = await window.duetRuntime.readUsage({ taskId });
  markViewChanged(view);
}

function applyPendingRuntimeState(view: TaskViewState): void {
  if (!view.task || !pendingReadyTaskIds.delete(view.task.id)) {
    return;
  }
  view.runtimeReady = true;
  view.composerObserved = true;
  view.status = hasActiveRun(view) ? view.status : "Ready";
}

function upsertTaskView(view: TaskViewState): void {
  const index = state.taskViews.findIndex((item) => item.task?.id === view.task?.id);
  if (index === -1) {
    state.taskViews = [...state.taskViews, view];
    return;
  }
  state.taskViews = state.taskViews.map((item, itemIndex) => (itemIndex === index ? view : item));
}

function activeTaskView(): TaskViewState | null {
  if (!state.activeTaskId) {
    return null;
  }
  return taskViewForId(state.activeTaskId);
}

function taskViewForId(taskId: string): TaskViewState | null {
  return state.taskViews.find((view) => view.task?.id === taskId) ?? null;
}

function activateTask(taskId: string): void {
  const view = taskViewForId(taskId);
  if (!view) {
    return;
  }
  if (state.activeTaskId !== taskId) {
    exitPromptNav({ focusComposer: false });
    state.usagePopover = null;
    clearUsagePopoverTimers();
  }
  state.activeTaskId = taskId;
  view.unread = false;
  terminal.clear();
  if (view.terminalBuffer) {
    terminal.write(view.terminalBuffer);
  }
  render();
}

function markViewChanged(view: TaskViewState): void {
  if (isActiveView(view)) {
    render();
    return;
  }
  view.unread = true;
}

function isActiveView(view: TaskViewState): boolean {
  return Boolean(view.task && view.task.id === state.activeTaskId);
}

function appendTerminalBuffer(view: TaskViewState, data: string): void {
  view.terminalBuffer = `${view.terminalBuffer}${data}`.slice(-MAX_TERMINAL_BUFFER_CHARS);
  if (!isActiveView(view)) {
    view.unread = true;
  }
}

function updateTaskTitleFromRun(view: TaskViewState, title: string): void {
  const nextTitle = title.trim();
  if (!view.task || !nextTitle || !AUTO_TITLE_PLACEHOLDERS.has(view.task.title)) {
    return;
  }
  view.task = {
    ...view.task,
    title: nextTitle,
    updatedAt: new Date().toISOString(),
  };
}

async function createTask(
  provider: RuntimeProvider,
  options: { cwd?: string | null } = {},
): Promise<void> {
  const providerName = providerLabel(provider);
  state.busy = true;
  state.status = `Starting ${providerName}`;
  state.taskDraft.settingsOpen = false;
  state.taskDraft.settingsAnchor = null;
  state.taskDraft.message = {
    tone: "info",
    text: `Starting ${providerName} Task...`,
  };
  render();

  try {
    const launchSettings = taskLaunchSettings(provider);
    const response = await window.duetRuntime.createTask({
      provider,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      model: launchSettings.model,
      reasoningEffort: launchSettings.reasoningEffort,
      speedMode: launchSettings.speedMode,
      approval: "on-request",
      sandbox: "read-only",
    });
    const view = createTaskView(response.task, `${providerName} PTY ${response.runtime.pid}`);
    upsertTaskView(view);
    activateTask(response.task.id);
    void hydrateTranscript(response.task.id);
    void hydrateUsage(response.task.id);
  } catch (error) {
    const message = errorMessage(error);
    state.status = message;
    state.taskDraft.message = {
      tone: "error",
      text: message,
    };
  } finally {
    state.busy = false;
    render();
  }
}

async function submitPrompt(): Promise<void> {
  const view = activeTaskView();
  const text = elements.promptInput.value.trim();

  if (!view) {
    // New chat: the first message creates the session.
    if (text) {
      await createSessionFromComposer(text);
    }
    return;
  }
  if (!view.task) {
    return;
  }

  const attachments = view.pendingAttachments.map((item) => item.attachment);
  if (!text && attachments.length === 0) {
    view.status = "Type a message before sending";
    render();
    return;
  }

  if (!view.live) {
    // Dormant session: lazy spawn + native resume, then queue the message.
    await resumeSessionAndSend(view, text, attachments);
    return;
  }

  view.status = "Queued";
  render();

  try {
    await window.duetRuntime.submitPrompt({ taskId: view.task.id, text, attachments });
    elements.promptInput.value = "";
    clearPendingAttachments(view);
  } catch (error) {
    view.status = errorMessage(error);
  } finally {
    render();
  }
}

async function createSessionFromComposer(text: string): Promise<void> {
  await createTask(state.taskDraft.provider, { cwd: state.taskDraft.cwd });
  const view = activeTaskView();
  if (!view?.task) {
    // Creation failed; createTask already surfaced the error.
    return;
  }
  try {
    await window.duetRuntime.submitPrompt({ taskId: view.task.id, text, attachments: [] });
    elements.promptInput.value = "";
  } catch (error) {
    view.status = errorMessage(error);
  } finally {
    render();
  }
}

async function resumeSessionAndSend(
  view: TaskViewState,
  text: string,
  attachments: DeliveryAttachment[],
): Promise<void> {
  if (!view.task) {
    return;
  }
  const taskId = view.task.id;
  state.busy = true;
  view.status = "Resuming session";
  render();
  try {
    const response = await window.duetRuntime.openTask({ taskId });
    view.task = response.task;
    view.live = true;
    view.status = response.resumedProviderSession
      ? "Resumed — your message will send when the agent is ready"
      : "Couldn't restore the agent's memory — continuing as a new session; the history above stays readable";
    applyPendingRuntimeState(view);
    await window.duetRuntime.submitPrompt({ taskId, text, attachments });
    elements.promptInput.value = "";
    clearPendingAttachments(view);
    void hydrateUsage(taskId);
  } catch (error) {
    view.status = errorMessage(error);
  } finally {
    state.busy = false;
    render();
  }
}

async function decideApproval(decision: ApprovalDecision): Promise<void> {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }

  state.busy = true;
  render();
  try {
    await window.duetRuntime.decideApproval({ taskId: view.task.id, decision });
  } catch (error) {
    view.status = errorMessage(error);
  } finally {
    state.busy = false;
    render();
  }
}

async function stopRun(): Promise<void> {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }

  view.status = "Stopped";
  render();
  try {
    await window.duetRuntime.stopRun({ taskId: view.task.id, inspectDelayMs: 6000 });
  } catch (error) {
    view.status = errorMessage(error);
  } finally {
    render();
  }
}

async function refreshReport(taskId = state.activeTaskId): Promise<void> {
  if (!taskId) {
    return;
  }
  const view = taskViewForId(taskId);
  if (!view?.task) {
    return;
  }

  view.report = await window.duetRuntime.readReport({ taskId: view.task.id });
  view.artifacts = await window.duetRuntime.listArtifacts({ taskId: view.task.id });
  if (view.composerObserved && !view.pendingApproval && !hasActiveRun(view)) {
    view.runtimeReady = true;
  }
  if (
    view.selectedArtifactPath &&
    !view.artifacts.some((artifact) => artifact.path === view.selectedArtifactPath)
  ) {
    view.selectedArtifactPath = null;
  }
  markViewChanged(view);
}

async function resizeTerminal(): Promise<void> {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }
  fitTerminal();
  await window.duetRuntime.resizeTerminal({
    taskId: view.task.id,
    cols: terminal.cols,
    rows: terminal.rows,
  });
}

function render(): void {
  const view = activeTaskView();
  elements.taskTitle.textContent = view?.task?.title ?? "New chat";
  elements.runtimeStatus.textContent = view?.status ?? state.status;
  elements.openPreviewWindow.disabled = !view?.task || state.busy;
  elements.openInspectorWindow.disabled = !view?.task || state.busy;
  elements.toggleTerminal.disabled = !view?.task || state.busy;
  elements.sessionMenuTrigger.classList.toggle("hidden", !view?.task);
  elements.sidebarNewChat.disabled = state.busy;
  renderReadingPopover();
  renderAttachmentStrip(view);
  renderComposerControls(view);
  renderComposerPopover(view);

  renderSidebar();
  renderApproval();
  renderWorkflow();
  renderRuns();
  renderArtifacts();
  renderTerminalDrawer();
  renderDeliveryQueue();
}

function renderAttachmentStrip(view = activeTaskView()): void {
  elements.attachmentStrip.replaceChildren();
  const attachments = view?.pendingAttachments ?? [];
  elements.attachmentStrip.classList.toggle("hidden", attachments.length === 0);
  if (attachments.length === 0) {
    return;
  }

  for (const item of attachments) {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    chip.title = item.attachment.originalName;

    const image = document.createElement("img");
    image.src = item.previewUrl;
    image.alt = item.attachment.originalName;

    const label = document.createElement("span");
    label.textContent = item.attachment.originalName;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachment-remove";
    remove.setAttribute("aria-label", `Remove ${item.attachment.originalName}`);
    remove.textContent = "x";
    remove.addEventListener("click", () => {
      void removePendingAttachment(item.attachment.id);
    });

    chip.append(image, label, remove);
    elements.attachmentStrip.append(chip);
  }
}

function renderComposerControls(view = activeTaskView()): void {
  const activeRun = hasActiveRun(view) || Boolean(view?.deliveryState?.activeRun);
  const pendingApproval = Boolean(view?.pendingApproval);
  const promptHasText = elements.promptInput.value.trim().length > 0;
  const hasAttachments = (view?.pendingAttachments.length ?? 0) > 0;
  const focused = document.activeElement === elements.promptInput;
  renderComposerChip(
    elements.permissionChip,
    composerChipLabel(view, "permission"),
    "permission",
    Boolean(view?.task),
  );
  renderComposerChip(
    elements.modelChip,
    composerChipLabel(view, "model"),
    "model",
    Boolean(view?.task),
  );
  renderUsageIndicator(view);
  // New-chat state (no view): the composer IS the create action — the
  // session is born from the first message, never from an empty spawn.
  const newChat = !view;
  elements.addAttachment.disabled = !view?.task || !view.live;
  elements.addAttachment.classList.toggle("active", state.composerMenu?.type === "add");
  elements.sendPrompt.disabled = state.busy || (!activeRun && !promptHasText && !hasAttachments);
  elements.sendPrompt.title = sendPromptTitle(view, activeRun, pendingApproval, promptHasText || hasAttachments);
  elements.sendPrompt.textContent = activeRun ? "■" : "↑";
  elements.sendPrompt.classList.toggle("stop-mode", activeRun);
  elements.promptInput.disabled = state.busy && !newChat;
  elements.promptInput.placeholder = composerPlaceholder(activeRun, pendingApproval);
  elements.sendPrompt.setAttribute("aria-label", sendButtonLabel(activeRun));
  elements.composer.classList.toggle("is-focused", focused);
  elements.composer.classList.toggle("is-drafting", promptHasText || hasAttachments);
  elements.composer.classList.toggle("has-attachments", hasAttachments);
  elements.composer.classList.toggle("is-idle", !newChat && !focused && !promptHasText && !hasAttachments);
}

function renderUsageIndicator(view: TaskViewState | null): void {
  const snapshot = view?.usageSnapshot ?? null;
  const context = snapshot?.context ?? null;
  const usedPercent = context ? 100 - context.remainingPercent : 0;
  const hasTask = Boolean(view?.task);
  const hasContext = Boolean(context);
  const high = hasContext && usedPercent >= USAGE_CONTEXT_HIGH_USED_PERCENT;

  elements.usageIndicator.disabled = !hasTask;
  elements.usageIndicator.classList.toggle("empty", !hasContext);
  elements.usageIndicator.classList.toggle("high", high);
  elements.usageIndicator.classList.toggle("active", Boolean(state.usagePopover));
  elements.usageIndicator.style.setProperty("--usage-ring-dashoffset", String(100 - usedPercent));
  elements.usageIndicator.ariaExpanded = String(Boolean(state.usagePopover));

  if (!hasTask) {
    elements.usageIndicator.title = "Usage data";
    elements.usageIndicator.setAttribute("aria-label", "Usage data");
    return;
  }
  if (!context) {
    elements.usageIndicator.title = "No usage data yet";
    elements.usageIndicator.setAttribute("aria-label", "No usage data yet");
    return;
  }

  const label = `${formatUsagePercent(context.remainingPercent)} context left`;
  elements.usageIndicator.title = label;
  elements.usageIndicator.setAttribute("aria-label", label);
}

function renderComposerChip(
  element: HTMLButtonElement,
  label: string | null,
  type: "permission" | "model",
  enabled: boolean,
): void {
  element.classList.toggle("hidden", !label);
  element.classList.toggle("active", state.composerMenu?.type === type);
  element.textContent = label ?? "";
  element.disabled = !enabled || !label;
  element.ariaExpanded = String(state.composerMenu?.type === type);
  if (label) {
    element.title = label;
  } else {
    element.removeAttribute("title");
  }
}

function composerChipLabel(view: TaskViewState | null, type: "permission" | "model"): string | null {
  const task = view?.task ?? null;
  const confirmed = type === "permission" ? sessionPermissionLabel(task) : sessionModelSummaryLabel(task);
  const pending = firstControlItem(view, type);
  if (!pending) {
    return confirmed;
  }
  if (pending.status === "undelivered") {
    return confirmed ? `${confirmed} (failed)` : "Failed";
  }
  return `${confirmed ?? "Default"} -> ${pending.text}`;
}

function toggleComposerMenu(type: ComposerMenuState["type"], anchor: HTMLElement): void {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }
  clearUsagePopoverTimers();
  const rect = anchor.getBoundingClientRect();
  const current = state.composerMenu;
  state.composerMenu =
    current?.type === type
      ? null
      : {
          type,
          anchor: {
            left: rect.left,
            top: rect.top,
            width: rect.width,
          },
        };
  state.usagePopover = null;
  render();
}

function scheduleUsagePopoverOpen(): void {
  clearUsagePopoverCloseTimer();
  if (usagePopoverOpenTimer !== null) {
    window.clearTimeout(usagePopoverOpenTimer);
  }
  usagePopoverOpenTimer = window.setTimeout(() => {
    usagePopoverOpenTimer = null;
    openUsagePopover(false);
  }, USAGE_POPOVER_OPEN_DELAY_MS);
}

function scheduleUsagePopoverClose(): void {
  clearUsagePopoverOpenTimer();
  if (state.usagePopover?.pinned) {
    return;
  }
  clearUsagePopoverCloseTimer();
  usagePopoverCloseTimer = window.setTimeout(() => {
    usagePopoverCloseTimer = null;
    closeUsagePopover();
  }, USAGE_POPOVER_CLOSE_DELAY_MS);
}

function toggleUsagePopover(): void {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }
  clearUsagePopoverTimers();
  if (state.usagePopover?.pinned) {
    closeUsagePopover();
    return;
  }
  openUsagePopover(true);
}

function openUsagePopover(pinned: boolean): void {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }
  const previousPinned = state.usagePopover?.pinned ?? false;
  state.composerMenu = null;
  state.usagePopover = {
    pinned: pinned || previousPinned,
  };
  render();
}

function closeUsagePopover(): void {
  clearUsagePopoverTimers();
  if (!state.usagePopover) {
    return;
  }
  state.usagePopover = null;
  render();
}

function clearUsagePopoverTimers(): void {
  clearUsagePopoverOpenTimer();
  clearUsagePopoverCloseTimer();
}

function clearUsagePopoverOpenTimer(): void {
  if (usagePopoverOpenTimer !== null) {
    window.clearTimeout(usagePopoverOpenTimer);
    usagePopoverOpenTimer = null;
  }
}

function clearUsagePopoverCloseTimer(): void {
  if (usagePopoverCloseTimer !== null) {
    window.clearTimeout(usagePopoverCloseTimer);
    usagePopoverCloseTimer = null;
  }
}

function renderComposerPopover(view = activeTaskView()): void {
  elements.composerPopoverRoot.replaceChildren();
  if (!view?.task) {
    return;
  }
  if (state.usagePopover) {
    const popover = renderUsagePopover(view);
    elements.composerPopoverRoot.append(popover);
    positionUsagePopover(popover);
    return;
  }
  if (!state.composerMenu) {
    return;
  }
  const menu = state.composerMenu.type === "add"
    ? renderAddMenu()
    : state.composerMenu.type === "permission"
      ? renderPermissionMenu(view.task)
      : renderModelMenu(view.task);
  positionComposerMenu(menu);
  elements.composerPopoverRoot.append(menu);
}

function renderUsagePopover(view: TaskViewState): HTMLElement {
  const popover = document.createElement("div");
  popover.className = "usage-popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Usage");
  popover.addEventListener("mouseenter", () => {
    clearUsagePopoverCloseTimer();
  });
  popover.addEventListener("mouseleave", () => {
    scheduleUsagePopoverClose();
  });

  const snapshot = view.usageSnapshot;
  if (!snapshot || (!snapshot.context && snapshot.limits.length === 0)) {
    const empty = document.createElement("p");
    empty.className = "usage-popover-empty";
    empty.textContent = "No usage data yet — appears after the first response";
    popover.append(empty);
    return popover;
  }

  if (snapshot.context) {
    popover.append(renderUsageContextRow(snapshot));
  }

  for (const limit of snapshot.limits) {
    popover.append(renderUsageLimitRow(limit));
  }

  const footer = document.createElement("p");
  footer.className = "usage-popover-footer";
  footer.textContent = `as of ${formatRelativeUsageTime(snapshot.capturedAt)}`;
  popover.append(footer);
  return popover;
}

function renderUsageContextRow(snapshot: UsageSnapshot): HTMLElement {
  const context = snapshot.context;
  const row = document.createElement("div");
  row.className = "usage-context-row";
  if (!context) {
    return row;
  }

  const label = document.createElement("strong");
  label.textContent = `Context — ${formatUsagePercent(context.remainingPercent)} left`;

  const meta = document.createElement("span");
  meta.textContent = `${compactTokenCount(context.usedTokens)} / ${compactTokenCount(context.windowTokens)}`;

  row.append(label, meta);
  return row;
}

function renderUsageLimitRow(limit: UsageSnapshot["limits"][number]): HTMLElement {
  const row = document.createElement("div");
  row.className = "usage-limit-row";

  const heading = document.createElement("div");
  heading.className = "usage-limit-heading";
  const label = document.createElement("strong");
  label.textContent = usageLimitDisplayLabel(limit.label);
  const value = document.createElement("span");
  value.textContent = `${formatUsagePercent(limit.remainingPercent)} left · resets ${formatRelativeUsageTime(limit.resetsAt * 1000)}`;
  heading.append(label, value);

  const bar = document.createElement("div");
  bar.className = "usage-limit-bar";
  const fill = document.createElement("div");
  fill.className = "usage-limit-bar-fill";
  fill.style.width = `${Math.max(0, Math.min(100, limit.remainingPercent))}%`;
  bar.append(fill);

  row.append(heading, bar);
  return row;
}

function renderAddMenu(): HTMLElement {
  const menu = composerMenu("Add");
  menu.append(
    composerMenuOption("Add photos & files", false, () => {
      state.composerMenu = null;
      elements.attachmentPicker.click();
      render();
    }),
  );
  return menu;
}

function renderPermissionMenu(task: Task): HTMLElement {
  const menu = composerMenu("Permission");
  if (task.provider === "codex") {
    for (const option of CODEX_PERMISSION_OPTIONS) {
      menu.append(
        composerMenuOption(option.label, sessionPermissionLabel(task) === option.label, () => {
          if (sessionPermissionLabel(task) === option.label) {
            state.composerMenu = null;
            render();
            return;
          }
          void queueControlChange({
            kind: "permission",
            label: option.label,
            codex: {
              preset: option.preset,
              sandbox: option.sandbox,
              approval: option.approval,
            },
            claude: null,
          });
        }),
      );
    }
    return menu;
  }

  for (const option of CLAUDE_PERMISSION_OPTIONS) {
    menu.append(
      composerMenuOption(option.label, task.permissionMode === option.value, () => {
        if (task.permissionMode === option.value) {
          state.composerMenu = null;
          render();
          return;
        }
        void queueControlChange({
          kind: "permission",
          label: option.label,
          codex: null,
          claude: {
            permissionMode: option.value,
          },
        });
      }),
    );
  }
  return menu;
}

function renderModelMenu(task: Task): HTMLElement {
  const menu = composerMenu("Model");
  menu.append(
    renderComposerMenuSection(
      "Reasoning",
      REASONING_OPTIONS[task.provider],
      task.reasoningEffort,
      (value) => {
        void queueControlChange(modelControlChange(task, task.model, value as ReasoningEffort | null));
      },
    ),
    renderComposerSubmenuSection(
      "Model",
      SESSION_MODEL_OPTIONS[task.provider],
      task.model,
      (value) => {
        void queueControlChange(modelControlChange(task, value, task.reasoningEffort));
      },
    ),
  );
  return menu;
}

function composerMenu(titleText: string): HTMLElement {
  const menu = document.createElement("div");
  menu.className = "composer-menu";
  menu.setAttribute("role", "menu");
  const title = document.createElement("p");
  title.className = "composer-menu-heading";
  title.textContent = titleText;
  menu.append(title);
  return menu;
}

function renderComposerMenuSection<T extends string | null>(
  label: string,
  options: Array<{ label: string; value: T }>,
  selected: T,
  onSelect: (value: T) => void,
): HTMLElement {
  const section = document.createElement("div");
  section.className = "composer-menu-section";
  const heading = document.createElement("p");
  heading.className = "composer-menu-section-heading";
  heading.textContent = label;
  section.append(heading);
  for (const option of options) {
    section.append(composerMenuOption(option.label, option.value === selected, () => onSelect(option.value)));
  }
  return section;
}

function renderComposerSubmenuSection<T extends string>(
  label: string,
  options: Array<{ label: string; value: T }>,
  selected: T | null,
  onSelect: (value: T) => void,
): HTMLElement {
  const section = document.createElement("div");
  section.className = "composer-menu-section composer-submenu-section";

  const trigger = document.createElement("button");
  trigger.className = "composer-menu-option composer-submenu-trigger";
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  trigger.textContent = label;
  const current = modelOptionLabel(options, selected) ?? "Choose";
  const meta = document.createElement("span");
  meta.textContent = `${current} >`;
  trigger.append(meta);
  trigger.addEventListener("click", (event) => {
    event.preventDefault();
  });

  const submenu = document.createElement("div");
  submenu.className = "composer-submenu";
  submenu.setAttribute("role", "menu");
  for (const option of options) {
    submenu.append(composerMenuOption(option.label, option.value === selected, () => onSelect(option.value)));
  }

  section.addEventListener("mouseenter", () => {
    trigger.setAttribute("aria-expanded", "true");
  });
  section.addEventListener("mouseleave", () => {
    trigger.setAttribute("aria-expanded", "false");
  });
  section.addEventListener("focusin", () => {
    trigger.setAttribute("aria-expanded", "true");
  });
  section.addEventListener("focusout", () => {
    trigger.setAttribute("aria-expanded", String(section.matches(":focus-within")));
  });

  section.append(trigger, submenu);
  return section;
}

function composerMenuOption(label: string, selected: boolean, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "composer-menu-option";
  button.classList.toggle("selected", selected);
  button.type = "button";
  button.setAttribute("role", "menuitemradio");
  button.ariaChecked = String(selected);
  button.textContent = label;
  if (selected) {
    const badge = document.createElement("span");
    badge.textContent = "current";
    button.append(badge);
  }
  button.addEventListener("click", onClick);
  return button;
}

function modelOptionLabel<T extends string>(
  options: Array<{ label: string; value: T }>,
  selected: T | null,
): string | null {
  return options.find((option) => option.value === selected)?.label ?? null;
}

function positionComposerMenu(menu: HTMLElement): void {
  const anchor = state.composerMenu?.anchor;
  const viewportPadding = 14;
  const width = Math.min(320, window.innerWidth - viewportPadding * 2);
  const left = anchor
    ? Math.min(
        window.innerWidth - width - viewportPadding,
        Math.max(viewportPadding, anchor.left + anchor.width - width),
      )
    : viewportPadding;
  const estimatedHeight = state.composerMenu?.type === "model" ? 360 : 190;
  const top = anchor
    ? Math.max(viewportPadding, anchor.top - estimatedHeight - 8)
    : viewportPadding;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.width = `${width}px`;
  menu.style.maxHeight = `${Math.max(180, window.innerHeight - viewportPadding * 2)}px`;
}

function positionUsagePopover(popover: HTMLElement): void {
  // Anchor geometry is read live on every render: the composer collapses and
  // expands around focus changes, so a stored anchor snapshot goes stale and
  // can drop the popover onto the indicator itself.
  const anchor = elements.usageIndicator.getBoundingClientRect();
  const viewportPadding = 14;
  const width = Math.min(320, window.innerWidth - viewportPadding * 2);
  popover.style.width = `${width}px`;
  popover.style.maxHeight = `${Math.max(180, window.innerHeight - viewportPadding * 2)}px`;
  const left = Math.min(
    window.innerWidth - width - viewportPadding,
    Math.max(viewportPadding, anchor.right - width),
  );
  const top = Math.max(viewportPadding, anchor.top - popover.offsetHeight - 8);
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

function formatUsagePercent(value: number): string {
  const clamped = Math.max(0, Math.min(100, value));
  const rounded = Math.round(clamped * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

function compactTokenCount(value: number): string {
  if (value >= 1_000_000) {
    const rounded = value / 1_000_000;
    return `${rounded >= 10 ? Math.round(rounded) : trimTrailingZero(rounded.toFixed(1))}m`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return String(Math.round(value));
}

function formatRelativeUsageTime(targetMs: number, nowMs = Date.now()): string {
  const seconds = Math.max(0, Math.round(Math.abs(nowMs - targetMs) / 1000));
  if (seconds < 45) {
    return "now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  if (hours < 24) {
    return remainderMinutes > 0 ? `${hours}h ${remainderMinutes}m` : `${hours}h`;
  }
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function usageLimitDisplayLabel(label: string): string {
  if (label === "5h") {
    return "5-hour limit";
  }
  if (label === "daily") {
    return "Daily";
  }
  if (label === "weekly") {
    return "Weekly";
  }
  if (label === "monthly") {
    return "Monthly";
  }
  return `${label} limit`;
}

function trimTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

function modelControlChange(
  task: Task,
  model: string | null,
  reasoningEffort: ReasoningEffort | null,
): DeliveryControlChange {
  return {
    kind: "model",
    label: [
      modelValueLabel(task.provider, model) ?? "Native Default",
      reasoningValueLabel(reasoningEffort) ?? "Native Default",
    ].join(" "),
    model,
    reasoningEffort,
  };
}

async function queueControlChange(change: DeliveryControlChange): Promise<void> {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }
  state.composerMenu = null;
  view.status = "Queued";
  render();
  try {
    await window.duetRuntime.setControl({ taskId: view.task.id, change });
  } catch (error) {
    view.status = errorMessage(error);
  } finally {
    render();
  }
}

async function addAttachmentFiles(files: File[]): Promise<void> {
  const view = activeTaskView();
  if (!view?.task || files.length === 0) {
    return;
  }

  const imageFiles = files.filter(isSupportedImageFile);
  if (imageFiles.length === 0) {
    view.status = "Only PNG, JPEG, GIF, and WebP images can be attached";
    render();
    return;
  }

  for (const file of imageFiles) {
    try {
      const bytes = await file.arrayBuffer();
      const attachment = await window.duetRuntime.createAttachment({
        taskId: view.task.id,
        originalName: file.name,
        mediaType: file.type,
        bytes,
      });
      view.pendingAttachments.push({
        attachment,
        previewUrl: URL.createObjectURL(file),
      });
      view.status = "Image attached";
    } catch (error) {
      view.status = errorMessage(error);
    }
  }
  render();
}

async function removePendingAttachment(attachmentId: string): Promise<void> {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }
  const index = view.pendingAttachments.findIndex((item) => item.attachment.id === attachmentId);
  if (index === -1) {
    return;
  }
  const [removed] = view.pendingAttachments.splice(index, 1);
  if (!removed) {
    return;
  }
  URL.revokeObjectURL(removed.previewUrl);
  try {
    await window.duetRuntime.deleteAttachment({
      taskId: view.task.id,
      attachmentId: removed.attachment.id,
    });
    view.status = "Image removed";
  } catch (error) {
    view.status = errorMessage(error);
  } finally {
    render();
  }
}

function clearPendingAttachments(view: TaskViewState): void {
  for (const item of view.pendingAttachments) {
    URL.revokeObjectURL(item.previewUrl);
  }
  view.pendingAttachments = [];
}

function isSupportedImageFile(file: File): boolean {
  return SUPPORTED_IMAGE_MIME_TYPES.has(file.type) || SUPPORTED_IMAGE_EXTENSIONS.has(fileExtension(file.name));
}

function hasImageTransfer(dataTransfer: DataTransfer | null): boolean {
  return Array.from(dataTransfer?.items ?? []).some(
    (item) => item.kind === "file" && SUPPORTED_IMAGE_MIME_TYPES.has(item.type),
  );
}

function fileExtension(name: string): string {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index).toLowerCase() : "";
}

function sessionPermissionLabel(task: Task | null): string | null {
  if (!task) {
    return null;
  }
  if (task.provider === "claude") {
    return task.permissionMode ?? null;
  }
  if (task.sandbox === "danger-full-access") {
    return "Full Access";
  }
  if (task.approval === "never") {
    return "Approve for me";
  }
  return "Ask for approval";
}

function sessionModelSummaryLabel(task: Task | null): string | null {
  if (!task) {
    return null;
  }
  const parts = [
    modelValueLabel(task.provider, task.model),
    reasoningValueLabel(task.reasoningEffort),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" ") : null;
}

function firstControlItem(
  view: TaskViewState | null,
  type: "permission" | "model",
): DeliveryQueueItem | null {
  return (
    view?.deliveryState?.queue.find(
      (item) => item.kind === "control" && item.control?.kind === type && item.status !== "delivered",
    ) ?? null
  );
}

function hasActiveRun(view = activeTaskView()): boolean {
  const latestRun = view?.report?.runs.at(-1);
  return isActiveRunStatus(latestRun?.status ?? "");
}

function sendPromptTitle(
  view: TaskViewState | null,
  activeRun: boolean,
  pendingApproval: boolean,
  promptHasText: boolean,
): string {
  if (!view?.task) {
    return "";
  }
  const providerName = providerLabel(view.task.provider);
  if (activeRun) {
    return `Stop ${providerName}`;
  }
  if (!promptHasText) {
    return "Type a message before sending.";
  }
  if (pendingApproval) {
    return `Queued — delivers after ${providerName} approval is resolved.`;
  }
  if (!view.runtimeReady) {
    return `${providerName} is starting — your message sends as soon as it accepts input.`;
  }
  if (view.deliveryState && !view.deliveryState.deliverable) {
    return `Queued — delivers when ${providerName} is ready.`;
  }
  return `Send to ${providerName}`;
}

function isActiveRunStatus(status: string): boolean {
  return ["active", "waiting-for-approval", "resumed-after-approval", "stopping"].includes(status);
}

function renderApproval(): void {
  const approval = activeTaskView()?.pendingApproval ?? null;
  elements.approvalBanner.classList.toggle("hidden", !approval);
  if (!approval) {
    elements.approvalBanner.removeAttribute("data-approval-kind");
    elements.approvalContext.replaceChildren();
    elements.approveSessionApproval.classList.add("hidden");
    return;
  }

  const sessionChoice =
    approval.choices?.find((choice) => choice.decision === "approve-for-session") ?? null;
  elements.approvalBanner.dataset.approvalKind = approval.kind;
  elements.approvalKindBadge.textContent = approvalKindLabel(approval.kind);
  elements.approvalTitle.textContent = approvalTitle(approval.kind);
  elements.approvalSummary.textContent = approvalSummary(approval.kind);
  elements.approveSessionApproval.classList.toggle("hidden", !sessionChoice);
  elements.approveSessionApproval.disabled = !sessionChoice;
  if (sessionChoice) {
    elements.approveSessionApproval.textContent = sessionChoice.label;
  }
  elements.approvalContext.replaceChildren(
    approvalContextItem("Source", approval.source),
    approvalContextItem("Scope", approvalScope(approval.kind)),
    approvalContextItem("Run", approval.runId ? shortId(approval.runId) : "session setup"),
    ...(approval.resurfacedAfterDecision
      ? [
          approvalContextItem(
            "Retry",
            `${approval.previousDecision ?? "decision"} did not advance native screen`,
          ),
        ]
      : []),
    approvalContextItem("Approve", "send native Enter"),
    ...(sessionChoice
      ? [approvalContextItem(sessionChoice.label, `send native ${sessionChoice.encodedAs}`)]
      : []),
    approvalContextItem("Deny", "send native Esc"),
  );
}

interface WorkflowState {
  headline: string;
  facts: string[];
  tone: "quiet" | "attention" | "action";
}

function workflowState(): WorkflowState {
  const view = activeTaskView();
  if (!view?.task) {
    return {
      headline: "Start or open a Task",
      facts: ["No provider selected"],
      tone: "action",
    };
  }

  const providerName = providerLabel(view.task.provider);
  const runs = view.report?.runs ?? [];
  const latestRun = runs.at(-1) ?? null;
  const changedFiles = latestRun?.changedFiles.length ?? 0;
  const artifactCount = view.artifacts.length;
  const baseFacts = [
    pluralize(runs.length, "Run"),
    pluralize(changedFiles, "change"),
    pluralize(artifactCount, "artifact"),
    "Terminal available",
  ];
  const deliveryItems = view.deliveryState?.queue ?? [];
  const firstDeliveryItem = deliveryItems[0] ?? null;

  if (firstDeliveryItem?.status === "undelivered") {
    return {
      headline: firstDeliveryItem.kind === "control" ? "Setting needs attention" : "Message needs attention",
      facts: [
        firstDeliveryItem.kind === "control" ? "Setting failed" : `No ${providerName} receipt`,
        ...baseFacts,
      ],
      tone: "action",
    };
  }

  if (firstDeliveryItem?.status === "delivering") {
    return {
      headline: `Delivering to ${providerName}`,
      facts: ["Waiting for receipt", ...baseFacts],
      tone: "attention",
    };
  }

  if (deliveryItems.some((item) => item.status === "queued")) {
    return {
      headline: `Queued for ${providerName}`,
      facts: [`${deliveryItems.length} waiting`, ...baseFacts],
      tone: "attention",
    };
  }

  if (view.pendingApproval) {
    return {
      headline: `${approvalKindLabel(view.pendingApproval.kind)} approval needed`,
      facts: baseFacts,
      tone: "action",
    };
  }

  if (latestRun && isActiveRunStatus(latestRun.status)) {
    return {
      headline: `${providerName} is working`,
      facts: baseFacts,
      tone: "attention",
    };
  }

  if (latestRun?.status === "stopped") {
    return {
      headline: "Stopped. Ready to continue",
      facts: baseFacts,
      tone: "action",
    };
  }

  if (artifactCount > 0) {
    return {
      headline: "Review ready",
      facts: baseFacts,
      tone: "action",
    };
  }

  if (runs.length > 0) {
    return {
      headline: "Ready to continue",
      facts: baseFacts,
      tone: "quiet",
    };
  }

  if (view.runtimeReady) {
    return {
      headline: "Ready for first Run",
      facts: baseFacts,
      tone: "quiet",
    };
  }

  if (!view.live) {
    // Dormant session: nothing is starting until the user sends a message.
    return {
      headline: "Ready to continue",
      facts: baseFacts,
      tone: "quiet",
    };
  }

  return {
    headline: `Starting ${providerName}`,
    facts: baseFacts,
    tone: "attention",
  };
}

function workflowFact(value: string): HTMLElement {
  const fact = document.createElement("span");
  fact.textContent = value;
  return fact;
}

function renderWorkflow(): void {
  const strip = elements.workflowHeadline.closest<HTMLElement>(".workflow-strip");
  // The New Chat surface speaks for itself; the workflow strip would
  // only repeat it.
  strip?.classList.toggle("hidden", !activeTaskView()?.task);
  const workflow = workflowState();
  elements.workflowHeadline.textContent = workflow.headline;
  elements.workflowFacts.replaceChildren(...workflow.facts.map(workflowFact));
  strip?.classList.toggle("quiet", workflow.tone === "quiet");
  strip?.classList.toggle("attention", workflow.tone === "attention");
  strip?.classList.toggle("action", workflow.tone === "action");
}

function renderRuns(): void {
  const runList = elements.runList;
  const nearBottom = runList.scrollHeight - runList.scrollTop - runList.clientHeight < 64;
  const previousScrollTop = runList.scrollTop;
  runList.replaceChildren(renderStickyPromptRail());

  const view = activeTaskView();
  if (!view?.task) {
    runList.append(renderTaskEntryPanel());
    finalizeReadingSurfaceRender(nearBottom, previousScrollTop);
    return;
  }

  const turns = buildReadingTurns(view);
  if (turns.length === 0) {
    const empty = document.createElement("article");
    empty.className = "empty-state";
    empty.textContent = "No Runs yet";
    runList.append(empty);
    finalizeReadingSurfaceRender(nearBottom, previousScrollTop);
    return;
  }

  for (const turn of turns) {
    runList.append(renderTurn(view, turn));
  }

  finalizeReadingSurfaceRender(nearBottom, previousScrollTop);
}

function finalizeReadingSurfaceRender(nearBottom: boolean, previousScrollTop: number): void {
  const runList = elements.runList;
  runList.scrollTop = nearBottom ? runList.scrollHeight : previousScrollTop;
  restorePromptNavAfterRender();
  scheduleStickyPromptSync();
}

function buildReadingTurns(view: TaskViewState): ReadingTurn[] {
  const runs = view.report?.runs ?? [];
  const runById = new Map(runs.map((run) => [run.runId, run]));

  const groups = new Map<string, TranscriptBlock[]>();
  for (const id of view.transcriptBlockOrder) {
    const block = view.transcriptBlocks.get(id);
    if (!block) {
      continue;
    }
    const key = `${block.sourceId}:${block.turnKey}`;
    const group = groups.get(key);
    if (group) {
      group.push(block);
    } else {
      groups.set(key, [block]);
    }
  }

  const turns: ReadingTurn[] = [];
  const matchedRunIds = new Set<string>();
  for (const [key, blocks] of groups) {
    const runId = blocks.find((block) => block.runId)?.runId ?? null;
    if (runId) {
      matchedRunIds.add(runId);
    }
    turns.push({
      key,
      runId,
      run: runId ? (runById.get(runId) ?? null) : null,
      blocks,
      fallbackText: null,
      tsMs: Date.parse(blocks[0]?.ts ?? "") || 0,
    });
  }

  for (const run of runs) {
    if (matchedRunIds.has(run.runId)) {
      continue;
    }
    turns.push({
      key: `run:${run.runId}`,
      runId: run.runId,
      run,
      blocks: [],
      fallbackText: transcriptForRun(view, run.runId)?.text.trimEnd() || null,
      tsMs: Date.parse(run.startedAt) || 0,
    });
  }

  return turns.sort((a, b) => a.tsMs - b.tsMs);
}

function renderStickyPromptRail(): HTMLElement {
  const rail = document.createElement("div");
  rail.className = "sticky-prompt-rail";

  const header = document.createElement("button");
  header.id = "sticky-prompt-header";
  header.className = "sticky-prompt-header hidden";
  header.type = "button";
  header.setAttribute("aria-label", "Scroll to the prompt for this reply");
  header.addEventListener("click", () => {
    const turnKey = header.dataset.turnKey;
    if (!turnKey) {
      return;
    }
    scrollToPromptTurn(turnKey);
  });

  rail.append(header);
  return rail;
}

function renderTurn(view: TaskViewState, turn: ReadingTurn): HTMLElement {
  const card = document.createElement("article");
  card.className = "turn-card";
  card.dataset.turnKey = turn.key;
  if (turn.runId) {
    card.dataset.runId = turn.runId;
    card.classList.toggle("highlighted", turn.runId === view.highlightedRunId);
  }

  card.append(renderTurnUser(turn));

  const workBlocks = turn.blocks.filter(isWorkTraceBlock);
  const answerBlocks = turn.blocks.filter(isAnswerBlock);
  const noAssistantOutput = turnCompletedWithoutAssistantOutput(turn);
  const liveRun = Boolean(turn.run && isActiveRunStatus(turn.run.status));
  if (turn.run && (workBlocks.length > 0 || !liveRun)) {
    card.append(renderTurnWorkTrace(turn, workBlocks, noAssistantOutput));
  }

  const body = document.createElement("div");
  body.className = "turn-body turn-answer";
  for (const block of answerBlocks) {
    body.append(renderTranscriptBlock(block));
  }
  const noAssistantErrorExcerpt = completionErrorExcerpt(turn.run);
  if (body.childElementCount === 0 && noAssistantOutput && noAssistantErrorExcerpt) {
    body.append(renderNoAssistantOutput(turn.run));
  }
  if (body.childElementCount === 0 && turn.blocks.length === 0 && turn.fallbackText) {
    body.append(renderTurnFallback(turn.fallbackText));
  }
  if (body.childElementCount === 0 && noAssistantOutput) {
    body.append(renderNoAssistantOutput(turn.run));
  }
  if (body.childElementCount > 0) {
    card.append(body);
  }

  if (liveRun && turn.run?.status !== "waiting-for-approval") {
    card.append(renderTurnStatusRow(view, turn));
  }

  if (turn.run) {
    card.append(renderTurnFooter(turn.run, turn.blocks.length > 0, noAssistantOutput));
  }
  return card;
}

function renderTurnUser(turn: ReadingTurn): HTMLElement {
  const header = document.createElement("header");
  header.className = "turn-user";
  header.dataset.turnKey = turn.key;

  const role = document.createElement("span");
  role.className = "turn-role";
  role.textContent = "You";
  header.append(role);

  const userBlock = turn.blocks.find(
    (block): block is Extract<TranscriptBlock, { kind: "user-message" }> =>
      block.kind === "user-message",
  );
  const text = userBlock?.text ?? turn.run?.prompt ?? "";

  if (userBlock?.command) {
    const chip = document.createElement("span");
    chip.className = "turn-command-chip turn-prompt";
    chip.tabIndex = -1;
    chip.dataset.turnKey = turn.key;
    chip.textContent = text || userBlock.command;
    chip.setAttribute("aria-label", `Prompt: ${chip.textContent}`);
    header.append(chip);
  } else {
    const prompt = document.createElement("div");
    prompt.className = "turn-user-text turn-prompt";
    prompt.tabIndex = -1;
    prompt.dataset.turnKey = turn.key;
    prompt.textContent = text || "(empty prompt)";
    prompt.setAttribute("aria-label", `Prompt: ${prompt.textContent}`);
    header.append(prompt);
  }
  return header;
}

function isWorkTraceBlock(
  block: TranscriptBlock,
): block is Extract<TranscriptBlock, { kind: "thinking" | "tool-call" | "plan" }> {
  return block.kind === "thinking" || block.kind === "tool-call" || block.kind === "plan";
}

function isAnswerBlock(
  block: TranscriptBlock,
): block is Extract<TranscriptBlock, { kind: "assistant-text" | "system-note" }> {
  return block.kind === "assistant-text" || block.kind === "system-note";
}

function turnCompletedWithoutAssistantOutput(turn: ReadingTurn): boolean {
  return Boolean(
    turn.run?.status === "completed" &&
      turn.run.completionSource === "terminal-idle-heuristic" &&
      !turn.blocks.some((block) => block.kind !== "user-message"),
  );
}

function renderTurnWorkTrace(
  turn: ReadingTurn,
  workBlocks: Array<Extract<TranscriptBlock, { kind: "thinking" | "tool-call" | "plan" }>>,
  noAssistantOutput: boolean,
): HTMLElement {
  const run = turn.run;
  if (!run) {
    throw new Error("Cannot render a work trace without a Run.");
  }

  const details = document.createElement("details");
  details.className = `turn-work-trace ${runTone(run, { noAssistantOutput })}`;
  const rememberedOpen = workTraceOpenByTurnKey.get(turn.key);
  details.open = rememberedOpen ?? shouldOpenWorkTraceByDefault(run);

  const summary = document.createElement("summary");
  summary.className = "turn-work-summary";
  let userRequestedToggle = false;
  summary.addEventListener("pointerdown", () => {
    userRequestedToggle = true;
  });
  summary.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      userRequestedToggle = true;
    }
  });
  details.addEventListener("toggle", () => {
    if (!userRequestedToggle) {
      return;
    }
    workTraceOpenByTurnKey.set(turn.key, details.open);
    userRequestedToggle = false;
  });

  const label = document.createElement("span");
  label.className = "turn-work-label";
  label.textContent = workTraceLabel(run, noAssistantOutput);
  summary.append(label);

  const metaItems = workTraceMeta(run, workBlocks);
  if (metaItems.length > 0) {
    const meta = document.createElement("span");
    meta.className = "turn-work-meta";
    meta.textContent = metaItems.join(" · ");
    summary.append(meta);
  }

  details.append(summary);

  const body = document.createElement("div");
  body.className = "turn-work-body";
  if (workBlocks.length > 0) {
    for (const block of workBlocks) {
      body.append(renderTranscriptBlock(block));
    }
  } else if (noAssistantOutput) {
    const note = document.createElement("div");
    note.className = "turn-system-note";
    note.textContent = `${providerLabelForRun(run)} returned to the prompt without emitting an assistant response or tool trace.`;
    body.append(note);
  } else {
    const note = document.createElement("div");
    note.className = "turn-system-note";
    note.textContent = "No structured work trace was captured for this Run.";
    body.append(note);
  }
  details.append(body);
  return details;
}

function shouldOpenWorkTraceByDefault(run: RuntimeRunReport): boolean {
  return run.status !== "completed";
}

function workTraceLabel(run: RuntimeRunReport, noAssistantOutput = false): string {
  if (isActiveRunStatus(run.status)) {
    return `${activeProviderLabel()} is working`;
  }
  if (noAssistantOutput) {
    return `No assistant reply after ${formatElapsed(run.elapsedMs)}`;
  }
  if (run.status === "completed") {
    return `Worked for ${formatElapsed(run.elapsedMs)}`;
  }
  return runOutcome(run);
}

function workTraceMeta(
  run: RuntimeRunReport,
  workBlocks: Array<Extract<TranscriptBlock, { kind: "thinking" | "tool-call" | "plan" }>>,
): string[] {
  const toolCount = workBlocks.filter((block) => block.kind === "tool-call").length;
  return [
    toolCount > 0 ? pluralize(toolCount, "action") : null,
    run.changedFiles.length > 0 ? changedFilesLabel(run.changedFiles.length) : null,
    run.approvalEvents.length > 0 ? pluralize(run.approvalEvents.length, "approval") : null,
  ].filter((item): item is string => Boolean(item));
}

function changedFilesLabel(count: number): string {
  return count === 1 ? "1 file changed" : `${count} files changed`;
}

function renderTranscriptBlock(block: TranscriptBlock): HTMLElement {
  if (block.kind === "assistant-text") {
    return markdownBody(block.markdown);
  }
  if (block.kind === "tool-call") {
    return renderToolCallBlock(block);
  }
  if (block.kind === "plan") {
    return renderPlanBlock(block);
  }
  if (block.kind === "thinking") {
    const section = document.createElement("section");
    section.className = "turn-thinking";
    section.append(runSectionLabel("Thinking"));
    const pre = document.createElement("pre");
    pre.className = "turn-thinking-text";
    pre.textContent = block.text;
    section.append(pre);
    return section;
  }
  const note = document.createElement("div");
  note.className = "turn-system-note";
  note.textContent = block.kind === "system-note" ? block.text : "";
  return note;
}

function renderTurnStatusRow(view: TaskViewState, turn: ReadingTurn): HTMLElement {
  const row = document.createElement("div");
  row.className = "turn-status-row";
  const native = view.workingStatus?.native ?? null;
  if (native) {
    renderNativeStatusContent(row, native);
  } else {
    renderDerivedStatusContent(row, turn);
  }
  applyStatusRowLiveness(row, view);
  return row;
}

// Duet's stall voice — the one thing the native UIs never say. Appears at
// "silent", self-heals without residue when evidence resumes.
function applyStatusRowLiveness(row: HTMLElement, view: TaskViewState): void {
  const liveness = view.workingStatus?.liveness ?? "fresh";
  row.classList.toggle("quiet", liveness === "quiet");
  row.classList.toggle("silent", liveness === "silent");
  row.querySelector(".turn-status-stall")?.remove();
  if (liveness !== "silent") {
    return;
  }
  const stall = document.createElement("button");
  stall.type = "button";
  stall.className = "turn-status-stall";
  const silentSince = view.workingStatus?.silentSince ?? null;
  const seconds = document.createElement("span");
  seconds.className = "turn-status-stall-elapsed";
  if (silentSince) {
    seconds.dataset.silentSince = silentSince;
  }
  seconds.textContent = formatLiveElapsed(silentSince);
  stall.append(
    document.createTextNode("No sign of activity for "),
    seconds,
    document.createTextNode(" — check the terminal"),
  );
  stall.addEventListener("click", () => {
    openTerminalDrawerFromStatus();
  });
  row.append(stall);
}

// The agent's voice: the provider's status region, verbatim. No CSS spinner —
// relay updates are the animation, so motion is evidence by construction.
function renderNativeStatusContent(row: HTMLElement, native: NativeStatusRegion): void {
  row.replaceChildren();
  row.classList.remove("derived");
  for (const trouble of native.troubleLines) {
    const line = document.createElement("div");
    line.className = "turn-status-trouble";
    line.textContent = trouble;
    row.append(line);
  }
  const status = document.createElement("div");
  status.className = "turn-status-line";
  status.textContent = native.line;
  row.append(status);
  for (const sub of native.subLines) {
    const line = document.createElement("div");
    line.className = "turn-status-sub";
    line.textContent = sub;
    row.append(line);
  }
}

// Duet's voice: visibly different styling, derived from durable signals
// (plan step, running tool) with Duet's own clock.
function renderDerivedStatusContent(row: HTMLElement, turn: ReadingTurn): void {
  row.replaceChildren();
  row.classList.add("derived");
  const line = document.createElement("div");
  line.className = "turn-status-line";
  const label = document.createElement("span");
  label.textContent = deriveCurrentStep(turn) ?? "Working";
  const elapsed = document.createElement("span");
  elapsed.className = "turn-status-elapsed";
  if (turn.run?.startedAt) {
    elapsed.dataset.startedAt = turn.run.startedAt;
  }
  elapsed.textContent = formatLiveElapsed(turn.run?.startedAt ?? null);
  line.append(label, document.createTextNode(" · "), elapsed);
  row.append(line);
}

function openTerminalDrawerFromStatus(): void {
  setTerminalOpen(true);
}

function deriveCurrentStep(turn: ReadingTurn): string | null {
  let planStep: string | null = null;
  let runningTool: string | null = null;
  for (const block of turn.blocks) {
    if (block.kind === "plan") {
      const active = block.items.find((item) => item.status === "in_progress");
      if (active) {
        planStep = active.activeLabel ?? active.text;
      }
    } else if (block.kind === "tool-call" && block.status === "running") {
      runningTool = block.summary ? `${block.toolName} — ${block.summary}` : block.toolName;
    }
  }
  return planStep ?? runningTool;
}

function updateLiveStatusRowInPlace(view: TaskViewState): boolean {
  if (!isActiveView(view)) {
    // Background task: state stored; nothing to draw until the view shows.
    return true;
  }
  const row = elements.runList.querySelector<HTMLElement>(".turn-status-row");
  if (!row) {
    return false;
  }
  const native = view.workingStatus?.native ?? null;
  if (!native) {
    // Derived content needs turn context — let the full render handle it.
    return false;
  }
  renderNativeStatusContent(row, native);
  applyStatusRowLiveness(row, view);
  return true;
}

function formatLiveElapsed(startedAt: string | null): string {
  const startedMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  if (Number.isNaN(startedMs)) {
    return "";
  }
  const totalSeconds = Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function renderPlanBlock(block: PlanBlock): HTMLElement {
  const section = document.createElement("section");
  section.className = "turn-plan";
  section.append(runSectionLabel("Plan"));
  const list = document.createElement("ul");
  list.className = "turn-plan-list";
  for (const item of block.items) {
    const row = document.createElement("li");
    row.className = `turn-plan-item ${item.status}`;
    const status = document.createElement("span");
    status.className = "turn-plan-status";
    status.textContent = item.status === "completed" ? "✓" : item.status === "in_progress" ? "…" : "○";
    const text = document.createElement("span");
    text.className = "turn-plan-text";
    text.textContent =
      item.status === "in_progress" && item.activeLabel ? item.activeLabel : item.text;
    row.append(status, text);
    list.append(row);
  }
  section.append(list);
  return section;
}

function renderToolCallBlock(block: ToolCallBlock): HTMLElement {
  const tool = document.createElement("article");
  tool.className = `turn-tool ${block.status}`;

  const summary = document.createElement("div");
  summary.className = "turn-tool-summary";
  const status = document.createElement("span");
  status.className = "turn-tool-status";
  status.textContent = block.status === "running" ? "…" : block.status === "ok" ? "✓" : "✕";
  const name = document.createElement("strong");
  name.className = "turn-tool-name";
  name.textContent = block.toolName;
  summary.append(status, name);
  if (block.summary) {
    const hint = document.createElement("span");
    hint.className = "turn-tool-hint";
    hint.textContent = block.summary;
    summary.append(hint);
  }
  if (block.durationMs !== null) {
    const duration = document.createElement("span");
    duration.className = "turn-tool-duration";
    duration.textContent = formatElapsed(block.durationMs);
    summary.append(duration);
  }
  tool.append(summary);

  const body = document.createElement("div");
  body.className = "turn-tool-body";
  body.append(
    toolDetailSection("Input", block.inputPreview, block.inputTruncated),
  );
  if (block.resultPreview !== null) {
    body.append(toolDetailSection("Result", block.resultPreview, block.resultTruncated));
  }
  tool.append(body);
  return tool;
}

function toolDetailSection(label: string, text: string, truncated: boolean): HTMLElement {
  const section = document.createElement("div");
  section.className = "turn-tool-section";
  section.append(runSectionLabel(truncated ? `${label} (truncated)` : label));
  const pre = document.createElement("pre");
  pre.className = "turn-tool-text";
  pre.textContent = text;
  section.append(pre);
  return section;
}

function renderTurnFallback(text: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "turn-fallback";
  wrap.append(runSectionLabel("Terminal approximation"));
  const pre = document.createElement("pre");
  pre.className = "turn-fallback-text";
  pre.textContent = text;
  wrap.append(pre);
  return wrap;
}

function renderNoAssistantOutput(run: RuntimeRunReport | null): HTMLElement {
  const errorExcerpt = completionErrorExcerpt(run);
  const note = document.createElement("div");
  note.className = errorExcerpt ? "turn-system-note attention" : "turn-system-note";
  if (!errorExcerpt) {
    const action = run?.kind === "slash" ? "completed the native command" : "returned to the prompt";
    note.textContent = `${providerLabelForRun(run)} ${action} without producing an assistant reply.`;
    return note;
  }

  const copy = document.createElement("div");
  copy.textContent = `${providerLabelForRun(run)} returned to the prompt without a reply. A provider/API error likely occurred.`;
  const excerpt = document.createElement("pre");
  excerpt.className = "turn-error-excerpt";
  excerpt.textContent = errorExcerpt;
  const action = document.createElement("button");
  action.className = "secondary turn-terminal-action";
  action.type = "button";
  action.textContent = "Open terminal";
  action.addEventListener("click", () => {
    setTerminalOpen(true);
  });
  note.append(copy, excerpt, action);
  return note;
}

function renderTurnFooter(
  run: RuntimeRunReport,
  hasSemanticBlocks: boolean,
  noAssistantOutput: boolean,
): HTMLElement {
  const footer = document.createElement("footer");
  footer.className = `turn-footer ${runTone(run, { noAssistantOutput })}`;

  const outcome = document.createElement("span");
  outcome.className = "turn-outcome";
  outcome.textContent = runOutcome(run, { noAssistantOutput });
  footer.append(outcome);

  const facts = document.createElement("span");
  facts.className = "turn-facts";
  const factItems = [
    formatElapsed(run.elapsedMs),
    run.changedFiles.length > 0 ? pluralize(run.changedFiles.length, "change") : null,
    run.approvalEvents.length > 0 ? pluralize(run.approvalEvents.length, "approval") : null,
    completionLabel(run),
  ].filter((item): item is string => Boolean(item));
  facts.textContent = factItems.join(" · ");
  footer.append(facts);

  if (run.artifactCandidates.length > 0) {
    const artifacts = document.createElement("span");
    artifacts.className = "turn-artifacts";
    for (const artifact of run.artifactCandidates) {
      const button = document.createElement("button");
      button.className = "artifact-link compact";
      button.type = "button";
      button.textContent = artifact.path;
      button.addEventListener("click", () => {
        void openArtifact(artifact.path);
      });
      artifacts.append(button);
    }
    footer.append(artifacts);
  }

  const provenance = document.createElement("span");
  provenance.className = "turn-provenance";
  provenance.textContent = noAssistantOutput
    ? "provider transcript (no assistant output)"
    : hasSemanticBlocks
      ? "provider transcript"
      : "terminal approximation";
  footer.append(provenance);

  return footer;
}

const markdownSanitizerConfig = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["style", "form", "input", "button"],
};

const markdownHtmlCache = new Map<string, string>();

function markdownBody(markdown: string): HTMLElement {
  const body = document.createElement("div");
  body.className = "md-body";
  let html = markdownHtmlCache.get(markdown);
  if (html === undefined) {
    html = DOMPurify.sanitize(marked.parse(markdown, { async: false }), markdownSanitizerConfig);
    markdownHtmlCache.set(markdown, html);
  }
  body.innerHTML = html;
  return body;
}

function renderTaskEntryPanel(): HTMLElement {
  const panel = document.createElement("article");
  panel.className = "task-entry-panel";

  const copy = document.createElement("div");
  copy.className = "task-entry-copy";
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "New chat";
  const title = document.createElement("h2");
  title.textContent = "What should we work on?";
  const body = document.createElement("p");
  body.className = "task-entry-body";
  body.textContent =
    "Pick the agent and folder, then type below — your first message starts the session.";
  copy.append(eyebrow, title, body);

  const controls = document.createElement("div");
  controls.className = "task-entry-controls";
  controls.append(renderProviderSegment(), renderFolderPicker(), renderLaunchSettingsControl());

  const message = renderTaskEntryMessage();
  const facts = document.createElement("div");
  facts.className = "task-entry-facts";
  facts.append(
    taskEntryFact("Provider", providerLabel(state.taskDraft.provider)),
    taskEntryFact("Model", modelSummaryLabel(state.taskDraft.provider)),
    taskEntryFact("Folder", folderSummaryLabel()),
  );

  panel.append(copy, controls);
  if (message) {
    panel.append(message);
  }
  panel.append(facts);
  return panel;
}

function renderProviderSegment(): HTMLElement {
  const segment = document.createElement("div");
  segment.className = "task-provider-segment";
  segment.setAttribute("role", "group");
  segment.ariaLabel = "Task provider";

  for (const provider of ["codex", "claude"] as const) {
    const button = document.createElement("button");
    button.id = `entry-provider-${provider}`;
    button.className = "secondary";
    button.classList.toggle("active", provider === state.taskDraft.provider);
    button.type = "button";
    button.disabled = state.busy;
    button.ariaPressed = String(provider === state.taskDraft.provider);
    button.textContent = providerLabel(provider);
    button.addEventListener("click", () => {
      state.taskDraft.provider = provider;
      state.taskDraft.message = null;
      render();
    });
    segment.append(button);
  }

  return segment;
}

function renderFolderPicker(): HTMLElement {
  const row = document.createElement("div");
  row.className = "task-folder-row";

  // Known projects are one click away; the file dialog is the fallback.
  const projects = (sessionIndex?.projects ?? []).filter((project) => !project.archived);
  for (const project of projects.slice(0, 4)) {
    if (state.taskDraft.cwd === project.path) {
      continue;
    }
    const quick = document.createElement("button");
    quick.className = "secondary task-folder-quick";
    quick.type = "button";
    quick.disabled = state.busy;
    quick.title = project.path;
    quick.textContent = project.name;
    quick.addEventListener("click", () => {
      state.taskDraft.cwd = project.path;
      taskDraftFolderTouched = true;
      state.taskDraft.message = null;
      render();
    });
    row.append(quick);
  }

  const choose = document.createElement("button");
  choose.id = "entry-choose-folder";
  choose.className = "secondary";
  choose.type = "button";
  choose.disabled = state.busy;
  choose.textContent = state.taskDraft.cwd ? folderName(state.taskDraft.cwd) : "Choose Folder";
  if (state.taskDraft.cwd) {
    choose.title = state.taskDraft.cwd;
    choose.classList.add("task-folder-selected");
  }
  choose.addEventListener("click", () => {
    void pickTaskFolder();
  });
  row.append(choose);

  if (state.taskDraft.cwd) {
    const clear = document.createElement("button");
    clear.id = "entry-clear-folder";
    clear.className = "secondary";
    clear.type = "button";
    clear.disabled = state.busy;
    clear.textContent = "Default Workspace";
    clear.addEventListener("click", () => {
      state.taskDraft.cwd = null;
      taskDraftFolderTouched = true;
      state.taskDraft.message = {
        tone: "info",
        text: "Using the default Duet workspace for new Tasks.",
      };
      render();
    });
    row.append(clear);
  }

  return row;
}

function renderLaunchSettingsControl(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "task-settings-wrap";

  const button = document.createElement("button");
  button.id = "entry-launch-settings";
  button.className = "secondary task-settings-trigger";
  button.type = "button";
  button.disabled = state.busy;
  button.ariaExpanded = String(state.taskDraft.settingsOpen);
  button.textContent = `${launchSettingsSummary(state.taskDraft.provider)} v`;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const willOpen = !state.taskDraft.settingsOpen;
    state.taskDraft.settingsOpen = willOpen;
    state.taskDraft.settingsAnchor = willOpen
      ? {
          left: rect.left,
          top: rect.bottom + 8,
          width: rect.width,
        }
      : null;
    render();
  });
  wrap.append(button);

  if (state.taskDraft.settingsOpen) {
    wrap.append(renderLaunchSettingsPopover(state.taskDraft.provider));
  }

  return wrap;
}

function renderLaunchSettingsPopover(provider: RuntimeProvider): HTMLElement {
  const popover = document.createElement("div");
  popover.className = "task-settings-popover";
  popover.setAttribute("role", "menu");
  positionLaunchSettingsPopover(popover);
  popover.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  popover.append(
    renderSettingSection("Reasoning", REASONING_OPTIONS[provider], state.taskDraft.reasoningEffort[provider], (value) => {
      state.taskDraft.reasoningEffort[provider] = value as ReasoningEffort | null;
      render();
    }),
    renderSettingSection("Model", MODEL_OPTIONS[provider], state.taskDraft.model[provider], (value) => {
      state.taskDraft.model[provider] = value;
      render();
    }),
  );

  if (provider === "codex") {
    popover.append(
      renderSettingSection(
        "Speed",
        [
          { label: "Default", value: "default" },
          { label: "Fast", value: "fast" },
        ],
        state.taskDraft.speedMode.codex,
        (value) => {
          state.taskDraft.speedMode.codex = value as LaunchSpeedMode;
          render();
        },
      ),
    );
  }

  return popover;
}

function positionLaunchSettingsPopover(popover: HTMLElement): void {
  const anchor = state.taskDraft.settingsAnchor;
  const viewportPadding = 14;
  const width = Math.min(360, window.innerWidth - viewportPadding * 2);
  const top = anchor?.top ?? viewportPadding;
  const canOpenLeft = Boolean(anchor && anchor.left - width - 12 >= viewportPadding);
  const left =
    anchor && canOpenLeft
      ? anchor.left - width - 12
      : anchor
        ? Math.min(
            window.innerWidth - width - viewportPadding,
            Math.max(viewportPadding, anchor.left + anchor.width - width),
          )
        : viewportPadding;

  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  popover.style.width = `${width}px`;
  popover.style.maxHeight = `${Math.max(220, window.innerHeight - top - viewportPadding)}px`;
}

function renderSettingSection<T extends string | null>(
  label: string,
  options: Array<{ label: string; value: T }>,
  selected: T,
  onSelect: (value: T) => void,
): HTMLElement {
  const section = document.createElement("div");
  section.className = "task-setting-section";

  const title = document.createElement("p");
  title.className = "task-setting-heading";
  title.textContent = label;
  section.append(title);

  for (const option of options) {
    const button = document.createElement("button");
    button.className = "task-setting-option";
    button.classList.toggle("selected", option.value === selected);
    button.type = "button";
    button.setAttribute("role", "menuitemradio");
    button.ariaChecked = String(option.value === selected);
    button.textContent = option.label;
    if (option.value === selected) {
      const selectedLabel = document.createElement("span");
      selectedLabel.textContent = "selected";
      button.append(selectedLabel);
    }
    button.addEventListener("click", () => {
      onSelect(option.value);
    });
    section.append(button);
  }

  return section;
}

function taskEntryFact(label: string, value: string): HTMLElement {
  const fact = document.createElement("div");
  fact.className = "task-entry-fact";
  const key = document.createElement("span");
  key.textContent = label;
  const val = document.createElement("strong");
  val.textContent = value;
  fact.append(key, val);
  return fact;
}

async function pickTaskFolder(): Promise<void> {
  state.busy = true;
  state.status = "Choosing Task Folder";
  state.taskDraft.settingsOpen = false;
  state.taskDraft.settingsAnchor = null;
  state.taskDraft.message = {
    tone: "info",
    text: "Choose the folder where this Task should run.",
  };
  render();

  try {
    const response = await window.duetRuntime.pickFolder();
    if (response.path) {
      state.taskDraft.cwd = response.path;
      taskDraftFolderTouched = true;
      state.status = `Selected ${folderName(response.path)}`;
      state.taskDraft.message = {
        tone: "info",
        text: `Selected ${folderName(response.path)}.`,
      };
    }
  } catch (error) {
    const message = errorMessage(error);
    state.status = message;
    state.taskDraft.message = {
      tone: "error",
      text: message,
    };
  } finally {
    state.busy = false;
    render();
  }
}

function renderTaskEntryMessage(): HTMLElement | null {
  if (!state.taskDraft.message) {
    return null;
  }

  const message = document.createElement("div");
  message.className = `task-entry-message ${state.taskDraft.message.tone}`;
  message.textContent = state.taskDraft.message.text;
  return message;
}

function taskLaunchSettings(provider: RuntimeProvider): {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  speedMode: LaunchSpeedMode | null;
} {
  return {
    model: state.taskDraft.model[provider],
    reasoningEffort: state.taskDraft.reasoningEffort[provider],
    speedMode: state.taskDraft.speedMode[provider],
  };
}

function launchSettingsSummary(provider: RuntimeProvider): string {
  const parts = [modelSummaryLabel(provider), reasoningSummaryLabel(provider)];
  if (provider === "codex" && state.taskDraft.speedMode.codex === "fast") {
    parts.push("Fast");
  }
  return parts.filter(Boolean).join(" ");
}

function modelSummaryLabel(provider: RuntimeProvider): string {
  return modelValueLabel(provider, state.taskDraft.model[provider]) ?? "Default";
}

function reasoningSummaryLabel(provider: RuntimeProvider): string {
  return reasoningValueLabel(state.taskDraft.reasoningEffort[provider]) ?? "Default";
}

function modelValueLabel(provider: RuntimeProvider, value: string | null): string | null {
  if (!value) {
    return null;
  }
  if (provider === "codex") {
    if (value === "gpt-5.5") {
      return "5.5";
    }
    if (value === "gpt-5.4") {
      return "5.4";
    }
    if (value === "gpt-5.4-mini") {
      return "5.4 Mini";
    }
    if (value === "gpt-5.3-codex-spark") {
      return "5.3 Spark";
    }
  }
  return MODEL_OPTIONS[provider].find((option) => option.value === value)?.label ?? value;
}

function reasoningValueLabel(value: ReasoningEffort | null): string | null {
  if (!value) {
    return null;
  }
  return (
    [...REASONING_OPTIONS.codex, ...REASONING_OPTIONS.claude].find(
      (option) => option.value === value,
    )?.label ?? value
  );
}

function folderSummaryLabel(): string {
  return state.taskDraft.cwd ? folderName(state.taskDraft.cwd) : "Duet workspace";
}

function folderName(folderPath: string): string {
  return folderPath.split(/[\\/]/).filter(Boolean).at(-1) ?? folderPath;
}

function renderArtifacts(): void {
  elements.artifactList.replaceChildren();
  const view = activeTaskView();
  const artifacts = view?.artifacts ?? [];
  elements.artifactStrip.classList.toggle("hidden", artifacts.length === 0);
  elements.openSelectedPreview.disabled = !view?.task || artifacts.length === 0;

  if (artifacts.length === 0) {
    return;
  }

  for (const artifact of artifacts) {
    const reviewState = artifactPreviewTab(artifact.taskId, artifact.path);
    const item = document.createElement("button");
    item.className = "artifact-item";
    item.type = "button";
    item.classList.toggle("selected", artifact.path === view?.selectedArtifactPath);
    item.classList.toggle("reviewed", Boolean(reviewState?.reviewed && !reviewState.dirty));
    item.classList.toggle("dirty", Boolean(reviewState?.dirty));
    const title = document.createElement("span");
    title.className = "artifact-item-title";
    title.textContent = artifact.path;
    const meta = document.createElement("span");
    meta.className = "artifact-item-meta";
    meta.textContent = `${artifactKindLabel(artifact.kind)} / ${artifact.changeKind} / ${artifactReviewLabel(
      reviewState,
    )}`;
    item.append(title, meta);
    item.addEventListener("click", () => {
      void openArtifact(artifact.path);
    });
    elements.artifactList.append(item);
  }
}

function artifactPreviewTab(taskId: string, relativePath: string): PreviewWindowTab | null {
  return state.previewTabs.find((tab) => tab.taskId === taskId && tab.path === relativePath) ?? null;
}

function artifactReviewLabel(tab: PreviewWindowTab | null): string {
  if (tab?.dirty) {
    return "Updated";
  }
  if (tab?.reviewed) {
    return "Reviewed";
  }
  return "Needs review";
}

function appendLiveTranscript(view: TaskViewState, data: string): void {
  if (!view.liveTranscriptRunId) {
    return;
  }

  const transcript = ensureRunTranscript(view, view.liveTranscriptRunId);
  transcript.receivedChars += data.length;
  const nextRawText = `${transcript.rawText}${data}`;
  transcript.truncated = transcript.truncated || nextRawText.length > MAX_TRANSCRIPT_RAW_CHARS;
  transcript.rawText = nextRawText.slice(-MAX_TRANSCRIPT_RAW_CHARS);

  const text = cleanTerminalTranscript(transcript.rawText, view.task?.provider);
  transcript.truncated = transcript.truncated || text.length > MAX_TRANSCRIPT_CHARS;
  transcript.text = text.slice(-MAX_TRANSCRIPT_CHARS);

  if (!transcript.text.trim()) {
    return;
  }
  scheduleTranscriptRender();
}

function ensureRunTranscript(view: TaskViewState, runId: string): RunTranscript {
  let transcript = view.runTranscripts.find((item) => item.runId === runId);
  if (!transcript) {
    transcript = {
      runId,
      rawText: "",
      text: "",
      truncated: false,
      receivedChars: 0,
    };
    view.runTranscripts = [...view.runTranscripts, transcript];
  }
  return transcript;
}

function transcriptForRun(view: TaskViewState, runId: string): RunTranscript | null {
  return view.runTranscripts.find((item) => item.runId === runId) ?? null;
}

function scheduleTranscriptRender(): void {
  if (transcriptRenderTimer !== null) {
    return;
  }
  transcriptRenderTimer = window.setTimeout(() => {
    transcriptRenderTimer = null;
    render();
  }, 160);
}

async function openArtifact(relativePath: string): Promise<void> {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }

  view.selectedArtifactPath = relativePath;
  render();
  await window.duetRuntime.openPreview({
    taskId: view.task.id,
    relativePath,
  });
}

async function openFloatingPreview(): Promise<void> {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }
  const relativePath = view.selectedArtifactPath ?? view.artifacts[0]?.path;

  await window.duetRuntime.openPreview({
    taskId: view.task.id,
    ...(relativePath ? { relativePath } : {}),
  });
}

async function openFloatingInspector(): Promise<void> {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }

  await window.duetRuntime.openInspector({
    taskId: view.task.id,
  });
}

function setTerminalOpen(open: boolean): void {
  state.terminalOpen = open;
  render();
  if (open) {
    queueMicrotask(() => {
      fitTerminal();
      void resizeTerminal();
    });
  }
}

function renderTerminalDrawer(): void {
  elements.terminalDrawer.classList.toggle("hidden", !state.terminalOpen);
  elements.toggleTerminal.classList.toggle("active", state.terminalOpen);
}

function renderDeliveryQueue(): void {
  elements.deliveryQueue.replaceChildren();
  const view = activeTaskView();
  const items = view?.deliveryState?.queue ?? [];
  const visibleItems = items.filter((item) => item.status !== "delivered");
  elements.deliveryQueue.classList.toggle("hidden", visibleItems.length === 0);
  if (!view?.task || visibleItems.length === 0) {
    return;
  }

  for (const item of visibleItems) {
    elements.deliveryQueue.append(renderDeliveryItem(view, item));
  }
}

function renderDeliveryItem(view: TaskViewState, item: DeliveryQueueItem): HTMLElement {
  const providerName = providerLabel(view.task?.provider ?? "codex");
  const row = document.createElement("article");
  row.className = `delivery-item ${item.status}`;
  row.dataset.deliveryId = item.id;

  const copy = document.createElement("div");
  copy.className = "delivery-copy";
  const status = document.createElement("strong");
  status.textContent = deliveryItemStatusLabel(view, providerName, item);
  const text = document.createElement("p");
  text.textContent = item.kind === "control" ? controlItemLabel(item) : promptItemLabel(item);
  copy.append(status, text);
  if (item.failureReason) {
    const reason = document.createElement("span");
    reason.className = "delivery-reason";
    reason.textContent = item.failureReason;
    copy.append(reason);
  }

  const actions = document.createElement("div");
  actions.className = "delivery-actions";
  if (item.status === "queued" && item.kind === "prompt") {
    actions.append(
      deliveryAction("Edit", () => {
        void editQueuedPrompt(item);
      }),
      deliveryAction("Cancel", () => {
        void cancelQueuedPrompt(item.id);
      }),
    );
  } else if (item.status === "queued") {
    actions.append(
      deliveryAction("Cancel", () => {
        void cancelQueuedPrompt(item.id);
      }),
    );
  } else if (item.status === "undelivered" && item.kind === "prompt") {
    actions.append(
      deliveryAction("Retry", () => {
        void retryQueuedPrompt(item.id);
      }),
      deliveryAction("Edit", () => {
        void editQueuedPrompt(item);
      }),
      deliveryAction("Terminal", () => {
        setTerminalOpen(true);
      }),
    );
  } else if (item.status === "undelivered") {
    actions.append(
      deliveryAction("Retry", () => {
        void retryQueuedPrompt(item.id);
      }),
      deliveryAction("Terminal", () => {
        setTerminalOpen(true);
      }),
    );
  } else {
    const waiting = document.createElement("span");
    waiting.textContent = "Waiting for receipt";
    actions.append(waiting);
  }

  row.append(copy, actions);
  return row;
}

function deliveryAction(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "secondary compact-action";
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

async function editQueuedPrompt(item: DeliveryQueueItem): Promise<void> {
  if (item.kind !== "prompt") {
    return;
  }
  elements.promptInput.value = item.text;
  await cancelQueuedPrompt(item.id);
  focusComposer();
  render();
}

async function cancelQueuedPrompt(itemId: string): Promise<void> {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }
  try {
    await window.duetRuntime.cancelQueuedPrompt({ taskId: view.task.id, itemId });
  } catch (error) {
    view.status = errorMessage(error);
    render();
  }
}

async function retryQueuedPrompt(itemId: string): Promise<void> {
  const view = activeTaskView();
  if (!view?.task) {
    return;
  }
  try {
    await window.duetRuntime.retryQueuedPrompt({ taskId: view.task.id, itemId });
  } catch (error) {
    view.status = errorMessage(error);
    render();
  }
}

function deliveryItemStatusLabel(
  view: TaskViewState,
  providerName: string,
  item: DeliveryQueueItem,
): string {
  if (item.kind === "control") {
    if (item.status === "delivering") {
      return `Applying ${providerName} setting`;
    }
    if (item.status === "undelivered") {
      return "Setting change failed";
    }
    return `Queued ${providerName} setting`;
  }
  if (item.status === "delivering") {
    return `Delivering to ${providerName}`;
  }
  if (item.status === "undelivered") {
    return `Undelivered — no ${providerName} receipt`;
  }
  const launchWait =
    !view.runtimeReady &&
    !view.deliveryState?.activeRun &&
    !view.deliveryState?.approvalActive;
  if (launchWait) {
    return `Starting ${providerName} — sends as soon as it accepts input`;
  }
  return `Queued — delivers when ${providerName} is ready`;
}

function promptItemLabel(item: DeliveryQueueItem): string {
  const attachmentLabel =
    item.attachments.length === 0
      ? null
      : item.attachments.length === 1
        ? "1 image"
        : `${item.attachments.length} images`;
  return [attachmentLabel, item.text].filter((part): part is string => Boolean(part)).join(" - ");
}

function controlItemLabel(item: DeliveryQueueItem): string {
  if (!item.control) {
    return item.text;
  }
  return item.control.kind === "permission"
    ? `Permission: ${item.text}`
    : `Model: ${item.text}`;
}

function deliveryStatusLabel(view: TaskViewState, deliveryState: DeliveryTaskState): string {
  const providerName = providerLabel(deliveryState.provider);
  const first = deliveryState.queue[0] ?? null;
  if (first?.status === "delivering") {
    if (first.kind === "control") {
      return "Applying setting";
    }
    return `Delivering to ${providerName}`;
  }
  if (first?.status === "undelivered") {
    return first.kind === "control" ? "Setting failed" : "Undelivered";
  }
  if (deliveryState.queue.some((item) => item.status === "queued")) {
    return "Queued";
  }
  if (deliveryState.approvalActive) {
    return `Waiting for ${providerName} approval`;
  }
  if (deliveryState.activeRun) {
    return `${providerName} is working`;
  }
  if (deliveryState.idleComposer || view.runtimeReady) {
    return "Ready";
  }
  return `Starting ${providerName}`;
}

function focusArtifactFromPreview(request: FocusArtifactInMainRequest): void {
  const view = taskViewForId(request.taskId);
  if (!view?.task) {
    return;
  }

  state.activeTaskId = request.taskId;
  view.unread = false;
  if (request.relativePath) {
    view.selectedArtifactPath = request.relativePath;
  }
  if (request.runId) {
    view.highlightedRunId = request.runId;
  }
  terminal.clear();
  if (view.terminalBuffer) {
    terminal.write(view.terminalBuffer);
  }
  render();

  queueMicrotask(() => {
    if (request.mode === "run" && request.runId) {
      scrollRunIntoView(request.runId);
      return;
    }
    if (!request.relativePath) {
      return;
    }
    const relativePath = request.relativePath;
    const artifact = Array.from(elements.artifactList.querySelectorAll<HTMLElement>(".artifact-item")).find(
      (item) => item.textContent?.includes(relativePath),
    );
    artifact?.scrollIntoView({ block: "nearest", inline: "center" });
  });
}

function focusRun(runId: string): void {
  const view = activeTaskView();
  if (view) {
    view.highlightedRunId = runId;
  }
  render();
  queueMicrotask(() => {
    scrollRunIntoView(runId);
  });
}

function scrollRunIntoView(runId: string): void {
  const runCard = Array.from(elements.runList.querySelectorAll<HTMLElement>(".turn-card")).find(
    (item) => item.dataset.runId === runId,
  );
  runCard?.scrollIntoView({ block: "center" });
}

function focusComposer(): void {
  elements.promptInput.focus();
}

function isComposerCompositionShortcut(event: KeyboardEvent): boolean {
  if (event.key !== "Enter" && event.key !== "Escape") {
    return false;
  }
  if (event.isComposing || composerIsComposing || event.keyCode === 229) {
    return true;
  }
  return performance.now() - lastComposerCompositionEndAt < COMPOSITION_END_SHORTCUT_GUARD_MS;
}

function composerPlaceholder(activeRun: boolean, pendingApproval: boolean): string {
  const view = activeTaskView();
  if (!view?.task) {
    return `Message ${providerLabel(state.taskDraft.provider)} — starts the session`;
  }
  const providerName = providerLabel(view.task.provider);
  if (pendingApproval) {
    return `${providerName} approval is waiting — Enter queues your message`;
  }
  if (activeRun) {
    return `${providerName} is working — Enter queues your message`;
  }
  if (!view.live) {
    return `Message ${providerName} — resumes this session`;
  }
  if (!view.runtimeReady) {
    return `${providerName} is starting — your message will send when it's ready`;
  }
  if ((view.report?.runs.length ?? 0) === 0) {
    return `Message ${providerName}`;
  }
  return "Continue, correct, or redirect this Task";
}

function sendButtonLabel(activeRun: boolean): string {
  if (activeRun) {
    return "Stop";
  }
  const view = activeTaskView();
  if (!view?.task) {
    return "Send";
  }
  return "Send";
}

function runSectionLabel(value: string): HTMLElement {
  const label = document.createElement("div");
  label.className = "run-rhythm-label";
  label.textContent = value;
  return label;
}

function approvalContextItem(label: string, value: string): HTMLElement {
  const item = document.createElement("span");
  item.dataset.approvalLabel = label;
  item.textContent = `${label}: ${value}`;
  return item;
}

function completionLabel(run: RuntimeRunReport): string {
  if (!run.completionSource) {
    return "pending";
  }
  return `${run.completionSource} / ${run.completionConfidence ?? "low"}`;
}

function runOutcome(
  run: RuntimeRunReport,
  options: { noAssistantOutput?: boolean } = {},
): string {
  const providerName = activeProviderLabel();
  if (run.status === "waiting-for-approval") {
    return `Waiting for ${approvalKindLabel(run.approvalKind)} approval`;
  }
  if (run.status === "resumed-after-approval") {
    return `Resumed after ${approvalKindLabel(run.approvalKind)} approval`;
  }
  if (run.status === "stopped") {
    return run.stopEvents.some((event) => event.action === "stopped" && event.slashStopSent)
      ? "Stopped by Esc + /stop"
      : "Stopped by Esc";
  }
  if (run.status === "approval-denied") {
    return `${approvalKindLabel(run.approvalKind)} approval denied`;
  }
  if (run.status === "completed" && options.noAssistantOutput) {
    return `${providerName} completed without an assistant reply`;
  }
  if (run.status === "completed" && run.completionSource === "terminal-idle-heuristic") {
    return "Completed by terminal idle heuristic";
  }
  if (run.status === "completed") {
    return "Completed";
  }
  if (run.status === "pty-exited") {
    return "PTY exited";
  }
  if (run.status === "failed") {
    return "Failed";
  }
  return `${providerName} is working`;
}

function providerLabelForRun(_run: RuntimeRunReport | null): string {
  return activeProviderLabel();
}

function completionErrorExcerpt(run: RuntimeRunReport | null): string | null {
  const hint = run?.completionHint;
  if (!hint || typeof hint !== "object" || Array.isArray(hint)) {
    return null;
  }
  const excerpt = hint.errorExcerpt;
  return typeof excerpt === "string" && excerpt.trim() ? excerpt.trim() : null;
}

function runTone(
  run: RuntimeRunReport,
  options: { noAssistantOutput?: boolean } = {},
): string {
  if (options.noAssistantOutput) {
    return "attention";
  }
  if (run.status === "stopped" || run.status === "approval-denied" || run.status === "failed") {
    return "attention";
  }
  if (run.status === "completed") {
    return "complete";
  }
  if (run.status === "waiting-for-approval") {
    return "waiting";
  }
  return "active";
}

function approvalTitle(kind: RuntimeRunReport["approvalKind"] | null | undefined): string {
  if (kind === "workspace-trust") {
    return "Workspace trust requested";
  }
  if (kind === "file-edit") {
    return "File edit approval requested";
  }
  if (kind === "file-read") {
    return "File read approval requested";
  }
  if (kind === "command") {
    return "Command approval requested";
  }
  return "Native approval requested";
}

function approvalSummary(kind: RuntimeRunReport["approvalKind"] | null | undefined): string {
  const providerName = activeProviderLabel();
  if (kind === "workspace-trust") {
    return `${providerName} is asking whether this Task workspace should be trusted before it continues.`;
  }
  if (kind === "file-edit") {
    return `${providerName} wants to write files in this Task workspace. Review the Run context before approving.`;
  }
  if (kind === "file-read") {
    return `${providerName} wants to read a file path through the native CLI session. Approve only when that access matches the Task.`;
  }
  if (kind === "command") {
    return `${providerName} wants to run a command through the native CLI session. Approve only when the command matches the Task.`;
  }
  return `${providerName} is waiting on a native approval screen in the PTY session.`;
}

function approvalScope(kind: RuntimeRunReport["approvalKind"] | null | undefined): string {
  if (kind === "workspace-trust") {
    return "Task workspace trust";
  }
  if (kind === "file-edit") {
    return "workspace file write";
  }
  if (kind === "file-read") {
    return "native file read";
  }
  if (kind === "command") {
    return "terminal command execution";
  }
  const providerName = activeProviderLabel();
  return `native ${providerName} session`;
}

function approvalKindLabel(kind: RuntimeRunReport["approvalKind"] | null | undefined): string {
  if (kind === "workspace-trust") {
    return "Workspace trust";
  }
  if (kind === "file-edit") {
    return "File edit";
  }
  if (kind === "file-read") {
    return "File read";
  }
  if (kind === "command") {
    return "Command";
  }
  return "Native";
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatElapsed(value: number | null): string {
  if (value === null) {
    return "running";
  }
  if (value < 1000) {
    return `${value} ms`;
  }
  return `${(value / 1000).toFixed(1)} s`;
}

function artifactKindLabel(kind: ArtifactCandidate["kind"]): string {
  if (kind === "html") {
    return "HTML";
  }
  if (kind === "markdown") {
    return "Markdown";
  }
  if (kind === "pdf") {
    return "PDF";
  }
  if (kind === "image") {
    return "Image";
  }
  if (kind === "spreadsheet") {
    return "Spreadsheet";
  }
  if (kind === "document") {
    return "Document";
  }
  if (kind === "presentation") {
    return "Presentation";
  }
  if (kind === "text") {
    return "Text";
  }
  return "Unknown";
}

function providerLabel(provider: RuntimeProvider): string {
  if (provider === "claude") {
    return "Claude";
  }
  return "Codex";
}

function activeProviderLabel(): string {
  const provider = activeTaskView()?.task?.provider;
  return provider ? providerLabel(provider) : "Codex";
}

function taskStatusLabel(task: Task): string {
  const providerName = providerLabel(task.provider);
  if (task.status === "running") {
    return `${providerName} is working`;
  }
  if (task.status === "waiting-for-approval") {
    return "Waiting for approval";
  }
  if (task.status === "stopping") {
    return "Stopping";
  }
  if (task.status === "stopped") {
    return "Stopped";
  }
  if (task.status === "failed") {
    return "Failed";
  }
  if (task.status === "starting" || task.status === "new") {
    return `${providerName} is starting`;
  }
  return "Ready";
}

function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 18)}...` : value;
}

function fitTerminal(): void {
  try {
    fitAddon.fit();
  } catch {
    // The terminal can be measured only after layout is ready.
  }
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing renderer element: ${id}`);
  }
  return element as T;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "");
}
