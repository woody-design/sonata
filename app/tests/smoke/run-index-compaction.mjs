import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// OBS S0 — the write-amplification stopgap. Covers the S0 surfaces plus the
// O1a retroactive ignore-filter compaction:
//   1. capReportLists  — the pure, idempotent, accumulating cap helper (F3),
//      reused by S2 at append time.
//   2. readExistingReport — compacts the bloated 26 MB field reports on load
//      (incident §7 last bullet), verified through the RunIndex constructor.
//   3. shouldIgnorePath — the extended build/derived-output ignore list (F2),
//      the single funnel for both the fs.watch path and the poll fallback.
//   4. dropIgnoredPaths — the load-time retroactive application of that same
//      ignore filter to already-persisted entries (OBS follow-up O1a), pure +
//      idempotent, folded into droppedCounts, and wired into readExistingReport.
const require = createRequire(import.meta.url);
const { RunIndex, capReportLists, dropIgnoredPaths, DEFAULT_REPORT_LIST_CAPS, shouldIgnorePath } =
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

// Legitimate (non-ignored) fixtures — the base `change`/`artifact` builders sit
// under `build/` and `out/`, which today's ignore filter (O1a) now rejects at
// load. Tests that mean to exercise ONLY the cap (not the retro-filter) use
// these so the entries survive the filter and reach `capReportLists`.
const legitChange = (i) => ({
  ...change(i),
  path: `src/mod-${i}/index-${i}.ts`,
  absolutePath: `~/proj/src/mod-${i}/index-${i}.ts`,
});
const legitArtifact = (i) => ({ ...artifact(i), path: `notes/report-${i}.md` });
const buildLegitChanges = (n) => Array.from({ length: n }, (_, i) => legitChange(i));
const buildLegitArtifacts = (n) => Array.from({ length: n }, (_, i) => legitArtifact(i));

// An artifact-extension path UNDER an ignored dir (`dist/`) — the retro-filter
// (O1a) must reject it. (The base `artifact` builder's `exp/poem/out-N.md` is
// NOT ignored: `out-N.md` is a filename segment, not the `out` dir segment.)
const ignoredArtifact = (i) => ({ ...artifact(i), path: `dist/asset-${i}.md` });
const buildIgnoredArtifacts = (n) => Array.from({ length: n }, (_, i) => ignoredArtifact(i));

