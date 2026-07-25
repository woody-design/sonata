import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// OBS S0 — the write-amplification stopgap. Covers the two S0 surfaces:
//   1. capReportLists  — the pure, idempotent, accumulating cap helper (F3),
//      reused by S2 at append time.
//   2. readExistingReport — compacts the bloated 26 MB field reports on load
//      (incident §7 last bullet), verified through the RunIndex constructor.
//   3. shouldIgnorePath — the extended build/derived-output ignore list (F2),
//      the single funnel for both the fs.watch path and the poll fallback.
const require = createRequire(import.meta.url);
const { RunIndex, capReportLists, DEFAULT_REPORT_LIST_CAPS, shouldIgnorePath } =
  require("../../dist/runtime");

const SCHEMA_ID = "sonata.runtime-report.v1";
const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const change = (i) => ({
  ts: `2026-07-25T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
  path: `app-inkai/build/generated/file-${i}.txt`,
  absolutePath: `~/proj/app-inkai/build/generated/file-${i}.txt`,
  changeKind: "modified",
  eventType: "change",
  type: "file",
  size: i,
  sha256: null,
});

const artifact = (i) => ({
  path: `exp/poem/out-${i}.md`,
  changeKind: "modified",
  type: "md",
});

const run = (runId, changedFiles, artifactCandidates) => ({
  runId,
  taskId: "t",
  kind: "prompt",
  prompt: "",
  title: "",
  status: "active",
  lifecyclePhase: "active",
  startedAt: "2026-07-25T00:00:00.000Z",
  endedAt: null,
  elapsedMs: null,
  completionSource: null,
  completionConfidence: null,
  approvalEvents: [],
  stopEvents: [],
  changedFiles,
  artifactCandidates,
  rawTerminalPointer: null,
});

const makeReport = (overrides = {}) => ({
  schemaId: SCHEMA_ID,
  version: SCHEMA_VERSION,
  generatedAt: "2026-07-25T00:00:00.000Z",
  taskId: "t",
  rawTerminalPolicy: "raw-terminal-not-persisted-by-default",
  rawTerminalPointer: null,
  runtime: null,
  runs: [],
  unassignedChanges: [],
  unassignedApprovals: [],
  ...overrides,
});

const buildChanges = (n) => Array.from({ length: n }, (_, i) => change(i));
const buildArtifacts = (n) => Array.from({ length: n }, (_, i) => artifact(i));

// ---------------------------------------------------------------------------
// 1) capReportLists — caps, records dropped counts, preserves the tail, pure.
// ---------------------------------------------------------------------------

{
  const report = makeReport({
    runs: [run("run-1", buildChanges(1200), buildArtifacts(400))],
    unassignedChanges: buildChanges(900),
  });
  const before = JSON.stringify(report);

  const capped = capReportLists(report);

  assert.equal(capped.runs[0].changedFiles.length, 500, "changedFiles capped to 500");
  assert.equal(capped.runs[0].artifactCandidates.length, 200, "artifactCandidates capped to 200");
  assert.equal(capped.unassignedChanges.length, 500, "unassignedChanges capped to 500");

  assert.deepEqual(
    capped.droppedCounts,
    { changedFiles: 700, unassignedChanges: 400, artifactCandidates: 200 },
    "per-bucket dropped counts recorded",
  );

  // The MOST-RECENT tail is retained (append order = newest last).
  assert.equal(
    capped.runs[0].changedFiles[499].path,
    change(1199).path,
    "newest changed file survives the cap",
  );
  assert.equal(
    capped.runs[0].changedFiles[0].path,
    change(700).path,
    "the tail starts at length-cap (oldest 700 dropped)",
  );

  // Purity: the input is untouched — no mutation of the report or its lists.
  assert.equal(JSON.stringify(report), before, "capReportLists mutates nothing (pure)");
  assert.equal(report.droppedCounts, undefined, "input gains no droppedCounts field");
  console.log("  [1] cap + dropped counts + tail + purity: OK");
}

// ---------------------------------------------------------------------------
// 2) Idempotence — re-capping a capped report changes nothing, counts hold.
// ---------------------------------------------------------------------------

{
  const report = makeReport({
    runs: [run("run-1", buildChanges(1200), buildArtifacts(400))],
    unassignedChanges: buildChanges(900),
  });
  const once = capReportLists(report);
  const twice = capReportLists(once);
  assert.deepEqual(twice, once, "capReportLists is idempotent");
  console.log("  [2] idempotent: OK");
}

// ---------------------------------------------------------------------------
// 3) Accumulation — the S2 flush-time reuse: growth past the cap sums into the
//    existing counts rather than resetting them.
// ---------------------------------------------------------------------------

{
  const capped = capReportLists(
    makeReport({ runs: [run("run-1", buildChanges(1200), [])] }),
  );
  assert.equal(capped.droppedCounts.changedFiles, 700, "first cap dropped 700");

  // Simulate S2 appending 5 more changes after the cap (500 -> 505), then re-cap.
  const grown = {
    ...capped,
    runs: [
      {
        ...capped.runs[0],
        changedFiles: [...capped.runs[0].changedFiles, ...buildChanges(5)],
      },
    ],
  };
  const recapped = capReportLists(grown);
  assert.equal(recapped.runs[0].changedFiles.length, 500, "still capped at 500 after growth");
  assert.equal(
    recapped.droppedCounts.changedFiles,
    705,
    "dropped count accumulates across caps (700 + 5)",
  );
  console.log("  [3] accumulation across caps: OK");
}

// ---------------------------------------------------------------------------
// 4) Default caps are the documented values.
// ---------------------------------------------------------------------------

{
  assert.deepEqual(
    DEFAULT_REPORT_LIST_CAPS,
    { changedFiles: 500, unassignedChanges: 500, artifactCandidates: 200 },
    "exported default caps",
  );
  console.log("  [4] default caps exported: OK");
}

// ---------------------------------------------------------------------------
// 5) readExistingReport compacts a bloated on-disk report through the RunIndex
//    constructor, and the next persist rewrites it bounded.
// ---------------------------------------------------------------------------

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-compaction-"));
  const reportPath = path.join(dir, "runtime-report.json");

  const bloated = makeReport({
    runs: [run("run-1", buildChanges(20000), buildArtifacts(1000))],
    unassignedChanges: buildChanges(30000),
  });
  fs.writeFileSync(reportPath, `${JSON.stringify(bloated)}\n`);
  const bloatedSize = fs.statSync(reportPath).size;

  const index = new RunIndex({ taskId: "t", reportPath, loadExisting: true });
  const loaded = index.read();

  assert.equal(loaded.runs[0].changedFiles.length, 500, "loaded run changedFiles capped");
  assert.equal(loaded.runs[0].artifactCandidates.length, 200, "loaded run artifactCandidates capped");
  assert.equal(loaded.unassignedChanges.length, 500, "loaded unassignedChanges capped");
  assert.deepEqual(
    loaded.droppedCounts,
    { changedFiles: 19500, unassignedChanges: 29500, artifactCandidates: 800 },
    "compaction records what it dropped",
  );

  // The constructor persisted the compacted report — the file on disk shrank.
  const compactedSize = fs.statSync(reportPath).size;
  assert.ok(
    compactedSize < bloatedSize / 10,
    `on-disk report shrank on load (${bloatedSize} -> ${compactedSize} bytes)`,
  );

  // A re-load of the now-compact file is stable (no further drops).
  const reindex = new RunIndex({ taskId: "t", reportPath, loadExisting: true });
  assert.deepEqual(
    reindex.read().droppedCounts,
    loaded.droppedCounts,
    "re-loading a compacted report drops nothing further",
  );

  index.dispose?.();
  reindex.dispose?.();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`  [5] readExistingReport compacts on load (${bloatedSize} -> ${compactedSize} bytes): OK`);
}

// ---------------------------------------------------------------------------
// 6) shouldIgnorePath — the extended ignore list. Segment-anywhere matching,
//    same semantics as the pre-existing node_modules entry.
// ---------------------------------------------------------------------------

{
  const ignored = [
    "", // empty path
    ".git/HEAD",
    ".sonata/runtime-report.json",
    "node_modules/react/index.js",
    "__pycache__/mod.cpython-311.pyc",
    "sample-output/run.txt",
    "app-inkai/build/outputs/apk/debug.apk", // build (nested)
    ".gradle/8.5/checksums/checksums.lock",
    "dist/bundle.js",
    "out/main/index.js",
    "target/classes/Main.class",
    "coverage/lcov.info",
    ".next/cache/webpack/x.pack",
    "DerivedData/App/Build/x.o",
    ".venv/lib/python3.11/site.py",
    "venv/bin/activate",
    ".cache/pip/wheels/x.whl",
    "src/out/index.ts", // nested source `out/` IS ignored — conservative, intended
    "sub/dir/.DS_Store", // trailing-suffix match, not a segment
    "build/x", // segment at root
    "compiled.pyc",
  ];
  for (const p of ignored) {
    assert.equal(shouldIgnorePath(p), true, `ignored: ${JSON.stringify(p)}`);
  }

  const kept = [
    "src/index.ts",
    "app/main.ts",
    "README.md",
    "lib/output.ts", // "output" is NOT the "out" segment
    "src/building.ts", // "building" is NOT "build"
    "distribute/config.json", // "distribute" is NOT "dist"
    "outer/wrap.ts", // "outer" is NOT "out"
    "targeting/aim.ts", // "targeting" is NOT "target"
    "packages/core/src/report.ts",
  ];
  for (const p of kept) {
    assert.equal(shouldIgnorePath(p), false, `kept: ${JSON.stringify(p)}`);
  }
  console.log("  [6] shouldIgnorePath ignore list (segment-anywhere, substring-safe): OK");
}

console.log("run-index-compaction smoke: OK");
