import fs from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeTheme,
  shell,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
} from "electron";
import {
  IPC_CHANNELS,
  type FolderPickResponse,
  type FocusArtifactInMainRequest,
  type InspectorWindowState,
  type MarkPreviewReviewedRequest,
  type OpenInspectorRequest,
  type OpenPreviewRequest,
  type PreviewWindowState,
  type RuntimeEvent,
  type TaskId,
  type TerminalActiveTaskState,
  type TerminalWindowState,
  type WorkspaceOpenExternalRequest,
  type WorkspaceOpenExternalResponse,
  type WorkspaceOpenFolderRequest,
} from "../shared/types";
import { registerIpcHandlers } from "./ipc";
import { RuntimeController } from "./runtime-controller";
import {
  ClaudeSettingsStore,
  LocalApiSettingsStore,
  ReadingSettingsStore,
  ResumeSettingsStore,
  TerminalWindowSettingsStore,
  WindowStateStore,
  claudeSettingsPath,
  localApiSettingsPath,
  readingSettingsPath,
  resumeSettingsPath,
  terminalWindowSettingsPath,
  windowStatePath,
} from "./settings-store";
import { WindowStateManager, type WindowDefaults } from "./window-state";
import { LocalApiServer, localApiSocketPath } from "./local-api/local-api-server";
import { ProjectsStore, projectsStorePath } from "./projects-store";

let mainWindow: BrowserWindow | null = null;
let previewWindow: BrowserWindow | null = null;
let inspectorWindow: BrowserWindow | null = null;
let terminalWindow: BrowserWindow | null = null;
let runtimeController: RuntimeController | null = null;
let readingSettingsStore: ReadingSettingsStore | null = null;
let terminalWindowSettingsStore: TerminalWindowSettingsStore | null = null;
let localApiServer: LocalApiServer | null = null;
// Distinguishes a user closing the terminal window (persist closed) from the
// app quitting (leave the open preference intact, so it reopens next launch).
let isQuitting = false;
let previewState: PreviewWindowState = {
  tabs: [],
  selected: null,
};
let inspectorState: InspectorWindowState = {
  taskId: null,
  lens: "run",
};
// Which task the terminal window shows. Owned by the main renderer (the
// selected-task concept is its UI state); relayed here for the terminal window.
let activeTerminalTask: TerminalActiveTaskState = { taskId: null, live: false };
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
const INSPECTOR_WINDOW_DEFAULTS: WindowDefaults = {
  width: 1080,
  height: 760,
  minWidth: 620,
  minHeight: 460,
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
    title: "Duet",
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
    title: "Duet Preview",
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

  window.loadFile(path.join(__dirname, "../renderer/preview.html"));
  windowState?.track(window, "preview");
  window.on("closed", () => {
    if (previewWindow === window) {
      previewWindow = null;
    }
  });

  return window;
}

