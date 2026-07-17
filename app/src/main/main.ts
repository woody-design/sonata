import fs from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeTheme,
  protocol,
  shell,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
} from "electron";
import {
  DEFAULT_TERMINAL_WINDOW_SETTINGS,
  IPC_CHANNELS,
  normalizeTerminalWindowSettings,
  type CliActionRequest,
  type FolderPickResponse,
  type OpenPreviewRequest,
  type PreviewActivateRequest,
  type PreviewBinding,
  type PreviewCloseRequest,
  type PreviewDocument,
  type PreviewReorderRequest,
  type PreviewSetPanelRequest,
  type PreviewSetScrollRequest,
  type ReadingSettings,
  type RuntimeEvent,
  type TaskId,
  type TerminalActiveTaskState,
  type TerminalWindowSettings,
  type TerminalWindowState,
  type WorkspaceDirEntry,
  type WorkspaceOpenExternalRequest,
  type WorkspaceOpenExternalResponse,
  type WorkspaceOpenFolderRequest,
  type WorkspaceReadDirRequest,
  type WorkspaceReadDocRequest,
  type WorkspaceResolvePathsRequest,
  type WorkspaceResolvePathsResult,
  type WorkspaceStatRequest,
  type WorkspaceStatResult,
} from "../shared/types";
import { registerIpcHandlers } from "./ipc";
import { NotificationController } from "./notification-controller";
import { PreviewSessions } from "./preview-sessions";
import { createRuntimeEventRecorder } from "./runtime-event-recorder";
import { RuntimeController } from "./runtime-controller";
import { WorkspaceFiles } from "./workspace-files";
import {
  ClaudeSettingsStore,
  CodexSettingsStore,
  LocalApiSettingsStore,
  PreviewSessionsStore,
  ReadingSettingsStore,
  ResumeSettingsStore,
  TerminalWindowSettingsStore,
  WindowStateStore,
  claudeSettingsPath,
  codexSettingsPath,
  localApiSettingsPath,
  previewSessionsPath,
  readingSettingsPath,
  resumeSettingsPath,
  terminalWindowSettingsPath,
  windowStatePath,
} from "./settings-store";
import { WindowStateManager, type WindowDefaults } from "./window-state";
import { LocalApiServer, localApiSocketPath } from "./local-api/local-api-server";
import { ProjectsStore, projectsStorePath } from "./projects-store";

