import path from "node:path";
import { app, BrowserWindow, screen, shell, type Rectangle } from "electron";
import {
  IPC_CHANNELS,
  type FocusArtifactInMainRequest,
  type InspectorWindowState,
  type MarkPreviewReviewedRequest,
  type OpenInspectorRequest,
  type OpenPreviewRequest,
  type PreviewWindowState,
  type RuntimeEvent,
  type TaskId,
  type WorkspaceOpenFolderRequest,
} from "../shared/types";
import { registerIpcHandlers } from "./ipc";
import { RuntimeController } from "./runtime-controller";

let mainWindow: BrowserWindow | null = null;
let previewWindow: BrowserWindow | null = null;
let inspectorWindow: BrowserWindow | null = null;
let runtimeController: RuntimeController | null = null;
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

async function openWorkspaceFolder(request: WorkspaceOpenFolderRequest): Promise<void> {
  if (!runtimeController) {
    throw new Error("Runtime controller is not ready.");
  }
  const result = await shell.openPath(runtimeController.workspacePath(request.taskId));
  if (result) {
    throw new Error(result);
  }
}

app.whenReady().then(() => {
  runtimeController = new RuntimeController({
    sendEvent: (event) => {
      handlePreviewRuntimeEvent(event);
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.runtimeEvent, event);
        }
      }
    },
  });
  registerIpcHandlers(runtimeController, {
    openPreview,
    markPreviewReviewed,
    readPreviewState,
    focusArtifactInMain,
    openInspector,
    readInspectorState,
    openWorkspaceFolder,
    closeTaskSurfaces,
  });
  mainWindow = createMainWindow();

  app.on("activate", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  runtimeController?.dispose();
  runtimeController = null;
  previewWindow = null;
  inspectorWindow = null;

  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  runtimeController?.dispose();
});
