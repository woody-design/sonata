import fs from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeTheme,
  protocol,
  screen,
  shell,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
} from "electron";
import {
  DEFAULT_TERMINAL_WINDOW_SETTINGS,
  IPC_CHANNELS,
  normalizeTerminalWindowSettings,
  type CliActionRequest,
  type CliReadinessFacts,
  type CliSetupRun,
  type CliSetupRunData,
  type CliSetupRunInputRequest,
  type CliSetupRunRequest,
  type CliSetupRunResizeRequest,
  type CliSetupRunSnapshot,
  type FolderPickResponse,
  type OpenPreviewRequest,
  type PreviewActivateRequest,
  type PreviewBinding,
  type PreviewCloseRequest,
  type PreviewDocument,
  type PreviewReorderRequest,
  type PreviewSetPanelRequest,
  type PreviewSetScrollRequest,
  type QuitConfirmAnswer,
  type ReadingSettings,
  type RuntimeEvent,
  type TaskId,
  type TerminalActiveTaskState,
  type TerminalWindowSettings,
  type TerminalWindowState,
  type UpdaterState,
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
import { registerIpcHandlers } from "./ipc";
import {
  planInitialWindowPair,
  type InitialWindowBounds,
  type InitialWindowPair,
} from "./initial-window-layout";
import { NotificationController } from "./notification-controller";
import { PreviewSessions } from "./preview-sessions";
import { createRuntimeEventRecorder } from "./runtime-event-recorder";
import { createPerfLog } from "./perf-log";
import { RuntimeController } from "./runtime-controller";
import { UpdaterController } from "./updater/updater-controller";
import { CliUpdater } from "./cli-updater/cli-updater";
import { CliReadiness } from "./cli-readiness/cli-readiness";
import { CliSetupRunController } from "./cli-readiness/setup-run";
import { buildUpdaterDialog } from "./updater/updater-interactive";
import {
  buildQuitDialog,
  decideQuitRequest,
  decideWindowClose,
  quitConfirmRequestFrom,
  type QuitAskHost,
  type QuitDialogSpec,
} from "./quit-guard";
import { WorkspaceFiles } from "./workspace-files";
import {
  ClaudeSettingsStore,
  CodexSettingsStore,
  LocalApiSettingsStore,
  PreviewSessionsStore,
  ReadingSettingsStore,
  ResumeSettingsStore,
  SonataSettingsStore,
  TerminalWindowSettingsStore,
  WindowStateStore,
  claudeSettingsPath,
  codexSettingsPath,
  localApiSettingsPath,
  previewSessionsPath,
  readingSettingsPath,
  resumeSettingsPath,
  sonataSettingsPath,
  terminalWindowSettingsPath,
  windowStatePath,
} from "./settings-store";
import { WindowStateManager, type WindowDefaults } from "./window-state";
import { LocalApiServer, localApiSocketPath } from "./local-api/local-api-server";
import { ProjectsStore, projectsStorePath } from "./projects-store";
import { TagsStore, tagsStorePath } from "./tags-store";

// The `sonata-file://` scheme serves a task workspace's local images to the
// Preview reader (design record §4/§6.1). It MUST be registered as privileged
// BEFORE `app` is ready — this runs at module load, before `whenReady`. It is
// `standard` so `sonata-file://<taskId>/<path>` parses hierarchically (host +
// path) and relative `./img.png` resolution behaves like a normal URL; `secure`
// so it is a trustworthy origin; `supportFetchAPI` so <img> subresource loads
// resolve cleanly. The handler (registered at ready) serves image bytes ONLY —
// everything else is a 404 (WorkspaceFiles.readImage is the whole gate).
protocol.registerSchemesAsPrivileged([
  {
    scheme: "sonata-file",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

let mainWindow: BrowserWindow | null = null;
let previewWindow: BrowserWindow | null = null;
let terminalWindow: BrowserWindow | null = null;
let runtimeController: RuntimeController | null = null;
let notificationController: NotificationController | null = null;
let updaterController: UpdaterController | null = null;
let cliUpdater: CliUpdater | null = null;
let cliReadiness: CliReadiness | null = null;
let cliSetupRun: CliSetupRunController | null = null;
let readingSettingsStore: ReadingSettingsStore | null = null;
let terminalWindowSettingsStore: TerminalWindowSettingsStore | null = null;
let localApiServer: LocalApiServer | null = null;
// Distinguishes a user closing the terminal window (persist closed) from the
// app quitting (leave the open preference intact, so it reopens next launch).
let isQuitting = false;
// Preview window session truth + disk seam (design record §6). The window binds
// ONE task at a time and follows the Reading window's active task; the bound id
// is the projection key.
let previewSessions: PreviewSessions | null = null;
let workspaceFiles: WorkspaceFiles | null = null;
let previewBoundTaskId: TaskId | null = null;
// Which task the terminal window shows. Owned by the main renderer (the
// selected-task concept is its UI state); relayed here for the terminal window.
let activeTerminalTask: TerminalActiveTaskState = {
  taskId: null,
  live: false,
  openTaskIds: [],
  projectName: "Tasks",
  sessionTitle: "New task",
  emptySurface: { kind: "fresh", phase: "ready", disabledReason: "Loading task settings" },
};
let windowState: WindowStateManager | null = null;

// ── Runtime-event interest routing (OBS S5 / D5) ─────────────────────────────
// `sendEvent` structured-clones each RuntimeEvent once PER window. The Terminal
// and Preview renderers each consume a tiny, fixed slice of the stream and
// deserialize-and-drop the rest; at a 200/s pty:data firehose that dead
// serialization dominates (audit A/F2). Route by WINDOW IDENTITY so main never
// serializes an event a window provably ignores.
//
// The interest sets are derived from the ONLY `onRuntimeEvent` consumer in each
// window's renderer and MUST track it:
//   - Terminal (renderer/terminal.ts) branches on exactly "pty:exit" and
//     "pty:data" — nothing else. Its binding / cli-action data arrives on
//     dedicated IPC channels, not this broadcast.
//   - Preview (renderer/preview/main.ts `reconcile`) branches on exactly
//     "file:changed". Its preview binding arrives on the dedicated
//     `previewBinding` channel, not this broadcast.
// The Reading (main) window — and ANY window whose identity we do not recognize
// — receives the full stream: fail-open, so a future window is never silently
// starved. The explicit `RuntimeEvent["type"]` element type makes each literal
// a compile-checked event name (a rename upstream would fail the build here).
const TERMINAL_WINDOW_EVENTS: ReadonlySet<RuntimeEvent["type"]> = new Set<RuntimeEvent["type"]>([
  "pty:data",
  "pty:exit",
]);
const PREVIEW_WINDOW_EVENTS: ReadonlySet<RuntimeEvent["type"]> = new Set<RuntimeEvent["type"]>([
  "file:changed",
]);

/** Whether `window` consumes `event` — identity match against the tracked
 *  window refs; unknown windows fail open (receive everything). */
function windowAcceptsEvent(window: BrowserWindow, event: RuntimeEvent): boolean {
  if (window === terminalWindow) {
    return TERMINAL_WINDOW_EVENTS.has(event.type);
  }
  if (window === previewWindow) {
    return PREVIEW_WINDOW_EVENTS.has(event.type);
  }
  return true; // main window + fail-open for any future/unknown window
}

const MAIN_WINDOW_DEFAULTS: WindowDefaults = {
  width: 1200,
  height: 820,
  minWidth: 720,
  minHeight: 640,
};
const PREVIEW_WINDOW_DEFAULTS: WindowDefaults = {
  width: 980,
  height: 760,
  minWidth: 560,
  minHeight: 420,
};
const TERMINAL_WINDOW_DEFAULTS: WindowDefaults = {
  width: 680,
  height: 820,
  minWidth: 420,
  minHeight: 360,
};

function createMainWindow(firstLaunchBounds?: InitialWindowBounds): BrowserWindow {
  const decision = windowState?.restore("main", MAIN_WINDOW_DEFAULTS, firstLaunchBounds);
  const window = new BrowserWindow({
    ...(decision?.bounds ?? {
      width: MAIN_WINDOW_DEFAULTS.width,
      height: MAIN_WINDOW_DEFAULTS.height,
    }),
    minWidth: MAIN_WINDOW_DEFAULTS.minWidth,
    minHeight: MAIN_WINDOW_DEFAULTS.minHeight,
    // Only set fullscreen when restoring into it — passing `false` explicitly
    // disables the macOS fullscreen (green) button.
    ...(decision?.fullScreen ? { fullscreen: true } : {}),
    title: "Sonata",
    // Full-height sidebar window (Notion/Codex/Finder pattern): no OS titlebar
    // strip — the renderer owns the whole window and the traffic lights float
    // over the sidebar's top-left. Fixes the dark-mode black titlebar (the app
    // now draws its own background everywhere) and makes the sidebar + main two
    // full-height bands. `trafficLightPosition` drops the lights into the
    // sidebar-top zone; the renderer reserves that corner in both collapse
    // states. macOS-only options; ignored elsewhere.
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
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
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });

  window.loadFile(path.join(__dirname, "../renderer/index.html"));
  windowState?.track(window, "main");
  guardWindowClose(window);

  // The two window-scoped CLI readiness triggers (D4 — event-driven, no timers).
  //
  // The launch probe rides `did-finish-load` rather than firing at app init, and
  // the reason is the login-shell PATH capture the probe depends on: it is a
  // SYNCHRONOUS shell subprocess (MEASURED 0.02–0.03s on this machine, bounded at
  // 2s for a hostile rc file), and paying it before the renderer has painted
  // would put a stale shell profile on the launch critical path. After first
  // paint it is free — and often already paid by the first pty spawn.
  //
  // Focus is the re-probe trigger, and it self-gates: the controller declines
  // unless some fact is actionable, so a healthy machine spends nothing when the
  // window comes forward. Both hooks live here rather than at the single launch
  // site so a main window re-created after a close (the `activate` path) carries
  // them too.
  window.webContents.once("did-finish-load", () => {
    void cliReadiness?.probe("launch");
  });
  window.on("focus", () => {
    cliReadiness?.noteMainWindowFocus();
  });

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  return window;
}

function createPreviewWindow(): BrowserWindow {
  const decision = windowState?.restore("preview", PREVIEW_WINDOW_DEFAULTS);
  const window = new BrowserWindow({
    ...(decision?.bounds ?? {
      width: PREVIEW_WINDOW_DEFAULTS.width,
      height: PREVIEW_WINDOW_DEFAULTS.height,
    }),
    minWidth: PREVIEW_WINDOW_DEFAULTS.minWidth,
    minHeight: PREVIEW_WINDOW_DEFAULTS.minHeight,
    // Only set fullscreen when restoring into it — passing `false` explicitly
    // disables the macOS fullscreen (green) button.
    ...(decision?.fullScreen ? { fullscreen: true } : {}),
    title: "Sonata Preview",
    // Frameless like the main + terminal windows: the tab strip is the drag
    // region and reserves a traffic-light inset on its left, so the strip reads
    // as a peer of the browser tab bars the design borrows from. macOS-only
    // options; ignored elsewhere.
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 14 },
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
  // The reader intercepts every in-document link click and routes it (fragment /
  // workspace tab / external), so the window itself must NEVER navigate — a
  // stray relative href (resolved against the injected doc base) would otherwise
  // replace the whole app with a `sonata-file://` page. Same guard the Reading
  // window carries.
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });

  window.loadFile(path.join(__dirname, "../renderer/preview.html"));
  windowState?.track(window, "preview");
  guardWindowClose(window);
  window.on("closed", () => {
    if (previewWindow === window) {
      previewWindow = null;
    }
  });

  return window;
}

function createTerminalWindow(firstLaunchBounds?: InitialWindowBounds): BrowserWindow {
  const decision = windowState?.restore("terminal", TERMINAL_WINDOW_DEFAULTS, firstLaunchBounds);
  const window = new BrowserWindow({
    ...(decision?.bounds ?? {
      width: TERMINAL_WINDOW_DEFAULTS.width,
      height: TERMINAL_WINDOW_DEFAULTS.height,
    }),
    minWidth: TERMINAL_WINDOW_DEFAULTS.minWidth,
    minHeight: TERMINAL_WINDOW_DEFAULTS.minHeight,
    ...(decision?.fullScreen ? { fullscreen: true } : {}),
    title: "Sonata CLI",
    // Frameless like the main window: the renderer owns the whole surface and
    // the traffic lights float over the topbar's reserved left corner, so the
    // CLI reads as a peer of the main column (its "CLI" label sits
    // right of the lights). macOS-only options; ignored elsewhere.
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
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

  window.loadFile(path.join(__dirname, "../renderer/terminal.html"));
  windowState?.track(window, "terminal");
  guardWindowClose(window);
  window.on("closed", () => {
    if (terminalWindow === window) {
      terminalWindow = null;
    }
    // A user-initiated close persists the closed preference; an app quit leaves
    // it intact so the terminal reopens next launch.
    if (!isQuitting) {
      persistTerminalWindowOpen(false);
    }
    sendTerminalWindowState();
  });

  return window;
}

function planPrimaryDisplayWindowPair(): InitialWindowPair | undefined {
  try {
    return planInitialWindowPair(screen.getPrimaryDisplay().workArea);
  } catch {
    // Display metrics can transiently fail during login/display reconfiguration.
    // The window factories still have safe standalone defaults in that case.
    return undefined;
  }
}

/**
 * Open/focus the Preview window and bind a task (design record §6.1). A bare
 * `taskId` (the header Eye button) shows that task's restored tabs or its empty
 * state; a `relativePath` also opens-or-focuses that tab. Binding stays in step
 * with the active-task relay — clicking a chip in task B implies B is active.
 */
async function openPreview(request: OpenPreviewRequest): Promise<void> {
  // A path target routes BEFORE any tab is opened (design record §6.1; plan v0).
  // A bare open (the Eye button's taskId, or an empty path) skips straight to the
  // window, exactly as before.
  let relativePath: string | undefined;
  if (request.relativePath) {
    // Normalize the target — a chip's relative path, or a transcript link's raw
    // href (relative OR absolute) — to a guarded workspace-relative path. An
    // absolute path outside the workspace (or a `../` escape) is not routable: a
    // principled no-op, the sandbox boundary.
    const normalized = workspaceFiles?.resolveRelative(request.taskId, request.relativePath) ?? null;
    if (normalized === null) {
      return;
    }
    relativePath = normalized;

    // Classify and hand non-previewable kinds to the OS — no tab, no Preview
    // window. `.html` → the default browser; media/binary → macOS Quick Look
    // anchored on the focused window. Everything previewable (and a nonexistent
    // tombstone) falls through to a Preview tab as today.
    const route = workspaceFiles?.classifyRoute(request.taskId, relativePath) ?? {
      target: "preview" as const,
    };
    if (route.target === "browser") {
      void shell.openPath(route.absolutePath);
      return;
    }
    if (route.target === "quicklook") {
      const owner = BrowserWindow.getFocusedWindow() ?? mainWindow;
      owner?.previewFile(route.absolutePath);
      return;
    }
  }

  bindPreviewTask(request.taskId);
  if (relativePath !== undefined) {
    previewSessions?.open(request.taskId, relativePath);
  }
  if (!previewWindow || previewWindow.isDestroyed()) {
    previewWindow = createPreviewWindow();
    previewWindow.webContents.once("did-finish-load", () => {
      pushPreviewBinding();
    });
  } else {
    previewWindow.show();
    previewWindow.focus();
    pushPreviewBinding();
  }
}

/**
 * The window binds ONE task's session and follows the Reading window's active
 * task (§6.1). Switching tasks swaps the whole strip (tabs, active, scroll all
 * restore); the previous task's claims persist untouched. Called from both the
 * active-task relay and an explicit open.
 */
function bindPreviewTask(taskId: TaskId | null): void {
  if (previewBoundTaskId === taskId) {
    return;
  }
  previewBoundTaskId = taskId;
  pushPreviewBinding();
}

function readPreviewBinding(): PreviewBinding {
  return currentPreviewBinding();
}

/** Push the bound task's session (+ breadcrumb root) to the Preview window
 *  ONLY — the old state broadcast to every window was unconsumed noise (§6.1). */
function pushPreviewBinding(): void {
  if (!previewWindow || previewWindow.isDestroyed()) {
    return;
  }
  previewWindow.webContents.send(IPC_CHANNELS.previewBinding, currentPreviewBinding());
}

function currentPreviewBinding(): PreviewBinding {
  const taskId = previewBoundTaskId;
  if (!taskId || !previewSessions) {
    return { taskId: null, projectDirName: null, session: null };
  }
  return {
    taskId,
    projectDirName: previewProjectDirName(taskId),
    session: previewSessions.session(taskId),
  };
}

/** Basename of the bound task's workspace cwd — the breadcrumb root label.
 *  Resolves for dormant sessions too (disk truth needs no live PTY); null when
 *  the task is gone (deleted). */
function previewProjectDirName(taskId: TaskId): string | null {
  try {
    const root = runtimeController?.sessionWorkingDirectory(taskId);
    return root ? path.basename(root) : null;
  } catch {
    return null;
  }
}

// Named transitions (renderer → main). Each ignores a taskId that raced a
// rebind, mutates session truth, and echoes the fresh binding back.
function previewCloseTab(request: PreviewCloseRequest): void {
  if (!previewSessions || request.taskId !== previewBoundTaskId) {
    return;
  }
  previewSessions.close(request.taskId, request.path);
  pushPreviewBinding();
}

function previewActivateTab(request: PreviewActivateRequest): void {
  if (!previewSessions || request.taskId !== previewBoundTaskId) {
    return;
  }
  previewSessions.activate(request.taskId, request.path);
  pushPreviewBinding();
}

function previewReorderTabs(request: PreviewReorderRequest): void {
  if (!previewSessions || request.taskId !== previewBoundTaskId) {
    return;
  }
  previewSessions.reorder(request.taskId, request.paths);
  pushPreviewBinding();
}

function previewSetScroll(request: PreviewSetScrollRequest): void {
  // Write-only: no echo (echoing scroll would fight the user's live scrolling).
  if (!previewSessions || request.taskId !== previewBoundTaskId) {
    return;
  }
  previewSessions.setScroll(request.taskId, request.path, request.scroll);
}

function previewSetPanel(request: PreviewSetPanelRequest): void {
  if (!previewSessions || request.taskId !== previewBoundTaskId) {
    return;
  }
  previewSessions.setPanel(request.taskId, request.open);
  pushPreviewBinding();
}

function readWorkspaceDoc(request: WorkspaceReadDocRequest): PreviewDocument {
  if (!workspaceFiles) {
    throw new Error("Workspace files seam is not ready.");
  }
  return workspaceFiles.readDoc(request.taskId, request.relativePath);
}

/** The `sonata-file://` handler body: parse `sonata-file://<taskId>/<enc-path>`,
 *  resolve to an image STREAM through WorkspaceFiles' audited guard, and answer
 *  404 for anything that is not a real in-workspace image (a script can never
 *  ride an image content-type). Genuinely never throws — a bad URL (incl.
 *  malformed percent-encoding) is a 404. The channel is scoped to the Preview's
 *  bound task: a request for any OTHER task's id is refused even though it would
 *  still be workspace-guarded, keeping the capability matched to the "one task's
 *  reading surface" model (least privilege). */
function serveSonataFileImage(rawUrl: string): Response {
  const notFound = new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain" },
  });
  if (!workspaceFiles) {
    return notFound;
  }
  let url: URL;
  let relativePath: string;
  try {
    url = new URL(rawUrl);
    relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  } catch {
    return notFound; // bad URL or malformed percent-encoding
  }
  const taskId = url.hostname;
  if (!taskId || !relativePath || taskId !== previewBoundTaskId) {
    return notFound;
  }
  const image = workspaceFiles.readImage(taskId, relativePath);
  if (!image) {
    return notFound;
  }
  return new Response(image.body, {
    status: 200,
    headers: { "content-type": image.mime, "cache-control": "no-cache" },
  });
}

function readWorkspaceDir(request: WorkspaceReadDirRequest): WorkspaceDirEntry[] {
  return workspaceFiles?.readDir(request.taskId, request.relativePath ?? "") ?? [];
}

function resolveWorkspacePaths(
  request: WorkspaceResolvePathsRequest,
): WorkspaceResolvePathsResult {
  return { existing: workspaceFiles?.resolvePaths(request.taskId, request.candidates) ?? [] };
}

function statWorkspacePath(request: WorkspaceStatRequest): WorkspaceStatResult {
  return (
    workspaceFiles?.stat(request.taskId, request.relativePath) ?? {
      exists: false,
      isFile: false,
      isDirectory: false,
      size: 0,
    }
  );
}

/** Broadcast the full reading appearance so satellites that follow it (Preview)
 *  re-stamp on a theme/mode/textStep change (R6). The system-mode channel only
 *  covers the auto→light/dark flip; this covers explicit changes. */
function broadcastReadingSettings(settings: ReadingSettings): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.readingSettingsChanged, settings);
    }
  }
}

