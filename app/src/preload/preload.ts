import { contextBridge, ipcRenderer } from "electron";
import {
  DEFAULT_READING_SETTINGS,
  IPC_CHANNELS,
  type DuetRuntimeBridge,
  type FocusArtifactInMainRequest,
  type InspectorWindowState,
  type PreviewWindowState,
  type ReadingSettings,
  type ResolvedReadingMode,
  type RuntimeEvent,
  normalizeReadingSettings,
} from "../shared/types";

const MAIN_WINDOW_ENTRY = "/index.html";

function isMainWindowDocument(): boolean {
  return (
    window.location.pathname.endsWith(MAIN_WINDOW_ENTRY) ||
    document.documentElement?.dataset.theme === DEFAULT_READING_SETTINGS.theme
  );
}

function readBootReadingSettings(): ReadingSettings {
  try {
    return normalizeReadingSettings(ipcRenderer.sendSync(IPC_CHANNELS.readingSettingsReadSync));
  } catch {
    return { ...DEFAULT_READING_SETTINGS };
  }
}

function resolvedMode(settings: ReadingSettings): "light" | "dark" {
  if (settings.mode !== "auto") {
    return settings.mode;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function stampReadingSettings(settings: ReadingSettings): void {
  const root = document.documentElement;
  if (!root) {
    return;
  }
  root.dataset.theme = settings.theme;
  root.dataset.mode = resolvedMode(settings);
  root.dataset.readingModeSetting = settings.mode;
  root.dataset.textStep = String(settings.textStep);
}

function captureFirstReadingFrame(): void {
  window.requestAnimationFrame(() => {
    const root = document.documentElement;
    if (!root) {
      return;
    }
    const textBody = window.getComputedStyle(root).getPropertyValue("--text-body").trim();
    root.dataset.readingFirstFrame = [
      root.dataset.theme ?? "",
      root.dataset.mode ?? "",
      textBody,
    ].join("/");
  });
}

function readBootInstanceLabel(): string {
  try {
    const value = ipcRenderer.sendSync(IPC_CHANNELS.instanceLabelReadSync);
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

function stampInstanceLabel(label: string): void {
  if (!label) {
    return;
  }
  const root = document.documentElement;
  if (!root) {
    return;
  }
  root.dataset.instanceLabel = label;
  root.style.setProperty("--instance-label", JSON.stringify(label));
  document.title = `Duet — ${label}`;
}

if (isMainWindowDocument()) {
  const bootReadingSettings = readBootReadingSettings();
  const bootInstanceLabel = readBootInstanceLabel();
  const stampBootSettings = (): void => {
    stampReadingSettings(bootReadingSettings);
    stampInstanceLabel(bootInstanceLabel);
    captureFirstReadingFrame();
  };

  if (document.documentElement) {
    stampBootSettings();
  } else {
    const observer = new MutationObserver(() => {
      if (!document.documentElement) {
        return;
      }
      observer.disconnect();
      stampBootSettings();
    });
    observer.observe(document, { childList: true });
  }
}

const duetRuntime: DuetRuntimeBridge = {
  createTask: (request) => ipcRenderer.invoke(IPC_CHANNELS.taskCreate, request),
  openTask: (request) => ipcRenderer.invoke(IPC_CHANNELS.taskOpen, request),
  closeTask: (request) => ipcRenderer.invoke(IPC_CHANNELS.taskClose, request),
  listTasks: () => ipcRenderer.invoke(IPC_CHANNELS.taskList),
  readSessionIndex: (request) => ipcRenderer.invoke(IPC_CHANNELS.sessionIndexRead, request ?? {}),
  readSession: (request) => ipcRenderer.invoke(IPC_CHANNELS.sessionRead, request),
  renameSession: (request) => ipcRenderer.invoke(IPC_CHANNELS.sessionRename, request),
  archiveSession: (request) => ipcRenderer.invoke(IPC_CHANNELS.sessionArchive, request),
  deleteSession: (request) => ipcRenderer.invoke(IPC_CHANNELS.sessionDelete, request),
  revealSession: (request) => ipcRenderer.invoke(IPC_CHANNELS.sessionReveal, request),
  renameProject: (request) => ipcRenderer.invoke(IPC_CHANNELS.projectRename, request),
  archiveProject: (request) => ipcRenderer.invoke(IPC_CHANNELS.projectArchive, request),
  revealProject: (request) => ipcRenderer.invoke(IPC_CHANNELS.projectReveal, request),
  submitPrompt: (request) => ipcRenderer.invoke(IPC_CHANNELS.promptSubmit, request),
  createAttachment: (request) => ipcRenderer.invoke(IPC_CHANNELS.attachmentCreate, request),
  deleteAttachment: (request) => ipcRenderer.invoke(IPC_CHANNELS.attachmentDelete, request),
  setControl: (request) => ipcRenderer.invoke(IPC_CHANNELS.controlSet, request),
  cancelQueuedPrompt: (request) => ipcRenderer.invoke(IPC_CHANNELS.promptQueueCancel, request),
  retryQueuedPrompt: (request) => ipcRenderer.invoke(IPC_CHANNELS.promptQueueRetry, request),
  decideApproval: (request) => ipcRenderer.invoke(IPC_CHANNELS.approvalDecide, request),
  answerOptionPrompt: (request) => ipcRenderer.invoke(IPC_CHANNELS.optionPromptAnswer, request),
  stopRun: (request) => ipcRenderer.invoke(IPC_CHANNELS.runStop, request),
  resizeTerminal: (request) => ipcRenderer.invoke(IPC_CHANNELS.terminalResize, request),
  setTerminalUserControl: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.terminalUserControlSet, request),
  writeTerminalUserInput: (request) => ipcRenderer.invoke(IPC_CHANNELS.terminalUserInput, request),
  setTerminalComposing: (request) => ipcRenderer.invoke(IPC_CHANNELS.terminalComposing, request),
  openTerminalLink: (request) => ipcRenderer.invoke(IPC_CHANNELS.terminalOpenLink, request),
  readClipboardText: () => ipcRenderer.invoke(IPC_CHANNELS.clipboardReadText),
  readReport: (request) => ipcRenderer.invoke(IPC_CHANNELS.reportRead, request),
  readTranscript: (request) => ipcRenderer.invoke(IPC_CHANNELS.transcriptRead, request),
  readUsage: (request) => ipcRenderer.invoke(IPC_CHANNELS.usageRead, request),
  readSlashCommands: (request) => ipcRenderer.invoke(IPC_CHANNELS.slashCommandsRead, request),
  dismissModal: (request) => ipcRenderer.invoke(IPC_CHANNELS.modalDismiss, request),
  listArtifacts: (request) => ipcRenderer.invoke(IPC_CHANNELS.artifactList, request),
  readArtifact: (request) => ipcRenderer.invoke(IPC_CHANNELS.artifactRead, request),
  openPreview: (request) => ipcRenderer.invoke(IPC_CHANNELS.previewOpen, request),
  markPreviewReviewed: (request) => ipcRenderer.invoke(IPC_CHANNELS.previewReviewedMark, request),
  readPreviewState: () => ipcRenderer.invoke(IPC_CHANNELS.previewStateRead),
  focusArtifactInMain: (request) => ipcRenderer.invoke(IPC_CHANNELS.mainArtifactFocusRequest, request),
  openInspector: (request) => ipcRenderer.invoke(IPC_CHANNELS.inspectorOpen, request),
  readInspectorState: () => ipcRenderer.invoke(IPC_CHANNELS.inspectorStateRead),
  readWorkspaceTree: (request) => ipcRenderer.invoke(IPC_CHANNELS.workspaceTreeRead, request),
  readWorkspaceFile: (request) => ipcRenderer.invoke(IPC_CHANNELS.workspaceFileRead, request),
  openWorkspaceExternal: (request) => ipcRenderer.invoke(IPC_CHANNELS.workspaceOpenExternal, request),
  openWorkspaceFolder: (request) => ipcRenderer.invoke(IPC_CHANNELS.workspaceOpenFolder, request),
  pickFolder: () => ipcRenderer.invoke(IPC_CHANNELS.folderPick),
  prepareResume: (request) => ipcRenderer.invoke(IPC_CHANNELS.resumePrepare, request),
  readResumeSettings: () => ipcRenderer.invoke(IPC_CHANNELS.resumeSettingsRead),
  writeResumeSettings: (settings) => ipcRenderer.invoke(IPC_CHANNELS.resumeSettingsWrite, settings),
  revertResumeBridge: () => ipcRenderer.invoke(IPC_CHANNELS.resumeBridgeRevert),
  readClaudeSettings: () => ipcRenderer.invoke(IPC_CHANNELS.claudeSettingsRead),
  writeClaudeSettings: (settings) => ipcRenderer.invoke(IPC_CHANNELS.claudeSettingsWrite, settings),
  readReadingSettings: () => ipcRenderer.invoke(IPC_CHANNELS.readingSettingsRead),
  writeReadingSettings: (settings) => ipcRenderer.invoke(IPC_CHANNELS.readingSettingsWrite, settings),
  onReadingSystemModeChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, mode: ResolvedReadingMode) => {
      callback(mode);
    };
    ipcRenderer.on(IPC_CHANNELS.readingSystemModeChanged, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.readingSystemModeChanged, listener);
  },
  onSettingsOpen: (callback) => {
    const listener = () => {
      callback();
    };
    ipcRenderer.on(IPC_CHANNELS.settingsOpen, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.settingsOpen, listener);
  },
  onPreviewState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, previewState: PreviewWindowState) => {
      callback(previewState);
    };
    ipcRenderer.on(IPC_CHANNELS.previewState, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.previewState, listener);
  },
  onMainArtifactFocus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, request: FocusArtifactInMainRequest) => {
      callback(request);
    };
    ipcRenderer.on(IPC_CHANNELS.mainArtifactFocus, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.mainArtifactFocus, listener);
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
