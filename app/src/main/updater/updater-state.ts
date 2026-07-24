import type { UpdaterState } from "../../shared/types/updater";

/**
 * The PURE auto-update state machine (auto-update S1). No Electron, no
 * electron-updater, no DOM — it reduces the electron-updater lifecycle to a
 * small state and projects that state to the renderer-facing contract. The
 * controller owns all the impure wiring; this module owns the decisions, so the
 * whole transition table unit-tests in plain node (`smoke:updater-state`).
 *
 * The five phases mirror the electron-updater lifecycle. `stagedVersion` is the
 * load-bearing field: it is the ONLY thing the renderer projection reads, and it
 * is sticky — once an update is downloaded it stays staged through a later
 * re-check's `checking` / `downloading` / `error` activity, so the sidebar's
 * "Update" button never flickers away every 12h while a background re-check
 * runs. Only a newer `update-downloaded` replaces it.
 */
export type UpdaterPhase = "idle" | "checking" | "downloading" | "staged" | "error";

export interface UpdaterMachineState {
  readonly phase: UpdaterPhase;
  /** Version downloaded and ready to install, or null when nothing is staged. */
  readonly stagedVersion: string | null;
}

/** The lifecycle events electron-updater emits, normalized to the fields this
 *  machine actually consumes (version strings; download progress is tracked as
 *  activity only, its percent is deliberately not surfaced — no Downloading UI). */
export type UpdaterEvent =
  | { type: "checking-for-update" }
  | { type: "update-available"; version: string }
  | { type: "update-not-available" }
  | { type: "download-progress" }
  | { type: "update-downloaded"; version: string }
  | { type: "error"; message: string };

export const INITIAL_UPDATER_STATE: UpdaterMachineState = {
  phase: "idle",
  stagedVersion: null,
};

export function reduceUpdaterEvent(
  state: UpdaterMachineState,
  event: UpdaterEvent,
): UpdaterMachineState {
  switch (event.type) {
    case "checking-for-update":
      return { phase: "checking", stagedVersion: state.stagedVersion };
    case "update-available":
      // autoDownload is on, so an available update begins downloading at once.
      return { phase: "downloading", stagedVersion: state.stagedVersion };
    case "download-progress":
      return { phase: "downloading", stagedVersion: state.stagedVersion };
    case "update-not-available":
      // Up to date. Rest in `staged` when something was already downloaded (the
      // latest IS the staged one), otherwise idle.
      return {
        phase: state.stagedVersion === null ? "idle" : "staged",
        stagedVersion: state.stagedVersion,
      };
    case "update-downloaded":
      return { phase: "staged", stagedVersion: event.version };
    case "error":
      // Non-fatal: the next scheduled check retries. A previously staged update
      // survives a failed re-check (the ready button must not vanish); with
      // nothing staged the machine rests in `error`, which the renderer
      // projection collapses to idle — the user sees "nothing to do", not a
      // failure they can't act on.
      return {
        phase: state.stagedVersion === null ? "error" : "staged",
        stagedVersion: state.stagedVersion,
      };
    default: {
      // Compile-time exhaustiveness; at runtime an unknown event leaves state
      // unchanged rather than corrupting it with the event object.
      const exhaustive: never = event;
      void exhaustive;
      return state;
    }
  }
}

/** Collapse the internal machine to the renderer-facing contract: the button
 *  exists only when there is a staged update to act on. Every non-staged phase
 *  (checking / downloading / error / idle) reads as `idle` to the renderer. */
export function projectUpdaterState(state: UpdaterMachineState): UpdaterState {
  return state.stagedVersion === null
    ? { status: "idle" }
    : { status: "staged", version: state.stagedVersion };
}
