import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  DEFAULT_READING_SETTINGS,
  IPC_CHANNELS,
  type CliActionRequest,
  type SonataRuntimeBridge,
  type PreviewBinding,
  type ReadingSettings,
  type ResolvedReadingMode,
  type RuntimeEvent,
  type TaskId,
  type TerminalActiveTaskState,
  type TerminalWindowState,
  type UpdaterState,
  normalizeReadingSettings,
} from "../shared/types";

const MAIN_WINDOW_ENTRY = "/index.html";
const PREVIEW_WINDOW_ENTRY = "/preview.html";
const TERMINAL_WINDOW_ENTRY = "/terminal.html";

/** The Reading (main) and Preview windows both FOLLOW the reading appearance
 *  (R6) — the preload stamps both on boot so neither flashes an unthemed frame.
 *  The terminal owns its own appearance (scheme + mode via its Aa picker); it
 *  is excluded EXPLICITLY and first. Its root carries `data-term-scheme`, never
 *  `data-theme`, so the content fallback below cannot sweep it into the
 *  reading-stamp path; the explicit pathname check is the belt on top. */
function isReadingThemedDocument(): boolean {
  const pathname = window.location.pathname;
  if (pathname.endsWith(TERMINAL_WINDOW_ENTRY)) {
    return false;
  }
  return (
    pathname.endsWith(MAIN_WINDOW_ENTRY) ||
    pathname.endsWith(PREVIEW_WINDOW_ENTRY) ||
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
  document.title = `Sonata — ${label}`;
}

if (isReadingThemedDocument()) {
  // The instance badge + first-frame probe are the Reading window's alone; the
  // Preview window only needs the theme/mode/textStep stamp.
  const isMainWindow = window.location.pathname.endsWith(MAIN_WINDOW_ENTRY);
  const bootReadingSettings = readBootReadingSettings();
  const stampBootSettings = (): void => {
    stampReadingSettings(bootReadingSettings);
    if (isMainWindow) {
      stampInstanceLabel(readBootInstanceLabel());
      captureFirstReadingFrame();
    }
  };

  // Keep the appearance stamp current for the Preview satellite across changes
  // (R6): a full reading-settings push (theme/mode/textStep) and — while in
  // auto mode — a system light/dark flip both re-stamp. The Reading window owns
  // this in its renderer, so this live path is Preview-only.
  if (!isMainWindow) {
    ipcRenderer.on(IPC_CHANNELS.readingSettingsChanged, (_event, settings: ReadingSettings) => {
      stampReadingSettings(normalizeReadingSettings(settings));
    });
    ipcRenderer.on(IPC_CHANNELS.readingSystemModeChanged, () => {
      // Re-resolve "auto" against the current system; an explicit light/dark
      // choice is pinned and unaffected.
      stampReadingSettings(readBootReadingSettings());
    });
  }

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

const sonataRuntime: SonataRuntimeBridge = {
  createTask: (request) => ipcRenderer.invoke(IPC_CHANNELS.taskCreate, request),
  openTask: (request) => ipcRenderer.invoke(IPC_CHANNELS.taskOpen, request),
  closeTask: (request) => ipcRenderer.invoke(IPC_CHANNELS.taskClose, request),
  listTasks: () => ipcRenderer.invoke(IPC_CHANNELS.taskList),
  readSessionIndex: (request) => ipcRenderer.invoke(IPC_CHANNELS.sessionIndexRead, request ?? {}),
  readSession: (request) => ipcRenderer.invoke(IPC_CHANNELS.sessionRead, request),
  renameSession: (request) => ipcRenderer.invoke(IPC_CHANNELS.sessionRename, request),
  archiveSession: (request) => ipcRenderer.invoke(IPC_CHANNELS.sessionArchive, request),
  setSessionTags: (request) => ipcRenderer.invoke(IPC_CHANNELS.sessionSetTags, request),
  deleteSession: (request) => ipcRenderer.invoke(IPC_CHANNELS.sessionDelete, request),
  revealSession: (request) => ipcRenderer.invoke(IPC_CHANNELS.sessionReveal, request),
  listTags: () => ipcRenderer.invoke(IPC_CHANNELS.tagsList),
  createTag: (request) => ipcRenderer.invoke(IPC_CHANNELS.tagsCreate, request),
  deleteTag: (request) => ipcRenderer.invoke(IPC_CHANNELS.tagsDelete, request),
  renameProject: (request) => ipcRenderer.invoke(IPC_CHANNELS.projectRename, request),
  archiveProject: (request) => ipcRenderer.invoke(IPC_CHANNELS.projectArchive, request),
  revealProject: (request) => ipcRenderer.invoke(IPC_CHANNELS.projectReveal, request),
  submitPrompt: (request) => ipcRenderer.invoke(IPC_CHANNELS.promptSubmit, request),
  createAttachment: (request) => ipcRenderer.invoke(IPC_CHANNELS.attachmentCreate, request),
  createReference: (request) => ipcRenderer.invoke(IPC_CHANNELS.attachmentCreateReference, request),
  pickReferences: () => ipcRenderer.invoke(IPC_CHANNELS.attachmentPick),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  decideApproval: (request) => ipcRenderer.invoke(IPC_CHANNELS.approvalDecide, request),
  answerOptionPrompt: (request) => ipcRenderer.invoke(IPC_CHANNELS.optionPromptAnswer, request),
  dismissOptionPrompt: (request) => ipcRenderer.invoke(IPC_CHANNELS.optionPromptDismiss, request),
  stopRun: (request) => ipcRenderer.invoke(IPC_CHANNELS.runStop, request),
  resizeTerminal: (request) => ipcRenderer.invoke(IPC_CHANNELS.terminalResize, request),
  writeTerminalUserInput: (request) => ipcRenderer.invoke(IPC_CHANNELS.terminalUserInput, request),
  replayTerminal: (request) => ipcRenderer.invoke(IPC_CHANNELS.terminalReplay, request),
  openTerminalLink: (request) => ipcRenderer.invoke(IPC_CHANNELS.terminalOpenLink, request),
  readClipboardText: () => ipcRenderer.invoke(IPC_CHANNELS.clipboardReadText),
  readReport: (request) => ipcRenderer.invoke(IPC_CHANNELS.reportRead, request),
  readTranscript: (request) => ipcRenderer.invoke(IPC_CHANNELS.transcriptRead, request),
  readUsage: (request) => ipcRenderer.invoke(IPC_CHANNELS.usageRead, request),
  readSlashCommands: (request) => ipcRenderer.invoke(IPC_CHANNELS.slashCommandsRead, request),
  injectRemoteControl: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.remoteControlInject, request),
  switchClaudeControl: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.claudeControlSwitch, request),
  switchClaudeStaged: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.claudeStagedSwitch, request),
  answerControlConfirm: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.controlConfirmAnswer, request),
  openPreview: (request) => ipcRenderer.invoke(IPC_CHANNELS.previewOpen, request),
  readPreviewBinding: () => ipcRenderer.invoke(IPC_CHANNELS.previewBindingRead),
  closePreviewTab: (request) => ipcRenderer.invoke(IPC_CHANNELS.previewClose, request),
  activatePreviewTab: (request) => ipcRenderer.invoke(IPC_CHANNELS.previewActivate, request),
  reorderPreviewTabs: (request) => ipcRenderer.invoke(IPC_CHANNELS.previewReorder, request),
  setPreviewScroll: (request) => ipcRenderer.invoke(IPC_CHANNELS.previewSetScroll, request),
  setPreviewPanel: (request) => ipcRenderer.invoke(IPC_CHANNELS.previewSetPanel, request),
  readWorkspaceDoc: (request) => ipcRenderer.invoke(IPC_CHANNELS.workspaceReadDoc, request),
  readWorkspaceDir: (request) => ipcRenderer.invoke(IPC_CHANNELS.workspaceReadDir, request),
  resolveWorkspacePaths: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceResolvePaths, request),
  statWorkspacePath: (request) => ipcRenderer.invoke(IPC_CHANNELS.workspaceStat, request),
  setTerminalWindowOpen: (open) => ipcRenderer.invoke(IPC_CHANNELS.terminalWindowSetOpen, open),
  readTerminalWindowState: () => ipcRenderer.invoke(IPC_CHANNELS.terminalWindowStateRead),
  setActiveTerminalTask: (state) => ipcRenderer.invoke(IPC_CHANNELS.terminalActiveTaskSet, state),
  readActiveTerminalTask: () => ipcRenderer.invoke(IPC_CHANNELS.terminalActiveTaskRead),
  requestCliAction: (request) => ipcRenderer.invoke(IPC_CHANNELS.cliActionRequest, request),
  readTerminalWindowSettings: () => ipcRenderer.invoke(IPC_CHANNELS.terminalWindowSettingsRead),
  writeTerminalWindowSettings: (settings) =>
    ipcRenderer.invoke(IPC_CHANNELS.terminalWindowSettingsWrite, settings),
  openWorkspaceExternal: (request) => ipcRenderer.invoke(IPC_CHANNELS.workspaceOpenExternal, request),
  openWorkspaceFolder: (request) => ipcRenderer.invoke(IPC_CHANNELS.workspaceOpenFolder, request),
  pickFolder: () => ipcRenderer.invoke(IPC_CHANNELS.folderPick),
  prepareResume: (request) => ipcRenderer.invoke(IPC_CHANNELS.resumePrepare, request),
  readResumeSettings: () => ipcRenderer.invoke(IPC_CHANNELS.resumeSettingsRead),
  writeResumeSettings: (settings) => ipcRenderer.invoke(IPC_CHANNELS.resumeSettingsWrite, settings),
  revertResumeBridge: () => ipcRenderer.invoke(IPC_CHANNELS.resumeBridgeRevert),
  readClaudeSettings: () => ipcRenderer.invoke(IPC_CHANNELS.claudeSettingsRead),
  writeClaudeSettings: (settings) => ipcRenderer.invoke(IPC_CHANNELS.claudeSettingsWrite, settings),
  readCodexSettings: () => ipcRenderer.invoke(IPC_CHANNELS.codexSettingsRead),
  writeCodexSettings: (settings) => ipcRenderer.invoke(IPC_CHANNELS.codexSettingsWrite, settings),
  readSonataSettings: () => ipcRenderer.invoke(IPC_CHANNELS.sonataSettingsRead),
  writeSonataSettings: (settings) => ipcRenderer.invoke(IPC_CHANNELS.sonataSettingsWrite, settings),
  readReadingSettings: () => ipcRenderer.invoke(IPC_CHANNELS.readingSettingsRead),
  writeReadingSettings: (settings) => ipcRenderer.invoke(IPC_CHANNELS.readingSettingsWrite, settings),
  onReadingSystemModeChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, mode: ResolvedReadingMode) => {
      callback(mode);
    };
    ipcRenderer.on(IPC_CHANNELS.readingSystemModeChanged, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.readingSystemModeChanged, listener);
  },
  onReadingSettingsChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, settings: ReadingSettings) => {
      callback(settings);
    };
    ipcRenderer.on(IPC_CHANNELS.readingSettingsChanged, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.readingSettingsChanged, listener);
  },
  onSettingsOpen: (callback) => {
    const listener = () => {
      callback();
    };
    ipcRenderer.on(IPC_CHANNELS.settingsOpen, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.settingsOpen, listener);
  },
  onNotificationActivateTask: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, taskId: TaskId) => {
      callback(taskId);
    };
    ipcRenderer.on(IPC_CHANNELS.notificationActivateTask, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.notificationActivateTask, listener);
  },
  onPreviewBinding: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, binding: PreviewBinding) => {
      callback(binding);
    };
    ipcRenderer.on(IPC_CHANNELS.previewBinding, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.previewBinding, listener);
  },
  onTerminalWindowState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: TerminalWindowState) => {
      callback(state);
    };
    ipcRenderer.on(IPC_CHANNELS.terminalWindowState, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.terminalWindowState, listener);
  },
  onActiveTerminalTask: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: TerminalActiveTaskState) => {
      callback(state);
    };
    ipcRenderer.on(IPC_CHANNELS.terminalActiveTask, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.terminalActiveTask, listener);
  },
  onCliAction: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, request: CliActionRequest) => {
      callback(request);
    };
    ipcRenderer.on(IPC_CHANNELS.cliAction, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.cliAction, listener);
  },
  onRuntimeEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, runtimeEvent: RuntimeEvent) => {
      callback(runtimeEvent);
    };
    ipcRenderer.on(IPC_CHANNELS.runtimeEvent, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.runtimeEvent, listener);
  },
  readUpdaterState: () => ipcRenderer.invoke(IPC_CHANNELS.updaterStateRead),
  requestUpdaterRestart: () => ipcRenderer.invoke(IPC_CHANNELS.updaterRestart),
  onUpdaterState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: UpdaterState) => {
      callback(state);
    };
    ipcRenderer.on(IPC_CHANNELS.updaterState, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.updaterState, listener);
  },
};

contextBridge.exposeInMainWorld("sonataRuntime", sonataRuntime);
