import fs from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeTheme,
  screen,
  shell,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
  type Rectangle,
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
  claudeSettingsPath,
  localApiSettingsPath,
  readingSettingsPath,
  resumeSettingsPath,
} from "./settings-store";
import { LocalApiServer, localApiSocketPath } from "./local-api/local-api-server";
import { ProjectsStore, projectsStorePath } from "./projects-store";

let mainWindow: BrowserWindow | null = null;
let previewWindow: BrowserWindow | null = null;
let inspectorWindow: BrowserWindow | null = null;
let runtimeController: RuntimeController | null = null;
let readingSettingsStore: ReadingSettingsStore | null = null;
let localApiServer: LocalApiServer | null = null;
let previewState: PreviewWindowState = {
  tabs: [],
  selected: null,
};
let inspectorState: InspectorWindowState = {
  taskId: null,
  lens: "run",
};
let previewWindowBounds: Rectangle | null = null;
let inspectorWindowBounds: Rectangle | null = null;

interface FloatingWindowDefaults {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
}

const MIN_RESTORED_VISIBLE_EDGE = 80;
const PREVIEW_WINDOW_DEFAULTS: FloatingWindowDefaults = {
  width: 980,
  height: 760,
  minWidth: 560,
  minHeight: 420,
};
const INSPECTOR_WINDOW_DEFAULTS: FloatingWindowDefaults = {
  width: 1080,
  height: 760,
  minWidth: 620,
  minHeight: 460,
};

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
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

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  return window;
}

function createPreviewWindow(): BrowserWindow {
  const window = new BrowserWindow({
    ...restoredFloatingWindowBounds(previewWindowBounds, PREVIEW_WINDOW_DEFAULTS),
    minWidth: PREVIEW_WINDOW_DEFAULTS.minWidth,
    minHeight: PREVIEW_WINDOW_DEFAULTS.minHeight,
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
  trackFloatingWindowBounds(window, (bounds) => {
    previewWindowBounds = bounds;
  });

  window.on("closed", () => {
    if (previewWindow === window) {
      previewWindow = null;
    }
  });

  return window;
}

function createInspectorWindow(): BrowserWindow {
  const window = new BrowserWindow({
    ...restoredFloatingWindowBounds(inspectorWindowBounds, INSPECTOR_WINDOW_DEFAULTS),
    minWidth: INSPECTOR_WINDOW_DEFAULTS.minWidth,
    minHeight: INSPECTOR_WINDOW_DEFAULTS.minHeight,
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
  trackFloatingWindowBounds(window, (bounds) => {
    inspectorWindowBounds = bounds;
  });

  window.on("closed", () => {
    if (inspectorWindow === window) {
      inspectorWindow = null;
    }
  });

  return window;
}

function restoredFloatingWindowBounds(
  savedBounds: Rectangle | null,
  defaults: FloatingWindowDefaults,
): Pick<Rectangle, "x" | "y" | "width" | "height"> | Pick<Rectangle, "width" | "height"> {
  if (!savedBounds) {
    return {
      width: defaults.width,
      height: defaults.height,
    };
  }

  const bounds = {
    x: savedBounds.x,
    y: savedBounds.y,
    width: Math.max(savedBounds.width, defaults.minWidth),
    height: Math.max(savedBounds.height, defaults.minHeight),
  };

  if (!isWindowVisibleOnAnyDisplay(bounds)) {
    return {
      width: defaults.width,
      height: defaults.height,
    };
  }

  return bounds;
}

function isWindowVisibleOnAnyDisplay(bounds: Pick<Rectangle, "x" | "y" | "width" | "height">): boolean {
  return screen.getAllDisplays().some((display) => {
    const visibleWidth =
      Math.min(bounds.x + bounds.width, display.workArea.x + display.workArea.width) -
      Math.max(bounds.x, display.workArea.x);
    const visibleHeight =
      Math.min(bounds.y + bounds.height, display.workArea.y + display.workArea.height) -
      Math.max(bounds.y, display.workArea.y);
    return visibleWidth >= MIN_RESTORED_VISIBLE_EDGE && visibleHeight >= MIN_RESTORED_VISIBLE_EDGE;
  });
}

function trackFloatingWindowBounds(
  window: BrowserWindow,
  saveBounds: (bounds: Rectangle) => void,
): void {
  const rememberBounds = (): void => {
    if (window.isDestroyed() || window.isMinimized()) {
      return;
    }
    saveBounds(window.getBounds());
  };

  window.on("move", rememberBounds);
  window.on("resize", rememberBounds);
  window.on("close", rememberBounds);
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
    openWorkspaceExternal,
    openWorkspaceFolder,
    pickFolder,
    pickReferences,
    closeTaskSurfaces,
  }, readingSettingsStore);
  createApplicationMenu();
  mainWindow = createMainWindow();

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

  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  localApiServer?.stop();
  localApiServer = null;
  runtimeController?.dispose();
});