/** Push the renderer-facing updater state to every window on each meaningful
 *  change (auto-update S1). main owns the window fan-out; the UpdaterController
 *  owns the state and calls this — the same split the runtime `sendEvent` and
 *  `sendTerminalWindowState` broadcasts use. */
function broadcastUpdaterState(state: UpdaterState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.updaterState, state);
    }
  }
}

/** Push the CLI readiness facts to every window when they CHANGE (CLI readiness
 *  S1, L6). Same split as the updater broadcast: main owns the window fan-out,
 *  the controller owns the facts and the change gate. Every window rather than
 *  just the main one: cheap for an event that fires only on a real transition,
 *  and the alternative — routing by window identity — is an optimization for a
 *  firehose this is not. (S2 update: the CLI window turned out to consume the
 *  setup-run channels rather than the facts, so today the Reading window is the
 *  only reader of THIS event. Left fanned out; nothing is paid for it.) */
function broadcastCliReadiness(facts: CliReadinessFacts): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.cliReadinessChanged, facts);
    }
  }
}

/** Push the CLI setup run's state (S2). Same fan-out split as the facts above,
 *  and both windows are real consumers: the Reading window's card renders the
 *  phase, the CLI window mounts and retires the run's terminal on it. */
function broadcastCliSetupRun(run: CliSetupRun | null): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.cliSetupRunChanged, run);
    }
  }
}

