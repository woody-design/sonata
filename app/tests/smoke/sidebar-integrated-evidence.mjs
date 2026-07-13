// Slice 6 content-addressed acceptance fence. Historical evidence manifests
// intentionally describe the worktree that each Slice committed, not today's
// renderer. Verify their source hashes against the commit that published each
// manifest, their image hashes against disk, and the cross-Slice acceptance
// claims that the final program depends on.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SIDEBAR_DISCLOSURE_ASSERTIONS,
  SIDEBAR_RENAME_ASSERTIONS,
  SIDEBAR_VISUAL_MODES,
  assertExactVisualMatrix,
  assertExactTrueAssertions,
} from "../helpers/sidebar-program-acceptance.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = path.resolve(appRoot, "..");
const evidenceRoot = path.join(repoRoot, "product-thinking", "sidebar-refactor-evidence");

const evidenceSpecs = [
  { slice: 0, directory: "slice-0-before", files: 26, sources: 6 },
  { slice: 1, directory: "slice-1-visual", files: 16, sources: 4 },
  { slice: 3, directory: "slice-3-disclosure", files: 6, sources: 8 },
  { slice: 5, directory: "slice-5-rename", files: 3, sources: 15 },
];

const manifests = new Map();
const verified = [];
for (const spec of evidenceSpecs) {
  const manifestPath = path.join(evidenceRoot, spec.directory, "manifest.json");
  const manifestRelativePath = path.relative(repoRoot, manifestPath);
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const sourceEntries = normalizedSourceEntries(manifest.sourceFiles);
  assert.equal(sourceEntries.length, spec.sources, `Slice ${spec.slice} source count`);
  assert.equal(manifest.files.length, spec.files, `Slice ${spec.slice} image count`);

  const evidenceCommit = commitContainingManifest(manifestRelativePath, manifestBytes);
  for (const [relativePath, expectedHash] of sourceEntries) {
    const committedSource = execFileSync("git", ["show", `${evidenceCommit}:${relativePath}`], {
      cwd: repoRoot,
    });
    assert.equal(
      sha256(committedSource),
      expectedHash,
      `Slice ${spec.slice} source hash: ${relativePath}`,
    );
  }
  for (const file of manifest.files) {
    const evidencePath = path.join(evidenceRoot, spec.directory, file.name);
    const evidenceRelativePath = path.relative(repoRoot, evidencePath);
    assert.equal(sha256(fs.readFileSync(evidencePath)), file.sha256, `Evidence hash: ${file.name}`);
    assert.equal(
      sha256(execFileSync("git", ["show", `${evidenceCommit}:${evidenceRelativePath}`], {
        cwd: repoRoot,
      })),
      file.sha256,
      `Committed evidence hash: ${file.name}`,
    );
  }

  manifests.set(spec.slice, manifest);
  verified.push({
    slice: spec.slice,
    evidenceCommit: evidenceCommit.slice(0, 12),
    sourceFiles: sourceEntries.length,
    imageFiles: manifest.files.length,
  });
}

assertCharacterizationEvidence(manifests.get(0));
assertVisualEvidence(manifests.get(1));
assertExactTrueAssertions(
  manifests.get(3).assertions,
  SIDEBAR_DISCLOSURE_ASSERTIONS,
  "Disclosure",
);
assertExactTrueAssertions(
  manifests.get(5).assertions,
  SIDEBAR_RENAME_ASSERTIONS,
  "Rename",
);
assertAcceptanceGuardsRejectDrift(manifests);
assertRegisteredCommands();

console.log(
  JSON.stringify(
    {
      result: "pass",
      acceptanceDomains: ["characterization", "visual", "disclosure", "rename"],
      verified,
      images: verified.reduce((total, item) => total + item.imageFiles, 0),
      sourceFingerprints: verified.reduce((total, item) => total + item.sourceFiles, 0),
    },
    null,
    2,
  ),
);

function assertCharacterizationEvidence(manifest) {
  assert.deepEqual(manifest.themes, ["duet", "paper", "calm", "focus"]);
  assert.deepEqual(manifest.modes, ["light", "dark"]);
  assert.equal(manifest.visualBaselines.length, 8, "4 themes × 2 modes baseline inventory");
  assert.equal(new Set(manifest.projectOrder).size, manifest.projectOrder.length, "project identity");
}

