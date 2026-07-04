// Late-binding actions seam (map §2.5; pulled forward from D4c to D0 by the
// program-brain amendment, execution log 2026-07-03). View modules attach
// handlers that call back into the shell — flows, mode switches, prompt-nav
// choreography. A static import of main.ts would cycle (main → view → main);
// the typed interface lives here, and main.ts binds the implementation once
// at boot, BEFORE the first render (boot order R4).
//
// Scope rule (C3 ruling, execution log): bare state assignments in view event
// handlers are grammar, not policy — when a view moves out of main.ts they
// route through this seam as shell-implemented actions, never as reading-core
// transitions. The interface holds ONLY what moved view code actually calls
// (D0 survey over the D1/D2 packet); D-mid extends it as further view
// families move. Survey notes: focusRun (named in the map's candidate list)
// has zero callers since the artifact strip retired — deferred dead-code
// list, not seamed; selectSession / startNewChat / executeSlashEntry become
// needed when D3 moves the sidebar and slash-picker families.

import type { TaskViewState } from "../reading-core/state";

/** The two co-equal surfaces of a task: the crafted reading view and the raw
 *  terminal. Both ARE Duet — the switch picks which lens is in front. */
export type ViewMode = "read" | "terminal";

export interface Actions {
  /** The shell's per-render state read: the active task's view, or null in a
   *  new chat. Views call it mid-build instead of importing the state atom. */
  activeTaskView(): TaskViewState | null;
  /** Surface switch — the single choke point every "open the terminal"
   *  caller goes through (approvals, banners, fallbacks, stall notices). */
  setViewMode(mode: ViewMode): void;
  /** Sticky-prompt rail header click: scroll the prompt's turn into view. */
  scrollToPromptTurn(turnKey: string): void;
  /** Post-render prompt-nav restore — first half of the finalize contract. */
  restorePromptNavAfterRender(): void;
  /** Sticky-header rAF coalesce (T4) — second half of the finalize contract. */
  scheduleStickyPromptSync(): void;
  /** The run list's no-task empty state — the New Chat entry panel. Provided
   *  by the shell so the transcript view never imports a sibling view
   *  (view→view stays outside the import fence; main.ts composes). */
  renderTaskEntryPanel(): HTMLElement;
  /** Folder-picker flow (busy state + IPC dialog + render). */
  pickTaskFolder(): void;
}

/** The bound registry. Reading it before initActions() runs is a boot-order
 *  violation and throws at the call site (undefined member access). */
export let actions: Actions;

/** Bound once by main.ts at boot, before the first render (R4). */
export function initActions(impl: Actions): void {
  actions = impl;
}
