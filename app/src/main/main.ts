import path from "node:path";
import { app, BrowserWindow, shell } from "electron";
import { IPC_CHANNELS } from "../shared/types";
import { registerIpcHandlers } from "./ipc";
import { RuntimeController } from "./runtime-controller";

let mainWindow: BrowserWindow | null = null;
let runtimeController: RuntimeController | null = null;

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

app.whenReady().then(() => {
  runtimeController = new RuntimeController({
    sendEvent: (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.runtimeEvent, event);
      }
    },
  });
  registerIpcHandlers(runtimeController);
  mainWindow = createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  runtimeController?.dispose();
  runtimeController = null;

  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  runtimeController?.dispose();
});
