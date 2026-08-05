import { spawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sonataLogsDir } from "../sonata-paths";
import { codexCommandEnv } from "./codex-env";
import type { CliUpdaterAttemptFact, CliUpdaterFactsStore } from "./state";

/**
 * The CLI updater's write half: launch `codex update` and record the attempt.
 *
 * Two properties carry the design.
 *
 * **Detached and unref'd.** `codex update` shells out to npm / `brew upgrade
 * --cask codex` / the standalone installer. Killing a package manager mid-write
 * can leave a corrupt global install, so the child must outlive Sonata rather
 * than die with it. That is also why nothing here awaits the child: the update
 * either finishes on its own or is inherited by launchd, and the next check's
 * version comparison is what tells us whether it worked (G3 — `codex update`
 * exits 0 with a success banner even on a brew no-op, so the exit code is a
 * failure signal only, never a success signal).
 *
 * **The record is the lock.** One `lastAttempt` row doubles as the cross-restart
 * mutex, so it must exist before anything can observe the child. See
 * {@link executeUpdate} for exactly when it is written and why that ordering is
 * the strongest one available.
 */

/** Codex's own subcommand — it owns install-method detection, we do not. */
const CODEX_UPDATE_ARGS = ["update"];

/**
 * How many `codex update` logs to keep (O2).
 *
 * Every attempt writes its own file, so without a ceiling this directory grows
 * for the life of the install. Twenty is sized off the actual attempt rate the
 * policy permits: the retry gate holds churn to one attempt per version, leaving
 * the 12h ticks plus one per launch — call it ~2–3/day worst case, so twenty
 * keeps roughly a week. That is the window in which someone reports "Codex
 * stopped updating last Tuesday" and the log still answers, while the directory
 * stays bounded no matter how long the app runs.
 */
export const KEEP_UPDATE_LOGS = 20;

const UPDATE_LOG_PREFIX = "codex-update-";
const UPDATE_LOG_SUFFIX = ".log";
/** The stamp shape {@link updateLogName} emits: an ISO instant with `:` and `.`
 *  swapped for `-`. */
const UPDATE_LOG_STAMP = String.raw`\d{4}-\d{2}-\d{2}T[\d-]+Z`;

/**
 * The writer and the matcher, built from ONE set of parts.
 *
 * Deriving the pattern rather than restating it is not tidiness: pruning is a
 * DELETE loop in a directory Sonata does not exclusively own, so a matcher that
 * could drift from the writer is a matcher that could one day delete the wrong
 * file. `sonataLogsDir()` has no other writer today; this does not assume that
 * stays true, and matches the FULL name, never a bare prefix.
 *
 * The stamp also makes the name **lexicographically ordered by time**, so
 * pruning sorts by name and never calls `stat`: no mtime races, no extra
 * syscalls, and a copied or touched file cannot reorder itself.
 */
const UPDATE_LOG_RE = new RegExp(
  `^${escapeRegExp(UPDATE_LOG_PREFIX)}${UPDATE_LOG_STAMP}${escapeRegExp(UPDATE_LOG_SUFFIX)}$`,
);

function updateLogName(startedAtIso: string): string {
  return `${UPDATE_LOG_PREFIX}${startedAtIso.replace(/[:.]/g, "-")}${UPDATE_LOG_SUFFIX}`;
}

