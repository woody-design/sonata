// The New Chat readiness card (CLI readiness S2; plan D6, D8, D9).
//
// A pre-task surface, and that is what makes it a different family from the
// attention banners next door: a banner is task-keyed and says something about a
// conversation in flight, while this says the machine cannot start one yet. It
// borrows the banners' voice — hairline ring, raised surface, one quiet sentence,
// a pill action — because the two are the same KIND of statement (a fact plus a
// pointer), and it shares none of their code, because they share no state.
//
// It mounts in the composer slot and NOTHING ELSE MOVES (D9). The composer card
// stays exactly where it is, chips live: the draft's provider switcher must remain
// reachable while the card shows (D6), and it lives on that card. What the card
// takes away is only the ability to SEND — see `.cli-readiness-active` below.
//
// Every decision about which card to show, and every word in it, is in the pure
// selector (reading-core/selectors/cli-readiness-card.ts). This module paints.

import {
  cliReadinessCard,
  type CliReadinessCardAction,
} from "../../reading-core/selectors/cli-readiness-card";
import type { RendererState } from "../../reading-core/state";
import { elements } from "../dom";
import { actions } from "../actions";

/** The shell's state atom, bound once at boot for the card's read paths. */
let state: RendererState;

export function initCliReadinessCardView(stateRef: RendererState): void {
  state = stateRef;
}

export function renderCliReadinessCard(): void {
  const model = cliReadinessCard(state);
  // The class is the send gate as well as the style hook: the composer's submit
  // handler checks it, the same way it checks `.drawer-active`. One condition, one
  // place — a card on screen and a live send path can never disagree.
  elements.composer.classList.toggle("cli-readiness-active", model !== null);
  if (!model) {
    elements.cliReadinessCardRoot.replaceChildren();
    return;
  }

  const card = document.createElement("section");
  card.className = "cli-readiness-card";
  card.dataset.kind = model.kind;
  card.dataset.provider = model.provider;
  // A statement about the machine, not a passing notice: announced, so someone
  // driving by keyboard is not left wondering why the composer went quiet.
  card.setAttribute("role", "status");

  const copy = document.createElement("p");
  copy.className = "cli-readiness-copy";
  copy.textContent = model.copy;
  card.append(copy);

  if (model.actions.length > 0) {
    const row = document.createElement("div");
    row.className = "cli-readiness-actions";
    for (const action of model.actions) {
      row.append(renderAction(action));
    }
    card.append(row);
  }

  elements.cliReadinessCardRoot.replaceChildren(card);
}

function renderAction(action: CliReadinessCardAction): HTMLButtonElement {
  const button = document.createElement("button");
  button.id = action.domId;
  button.className = "cli-readiness-action";
  button.type = "button";
  button.dataset.action = action.kind;
  button.dataset.provider = action.provider;
  button.textContent = action.label;
  button.addEventListener("click", () => {
    // Fire-and-forget through the seam. The card does not go optimistic: main
    // publishes the run's `running` phase before it even opens the window, and
    // that push is what repaints this card — so there is no window in which a
    // local guess could contradict the authority.
    if (action.kind === "start") {
      actions.startCliLogin(action.provider);
      return;
    }
    actions.installCli(action.provider);
  });
  return button;
}
