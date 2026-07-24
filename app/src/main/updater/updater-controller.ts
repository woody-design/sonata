import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { Logger } from "electron-updater";
import { updaterStateEquals, type UpdaterState } from "../../shared/types/updater";
import {
  INITIAL_UPDATER_STATE,
  projectUpdaterState,
  reduceUpdaterEvent,
  type UpdaterEvent,
  type UpdaterMachineState,
} from "./updater-state";
import {
  evaluateUpdaterGate,
  type UpdaterGateInput,
  type UpdaterGateStatus,
} from "./updater-gate";

/** First silent check ~60s after ready — late enough not to compete with boot,
 *  soon enough to catch a stale launch. Then every 12h (checks ride the public
 *  atom feed + CDN; do not poll aggressively — research Q2). */
const FIRST_CHECK_DELAY_MS = 60_000;
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

export interface UpdaterControllerOptions {
  /** Push the renderer-facing state to every window. main owns the fan-out —
   *  mirrors the `sendEvent` / `sendTerminalWindowState` convention, and keeps
   *  this controller free of `BrowserWindow`. */
  broadcast: (state: UpdaterState) => void;
}

/**
 * Wires electron-updater's `autoUpdater` to the pure state machine (auto-update
 * S1). The thin impure shell: it owns the gate (checked once at init), the
 * schedule, the electron-updater config + event subscriptions, and the
 * restart-to-install handoff. All state DECISIONS live in updater-state.ts; all
 * gate decisions in updater-gate.ts.
 *
 * When the gate is not `active` the controller is inert — it wires nothing and
 * schedules nothing — but still answers `readState()` (idle) and `requestRestart()`
 * (no-op) so the IPC surface is always present, and exposes `status` for the
 * menu slice (S3) to explain why updates are off.
 */
export class UpdaterController {
  private readonly broadcast: (state: UpdaterState) => void;
  private machine: UpdaterMachineState = INITIAL_UPDATER_STATE;
  private lastPushed: UpdaterState = { status: "idle" };
  private gateStatus: UpdaterGateStatus = "disabled-dev";
  private firstCheckTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private restarting = false;

  constructor(options: UpdaterControllerOptions) {
    this.broadcast = options.broadcast;
  }

  /** Evaluate the gate once and, when active, configure electron-updater, wire
   *  its events, and start the schedule. Idempotent guard is unnecessary — main
   *  calls this exactly once after `whenReady`. */
  start(): void {
    this.gateStatus = evaluateUpdaterGate(this.readGateInput());
    if (this.gateStatus !== "active") {
      console.log(`[updater] inactive (${this.gateStatus}); auto-update disabled.`);
      return;
    }
    this.configure();
    this.wireEvents();
    this.scheduleChecks();
    console.log("[updater] active; first check in 60s, then every 12h.");
  }

  /** The activation status, for the menu slice (S3) to read. */
  get status(): UpdaterGateStatus {
    return this.gateStatus;
  }

  /** Current renderer-facing state — served on the sync-read IPC so a late window
   *  hydrates to whatever was already broadcast. */
  readState(): UpdaterState {
    return projectUpdaterState(this.machine);
  }

  /** Restart into the staged update. Valid only when an update is staged; a
   *  double-click (or a second window) is ignored while a restart is in flight. */
  requestRestart(): void {
    if (this.gateStatus !== "active") {
      return;
    }
    if (this.machine.stagedVersion === null) {
      return;
    }
    if (this.restarting) {
      return;
    }
    this.restarting = true;
    // Ordering is load-bearing: clear install-on-quit BEFORE quitAndInstall, or
    // Squirrel throws RACCommandError "the command is disabled" (electron-builder
    // #6418). quitAndInstall then closes all windows and installs on quit.
    autoUpdater.autoInstallOnAppQuit = false;
    try {
      autoUpdater.quitAndInstall();
    } catch (error) {
      // A failed handoff (rare macOS ShipIt no-op) must not wedge the button in
      // a permanent "Updating…" — release the guard so a retry is possible, and
      // restore install-on-quit as the fallback path.
      console.error("[updater] quitAndInstall failed:", error);
      autoUpdater.autoInstallOnAppQuit = true;
      this.restarting = false;
    }
  }

