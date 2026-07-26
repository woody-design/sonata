import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";

// OBS S9 — dev-gated perf instrumentation (P6). Proves the AD-0 invariant
// (zero-cost-when-off) structurally and that the flag-ON path reports sane
// metrics: an event-loop-lag summary + one line per run-index flush carrying
// wall duration + serialized size (the AD-1/AD-2 tripwire evidence).
//
//   (a) flag OFF  => createPerfLog returns null (no object, so no timer, no
//                    sampler, no per-flush timing — the whole cost is one check);
//   (b) RunIndex WITHOUT onFlushMetrics never invokes a metrics callback;
//   (c) RunIndex WITH onFlushMetrics reports {name, durationMs, bytes} per flush,
//       and bytes tracks the actual on-disk serialized size;
//   (d) the perf-log file sink emits greppable [perf:flush] + [perf:event-loop]
//       lines and stop() is idempotent;
//   (e) the event-loop histogram is per-window truthful (OBS follow-up O3):
//       counts/samples/maxLagMs reset after every summary, so no window's
//       numbers accumulate into the next.
const require = createRequire(import.meta.url);
const { createPerfLog } = require("../../dist/main/perf-log");
const { RunIndex } = require("../../dist/runtime");

// Hand-driven clock (same shape the projection / storm smokes use): timers fire
// only on advance(); handles are plain numbers with no unref.
function makeClock() {
  let now = 0;
  let seq = 0;
  const scheduled = new Map();
  const timers = {
    setTimeout(fn, ms) {
      const id = ++seq;
      scheduled.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      scheduled.delete(id);
    },
  };
  function advance(ms) {
    const target = now + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of scheduled) {
        if (t.at <= target && (next === null || t.at < next.at || (t.at === next.at && id < next.id))) {
          next = { id, at: t.at, fn: t.fn };
        }
      }
      if (!next) break;
      scheduled.delete(next.id);
      now = next.at;
      next.fn();
    }
    now = target;
  }
  return { timers, advance };
}

const TASK = "t";
const runStarted = () => ({
  type: "run:started",
  payload: {
    taskId: TASK,
    id: "run-perf",
    kind: "prompt",
    prompt: "perf",
    promptId: "p-perf",
    title: "perf",
    status: "active",
    lifecyclePhase: "active",
    startedAt: "2026-07-25T00:00:00.000Z",
    endedAt: null,
    elapsedMs: null,
    completionSource: null,
    completionConfidence: null,
  },
  ts: "2026-07-25T00:00:00.000Z",
});
const runUpdated = () => ({
  ...runStarted(),
  type: "run:updated",
  payload: { ...runStarted().payload, status: "completed" },
});

// ---------------------------------------------------------------------------
// (a) flag OFF => null. The null IS the AD-0 zero-cost-when-off guarantee.
// ---------------------------------------------------------------------------
{
  assert.equal(createPerfLog(undefined), null, "unset flag => null (no perf log)");
  assert.equal(createPerfLog(""), null, "empty flag => null");
  assert.equal(createPerfLog("0"), null, "'0' => null (explicit off)");
  console.log("  [a] flag OFF => createPerfLog null (no sampler, no timer): OK");
}

// ---------------------------------------------------------------------------
// (b) RunIndex WITHOUT onFlushMetrics: flushes work, no metrics callback exists.
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-perf-off-"));
  const reportPath = path.join(dir, "runtime-report.json");
  const clock = makeClock();
  const index = new RunIndex({ taskId: TASK, reportPath, trailingMs: 1000, timers: clock.timers });
  // run:started is critical -> immediate flush; no onFlushMetrics wired => nothing
  // observes it, and nothing throws.
  index.consume(runStarted());
  assert.ok(fs.existsSync(reportPath), "flush still wrote the report with metrics off");
  index.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("  [b] RunIndex without onFlushMetrics: flush works, no callback: OK");
}