// The `sonata-file://` scheme serves a task workspace's local images to the
// Preview reader (design record §4/§6.1). It MUST be registered as privileged
// BEFORE `app` is ready — this runs at module load, before `whenReady`. It is
// `standard` so `sonata-file://<taskId>/<path>` parses hierarchically (host +
// path) and relative `./img.png` resolution behaves like a normal URL; `secure`
// so it is a trustworthy origin; `supportFetchAPI` so <img> subresource loads
// resolve cleanly. The handler (registered at ready) serves image bytes ONLY —
// everything else is a 404 (WorkspaceFiles.readImage is the whole gate).
protocol.registerSchemesAsPrivileged([
  {
    scheme: "sonata-file",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

let mainWindow: BrowserWindow | null = null;
let previewWindow: BrowserWindow | null = null;
let terminalWindow: BrowserWindow | null = null;
let runtimeController: RuntimeController | null = null;
let notificationController: NotificationController | null = null;
let readingSettingsStore: ReadingSettingsStore | null = null;
let terminalWindowSettingsStore: TerminalWindowSettingsStore | null = null;
let localApiServer: LocalApiServer | null = null;
// Distinguishes a user closing the terminal window (persist closed) from the
// app quitting (leave the open preference intact, so it reopens next launch).
let isQuitting = false;
// Preview window session truth + disk seam (design record §6). The window binds
// ONE task at a time and follows the Reading window's active task; the bound id
// is the projection key.
let previewSessions: PreviewSessions | null = null;
let workspaceFiles: WorkspaceFiles | null = null;
let previewBoundTaskId: TaskId | null = null;
// Which task the terminal window shows. Owned by the main renderer (the
// selected-task concept is its UI state); relayed here for the terminal window.
let activeTerminalTask: TerminalActiveTaskState = {
  taskId: null,
  live: false,
  openTaskIds: [],
  projectName: "Tasks",
  sessionTitle: "New task",
  emptySurface: { kind: "fresh", phase: "ready", disabledReason: "Loading task settings" },
};
let windowState: WindowStateManager | null = null;

const MAIN_WINDOW_DEFAULTS: WindowDefaults = {
  width: 1280,
  height: 860,
  minWidth: 960,
  minHeight: 640,
};
const PREVIEW_WINDOW_DEFAULTS: WindowDefaults = {
  width: 980,
  height: 760,
  minWidth: 560,
  minHeight: 420,
};
const TERMINAL_WINDOW_DEFAULTS: WindowDefaults = {
  width: 900,
  height: 760,
  minWidth: 480,
  minHeight: 360,
};

function createMainWindow(): BrowserWindow {
  const decision = windowState?.restore("main", MAIN_WINDOW_DEFAULTS);
  const window = new BrowserWindow({
    ...(decision?.bounds ?? {
      width: MAIN_WINDOW_DEFAULTS.width,
      height: MAIN_WINDOW_DEFAULTS.height,
    }),
    minWidth: MAIN_WINDOW_DEFAULTS.minWidth,
    minHeight: MAIN_WINDOW_DEFAULTS.minHeight,
    // Only set fullscreen when restoring into it — passing `false` explicitly
    // disables the macOS fullscreen (green) button.
    ...(decision?.fullScreen ? { fullscreen: true } : {}),
    title: "Sonata",
    // Full-height sidebar window (Notion/Codex/Finder pattern): no OS titlebar
    // strip — the renderer owns the whole window and the traffic lights float
    // over the sidebar's top-left. Fixes the dark-mode black titlebar (the app
    // now draws its own background everywhere) and makes the sidebar + main two
    // full-height bands. `trafficLightPosition` drops the lights into the
    // sidebar-top zone; the renderer reserves that corner in both collapse
    // states. macOS-only options; ignored elsewhere.
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });

  window.loadFile(path.join(__dirname, "../renderer/index.html"));
  windowState?.track(window, "main");
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  return window;
}

function createPreviewWindow(): BrowserWindow {
  const decision = windowState?.restore("preview", PREVIEW_WINDOW_DEFAULTS);
  const window = new BrowserWindow({
    ...(decision?.bounds ?? {
      width: PREVIEW_WINDOW_DEFAULTS.width,
      height: PREVIEW_WINDOW_DEFAULTS.height,
    }),
    minWidth: PREVIEW_WINDOW_DEFAULTS.minWidth,
    minHeight: PREVIEW_WINDOW_DEFAULTS.minHeight,
    // Only set fullscreen when restoring into it — passing `false` explicitly
    // disables the macOS fullscreen (green) button.
    ...(decision?.fullScreen ? { fullscreen: true } : {}),
    title: "Sonata Preview",
    // Frameless like the main + terminal windows: the tab strip is the drag
    // region and reserves a traffic-light inset on its left, so the strip reads
    // as a peer of the browser tab bars the design borrows from. macOS-only
    // options; ignored elsewhere.
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  // The reader intercepts every in-document link click and routes it (fragment /
  // workspace tab / external), so the window itself must NEVER navigate — a
  // stray relative href (resolved against the injected doc base) would otherwise
  // replace the whole app with a `sonata-file://` page. Same guard the Reading
  // window carries.
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });

  window.loadFile(path.join(__dirname, "../renderer/preview.html"));
  windowState?.track(window, "preview");
  window.on("closed", () => {
    if (previewWindow === window) {
      previewWindow = null;
    }
  });

  return window;
}

function createTerminalWindow(): BrowserWindow {
  const decision = windowState?.restore("terminal", TERMINAL_WINDOW_DEFAULTS);
  const window = new BrowserWindow({
    ...(decision?.bounds ?? {
      width: TERMINAL_WINDOW_DEFAULTS.width,
      height: TERMINAL_WINDOW_DEFAULTS.height,
    }),
    minWidth: TERMINAL_WINDOW_DEFAULTS.minWidth,
    minHeight: TERMINAL_WINDOW_DEFAULTS.minHeight,
    ...(decision?.fullScreen ? { fullscreen: true } : {}),
    title: "Sonata CLI",
    // Frameless like the main window: the renderer owns the whole surface and
    // the traffic lights float over the topbar's reserved left corner, so the
    // CLI reads as a peer of the main column (its "CLI" label sits
    // right of the lights). macOS-only options; ignored elsewhere.
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  window.loadFile(path.join(__dirname, "../renderer/terminal.html"));
  windowState?.track(window, "terminal");
  window.on("closed", () => {
    if (terminalWindow === window) {
      terminalWindow = null;
    }
    // A user-initiated close persists the closed preference; an app quit leaves
    // it intact so the terminal reopens next launch.
    if (!isQuitting) {
      persistTerminalWindowOpen(false);
    }
    sendTerminalWindowState();
  });

  return window;
}

/**
 * Open/focus the Preview window and bind a task (design record §6.1). A bare
 * `taskId` (the header Eye button) shows that task's restored tabs or its empty
 * state; a `relativePath` also opens-or-focuses that tab. Binding stays in step
 * with the active-task relay — clicking a chip in task B implies B is active.
 */
async function openPreview(request: OpenPreviewRequest): Promise<void> {
  bindPreviewTask(request.taskId);
  if (request.relativePath) {
    previewSessions?.open(request.taskId, request.relativePath);
  }
  if (!previewWindow || previewWindow.isDestroyed()) {
    previewWindow = createPreviewWindow();
    previewWindow.webContents.once("did-finish-load", () => {
      pushPreviewBinding();
    });
  } else {
    previewWindow.show();
    previewWindow.focus();
    pushPreviewBinding();
  }
}

/**
 * The window binds ONE task's session and follows the Reading window's active
 * task (§6.1). Switching tasks swaps the whole strip (tabs, active, scroll all
 * restore); the previous task's claims persist untouched. Called from both the
 * active-task relay and an explicit open.
 */
function bindPreviewTask(taskId: TaskId | null): void {
  if (previewBoundTaskId === taskId) {
    return;
  }
  previewBoundTaskId = taskId;
  pushPreviewBinding();
}

function readPreviewBinding(): PreviewBinding {
  return currentPreviewBinding();
}

/** Push the bound task's session (+ breadcrumb root) to the Preview window
 *  ONLY — the old state broadcast to every window was unconsumed noise (§6.1). */
function pushPreviewBinding(): void {
  if (!previewWindow || previewWindow.isDestroyed()) {
    return;
  }
  previewWindow.webContents.send(IPC_CHANNELS.previewBinding, currentPreviewBinding());
}

function currentPreviewBinding(): PreviewBinding {
  const taskId = previewBoundTaskId;
  if (!taskId || !previewSessions) {
    return { taskId: null, projectDirName: null, session: null };
  }
  return {
    taskId,
    projectDirName: previewProjectDirName(taskId),
    session: previewSessions.session(taskId),
  };
}

/** Basename of the bound task's workspace cwd — the breadcrumb root label.
 *  Resolves for dormant sessions too (disk truth needs no live PTY); null when
 *  the task is gone (deleted). */
function previewProjectDirName(taskId: TaskId): string | null {
  try {
    const root = runtimeController?.sessionWorkingDirectory(taskId);
    return root ? path.basename(root) : null;
  } catch {
    return null;
  }
}

// Named transitions (renderer → main). Each ignores a taskId that raced a
// rebind, mutates session truth, and echoes the fresh binding back.
function previewCloseTab(request: PreviewCloseRequest): void {
  if (!previewSessions || request.taskId !== previewBoundTaskId) {
    return;
  }
  previewSessions.close(request.taskId, request.path);
  pushPreviewBinding();
}

function previewActivateTab(request: PreviewActivateRequest): void {
  if (!previewSessions || request.taskId !== previewBoundTaskId) {
    return;
  }
  previewSessions.activate(request.taskId, request.path);
  pushPreviewBinding();
}

function previewReorderTabs(request: PreviewReorderRequest): void {
  if (!previewSessions || request.taskId !== previewBoundTaskId) {
    return;
  }
  previewSessions.reorder(request.taskId, request.paths);
  pushPreviewBinding();
}

function previewSetScroll(request: PreviewSetScrollRequest): void {
  // Write-only: no echo (echoing scroll would fight the user's live scrolling).
  if (!previewSessions || request.taskId !== previewBoundTaskId) {
    return;
  }
  previewSessions.setScroll(request.taskId, request.path, request.scroll);
}

function previewSetPanel(request: PreviewSetPanelRequest): void {
  if (!previewSessions || request.taskId !== previewBoundTaskId) {
    return;
  }
  previewSessions.setPanel(request.taskId, request.open);
  pushPreviewBinding();
}

function readWorkspaceDoc(request: WorkspaceReadDocRequest): PreviewDocument {
  if (!workspaceFiles) {
    throw new Error("Workspace files seam is not ready.");
  }
  return workspaceFiles.readDoc(request.taskId, request.relativePath);
}

/** The `sonata-file://` handler body: parse `sonata-file://<taskId>/<enc-path>`,
 *  resolve to an image STREAM through WorkspaceFiles' audited guard, and answer
 *  404 for anything that is not a real in-workspace image (a script can never
 *  ride an image content-type). Genuinely never throws — a bad URL (incl.
 *  malformed percent-encoding) is a 404. The channel is scoped to the Preview's
 *  bound task: a request for any OTHER task's id is refused even though it would
 *  still be workspace-guarded, keeping the capability matched to the "one task's
 *  reading surface" model (least privilege). */
function serveSonataFileImage(rawUrl: string): Response {
  const notFound = new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain" },
  });
  if (!workspaceFiles) {
    return notFound;
  }
  let url: URL;
  let relativePath: string;
  try {
    url = new URL(rawUrl);
    relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  } catch {
    return notFound; // bad URL or malformed percent-encoding
  }
  const taskId = url.hostname;
  if (!taskId || !relativePath || taskId !== previewBoundTaskId) {
    return notFound;
  }
  const image = workspaceFiles.readImage(taskId, relativePath);
  if (!image) {
    return notFound;
  }
  return new Response(image.body, {
    status: 200,
    headers: { "content-type": image.mime, "cache-control": "no-cache" },
  });
}

function readWorkspaceDir(request: WorkspaceReadDirRequest): WorkspaceDirEntry[] {
  return workspaceFiles?.readDir(request.taskId, request.relativePath ?? "") ?? [];
}

function resolveWorkspacePaths(
  request: WorkspaceResolvePathsRequest,
): WorkspaceResolvePathsResult {
  return { existing: workspaceFiles?.resolvePaths(request.taskId, request.candidates) ?? [] };
}

function statWorkspacePath(request: WorkspaceStatRequest): WorkspaceStatResult {
  return (
    workspaceFiles?.stat(request.taskId, request.relativePath) ?? {
      exists: false,
      isFile: false,
      isDirectory: false,
      size: 0,
    }
  );
}

/** Broadcast the full reading appearance so satellites that follow it (Preview)
 *  re-stamp on a theme/mode/textStep change (R6). The system-mode channel only
 *  covers the auto→light/dark flip; this covers explicit changes. */
function broadcastReadingSettings(settings: ReadingSettings): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.readingSettingsChanged, settings);
    }
  }
}

