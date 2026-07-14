// Slice 6 executable integration gate. Each owned suite keeps its focused
// oracle; this runner proves they all pass against one built product revision
// without overwriting the canonical evidence published by earlier Slices.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SIDEBAR_DISCLOSURE_ASSERTIONS,
  SIDEBAR_RENAME_ASSERTIONS,
  assertExactVisualMatrix,
  assertExactTrueAssertions,
} from "../helpers/sidebar-program-acceptance.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-sidebar-integrated-"));
const completedChecks = [];

try {
  const chromeDir = path.join(outputRoot, "chrome");
  const disclosureDir = path.join(outputRoot, "disclosure");
  const renameDir = path.join(outputRoot, "rename");
  const hoverDir = path.join(outputRoot, "hover");

  runNode("tests/smoke/sidebar-fixture.mjs");
  runNode("tests/smoke/sidebar-disclosure-core.mjs");
  runNode("tests/smoke/sidebar-rename-core.mjs");
  runElectronAsNode("tests/smoke/sidebar-rename-persistence.mjs");
  runNode("tests/smoke/reading-core-purity.mjs");
  runNode("tests/smoke/reading-sidebar-selectors.mjs");
  runNode("tests/smoke/reading-transitions.mjs");
  runNode("tests/smoke/session-index.mjs");
  runNode("tests/smoke/reading-runtime-reducer.mjs");
  runNode("tests/smoke/sidebar-integrated-evidence.mjs");
  runNode("tests/smoke/session-title-policy.mjs");
  runElectronAsNode("tests/e2e/session-title-lifecycle.mjs");
  runNode("tests/smoke/notification-controller.mjs");
  runNode("tests/smoke/local-api.mjs");
  // Standing repo fence: a program gate must include the architecture's own
  // laws, not just the program's focused oracles (the sidebar program shipped
  // with import-fence red because this gate never ran it).
  runNode("tests/smoke/import-fence.mjs");
  const preUiChecks = [...completedChecks];
  runNode("tests/e2e/sidebar-chrome.mjs", [chromeDir]);
  runNode("tests/e2e/terminal-theme-independence.mjs");
  runNode("tests/e2e/sidebar-disclosure.mjs", [disclosureDir]);
  runNode("tests/e2e/sidebar-rename.mjs", [renameDir]);
  runNode("tests/e2e/sidebar-hover-card.mjs", [hoverDir]);
  runNode("tests/e2e/sidebar-sessions.mjs");

  const chrome = readManifest(chromeDir);
  const disclosure = readManifest(disclosureDir);
  const rename = readManifest(renameDir);
  const hover = readManifest(hoverDir);
  assertExactVisualMatrix(chrome.results, "generated visual matrix");
  assertEqual(chrome.files.length, 16, "visual evidence files");
  assertExactTrueAssertions(
    disclosure.assertions,
    SIDEBAR_DISCLOSURE_ASSERTIONS,
    "generated disclosure assertions",
  );
  assertEqual(disclosure.files.length, 6, "disclosure evidence files");
  assertExactTrueAssertions(
    rename.assertions,
    SIDEBAR_RENAME_ASSERTIONS,
    "generated rename assertions",
  );
  assertEqual(rename.files.length, 3, "rename evidence files");
  const hoverEvidence = validateHoverEvidence(hoverDir, hover);

  console.log(
    JSON.stringify(
      {
        result: "pass",
        preUiChecks,
        uiChecks: completedChecks.slice(preUiChecks.length),
        visualCombinations: chrome.results.length,
        disclosureAssertions: Object.keys(disclosure.assertions).length,
        renameAssertions: Object.keys(rename.assertions).length,
        hoverVisualEvidence: hoverEvidence,
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(outputRoot, { recursive: true, force: true });
}

function runNode(relativePath, args = []) {
  runProcess(process.execPath, [path.join(appRoot, relativePath), ...args], relativePath);
  completedChecks.push(relativePath);
}

function runElectronAsNode(relativePath) {
  const executable = path.join(
    appRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "electron.cmd" : "electron",
  );
  runProcess(executable, [path.join(appRoot, relativePath)], relativePath, {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
  });
  completedChecks.push(relativePath);
}

function runProcess(command, args, label, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: appRoot,
    env,
    encoding: "utf8",
  });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit ${String(result.status)}`);
  }
}

function readManifest(directory) {
  return JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
}

function validateHoverEvidence(directory, manifest) {
  const expected = new Map([
    ["narrow-dark.png", { width: 500, height: 420 }],
    ["narrow-light.png", { width: 500, height: 420 }],
    ["normal-dark.png", { width: 1280, height: 800 }],
    ["normal-light.png", { width: 1280, height: 800 }],
  ]);
  const expectedNames = [...expected.keys()];
  assertEqual(
    JSON.stringify(manifest.matrix),
    JSON.stringify({ widths: ["normal", "narrow"], modes: ["light", "dark"] }),
    "hover visual matrix dimensions",
  );
  assertEqual(Array.isArray(manifest.files), true, "hover manifest files array");
  const manifestNames = manifest.files.map((entry) => entry.name).sort();
  assertEqual(JSON.stringify(manifestNames), JSON.stringify(expectedNames), "exact hover manifest files");
  const diskNames = fs.readdirSync(directory).filter((name) => name.endsWith(".png")).sort();
  assertEqual(JSON.stringify(diskNames), JSON.stringify(expectedNames), "exact hover PNG files on disk");

  const dimensions = {};
  const hashes = new Set();
  for (const entry of manifest.files) {
    assertEqual(
      typeof entry.sha256 === "string" && /^[a-f0-9]{64}$/.test(entry.sha256),
      true,
      `${entry.name} manifest SHA-256 shape`,
    );
    const bytes = fs.readFileSync(path.join(directory, entry.name));
    assertEqual(
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      true,
      `${entry.name} PNG signature`,
    );
    const actualHash = crypto.createHash("sha256").update(bytes).digest("hex");
    assertEqual(actualHash, entry.sha256, `${entry.name} independently recomputed SHA-256`);
    hashes.add(actualHash);
    const actualSize = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    assertEqual(
      JSON.stringify(actualSize),
      JSON.stringify(expected.get(entry.name)),
      `${entry.name} dimensions`,
    );
    dimensions[entry.name] = actualSize;
  }
  assertEqual(hashes.size, expected.size, "hover screenshots are four distinct images");
  return { files: expectedNames, dimensions, uniqueHashes: hashes.size };
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
