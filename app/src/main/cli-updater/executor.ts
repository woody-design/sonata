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
 * schema. `codex update` is idempotent and brew-locked; a duplicate run is a
 * no-op.
 *
 * Returns the persisted record, or null when the spawn produced no child.
 */
export function executeUpdate(options: ExecuteOptions): CliUpdaterAttemptFact | null {
  const now = options.now ?? (() => new Date());
  const logsDir = options.logsDir ?? sonataLogsDir();
  const spawnUpdate = options.spawnUpdate ?? defaultSpawnUpdate;
  const log = options.log ?? (() => undefined);

  const startedAt = now().toISOString();
  const logFile = path.join(logsDir, `codex-update-${fileStamp(startedAt)}.log`);

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

/** ISO 8601 with the characters a filesystem would rather not see. */
function fileStamp(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
