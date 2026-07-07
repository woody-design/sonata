// Layer-1 smoke — the Codex approval default reaches the SPAWN ARGV.
//
// Proves the createTask injection end-to-end: a fresh Codex task with NO
// explicit approval inherits the stored Codex default (Settings → Codex) and
// that value reaches the `-a <value>` spawn argument; an explicit per-request
// approval still overrides the stored default. Drives the REAL RuntimeController
// (not a copy of its logic) against a fake `codex` on PATH, so it needs neither
// a real Codex install nor the network — the argv is captured synchronously at
// spawn, before the child does anything.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-codex-inject-"));
// Isolate every Duet-owned path (config/data/runtime/bin) AND the Codex profile
// home to temp — NEVER touch the real ~/.duet or ~/.codex.
process.env.DUET_DATA_DIR = path.join(tempRoot, "duet-data");
process.env.CODEX_HOME = path.join(tempRoot, "codex-home");

// Shadow PATH with a no-op `codex` so node-pty spawns something harmless. The
// child exits immediately; startTask returns the argv before that matters.
const binDir = path.join(tempRoot, "bin");
fs.mkdirSync(binDir, { recursive: true });
const fakeCodex = path.join(binDir, "codex");
fs.writeFileSync(fakeCodex, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
fs.chmodSync(fakeCodex, 0o755);
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;

const workspace = path.join(tempRoot, "workspace");
fs.mkdirSync(workspace, { recursive: true });

const { RuntimeController } = require("../../dist/main/runtime-controller");
const {
  ProjectsStore,
} = require("../../dist/main/projects-store");
const {
  ResumeSettingsStore,
  ClaudeSettingsStore,
  CodexSettingsStore,
} = require("../../dist/main/settings-store");

const failures = [];
const assert = (cond, label) => {
  if (!cond) failures.push(label);
};

// The stored Codex default is a NON-default value, so a passing assertion can
// only come from the store, never from Codex's own "on-request" fallback.
const codexSettingsStore = new CodexSettingsStore(path.join(tempRoot, "codex-settings.json"));
codexSettingsStore.write({ defaultApprovalMode: "on-failure" });

const controller = new RuntimeController({
  sendEvent: () => {},
  projectsStore: new ProjectsStore(path.join(tempRoot, "projects.json")),
  resumeSettingsStore: new ResumeSettingsStore(path.join(tempRoot, "resume-settings.json")),
  claudeSettingsStore: new ClaudeSettingsStore(path.join(tempRoot, "claude-settings.json")),
  codexSettingsStore,
});

function includesSequence(values, sequence) {
  return values.some((_value, index) =>
    sequence.every((expected, offset) => values[index + offset] === expected),
  );
}

let inheritedArgs = [];
let overrideArgs = [];
try {
  // 1. No explicit approval → inherits the stored default ("on-failure").
  const inherited = controller.createTask({ provider: "codex", cwd: workspace });
  inheritedArgs = inherited.runtime.args;
  assert(inherited.task.approval === "on-failure", "inherited task.approval is the stored default");
  assert(
    includesSequence(inheritedArgs, ["-a", "on-failure"]),
    "inherited spawn argv carries -a on-failure",
  );
  assert(
    !includesSequence(inheritedArgs, ["-a", "on-request"]),
    "inherited argv does NOT fall back to Codex's own on-request default",
  );

  // 2. Explicit approval overrides the stored default.
  const override = controller.createTask({
    provider: "codex",
    cwd: workspace,
    approval: "never",
  });
  overrideArgs = override.runtime.args;
  assert(override.task.approval === "never", "explicit override wins on task.approval");
  assert(
    includesSequence(overrideArgs, ["-a", "never"]),
    "override spawn argv carries -a never",
  );
  assert(
    !includesSequence(overrideArgs, ["-a", "on-failure"]),
    "override argv does NOT carry the stored default",
  );
} finally {
  controller.dispose();
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5 });
}

const success = failures.length === 0;
console.log(JSON.stringify({ success, failures, inheritedArgs, overrideArgs }, null, 2));
process.exitCode = success ? 0 : 1;