function isUpdateLogName(name: string): boolean {
  return UPDATE_LOG_RE.test(name);
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Keep the newest {@link KEEP_UPDATE_LOGS} update logs, delete the rest.
 *
 * Never throws: it is called after the child is already running and its record
 * already persisted, so nothing it can do may reach the spawn path. A failed
 * prune is a directory that stays large — the log line says so — and never a
 * failed update.
 */
export function pruneUpdateLogs(
  logsDir: string,
  keep: number = KEEP_UPDATE_LOGS,
  log: (message: string) => void = () => undefined,
): void {
  // A non-finite ceiling would reach `slice()` as NaN, which slices from 0 —
  // i.e. "delete every log, including the one the running child holds". Fall
  // back to the default rather than let a nonsense number mean total deletion;
  // an explicit 0 or negative still clamps to 0, because that IS an intent.
  const ceiling = Number.isFinite(keep) ? Math.max(Math.trunc(keep), 0) : KEEP_UPDATE_LOGS;
  try {
    const logs = fs
      .readdirSync(logsDir)
      .filter(isUpdateLogName)
      // Newest first; see updateLogName for why the name is a valid clock.
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    for (const name of logs.slice(ceiling)) {
      // The newest file is always kept, so the log the child currently holds
      // open is never a candidate. (Even if it somehow were, POSIX keeps an
      // unlinked inode writable for its holder — the child would not fault.)
      fs.rmSync(path.join(logsDir, name), { force: true });
    }
  } catch (error) {
    log(`could not prune update logs in ${logsDir}: ${describe(error)}`);
  }
}

/** A spawned `codex update`, reduced to the three things the executor needs.
 *  Narrow on purpose: a test fakes this in five lines, with no `ChildProcess`
 *  stand-in and no mocking of `node:child_process`. */
export interface UpdateChild {
  /** undefined when the spawn itself failed (ENOENT and friends). */
  readonly pid: number | undefined;
  /** Fires with the exit code, or null when the child died from a signal. */
  onExit(listener: (code: number | null) => void): void;
  /** Spawn-level failure. MUST be registered — an unhandled `error` event on a
   *  real ChildProcess throws. */
  onError(listener: (error: Error) => void): void;
  /** Drop the child from the parent's event-loop refcount. */
  unref(): void;
}

export interface ExecuteOptions {
  readonly store: CliUpdaterFactsStore;
  /** The `latest` this attempt is reaching for — the scope a failure counts
   *  against (F3). */
  readonly forVersion: string;
  readonly now?: () => Date;
  readonly logsDir?: string;
  readonly spawnUpdate?: (input: SpawnInput) => UpdateChild;
  readonly log?: (message: string) => void;
  /** Test seam for the log-retention ceiling; defaults to {@link KEEP_UPDATE_LOGS}. */
  readonly keepLogs?: number;
}

export interface SpawnInput {
  /** Open, append-mode fd for the child's stdout AND stderr. The executor closes
   *  the parent's copy right after the spawn; the child keeps its own. */
  readonly logFd: number;
}

/**
 * Launch one update and persist the attempt. Synchronous — `spawn` returns
 * immediately and the facts write is a small atomic file write — which is what
 * makes the ordering below airtight.
 *
 * Ordering, and why it is the write-ahead the design asks for: the plan says the
 * record is written "before spawning", but a record's whole job is to name a
 * pid, and a pid does not exist until the spawn returns. So the strongest
 * available ordering is spawn → write, *with no await in between*: the write
 * completes in the same tick as the spawn, strictly before the event loop can
 * deliver the child's `exit`. There is therefore no interleaving in which the
 * exit patch races a missing record.
 *
 * The residual window is a hard crash in those few microseconds, which leaves an
 * orphaned `codex update` with no record. That is deliberately not defended
 * against: the alternative (write a pid-less row first, patch the pid after)
 * classifies as UNKNOWN, and UNKNOWN blocks nothing — so both designs end at the
 * same next-cycle retry, and one of them costs a nullable pid through the whole
 * schema. The duplicate run this can cause is tolerable because `codex update`
 * is idempotent; note it is NOT universally serialized — only the brew path
 * takes brew's lock, while npm / pnpm / install.sh have no cross-process lock at
 * all. What bounds the number of runs is policy's per-reason retry gate, not a
 * lock.
 *
 * Returns the persisted record, or null when the spawn produced no child.
 */
export function executeUpdate(options: ExecuteOptions): CliUpdaterAttemptFact | null {
  const now = options.now ?? (() => new Date());
  const logsDir = options.logsDir ?? sonataLogsDir();
  const spawnUpdate = options.spawnUpdate ?? defaultSpawnUpdate;
  const log = options.log ?? (() => undefined);

  const startedAt = now().toISOString();
  const logFile = path.join(logsDir, updateLogName(startedAt));

  let logFd: number;
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    logFd = fs.openSync(logFile, "a");
    // A genuine write-ahead marker: whatever happens to the child, the log says
    // what was attempted and when.
    fs.writeSync(logFd, `--- sonata: codex update -> ${options.forVersion} at ${startedAt}\n`);
  } catch (error) {
    log(`could not open update log ${logFile}: ${describe(error)}`);
    return null;
  }

  let child: UpdateChild;
  try {
    child = spawnUpdate({ logFd });
  } catch (error) {
    fs.closeSync(logFd);
    log(`spawn failed: ${describe(error)}`);
    return null;
  }

  // Registered before anything else can throw or return: on a real ChildProcess
  // an unhandled `error` event is fatal to the process.
  child.onError((error) => {
    // Deliberately does NOT patch the record to a failure. A spawn-level error
    // means codex could not be launched at all, which says nothing about whether
    // codex can be UPDATED — and fabricating a non-zero exit here would hand the
    // boot prompt back to a CLI that may not even be installed.
    log(`update child error: ${error.message}`);
  });
  child.unref();

  const { pid } = child;
  // The parent's fd copy has done its job — the child holds its own.
  fs.closeSync(logFd);

  if (pid === undefined) {
    log("update child has no pid; nothing recorded");
    return null;
  }

  const attempt: CliUpdaterAttemptFact = {
    forVersion: options.forVersion,
    startedAt,
    pid,
    exitCode: null,
    logFile,
  };
  const previous = options.store.read();
  options.store.write({ ...previous, lastAttempt: attempt });
  log(`launched codex update -> ${options.forVersion} (pid ${pid}, log ${logFile})`);

  child.onExit((code) => {
    patchExitCode(options.store, attempt, code, log);
  });

  // Last, deliberately: the child is running and its record is on disk, so
  // there is no longer any path by which housekeeping can cost us an update.
  pruneUpdateLogs(logsDir, options.keepLogs ?? KEEP_UPDATE_LOGS, log);

  return attempt;
}

