/**
 * Projection — the ONE primitive through which every bounded persistence /
 * notification path in the main process flows (OBS D1). It owns a dirty flag and
 * a trailing-debounce cadence so that a producer's event rate (a Gradle build, a
 * spinner) can never set the disk-write or IPC rate: raw signals mark state cheap;
 * the actual effect (`flush` = write + notify) runs on a clock, not per event.
 *
 * Cadence policy is TRAILING-FIXED, not sliding:
 *   - The first `markDirty()` after a clean/flush arms one timer for `trailingMs`.
 *   - Further marks inside that window set dirty but do NOT re-arm or push the
 *     deadline out — a steady mark stream therefore flushes every ~`trailingMs`
 *     (arm-once → fire → re-arm on the next mark), it never starves. Sliding
 *     (extend-on-every-mark) debounce would starve under continuous load: an
 *     unbroken stream would push the deadline forever and never flush. That is
 *     the whole point of trailing-fixed here (AD-0 storm fence).
 *
 * Reentrancy contract: `flush` runs only when dirty, and dirty is cleared BEFORE
 * the closure is invoked. So if `flush` itself calls `markDirty()` (future misuse
 * — a flush whose side effects dirty the same state), the mark is not lost and
 * does not recurse: it re-arms a fresh trailing window normally, to be flushed on
 * the next tick.
 *
 * Error contract: a throwing `flush` never wedges the Projection — dirty is
 * already cleared and the timer already disarmed when the closure runs, so state
 * stays coherent whether it returns or throws. The error PROPAGATES for the
 * caller-driven flushes (`markCritical`, `flushNow`) — the caller asked to flush
 * and can handle the failure. For the TIMER-driven flush there is no caller to
 * catch it, so it is routed to `onError` (default: `console.error` with the
 * projection name) rather than becoming an unhandled crash. `seal()`'s final
 * flush is likewise routed to `onError`: seal is a teardown operation that must
 * always reach permanent inertness, never throw out of a dispose path.
 *
 * Deterministic in tests: the `timers` seam (default: globals) lets smokes drive
 * time by hand. Injected fake handles need not carry `unref`; the real
 * main-process node timer does, and we `unref` it so a pending flush never keeps
 * the process alive.
 */

/** Opaque timer handle — `NodeJS.Timeout` in production, whatever a fake returns in tests. */
type TimerHandle = unknown;

/** Injectable timer seam so smokes drive the debounce clock deterministically. */
export interface ProjectionTimers {
  setTimeout(handler: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

const DEFAULT_TIMERS: ProjectionTimers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface ProjectionOptions {
  /** Identifies the projection in default `onError` logging. */
  name: string;
  /** The bounded effect: write + notify. Runs only when dirty; may throw. */
  flush: () => void;
  /** Trailing-debounce window in milliseconds. */
  trailingMs: number;
  /** Timer seam; defaults to the process globals. */
  timers?: ProjectionTimers;
  /** Sink for timer-driven / seal-driven flush errors; defaults to `console.error`. */
  onError?: (error: unknown) => void;
}

export class Projection {
  private readonly name: string;
  private readonly flush: () => void;
  private readonly trailingMs: number;
  private readonly timers: ProjectionTimers;
  private readonly onError: (error: unknown) => void;

  private dirty = false;
  private timer: TimerHandle | null = null;
  private sealed = false;

  constructor(options: ProjectionOptions) {
    this.name = options.name;
    this.flush = options.flush;
    this.trailingMs = options.trailingMs;
    this.timers = options.timers ?? DEFAULT_TIMERS;
    this.onError =
      options.onError ??
      ((error) => console.error(`[projection:${this.name}] flush failed`, error));
  }

  /** Mark state changed. Arms the trailing window once; does not extend it (see class doc). */
  markDirty(): void {
    if (this.sealed) {
      return;
    }
    this.dirty = true;
    if (this.timer !== null) {
      // Trailing-FIXED: a window is already open — do NOT push the deadline out,
      // or a steady stream would starve the flush. Ride the armed timer.
      return;
    }
    this.arm();
  }

  /** A critical event: mark dirty and flush synchronously now. Cancels any armed window first. */
  markCritical(): void {
    if (this.sealed) {
      return;
    }
    this.dirty = true;
    this.flushIfDirty();
  }

  /** Manual immediate flush if dirty; a no-op when clean. */
  flushNow(): void {
    if (this.sealed) {
      return;
    }
    this.flushIfDirty();
  }

  /**
   * Flush-then-seal (dispose). Flushes exactly once if dirty, then goes
   * permanently inert: every later mark / flush is a no-op, the timer is cleared,
   * and `flush` is never called again — this is what makes a late straggler event
   * unable to re-run the effect after teardown (e.g. re-create a deleted record
   * dir). Idempotent. The final flush's error is routed to `onError`, never thrown
   * out of teardown; inertness is reached regardless.
   */
  seal(): void {
    if (this.sealed) {
      return;
    }
    try {
      if (this.dirty) {
        this.dirty = false; // clear before the closure — reentrancy contract
        this.flush();
      }
    } catch (error) {
      this.onError(error);
    } finally {
      this.sealed = true;
      this.dirty = false;
      this.clearTimer(); // absorb any window a reentrant markDirty armed
    }
  }

  private arm(): void {
    const handle = this.timers.setTimeout(() => {
      // Timer-driven: no caller to catch a throw, so it must never crash the
      // process. State is already coherent (dirty cleared, timer disarmed inside
      // flushIfDirty) before the closure runs.
      try {
        this.flushIfDirty();
      } catch (error) {
        this.onError(error);
      }
    }, this.trailingMs);
    // Real node timers expose unref(); injected fakes may not.
    (handle as { unref?: () => void }).unref?.();
    this.timer = handle;
  }

  /**
   * The single flush path. Disarms first, then — only if dirty — clears dirty
   * BEFORE invoking the closure, so a `markDirty()` from inside `flush` re-arms a
   * fresh window instead of being lost or recursing. A throw propagates to the
   * caller; caller-driven sites (markCritical/flushNow) surface it, the timer site
   * catches it into `onError`.
   */
  private flushIfDirty(): void {
    this.clearTimer();
    if (!this.dirty) {
      return;
    }
    this.dirty = false;
    this.flush();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
