/**
 * The task-lifecycle single-flight: one synchronous owner for every
 * create/send/resume/mutation entered from the Composer or a satellite
 * surface. Claim before the first await, transition through the flow's
 * phases under the owning token, release in the flow's `finally`.
 *
 * Pure state policy — it touches only the atom (zero DOM/Electron), so it
 * lives in the transitions family beside its siblings and unit-tests in
 * plain node. The claim/transition/release contract is the mutual-exclusion
 * grain the flows depend on; keep its guards exact.
 */
import {
  isSessionLifecycleActive,
  type RendererState,
  type SessionLifecycle,
} from "../state";

export type ActiveSessionLifecycle = Exclude<SessionLifecycle, { phase: "idle" }>;

// Module-level token counter: uniqueness only has to hold within one renderer
// lifetime (a token never outlives the process), so a monotonic sequence is
// enough — no need to persist or seed it.
let sequence = 0;

/** Take the single-flight if idle. Returns the owning token, or null when a
 *  lifecycle is already active (state unchanged — the second caller backs
 *  off). The token binds every later transition/release to THIS claim. */
export function claimSessionLifecycle(
  state: RendererState,
  create: (ownerToken: string) => ActiveSessionLifecycle,
): string | null {
  if (isSessionLifecycleActive(state)) {
    return null;
  }
  const ownerToken = `session-lifecycle-${++sequence}`;
  state.sessionLifecycle = create(ownerToken);
  return ownerToken;
}

/** Advance the active lifecycle to its next phase. Rejects (returns false,
 *  state unchanged) when idle or when the token does not own the current
 *  phase. The stored owner is pinned to the CLAIMING token regardless of what
 *  `next.ownerToken` carries — a caller can never silently swap owners by
 *  passing a mismatched token in `next`. */
export function transitionSessionLifecycle(
  state: RendererState,
  ownerToken: string,
  next: ActiveSessionLifecycle,
): boolean {
  const current = state.sessionLifecycle;
  if (current.phase === "idle" || current.ownerToken !== ownerToken) {
    return false;
  }
  state.sessionLifecycle = { ...next, ownerToken };
  return true;
}

/** Release the single-flight back to idle. A no-op when idle or when the token
 *  does not own the current phase — a stale finally never releases a lifecycle
 *  someone else has since claimed. */
export function releaseSessionLifecycle(state: RendererState, ownerToken: string): void {
  const current = state.sessionLifecycle;
  if (current.phase !== "idle" && current.ownerToken === ownerToken) {
    state.sessionLifecycle = { phase: "idle" };
  }
}
