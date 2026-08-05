import { CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS } from "../update-cadence";
import { checkCodex } from "./checker";
import { executeUpdate } from "./executor";
import {
  classifyAttempt,
  shouldExecute,
  sonataOwnsPrompt,
  updatePending,
  type AttemptState,
  type CliUpdaterCycleReason,
} from "./policy";
import {
  CliUpdaterStateStore,
  type CliUpdaterAttemptFact,
  type CliUpdaterCheckFact,
  type CliUpdaterFactsStore,
  type CliUpdaterState,
} from "./state";

/**
 * Keeps the user's installed Codex CLI fresh (Codex auto-update plan v1).
 *
 * Sonata runs the user's own PATH-resolved CLIs. Claude Code self-updates; Codex
 * does not — it only shows a boot prompt, which inside Sonata's pty is a prompt
 * nobody resolves, so stale installs pile up. This controller takes that job
 * over, and the interesting part of the design is what it does NOT have:
 *
 * - **No stored ownership.** Whether Sonata or Codex speaks to the user at spawn
 *   time is derived from the facts on every call (`spawnDecision`). Handback and
 *   reclaim have no code — see policy.ts.
 * - **No cached facts.** Every read goes to the store, because the detached
 *   child's exit listener writes to it behind this class's back. A cache would
 *   make a hard failure invisible to `spawnDecision` until the next cycle; the
 *   read is one small JSON file, on a path that already reads settings stores
 *   inline at spawn time.
 * - **No per-trigger logic.** All three triggers (60s post-launch, every 12h,
 *   last codex pty exit) call the same `runCycle`. A trigger only says "now may
 *   be a good time"; every condition, including the zero-live-pty gate, is
 *   evaluated inside the cycle.
 *
 * Every effect is an injected seam, so the whole controller drives from plain
 * node with no mocking of `node:child_process` or `fetch`.
 */

/** Why a cycle ran. Defined in policy.ts (one decision turns on it), re-exported
 *  here because the schedulers and triggers are what name it. */
export type { CliUpdaterCycleReason };

/** What the spawn path needs from this controller, and all it needs. */
export interface SpawnDecision {
  /** Append `-c check_for_update_on_startup=false` to the codex argv (S2). True
   *  exactly when Sonata owns the update conversation. */
  readonly suppressNativePrompt: boolean;
}

export type IdleOutcome = "idle" | "timeout";

/**
 * The slice of this controller the codex spawn path depends on. RuntimeController
 * holds THIS, not the concrete class — so the spawn path can state exactly what
 * it needs (ask who owns the prompt, wait out a running update, report that the
 * last session ended) and a test can satisfy it in three lines.
 */
export interface CodexSpawnGate {
  spawnDecision(): SpawnDecision;
  whenIdle(timeoutMs?: number): Promise<IdleOutcome>;
  runCycle(reason: CliUpdaterCycleReason): Promise<void>;
}

/**
 * A gate that does nothing: never suppresses codex's prompt, never waits, never
 * schedules. The honest degradation for a RuntimeController built without a CLI
 * updater — it reproduces exactly the pre-auto-update behaviour rather than
 * pretending the feature is on.
 */
export const INERT_CODEX_SPAWN_GATE: CodexSpawnGate = {
  spawnDecision: () => ({ suppressNativePrompt: false }),
  whenIdle: async () => "idle",
  runCycle: async () => undefined,
};

/**
 * How long a codex spawn will wait for a running update before going ahead
 * anyway (D5). Bounded with fall-through on purpose: an unbounded await would
 * let one hung `brew upgrade` block every codex session the user tries to start,
 * and the worst case of falling through is a visible, retryable boot failure —
 * a far better failure than a silently dead New Chat button.
 */
export const WHEN_IDLE_TIMEOUT_MS = 15_000;

/** Liveness poll cadence while waiting out a running update. */
export const ATTEMPT_POLL_INTERVAL_MS = 250;

export interface CliUpdaterCadence {
  readonly firstCheckDelayMs: number;
  readonly checkIntervalMs: number;
}

export interface CliUpdaterOptions {
  /** Live codex PTYs right now. S2 wires this to RuntimeController; the gate
   *  itself is policy, evaluated inside every cycle. */
  readonly livePtyCount: () => number;
  /** The `keepCodexUpToDate` setting. S2 wires this to codex-settings; read on
   *  every evaluation so a toggle takes effect without a restart. */
  readonly isEnabled: () => boolean;
  readonly store?: CliUpdaterFactsStore;
  readonly check?: () => Promise<CliUpdaterCheckFact>;
  readonly execute?: (forVersion: string) => CliUpdaterAttemptFact | null;
  readonly isPidAlive?: (pid: number) => boolean;
  /** Epoch ms. Injected for the pid-reuse sanity window. */
  readonly now?: () => number;
  /** Defaults to the shared app/CLI cadence; overridable so a test can drive the
   *  scheduler without waiting a minute. */
  readonly cadence?: CliUpdaterCadence;
  readonly pollIntervalMs?: number;
  readonly log?: (message: string) => void;
}

