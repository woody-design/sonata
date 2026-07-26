/**
 * The build/derived-output ignore filter — a fixed, shared domain rule, not a
 * per-instance policy. Extracted to this neutral module (OBS follow-up O1a) so
 * BOTH the terminal-host ingest path and the run-index load-time compaction
 * import the SAME predicate: the "reject at ingest" and "compact at rest"
 * filters are then structurally one definition and can never drift. run-index
 * must not deep-import terminal-host (the storm/consume boundary), so the rule
 * lives here, a sibling both may import.
 */

// Path SEGMENTS whose subtrees the watcher never reports — matched anywhere in
// the path, exactly like `node_modules` (so `app/build/foo` and a nested
// `src/out/index.ts` both match). The first group is the pre-existing set; the
// second is the build/derived-output set added for OBS S0 to stop the
// write-amplification storm at the source (a Gradle build dirties thousands of
// files under `build/` + `.gradle/`; each otherwise became a `file:changed`
// event and a full-report rewrite — incident F2). Deliberately conservative:
// segment-anywhere matching means a legitimately-named source dir (e.g. `out/`,
// `dist/`) is also ignored; that is the intended trade — this is noise control,
// and the run-index caps + write-cadence bound (S0 F3 / S2) absorb whatever
// still gets through. This filter is the single funnel for BOTH the fs.watch
// path and the 750 ms poll fallback (all four call sites route through here),
// AND the run-index load-time retroactive compaction (O1a) that applies it to
// already-persisted `changedFiles` / `unassignedChanges` / `artifactCandidates`
// entries a pre-OBS build wrote before this filter existed.
const IGNORED_PATH_SEGMENTS = new Set([
  ".git",
  ".sonata",
  "node_modules",
  "__pycache__",
  "sample-output",
  "build",
  ".gradle",
  "dist",
  "out",
  "target",
  "coverage",
  ".next",
  "DerivedData",
  ".venv",
  "venv",
  ".cache",
]);

export function shouldIgnorePath(relativePath: string): boolean {
  if (!relativePath) {
    return true;
  }
  const parts = relativePath.split(/[\\/]/);
  return (
    parts.some((segment) => IGNORED_PATH_SEGMENTS.has(segment)) ||
    relativePath.endsWith(".DS_Store") ||
    relativePath.endsWith(".pyc")
  );
}
