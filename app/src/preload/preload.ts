import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, type DuetRuntimeBridge, type RuntimeEvent } from "../shared/types";

const duetRuntime: DuetRuntimeBridge = {
  createTask: (request) => ipcRenderer.invoke(IPC_CHANNELS.taskCreate, request),
  openTask: (request) => ipcRenderer.invoke(IPC_CHANNELS.taskOpen, request),
  submitPrompt: (request) => ipcRenderer.invoke(IPC_CHANNELS.promptSubmit, request),
  decideApproval: (request) => ipcRenderer.invoke(IPC_CHANNELS.approvalDecide, request),
  stopRun: (request) => ipcRenderer.invoke(IPC_CHANNELS.runStop, request),
  resizeTerminal: (request) => ipcRenderer.invoke(IPC_CHANNELS.terminalResize, request),
  readReport: (request) => ipcRenderer.invoke(IPC_CHANNELS.reportRead, request),
  listArtifacts: (request) => ipcRenderer.invoke(IPC_CHANNELS.artifactList, request),
  readArtifact: (request) => ipcRenderer.invoke(IPC_CHANNELS.artifactRead, request),
  onRuntimeEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, runtimeEvent: RuntimeEvent) => {
      callback(runtimeEvent);
    };
    ipcRenderer.on(IPC_CHANNELS.runtimeEvent, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.runtimeEvent, listener);
  },
};

contextBridge.exposeInMainWorld("duetRuntime", duetRuntime);
