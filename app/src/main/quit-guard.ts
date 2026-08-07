/**
 * The quit / last-window confirmation guard's DECISIONS and COPY (Focus/Flow S4,
 * D5). PURE — no Electron, no `dialog`, no BrowserWindow — so the whole truth
 * table and the dialog copy unit-test in plain node (`smoke:quit-guard`). The
 * impure shell (menu item, window `close` handlers, the renderer push, the
 * native message box) lives in main.ts, exactly as the updater's does
 * (`updater/updater-interactive.ts` + main.ts's `runInteractiveUpdaterCheck`).
 *
 * Why a guard at all: Sonata's quit and its last-window close are the SAME
 * event for the user's work — `before-quit` disposes the RuntimeController, and
 * so does `window-all-closed` (main.ts). Every live CLI dies either way. The
 * sessions are resumable next launch, so the dialog guards against
 * INTERRUPTION, not loss — which is why it is one plain question and not a
 * per-session inventory.
 *
 * ── Where the guard is armed, and why it is NOT `before-quit` ────────────────
 *
 * D5 names two gestures: **Cmd+Q** and **closing the last remaining window**.
 * Both are armed at the gesture — the Quit MENU ITEM (which owns the ⌘Q
 * accelerator) and each window's `close` event — never at `app.on("before-quit")`.
 *
 * `before-quit` looks like the tidier choke point and is the wrong place, for
 * two independent reasons:
 *
 *   1. MEASURED (2026-08-06): an Electron app that `preventDefault()`s
 *      `before-quit` can never be closed by Playwright. `electronApp.close()`
 *      calls `app.quit()` and then waits for the process to die with NO
 *      timeout — probed against a minimal Electron app, `close()` had still not
 *      resolved after 5 minutes. Every one of this repo's ~100 e2e files ends
 *      in `electronApp.close()`, so a `before-quit` guard hangs the entire
 *      suite. Guarding the gesture leaves `app.quit()` a clean, honest
 *      "terminate now" for the harness, for `quitAndInstall()` (an update
 *      restart the user already consented to), and for the non-darwin
 *      `window-all-closed` path.
 *   2. `before-quit` also fires for a macOS logout/restart. An app that answers
 *      a system shutdown with a modal is user-hostile, and D5 asks about a
 *      user's quit gesture, not about every route out of the process.
 *
 * The one behavior this costs: quitting from the DOCK icon's context menu while
 * windows are open bypasses the dialog (it reaches `before-quit` without
 * passing the menu item). That gesture is a deliberate two-step — right-click,
 * then Quit — and the dialog exists for the accident, which is ⌘Q. Recorded
 * here rather than papered over.
 */

import type { QuitConfirmRequest } from "../shared/types";

/** One dialog, two surfaces. The renderer draws the branded version and
 *  `dialog.showMessageBox` draws the fallback, and BOTH read their words from
 *  the spec below — so a copy change cannot land on one surface only.
 *
 *  `buttons` is in native `showMessageBox` order (index = button id); the
 *  renderer stacks them primary-over-cancel per the approved layout. */
export interface QuitDialogSpec {
  readonly title: string;
  readonly body: string;
  readonly buttons: readonly string[];
  /** Return activates this one (macOS default-button semantics). */
  readonly defaultId: number;
  /** Esc activates this one. */
  readonly cancelId: number;
  /** The id that means "go ahead and quit" — never inferred from a label. */
  readonly confirmButtonId: number;
}

/**
 * The confirmation dialog. Copy is Woody-approved (D5) and pinned in
 * `smoke:ui-vocabulary-corpus`.
 *
 * It takes no arguments on purpose: D5 rules that the question is the same
 * REGARDLESS of session liveness ("always confirm"), and the same for both
 * gestures. A parameter here would be an invitation to make it conditional.
 */