/** Push one chunk of a setup run's output. Sent to every window like its state,
 *  rather than routed to the CLI window alone: routing by window identity is the
 *  optimization `sendEvent` exists for and it buys nothing here — a setup run is
 *  one short-lived command, not a 200/s session firehose. */
function broadcastCliSetupRunData(chunk: CliSetupRunData): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.cliSetupRunData, chunk);
    }
  }
}

/**
 * Bring the CLI window up and wait until it can receive the run's output.
 *
 * The wait is the point. A setup run is usually requested with the CLI window
 * closed (someone whose CLI is missing has had no reason to open it), so without
 * it the first seconds of an installer would be broadcast to a window that does
 * not exist yet — and "follow along in the terminal window" would open onto a
 * blank grid. `did-finish-load` is the readiness signal; an already-loaded window
 * resolves immediately.
 */
async function showTerminalWindowForSetupRun(): Promise<void> {
  await setTerminalWindowOpen(true);
  const window = terminalWindow;
  if (!window || window.isDestroyed()) {
    return;
  }
  if (!window.webContents.isLoading()) {
    return;
  }
  await new Promise<void>((resolve) => {
    window.webContents.once("did-finish-load", () => resolve());
    // A window that never finishes loading must not wedge the run: the command is
    // still the right thing to do, and the output buffer replays into the window
    // whenever it does arrive.
    setTimeout(resolve, 5_000);
  });
}

