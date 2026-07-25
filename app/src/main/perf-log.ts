import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Dev-gated main-process performance instrumentation (OBS P6 — the AD-1/AD-2
 * tripwire data). Mirrors the `SONATA_RUNTIME_EVENT_LOG` recorder precedent:
 * env-gated, synchronous by design, default OFF, disable-on-write-failure,
 * never intended to stay enabled in normal daily use.
 *
 * AD-0 (zero-cost-when-off) is structural: `createPerfLog` returns `null` when
 * the flag is absent, so the ONLY cost on the hot path is one `perfLog?.` /
 * `if (onFlushMetrics)` boolean check — no timer is armed, no per-flush timing
 * runs, no histogram exists. Everything below is constructed lazily, only when
 * the flag is set.
 *
 * `SONATA_PERF_LOG` shape (chosen to mirror the recorder's dir semantics, plus a
 * `1` convenience for interactive runs):
 *   - unset / "" / "0"  → disabled (returns null).
 *   - "1"               → enabled; summary/flush lines go to stderr.
 *   - <any other value> → enabled; treated as a directory; lines append to
 *                         `<dir>/perf-<pid>-<ts>.log` (mkdir -p; the first write
 *                         failure disables the log for the rest of the process).
 *
 * Two evidence streams, both one greppable `[perf:*]` line:
 *   - `[perf:event-loop]` — a coarse 500 ms drift sampler → p50/p95/max histogram,
 *     summarised every ~30 s and once at quit (`stop()`). This is the AD-1
 *     "does the main loop stall under load, i.e. should persistence move to a
 *     utilityProcess" tripwire.
 *   - `[perf:flush]` — per run-index flush: wall duration + serialized size. The
 *     duration times the WRITE path only (materialize + serialize + write +
 *     rename); it deliberately EXCLUDES the trailing `report:updated` notify
 *     broadcast (OBS S9 R1 / N2). That is the correct scope for this tripwire:
 *     SQLite would replace serialize+write, not the IPC broadcast (a separate
 *     D6/AD-3 concern), so folding notify in would pollute the signal. This is
 *     the AD-2 "did bounded-JSON+debounce suffice, or is a report large/slow
 *     enough to justify SQLite" tripwire. Fed via `RunIndexOptions.onFlushMetrics`
 *     (the Projection primitive itself is deliberately left untouched — it is the
 *     shared constitution seam, not a place for dev hooks).
 */

/** One run-index flush measurement. `bytes` is the serialized JSON length (≈ on-disk size). */
export interface FlushMetric {
  name: string;
  durationMs: number;
  bytes?: number;
}

export interface PerfLog {
  /** Record one run-index flush (duration + serialized size). */
  recordFlush(metric: FlushMetric): void;
  /** Emit the final event-loop-lag summary and disarm the sampler. Idempotent. */
  stop(): void;
}

const SAMPLE_MS = 500;
const SUMMARY_MS = 30_000;
/** Fixed histogram upper bounds (ms); a sample lands in the first bucket it does not exceed. */
const LAG_BUCKETS_MS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];

/**
 * Build the live perf log when `SONATA_PERF_LOG` is set, else `null` — the null
 * IS the AD-0 zero-cost-when-off guarantee (no sampler, no timers, no state).
 */
export function createPerfLog(value: string | undefined = process.env.SONATA_PERF_LOG): PerfLog | null {
  if (!value || value === "0") {
    return null;
  }
  const write = makeSink(value);

  // --- event-loop-lag sampler: 40-odd lines, imports nothing app-level -------
  const counts = new Array(LAG_BUCKETS_MS.length + 1).fill(0);
  let samples = 0;
  let maxLagMs = 0;
  let last = process.hrtime.bigint();
  let sinceSummary = 0;

  const sample = (): void => {
    const now = process.hrtime.bigint();
    const elapsedMs = Number(now - last) / 1e6;
    last = now;
    // Lag = how much LATER than the nominal interval this tick fired ≈ the time
    // the loop was blocked from servicing the timer. CAVEAT (OBS S9 R1 / N1): the
    // OS coalesces setInterval on battery / under App Nap, so a fired-late tick
    // can read high WITHOUT the loop being blocked. Read the AD-1 tripwire numbers
    // as loop-blocking only on AC power / a foreground app; treat battery-mode
    // inflation as measurement noise, not a real stall.
    const lagMs = Math.max(0, elapsedMs - SAMPLE_MS);
    let bucket = LAG_BUCKETS_MS.findIndex((bound) => lagMs <= bound);
    if (bucket === -1) {
      bucket = LAG_BUCKETS_MS.length;
    }
    counts[bucket] += 1;
    samples += 1;
    if (lagMs > maxLagMs) {
      maxLagMs = lagMs;
    }
    sinceSummary += SAMPLE_MS;
    if (sinceSummary >= SUMMARY_MS) {
      summarize(SUMMARY_MS / 1000);
      sinceSummary = 0;
    }
  };

  const summarize = (windowSec: number): void => {
    if (samples === 0) {
      return;
    }
    const p50 = percentile(counts, 0.5);
    const p95 = percentile(counts, 0.95);
    write(
      `[perf:event-loop] samples=${samples} p50<=${p50}ms p95<=${p95}ms max=${maxLagMs.toFixed(1)}ms window~${windowSec}s`,
    );
  };

  const timer = setInterval(sample, SAMPLE_MS);
  // Must never keep the process alive on its own (matches every other main-loop timer).
  timer.unref?.();

  let stopped = false;
  return {
    recordFlush(metric) {
      write(
        `[perf:flush] name=${metric.name} durationMs=${metric.durationMs.toFixed(2)}` +
          (metric.bytes === undefined ? "" : ` bytes=${metric.bytes}`),
      );
    },
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
      summarize(Math.round((samples * SAMPLE_MS) / 1000) || 0);
    },
  };
}

/** Coarse percentile from the fixed histogram: the upper bound of the bucket the fraction falls in. */
function percentile(counts: number[], fraction: number): number | string {
  const total = counts.reduce((sum, c) => sum + c, 0);
  if (total === 0) {
    return 0;
  }
  // The last bucket has no upper bound (the overflow row); report it as ">max+".
  const overflow = `${LAG_BUCKETS_MS[LAG_BUCKETS_MS.length - 1]}+`;
  const target = fraction * total;
  let cumulative = 0;
  for (let i = 0; i < counts.length; i += 1) {
    cumulative += counts[i] ?? 0;
    if (cumulative >= target) {
      return LAG_BUCKETS_MS[i] ?? overflow;
    }
  }
  return overflow;
}

/**
 * Resolve the flag value to a line sink. "1" → stderr; anything else → an append
 * file under that directory. A write failure disables the sink for the rest of
 * the process (loud once), never interfering with the app — same contract the
 * runtime-event recorder holds.
 */
function makeSink(value: string): (line: string) => void {
  if (value === "1") {
    return (line) => process.stderr.write(`${line}\n`);
  }
  let file: string | null = null;
  let disabled = false;
  return (line) => {
    if (disabled) {
      return;
    }
    try {
      if (!file) {
        mkdirSync(value, { recursive: true });
        file = join(value, `perf-${process.pid}-${Date.now()}.log`);
      }
      appendFileSync(file, `${line}\n`);
    } catch (error) {
      disabled = true;
      console.error("[perf-log] disabled after write failure:", error);
    }
  };
}
