// The sidebar update pill (auto-update S2): the app's ONLY ambient update
// affordance. It exists — visibly — exactly when there is something the user can
// do, i.e. an update is downloaded and staged (agreed design §Behavior). A
// background download stages silently with no UI; when it lands, this pill
// lights up in the sidebar's bottom-right.
//
// A persistent node like the terminal-window toggle: created once at boot and
// updated imperatively from the updater-state stream. It lives in
// #sidebar-update-slot, the right half of the sidebar footer and a sibling of
// the scrolling session list, so renderSidebar's list rebuild never touches it.
//
// State model — two independent axes:
//   • staged: the last renderer-facing updater state ({version} when staged,
//     null when idle). null ⇒ the slot is display:none (no reserved space).
//   • phase: what the pill is doing —
//       resting  → "Restart to Update" (ONE click restarts; the label itself
//                                        carries the warning, Chrome's
//                                        "Relaunch to update" pattern)
//       updating → "Installing…"       (disabled; the restart is requested and
//                                        the app is expected to quit momentarily)
//
// The retired third state (2026-07-27): resting used to read "Update" and the
// first click only ARMED an inline "Restart to Update" confirm. An illegible
// confirm is worse than none — a user who does not realize a second click is
// required simply never updates — so the confirm, its revert timeout, and the
// dismiss-gesture hooks (sidebar scroll/resize, outside click) are gone. The
// staged-update dialog (updater-interactive.ts) already used one-click
// "Restart to Update"; pill and dialog now share label and semantics.

import type { UpdaterState } from "../../shared/types";
import { elements } from "../dom";

const LABEL_RESTING = "Restart to Update";
const LABEL_UPDATING = "Installing…";

// ShipIt no-op fallback (assigned by the S1 review). macOS `quitAndInstall` can
// silently return WITHOUT quitting (electron-updater #7356 / #8795). The
// main-side controller already releases its guard on the THROWING path; this
// covers the non-throwing path renderer-side: if we are still alive this long
// after asking to restart, un-wedge the pill back to its resting label so it
// never sticks permanently on "Installing…".
const WEDGE_REVERT_MS = 15_000;

/** The updater bridge surface this widget needs — injected from main.ts (the
 *  composition root wires it to window.sonataRuntime), the same decoupling every
 *  other view family uses instead of touching the runtime bridge directly. */
export interface UpdateButtonDeps {
  onUpdaterState(callback: (state: UpdaterState) => void): () => void;
  readUpdaterState(): Promise<UpdaterState>;
  requestUpdaterRestart(): Promise<void>;
}

type Phase = "resting" | "updating";

let deps: UpdateButtonDeps | null = null;
let button: HTMLButtonElement | null = null;
let staged: { version: string } | null = null;
let phase: Phase = "resting";
let wedgeTimer: number | undefined;

export function initUpdateButton(dependencies: UpdateButtonDeps): void {
  deps = dependencies;

  button = document.createElement("button");
  button.id = "sidebar-update-button";
  button.className = "sidebar-update-button";
  button.type = "button";
  button.addEventListener("click", onClick);
  elements.sidebarUpdateSlot.append(button);
  render();

  // Hydration (agreed design; S1 report): subscribe for live pushes AND read
  // once — a staged broadcast fired before this window (or this listener)
  // existed would otherwise be missed, leaving a downloaded update invisible.
  deps.onUpdaterState(applyState);
  void deps
    .readUpdaterState()
    .then(applyState)
    .catch(() => {
      // Best-effort catch-up; a later broadcast still lights the pill.
    });
}

function applyState(next: UpdaterState): void {
  if (next.status === "idle") {
    staged = null;
    phase = "resting";
    clearWedgeTimer();
    render();
    return;
  }
  const wasHidden = staged === null;
  staged = { version: next.version };
  // A re-broadcast while the restart is in flight (e.g. a re-check that keeps
  // the same staged version) must not reset the user's interaction; only a
  // transition out of hidden seeds the resting phase.
  if (wasHidden) {
    phase = "resting";
  }
  render();
}

function onClick(): void {
  if (!staged || !deps || phase === "updating") {
    // updating: disabled and non-interactive — nothing to do.
    return;
  }
  phase = "updating";
  render();
  void deps.requestUpdaterRestart();
  // Non-throwing ShipIt no-op guard: if the app has not quit by now, revert.
  clearWedgeTimer();
  wedgeTimer = window.setTimeout(() => {
    wedgeTimer = undefined;
    if (phase === "updating") {
      console.warn(
        "[updater] still running ~15s after restart request — reverting the update pill (macOS ShipIt no-op).",
      );
      phase = "resting";
      render();
    }
  }, WEDGE_REVERT_MS);
}

function render(): void {
  if (!button) {
    return;
  }
  if (!staged) {
    elements.sidebarUpdateSlot.classList.add("hidden");
    button.disabled = false;
    button.classList.remove("updating");
    return;
  }
  elements.sidebarUpdateSlot.classList.remove("hidden");
  button.dataset.tooltip = `Sonata ${staged.version}`;
  button.classList.toggle("updating", phase === "updating");
  button.disabled = phase === "updating";
  button.textContent = phase === "updating" ? LABEL_UPDATING : LABEL_RESTING;
}

function clearWedgeTimer(): void {
  if (wedgeTimer !== undefined) {
    window.clearTimeout(wedgeTimer);
    wedgeTimer = undefined;
  }
}