/**
 * A clicked native notification raises the Reading window and asks its renderer
 * to select the task the notification was about — the whole point of the
 * notification in a multi-task host is landing you on the right session.
 */
function activateTaskFromNotification(taskId: TaskId): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send(IPC_CHANNELS.notificationActivateTask, taskId);
}

/** A deleted session leaves no dormant record to return to, so its preview
 *  claims are forgotten (close/archive keep theirs). Called only on delete. */
function forgetPreviewSession(taskId: TaskId): void {
  previewSessions?.forget(taskId);
  if (previewBoundTaskId === taskId) {
    previewBoundTaskId = null;
    pushPreviewBinding();
  }
}


/**
 * The terminal window's toggle. Opening creates-or-focuses the window and
 * persists the preference; closing routes through `window.close()`, whose
 * "closed" handler persists the closed preference and broadcasts state. The
 * return value carries the *intent* immediately (for the awaiting toggle
 * button); the authoritative broadcast follows from the window lifecycle.
 */
async function setTerminalWindowOpen(open: boolean): Promise<TerminalWindowState> {
  if (open) {
    if (!terminalWindow || terminalWindow.isDestroyed()) {
      terminalWindow = createTerminalWindow();
    } else {
      terminalWindow.show();
      terminalWindow.focus();
    }
    persistTerminalWindowOpen(true);
    sendTerminalWindowState();
    return { open: true };
  }

  if (terminalWindow && !terminalWindow.isDestroyed()) {
    terminalWindow.close();
  } else {
    persistTerminalWindowOpen(false);
    sendTerminalWindowState();
  }
  return { open: false };
}

