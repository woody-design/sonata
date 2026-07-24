/**
 * The auto-update activation gate (auto-update S1). PURE — no Electron — so the
 * full truth table unit-tests in plain node (`smoke:updater-gating`). The
 * controller reads the live Electron/env values into {@link UpdaterGateInput}
 * and calls {@link evaluateUpdaterGate} exactly once at init.
 *
 * The gate answers WHY the updater is (in)active, not just whether — the future
 * menu slice (S3) surfaces the reason ("disabled in dev", "move to /Applications
 * to enable updates"). The status is the controller's single source of truth for
 * that.
 */
export type UpdaterGateStatus =
  | "active"
  | "disabled-dev"
  | "disabled-env"
  | "disabled-location";

export interface UpdaterGateInput {
  /** `app.isPackaged`. The real install is packaged; a dev/`npm start` run is not. */
  readonly isPackaged: boolean;
  /** `SONATA_DISABLE_UPDATER=1` — the kill switch. */
  readonly disableEnv: boolean;
  /** `SONATA_UPDATE_ALLOW_UNPACKAGED=1` — dev-harness bypass of the packaged
   *  requirement, mirroring electron-updater's `forceDevUpdateConfig` (S4). */
  readonly allowUnpackaged: boolean;
  /** `SONATA_UPDATE_FEED_URL` is set — the e2e harness feed override, which also
   *  relaxes the /Applications requirement (a harness install lives anywhere). */
  readonly feedOverride: boolean;
  /** `app.isInApplicationsFolder()` — or null when the API is unavailable or
   *  threw (treated defensively: absence is NOT a positive "wrong location"
   *  signal, so it does not disable). */
  readonly inApplicationsFolder: boolean | null;
}

export function evaluateUpdaterGate(input: UpdaterGateInput): UpdaterGateStatus {
  // The kill switch is the most deliberate override — it wins over everything,
  // so a test/harness that sets it gets a predictable inert updater regardless
  // of packaging or location.
  if (input.disableEnv) {
    return "disabled-env";
  }
  // Packaging is required; only the explicit unpackaged bypass relaxes it (the
  // feed override does NOT — an unpackaged app still needs the bypass to run).
  if (!input.isPackaged && !input.allowUnpackaged) {
    return "disabled-dev";
  }
  // ShipIt cannot swap a bundle running from a read-only/translocated path
  // (research Q4) — a confident "not in /Applications" disables. The feed
  // override (harness) bypasses this; an unavailable API (null) does not block.
  if (!input.feedOverride && input.inApplicationsFolder === false) {
    return "disabled-location";
  }
  return "active";
}
