// Slice 6 executable integration gate. Each owned suite keeps its focused
// oracle; this runner proves they all pass against one built product revision
// without overwriting the canonical evidence published by earlier Slices.
import { spawnSync } from "node:child_process";
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
  runNode("tests/e2e/sidebar-sessions.mjs");

  const chrome = readManifest(chromeDir);
  const disclosure = readManifest(disclosureDir);
  const rename = readManifest(renameDir);
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

  console.log(
    JSON.stringify(
      {
        result: "pass",
        preUiChecks,
        uiChecks: completedChecks.slice(preUiChecks.length),
        visualCombinations: chrome.results.length,
        disclosureAssertions: Object.keys(disclosure.assertions).length,
        renameAssertions: Object.keys(rename.assertions).length,
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

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
