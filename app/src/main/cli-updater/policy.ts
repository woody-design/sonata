import type { CliUpdaterAttemptFact, CliUpdaterState } from "./state";

/**
 * The CLI updater's pure heart (Codex auto-update plan v1). ZERO I/O — no fs, no
 * child_process, no network, no clock. Every input arrives as an argument,
 * including "is that pid alive" and "what time is it", so the full ownership
 * truth table unit-tests over fact literals in plain node.
 *
 * The one idea to hold onto: **ownership of the boot update prompt is derived,
 * never stored.** `sonataOwnsPrompt` is a function of the facts, so handback and
 * reclaim need no code — no transition to fire, no flag to flip, nothing to
 * forget. Reclaim in particular is entirely emergent: the user updates codex by
 * hand and `updatePending` goes false; a newer version ships and the recorded
 * failure no longer matches `latest`; a retry succeeds and the version advances.
 * Each of those makes the handback condition stop holding, all by itself.
 */

// ── Versions ────────────────────────────────────────────────────────────────

export interface SemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * Parse a STRICT `x.y.z` (an optional `v` prefix is tolerated — some tools print
 * it — and nothing else). Deliberately narrow: a prerelease like
 * `0.147.0-alpha.10` returns null rather than silently comparing equal to
 * `0.147.0`. The npm `latest` dist-tag and `codex --version` both emit bare
 * `x.y.z` (measured 2026-08-05), so anything else is a shape we do not
 * understand — and a version we do not understand must never be allowed to
 * decide that an update is pending.
 */
export function parseVersion(raw: string | null | undefined): SemanticVersion | null {
  if (typeof raw !== "string") {
    return null;
  }
  const match = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(raw.trim());
  if (!match) {
    return null;
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** -1 / 0 / 1, field by field. */
export function compareVersions(a: SemanticVersion, b: SemanticVersion): number {
  if (a.major !== b.major) {
    return a.major < b.major ? -1 : 1;
  }
  if (a.minor !== b.minor) {
    return a.minor < b.minor ? -1 : 1;
  }
  if (a.patch !== b.patch) {
    return a.patch < b.patch ? -1 : 1;
  }
  return 0;
}

/**
 * `a < b` for two version STRINGS. False whenever either side fails to parse —
 * "we cannot compare" and "there is nothing newer" collapse to the same,
 * do-nothing answer, which is the safe one.
 */
export function semverLt(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    return false;
  }
  return compareVersions(left, right) < 0;
}

/**
 * Pull the version out of `codex --version` output.
 *
 * MEASURED on this machine (brew cask, 2026-08-05): `codex --version` prints
 * `codex-cli 0.146.0\n`. Matching a standalone `x.y.z` token rather than
 * anchoring on the `codex-cli ` prefix keeps a future rename (or an installer
 * that prints a bare version) working, while `parseVersion`'s strictness still
 * rejects anything that is not a clean three-part version.
 */
export function parseCodexVersionOutput(output: string | null | undefined): string | null {
  if (typeof output !== "string") {
    return null;
  }
  for (const token of output.split(/\s+/)) {
    const parsed = parseVersion(token);
    if (parsed) {
      return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
    }
  }
  return null;
}

// ── Attempt classification (F1 / F2 / F3) ───────────────────────────────────

export type AttemptState =
  /** No attempt has ever been recorded (or the record was unreadable). */
  | "none"
  /** Unreaped and its pid is alive within the sanity window — the mutex is held. */
  | "running"
  /** Unreaped and its pid is gone: the app died before it saw the exit. NOT a
   *  failure — we simply never learned the outcome. The next check's version
   *  comparison is the truth. */
  | "unknown"
  /** Exited non-zero. The only signal `codex update` gives for real failure
   *  (G3: it exits 0 with a success banner even on a no-op). */
  | "hard-failed"
  /** Exited 0. Says the command ran, NOT that the version moved — brew-cask lag
   *  makes exit-0-but-stale routine (G3), which is why this is not "success". */
  | "completed";

/**
 * How long an unreaped attempt may keep claiming its pid before we stop
 * believing the pid belongs to us.
 *
 * This is a pid-REUSE guard, not a timeout policy: pids wrap, and a week-old
 * record naming pid 4242 must not let some unrelated process hold the update
 * mutex forever. Thirty minutes is ~600× the measured runtime of a real `codex
 * update` (~3s on this machine, brew index refresh included) yet short enough
 * that a stale record self-clears within one check interval. Past the window the
 * attempt reads UNKNOWN — which blocks nothing, so the cost of being wrong in
 * either direction is one extra `codex update` run.
 *
 * That extra run is cheap but NOT free, and the honest bound is worth stating:
 * `codex update` is idempotent, and the brew path additionally serializes on
 * brew's own lock — but the npm / pnpm / install.sh paths have NO cross-process
 * lock, so two overlapping runs there are genuinely concurrent. What actually
 * keeps the count down is {@link shouldExecute}'s per-reason gate below, not a
 * lock.
 */
export const ATTEMPT_LIVENESS_WINDOW_MS = 30 * 60 * 1000;

export interface AttemptProbe {
  /** Result of a `kill(pid, 0)`-style liveness probe, taken by the caller. */
  readonly pidAlive: boolean;
  /** Epoch ms "now", taken by the caller. */
  readonly nowMs: number;
}

/**
 * Classify the one persisted attempt record. Pure: the caller supplies the two
 * facts that would otherwise require I/O.
 */
export function classifyAttempt(
  attempt: CliUpdaterAttemptFact | null,
  probe: AttemptProbe,
): AttemptState {
  if (!attempt) {
    return "none";
  }
  if (attempt.exitCode !== null) {
    return attempt.exitCode === 0 ? "completed" : "hard-failed";
  }
  const held = probe.pidAlive && isWithinLivenessWindow(attempt.startedAt, probe.nowMs);
  return held ? "running" : "unknown";
}

/** True only while the recorded pid is alive AND the record is young enough for
 *  that pid to plausibly still be ours. A startedAt we cannot parse, or one in
 *  the future, fails the window: an untrustworthy time base is not a licence to
 *  hold the mutex. */
function isWithinLivenessWindow(startedAt: string, nowMs: number): boolean {
  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) {
    return false;
  }
  const age = nowMs - startedMs;
  return age >= 0 && age <= ATTEMPT_LIVENESS_WINDOW_MS;
}