/** The readiness surfaces' buttons — Reading window only. Two surfaces offer a
 *  setup run now (the New Chat card, and S4's existing-chat banner), and both live
 *  in the Reading window; no other window may start one. */
async function startCliSetupRun(request: CliSetupRunRequest, senderId: number): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.id !== senderId) {
    throw new Error("Only the Reading window may start a CLI setup run.");
  }
  await cliSetupRun?.start(request);
}

function readCliSetupRun(): CliSetupRunSnapshot {
  return cliSetupRun?.read() ?? { run: null, output: "", outputSeq: 0 };
}

/** Keystrokes and geometry — CLI window only, because it is the surface that
 *  hosts the pty's grid. The same guard shape as `requestCliAction`. */
function writeCliSetupRunInput(request: CliSetupRunInputRequest, senderId: number): void {
  requireTerminalWindowSender(senderId, "write into a CLI setup run");
  cliSetupRun?.write(request.id, request.data);
}

function resizeCliSetupRun(request: CliSetupRunResizeRequest, senderId: number): void {
  requireTerminalWindowSender(senderId, "resize a CLI setup run");
  cliSetupRun?.resize(request.id, request.cols, request.rows);
}

function requireTerminalWindowSender(senderId: number, action: string): void {
  if (
    !terminalWindow ||
    terminalWindow.isDestroyed() ||
    terminalWindow.webContents.id !== senderId
  ) {
    throw new Error(`Only the CLI window may ${action}.`);
  }
}

/**
 * The "Check for Updates…" menu affordance (auto-update S3). Runs the interactive
 * check and shows exactly one native dialog for its outcome. The updater decision
 * + copy are pure (updater-interactive.ts); this owns only the impure dialog and
 * the restart handoff. `staged` offers "Restart to Update", which routes through
 * the SAME `requestRestart` path as the sidebar pill — the restart-guard reducer
 * governs it. The controller reads its gate status lazily, so this is safe to
 * call any time after `updaterController.start()`.
 */
async function runInteractiveUpdaterCheck(): Promise<void> {
  const controller = updaterController;
  if (!controller) {
    return;
  }
  const outcome = await controller.checkForUpdatesInteractive();
  const spec = buildUpdaterDialog(outcome);
  const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const options = {
    type: "info" as const,
    // On macOS `message` is the bold headline and `detail` the secondary line;
    // `title` is the (mostly unused) window title. Map the spec's title → both.
    title: spec.title,
    message: spec.title,
    detail: spec.body,
    buttons: [...spec.buttons],
    defaultId: spec.defaultId,
    cancelId: spec.cancelId,
  };
  const { response } = owner
    ? await dialog.showMessageBox(owner, options)
    : await dialog.showMessageBox(options);
  if (spec.restartButtonId !== null && response === spec.restartButtonId) {
    controller.requestRestart();
  }
}

/**
 * A clicked native notification raises the Reading window and asks its renderer
 * to select the task the notification was about — the whole point of the
 * notification in a multi-task host is landing you on the right session.
 */
function activateTaskFromNotification(taskId: TaskId): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send(IPC_CHANNELS.notificationActivateTask, taskId);
}

/** A deleted session leaves no dormant record to return to, so its preview
 *  claims are forgotten (close/archive keep theirs). Called only on delete. */
function forgetPreviewSession(taskId: TaskId): void {
  previewSessions?.forget(taskId);
  if (previewBoundTaskId === taskId) {
    previewBoundTaskId = null;
    pushPreviewBinding();
  }
}


