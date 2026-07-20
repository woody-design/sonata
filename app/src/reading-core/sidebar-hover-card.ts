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

export interface SidebarHoverCardTiming {
  openDelayMs: number;
  warmWindowMs: number;
}

const DEFAULT_TIMING: SidebarHoverCardTiming = {
  openDelayMs: SIDEBAR_HOVER_CARD_OPEN_DELAY_MS,
  warmWindowMs: SIDEBAR_HOVER_CARD_WARM_WINDOW_MS,
};

/**
 * Pure hover-card ownership policy. An already-open card moves directly from
 * task to task; there is deliberately no closed state between those owners.
 */
export function reduceSidebarHoverCard(
  state: SidebarHoverCardState,
  event: SidebarHoverCardEvent,
  timing: SidebarHoverCardTiming = DEFAULT_TIMING,
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
      openAt: event.now + Math.max(SIDEBAR_HOVER_CARD_OPEN_DELAY_MS, timing.openDelayMs),
    };
  }

  if (event.type === "row-leave") {
    if (state.kind === "open") {
      return {
        kind: "warm",
        until: event.now + Math.max(0, timing.warmWindowMs),
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
