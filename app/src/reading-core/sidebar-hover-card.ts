export const SIDEBAR_HOVER_CARD_OPEN_DELAY_MS = 500;
export const SIDEBAR_HOVER_CARD_WARM_WINDOW_MS = 250;

export type SidebarHoverCardState =
  | { kind: "idle" }
  | { kind: "pending"; taskId: string; openAt: number }
  | { kind: "open"; taskId: string }
  | { kind: "warm"; until: number };

export type SidebarHoverCardEvent =
  | { type: "row-enter"; taskId: string; now: number }
  | { type: "row-leave"; now: number }
  | { type: "timer"; now: number }
  | { type: "dismiss" };

/**
 * Pure hover-card ownership policy. An already-open card moves directly from
 * task to task; there is deliberately no closed state between those owners.
 *
 * Timing is fixed by the two module constants — the delays are simulated in
 * tests through the injected `now`, never through a per-call override, so there
 * is no timing parameter (a prior injectable `timing` was dead: no caller ever
 * passed it, and its open-delay was floored at the default, so it could not even
 * lower the delay it advertised — m2).
 */
export function reduceSidebarHoverCard(
  state: SidebarHoverCardState,
  event: SidebarHoverCardEvent,
): SidebarHoverCardState {
  if (event.type === "dismiss") {
    return state.kind === "idle" ? state : { kind: "idle" };
  }

  if (event.type === "row-enter") {
    if (state.kind === "open") {
      return state.taskId === event.taskId
        ? state
        : { kind: "open", taskId: event.taskId };
    }
    if (state.kind === "pending" && state.taskId === event.taskId) {
      return state;
    }
    if (state.kind === "warm" && event.now <= state.until) {
      return { kind: "open", taskId: event.taskId };
    }
    return {
      kind: "pending",
      taskId: event.taskId,
      openAt: event.now + SIDEBAR_HOVER_CARD_OPEN_DELAY_MS,
    };
  }

  if (event.type === "row-leave") {
    if (state.kind === "open") {
      return {
        kind: "warm",
        until: event.now + SIDEBAR_HOVER_CARD_WARM_WINDOW_MS,
      };
    }
    return state.kind === "pending" ? { kind: "idle" } : state;
  }

  if (state.kind === "pending" && event.now >= state.openAt) {
    return { kind: "open", taskId: state.taskId };
  }
  if (state.kind === "warm" && event.now > state.until) {
    return { kind: "idle" };
  }
  return state;
}