/**
 * The terminal window's toggle. Opening creates-or-focuses the window and
 * persists the preference; closing routes through `window.close()`, whose
 * "closed" handler persists the closed preference and broadcasts state. The
 * return value carries the *intent* immediately (for the awaiting toggle
 * button); the authoritative broadcast follows from the window lifecycle.
 */
async function setTerminalWindowOpen(open: boolean): Promise<TerminalWindowState> {
  if (open) {
    if (!terminalWindow || terminalWindow.isDestroyed()) {
      terminalWindow = createTerminalWindow();
    } else {
      terminalWindow.show();
      terminalWindow.focus();
    }
    persistTerminalWindowOpen(true);
    sendTerminalWindowState();
    return { open: true };
  }

  if (terminalWindow && !terminalWindow.isDestroyed()) {
    terminalWindow.close();
  } else {
    persistTerminalWindowOpen(false);
    sendTerminalWindowState();
  }
  return { open: false };
}

function readTerminalWindowState(): TerminalWindowState {
  return { open: Boolean(terminalWindow && !terminalWindow.isDestroyed()) };
}

function sendTerminalWindowState(): void {
  const state = readTerminalWindowState();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.terminalWindowState, state);
    }
  }
}

function readTerminalWindowSettings(): TerminalWindowSettings {
  return terminalWindowSettingsStore?.read() ?? { ...DEFAULT_TERMINAL_WINDOW_SETTINGS };
}

function writeTerminalWindowSettings(settings: TerminalWindowSettings): TerminalWindowSettings {
  // The window owns scheme + mode + fontSize; `open` is owned by the toggle,
  // so preserve the stored value rather than trusting the request. Normalized
  // HERE, not just in the store's write(): the no-store / write-failure
  // fallbacks return `merged` directly, and a malformed IPC payload must not
  // round-trip back to the renderer unvalidated through those paths.
  const merged: TerminalWindowSettings = normalizeTerminalWindowSettings({
    ...readTerminalWindowSettings(),
    scheme: settings.scheme,
    mode: settings.mode,
    fontSize: settings.fontSize,
  });
  try {
    return terminalWindowSettingsStore?.write(merged) ?? merged;
  } catch {
    return merged;
  }
}

function persistTerminalWindowOpen(open: boolean): void {
  try {
    // Merge so the persisted theme/mode survive an open/close toggle.
    terminalWindowSettingsStore?.write({ ...readTerminalWindowSettings(), open });
  } catch {
    // A failed preference write must never crash the app — at worst the open
    // state re-defaults on next launch.
  }
}

function setActiveTerminalTask(next: TerminalActiveTaskState, senderId: number): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.id !== senderId) {
    throw new Error("Only the Reading window may set the CLI binding.");
  }
  activeTerminalTask = next;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.terminalActiveTask, activeTerminalTask);
    }
  }
  // The Preview window rides the same active-task signal: it follows whatever
  // task the Reading window has selected (§6.1). A null task unbinds to the
  // empty state.
  bindPreviewTask(next.taskId);
}

function requestCliAction(request: CliActionRequest, senderId: number): void {
  if (
    !terminalWindow ||
    terminalWindow.isDestroyed() ||
    terminalWindow.webContents.id !== senderId
  ) {
    throw new Error("Only the CLI window may request a CLI action.");
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error("The Reading window is unavailable.");
  }
  mainWindow.webContents.send(IPC_CHANNELS.cliAction, request);
}

function readActiveTerminalTask(): TerminalActiveTaskState {
  return activeTerminalTask;
}

async function openWorkspaceExternal(
  request: WorkspaceOpenExternalRequest,
): Promise<WorkspaceOpenExternalResponse> {
  if (!workspaceFiles) {
    throw new Error("Workspace files seam is not ready.");
  }
  // Route external-open through WorkspaceFiles' single audited resolution (§6.1)
  // — the same path+symlink guard reads use, no second copy here.
  const targetPath = workspaceFiles.resolveExternalTarget(request.taskId, request.relativePath);

  if (request.target === "folder") {
    await openFolderTarget(targetPath, Boolean(request.relativePath));
  } else {
    await openCursorTarget(targetPath);
  }

  return {
    target: request.target,
    path: targetPath,
  };
}

async function openWorkspaceFolder(request: WorkspaceOpenFolderRequest): Promise<void> {
  await openWorkspaceExternal({
    taskId: request.taskId,
    target: "folder",
  });
}

async function pickFolder(): Promise<FolderPickResponse> {
  if (process.env.SONATA_TEST_PICK_FOLDER) {
    return {
      path: process.env.SONATA_TEST_PICK_FOLDER,
    };
  }
  const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const options: OpenDialogOptions = {
    title: "Choose Task Folder",
    properties: ["openDirectory", "createDirectory"],
  };
  const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  return {
    path: result.canceled ? null : result.filePaths[0] ?? null,
  };
}

async function pickReferences(): Promise<string[]> {
  if (process.env.SONATA_TEST_PICK_REFERENCES) {
    return process.env.SONATA_TEST_PICK_REFERENCES.split("\n").map((entry) => entry.trim()).filter(Boolean);
  }
  const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  // macOS shows files AND folders in one panel — no split menu (D6).
  const options: OpenDialogOptions = {
    title: "Attach Files or Folders",
    properties: ["openFile", "openDirectory", "multiSelections"],
  };
  const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  return result.canceled ? [] : result.filePaths;
}

async function openFolderTarget(targetPath: string, revealTarget: boolean): Promise<void> {
  if (revealTarget && fs.statSync(targetPath).isFile()) {
    shell.showItemInFolder(targetPath);
    return;
  }

  const result = await shell.openPath(targetPath);
  if (result) {
    throw new Error(result);
  }
}

async function openCursorTarget(targetPath: string): Promise<void> {
  await shell.openExternal(cursorFileUrl(targetPath));
}

function cursorFileUrl(filePath: string): string {
  const normalizedPath = filePath.split(path.sep).join("/");
  const encodedPath = normalizedPath.split("/").map(encodeURIComponent).join("/");
  return `cursor://file${encodedPath.startsWith("/") ? "" : "/"}${encodedPath}`;
}

/**
 * The Settings page lives in the main window as a centered overlay; the
 * menu item (and ⌘,) is its only chrome-level entrance per the HIG — no
 * toolbar button. Most settings are born at their moments; this is the
 * review door.
 */
function openSettingsInMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
    mainWindow.webContents.once("did-finish-load", () => {
      mainWindow?.webContents.send(IPC_CHANNELS.settingsOpen);
    });
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send(IPC_CHANNELS.settingsOpen);
}

