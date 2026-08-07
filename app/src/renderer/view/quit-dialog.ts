// The quit / last-window confirmation dialog (Focus/Flow S4, D5).
//
// Structure is the Settings overlay's, verbatim in family: a fixed scrim over
// the whole window, a `role="dialog" aria-modal="true"` box on top of it, and
// the Escape ladder in renderer/main.ts owning dismissal. It sits ABOVE the
// Settings overlay in both stacking and that ladder — it is the last question
// the app asks.
//
// The layout is the vertical alert stack Woody approved as a UX pattern
// (Ghostty's quit dialog is the pattern reference ONLY): brand mark, title,
// body, primary CTA over cancel. Every value on screen — radius, border,
// surface, shadow, type, spacing — is a design token (styles.css).
//
// This view composes NO COPY. Every word arrives on `state.quitConfirm`, which
// is main's push (main/quit-guard.ts owns the words for this surface and for
// the native `dialog.showMessageBox` fallback alike), so the two surfaces cannot
// say different things.

import type { QuitConfirmRequest } from "../../shared/types";
import type { RendererState } from "../../reading-core/state";
import { elements } from "../dom";
import { actions } from "../actions";
import { sonataMark } from "./icons";

/** The shell's state atom, bound once at boot (R4). */
let state: RendererState;

export function initQuitDialogView(stateRef: RendererState): void {
  state = stateRef;
}

/**
 * The mounted ask's id, or null when nothing is mounted.
 *
 * The dialog is a pure function of its request, so it is built ONCE per ask and
 * left alone — identity-keyed reuse, the S1-D7 shape. That is not an
 * optimization: `render()` runs several times a second while a session works,
 * and a rebuild would take the caret off the focused button every time. It also
 * makes the mount the only place focus is ever claimed, so there is no
 * render-path focus grab to guard (S1's rule).
 */
let mountedRequestId: number | null = null;

export function renderQuitConfirmDialog(): void {
  const request = state.quitConfirm;
  if (!request) {
    if (mountedRequestId !== null) {
      elements.quitConfirmRoot.replaceChildren();
      mountedRequestId = null;
    }
    return;
  }
  if (mountedRequestId === request.requestId) {
    return;
  }

  const { scrim, primary } = buildQuitDialog(request);
  elements.quitConfirmRoot.replaceChildren(scrim);
  mountedRequestId = request.requestId;
  // macOS alert semantics: the default button holds the caret when the sheet
  // opens. Claimed once, at mount, on the surface the user's attention has just
  // moved to — never on a re-render (see above).
  primary.focus();
}

function buildQuitDialog(request: QuitConfirmRequest): {
  scrim: HTMLElement;
  primary: HTMLButtonElement;
} {
  const scrim = document.createElement("div");
  scrim.className = "quit-confirm-overlay";
  // Deliberately NOT dismiss-on-scrim-click (the Settings overlay's one
  // divergence): a macOS alert is answered, not clicked away, and a stray click
  // must not decide something this consequential either way.
  //
  // The `preventDefault` is load-bearing beyond making the surface behind inert,
  // and it is registered on the scrim so it catches every mousedown in the
  // dialog: suppressing mousedown's default keeps the caret ON the primary CTA
  // no matter where inside the dialog the user clicks, so Return still means
  // "Close Sonata". `click` is dispatched on mouseup regardless, so both buttons
  // keep working exactly as before.
  scrim.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });

  const dialog = document.createElement("div");
  dialog.className = "quit-confirm-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", request.title);

  const mark = sonataMark();

  const title = document.createElement("h2");
  title.className = "quit-confirm-title";
  title.textContent = request.title;

  const body = document.createElement("p");
  body.className = "quit-confirm-body";
  body.textContent = request.body;

  const primary = document.createElement("button");
  primary.className = "primary quit-confirm-action";
  primary.type = "button";
  primary.textContent = request.confirmLabel;
  primary.addEventListener("click", () => {
    actions.answerQuitConfirm(true);
  });

  const cancel = document.createElement("button");
  cancel.className = "secondary quit-confirm-action";
  cancel.type = "button";
  cancel.textContent = request.cancelLabel;
  cancel.addEventListener("click", () => {
    actions.answerQuitConfirm(false);
  });

  const actionsRow = document.createElement("div");
  actionsRow.className = "quit-confirm-actions";
  actionsRow.append(primary, cancel);

  dialog.addEventListener("keydown", (event) => {
    // Return is the default button, whichever of the two holds the caret — the
    // macOS alert rule. (Space still activates the focused button natively, so
    // Cancel remains reachable from the keyboard without a modifier.)
    if (event.key === "Enter") {
      event.preventDefault();
      actions.answerQuitConfirm(true);
      return;
    }
    // `aria-modal` is a promise; a two-button focus cycle is what makes it true.
    // Without it Tab walks out through the scrim into a composer the user cannot
    // see or click, and the caret disappears.
    if (event.key === "Tab") {
      event.preventDefault();
      (document.activeElement === primary ? cancel : primary).focus();
    }
    // Escape is NOT handled here: it belongs to the Escape ladder in
    // renderer/main.ts, where this dialog is the top rung — so it cancels the
    // quit whether or not the caret is still inside the dialog.
  });

  dialog.append(mark, title, body, actionsRow);
  scrim.append(dialog);
  return { scrim, primary };
}