// A tool-attributed change (S6 semantic channel, source:"tool"). The ingest gate
// never filtered this channel, so the retro-filter (R1) keeps such entries even
// under an ignored dir. Legacy watcher noise, by contrast, carries NO `source`.
const toolChange = (relPath) => ({
  ts: "2026-07-25T00:00:00.000Z",
  path: relPath,
  absolutePath: `~/proj/${relPath}`,
  changeKind: "modified",
  eventType: "tool",
  type: "file",
  size: null,
  sha256: null,
  source: "tool",
  tool: "Write",
});

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
//    constructor, and the next persist rewrites it bounded. Legitimate paths so
//    only the CAP is exercised here (the retro ignore-filter is proved in 8).
// ---------------------------------------------------------------------------

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-compaction-"));
  const reportPath = path.join(dir, "runtime-report.json");

  const bloated = makeReport({
    runs: [run("run-1", buildLegitChanges(20000), buildLegitArtifacts(1000))],
    unassignedChanges: buildLegitChanges(30000),
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

// ---------------------------------------------------------------------------
// 7) dropIgnoredPaths — the retroactive ingest-filter compaction (OBS O1a).
//    Today's shouldIgnorePath applied at REST, across ALL THREE gated lists
//    (changedFiles, unassignedChanges, artifactCandidates); dropped entries fold
//    into the existing per-list droppedCounts; pure, idempotent, and a clean
//    report is returned untouched.
// ---------------------------------------------------------------------------

{
  // Mixed fixture: build-output noise the ingest filter rejects today (change(i)
  // is under `build/`, artifact(i) under `out/`) + legitimate paths it keeps.
  const report = makeReport({
    runs: [
      run(
        "run-1",
        [change(0), change(1), change(2), legitChange(0), legitChange(1)], // 3 ignored + 2 kept
        [ignoredArtifact(0), legitArtifact(0)], // ignored is under `dist/`; legit kept
      ),
    ],
    unassignedChanges: [change(3), change(4), legitChange(2)], // 2 ignored + 1 kept
  });
  const before = JSON.stringify(report);

  const filtered = dropIgnoredPaths(report);

  assert.deepEqual(
    filtered.runs[0].changedFiles.map((c) => c.path),
    [legitChange(0).path, legitChange(1).path],
    "run changedFiles keeps only the non-ignored paths",
  );
  assert.deepEqual(
    filtered.runs[0].artifactCandidates.map((a) => a.path),
    [legitArtifact(0).path],
    "run artifactCandidates keeps only the non-ignored paths",
  );
  assert.deepEqual(
    filtered.unassignedChanges.map((c) => c.path),
    [legitChange(2).path],
    "unassignedChanges keeps only the non-ignored paths",
  );
  assert.deepEqual(
    filtered.droppedCounts,
    { changedFiles: 3, unassignedChanges: 2, artifactCandidates: 1 },
    "retro-filtered entries fold into the per-list droppedCounts",
  );

  // Fold-IN (not replace): pre-existing counts accumulate, they are never reset.
  const seeded = {
    ...report,
    droppedCounts: { changedFiles: 10, unassignedChanges: 20, artifactCandidates: 5 },
  };
  assert.deepEqual(
    dropIgnoredPaths(seeded).droppedCounts,
    { changedFiles: 13, unassignedChanges: 22, artifactCandidates: 6 },
    "retro-drops accumulate onto existing droppedCounts",
  );

  // Purity, idempotence, and clean-report pass-through.
  assert.equal(JSON.stringify(report), before, "dropIgnoredPaths mutates nothing (pure)");
  assert.equal(report.droppedCounts, undefined, "input gains no droppedCounts field");
  assert.deepEqual(dropIgnoredPaths(filtered), filtered, "idempotent: a filtered report drops nothing further");
  const clean = makeReport({
    runs: [run("run-1", buildLegitChanges(3), buildLegitArtifacts(2))],
    unassignedChanges: buildLegitChanges(2),
  });
  assert.equal(dropIgnoredPaths(clean), clean, "a report with no ignored paths is returned unchanged (same ref)");
  console.log("  [7] dropIgnoredPaths retro-filter (all three lists, folded counts, pure/idempotent): OK");
}

// ---------------------------------------------------------------------------
// 8) The retro-filter fires through the RunIndex load path (readExistingReport)
//    end to end: a report a pre-OBS build wrote (every path under an ignored
//    build-output dir) loads to empty lists with the drops recorded, and the
//    persisted file shrinks. Also pins the path-shape contract — the entries'
//    workspace-relative `path` is exactly what shouldIgnorePath consumes.
// ---------------------------------------------------------------------------

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-retro-ignore-"));
  const reportPath = path.join(dir, "runtime-report.json");

  // Sanity: the fixtures ARE paths today's ingest filter rejects.
  assert.equal(shouldIgnorePath(change(0).path), true, "fixture changedFiles path is ignorable");
  assert.equal(shouldIgnorePath(ignoredArtifact(0).path), true, "fixture artifact path is ignorable");

  const bloated = makeReport({
    runs: [run("run-1", buildChanges(4000), buildIgnoredArtifacts(300))],
    unassignedChanges: buildChanges(2000),
  });
  fs.writeFileSync(reportPath, `${JSON.stringify(bloated)}\n`);
  const bloatedSize = fs.statSync(reportPath).size;

  const index = new RunIndex({ taskId: "t", reportPath, loadExisting: true });
  const loaded = index.read();

  assert.equal(loaded.runs[0].changedFiles.length, 0, "all ignored changedFiles retro-filtered on load");
  assert.equal(loaded.runs[0].artifactCandidates.length, 0, "all ignored artifactCandidates retro-filtered on load");
  assert.equal(loaded.unassignedChanges.length, 0, "all ignored unassignedChanges retro-filtered on load");
  assert.deepEqual(
    loaded.droppedCounts,
    { changedFiles: 4000, unassignedChanges: 2000, artifactCandidates: 300 },
    "the retro-filter recorded every dropped entry",
  );

  const compactedSize = fs.statSync(reportPath).size;
  assert.ok(compactedSize < bloatedSize / 10, `report shrank on load (${bloatedSize} -> ${compactedSize} bytes)`);

  // Re-load is stable — nothing left to drop.
  const reindex = new RunIndex({ taskId: "t", reportPath, loadExisting: true });
  assert.deepEqual(reindex.read().droppedCounts, loaded.droppedCounts, "re-loading drops nothing further");

  index.dispose?.();
  reindex.dispose?.();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`  [8] retro-filter through load path (${bloatedSize} -> ${compactedSize} bytes, all ignored dropped): OK`);
}

