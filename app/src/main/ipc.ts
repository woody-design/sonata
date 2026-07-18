import { clipboard, ipcMain, shell } from "electron";
import {
  IPC_CHANNELS,
  isCliActionRequest,
  isTerminalActiveTaskState,
  type CliActionRequest,
  type ClipboardReadTextResponse,
  type FolderPickResponse,
  type OpenPreviewRequest,
  type OpenTerminalLinkRequest,
  type OpenTerminalLinkResponse,
  type PreviewActivateRequest,
  type PreviewBinding,
  type PreviewCloseRequest,
  type PreviewDocument,
  type PreviewReorderRequest,
  type PreviewSetPanelRequest,
  type PreviewSetScrollRequest,
  type ReadingSettings,
  type TaskId,
  type TerminalActiveTaskState,
  type TerminalWindowSettings,
  type TerminalWindowState,
  type WorkspaceDirEntry,
  type WorkspaceOpenExternalRequest,
  type WorkspaceOpenExternalResponse,
  type WorkspaceOpenFolderRequest,
  type WorkspaceReadDirRequest,
  type WorkspaceReadDocRequest,
  type WorkspaceResolvePathsRequest,
  type WorkspaceResolvePathsResult,
  type WorkspaceStatRequest,
  type WorkspaceStatResult,
} from "../shared/types";

// Links clicked in the terminal are UNTRUSTED — they come from whatever the CLI
// printed (or a hostile remote). Only web/mail schemes may reach the OS opener;
// everything else (file:, vscode:, custom app schemes that could trigger actions)
// is refused. The check lives here in the main process so a compromised renderer
// can't bypass it, and we open the re-serialized parsed URL, never the raw string.
const TERMINAL_LINK_ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

type IpcTestGate = "TASK_CREATE" | "TASK_OPEN" | "PROMPT_SUBMIT" | "RESUME_SETTINGS_WRITE";