function readTerminalWindowState(): TerminalWindowState {
  return { open: Boolean(terminalWindow && !terminalWindow.isDestroyed()) };
}

function sendTerminalWindowState(): void {
  const state = readTerminalWindowState();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.terminalWindowState, state);
    }
  }
}

function readTerminalWindowSettings(): TerminalWindowSettings {
  return terminalWindowSettingsStore?.read() ?? { ...DEFAULT_TERMINAL_WINDOW_SETTINGS };
}

function writeTerminalWindowSettings(settings: TerminalWindowSettings): TerminalWindowSettings {
  // The window owns scheme + mode + fontSize; `open` is owned by the toggle,
  // so preserve the stored value rather than trusting the request. Normalized
  // HERE, not just in the store's write(): the no-store / write-failure
  // fallbacks return `merged` directly, and a malformed IPC payload must not
  // round-trip back to the renderer unvalidated through those paths.
  const merged: TerminalWindowSettings = normalizeTerminalWindowSettings({
    ...readTerminalWindowSettings(),
    scheme: settings.scheme,
    mode: settings.mode,
    fontSize: settings.fontSize,
  });
  try {
    return terminalWindowSettingsStore?.write(merged) ?? merged;
  } catch {
    return merged;
  }
}

function persistTerminalWindowOpen(open: boolean): void {
  try {
    // Merge so the persisted theme/mode survive an open/close toggle.
    terminalWindowSettingsStore?.write({ ...readTerminalWindowSettings(), open });
  } catch {
    // A failed preference write must never crash the app — at worst the open
    // state re-defaults on next launch.
  }
}

