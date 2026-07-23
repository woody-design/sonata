// M1 gate assertion (Mine 1) — a PACKAGED run writes app.asar.unpacked paths.
//
// The definitive end-to-end check that the asarUnpackedPath fix works against
// Electron's REAL __dirname behavior (not a simulated layout). It drives the
// packaged Sonata binary itself under ELECTRON_RUN_AS_NODE so the settings
// module runs with the exact __dirname Electron gives it, calls
// ensureClaudeRuntimeSettings, and asserts all three command paths point at
// unpacked, on-disk, external-node-runnable files.
//
// Requires a packaged app (run `npm run package` first). Override its location
// with SONATA_PACKAGED_APP. Does NOT build anything.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const defaultApp = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../release/mac-arm64/Sonata.app",
);
const appPath = process.env.SONATA_PACKAGED_APP
  ? path.resolve(process.env.SONATA_PACKAGED_APP)
  : defaultApp;

// Environmental SKIP (exit 77 — the aggregate runner's SKIP convention): this
// smoke drives a packaged artifact it does NOT build. Absent one, it is not
// applicable rather than failing — `npm run package` produces it.
if (!fs.existsSync(appPath)) {
  console.log(`SKIP: packaged app absent — run \`npm run package\` first (${appPath})`);
  process.exit(77);
}

const bin = path.join(appPath, "Contents", "MacOS", "Sonata");
const appAsar = path.join(appPath, "Contents", "Resources", "app.asar");
assert.ok(fs.existsSync(bin), `packaged binary exists: ${bin}`);

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-packaged-settings-"));
try {
  // Child runs INSIDE the packaged Electron (as node): it requires the settings
  // module by its app.asar path — Electron resolves it, and __dirname is
  // whatever Electron actually sets. We then read the JSON it wrote back out.
  const childScript = path.join(stage, "emit-settings.mjs");
  fs.writeFileSync(
    childScript,
    `
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const mod = require(path.join(process.env.SONATA_APP_ASAR, "dist/runtime/cli-signal"));
const runtimeDir = process.env.SONATA_RUNTIME_DIR;
fs.mkdirSync(runtimeDir, { recursive: true });
const settingsPath = mod.ensureClaudeRuntimeSettings(runtimeDir, { approvalBroker: true });
process.stdout.write(fs.readFileSync(settingsPath, "utf8"));
`,
    "utf8",
  );

  const runtimeDir = path.join(stage, "runtime-home");
  const res = spawnSync(bin, [childScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      SONATA_APP_ASAR: appAsar,
      SONATA_RUNTIME_DIR: runtimeDir,
    },
  });
  assert.equal(res.status, 0, `packaged run emitted settings (stderr: ${res.stderr})`);

  const settings = JSON.parse(res.stdout);
  const statusLineCommand = settings.statusLine.command;
  const hookCommand = settings.hooks.Stop[0].hooks[0].command;
  const brokerCommand = settings.hooks.PermissionRequest[0].hooks[0].command;

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
      check.script.includes(`app.asar.unpacked${path.sep}`),
      `${check.name} path is under app.asar.unpacked (got: ${check.script})`,
    );
    assert.ok(
      !new RegExp(`app\\.asar${path.sep === "/" ? "/" : "\\\\"}(?!unpacked)`).test(check.script),
      `${check.name} path does NOT reference the packed archive (got: ${check.script})`,
    );
    assert.ok(check.script.endsWith(check.needle), `${check.name} → ${check.needle}`);
    assert.ok(
      fs.existsSync(check.script),
      `${check.name} script exists on disk (external node can run it): ${check.script}`,
    );
    report.push({ name: check.name, script: check.script });
  }

  console.log(JSON.stringify({ success: true, appPath, checks: report }, null, 2));
  process.exitCode = 0;
} finally {
  fs.rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
