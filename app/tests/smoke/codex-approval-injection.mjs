// Layer-1 smoke — Codex launch settings reach the SPAWN ARGV.
//
// Proves the createTask injection end-to-end: a fresh Codex task with NO
// explicit permission mode inherits the stored Codex default (Settings → Codex)
// and that mode fans out to the exact (`-s`/`-a`/`approvals_reviewer`) spawn
// flags; an explicit per-request mode still overrides the stored default. It
// also pins the newest model and Ultra effort through request normalization
// into both task state and argv. Drives the REAL RuntimeController (not a copy
// of its logic) against a fake `codex` on PATH, so it needs neither a real
// Codex install nor the network — the argv is captured synchronously at spawn,
// before the child does anything.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-codex-inject-"));
// Isolate every Sonata-owned path (config/data/runtime/bin) AND the Codex profile
// home to temp — NEVER touch the real ~/.sonata or ~/.codex.
process.env.SONATA_DATA_DIR = path.join(tempRoot, "sonata-data");
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
  SonataSettingsStore,
} = require("../../dist/main/settings-store");

const failures = [];
const assert = (cond, label) => {
  if (!cond) failures.push(label);
};

// The stored Codex default is a NON-default value, so a passing assertion can
// only come from the store, never from Codex's own "ask-for-approval" fallback.
const codexSettingsStore = new CodexSettingsStore(path.join(tempRoot, "codex-settings.json"));
codexSettingsStore.write({ defaultPermissionMode: "full-access" });

const controller = new RuntimeController({
  sendEvent: () => {},
  projectsStore: new ProjectsStore(path.join(tempRoot, "projects.json")),
  resumeSettingsStore: new ResumeSettingsStore(path.join(tempRoot, "resume-settings.json")),
  claudeSettingsStore: new ClaudeSettingsStore(path.join(tempRoot, "claude-settings.json")),
  codexSettingsStore,
  sonataSettingsStore: new SonataSettingsStore(path.join(tempRoot, "sonata-settings.json")),
});

function includesSequence(values, sequence) {
  return values.some((_value, index) =>
    sequence.every((expected, offset) => values[index + offset] === expected),
  );
}

let inheritedArgs = [];
let overrideArgs = [];
let ultraArgs = [];
try {
  // 1. No explicit mode → inherits the stored default ("full-access"), which
  //    fans out to the danger-full-access flag row.
  const inherited = controller.createTask({ provider: "codex", cwd: workspace });
  inheritedArgs = inherited.runtime.args;
  assert(
    inherited.task.codexPermissionMode === "full-access",
    "inherited task.codexPermissionMode is the stored default",
  );
  assert(
    includesSequence(inheritedArgs, ["-s", "danger-full-access"]) &&
      includesSequence(inheritedArgs, ["-a", "never"]) &&
      includesSequence(inheritedArgs, ["-c", 'approvals_reviewer="user"']),
    "inherited spawn argv carries the full-access flag row",
  );
  assert(
    !includesSequence(inheritedArgs, ["-s", "workspace-write"]),
    "inherited argv does NOT fall back to Codex's own ask-for-approval default",
  );

  // 2. Explicit mode overrides the stored default.
  const override = controller.createTask({
    provider: "codex",
    cwd: workspace,
    codexPermissionMode: "approve-for-me",
  });
  overrideArgs = override.runtime.args;
  assert(
    override.task.codexPermissionMode === "approve-for-me",
    "explicit override wins on task.codexPermissionMode",
  );
  assert(
    includesSequence(overrideArgs, ["-s", "workspace-write"]) &&
      includesSequence(overrideArgs, ["-a", "on-request"]) &&
      includesSequence(overrideArgs, ["-c", 'approvals_reviewer="auto_review"']),
    "override spawn argv carries the approve-for-me flag row",
  );
  assert(
    !includesSequence(overrideArgs, ["-s", "danger-full-access"]),
    "override argv does NOT carry the stored default",
  );

  // 3. The GPT-5.6 model and Ultra effort survive controller normalization.
  const ultra = controller.createTask({
    provider: "codex",
    cwd: workspace,
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
  });
  ultraArgs = ultra.runtime.args;
  assert(ultra.task.model === "gpt-5.6-sol", "GPT-5.6 Sol survives normalization");
  assert(ultra.task.reasoningEffort === "ultra", "Ultra survives normalization");
  assert(
    includesSequence(ultraArgs, ["-m", "gpt-5.6-sol"]),
    "GPT-5.6 Sol reaches spawn argv",
  );
  assert(
    includesSequence(ultraArgs, ["-c", 'model_reasoning_effort="ultra"']),
    "Ultra reaches spawn argv",
  );
} finally {
  controller.dispose();
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5 });
}

const success = failures.length === 0;
console.log(JSON.stringify({ success, failures, inheritedArgs, overrideArgs, ultraArgs }, null, 2));
process.exitCode = success ? 0 : 1;
