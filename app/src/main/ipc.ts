import { ipcMain } from "electron";
import {
  IPC_CHANNELS,
  type InspectorWindowState,
  type OpenInspectorRequest,
  type OpenPreviewRequest,
  type PreviewWindowState,
  type TaskId,
  type WorkspaceOpenFolderRequest,
} from "../shared/types";
import type { RuntimeController } from "./runtime-controller";

export interface WindowIpcController {
  openPreview(request: OpenPreviewRequest): Promise<PreviewWindowState>;
  readPreviewState(): PreviewWindowState;
  openInspector(request: OpenInspectorRequest): Promise<InspectorWindowState>;
  readInspectorState(): InspectorWindowState;
  openWorkspaceFolder(request: WorkspaceOpenFolderRequest): Promise<void>;
  closeTaskSurfaces(taskId: TaskId): void;
}

export function registerIpcHandlers(
  runtimeController: RuntimeController,
  windowController: WindowIpcController,
): void {
  ipcMain.handle(IPC_CHANNELS.taskCreate, (_event, request) =>
    runtimeController.createTask(request),
  );
  ipcMain.handle(IPC_CHANNELS.taskOpen, (_event, request) =>
    runtimeController.openTask(request),
  );
  ipcMain.handle(IPC_CHANNELS.taskClose, (_event, request) => {
    runtimeController.closeTask(request.taskId);
    windowController.closeTaskSurfaces(request.taskId);
  });
  ipcMain.handle(IPC_CHANNELS.promptSubmit, (_event, request) => {
    runtimeController.submitPrompt(request.taskId, request.text);
  });
  ipcMain.handle(IPC_CHANNELS.approvalDecide, (_event, request) => {
    runtimeController.decideApproval(request.taskId, request.decision);
  });
  ipcMain.handle(IPC_CHANNELS.runStop, (_event, request) =>
    runtimeController.stopRun(request.taskId, {
      inspectDelayMs: request.inspectDelayMs,
      forceSlashStop: request.forceSlashStop,
    }),
  );
  ipcMain.handle(IPC_CHANNELS.terminalResize, (_event, request) => {
    runtimeController.resizeTerminal(request.taskId, request.cols, request.rows);
  });
  ipcMain.handle(IPC_CHANNELS.reportRead, (_event, request) =>
    runtimeController.readReport(request.taskId),
  );
  ipcMain.handle(IPC_CHANNELS.artifactList, (_event, request) =>
    runtimeController.listArtifacts(request.taskId),
  );
  ipcMain.handle(IPC_CHANNELS.artifactRead, (_event, request) =>
    runtimeController.readArtifact(request.taskId, request.relativePath),
  );
  ipcMain.handle(IPC_CHANNELS.previewOpen, (_event, request) =>
    windowController.openPreview(request),
  );
  ipcMain.handle(IPC_CHANNELS.previewStateRead, () => windowController.readPreviewState());
  ipcMain.handle(IPC_CHANNELS.inspectorOpen, (_event, request) =>
    windowController.openInspector(request),
  );
  ipcMain.handle(IPC_CHANNELS.inspectorStateRead, () => windowController.readInspectorState());
  ipcMain.handle(IPC_CHANNELS.workspaceTreeRead, (_event, request) =>
    runtimeController.readWorkspaceTree(request.taskId),
  );
  ipcMain.handle(IPC_CHANNELS.workspaceFileRead, (_event, request) =>
    runtimeController.readWorkspaceFile(request.taskId, request.relativePath),
  );
  ipcMain.handle(IPC_CHANNELS.workspaceOpenFolder, (_event, request) =>
    windowController.openWorkspaceFolder(request),
  );
}
