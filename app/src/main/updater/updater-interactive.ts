/**
 * The user-initiated "Check for Updates…" decision + copy (auto-update S3). PURE
 * — no Electron, no `dialog` — so the whole outcome truth table and the dialog
 * spec unit-test in plain node (`smoke:updater-menu-check`). The controller runs
 * the impure `autoUpdater.checkForUpdates()` network round-trip; every decision
 * about WHETHER to run it and WHAT to say lives here.
 *
 * Unlike the silent 12h checks (invisible unless something is staged), a manual
 * check is a courtesy affordance: it always answers the user with exactly one
 * native dialog. The eight outcomes below each map to one dialog spec.
 */
import type { UpdaterGateStatus } from "./updater-gate";
import type { UpdaterPhase } from "./updater-state";

/** The result of a manual check, ready to render as one dialog. `disabled`
 *  carries the gate reason so the menu can explain WHY (internal / location /
 *  dev / env); the version-bearing outcomes carry the string the copy needs. */
export type InteractiveCheckOutcome =
  | { readonly kind: "up-to-date"; readonly currentVersion: string }
  | { readonly kind: "found-downloading"; readonly version: string }
  | { readonly kind: "already-downloading" }
  | { readonly kind: "staged"; readonly version: string }
  | { readonly kind: "check-failed" }
  | { readonly kind: "disabled"; readonly reason: UpdaterGateStatus };

/** The normalized outcome of the impure `autoUpdater.checkForUpdates()` call the
 *  controller hands back to {@link resolveCheckOutcome}. */
export type InteractiveCheckResult =
  | { readonly kind: "update-available"; readonly version: string }
  | { readonly kind: "up-to-date" }
  | { readonly kind: "failed" };

/** Everything {@link decideInteractiveCheck} needs to decide without a network
 *  call: the gate status and the live machine phase + staged version. */
export interface InteractiveCheckContext {
  readonly gateStatus: UpdaterGateStatus;
  readonly phase: UpdaterPhase;
  readonly stagedVersion: string | null;
  /** `app.getVersion()` — only the `up-to-date` outcome needs it, but it is read
   *  once up front so the controller never has to touch Electron again. */
  readonly currentVersion: string;
}

/** The pre-check decision: either the outcome is already known (no network
 *  needed) or the controller must run the check and feed the result back
 *  through {@link resolveCheckOutcome}. */
export type InteractiveCheckPlan =
  | { readonly action: "resolve"; readonly outcome: InteractiveCheckOutcome }
  | { readonly action: "check" };

/**
 * Decide the manual check WITHOUT touching the network. Three short-circuits, in
 * order:
 *   1. Updater disabled → report the reason; never touch `autoUpdater`.
 *   2. Something already staged → report it immediately; a manual check must not
 *      re-download what is already ready (and the pill is already showing it).
 *   3. A background check/download is in flight (`checking` / `downloading`) →
 *      report "on its way" WITHOUT a second `checkForUpdates()` (the brief's
 *      "don't double-invoke"). electron-updater would dedup the concurrent call,
 *      but not double-invoking is the explicit contract.
 * Otherwise (`idle` / `error`) run the check.
 */
export function decideInteractiveCheck(
  context: InteractiveCheckContext,
): InteractiveCheckPlan {
  if (context.gateStatus !== "active") {
    return { action: "resolve", outcome: { kind: "disabled", reason: context.gateStatus } };
  }
  if (context.stagedVersion !== null) {
    return { action: "resolve", outcome: { kind: "staged", version: context.stagedVersion } };
  }
  if (context.phase === "checking" || context.phase === "downloading") {
    return { action: "resolve", outcome: { kind: "already-downloading" } };
  }
  return { action: "check" };
}

/** Map a completed check's result to its outcome. `up-to-date` needs the current
 *  version for the copy; `update-available` means autoDownload has begun staging
 *  it in the background. */