function assertVisualEvidence(manifest) {
  assertExactVisualMatrix(manifest.results, "complete historical visual matrix");

  const expectedByMode = {
    light: {
      surface: "rgb(249, 248, 247)",
      selected: "rgb(241, 240, 239)",
      ink: "rgb(52, 53, 54)",
    },
    dark: {
      surface: "rgb(32, 32, 32)",
      selected: "rgb(44, 44, 44)",
      ink: "rgb(232, 232, 232)",
    },
  };
  for (const mode of SIDEBAR_VISUAL_MODES) {
    const modeResults = manifest.results.filter((result) => result.mode === mode);
    const reference = modeResults[0].snapshot;
    for (const result of modeResults) {
      assert.deepEqual(result.snapshot, reference, `${mode} chrome is theme/text-size invariant`);
      assert.equal(result.snapshot.sidebar.backgroundColor, expectedByMode[mode].surface);
      assert.equal(result.snapshot.selected.backgroundColor, expectedByMode[mode].selected);
      assert.equal(result.snapshot.spinnerColor, expectedByMode[mode].ink);
      assert.equal(result.snapshot.spinnerColor, result.snapshot.selected.buttonColor);
      assert.match(result.snapshot.sidebar.fontFamily, /system-ui/);
      assert.deepEqual(
        result.liveness.map((entry) => entry.liveness),
        ["fresh", "quiet", "silent", "fresh"],
      );
      for (const entry of result.liveness) {
        assert.equal(entry.sameNode, true);
        assert.equal(entry.stroke, "currentColor");
        assert.equal(entry.svgColor, entry.buttonColor);
      }
    }
  }
  assert.equal(manifest.statusEvidence.attention.length, 8);
  assert.equal(manifest.statusEvidence.done.length, 8);
  assert.equal(manifest.statusEvidence.reducedMotion, true);
}

function assertRegisteredCommands() {
  const scripts = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8")).scripts;
  const expected = {
    "e2e:sidebar-screenshots": "npm run build && node tests/e2e/sidebar-screenshots.mjs",
    "e2e:sidebar-chrome":
      "npm run build && node tests/e2e/sidebar-chrome.mjs && node tests/e2e/terminal-theme-independence.mjs",
    "e2e:sidebar-disclosure": "npm run build && node tests/e2e/sidebar-disclosure.mjs",
    "e2e:sidebar-rename": "npm run build && node tests/e2e/sidebar-rename.mjs",
    "e2e:sidebar-integrated": "npm run build && node tests/e2e/sidebar-integrated.mjs",
    "smoke:sidebar-integrated-evidence": "node tests/smoke/sidebar-integrated-evidence.mjs",
  };
  for (const [command, expectedScript] of Object.entries(expected)) {
    assert.equal(scripts[command], expectedScript, `exact registered command: ${command}`);
  }
}

function assertAcceptanceGuardsRejectDrift(availableManifests) {
  const visualResults = availableManifests.get(1).results;
  assert.throws(
    () => assertExactVisualMatrix(visualResults.slice(1), "missing visual tuple"),
    /missing visual tuple/,
  );
  assert.throws(
    () =>
      assertExactVisualMatrix(
        [...visualResults.slice(0, -1), visualResults[0]],
        "duplicated visual tuple",
      ),
    /duplicated visual tuple/,
  );

  const disclosure = availableManifests.get(3).assertions;
  const missing = { ...disclosure };
  delete missing[SIDEBAR_DISCLOSURE_ASSERTIONS[0]];
  assert.throws(
    () =>
      assertExactTrueAssertions(missing, SIDEBAR_DISCLOSURE_ASSERTIONS, "missing assertion"),
    /missing assertion keyset/,
  );
  assert.throws(
    () =>
      assertExactTrueAssertions(
        { ...disclosure, unreviewedClaim: true },
        SIDEBAR_DISCLOSURE_ASSERTIONS,
        "extra assertion",
      ),
    /extra assertion keyset/,
  );
  assert.throws(
    () =>
      assertExactTrueAssertions(
        { ...disclosure, [SIDEBAR_DISCLOSURE_ASSERTIONS[0]]: false },
        SIDEBAR_DISCLOSURE_ASSERTIONS,
        "false assertion",
      ),
    /false assertion assertion/,
  );
}

function normalizedSourceEntries(sourceFiles) {
  return Array.isArray(sourceFiles)
    ? sourceFiles.map((entry) => [entry.path, entry.sha256])
    : Object.entries(sourceFiles);
}

function commitContainingManifest(relativePath, manifestBytes) {
  const commits = execFileSync(
    "git",
    ["log", "--format=%H", "--", relativePath],
    { cwd: repoRoot, encoding: "utf8" },
  )
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const manifestHash = sha256(manifestBytes);
  const matchingCommit = commits.find((commit) => {
    try {
      return sha256(execFileSync("git", ["show", `${commit}:${relativePath}`], { cwd: repoRoot })) ===
        manifestHash;
    } catch {
      return false;
    }
  });
  assert.equal(Boolean(matchingCommit), true, `exact evidence manifest is committed: ${relativePath}`);
  return matchingCommit;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