// ── Quit / last-window confirmation (Focus/Flow S4, D5) ─────────────────────
//
// Every DECISION and every WORD is pure (`quit-guard.ts`, which also records why
// the guard is armed at the gesture rather than at `before-quit` — measured).
// This is the impure half: the ask on screen, and the two entrances to it.
//
// Note what does NOT change here: `before-quit` and `window-all-closed` keep
// their teardown sequences exactly. The guard is an ASK PHASE in front of them —
// once the user says yes, the app quits (or the window closes) down the same
// path it always did.

/** True while a confirmation is on screen, on EITHER surface. The pure guards
 *  read it as `asking`: a second ⌘Q must not stack a second dialog. */
let quitAskInFlight = false;
/** The renderer ask awaiting its answer, or null. Its `requestId` is what makes
 *  a late/stray answer unable to settle a question it did not belong to. */
let pendingQuitAsk: { readonly requestId: number; readonly settle: (confirmed: boolean) => void } | null =
  null;
let nextQuitRequestId = 1;
/** Windows whose close the user has already confirmed. Read back when the close
 *  re-enters after the guard calls `close()` a second time — the window is going
 *  away, so nothing is ever removed from this set. */
const closeConfirmedWindows = new WeakSet<BrowserWindow>();

function openWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
}

/** The app's user-facing quit gesture: the Quit menu item, which owns ⌘Q. Zero
 *  windows quits outright (D5's one exception — the runtimes are already
 *  disposed, so there is nothing to protect). */
async function requestUserQuit(): Promise<void> {
  const decision = decideQuitRequest({
    asking: quitAskInFlight,
    openWindowCount: openWindows().length,
    mainWindowCanAsk: Boolean(mainWindow && !mainWindow.isDestroyed()),
  });
  if (decision.action === "ignore") {
    return;
  }
  if (decision.action === "quit") {
    app.quit();
    return;
  }
  if (await askQuitConfirmation(decision.host, BrowserWindow.getFocusedWindow())) {
    app.quit();
  }
}

/**
 * Guard one window's close. Attached by all three window factories, because
 * "last window" is a property of the SET, not of any particular window: whichever
 * one is last, closing it runs `window-all-closed` → `runtimeController.dispose()`
 * and every live CLI dies — the same loss ⌘Q causes, so it asks the same question.
 *
 * A confirmed close proceeds as a normal second `close()` rather than `destroy()`:
 * the window's own teardown listeners (geometry capture, the CLI window's
 * open-preference persist) are product behavior, and destroying would skip the
 * `close` half of them silently.
 */
function guardWindowClose(window: BrowserWindow): void {
  window.on("close", (event) => {
    const decision = decideWindowClose({
      quitting: isQuitting,
      closeConfirmed: closeConfirmedWindows.has(window),
      // During `close` the window is still in `getAllWindows()`, so "the only
      // one left" is exactly a count of 1.
      isLastWindow: openWindows().length <= 1,
      isMainWindow: window === mainWindow,
      asking: quitAskInFlight,
    });
    if (decision.action === "close") {
      return;
    }
    event.preventDefault();
    if (decision.action === "ignore") {
      return;
    }
    void askQuitConfirmation(decision.host, window).then((confirmed) => {
      if (!confirmed || window.isDestroyed()) {
        return;
      }
      closeConfirmedWindows.add(window);
      window.close();
    });
  });
}

/** Put the question on screen and resolve with the user's answer. */
async function askQuitConfirmation(
  host: QuitAskHost,
  owner: BrowserWindow | null,
): Promise<boolean> {
  const spec = buildQuitDialog();
  quitAskInFlight = true;
  try {
    return host === "renderer" && mainWindow && !mainWindow.isDestroyed()
      ? await askQuitInMainWindow(mainWindow, spec)
      : await askQuitNatively(spec, owner);
  } finally {
    quitAskInFlight = false;
  }
}

/**
 * The branded dialog (D5): the main window's renderer draws it from the words
 * this push carries.
 *
 * Every way the question can DIE is settled as a cancel, because the failure
 * this protects against is a wedge — an ask that never resolves leaves
 * `quitAskInFlight` true forever and the app can never be quit again. Three
 * ways: the user answers, the window closes underneath the dialog, or the
 * renderer process goes away.
 */
function askQuitInMainWindow(window: BrowserWindow, spec: QuitDialogSpec): Promise<boolean> {
  const requestId = nextQuitRequestId++;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (confirmed: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (pendingQuitAsk?.requestId === requestId) {
        pendingQuitAsk = null;
      }
      // MEASURED: reading `.webContents` off a destroyed BrowserWindow THROWS,
      // and `settle` runs from the `closed` handler — where the window is
      // already destroyed. The throw escaped into Electron's own window-teardown
      // emit and left the quit sequence half-finished: the window closed,
      // `will-quit` never fired, and the process sat there forever. A destroyed
      // window has already dropped both listeners, so skipping is also correct.
      if (!window.isDestroyed()) {
        window.off("closed", cancel);
        window.webContents.off("render-process-gone", cancel);
      }
      resolve(confirmed);
    };
    const cancel = (): void => settle(false);
    pendingQuitAsk = { requestId, settle };
    window.on("closed", cancel);
    window.webContents.on("render-process-gone", cancel);

    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
    // A ⌘Q in the first moments after launch would otherwise send into a
    // renderer with no listener yet — and a lost ask is the wedge above. The
    // `settled` re-check is what keeps the deferred branch honest: an ask that
    // died while the window was still loading must not paint a dialog nothing
    // can answer (its `requestId` is already retired).
    const push = (): void => {
      if (settled || window.isDestroyed()) {
        return;
      }
      window.webContents.send(
        IPC_CHANNELS.quitConfirmAsk,
        quitConfirmRequestFrom(spec, requestId),
      );
    };
    if (window.webContents.isLoading()) {
      window.webContents.once("did-finish-load", push);
    } else {
      push();
    }
  });
}

/** The fallback for a window with no Sonata dialog surface of its own (CLI /
 *  Preview) — same spec, same words, native chrome. `question` rather than
 *  `warning`: this is a confirmation, and the copy is deliberately calm. */
async function askQuitNatively(
  spec: QuitDialogSpec,
  owner: BrowserWindow | null,
): Promise<boolean> {
  const options = {
    type: "question" as const,
    // macOS: `message` is the bold headline, `detail` the secondary line.
    title: spec.title,
    message: spec.title,
    detail: spec.body,
    buttons: [...spec.buttons],
    defaultId: spec.defaultId,
    cancelId: spec.cancelId,
  };
  const { response } =
    owner && !owner.isDestroyed()
      ? await dialog.showMessageBox(owner, options)
      : await dialog.showMessageBox(options);
  return response === spec.confirmButtonId;
}

/** The renderer's reply. An answer whose `requestId` does not match the ask in
 *  flight is dropped: it belongs to a question already settled. */
function answerQuitConfirm(answer: QuitConfirmAnswer): void {
  if (pendingQuitAsk?.requestId !== answer.requestId) {
    return;
  }
  pendingQuitAsk.settle(answer.confirmed);
}

