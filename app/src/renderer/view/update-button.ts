// The sidebar update pill (auto-update S2): the app's ONLY ambient update
// affordance. It exists — visibly — exactly when there is something the user can
// do, i.e. an update is downloaded and staged (agreed design §Behavior). A
// background download stages silently with no UI; when it lands, this pill
// lights up in the sidebar's bottom-right.
//
// A persistent node like the terminal-window toggle: created once at boot and
// updated imperatively from the updater-state stream. It lives in
// #sidebar-update-slot, a sibling of the scrolling session list, so renderSidebar's
// list rebuild never touches it.
//
// State model — two independent axes:
//   • staged: the last renderer-facing updater state ({version} when staged,
//     null when idle). null ⇒ the slot is display:none (no reserved space).
//   • phase: the interaction the user has taken on a VISIBLE pill —
//       resting  → "Update"            (calm, one click to arm)
//       armed    → "Restart to Update" (inline confirm; a running session is not
//                                        restarted on a single stray click)
//       updating → "Updating…"         (disabled; the restart is requested and the
//                                        app is expected to quit momentarily)
//
// The armed confirm stands down the same way every transient sidebar affordance
// does — on a revert timeout, on a sidebar scroll/resize (the dismiss choke
// point in sidebar.ts), and on an outside click (the document click handler in
// main.ts) — via the injected `revertArmedUpdateButton` below.

import type { UpdaterState } from "../../shared/types";
import { elements } from "../dom";

const LABEL_RESTING = "Update";
const LABEL_ARMED = "Restart to Update";
const LABEL_UPDATING = "Updating…";

// Armed "Restart to Update" reverts to "Update" after this idle window when the
// user neither confirms nor interacts elsewhere — the inline confirm is a
// pause, not a mode you can get stuck in.
const ARM_REVERT_MS = 6_000;

// ShipIt no-op fallback (assigned by the S1 review). macOS `quitAndInstall` can
// silently return WITHOUT quitting (electron-updater #7356 / #8795). The
// main-side controller already releases its guard on the THROWING path; this
// covers the non-throwing path renderer-side: if we are still alive this long
// after asking to restart, un-wedge the pill back to "Update" so it never sticks
// permanently on "Updating…".
const WEDGE_REVERT_MS = 15_000;

/** The updater bridge surface this widget needs — injected from main.ts (the
 *  composition root wires it to window.sonataRuntime), the same decoupling every
 *  other view family uses instead of touching the runtime bridge directly. */
export interface UpdateButtonDeps {
  onUpdaterState(callback: (state: UpdaterState) => void): () => void;
  readUpdaterState(): Promise<UpdaterState>;
  requestUpdaterRestart(): Promise<void>;
}

type Phase = "resting" | "armed" | "updating";

let deps: UpdateButtonDeps | null = null;
let button: HTMLButtonElement | null = null;
let staged: { version: string } | null = null;
let phase: Phase = "resting";
let armTimer: number | undefined;
let wedgeTimer: number | undefined;

export function initUpdateButton(dependencies: UpdateButtonDeps): void {
  deps = dependencies;

  button = document.createElement("button");
  button.id = "sidebar-update-button";
  // `.primary` = the design system's primary-action grammar (ink fill + disabled
  // treatment); `.sidebar-update-button` = pill geometry + placement only.
  button.className = "sidebar-update-button primary";
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
    clearArmTimer();
    clearWedgeTimer();
    render();
    return;
  }
  const wasHidden = staged === null;
  staged = { version: next.version };
  // A re-broadcast while the pill is armed/updating (e.g. a re-check that keeps
  // the same staged version) must not reset the user's interaction; only a
  // transition out of hidden seeds the resting phase.
  if (wasHidden) {
    phase = "resting";
  }
  render();
}

function onClick(): void {
  if (!staged || !deps) {
    return;
  }
  if (phase === "resting") {
    phase = "armed";
    clearArmTimer();
    armTimer = window.setTimeout(() => {
      armTimer = undefined;
      if (phase === "armed") {
        phase = "resting";
        render();
      }
    }, ARM_REVERT_MS);
    render();
    return;
  }
  if (phase === "armed") {
    phase = "updating";
    clearArmTimer();
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
    return;
  }
  // updating: disabled and non-interactive — nothing to do.
}

/** Revert an ARMED pill back to "Update". Called by the sidebar's scroll/resize
 *  dismiss choke point (sidebar.ts) and the document outside-click handler
 *  (main.ts), so the inline confirm stands down on the same "you looked away"
 *  grammar as the sidebar menus. No-op unless armed — an in-flight "Updating…"
 *  must never be interrupted, and a hidden/resting pill has nothing to revert. */
export function revertArmedUpdateButton(): void {
  if (phase !== "armed") {
    return;
  }
  phase = "resting";
  clearArmTimer();
  render();
}

function render(): void {
  if (!button) {
    return;
  }
  if (!staged) {
    elements.sidebarUpdateSlot.classList.add("hidden");
    button.disabled = false;
    button.classList.remove("armed", "updating");
    return;
  }
  elements.sidebarUpdateSlot.classList.remove("hidden");
  button.dataset.tooltip = `Sonata ${staged.version}`;
  button.classList.toggle("armed", phase === "armed");
  button.classList.toggle("updating", phase === "updating");
  button.disabled = phase === "updating";
  button.textContent =
    phase === "updating" ? LABEL_UPDATING : phase === "armed" ? LABEL_ARMED : LABEL_RESTING;
}

function clearArmTimer(): void {
  if (armTimer !== undefined) {
    window.clearTimeout(armTimer);
    armTimer = undefined;
  }
}

function clearWedgeTimer(): void {
  if (wedgeTimer !== undefined) {
    window.clearTimeout(wedgeTimer);
    wedgeTimer = undefined;
  }
}
