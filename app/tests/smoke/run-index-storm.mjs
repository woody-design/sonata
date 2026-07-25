import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// OBS S2 — the storm fence. RunIndex adopts the Projection primitive: write AND
// broadcast share ONE dirty-gated, time-bounded, size-bounded cadence, driven by
// an INJECTED fake clock so persistence is deterministic — no wall-clock waits.
//
// This is the incident's §7 unit plan, made real against the actual filesystem:
//   (a) a 10k file:changed storm persists O(elapsed windows), not O(events);
//   (b) the on-disk report stays <= caps with correct droppedCounts;
//   (c) 1000 no-op events on a clean report write ZERO times;
//   (d) dispose() flushes the pending tail exactly once;
//   (e) a post-dispose event writes nothing and re-creates no directory;
//   (f) the delete flow (discard) never resurrects the report file.
const require = createRequire(import.meta.url);
const { RunIndex, DEFAULT_REPORT_LIST_CAPS } = require("../../dist/runtime");

// ---------------------------------------------------------------------------
// Hand-driven clock — the same shape S1's projection smoke uses. setTimeout /
// clearTimeout fire only on advance(); handles are plain numbers (no unref).
// ---------------------------------------------------------------------------
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
  return { timers, advance, pending: () => scheduled.size };
}

// ---------------------------------------------------------------------------
// Event fixtures.
// ---------------------------------------------------------------------------
const TASK = "t";
const RUN = "run-storm";

const runStarted = () => ({
  type: "run:started",
  payload: {
    taskId: TASK,
    id: RUN,
    kind: "prompt",
    prompt: "storm",
    promptId: "p-storm",
    title: "storm",
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

const fileChanged = (i) => ({
  type: "file:changed",
  payload: {
    taskId: TASK,
    runId: RUN,
    path: `app-inkai/build/generated/file-${i}.txt`,
    absolutePath: `/home/u/app-inkai/build/generated/file-${i}.txt`,
    changeKind: "modified",
    eventType: "change",
    type: "file",
    size: i,
    sha256: null,
  },
  ts: "2026-07-25T00:00:01.000Z",
});

const workingStatus = () => ({
  type: "working-status:updated",
  payload: { taskId: TASK, status: "working" },
  ts: "2026-07-25T00:00:02.000Z",
});

const ptyExit = () => ({
  type: "pty:exit",
  payload: { taskId: TASK, exitCode: 0, signal: null },
  ts: "2026-07-25T00:00:03.000Z",
});

// Count actual writes by watching the file's on-disk content change. The atomic
// tmp+rename means each flush leaves a distinct mtime/content; to count robustly
// we intercept via a notify tap AND cross-check the file, since notify fires
// exactly once per flush (write + notify share the cadence).
function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `sonata-storm-${tag}-`));
}

// ---------------------------------------------------------------------------
// (a) + (b) 10k file:changed storm: O(windows) writes, report <= caps.
// ---------------------------------------------------------------------------
{
  const dir = tmpDir("storm");
  const reportPath = path.join(dir, "runtime-report.json");
  const clock = makeClock();
  let notifies = 0;

  const index = new RunIndex({
    taskId: TASK,
    reportPath,
    notify: () => { notifies += 1; },
    trailingMs: 1000,
    timers: clock.timers,
  });

  // run:started is critical -> immediate flush (1 write + 1 notify).
  index.consume(runStarted());
  assert.equal(notifies, 1, "run:started flushed immediately (critical)");

  // 10k file:changed in ~5 evenly-spaced windows: 200ms between marks, so each
  // 1000ms window covers ~5 marks... drive time explicitly to bound the windows.
  // We interleave: 2000 events, advance 1000ms, repeat 5x = 10k events, 5 windows.
  let events = 0;
  const notifiesBefore = notifies;
  for (let w = 0; w < 5; w += 1) {
    for (let i = 0; i < 2000; i += 1) {
      index.consume(fileChanged(events));
      events += 1;
    }
    clock.advance(1000); // the trailing window elapses once per batch
  }
  assert.equal(events, 10_000, "fed 10k file:changed events");

  const stormNotifies = notifies - notifiesBefore;
  // O(windows): ~5 flushes for 10k events, NOT 10k. Generous upper bound well
  // under the event count proves the coalescing.
  assert.ok(
    stormNotifies <= 8,
    `persist count is O(elapsed windows), not O(events): ${stormNotifies} flushes for 10k events`,
  );
  assert.ok(stormNotifies >= 5, `each elapsed window flushed once: ${stormNotifies}`);

  // (b) report on disk <= caps, with correct droppedCounts.
  const onDisk = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const run = onDisk.runs.find((r) => r.runId === RUN);
  assert.equal(
    run.changedFiles.length,
    DEFAULT_REPORT_LIST_CAPS.changedFiles,
    "on-disk changedFiles capped to 500",
  );
  // 10k distinct paths, cap 500 -> 9500 dropped.
  assert.equal(
    onDisk.droppedCounts.changedFiles,
    10_000 - DEFAULT_REPORT_LIST_CAPS.changedFiles,
    "droppedCounts.changedFiles == events - cap",
  );
  // The tail is the most-recent 500 (paths 9500..9999).
  assert.equal(
    run.changedFiles[run.changedFiles.length - 1].path,
    fileChanged(9999).payload.path,
    "newest change survives the cap",
  );
  assert.equal(
    run.changedFiles[0].path,
    fileChanged(9500).payload.path,
    "the tail starts at events-cap (oldest dropped)",
  );

  // Compact JSON on disk: no pretty-print indentation.
  const raw = fs.readFileSync(reportPath, "utf8");
  assert.ok(!raw.includes("\n  "), "persisted JSON is compact (no pretty-print indent)");

  index.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`  [a/b] 10k storm -> ${stormNotifies} flushes, report capped @500, dropped 9500, compact: OK`);
}