export function resolveCheckOutcome(
  result: InteractiveCheckResult,
  currentVersion: string,
): InteractiveCheckOutcome {
  switch (result.kind) {
    case "update-available":
      return { kind: "found-downloading", version: result.version };
    case "up-to-date":
      return { kind: "up-to-date", currentVersion };
    case "failed":
      return { kind: "check-failed" };
    default: {
      const exhaustive: never = result;
      void exhaustive;
      return { kind: "check-failed" };
    }
  }
}

/**
 * The native dialog to show for an outcome (auto-update S3). PURE copy — the
 * controller/main.ts renders it via `dialog.showMessageBox`. `title` is the bold
 * headline (macOS `message`), `body` the detail line. Only the `staged` outcome
 * offers a restart; `restartButtonId` is the index that routes back through the
 * SAME `requestRestart` path as the sidebar pill (so the restart-guard reducer
 * governs it), or null when the only button is a dismiss.
 *
 * Copy is Woody-approved and pinned in `smoke:ui-vocabulary-corpus`.
 */
export interface UpdaterDialogSpec {
  readonly title: string;
  readonly body: string;
  readonly buttons: readonly string[];
  readonly defaultId: number;
  readonly cancelId: number;
  readonly restartButtonId: number | null;
}

/** One dismiss button ("OK") — every outcome except `staged`. */
const DISMISS_ONLY = {
  buttons: ["OK"] as const,
  defaultId: 0,
  cancelId: 0,
  restartButtonId: null,
};

export function buildUpdaterDialog(outcome: InteractiveCheckOutcome): UpdaterDialogSpec {
  switch (outcome.kind) {
    case "up-to-date":
      return {
        title: "You're up to date",
        body: `Sonata ${outcome.currentVersion} is the latest version.`,
        ...DISMISS_ONLY,
      };
    case "found-downloading":
      return {
        title: "Update available",
        body:
          `Sonata ${outcome.version} is downloading in the background. ` +
          "The Restart to Update button will appear in the sidebar when it's ready.",
        ...DISMISS_ONLY,
      };
    case "already-downloading":
      return {
        title: "Update on its way",
        body:
          "An update is downloading in the background. " +
          "The Restart to Update button will appear in the sidebar when it's ready.",
        ...DISMISS_ONLY,
      };
    case "staged":
      // "Restart to Update" is the default (index 0); "Later" cancels. The
      // restart routes through requestRestart — the restart-guard reducer governs
      // it exactly as the pill's click does. Dialog and pill now share the label
      // AND the one-click semantics (2026-07-27).
      return {
        title: "Update ready",
        body: `Sonata ${outcome.version} is ready to install.`,
        buttons: ["Restart to Update", "Later"],
        defaultId: 0,
        cancelId: 1,
        restartButtonId: 0,
      };
    case "check-failed":
      return {
        title: "Couldn't check for updates",
        body: "Sonata will retry automatically.",
        ...DISMISS_ONLY,
      };
    case "disabled":
      return buildDisabledDialog(outcome.reason);
    default: {
      const exhaustive: never = outcome;
      void exhaustive;
      return { title: "Updates unavailable", body: "", ...DISMISS_ONLY };
    }
  }
}

function buildDisabledDialog(reason: UpdaterGateStatus): UpdaterDialogSpec {
  switch (reason) {
    case "disabled-internal":
      return {
        title: "Internal build",
        body: "This build updates through update-daily.sh, not the public channel.",
        ...DISMISS_ONLY,
      };
    case "disabled-location":
      return {
        title: "Updates unavailable",
        body: "Move Sonata to the Applications folder to enable automatic updates.",
        ...DISMISS_ONLY,
      };
    case "disabled-dev":
      return {
        title: "Updates unavailable",
        body: "Updates are disabled in development builds.",
        ...DISMISS_ONLY,
      };
    case "disabled-env":
      return {
        title: "Updates disabled",
        body: "Automatic updates are turned off for this session (SONATA_DISABLE_UPDATER).",
        ...DISMISS_ONLY,
      };
    case "active":
    default:
      // Unreachable: `disabled` outcomes only carry a disabled reason. Kept total.
      return {
        title: "Updates unavailable",
        body: "Automatic updates are turned off.",
        ...DISMISS_ONLY,
      };
  }
}