export class CliUpdater {
  private readonly livePtyCount: () => number;
  private readonly isEnabled: () => boolean;
  private readonly store: CliUpdaterFactsStore;
  private readonly check: () => Promise<CliUpdaterCheckFact>;
  private readonly execute: (forVersion: string) => CliUpdaterAttemptFact | null;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly now: () => number;
  private readonly cadence: CliUpdaterCadence;
  private readonly pollIntervalMs: number;
  private readonly log: (message: string) => void;

  private firstCheckTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private started = false;
  private disposed = false;

  constructor(options: CliUpdaterOptions) {
    this.livePtyCount = options.livePtyCount;
    this.isEnabled = options.isEnabled;
    this.store = options.store ?? new CliUpdaterStateStore();
    this.check = options.check ?? (() => checkCodex());
    this.execute =
      options.execute ??
      ((forVersion) => executeUpdate({ store: this.store, forVersion, log: this.log }));
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
    this.now = options.now ?? Date.now;
    this.cadence = options.cadence ?? {
      firstCheckDelayMs: FIRST_CHECK_DELAY_MS,
      checkIntervalMs: CHECK_INTERVAL_MS,
    };
    this.pollIntervalMs = options.pollIntervalMs ?? ATTEMPT_POLL_INTERVAL_MS;
    this.log = options.log ?? ((message) => console.log(`[cli-updater] ${message}`));
  }

