import path from "node:path";
import { app, BrowserWindow, shell } from "electron";
import {
  IPC_CHANNELS,
  type InspectorWindowState,
  type OpenInspectorRequest,
  type OpenPreviewRequest,
  type PreviewWindowState,
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
    width: 980,
    height: 760,
    minWidth: 560,
    minHeight: 420,
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

  window.on("closed", () => {
    if (previewWindow === window) {
      previewWindow = null;
    }
  });

  return window;
}

function createInspectorWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 620,
    minHeight: 460,
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

  window.on("closed", () => {
    if (inspectorWindow === window) {
      inspectorWindow = null;
    }
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
      : [...previewState.tabs, { ...ref, dirty: false }],
    selected: ref,
  };
}

function sendPreviewState(): void {
  if (previewWindow && !previewWindow.isDestroyed()) {
    previewWindow.webContents.send(IPC_CHANNELS.previewState, previewState);
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
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.runtimeEvent, event);
        }
      }
    },
  });
  registerIpcHandlers(runtimeController, {
    openPreview,
    readPreviewState,
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