// ---------------------------------------------------------------------------
// (c) 1000 no-op events on a clean report => ZERO writes.
// ---------------------------------------------------------------------------
{
  const dir = tmpDir("noop");
  const reportPath = path.join(dir, "runtime-report.json");
  const clock = makeClock();
  let notifies = 0;

  const index = new RunIndex({
    taskId: TASK,
    reportPath,
    notify: () => { notifies += 1; },
    trailingMs: 1000,
    timers: clock.timers,
  });
  // Constructor wrote the initial report; capture its mtime.
  const mtimeAfterCtor = fs.statSync(reportPath).mtimeMs;

  for (let i = 0; i < 1000; i += 1) {
    const summary = index.consume(workingStatus());
    assert.equal(summary, null, "no-op consume returns null (mutated nothing)");
  }
  clock.advance(5000); // no timer should ever have armed

  assert.equal(notifies, 0, "1000 no-op events triggered ZERO flushes/broadcasts");
  assert.equal(clock.pending(), 0, "no-op events armed no trailing timer");
  assert.equal(
    fs.statSync(reportPath).mtimeMs,
    mtimeAfterCtor,
    "the report file on disk was never rewritten by no-op events",
  );

  index.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("  [c] 1000 no-op events on a clean report -> 0 writes: OK");
}

// ---------------------------------------------------------------------------
// (d) dispose() flushes the pending tail exactly once.
// ---------------------------------------------------------------------------
{
  const dir = tmpDir("dispose");
  const reportPath = path.join(dir, "runtime-report.json");
  const clock = makeClock();
  let notifies = 0;

  const index = new RunIndex({
    taskId: TASK,
    reportPath,
    notify: () => { notifies += 1; },
    trailingMs: 1000,
    timers: clock.timers,
  });
  index.consume(runStarted()); // critical flush
  const baseline = notifies;

  index.consume(fileChanged(1)); // routine: arms the trailing window, no flush yet
  assert.equal(notifies, baseline, "routine mutation did not flush yet");
  assert.equal(clock.pending(), 1, "routine mutation armed the trailing window");

  index.dispose(); // flush-then-seal
  assert.equal(notifies, baseline + 1, "dispose flushed the pending tail exactly once");
  assert.equal(clock.pending(), 0, "dispose cleared the armed timer");

  const onDisk = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(
    onDisk.runs[0].changedFiles.length,
    1,
    "the pending change reached disk via the dispose flush",
  );

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("  [d] dispose flushes pending tail exactly once: OK");
}

// ---------------------------------------------------------------------------
// (e) post-dispose event writes nothing and re-creates no directory.
// ---------------------------------------------------------------------------
{
  const dir = tmpDir("post-dispose");
  const reportPath = path.join(dir, "sub", "runtime-report.json");
  const clock = makeClock();
  let notifies = 0;

  const index = new RunIndex({
    taskId: TASK,
    reportPath,
    notify: () => { notifies += 1; },
    trailingMs: 1000,
    timers: clock.timers,
  });
  index.consume(runStarted());
  index.dispose();
  const notifiesAfterDispose = notifies;

  // Simulate the record dir being removed after teardown (session deleted).
  fs.rmSync(path.dirname(reportPath), { recursive: true, force: true });
  assert.ok(!fs.existsSync(path.dirname(reportPath)), "record dir removed");

  // A late straggler event after dispose must be inert.
  index.consume(fileChanged(1));
  index.consume(ptyExit());
  clock.advance(5000);

  assert.equal(notifies, notifiesAfterDispose, "post-dispose events triggered no flush/broadcast");
  assert.ok(
    !fs.existsSync(path.dirname(reportPath)),
    "post-dispose events did NOT re-create the deleted record dir",
  );
  assert.ok(!fs.existsSync(reportPath), "post-dispose events did NOT resurrect the report file");

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("  [e] post-dispose event: no write, no dir resurrection: OK");
}

// ---------------------------------------------------------------------------
// (f) delete flow (discard) never resurrects the report file even with a
//     PENDING dirty tail — discard seals WITHOUT the final write.
// ---------------------------------------------------------------------------
{
  const dir = tmpDir("discard");
  const reportPath = path.join(dir, "runtime-report.json");
  const clock = makeClock();
  let notifies = 0;

  const index = new RunIndex({
    taskId: TASK,
    reportPath,
    notify: () => { notifies += 1; },
    trailingMs: 1000,
    timers: clock.timers,
  });
  index.consume(runStarted());

  // Leave a PENDING dirty tail (routine mutation, window not yet elapsed).
  index.consume(fileChanged(1));
  assert.equal(clock.pending(), 1, "a dirty tail is pending before discard");
  const notifiesBeforeDiscard = notifies;

  // The delete flow: discard (seal WITHOUT final write), THEN remove the file —
  // mirroring deleteSession's retire(discard) -> rmSync ordering.
  index.discard();
  assert.equal(
    notifies,
    notifiesBeforeDiscard,
    "discard did NOT flush the pending tail (no write, no broadcast)",
  );
  assert.equal(clock.pending(), 0, "discard cleared the armed timer");

  fs.rmSync(reportPath, { force: true });

  // A straggler after discard is inert and must not resurrect the file.
  index.consume(fileChanged(2));
  index.consume(ptyExit());
  clock.advance(5000);
  assert.ok(!fs.existsSync(reportPath), "discard + straggler never resurrected the report file");
  assert.equal(notifies, notifiesBeforeDiscard, "post-discard events are fully inert");

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("  [f] delete flow (discard): pending tail not written, no resurrection: OK");
}

console.log("run-index-storm smoke: OK");