function setActiveTerminalTask(next: TerminalActiveTaskState, senderId: number): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.id !== senderId) {
    throw new Error("Only the Reading window may set the CLI binding.");
  }
  activeTerminalTask = next;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.terminalActiveTask, activeTerminalTask);
    }
  }
  // The Preview window rides the same active-task signal: it follows whatever
  // task the Reading window has selected (§6.1). A null task unbinds to the
  // empty state.
  bindPreviewTask(next.taskId);
}

function requestCliAction(request: CliActionRequest, senderId: number): void {
  if (
    !terminalWindow ||
    terminalWindow.isDestroyed() ||
    terminalWindow.webContents.id !== senderId
  ) {
    throw new Error("Only the CLI window may request a CLI action.");
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error("The Reading window is unavailable.");
  }
  mainWindow.webContents.send(IPC_CHANNELS.cliAction, request);
}

function readActiveTerminalTask(): TerminalActiveTaskState {
  return activeTerminalTask;
}

async function openWorkspaceExternal(
  request: WorkspaceOpenExternalRequest,
): Promise<WorkspaceOpenExternalResponse> {
  if (!workspaceFiles) {
    throw new Error("Workspace files seam is not ready.");
  }
  // Route external-open through WorkspaceFiles' single audited resolution (§6.1)
  // — the same path+symlink guard reads use, no second copy here.
  const targetPath = workspaceFiles.resolveExternalTarget(request.taskId, request.relativePath);

  if (request.target === "folder") {
    await openFolderTarget(targetPath, Boolean(request.relativePath));
  } else {
    await openCursorTarget(targetPath);
  }

  return {
    target: request.target,
    path: targetPath,
  };
}

async function openWorkspaceFolder(request: WorkspaceOpenFolderRequest): Promise<void> {
  await openWorkspaceExternal({
    taskId: request.taskId,
    target: "folder",
  });
}

async function pickFolder(): Promise<FolderPickResponse> {
  if (process.env.SONATA_TEST_PICK_FOLDER) {
    return {
      path: process.env.SONATA_TEST_PICK_FOLDER,
    };
  }
  const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const options: OpenDialogOptions = {
    title: "Choose Task Folder",
    properties: ["openDirectory", "createDirectory"],
  };
  const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  return {
    path: result.canceled ? null : result.filePaths[0] ?? null,
  };
}

async function pickReferences(): Promise<string[]> {
  if (process.env.SONATA_TEST_PICK_REFERENCES) {
    return process.env.SONATA_TEST_PICK_REFERENCES.split("\n").map((entry) => entry.trim()).filter(Boolean);
  }
  const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  // macOS shows files AND folders in one panel — no split menu (D6).
  const options: OpenDialogOptions = {
    title: "Attach Files or Folders",
    properties: ["openFile", "openDirectory", "multiSelections"],
  };
  const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  return result.canceled ? [] : result.filePaths;
}

