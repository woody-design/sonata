/**
 * The renderer-facing auto-update state (auto-update S1). Per the agreed design
 * the UI has exactly two actionable conditions: nothing to do, or an update is
 * downloaded, staged, and ready to install on restart. The main-process state
 * machine's internal `checking` / `downloading` / `error` phases all project to
 * `idle` here — there is deliberately NO Downloading UI (background staging is
 * invisible; "the button only exists when there's something the user can do").
 *
 * This is the ONLY updater shape that crosses IPC. It is a discriminated union
 * so the sidebar button (S2) branches on `status` and reads `version` only when
 * an update is actually staged.
 */
export type UpdaterState =
  | { status: "idle" }
  | { status: "staged"; version: string };

export const IDLE_UPDATER_STATE: UpdaterState = { status: "idle" };

/** Boundary validation for the IPC payload — the contract fence pins the shape,
 *  and a hostile/garbled push can never reach the renderer as a valid state. */
export function isUpdaterState(value: unknown): value is UpdaterState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.status === "idle") {
    return Object.keys(record).length === 1;
  }
  if (record.status === "staged") {
    return (
      Object.keys(record).length === 2 &&
      typeof record.version === "string" &&
      record.version.length > 0
    );
  }
  return false;
}

/** Whether two renderer-facing states are indistinguishable — the controller
 *  uses this to suppress redundant broadcasts (e.g. the many download-progress
 *  ticks that all project to `idle`). */
export function updaterStateEquals(a: UpdaterState, b: UpdaterState): boolean {
  if (a.status !== b.status) {
    return false;
  }
  if (a.status === "staged" && b.status === "staged") {
    return a.version === b.version;
  }
  return true;
}
