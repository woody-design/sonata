import {
  isSessionLifecycleActive,
  type RendererState,
  type SessionLifecycle,
} from "../../reading-core/state";

export type ActiveSessionLifecycle = Exclude<SessionLifecycle, { phase: "idle" }>;

let state: RendererState;
let sequence = 0;

export function initSessionLifecycle(boundState: RendererState): void {
  state = boundState;
}

export function claimSessionLifecycle(
  create: (ownerToken: string) => ActiveSessionLifecycle,
): string | null {
  if (isSessionLifecycleActive(state)) {
    return null;
  }
  const ownerToken = `session-lifecycle-${++sequence}`;
  state.sessionLifecycle = create(ownerToken);
  return ownerToken;
}

export function transitionSessionLifecycle(
  ownerToken: string,
  next: ActiveSessionLifecycle,
): boolean {
  const current = state.sessionLifecycle;
  if (current.phase === "idle" || current.ownerToken !== ownerToken) {
    return false;
  }
  state.sessionLifecycle = next;
  return true;
}

export function releaseSessionLifecycle(ownerToken: string): void {
  const current = state.sessionLifecycle;
  if (current.phase !== "idle" && current.ownerToken === ownerToken) {
    state.sessionLifecycle = { phase: "idle" };
  }
}
