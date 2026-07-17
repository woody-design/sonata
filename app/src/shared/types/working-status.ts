/**
 * Working-status contract — the agent's native status region, relayed
 * verbatim from a per-task headless screen model over the PTY stream.
 *
 * Fidelity rule: every string here is the provider's own rendering,
 * untouched. Sonata's derived/stall voice is computed downstream and must
 * stay visually distinct from these fields (two voices, one boundary).
 * Slice 4 extends this payload with phase/liveness; the `native` shape
 * is stable.
 */

export interface NativeStatusRegion {
  /** The provider's status/spinner line, verbatim (glyph included). */
  line: string;
  /** Consecutive ⎿ sub-lines directly below the status line (tips). */
  subLines: string[];
  /**
   * Failure-signature lines above the status line (retry countdown,
   * API-unreachable), verbatim and in screen order.
   */
  troubleLines: string[];
}

/**
 * Evidence freshness while a run is live. fresh = PTY activity within the
 * quiet threshold; quiet = motion has stopped (meaningful, not yet alarming);
 * silent = long enough to voice suspicion. Always "fresh" outside a run and
 * while a native approval pauses the clock (waiting for the user is not the
 * agent stalling).
 */
export type WorkingLiveness = "fresh" | "quiet" | "silent";

export interface WorkingStatusState {
  native: NativeStatusRegion | null;
  liveness: WorkingLiveness;
  /** Start of the current silence window (ISO), null while fresh. */
  silentSince: string | null;
  capturedAt: string;
}
