import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../shared/types";
import type { RuntimeController } from "./runtime-controller";

export function registerIpcHandlers(runtimeController: RuntimeController): void {
  ipcMain.handle(IPC_CHANNELS.taskCreate, (_event, request) =>
    runtimeController.createTask(request),
  );
  ipcMain.handle(IPC_CHANNELS.taskOpen, (_event, request) =>
    runtimeController.openTask(request),
  );
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
}