async function openFolderTarget(targetPath: string, revealTarget: boolean): Promise<void> {
  if (revealTarget && fs.statSync(targetPath).isFile()) {
    shell.showItemInFolder(targetPath);
    return;
  }

  const result = await shell.openPath(targetPath);
  if (result) {
    throw new Error(result);
  }
}

async function openCursorTarget(targetPath: string): Promise<void> {
  await shell.openExternal(cursorFileUrl(targetPath));
}

function cursorFileUrl(filePath: string): string {
  const normalizedPath = filePath.split(path.sep).join("/");
  const encodedPath = normalizedPath.split("/").map(encodeURIComponent).join("/");
  return `cursor://file${encodedPath.startsWith("/") ? "" : "/"}${encodedPath}`;
}

/**
 * The Settings page lives in the main window as a centered overlay; the
 * menu item (and ⌘,) is its only chrome-level entrance per the HIG — no
 * toolbar button. Most settings are born at their moments; this is the
 * review door.
 */
function openSettingsInMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
    mainWindow.webContents.once("did-finish-load", () => {
      mainWindow?.webContents.send(IPC_CHANNELS.settingsOpen);
    });
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send(IPC_CHANNELS.settingsOpen);
}

function createApplicationMenu(): void {
  const isMac = process.platform === "darwin";
  const settingsItem: MenuItemConstructorOptions = {
    id: "settings",
    label: "Settings…",
    accelerator: "CmdOrCtrl+,",
    click: () => openSettingsInMainWindow(),
  };
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              settingsItem,
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      submenu: isMac
        ? [{ role: "close" }]
        : [settingsItem, { type: "separator" }, { role: "quit" }],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function sendReadingSystemMode(): void {
  const mode = nativeTheme.shouldUseDarkColors ? "dark" : "light";
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.readingSystemModeChanged, mode);
    }
  }
}

function startLocalApiIfEnabled(controller: RuntimeController): void {
  // SONATA_LOCAL_API=0 is a hard off that overrides the settings file —
  // a kill switch that wins regardless of persisted preference.
  if (process.env.SONATA_LOCAL_API === "0") {
    return;
  }
  const settings = new LocalApiSettingsStore(
    localApiSettingsPath(),
  ).read();
  const enabled = settings.enabled || process.env.SONATA_LOCAL_API === "1";
  if (!enabled) {
    return;
  }
  localApiServer = new LocalApiServer({
    socketPath: localApiSocketPath(app.getPath("userData")),
    appVersion: app.getVersion(),
    facade: {
      readSessionIndex: (options) => controller.readSessionIndex(options),
      readSessionSnapshot: (taskId: TaskId) => controller.readSessionSnapshot(taskId),
      submitPrompt: (taskId: TaskId, text: string) => controller.submitPrompt(taskId, text),
      openTask: (taskId: TaskId) => {
        controller.openTask({ taskId, resume: true });
      },
    },
  });
  localApiServer.start().catch((error) => {
    console.error("[local-api] failed to start:", error);
    localApiServer = null;
  });
}

// Recorded reality for the reading-core reducer fixtures (map §2.4): default
// off; set SONATA_RUNTIME_EVENT_LOG=<dir> to capture the renderer-bound event
// stream as JSONL.
const recordRuntimeEvent = createRuntimeEventRecorder(process.env.SONATA_RUNTIME_EVENT_LOG);

