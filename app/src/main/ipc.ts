import { clipboard, ipcMain, shell } from "electron";
import {
  IPC_CHANNELS,
  type ClipboardReadTextResponse,
  type FolderPickResponse,
  type FocusArtifactInMainRequest,
  type InspectorWindowState,
  type MarkPreviewReviewedRequest,
  type OpenInspectorRequest,
  type OpenPreviewRequest,
  type OpenTerminalLinkRequest,
  type OpenTerminalLinkResponse,
  type PreviewWindowState,
  type TaskId,
  type WorkspaceOpenExternalRequest,
  type WorkspaceOpenExternalResponse,
  type WorkspaceOpenFolderRequest,
} from "../shared/types";

// Links clicked in the terminal are UNTRUSTED — they come from whatever the CLI
// printed (or a hostile remote). Only web/mail schemes may reach the OS opener;
// everything else (file:, vscode:, custom app schemes that could trigger actions)
// is refused. The check lives here in the main process so a compromised renderer
// can't bypass it, and we open the re-serialized parsed URL, never the raw string.
const TERMINAL_LINK_ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function openExternalIfAllowed(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (!TERMINAL_LINK_ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return false;
  }
  void shell.openExternal(parsed.toString());
  return true;
}
import type { ReadingSettingsStore } from "./settings-store";
import type { RuntimeController } from "./runtime-controller";

export interface WindowIpcController {
  openPreview(request: OpenPreviewRequest): Promise<PreviewWindowState>;
  markPreviewReviewed(request: MarkPreviewReviewedRequest): PreviewWindowState;
  readPreviewState(): PreviewWindowState;
  focusArtifactInMain(request: FocusArtifactInMainRequest): void;
  openInspector(request: OpenInspectorRequest): Promise<InspectorWindowState>;
  readInspectorState(): InspectorWindowState;
  openWorkspaceExternal(request: WorkspaceOpenExternalRequest): Promise<WorkspaceOpenExternalResponse>;
  openWorkspaceFolder(request: WorkspaceOpenFolderRequest): Promise<void>;
  pickFolder(): Promise<FolderPickResponse>;
  closeTaskSurfaces(taskId: TaskId): void;
}

