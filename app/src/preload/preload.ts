import { contextBridge, ipcRenderer } from "electron";
import {
  IPC_CHANNELS,
  type DuetRuntimeBridge,
  type InspectorWindowState,
  type PreviewWindowState,
  type RuntimeEvent,
} from "../shared/types";

const duetRuntime: DuetRuntimeBridge = {
  createTask: (request) => ipcRenderer.invoke(IPC_CHANNELS.taskCreate, request),
  openTask: (request) => ipcRenderer.invoke(IPC_CHANNELS.taskOpen, request),
  closeTask: (request) => ipcRenderer.invoke(IPC_CHANNELS.taskClose, request),
  listTasks: () => ipcRenderer.invoke(IPC_CHANNELS.taskList),
  submitPrompt: (request) => ipcRenderer.invoke(IPC_CHANNELS.promptSubmit, request),
  decideApproval: (request) => ipcRenderer.invoke(IPC_CHANNELS.approvalDecide, request),
  stopRun: (request) => ipcRenderer.invoke(IPC_CHANNELS.runStop, request),
  resizeTerminal: (request) => ipcRenderer.invoke(IPC_CHANNELS.terminalResize, request),
  readReport: (request) => ipcRenderer.invoke(IPC_CHANNELS.reportRead, request),
  listArtifacts: (request) => ipcRenderer.invoke(IPC_CHANNELS.artifactList, request),
  readArtifact: (request) => ipcRenderer.invoke(IPC_CHANNELS.artifactRead, request),
  openPreview: (request) => ipcRenderer.invoke(IPC_CHANNELS.previewOpen, request),
  readPreviewState: () => ipcRenderer.invoke(IPC_CHANNELS.previewStateRead),
  openInspector: (request) => ipcRenderer.invoke(IPC_CHANNELS.inspectorOpen, request),
  readInspectorState: () => ipcRenderer.invoke(IPC_CHANNELS.inspectorStateRead),
  readWorkspaceTree: (request) => ipcRenderer.invoke(IPC_CHANNELS.workspaceTreeRead, request),
  readWorkspaceFile: (request) => ipcRenderer.invoke(IPC_CHANNELS.workspaceFileRead, request),
  openWorkspaceFolder: (request) => ipcRenderer.invoke(IPC_CHANNELS.workspaceOpenFolder, request),
  onPreviewState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, previewState: PreviewWindowState) => {
      callback(previewState);
    };
    ipcRenderer.on(IPC_CHANNELS.previewState, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.previewState, listener);
  },
  onInspectorState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, inspectorState: InspectorWindowState) => {
      callback(inspectorState);
    };
    ipcRenderer.on(IPC_CHANNELS.inspectorState, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.inspectorState, listener);
  },
  onRuntimeEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, runtimeEvent: RuntimeEvent) => {
      callback(runtimeEvent);
    };
    ipcRenderer.on(IPC_CHANNELS.runtimeEvent, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.runtimeEvent, listener);
  },
};

contextBridge.exposeInMainWorld("duetRuntime", duetRuntime);