// ---------------------------------------------------------------------------
// (c) RunIndex WITH onFlushMetrics: one sane metric per flush; bytes == on-disk.
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-perf-on-"));
  const reportPath = path.join(dir, "runtime-report.json");
  const clock = makeClock();
  const metrics = [];
  const index = new RunIndex({
    taskId: TASK,
    reportPath,
    trailingMs: 1000,
    timers: clock.timers,
    onFlushMetrics: (m) => metrics.push(m),
  });

  // Construction writes the initial report DIRECTLY (not through the flush
  // closure), so no metric fires at birth.
  assert.equal(metrics.length, 0, "construction does not emit a flush metric");

  // run:started is critical -> exactly one flush -> exactly one metric.
  index.consume(runStarted());
  assert.equal(metrics.length, 1, "critical flush emitted exactly one metric");
  const m = metrics[0];
  assert.equal(m.name, `run-index:${TASK}`, "metric name identifies the run-index");
  assert.ok(Number.isFinite(m.durationMs) && m.durationMs >= 0, `durationMs is a sane number: ${m.durationMs}`);
  const onDiskBytes = fs.readFileSync(reportPath, "utf8").length;
  assert.equal(m.bytes, onDiskBytes, "metric bytes == serialized on-disk size");
  assert.ok(m.bytes > 0, "bytes is positive");

  // A routine mutation arms the trailing window; the flush on advance -> a 2nd metric.
  index.consume(runUpdated());
  clock.advance(1000);
  assert.equal(metrics.length, 2, "the trailing-window flush emitted a second metric");

  index.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("  [c] RunIndex with onFlushMetrics: one metric per flush, bytes tracks on-disk size: OK");
}

// ---------------------------------------------------------------------------
// (d) perf-log file sink: greppable [perf:flush] + [perf:event-loop] lines,
//     stop() idempotent, sampler unref'd (never keeps the process alive).
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-perf-sink-"));
  const log = createPerfLog(dir);
  assert.ok(log, "a directory flag yields a live perf log");

  log.recordFlush({ name: "run-index:t", durationMs: 0.42, bytes: 1234 });

  // Let the 500 ms sampler fire at least twice so stop() has samples to summarise.
  await delay(1100);
  log.stop();
  log.stop(); // idempotent — a second stop must not throw or double-summarise.

  const files = fs.readdirSync(dir).filter((f) => f.startsWith("perf-") && f.endsWith(".log"));
  assert.equal(files.length, 1, "the sink wrote exactly one per-run log file");
  const contents = fs.readFileSync(path.join(dir, files[0]), "utf8");
  assert.match(contents, /\[perf:flush\] name=run-index:t durationMs=0\.42 bytes=1234/, "flush line is greppable");
  assert.match(contents, /\[perf:event-loop\] samples=\d+ p50<=/, "event-loop summary line is greppable");
  const summaryLines = contents.match(/\[perf:event-loop\]/g) ?? [];
  assert.equal(summaryLines.length, 1, "stop() summarised exactly once (idempotent)");

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("  [d] perf-log file sink: [perf:flush] + [perf:event-loop] lines, stop() idempotent: OK");
}

// ---------------------------------------------------------------------------
// (e) per-window histogram truth (OBS follow-up O3). Drive several summary
//     windows in ~1 s via the interval test seam, then prove no window's numbers
//     bleed into the next. The interval summariser fires on a fixed SAMPLE COUNT
//     (sinceSummary accrues the nominal sampleMs, not wall time), so each full
//     window reports EXACTLY summaryMs/sampleMs samples — independent of real
//     timer jitter. Under the pre-fix cumulative bug those per-line counts would
//     climb (3, 6, 9, …) toward the session total; the reset pins every line to
//     its own window, so the max across all lines stays at one window's worth.
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-perf-window-"));
  const sampleMs = 50;
  const summaryMs = 150; // one interval window == summaryMs/sampleMs == 3 samples
  const perWindow = summaryMs / sampleMs;
  const log = createPerfLog(dir, { sampleMs, summaryMs });
  assert.ok(log, "short-interval flag yields a live perf log");

  // ~24 samples at 50 ms => many full interval windows summarise before stop().
  await delay(1200);
  log.stop();

  const files = fs.readdirSync(dir).filter((f) => f.startsWith("perf-") && f.endsWith(".log"));
  assert.equal(files.length, 1, "the sink wrote exactly one per-run log file");
  const contents = fs.readFileSync(path.join(dir, files[0]), "utf8");
  const sampleCounts = [...contents.matchAll(/\[perf:event-loop\] samples=(\d+)/g)].map((m) => Number(m[1]));

  assert.ok(sampleCounts.length >= 2, `several event-loop windows summarised: saw ${sampleCounts.length}`);
  // The reset proof: each full window reports exactly its own `perWindow` samples,
  // the final partial (stop) window fewer — so the max across every line is one
  // window's worth, NOT the accumulating 3/6/9/… the cumulative bug produced.
  assert.ok(
    Math.max(...sampleCounts) <= perWindow,
    `no window accumulates the previous one (each <= ${perWindow}); saw ${JSON.stringify(sampleCounts)}`,
  );

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("  [e] event-loop histogram resets per window (no cross-window accumulation): OK");
}

console.log("perf-instrumentation smoke: OK");