  /**
   * Reconcile whatever the last run left behind, then start the schedule. Its
   * own timers, not the app updater's: `UpdaterController` is packaged-gated and
   * inert in dev, while a dev build spawns the same real codex a packaged one
   * does and must keep it fresh too (D1). Only the cadence is shared.
   */
  start(): void {
    if (this.started || this.disposed) {
      return;
    }
    this.started = true;
    this.reconcile();

    this.firstCheckTimer = setTimeout(() => {
      this.firstCheckTimer = null;
      void this.runCycle("first-check");
    }, this.cadence.firstCheckDelayMs);
    this.firstCheckTimer.unref?.();

    this.intervalTimer = setInterval(() => {
      void this.runCycle("interval");
    }, this.cadence.checkIntervalMs);
    this.intervalTimer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    if (this.firstCheckTimer) {
      clearTimeout(this.firstCheckTimer);
      this.firstCheckTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  /**
   * Startup reconcile (F2). Classifies the attempt the last run left behind and
   * says so in the log.
   *
   * It writes NOTHING, and that is the point rather than an omission: "a live
   * orphan holds the mutex" and "a dead unreaped attempt is UNKNOWN" are both
   * derived from the record plus a pid probe, re-derived on every read. There is
   * no adoption to record and no cleanup to forget — an adopted orphan becomes
   * UNKNOWN the moment its pid stops answering, with no code running at all.
   */
  reconcile(): AttemptState {
    const facts = this.store.read();
    const state = this.attemptStateOf(facts);
    const attempt = facts.lastAttempt;
    if (attempt && state === "running") {
      this.log(
        `adopted a running codex update from a previous run (pid ${attempt.pid}, for ${attempt.forVersion})`,
      );
    } else if (attempt && state === "unknown") {
      this.log(
        `previous codex update (pid ${attempt.pid}, for ${attempt.forVersion}) left no outcome; treating as unknown`,
      );
    }
    return state;
  }

  /** The live classification of the persisted attempt. */
  attemptState(): AttemptState {
    return this.attemptStateOf(this.store.read());
  }

  /**
   * The single orchestration point: reconcile → check → policy → maybe execute →
   * persist. "Reconcile" is not a separate step here because it is not separate
   * work — the attempt classification is re-derived from the record and a pid
   * probe every time it is read, so the cycle gets the reconciled view for free.
   * {@link reconcile} is that same derivation with the startup narration.
   *
   * Re-entrant-guarded by JOINING rather than dropping — a caller that arrives
   * mid-cycle gets the in-flight cycle's promise, so `await runCycle(...)`
   * always means "a cycle has completed", never "a cycle was skipped". Never
   * rejects.
   */
  runCycle(reason: CliUpdaterCycleReason): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    const settled = this.cycle(reason).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = settled;
    return settled;
  }

  /**
   * Who speaks to the user at spawn time. Called on the codex spawn path, so it
   * is synchronous and cannot throw: any failure degrades to "let codex show its
   * own prompt", which is exactly the behaviour that existed before this
   * controller did.
   */
  spawnDecision(): SpawnDecision {
    try {
      const facts = this.store.read();
      return {
        suppressNativePrompt: sonataOwnsPrompt({
          setting: this.isEnabled(),
          facts,
          attemptState: this.attemptStateOf(facts),
        }),
      };
    } catch (error) {
      this.log(`spawn decision failed, deferring to codex: ${describe(error)}`);
      return { suppressNativePrompt: false };
    }
  }

  /**
   * Wait out a running update — the mutex a codex spawn takes (D5). Resolves
   * `"idle"` the moment no update is running (immediately, in the overwhelmingly
   * common case) and `"timeout"` when the bound expires with one still running.
   * The caller proceeds either way; the outcome is returned so it can say so.
   *
   * Sits on the codex spawn path, so — symmetrically with `spawnDecision` — it
   * DEGRADES OPEN: every failure mode (bound expired, controller disposed, a
   * store or probe that threw) resolves and lets the spawn proceed. A session
   * the user asked for must never be lost to the updater's bookkeeping; the
   * worst case of proceeding is a visible, retryable boot failure, and the worst
   * case of not proceeding is a New Chat button that silently does nothing.
   */
  async whenIdle(timeoutMs: number = WHEN_IDLE_TIMEOUT_MS): Promise<IdleOutcome> {
    // Wall-clock, deliberately not the injected `now`: this bound exists to cap
    // how long a real person waits for a real spawn, so it must measure real
    // elapsed time whatever clock the classifier has been given. (`now` is
    // injected for the pid-reuse window, which is about the record's age.)
    const deadline = Date.now() + timeoutMs;
    try {
      while (this.attemptState() === "running") {
        if (this.disposed) {
          return "idle";
        }
        if (Date.now() >= deadline) {
          return "timeout";
        }
        await delay(this.pollIntervalMs);
      }
    } catch (error) {
      this.log(`idle wait failed, proceeding with the spawn: ${describe(error)}`);
      return "idle";
    }
    return "idle";
  }

  private async cycle(reason: CliUpdaterCycleReason): Promise<void> {
    try {
      // Not policy leaking out of policy — `setting` is still an input to both
      // predicates below. This is effect avoidance: a user who turned the
      // feature off should not have Sonata running `codex --version` and
      // querying npm on their behalf every twelve hours. The facts simply go
      // stale, which costs nothing while both predicates answer false anyway.
      if (!this.isEnabled()) {
        this.log(`cycle(${reason}): keepCodexUpToDate is off; skipping`);
        return;
      }
      const check = await this.check();
      if (this.disposed) {
        return;
      }
      // Re-read rather than reusing a pre-check snapshot: the detached child's
      // exit listener may have patched `lastAttempt` while we were awaiting.
      // Policy then runs on the write's RESULT — the normalized, persisted
      // truth — so a decision can never rest on a fact the file would reject.
      const facts: CliUpdaterState = this.store.write({
        ...this.store.read(),
        lastCheck: check,
      });

      const attemptState = this.attemptStateOf(facts);
      const setting = this.isEnabled();
      const livePtyCount = this.livePtyCount();
      const pending = updatePending(facts);
      this.log(
        `cycle(${reason}): installed=${check.installed ?? "?"} latest=${check.latest ?? "?"} ` +
          `pending=${pending} attempt=${attemptState} ptys=${livePtyCount} enabled=${setting}`,
      );

      if (!shouldExecute({ setting, facts, attemptState, livePtyCount, reason })) {
        return;
      }
      // `updatePending` is part of `shouldExecute`, so a comparable `latest` is
      // guaranteed here; the guard keeps that reasoning local rather than
      // asserted at a distance.
      const latest = facts.lastCheck?.latest;
      if (latest === null || latest === undefined) {
        return;
      }
      this.execute(latest);
    } catch (error) {
      // A cycle is background maintenance. It logs and dies; the next trigger
      // tries again with whatever facts survived.
      this.log(`cycle(${reason}) failed: ${describe(error)}`);
    }
  }

  private attemptStateOf(facts: CliUpdaterState): AttemptState {
    const attempt = facts.lastAttempt;
    // Only an unreaped attempt needs the probe — spend the syscall then, and
    // keep the classifier itself free of I/O.
    const pidAlive =
      attempt !== null && attempt.exitCode === null ? this.isPidAlive(attempt.pid) : false;
    return classifyAttempt(attempt, { pidAlive, nowMs: this.now() });
  }
}

/**
 * `kill(pid, 0)` — the standard liveness probe: it sends no signal and only
 * reports whether the pid exists and is signalable. EPERM means the process is
 * very much alive, just owned by someone else, so it counts as alive.
 */
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Deliberately NOT unref'd, unlike the schedule timers: this one is awaited by
 *  a caller that is mid-spawn, and an unref'd poll could let a bare-node process
 *  exit out from under a pending `whenIdle`. It is bounded by the caller's
 *  timeout regardless. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