export function registerIpcHandlers(
  runtimeController: RuntimeController,
  windowController: WindowIpcController,
  readingSettingsStore: ReadingSettingsStore,
): void {
  ipcMain.on(IPC_CHANNELS.readingSettingsReadSync, (event) => {
    event.returnValue = readingSettingsStore.read();
  });

  ipcMain.on(IPC_CHANNELS.instanceLabelReadSync, (event) => {
    // Drives the instance badge. Read from the launch env so the same build
    // shows the badge only when the launcher sets it (the workshop does; the
    // daily driver does not) — nothing branch-specific to promote.
    event.returnValue = (process.env.DUET_INSTANCE_LABEL ?? "").trim();
  });

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
  ipcMain.handle(IPC_CHANNELS.taskList, () => runtimeController.listTasks());
  ipcMain.handle(IPC_CHANNELS.sessionIndexRead, (_event, request) =>
    runtimeController.readSessionIndex(request ?? {}),
  );
  ipcMain.handle(IPC_CHANNELS.sessionRead, (_event, request) =>
    runtimeController.readSessionSnapshot(request.taskId),
  );
  ipcMain.handle(IPC_CHANNELS.sessionRename, (_event, request) => {
    runtimeController.renameSession(request.taskId, request.title);
  });
  ipcMain.handle(IPC_CHANNELS.sessionArchive, (_event, request) => {
    runtimeController.archiveSession(request.taskId, request.archived);
    if (request.archived) {
      windowController.closeTaskSurfaces(request.taskId);
    }
  });
  ipcMain.handle(IPC_CHANNELS.sessionDelete, (_event, request) => {
    runtimeController.deleteSession(request.taskId);
    windowController.closeTaskSurfaces(request.taskId);
  });
  ipcMain.handle(IPC_CHANNELS.sessionReveal, (_event, request) => {
    const folder = runtimeController.sessionWorkingDirectory(request.taskId);
    return shell.openPath(folder);
  });
  ipcMain.handle(IPC_CHANNELS.projectRename, (_event, request) => {
    runtimeController.renameProject(request.path, request.displayName);
  });
  ipcMain.handle(IPC_CHANNELS.projectArchive, (_event, request) => {
    runtimeController.archiveProject(request.path, request.archived);
  });
  ipcMain.handle(IPC_CHANNELS.projectReveal, (_event, request) => {
    return shell.openPath(request.path);
  });
  ipcMain.handle(IPC_CHANNELS.promptSubmit, (_event, request) => {
    runtimeController.submitPrompt(request.taskId, request.text, request.attachments ?? []);
  });
  ipcMain.handle(IPC_CHANNELS.attachmentCreate, (_event, request) => {
    return runtimeController.createAttachment(request.taskId, request);
  });
  ipcMain.handle(IPC_CHANNELS.attachmentDelete, (_event, request) => {
    runtimeController.deleteAttachment(request.taskId, request.attachmentId);
  });
  ipcMain.handle(IPC_CHANNELS.controlSet, (_event, request) => {
    return runtimeController.setControl(request.taskId, request.change);
  });
  ipcMain.handle(IPC_CHANNELS.promptQueueCancel, (_event, request) => {
    runtimeController.cancelQueuedPrompt(request.taskId, request.itemId);
  });
  ipcMain.handle(IPC_CHANNELS.promptQueueRetry, (_event, request) => {
    runtimeController.retryQueuedPrompt(request.taskId, request.itemId);
  });
  ipcMain.handle(IPC_CHANNELS.approvalDecide, (_event, request) => {
    runtimeController.decideApproval(request.taskId, request.decision);
  });
  ipcMain.handle(IPC_CHANNELS.optionPromptAnswer, (_event, request) =>
    runtimeController.answerOptionPrompt(request.taskId, request.toolUseId, request.optionIndices),
  );
  ipcMain.handle(IPC_CHANNELS.runStop, (_event, request) =>
    runtimeController.stopRun(request.taskId, {
      inspectDelayMs: request.inspectDelayMs,
      forceSlashStop: request.forceSlashStop,
    }),
  );
  ipcMain.handle(IPC_CHANNELS.terminalResize, (_event, request) => {
    runtimeController.resizeTerminal(request.taskId, request.cols, request.rows);
  });
  ipcMain.handle(IPC_CHANNELS.terminalUserControlSet, (_event, request) =>
    runtimeController.setTerminalUserControl(request.taskId, request.active),
  );
  ipcMain.handle(IPC_CHANNELS.terminalUserInput, (_event, request) => {
    runtimeController.writeTerminalUserInput(request.taskId, request.data);
  });
  ipcMain.handle(IPC_CHANNELS.terminalComposing, (_event, request) => {
    runtimeController.setTerminalComposing(request.taskId, request.composing);
  });
  ipcMain.handle(
    IPC_CHANNELS.terminalOpenLink,
    (_event, request: OpenTerminalLinkRequest): OpenTerminalLinkResponse => ({
      opened: openExternalIfAllowed(request.url),
    }),
  );
  ipcMain.handle(
    IPC_CHANNELS.clipboardReadText,
    (): ClipboardReadTextResponse => ({ text: clipboard.readText() }),
  );
  ipcMain.handle(IPC_CHANNELS.reportRead, (_event, request) =>
    runtimeController.readReport(request.taskId),
  );
  ipcMain.handle(IPC_CHANNELS.transcriptRead, (_event, request) =>
    runtimeController.readTranscript(request.taskId),
  );
  ipcMain.handle(IPC_CHANNELS.usageRead, (_event, request) =>
    runtimeController.readUsage(request.taskId),
  );
  ipcMain.handle(IPC_CHANNELS.slashCommandsRead, (_event, request) =>
    runtimeController.listSlashCommands(request ?? {}),
  );
  ipcMain.handle(IPC_CHANNELS.modalDismiss, (_event, request) =>
    runtimeController.dismissModal(request.taskId),
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
  ipcMain.handle(IPC_CHANNELS.previewReviewedMark, (_event, request) =>
    windowController.markPreviewReviewed(request),
  );
  ipcMain.handle(IPC_CHANNELS.previewStateRead, () => windowController.readPreviewState());
  ipcMain.handle(IPC_CHANNELS.mainArtifactFocusRequest, (_event, request) => {
    windowController.focusArtifactInMain(request);
  });
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
  ipcMain.handle(IPC_CHANNELS.workspaceOpenExternal, (_event, request) =>
    windowController.openWorkspaceExternal(request),
  );
  ipcMain.handle(IPC_CHANNELS.workspaceOpenFolder, (_event, request) =>
    windowController.openWorkspaceFolder(request),
  );
  ipcMain.handle(IPC_CHANNELS.folderPick, () => windowController.pickFolder());
  ipcMain.handle(IPC_CHANNELS.resumePrepare, (_event, request) =>
    runtimeController.prepareResume(request.taskId),
  );
  ipcMain.handle(IPC_CHANNELS.resumeSettingsRead, () => runtimeController.readResumeSettings());
  ipcMain.handle(IPC_CHANNELS.resumeSettingsWrite, (_event, request) =>
    runtimeController.writeResumeSettings(request),
  );
  ipcMain.handle(IPC_CHANNELS.resumeBridgeRevert, () => runtimeController.revertResumeBridge());
  ipcMain.handle(IPC_CHANNELS.claudeSettingsRead, () => runtimeController.readClaudeSettings());
  ipcMain.handle(IPC_CHANNELS.claudeSettingsWrite, (_event, request) =>
    runtimeController.writeClaudeSettings(request),
  );
  ipcMain.handle(IPC_CHANNELS.readingSettingsRead, () => readingSettingsStore.read());
  ipcMain.handle(IPC_CHANNELS.readingSettingsWrite, (_event, request) =>
    readingSettingsStore.write(request),
  );
}
