import { JsonSettingsStore, cliUpdaterStatePath } from "../settings-store";

/**
 * The CLI updater's FACTS — the only thing it persists (Codex auto-update plan
 * v1).
 *
 * The design's load-bearing property is that **ownership of the boot update
 * prompt is derived, never stored**: there is no `mode` / `ownedBy` field here
 * and there must never be one. A stored ownership flag would be a second source
 * of truth that can desynchronize from reality; deriving it from these two
 * records makes the invariant a property of the representation rather than a
 * discipline someone has to maintain (D8).
 *
 * Everything the policy needs is a pure function of these two records plus one
 * live pid-liveness probe. See policy.ts.
 */

/** What the last check learned. `installed`/`latest` are bare `x.y.z` strings. */
export interface CliUpdaterCheckFact {
  /** ISO timestamp of the check. */
  readonly at: string;
  /**
   * True only when BOTH versions were obtained and parsed — i.e. the check
   * produced a comparable pair. A missing codex, an unreachable registry and an
   * unparseable version string all land here as `false`, because the policy
   * treats them identically: nothing is known, so nothing is pending.
   */
  readonly ok: boolean;
  /** `codex --version`, or null when codex is absent / unparseable. */
  readonly installed: string | null;
  /** npm dist-tag `latest`, or null when unreachable / unparseable. */
  readonly latest: string | null;
}

/**
 * The last `codex update` we launched. Written the moment the child exists
 * (exitCode null) and patched from the exit listener, so this ONE record is
 * simultaneously the three-state outcome (F1), the cross-restart lock (F2) and
 * the failure's version scope (F3). See `classifyAttempt`.
 */
export interface CliUpdaterAttemptFact {
  /** The `latest` this attempt was trying to reach — a HARD-FAIL counts only
   *  against this version, never against codex-updating in general. */
  readonly forVersion: string;
  /** ISO timestamp of the spawn. Also the pid-reuse sanity anchor. */
  readonly startedAt: string;
  /** The detached child's pid. */
  readonly pid: number;
  /** null while the child is unreaped BY US — either still running, or the app
   *  died before it could observe the exit. Distinguishing those two is the
   *  pid-liveness probe's job, not this field's. */
  readonly exitCode: number | null;
  /** Absolute path of the file the child's stdout+stderr were appended to. */
  readonly logFile: string;
}

export interface CliUpdaterState {
  readonly lastCheck: CliUpdaterCheckFact | null;
  readonly lastAttempt: CliUpdaterAttemptFact | null;
}

export const EMPTY_CLI_UPDATER_STATE: CliUpdaterState = {
  lastCheck: null,
  lastAttempt: null,
};

/**
 * Normalize-on-read, fail-safe: anything that is not a complete, well-typed
 * record becomes `null` for that slot. A half-written or hand-edited file must
 * never be able to fabricate a fact — losing a fact costs one re-check, while
 * trusting a malformed one could suppress the user's update prompt.
 */
export function normalizeCliUpdaterState(value: unknown): CliUpdaterState {
  if (!isRecord(value)) {
    return EMPTY_CLI_UPDATER_STATE;
  }
  return {
    lastCheck: normalizeCheckFact(value.lastCheck),
    lastAttempt: normalizeAttemptFact(value.lastAttempt),
  };
}

function normalizeCheckFact(value: unknown): CliUpdaterCheckFact | null {
  if (!isRecord(value)) {
    return null;
  }
  const at = isNonEmptyString(value.at) ? value.at : null;
  if (at === null || typeof value.ok !== "boolean") {
    return null;
  }
  const installed = isNonEmptyString(value.installed) ? value.installed : null;
  const latest = isNonEmptyString(value.latest) ? value.latest : null;
  return {
    at,
    // `ok` can only ever narrow on read: a file claiming ok with a missing
    // version is incoherent, and the coherent reading is "not comparable".
    ok: value.ok && installed !== null && latest !== null,
    installed,
    latest,
  };
}

function normalizeAttemptFact(value: unknown): CliUpdaterAttemptFact | null {
  if (!isRecord(value)) {
    return null;
  }
  const { forVersion, startedAt, pid, exitCode, logFile } = value;
  const validPid = isInteger(pid) && pid > 0;
  if (
    !isNonEmptyString(forVersion) ||
    !isNonEmptyString(startedAt) ||
    !isNonEmptyString(logFile) ||
    !validPid
  ) {
    return null;
  }
  return {
    forVersion,
    startedAt,
    pid,
    // Anything that is not an integer exit code reads as "not observed" — the
    // conservative slot, since it keeps the record out of HARD-FAIL.
    exitCode: isInteger(exitCode) ? exitCode : null,
    logFile,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/**
 * The facts file. Follows the `JsonSettingsStore` family (normalize-on-read,
 * atomic tmp+rename write); the path helper lives with its nine siblings in
 * settings-store.ts.
 */
export class CliUpdaterStateStore extends JsonSettingsStore<CliUpdaterState> {
  constructor(filePath: string = cliUpdaterStatePath()) {
    super(filePath, normalizeCliUpdaterState);
  }
}

/**
 * The store as its consumers need it — the two methods, nothing else. Lets a
 * test hand the executor and the facade an in-memory fake instead of a temp
 * directory when the file itself is not what is under test (the
 * `preview-sessions` fake-store precedent).
 */
export interface CliUpdaterFactsStore {
  read(): CliUpdaterState;
  write(next: CliUpdaterState): CliUpdaterState;
}