  /** Stop the schedule so the timers never hold the process alive on quit. */
  dispose(): void {
    if (this.firstCheckTimer) {
      clearTimeout(this.firstCheckTimer);
      this.firstCheckTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  private configure(): void {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    // Route electron-updater's logging through the app's existing console
    // approach (see main.ts's `[local-api]` / `[notifications]` prefixes) — no
    // logging framework. `debug` is intentionally omitted (very chatty); info /
    // warn / error carry the diagnostics worth seeing.
    const logger: Logger = {
      info: (message) => console.log("[updater]", message),
      warn: (message) => console.warn("[updater]", message),
      error: (message) => console.error("[updater]", message),
    };
    autoUpdater.logger = logger;
    // e2e harness (S4): point at a local generic feed instead of GitHub.
    const feedUrl = process.env.SONATA_UPDATE_FEED_URL;
    if (feedUrl) {
      autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
    }
    // The gate only reaches here unpackaged via SONATA_UPDATE_ALLOW_UNPACKAGED;
    // mirror electron-updater's dev path so that harness build reads
    // dev-app-update.yml instead of the packaged app-update.yml.
    if (!app.isPackaged) {
      autoUpdater.forceDevUpdateConfig = true;
    }
  }

  private wireEvents(): void {
    autoUpdater.on("checking-for-update", () => {
      this.dispatch({ type: "checking-for-update" });
    });
    autoUpdater.on("update-available", (info) => {
      this.dispatch({ type: "update-available", version: info.version });
    });
    autoUpdater.on("update-not-available", () => {
      this.dispatch({ type: "update-not-available" });
    });
    autoUpdater.on("download-progress", () => {
      this.dispatch({ type: "download-progress" });
    });
    autoUpdater.on("update-downloaded", (event) => {
      this.dispatch({ type: "update-downloaded", version: event.version });
    });
    autoUpdater.on("error", (error) => {
      this.dispatch({ type: "error", message: error?.message ?? String(error) });
    });
  }

  private scheduleChecks(): void {
    this.firstCheckTimer = setTimeout(() => {
      this.firstCheckTimer = null;
      this.check();
    }, FIRST_CHECK_DELAY_MS);
    this.firstCheckTimer.unref?.();
    this.intervalTimer = setInterval(() => {
      this.check();
    }, CHECK_INTERVAL_MS);
    this.intervalTimer.unref?.();
  }

  private check(): void {
    // The `error` event already drives the machine + logs; swallow the mirrored
    // promise rejection so a failed check is never an unhandled rejection.
    void autoUpdater.checkForUpdates().catch(() => undefined);
  }

  private dispatch(event: UpdaterEvent): void {
    this.machine = reduceUpdaterEvent(this.machine, event);
    const next = projectUpdaterState(this.machine);
    // Suppress redundant pushes — the many download-progress ticks (and a
    // re-check while staged) all project to a state the renderer already has.
    if (updaterStateEquals(next, this.lastPushed)) {
      return;
    }
    this.lastPushed = next;
    this.broadcast(next);
  }

  private readGateInput(): UpdaterGateInput {
    let inApplicationsFolder: boolean | null = null;
    try {
      // macOS-only; absent (or throwing) on other platforms or a future Electron
      // — read defensively so an unavailable API can't crash init or be mistaken
      // for a wrong location.
      inApplicationsFolder =
        typeof app.isInApplicationsFolder === "function"
          ? app.isInApplicationsFolder()
          : null;
    } catch {
      inApplicationsFolder = null;
    }
    return {
      isPackaged: app.isPackaged,
      disableEnv: process.env.SONATA_DISABLE_UPDATER === "1",
      allowUnpackaged: process.env.SONATA_UPDATE_ALLOW_UNPACKAGED === "1",
      feedOverride: Boolean(process.env.SONATA_UPDATE_FEED_URL),
      inApplicationsFolder,
    };
  }
}