function createApplicationMenu(): void {
  const isMac = process.platform === "darwin";
  // Sonata's own Quit, in place of `{ role: "quit" }` — it owns ⌘Q, and every
  // quit gesture the user can make goes through the S4 guard (D5). The label
  // matches the role's exactly (`Quit <app.name>`), so nothing on screen moves.
  const quitItem: MenuItemConstructorOptions = {
    id: "quit",
    label: `Quit ${app.name}`,
    accelerator: "CmdOrCtrl+Q",
    click: () => {
      void requestUserQuit();
    },
  };
  const settingsItem: MenuItemConstructorOptions = {
    id: "settings",
    label: "Settings…",
    accelerator: "CmdOrCtrl+,",
    click: () => openSettingsInMainWindow(),
  };
  // Standard macOS courtesy, directly below About (auto-update S3). The only
  // manual update affordance; silent checks handle the rest. Present only in the
  // macOS app menu — the updater is macOS-only (ShipIt), so a non-mac entry would
  // never resolve to an active gate.
  const checkForUpdatesItem: MenuItemConstructorOptions = {
    id: "check-for-updates",
    label: "Check for Updates…",
    click: () => {
      void runInteractiveUpdaterCheck();
    },
  };
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              checkForUpdatesItem,
              { type: "separator" },
              settingsItem,
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              quitItem,
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      submenu: isMac
        ? [{ role: "close" }]
        : [settingsItem, { type: "separator" }, quitItem],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function sendReadingSystemMode(): void {
  const mode = nativeTheme.shouldUseDarkColors ? "dark" : "light";
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.readingSystemModeChanged, mode);
    }
  }
}

function startLocalApiIfEnabled(controller: RuntimeController): void {
  // SONATA_LOCAL_API=0 is a hard off that overrides the settings file —
  // a kill switch that wins regardless of persisted preference.
  if (process.env.SONATA_LOCAL_API === "0") {
    return;
  }
  const settings = new LocalApiSettingsStore(
    localApiSettingsPath(),
  ).read();
  const enabled = settings.enabled || process.env.SONATA_LOCAL_API === "1";
  if (!enabled) {
    return;
  }
  localApiServer = new LocalApiServer({
    socketPath: localApiSocketPath(app.getPath("userData")),
    appVersion: app.getVersion(),
    facade: {
      readSessionIndex: (options) => controller.readSessionIndex(options),
      readSessionSnapshot: (taskId: TaskId) => controller.readSessionSnapshot(taskId),
      submitPrompt: (taskId: TaskId, text: string) => controller.submitPrompt(taskId, text),
      // Validates synchronously (so the server's typed-error → wire-code
      // translation and its command dedup keep working) and boots in the
      // background. The split lives in the controller, next to the lookup logic
      // it depends on — see `resumeTaskInBackground`.
      openTask: (taskId: TaskId) => controller.resumeTaskInBackground(taskId),
    },
  });
  localApiServer.start().catch((error) => {
    console.error("[local-api] failed to start:", error);
    localApiServer = null;
  });
}

// Recorded reality for the reading-core reducer fixtures (map §2.4): default
// off; set SONATA_RUNTIME_EVENT_LOG=<dir> to capture the renderer-bound event
// stream as JSONL.
const recordRuntimeEvent = createRuntimeEventRecorder(process.env.SONATA_RUNTIME_EVENT_LOG);

// Dev-gated main-process perf instrumentation (OBS S9 / P6): default off; set
// SONATA_PERF_LOG=1 (stderr) or =<dir> to stream event-loop-lag summaries and
// per run-index flush duration/size (the AD-1/AD-2 tripwire evidence). Null when
// off — that null is the AD-0 zero-cost-when-off guarantee (no sampler, no timer).
const perfLog = createPerfLog();