/**
 * Patch the recorded exit code — but only while the record is still ours. A
 * later attempt may have replaced `lastAttempt` (the app was quit and relaunched
 * and a new cycle ran); writing our code over it would resurrect a dead fact.
 * pid + startedAt together identify the row.
 *
 * A signal death (`code === null`) is left as `null`: the child was killed, not
 * failed, and the classifier's pid probe will read it as UNKNOWN — which is the
 * honest answer.
 */
function patchExitCode(
  store: CliUpdaterFactsStore,
  attempt: CliUpdaterAttemptFact,
  code: number | null,
  log: (message: string) => void,
): void {
  if (code === null) {
    log(`codex update (pid ${attempt.pid}) died from a signal; outcome unknown`);
    return;
  }
  const current = store.read();
  const recorded = current.lastAttempt;
  if (!recorded || recorded.pid !== attempt.pid || recorded.startedAt !== attempt.startedAt) {
    return;
  }
  store.write({ ...current, lastAttempt: { ...recorded, exitCode: code } });
  log(`codex update (pid ${attempt.pid}) exited ${code}`);
}

/**
 * The spawn shape that lets the update outlive Sonata — the whole survival
 * claim, in one object.
 *
 * `detached` puts the child in its own process group so a quitting Sonata (or a
 * Ctrl-C'd dev run) does not take the package manager down with it; the log fd
 * replaces both output streams so the child holds no pipe to a parent that may
 * vanish; stdin is `ignore` because a package manager that decides to prompt
 * must fail rather than hang forever on a terminal nobody is watching.
 *
 * Exported so the G4 harness can prove THESE options survive a parent's death on
 * this macOS, rather than proving it about a copy of them that could drift.
 */
export function detachedSpawnOptions(logFd: number): SpawnOptions {
  return { detached: true, stdio: ["ignore", logFd, logFd] };
}

function defaultSpawnUpdate(input: SpawnInput): UpdateChild {
  const child = spawn("codex", CODEX_UPDATE_ARGS, {
    ...detachedSpawnOptions(input.logFd),
    env: codexCommandEnv(),
  });
  return {
    pid: child.pid,
    onExit: (listener) => {
      child.once("exit", (code) => listener(code));
    },
    onError: (listener) => {
      child.once("error", listener);
    },
    unref: () => child.unref(),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
