import path from "node:path";
import { app, BrowserWindow, shell } from "electron";
import {
  IPC_CHANNELS,
  type OpenPreviewRequest,
  type PreviewWindowState,
} from "../shared/types";
import { registerIpcHandlers } from "./ipc";
import { RuntimeController } from "./runtime-controller";

let mainWindow: BrowserWindow | null = null;
let previewWindow: BrowserWindow | null = null;
let runtimeController: RuntimeController | null = null;
let previewState: PreviewWindowState = {
  taskId: null,
  tabs: [],
  selectedPath: null,
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
  if (previewState.taskId !== request.taskId) {
    previewState = {
      taskId: request.taskId,
      tabs: [],
      selectedPath: null,
    };
  }

  if (!request.relativePath) {
    return;
  }

  const existing = previewState.tabs.find((tab) => tab.path === request.relativePath);
  previewState = {
    taskId: request.taskId,
    tabs: existing
      ? previewState.tabs.map((tab) =>
          tab.path === request.relativePath ? { ...tab, dirty: false } : tab,
        )
      : [...previewState.tabs, { path: request.relativePath, dirty: false }],
    selectedPath: request.relativePath,
  };
}

function sendPreviewState(): void {
  if (previewWindow && !previewWindow.isDestroyed()) {
    previewWindow.webContents.send(IPC_CHANNELS.previewState, previewState);
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

  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  runtimeController?.dispose();
});
