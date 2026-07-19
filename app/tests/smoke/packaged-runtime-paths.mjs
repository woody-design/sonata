// Mine 1 smoke — packaged-layout path mapping for the Claude runtime-settings.
//
// In a packaged app the provider CLIs spawn SYSTEM `node` to run Sonata's sink
// scripts, so those scripts (and the commands that point at them) must resolve
// to real on-disk files under `app.asar.unpacked`, never a path inside the
// archive. The three command sites build their paths via `path.join(__dirname,
// ...)`, so correctness hinges on the settings module RUNNING from the unpacked
// tree. We simulate exactly that: copy the compiled `dist/runtime` into a
// directory literally named `.../app.asar.unpacked/dist/runtime`, require the
// settings module FROM there, and assert the written JSON's three command paths
// land on app.asar.unpacked files that actually exist.
//
// (The definitive check that Electron itself rewrites __dirname to the unpacked
// path is done against a real packaged .app in the S1 report; this smoke locks
// the code's contract independent of a packaging run.)

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const distRuntime = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../dist/runtime",
);

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-packaged-paths-"));
try {
  // Reproduce a signed .app's Resources layout: the settings module lives under
  // app.asar.unpacked, which is where electron-builder places our asarUnpack'd
  // dirs and where Electron points __dirname for them.
  const unpackedRuntime = path.join(
    stage,
    "Sonata.app",
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "dist",
    "runtime",
  );
  fs.mkdirSync(path.dirname(unpackedRuntime), { recursive: true });
  fs.cpSync(distRuntime, unpackedRuntime, { recursive: true });

  const { ensureClaudeRuntimeSettings } = require(path.join(unpackedRuntime, "cli-signal"));

  // The session runtime home is a normal on-disk dir (in the app it is
  // ~/.sonata/data/runtime/<taskId>); only the SINK scripts live under the .app.
  const runtimeDir = path.join(stage, "runtime-home");
  fs.mkdirSync(runtimeDir, { recursive: true });

  const settingsPath = ensureClaudeRuntimeSettings(runtimeDir, { approvalBroker: true });
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));

  // Pull the three command strings back out.
  const statusLineCommand = settings.statusLine.command;
  const hookCommand = settings.hooks.Stop[0].hooks[0].command;
  const brokerCommand = settings.hooks.PermissionRequest[0].hooks[0].command;

  // Each command is `node '<absolute script path>' '<dir>'`; extract the first
  // single-quoted path — the script the external `node` will execute.
  const scriptOf = (command) => {
    const match = command.match(/'((?:[^']|'\\'')*)'/);
    assert.ok(match, `command carries a quoted script path: ${command}`);
    return match[1];
  };

  const checks = [
    { name: "statusline-sink", script: scriptOf(statusLineCommand), needle: "claude-statusline-sink.js" },
    { name: "hook-sink", script: scriptOf(hookCommand), needle: "hook-sink.js" },
    { name: "approval-broker", script: scriptOf(brokerCommand), needle: "approval-broker.js" },
  ];

  const report = [];
  for (const check of checks) {
    assert.ok(
      check.script.includes("app.asar.unpacked"),
      `${check.name} path is under app.asar.unpacked (got: ${check.script})`,
    );
    assert.ok(
      !check.script.includes(`app.asar${path.sep}`) &&
        !/app\.asar\//.test(check.script),
      `${check.name} path is NOT inside the packed archive (got: ${check.script})`,
    );
    assert.ok(check.script.endsWith(check.needle), `${check.name} → ${check.needle}`);
    assert.ok(fs.existsSync(check.script), `${check.name} script exists on disk: ${check.script}`);
    report.push({ name: check.name, script: check.script });
  }

  console.log(JSON.stringify({ success: true, settingsPath, checks: report }, null, 2));
  process.exitCode = 0;
} finally {
  fs.rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