function createInspectorWindow(): BrowserWindow {
  const decision = windowState?.restore("inspector", INSPECTOR_WINDOW_DEFAULTS);
  const window = new BrowserWindow({
    ...(decision?.bounds ?? {
      width: INSPECTOR_WINDOW_DEFAULTS.width,
      height: INSPECTOR_WINDOW_DEFAULTS.height,
    }),
    minWidth: INSPECTOR_WINDOW_DEFAULTS.minWidth,
    minHeight: INSPECTOR_WINDOW_DEFAULTS.minHeight,
    // Only set fullscreen when restoring into it — passing `false` explicitly
    // disables the macOS fullscreen (green) button.
    ...(decision?.fullScreen ? { fullscreen: true } : {}),
    title: "Duet Inspector",
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

  window.loadFile(path.join(__dirname, "../renderer/inspector.html"));
  windowState?.track(window, "inspector");
  window.on("closed", () => {
    if (inspectorWindow === window) {
      inspectorWindow = null;
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
    title: "Duet Terminal",
    // Frameless like the main window: the renderer owns the whole surface and
    // the traffic lights float over the topbar's reserved left corner, so the
    // terminal reads as a peer of the main column (its "Terminal" label sits
    // right of the lights). macOS-only options; ignored elsewhere.
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 15 },
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

async function openPreview(request: OpenPreviewRequest): Promise<PreviewWindowState> {
  updatePreviewState(request);
  if (!previewWindow || previewWindow.isDestroyed()) {
    previewWindow = createPreviewWindow();
    previewWindow.webContents.once("did-finish-load", () => {
      sendPreviewState();
    });
  } else {
    previewWindow.show();
    previewWindow.focus();
    sendPreviewState();
  }
  return previewState;
}

function readPreviewState(): PreviewWindowState {
  return previewState;
}

function updatePreviewState(request: OpenPreviewRequest): void {
  if (!request.relativePath) {
    return;
  }

  const ref = {
    taskId: request.taskId,
    path: request.relativePath,
  };
  const existing = previewState.tabs.find((tab) => samePreviewRef(tab, ref));
  previewState = {
    tabs: existing
      ? previewState.tabs.map((tab) =>
          samePreviewRef(tab, ref) ? { ...tab, dirty: false } : tab,
        )
      : [...previewState.tabs, { ...ref, dirty: false, reviewed: false }],
    selected: ref,
  };
}

function sendPreviewState(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.previewState, previewState);
    }
  }
}

function markPreviewReviewed(request: MarkPreviewReviewedRequest): PreviewWindowState {
  const ref = {
    taskId: request.taskId,
    path: request.relativePath,
  };
  const existing = previewState.tabs.find((tab) => samePreviewRef(tab, ref));
  previewState = {
    tabs: existing
      ? previewState.tabs.map((tab) =>
          samePreviewRef(tab, ref) ? { ...tab, dirty: false, reviewed: true } : tab,
        )
      : [...previewState.tabs, { ...ref, dirty: false, reviewed: true }],
    selected: ref,
  };
  sendPreviewState();
  return previewState;
}

function focusArtifactInMain(request: FocusArtifactInMainRequest): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send(IPC_CHANNELS.mainArtifactFocus, request);
}

function handlePreviewRuntimeEvent(event: RuntimeEvent): void {
  if (event.type !== "file:changed") {
    return;
  }

  const ref = {
    taskId: event.payload.taskId,
    path: event.payload.path,
  };
  const selected = previewState.selected ? samePreviewRef(previewState.selected, ref) : false;
  let changed = false;
  const tabs = previewState.tabs.map((tab) => {
    if (!samePreviewRef(tab, ref)) {
      return tab;
    }
    changed = true;
    return {
      ...tab,
      dirty: !selected,
      reviewed: false,
    };
  });

  if (changed) {
    previewState = {
      ...previewState,
      tabs,
    };
    sendPreviewState();
  }
}

function samePreviewRef(
  left: { taskId: string; path: string },
  right: { taskId: string; path: string },
): boolean {
  return left.taskId === right.taskId && left.path === right.path;
}

function closeTaskSurfaces(taskId: TaskId): void {
  const tabs = previewState.tabs.filter((tab) => tab.taskId !== taskId);
  const selected =
    previewState.selected?.taskId === taskId ? tabs.at(-1) ?? null : previewState.selected;
  previewState = {
    tabs,
    selected,
  };
  sendPreviewState();

  if (inspectorState.taskId === taskId) {
    inspectorState = {
      ...inspectorState,
      taskId: null,
    };
  }
  sendInspectorState();
}

async function openInspector(request: OpenInspectorRequest): Promise<InspectorWindowState> {
  updateInspectorState(request);
  if (!inspectorWindow || inspectorWindow.isDestroyed()) {
    inspectorWindow = createInspectorWindow();
    inspectorWindow.webContents.once("did-finish-load", () => {
      sendInspectorState();
    });
  } else {
    inspectorWindow.show();
    inspectorWindow.focus();
    sendInspectorState();
  }
  return inspectorState;
}

function readInspectorState(): InspectorWindowState {
  return inspectorState;
}

function updateInspectorState(request: OpenInspectorRequest): void {
  inspectorState = {
    taskId: request.taskId,
    lens: request.lens ?? inspectorState.lens,
  };
}

function sendInspectorState(): void {
  if (inspectorWindow && !inspectorWindow.isDestroyed()) {
    inspectorWindow.webContents.send(IPC_CHANNELS.inspectorState, inspectorState);
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

function persistTerminalWindowOpen(open: boolean): void {
  try {
    terminalWindowSettingsStore?.write({ open });
  } catch {
    // A failed preference write must never crash the app — at worst the open
    // state re-defaults on next launch.
  }
}

function setActiveTerminalTask(next: TerminalActiveTaskState): void {
  activeTerminalTask = next;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.terminalActiveTask, activeTerminalTask);
    }
  }
}

