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

/**
 * The focus trap, armed for the mounted dialog's lifetime (review 1, minor 2).
 *
 * Claiming the caret at mount is not enough, because other surfaces claim it too
 * and some of them do so AFTER this view has painted. The one that broke the
 * modality promise: `updateDrawerActive` (view/approvals.ts) hands the caret to
 * the composer whenever a blocking drawer resolves, and the drawer renderers run
 * later in the render order than this one — so an approval answered (from the
 * co-visible terminal, say) while the quit dialog was up put the caret in a
 * composer the user could neither see nor click. Typing landed there, Return
 * SUBMITTED A PROMPT behind the scrim, and Escape both cancelled the quit and
 * fired stopRun.
 *
 * The fix is not to teach that one thief about this dialog. `focusin` bubbles
 * from every focus change in the document, so ONE listener defends the invariant
 * against every claimant — the ones that exist today, the ones that run after
 * this view, and the ones nobody has written yet. A blacklist of known thieves
 * would have to grow forever and would be wrong the first time it didn't
 * (governing principle: no blacklists).
 *
 * Re-focusing lands inside the dialog, which fires `focusin` again with a target
 * this guard accepts — so it settles in one hop, never loops.
 */
let focusTrap: ((event: FocusEvent) => void) | null = null;

function mountedDialog(): HTMLElement | null {
  return elements.quitConfirmRoot.querySelector<HTMLElement>(".quit-confirm-dialog");
}

/**
 * The caret rests on the DIALOG, never on a button (Woody's visual pass).
 *
 * A macOS default button says "Return does this" with its FILL, not with a focus
 * ring — `NSAlert` draws no ring on it, and neither does the Ghostty dialog this
 * layout references. Opening with the caret on the primary CTA put our neutral
 * `:focus-visible` ring around it and made the button look like something the
 * user had already tabbed to.
 *
 * Nothing is lost by moving it: Return and Tab are handled on the dialog element
 * itself, so they fire with the container focused, and Escape belongs to the
 * document-level ladder. The ring rule stays exactly as it is — when the user
 * genuinely Tabs onto a button it SHOULD appear, and that is now the only way it
 * ever does.
 */
function claimFocus(dialog: HTMLElement): void {
  dialog.focus();
}

function unmountQuitConfirmDialog(): void {
  if (focusTrap) {
    document.removeEventListener("focusin", focusTrap, true);
    focusTrap = null;
  }
  elements.quitConfirmRoot.replaceChildren();
  mountedRequestId = null;
}

export function renderQuitConfirmDialog(): void {
  const request = state.quitConfirm;
  if (!request) {
    if (mountedRequestId !== null) {
      unmountQuitConfirmDialog();
    }
    return;
  }

  if (mountedRequestId !== request.requestId) {
    const { scrim, dialog } = buildQuitDialog(request);
    elements.quitConfirmRoot.replaceChildren(scrim);
    mountedRequestId = request.requestId;
    focusTrap = (event: FocusEvent): void => {
      const dialog = mountedDialog();
      if (dialog && event.target instanceof Node && !dialog.contains(event.target)) {
        claimFocus(dialog);
      }
    };
    document.addEventListener("focusin", focusTrap, true);
    // Claimed once, at mount, on the surface the user's attention has just moved
    // to — never on a re-render (see `mountedRequestId` above).
    claimFocus(dialog);
    return;
  }

  // The belt the trap cannot provide: a thief that BLURS without focusing
  // anything drops the caret on <body>, and `focusin` does not fire for that.
  // Same shape as the Settings overlay's orphan reclaim (view/settings.ts), and
  // same reason — reading `document.activeElement` here makes "orphaned" a fact
  // about this paint rather than a prediction made before it.
  const active = document.activeElement;
  if (!active || active === document.body) {
    const dialog = mountedDialog();
    if (dialog) {
      claimFocus(dialog);
    }
  }
}

function buildQuitDialog(request: QuitConfirmRequest): {
  scrim: HTMLElement;
  dialog: HTMLElement;
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
  // Programmatically focusable, never in the tab order — the Settings overlay's
  // focus-handoff shape. `.quit-confirm-dialog` carries `outline: none`, so the
  // container holding the caret shows nothing.
  dialog.tabIndex = -1;

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
      // From the container (the opening state) the first Tab lands on the
      // primary — which is when the focus ring correctly appears.
      (document.activeElement === primary ? cancel : primary).focus();
    }
    // Escape is NOT handled here: it belongs to the Escape ladder in
    // renderer/main.ts, where this dialog is the top rung — so it cancels the
    // quit whether or not the caret is still inside the dialog.
  });

  dialog.append(mark, title, body, actionsRow);
  scrim.append(dialog);
  return { scrim, dialog };
}