// ---------------------------------------------------------------------------
// 9) Tool-provenance exemption (R1). The S6 semantic channel deliberately ingests
//    tool edits under build-named dirs as real work — ingest never filters them —
//    so the retro-filter must not either. Entries with source:"tool" under an
//    ignored dir SURVIVE; non-tool (watcher/legacy) ignored entries still drop.
//    artifactCandidates carry no `source`, so an ignored-path artifact survives
//    iff a changedFiles entry for its path survived (was tool-attributed).
// ---------------------------------------------------------------------------

{
  const report = makeReport({
    runs: [
      run(
        "run-1",
        [
          toolChange("dist/manifest.json"), // ignored dir, source:tool  -> KEEP
          change(0), //                        build/ path, no source     -> DROP
          toolChange("src/app/main.ts"), //    legit, source:tool         -> KEEP
          legitChange(0), //                   legit, no source           -> KEEP
          toolChange("dist/report.html"), //   backs the tool artifact    -> KEEP
        ],
        [
          { path: "dist/report.html", changeKind: "modified", type: "html" }, // backed by surviving tool change -> KEEP
          ignoredArtifact(0), //               dist/asset-0.md, no backing survivor -> DROP
          legitArtifact(0), //                 notes/report-0.md, not ignored       -> KEEP
        ],
      ),
    ],
    unassignedChanges: [
      toolChange("out/bundle.js"), // ignored dir, source:tool -> KEEP
      change(1), //                   build/ path, no source   -> DROP
    ],
  });

  const filtered = dropIgnoredPaths(report);

  assert.deepEqual(
    filtered.runs[0].changedFiles.map((c) => c.path),
    ["dist/manifest.json", "src/app/main.ts", legitChange(0).path, "dist/report.html"],
    "tool-attributed entries under ignored dirs survive; non-tool ignored dropped",
  );
  assert.deepEqual(
    filtered.runs[0].artifactCandidates.map((a) => a.path),
    ["dist/report.html", legitArtifact(0).path],
    "ignored artifact survives iff backed by a surviving (tool) changedFiles path",
  );
  assert.deepEqual(
    filtered.unassignedChanges.map((c) => c.path),
    ["out/bundle.js"],
    "tool-attributed unassigned change under an ignored dir survives; legacy dropped",
  );
  assert.deepEqual(
    filtered.droppedCounts,
    { changedFiles: 1, unassignedChanges: 1, artifactCandidates: 1 },
    "only the non-tool ignored entries are counted as dropped",
  );
  console.log("  [9] tool-provenance exemption: source:'tool' entries under ignored dirs survive the retro-filter: OK");
}

console.log("run-index-compaction smoke: OK");