export function buildQuitDialog(): QuitDialogSpec {
  return {
    title: "Quit Sonata?",
    body: "All sessions will be terminated",
    buttons: ["Close Sonata", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    confirmButtonId: 0,
  };
}

/** Project a spec onto the renderer push (`QuitConfirmRequest`, shared/types —
 *  it crosses the IPC boundary). The labels are READ OUT of the spec's
 *  button list by id rather than restated, which is what makes "one source for
 *  the copy" a fact instead of a convention. */
export function quitConfirmRequestFrom(
  spec: QuitDialogSpec,
  requestId: number,
): QuitConfirmRequest {
  return {
    requestId,
    title: spec.title,
    body: spec.body,
    confirmLabel: spec.buttons[spec.confirmButtonId] ?? "",
    cancelLabel: spec.buttons[spec.cancelId] ?? "",
  };
}

/** Which surface asks. `renderer` is the branded dialog in the main (Reading)
 *  window; `native` is `dialog.showMessageBox`, for when the window that must
 *  ask has no Sonata dialog surface of its own (CLI / Preview). */
export type QuitAskHost = "renderer" | "native";

export interface QuitRequestFacts {
  /** A confirmation is already on screen (either surface). */
  readonly asking: boolean;
  /** Open, non-destroyed BrowserWindows. */
  readonly openWindowCount: number;
  /** The main (Reading) window exists and can draw the branded dialog. */
  readonly mainWindowCanAsk: boolean;
}

export type QuitRequestDecision =
  /** Nothing to protect (or already confirmed): call `app.quit()`. */
  | { readonly action: "quit" }
  /** A confirmation is already up — do not stack a second one. */
  | { readonly action: "ignore" }
  | { readonly action: "ask"; readonly host: QuitAskHost };

/**
 * The ⌘Q / Quit-menu decision.
 *
 * Clause order is the reasoning order:
 *   1. A dialog is already asking — a second ⌘Q must not stack another.
 *   2. ZERO windows → quit outright. D5's one principled exception to "always
 *      confirm": `window-all-closed` already disposed every runtime, so the
 *      PTYs are dead and there is nothing left to protect. Asking would be
 *      theatre.
 *   3. The main window can draw the branded dialog → ask there.
 *   4. Otherwise a satellite window is all there is → native fallback.
 */
export function decideQuitRequest(facts: QuitRequestFacts): QuitRequestDecision {
  if (facts.asking) {
    return { action: "ignore" };
  }
  if (facts.openWindowCount === 0) {
    return { action: "quit" };
  }
  return { action: "ask", host: facts.mainWindowCanAsk ? "renderer" : "native" };
}

export interface WindowCloseFacts {
  /** The app is already going down (`before-quit` set the flag). Window closes
   *  during a quit are the quit's own teardown — never re-ask there. */
  readonly quitting: boolean;
  /** This window's close was already confirmed; this is the second pass. */
  readonly closeConfirmed: boolean;
  /** This is the last non-destroyed window — closing it kills every runtime. */
  readonly isLastWindow: boolean;
  /** It is the main (Reading) window, so it can draw the branded dialog. */
  readonly isMainWindow: boolean;
  /** A confirmation is already on screen (either surface). */
  readonly asking: boolean;
}

export type WindowCloseDecision =
  /** Let the close proceed untouched. */
  | { readonly action: "close" }
  /** `preventDefault()` and do nothing else — a confirmation is already up. */
  | { readonly action: "ignore" }
  | { readonly action: "ask"; readonly host: QuitAskHost };

/**
 * The window-`close` decision.
 *
 * Clause order, and why each precedes the next:
 *   1. `quitting` — the app is tearing down; a guard here would fight the quit
 *      the user already confirmed.
 *   2. `closeConfirmed` — this is the re-entry after the user said yes.
 *   3. NOT the last window — nothing is at stake: satellites come and go and
 *      the runtimes outlive them. This deliberately precedes the `asking`
 *      clause: closing a satellite while a quit dialog is up is exactly what
 *      the user clicked, and it costs them nothing.
 *   4. `asking` — the last window, with a confirmation already on screen (e.g.
 *      the user clicked the traffic light while the ⌘Q dialog was up). Hold the
 *      window; the dialog on screen is already the question.
 *   5. Otherwise ask — branded in the main window, native in a satellite.
 *
 * A confirmed close proceeds as a normal `close()` (main.ts re-enters here with
 * `closeConfirmed`), never `destroy()`: the window's own teardown listeners —
 * geometry capture, the terminal window's open-preference persist — are part of
 * the product, and a bypass would silently skip them.
 */
export function decideWindowClose(facts: WindowCloseFacts): WindowCloseDecision {
  if (facts.quitting || facts.closeConfirmed || !facts.isLastWindow) {
    return { action: "close" };
  }
  if (facts.asking) {
    return { action: "ignore" };
  }
  return { action: "ask", host: facts.isMainWindow ? "renderer" : "native" };
}
