import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../shared/types";

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.taskCreate, notImplemented("createTask"));
  ipcMain.handle(IPC_CHANNELS.taskOpen, notImplemented("openTask"));
  ipcMain.handle(IPC_CHANNELS.promptSubmit, notImplemented("submitPrompt"));
  ipcMain.handle(IPC_CHANNELS.approvalDecide, notImplemented("decideApproval"));
  ipcMain.handle(IPC_CHANNELS.runStop, notImplemented("stopRun"));
  ipcMain.handle(IPC_CHANNELS.terminalResize, notImplemented("resizeTerminal"));
  ipcMain.handle(IPC_CHANNELS.reportRead, notImplemented("readReport"));
  ipcMain.handle(IPC_CHANNELS.artifactList, notImplemented("listArtifacts"));
  ipcMain.handle(IPC_CHANNELS.artifactRead, notImplemented("readArtifact"));
}

function notImplemented(action: string): () => never {
  return () => {
    throw new Error(`${action} is not implemented in the app skeleton yet.`);
  };
}