// ── The three predicates ────────────────────────────────────────────────────

/**
 * Why a cycle ran. Lives here rather than with the scheduler because exactly one
 * DECISION turns on it (see {@link shouldExecute}) — and every decision in this
 * design lives in the pure module.
 */
export type CliUpdaterCycleReason = "first-check" | "interval" | "pty-exit" | "manual";

/**
 * Whether a trigger's FREQUENCY is bounded by a clock Sonata controls.
 *
 * The 60s post-launch tick and the 12h interval fire on Sonata's own schedule:
 * at most ~2/day plus one per launch, no matter what the user does. `pty-exit`
 * is different in kind — it fires on session churn, which the user can drive
 * arbitrarily often. That distinction, not the trigger's name, is what the
 * execute gate below actually cares about.
 */
function isFrequencyBounded(reason: CliUpdaterCycleReason): boolean {
  return reason !== "pty-exit";
}

export interface OwnershipInput {
  /** The `keepCodexUpToDate` setting. */
  readonly setting: boolean;
  readonly facts: CliUpdaterState;
  readonly attemptState: AttemptState;
}

export interface ExecutionInput extends OwnershipInput {
  /** Live codex PTYs. Must be zero to update — codex re-execs itself through
   *  arg0 symlinks to `current_exe()`, so swapping the binary under a live
   *  session either dangles those symlinks or silently mixes versions (G1). */
  readonly livePtyCount: number;
  /** What triggered this cycle. Gates retries — see {@link shouldExecute}. */
  readonly reason: CliUpdaterCycleReason;
}

/** A newer version is known to exist. Requires a comparable pair — an
 *  unreachable registry or an absent codex is not "pending". */
export function updatePending(facts: CliUpdaterState): boolean {
  const check = facts.lastCheck;
  return check !== null && check.ok && semverLt(check.installed, check.latest);
}

/**
 * Whether SONATA speaks to the user at spawn time (suppressing codex's native
 * boot prompt), as opposed to handing the conversation back to codex.
 *
 * Handback happens in exactly one situation: there is a pending update AND we
 * demonstrably hard-failed at *that same* version. Anything less specific keeps
 * ownership:
 *  - UNKNOWN never hands back — an app that died mid-update told us nothing
 *    about whether codex can be updated.
 *  - Staleness never hands back — "pending for a long time" is not evidence of
 *    failure, and the starvation horizon was explicitly rejected (D6).
 *  - A hard failure recorded against an OLDER version never hands back — a newer
 *    release is a fresh chance, and that is the whole reclaim mechanism.
 */
export function sonataOwnsPrompt(input: OwnershipInput): boolean {
  if (!input.setting) {
    return false;
  }
  return !(updatePending(input.facts) && hardFailedForLatest(input));
}

/**
 * Whether to launch `codex update` right now.
 *
 * Note what is NOT here: HARD-FAIL is not excluded. While ownership has been
 * handed back, Sonata keeps retrying silently on the scheduled cycles — that is
 * precisely how it re-earns ownership, and it costs nothing the user can see.
 * Only a RUNNING attempt blocks outright, because that is the mutex.
 *
 * The retry gate (O1) is what keeps "retry on every cycle" from turning into
 * "retry on every session close". Under brew-cask lag an attempt routinely exits
 * 0 without moving the version, so `updatePending` stays true indefinitely — and
 * a user who opens and closes ten Codex sessions in an afternoon would otherwise
 * launch ten package-manager runs. So: a frequency-bounded trigger retries
 * unconditionally (≈2/day + 1/launch, a rate nothing can inflate), while a
 * churn-driven `pty-exit` executes only when no attempt has been made for the
 * CURRENT latest at all — regardless of how that attempt turned out.
 *
 * Deliberately no wall-clock cooldown and no new persisted field: the existing
 * `forVersion` vs `latest` comparison already carries "we have tried this one",
 * and a time horizon is a rejected mechanism class in this design (D6).
 */
export function shouldExecute(input: ExecutionInput): boolean {
  return (
    input.setting &&
    updatePending(input.facts) &&
    input.livePtyCount === 0 &&
    input.attemptState !== "running" &&
    (isFrequencyBounded(input.reason) || !alreadyAttemptedLatest(input.facts))
  );
}

/** An attempt has been launched for the current `latest`, whatever its outcome
 *  (running, unknown, failed, or completed-but-stale). */
export function alreadyAttemptedLatest(facts: CliUpdaterState): boolean {
  return (
    facts.lastAttempt !== null &&
    facts.lastCheck !== null &&
    facts.lastAttempt.forVersion === facts.lastCheck.latest
  );
}

/** The handback condition's version scope (F3): the failure has to be against
 *  the version we are currently trying to reach, not some older one. */
function hardFailedForLatest(input: OwnershipInput): boolean {
  return input.attemptState === "hard-failed" && alreadyAttemptedLatest(input.facts);
}