// End-to-end lifecycle tests need to hold or reject an IPC boundary after the
// renderer has synchronously claimed ownership. Keep that seam at the real
// process boundary (rather than mocking renderer APIs) and inert unless an
// explicitly test-scoped launch variable is present.
async function passIpcTestGate(gate: IpcTestGate): Promise<void> {
  const delay = Number(process.env[`SONATA_TEST_${gate}_DELAY_MS`] ?? "0");
  if (Number.isFinite(delay) && delay > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(delay, 10_000)));
  }
  if (process.env[`SONATA_TEST_${gate}_FAIL`] === "1") {
    throw new Error(`Injected ${gate.toLowerCase()} failure.`);
  }
}

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
  openPreview(request: OpenPreviewRequest): Promise<void>;
  readPreviewBinding(): PreviewBinding;
  previewCloseTab(request: PreviewCloseRequest): void;
  previewActivateTab(request: PreviewActivateRequest): void;
  previewReorderTabs(request: PreviewReorderRequest): void;
  previewSetScroll(request: PreviewSetScrollRequest): void;
  previewSetPanel(request: PreviewSetPanelRequest): void;
  readWorkspaceDoc(request: WorkspaceReadDocRequest): PreviewDocument;
  readWorkspaceDir(request: WorkspaceReadDirRequest): WorkspaceDirEntry[];
  resolveWorkspacePaths(request: WorkspaceResolvePathsRequest): WorkspaceResolvePathsResult;
  statWorkspacePath(request: WorkspaceStatRequest): WorkspaceStatResult;
  broadcastReadingSettings(settings: ReadingSettings): void;
  setTerminalWindowOpen(open: boolean): Promise<TerminalWindowState>;
  readTerminalWindowState(): TerminalWindowState;
  readTerminalWindowSettings(): TerminalWindowSettings;
  writeTerminalWindowSettings(settings: TerminalWindowSettings): TerminalWindowSettings;
  setActiveTerminalTask(state: TerminalActiveTaskState, senderId: number): void;
  readActiveTerminalTask(): TerminalActiveTaskState;
  requestCliAction(request: CliActionRequest, senderId: number): void;
  openWorkspaceExternal(request: WorkspaceOpenExternalRequest): Promise<WorkspaceOpenExternalResponse>;
  openWorkspaceFolder(request: WorkspaceOpenFolderRequest): Promise<void>;
  pickFolder(): Promise<FolderPickResponse>;
  pickReferences(): Promise<string[]>;
  forgetPreviewSession(taskId: TaskId): void;
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
    event.returnValue = (process.env.SONATA_INSTANCE_LABEL ?? "").trim();
  });

  ipcMain.handle(IPC_CHANNELS.taskCreate, async (_event, request) => {
    await passIpcTestGate("TASK_CREATE");
    return runtimeController.createTask(request);
  });
  ipcMain.handle(IPC_CHANNELS.taskOpen, async (_event, request) => {
    await passIpcTestGate("TASK_OPEN");
    return runtimeController.openTask(request);
  });
  ipcMain.handle(IPC_CHANNELS.taskClose, (_event, request) => {
    runtimeController.closeTask(request.taskId);
  });
  ipcMain.handle(IPC_CHANNELS.taskList, () => runtimeController.listTasks());
  ipcMain.handle(IPC_CHANNELS.sessionIndexRead, (_event, request) =>
    runtimeController.readSessionIndex(request ?? {}),
  );
  ipcMain.handle(IPC_CHANNELS.sessionRead, (_event, request) =>
    runtimeController.readSessionSnapshot(request.taskId),
  );
  ipcMain.handle(IPC_CHANNELS.sessionRename, (_event, request) =>
    runtimeController.renameSession(request.taskId, request.title),
  );
  ipcMain.handle(IPC_CHANNELS.sessionArchive, (_event, request) => {
    runtimeController.archiveSession(request.taskId, request.archived);
  });
  ipcMain.handle(IPC_CHANNELS.sessionDelete, (_event, request) => {
    runtimeController.deleteSession(request.taskId);
    // A deleted session has no dormant record to return to — forget its preview
    // claims (close/archive keep theirs, per §6.1 task reading memory).
    windowController.forgetPreviewSession(request.taskId);
  });
  ipcMain.handle(IPC_CHANNELS.sessionReveal, (_event, request) => {
    const folder = runtimeController.sessionWorkingDirectory(request.taskId);
    return shell.openPath(folder);
  });
  ipcMain.handle(IPC_CHANNELS.projectRename, (_event, request) =>
    runtimeController.renameProject(request.path, request.displayName),
  );
  ipcMain.handle(IPC_CHANNELS.projectArchive, (_event, request) => {
    runtimeController.archiveProject(request.path, request.archived);
  });
  ipcMain.handle(IPC_CHANNELS.projectReveal, (_event, request) => {
    return shell.openPath(request.path);
  });
  ipcMain.handle(IPC_CHANNELS.promptSubmit, async (_event, request) => {
    await passIpcTestGate("PROMPT_SUBMIT");
    runtimeController.submitPrompt(request.taskId, request.text, request.attachments ?? []);
  });
  ipcMain.handle(IPC_CHANNELS.attachmentCreate, (_event, request) => {
    return runtimeController.createAttachment(request.taskId, request);
  });
  ipcMain.handle(IPC_CHANNELS.attachmentCreateReference, (_event, request) => {
    return runtimeController.createReference(request.paths);
  });
  ipcMain.handle(IPC_CHANNELS.attachmentPick, () => windowController.pickReferences());
  ipcMain.handle(IPC_CHANNELS.approvalDecide, (_event, request) => {
    runtimeController.decideApproval(request.taskId, request.decision, request.approvalId ?? null);
  });
  ipcMain.handle(IPC_CHANNELS.optionPromptAnswer, (_event, request) =>
    runtimeController.answerOptionPrompt(request.taskId, request.toolUseId, request.selections),
  );
  ipcMain.handle(IPC_CHANNELS.optionPromptDismiss, (_event, request) =>
    runtimeController.dismissOptionPrompt(request.taskId, request.toolUseId),
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
  ipcMain.handle(IPC_CHANNELS.terminalUserInput, (_event, request) => {
    runtimeController.writeTerminalUserInput(request.taskId, request.data);
  });
  ipcMain.handle(IPC_CHANNELS.terminalReplay, (_event, request) =>
    runtimeController.replayTerminal(request.taskId),
  );
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
  ipcMain.handle(IPC_CHANNELS.remoteControlInject, (_event, request) =>
    runtimeController.injectRemoteControl(request.taskId),
  );
  ipcMain.handle(IPC_CHANNELS.claudeControlSwitch, (_event, request) =>
    runtimeController.switchClaudeControl(
      request.taskId,
      request.kind,
      request.value,
      request.from,
    ),
  );
  ipcMain.handle(IPC_CHANNELS.claudeStagedSwitch, (_event, request) =>
    runtimeController.switchClaudeStaged(request.taskId, request.model, request.effort),
  );
  ipcMain.handle(IPC_CHANNELS.controlConfirmAnswer, (_event, request) =>
    runtimeController.answerControlConfirm(request.taskId, request.rowNumber),
  );
  ipcMain.handle(IPC_CHANNELS.previewOpen, (_event, request) =>
    windowController.openPreview(request),
  );
  ipcMain.handle(IPC_CHANNELS.previewBindingRead, () => windowController.readPreviewBinding());
  ipcMain.handle(IPC_CHANNELS.previewClose, (_event, request) => {
    windowController.previewCloseTab(request);
  });
  ipcMain.handle(IPC_CHANNELS.previewActivate, (_event, request) => {
    windowController.previewActivateTab(request);
  });
  ipcMain.handle(IPC_CHANNELS.previewReorder, (_event, request) => {
    windowController.previewReorderTabs(request);
  });
  ipcMain.handle(IPC_CHANNELS.previewSetScroll, (_event, request) => {
    windowController.previewSetScroll(request);
  });
  ipcMain.handle(IPC_CHANNELS.previewSetPanel, (_event, request) => {
    windowController.previewSetPanel(request);
  });
  ipcMain.handle(IPC_CHANNELS.terminalWindowSetOpen, (_event, open: boolean) =>
    windowController.setTerminalWindowOpen(open),
  );
  ipcMain.handle(IPC_CHANNELS.terminalWindowStateRead, () =>
    windowController.readTerminalWindowState(),
  );
  ipcMain.handle(IPC_CHANNELS.terminalActiveTaskSet, (event, state: unknown) => {
    if (!isTerminalActiveTaskState(state)) {
      throw new Error("Invalid CLI binding.");
    }
    windowController.setActiveTerminalTask(state, event.sender.id);
  });
  ipcMain.handle(IPC_CHANNELS.terminalActiveTaskRead, () =>
    windowController.readActiveTerminalTask(),
  );
  ipcMain.handle(IPC_CHANNELS.cliActionRequest, (event, request: unknown) => {
    if (!isCliActionRequest(request)) {
      throw new Error("Invalid CLI action.");
    }
    windowController.requestCliAction(request, event.sender.id);
  });
  ipcMain.handle(IPC_CHANNELS.terminalWindowSettingsRead, () =>
    windowController.readTerminalWindowSettings(),
  );
  ipcMain.handle(IPC_CHANNELS.terminalWindowSettingsWrite, (_event, settings) =>
    windowController.writeTerminalWindowSettings(settings),
  );
  ipcMain.handle(IPC_CHANNELS.workspaceReadDoc, (_event, request) =>
    windowController.readWorkspaceDoc(request),
  );
  ipcMain.handle(IPC_CHANNELS.workspaceReadDir, (_event, request) =>
    windowController.readWorkspaceDir(request),
  );
  ipcMain.handle(IPC_CHANNELS.workspaceResolvePaths, (_event, request) =>
    windowController.resolveWorkspacePaths(request),
  );
  ipcMain.handle(IPC_CHANNELS.workspaceStat, (_event, request) =>
    windowController.statWorkspacePath(request),
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
  ipcMain.handle(IPC_CHANNELS.resumeSettingsWrite, async (_event, request) => {
    await passIpcTestGate("RESUME_SETTINGS_WRITE");
    return runtimeController.writeResumeSettings(request);
  });
  ipcMain.handle(IPC_CHANNELS.resumeBridgeRevert, () => runtimeController.revertResumeBridge());
  ipcMain.handle(IPC_CHANNELS.claudeSettingsRead, () => runtimeController.readClaudeSettings());
  ipcMain.handle(IPC_CHANNELS.claudeSettingsWrite, (_event, request) =>
    runtimeController.writeClaudeSettings(request),
  );
  ipcMain.handle(IPC_CHANNELS.codexSettingsRead, () => runtimeController.readCodexSettings());
  ipcMain.handle(IPC_CHANNELS.codexSettingsWrite, (_event, request) =>
    runtimeController.writeCodexSettings(request),
  );
  ipcMain.handle(IPC_CHANNELS.readingSettingsRead, () => readingSettingsStore.read());
  ipcMain.handle(IPC_CHANNELS.readingSettingsWrite, (_event, request) => {
    const persisted = readingSettingsStore.write(request);
    // Satellites that follow the reading appearance (Preview) re-stamp on this
    // push — the main renderer already applied locally (R6).
    windowController.broadcastReadingSettings(persisted);
    return persisted;
  });
}