function readActiveTerminalTask(): TerminalActiveTaskState {
  return activeTerminalTask;
}

async function openWorkspaceExternal(
  request: WorkspaceOpenExternalRequest,
): Promise<WorkspaceOpenExternalResponse> {
  if (!runtimeController) {
    throw new Error("Runtime controller is not ready.");
  }
  const workspaceRoot = runtimeController.workspacePath(request.taskId);
  const targetPath = resolveWorkspaceExternalPath(workspaceRoot, request.relativePath);

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
  if (process.env.DUET_TEST_PICK_FOLDER) {
    return {
      path: process.env.DUET_TEST_PICK_FOLDER,
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
  if (process.env.DUET_TEST_PICK_REFERENCES) {
    return process.env.DUET_TEST_PICK_REFERENCES.split("\n").map((entry) => entry.trim()).filter(Boolean);
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

function resolveWorkspaceExternalPath(workspaceRoot: string, relativePath?: string): string {
  const resolvedRoot = path.resolve(workspaceRoot);
  if (!relativePath) {
    return resolvedRoot;
  }

  if (path.isAbsolute(relativePath)) {
    throw new Error("Workspace path must be relative to the workspace.");
  }

  const targetPath = path.resolve(resolvedRoot, relativePath);
  const rootWithSep = `${resolvedRoot}${path.sep}`;
  if (targetPath !== resolvedRoot && !targetPath.startsWith(rootWithSep)) {
    throw new Error("Workspace path escapes the workspace.");
  }

  const realRoot = safeRealpath(resolvedRoot);
  const realTarget = safeRealpath(targetPath);
  const realRootWithSep = `${realRoot}${path.sep}`;
  if (realTarget !== realRoot && !realTarget.startsWith(realRootWithSep)) {
    throw new Error("Workspace path escapes the workspace through a symlink.");
  }

  return targetPath;
}

function safeRealpath(filePath: string): string {
  return fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
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
  // DUET_LOCAL_API=0 is a hard off that overrides the settings file —
  // a kill switch that wins regardless of persisted preference.
  if (process.env.DUET_LOCAL_API === "0") {
    return;
  }
  const settings = new LocalApiSettingsStore(
    localApiSettingsPath(),
  ).read();
  const enabled = settings.enabled || process.env.DUET_LOCAL_API === "1";
  if (!enabled) {
    return;
  }
  localApiServer = new LocalApiServer({
    socketPath: localApiSocketPath(app.getPath("userData")),
    appVersion: app.getVersion(),
    facade: {
      readSessionIndex: () => controller.readSessionIndex(),
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

app.whenReady().then(() => {
  readingSettingsStore = new ReadingSettingsStore(readingSettingsPath());
  runtimeController = new RuntimeController({
    projectsStore: new ProjectsStore(projectsStorePath()),
    resumeSettingsStore: new ResumeSettingsStore(resumeSettingsPath()),
    claudeSettingsStore: new ClaudeSettingsStore(claudeSettingsPath()),
    sendEvent: (event) => {
      handlePreviewRuntimeEvent(event);
      localApiServer?.broadcastEvent(event);
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.runtimeEvent, event);
        }
      }
    },
  });
  startLocalApiIfEnabled(runtimeController);
  if (!readingSettingsStore) {
    throw new Error("Reading settings store is not ready.");
  }
  nativeTheme.on("updated", sendReadingSystemMode);
  registerIpcHandlers(runtimeController, {
    openPreview,
    markPreviewReviewed,
    readPreviewState,
    focusArtifactInMain,
    openInspector,
    readInspectorState,
    setTerminalWindowOpen,
    readTerminalWindowState,
    setActiveTerminalTask,
    readActiveTerminalTask,
    openWorkspaceExternal,
    openWorkspaceFolder,
    pickFolder,
    pickReferences,
    closeTaskSurfaces,
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
  inspectorWindow = null;
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
  localApiServer?.stop();
  localApiServer = null;
  runtimeController?.dispose();
});