app.whenReady().then(() => {
  readingSettingsStore = new ReadingSettingsStore(readingSettingsPath());
  previewSessions = new PreviewSessions(new PreviewSessionsStore(previewSessionsPath()));
  // The disk-truth seam resolves a task's workspace root for LIVE or DORMANT
  // sessions (sessionWorkingDirectory reads the manifest) — reading a file
  // never needs a live PTY. A gone task returns null → absent/empty projection.
  workspaceFiles = new WorkspaceFiles((taskId) => {
    try {
      return runtimeController?.sessionWorkingDirectory(taskId) ?? null;
    } catch {
      return null;
    }
  });
  // Serve `sonata-file://<taskId>/<path>` local images to the Preview reader.
  // The URL host is the task id, the path is the (percent-encoded) workspace-
  // relative path; resolution + the image-only allowlist live in WorkspaceFiles
  // (the ONE audited guard). Anything that is not a real, in-workspace image →
  // 404, so this channel can never serve a script or escape the workspace.
  protocol.handle("sonata-file", (request) => serveSonataFileImage(request.url));
  // SONATA_NOTIFICATIONS=0 is a hard off (kill switch for test harnesses and for
  // anyone who prefers the macOS per-app toggle as their only control).
  if (process.env.SONATA_NOTIFICATIONS !== "0") {
    notificationController = new NotificationController({
      activateTask: activateTaskFromNotification,
      // Pull the current name + provider from the live task registry at fire
      // time — authoritative even after a rename, and for tasks the controller
      // never saw created. `runtimeController` is assigned just below; the
      // notifier only fires later, so the lazy read is safe.
      resolveTaskMeta: (taskId) => {
        const task = runtimeController?.listTasks().find((entry) => entry.id === taskId);
        return task
          ? {
              title: task.title,
              provider: task.provider,
              ...(task.titleOrigin === undefined ? {} : { titleOrigin: task.titleOrigin }),
            }
          : null;
      },
    });
  }
  runtimeController = new RuntimeController({
    projectsStore: new ProjectsStore(projectsStorePath()),
    resumeSettingsStore: new ResumeSettingsStore(resumeSettingsPath()),
    claudeSettingsStore: new ClaudeSettingsStore(claudeSettingsPath()),
    codexSettingsStore: new CodexSettingsStore(codexSettingsPath()),
    sendEvent: (event) => {
      recordRuntimeEvent(event);
      localApiServer?.broadcastEvent(event);
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.runtimeEvent, event);
        }
      }
      notificationController?.handleEvent(event);
    },
  });
  startLocalApiIfEnabled(runtimeController);
  if (!readingSettingsStore) {
    throw new Error("Reading settings store is not ready.");
  }
  nativeTheme.on("updated", sendReadingSystemMode);
  registerIpcHandlers(runtimeController, {
    openPreview,
    readPreviewBinding,
    previewCloseTab,
    previewActivateTab,
    previewReorderTabs,
    previewSetScroll,
    previewSetPanel,
    readWorkspaceDoc,
    readWorkspaceDir,
    resolveWorkspacePaths,
    statWorkspacePath,
    broadcastReadingSettings,
    setTerminalWindowOpen,
    readTerminalWindowState,
    readTerminalWindowSettings,
    writeTerminalWindowSettings,
    setActiveTerminalTask,
    readActiveTerminalTask,
    requestCliAction,
    openWorkspaceExternal,
    openWorkspaceFolder,
    pickFolder,
    pickReferences,
    forgetPreviewSession,
  }, readingSettingsStore);
  createApplicationMenu();
  windowState = new WindowStateManager(new WindowStateStore(windowStatePath()));
  mainWindow = createMainWindow();
  // Default-on: the terminal opens beside the conversation unless the user
  // closed it last session. `windowState` is ready above, so the restore path
  // inside the factory works.
  terminalWindowSettingsStore = new TerminalWindowSettingsStore(terminalWindowSettingsPath());
  if (terminalWindowSettingsStore.read().open) {
    // Open the terminal only after the main window has loaded: the conversation
    // is the primary surface (it stays frontmost and is the first window any
    // harness sees), and the terminal slides in beside it a beat later. The
    // heavy main renderer would otherwise lose the "first window" race to the
    // tiny terminal page.
    mainWindow.webContents.once("did-finish-load", () => {
      if (!terminalWindow || terminalWindow.isDestroyed()) {
        terminalWindow = createTerminalWindow();
      }
      mainWindow?.focus();
      // The main renderer's boot-time state read may have run before the window
      // existed; broadcast now so its toggle button reflects the open terminal.
      sendTerminalWindowState();
    });
  }

  app.on("activate", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  localApiServer?.stop();
  localApiServer = null;
  runtimeController?.dispose();
  runtimeController = null;
  previewWindow = null;
  terminalWindow = null;

  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  // Mark the quit so the terminal window's "closed" handler leaves the open
  // preference intact (a quit is not the user choosing to close the terminal).
  isQuitting = true;
  windowState?.flush();
  previewSessions?.flush();
  localApiServer?.stop();
  localApiServer = null;
  runtimeController?.dispose();
});
