import {
  UNKNOWN_CLI_READINESS_FACTS,
  type CliReadinessFacts,
} from "../../shared/types/cli-readiness";

/**
 * What diagnosing a failed session start needs from the readiness controller (CLI
 * readiness S4; plan D10, L5).
 *
 * A narrow port rather than the `CliReadiness` class, for the reason the
 * `CodexSpawnGate` port next door exists: the runtime controller has no business
 * with probe scheduling, focus gates, or the change broadcast — it asks one
 * question at one moment ("look again, then tell me what you see") and the type
 * says so. `CliReadiness` satisfies it structurally.
 *
 * The order matters and is the whole contract: **re-probe first, then read.** The
 * facts on hand were learned at launch, or at the last focus, and the machine has
 * since done the one thing that matters — it failed to start a CLI. Reading a
 * stale healthy fact would silence the banner exactly when it is due; reading a
 * stale broken one would accuse a machine the user has since fixed.
 */
export interface CliReadinessSource {
  /** Look at the machine again. Never rejects (the controller swallows its own
   *  probe failures and keeps the last facts). No PATH-cache bust: nothing was
   *  installed, so the captured login-shell PATH is still the PATH the spawn used
   *  — which is exactly the PATH whose verdict we want (S1's note for S4). */
  reprobe(): Promise<void>;
  /** The facts as they stand now. */
  read(): CliReadinessFacts;
}

/**
 * A source that observes nothing: never probes, always knows nothing. Since
 * `unknown` is the permissive reading (D3), a controller built with this can
 * never raise a banner — it reproduces exactly the pre-S4 behaviour instead of
 * pretending the diagnosis is wired.
 *
 * Exists for the same reason `INERT_CODEX_SPAWN_GATE` does: the option it fills is
 * REQUIRED, so a construction site that genuinely has no readiness controller has
 * to say so out loud rather than omit a field whose absence would be invisible.
 */
export const INERT_CLI_READINESS_SOURCE: CliReadinessSource = {
  reprobe(): Promise<void> {
    return Promise.resolve();
  },
  read(): CliReadinessFacts {
    return UNKNOWN_CLI_READINESS_FACTS;
  },
};