app.whenReady().then(() => {
  readingSettingsStore = new ReadingSettingsStore(readingSettingsPath());
  previewSessions = new PreviewSessions(new PreviewSessionsStore(previewSessionsPath()));
  // The disk-truth seam resolves a task's workspace root for LIVE or DORMANT
  // sessions (sessionWorkingDirectory reads the manifest) — reading a file
  // never needs a live PTY. A gone task returns null → absent/empty projection.
  workspaceFiles = new WorkspaceFiles((taskId) => {
    try {
      return runtimeController?.sessionWorkingDirectory(taskId) ?? null;
    } catch {
      return null;
    }
  });
  // Serve `sonata-file://<taskId>/<path>` local images to the Preview reader.
  // The URL host is the task id, the path is the (percent-encoded) workspace-
  // relative path; resolution + the image-only allowlist live in WorkspaceFiles
  // (the ONE audited guard). Anything that is not a real, in-workspace image →
  // 404, so this channel can never serve a script or escape the workspace.
  protocol.handle("sonata-file", (request) => serveSonataFileImage(request.url));
  // SONATA_NOTIFICATIONS=0 is a hard off (kill switch for test harnesses and for
  // anyone who prefers the macOS per-app toggle as their only control).
  if (process.env.SONATA_NOTIFICATIONS !== "0") {
    notificationController = new NotificationController({
      activateTask: activateTaskFromNotification,
      // Pull the current name + provider from the live task registry at fire
      // time — authoritative even after a rename, and for tasks the controller
      // never saw created. `runtimeController` is assigned just below; the
      // notifier only fires later, so the lazy read is safe.
      resolveTaskMeta: (taskId) => {
        const task = runtimeController?.listTasks().find((entry) => entry.id === taskId);
        return task
          ? {
              title: task.title,
              provider: task.provider,
              ...(task.titleOrigin === undefined ? {} : { titleOrigin: task.titleOrigin }),
            }
          : null;
      },
    });
  }
  // ONE store instance, shared: the controller reads the launch policy from it
  // and the CLI updater reads `keepCodexUpToDate` from it, and a toggle must be
  // visible to both without a restart.
  const codexSettingsStore = new CodexSettingsStore(codexSettingsPath());
  // Built BEFORE the controller so the controller can hold it directly. The
  // dependency is mutual (the controller asks the updater who owns the prompt;
  // the updater asks the controller how many Codex sessions are live), and the
  // lazy hop lives on THIS side because it is the one that reads honestly:
  // before the controller exists there are, in fact, zero live sessions.
  cliUpdater = new CliUpdater({
    livePtyCount: () => runtimeController?.liveCodexPtyCount() ?? 0,
    isEnabled: () => codexSettingsStore.read().keepCodexUpToDate,
  });
  // Built here, ahead of the controller, so the controller can hold it DIRECTLY:
  // the readiness controller depends on nothing (its only collaborator is the
  // window broadcast below), so unlike the CLI updater there is no mutual
  // dependency to break with a lazy hop. Nothing probes yet — the launch trigger
  // is the main window's did-finish-load (see createMainWindow), and until it
  // lands the facts read all-`unknown`, the permissive state. The IPC pull channel
  // can therefore answer from the first moment a window exists.
  cliReadiness = new CliReadiness({ broadcast: broadcastCliReadiness });
  // Reads the facts back through the SAME controller that owns them rather than
  // keeping a copy — both the S2 install verdict (L7) and the S4 session-start
  // diagnosis mean "what does the probe say NOW", and a second copy of the facts
  // is a second thing that could be stale.
  const readiness = cliReadiness;
  runtimeController = new RuntimeController({
    projectsStore: new ProjectsStore(projectsStorePath()),
    tagsStore: new TagsStore(tagsStorePath()),
    resumeSettingsStore: new ResumeSettingsStore(resumeSettingsPath()),
    claudeSettingsStore: new ClaudeSettingsStore(claudeSettingsPath()),
    codexSettingsStore,
    sonataSettingsStore: new SonataSettingsStore(sonataSettingsPath()),
    cliUpdater,
    // The S4 diagnosis port: re-probe, then read. Passed as the narrow
    // `CliReadinessSource` surface — the controller never schedules, gates, or
    // broadcasts facts.
    cliReadiness: readiness,
    ...(perfLog ? { onFlushMetrics: (metric) => perfLog.recordFlush(metric) } : {}),
    sendEvent: (event) => {
      recordRuntimeEvent(event);
      localApiServer?.broadcastEvent(event);
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed() || !windowAcceptsEvent(window, event)) {
          continue;
        }
        window.webContents.send(IPC_CHANNELS.runtimeEvent, event);
      }
      notificationController?.handleEvent(event);
    },
  });
  startLocalApiIfEnabled(runtimeController);
  updaterController = new UpdaterController({ broadcast: broadcastUpdaterState });
  // The recovery half (S2), reading the same facts through the same controller.
  cliSetupRun = new CliSetupRunController({
    broadcastState: broadcastCliSetupRun,
    broadcastData: broadcastCliSetupRunData,
    showTerminalWindow: showTerminalWindowForSetupRun,
    reprobe: (options) => readiness.reprobe(options),
    isAbsent: (provider) => readiness.read()[provider].install === "absent",
  });
  if (!readingSettingsStore) {
    throw new Error("Reading settings store is not ready.");
  }
  nativeTheme.on("updated", sendReadingSystemMode);
  registerIpcHandlers(runtimeController, {
    openPreview,
    readPreviewBinding,
    previewCloseTab,
    previewActivateTab,
    previewReorderTabs,
    previewSetScroll,
    previewSetPanel,
    readWorkspaceDoc,
    readWorkspaceDir,
    resolveWorkspacePaths,
    statWorkspacePath,
    broadcastReadingSettings,
    setTerminalWindowOpen,
    readTerminalWindowState,
    readTerminalWindowSettings,
    writeTerminalWindowSettings,
    setActiveTerminalTask,
    readActiveTerminalTask,
    requestCliAction,
    startCliSetupRun,
    readCliSetupRun,
    writeCliSetupRunInput,
    resizeCliSetupRun,
    openWorkspaceExternal,
    openWorkspaceFolder,
    pickFolder,
    pickReferences,
    forgetPreviewSession,
    answerQuitConfirm,
  }, readingSettingsStore, updaterController, cliReadiness);
  createApplicationMenu();
  windowState = new WindowStateManager(new WindowStateStore(windowStatePath()));
  // Default-on: the terminal opens beside the conversation unless the user
  // closed it last session. Only a genuinely fresh pair receives coordinated
  // bounds: existing users keep each window's last saved geometry exactly.
  terminalWindowSettingsStore = new TerminalWindowSettingsStore(terminalWindowSettingsPath());
  const terminalStartsOpen = terminalWindowSettingsStore.read().open;
  let initialWindowPair: InitialWindowPair | undefined;
  if (
    terminalStartsOpen &&
    !windowState.hasRestorableState("main", MAIN_WINDOW_DEFAULTS) &&
    !windowState.hasRestorableState("terminal", TERMINAL_WINDOW_DEFAULTS)
  ) {
    initialWindowPair = planPrimaryDisplayWindowPair();
  }
  mainWindow = createMainWindow(initialWindowPair?.main);
  if (terminalStartsOpen) {
    // Open the terminal only after the main window has loaded: the conversation
    // is the primary surface (it stays frontmost and is the first window any
    // harness sees), and the terminal slides in beside it a beat later. The
    // heavy main renderer would otherwise lose the "first window" race to the
    // tiny terminal page.
    mainWindow.webContents.once("did-finish-load", () => {
      if (!terminalWindow || terminalWindow.isDestroyed()) {
        terminalWindow = createTerminalWindow(initialWindowPair?.terminal);
      }
      mainWindow?.focus();
      // The main renderer's boot-time state read may have run before the window
      // existed; broadcast now so its toggle button reflects the open terminal.
      sendTerminalWindowState();
    });
  }

  // Start the auto-updater last: the gate is evaluated once here, and the first
  // silent check is 60s out — well after the windows exist to receive a staged
  // broadcast. Inert unless packaged + in /Applications (guards inside).
  updaterController.start();
  // Same cadence, its own timers, NO packaging gate: a dev build spawns the same
  // real `codex` a packaged one does, so it has to keep it fresh too. `start()`
  // also reconciles whatever the last run left behind (an update that outlived
  // the app is adopted, or classified as an unknown outcome).
  cliUpdater.start();

  app.on("activate", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  localApiServer?.stop();
  localApiServer = null;
  runtimeController?.dispose();
  runtimeController = null;
  previewWindow = null;
  terminalWindow = null;

  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  // Mark the quit so the terminal window's "closed" handler leaves the open
  // preference intact (a quit is not the user choosing to close the terminal).
  isQuitting = true;
  windowState?.flush();
  previewSessions?.flush();
  localApiServer?.stop();
  localApiServer = null;
  runtimeController?.dispose();
  // Clear the updater's check timers so they never hold the process alive on
  // quit (they are also unref'd as a belt-and-braces).
  updaterController?.dispose();
  // Same for the CLI updater. Note this does NOT stop an in-flight `codex
  // update`: that child is detached and unref'd on purpose, because killing a
  // package manager mid-write can corrupt a global install. It finishes without
  // us, and the next launch reconciles what it left behind.
  cliUpdater?.dispose();
  // No timers to clear here — the readiness probe has none. This only stops an
  // in-flight probe from broadcasting into a window set that is being torn down.
  cliReadiness?.dispose();
  // Stops broadcasting a setup run. It does not kill one — but note the limit of
  // that (review O1): the pty is not detached, so a real QUIT interrupts the
  // installer anyway. Accepted; the recovery is retry, and the controller's dispose
  // doc carries the measurement and the reasoning.
  cliSetupRun?.dispose();
  // Emit the final event-loop-lag summary and disarm the sampler (no-op when the
  // perf log is off — perfLog is null).
  perfLog?.stop();
});
