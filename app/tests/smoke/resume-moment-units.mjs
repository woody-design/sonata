// Slice C smoke — the resume moment's units:
//   1. ResumeSettingsStore round-trip + normalize (positive enum, ask default)
//   2. readClaudeResumeStats on a fixture transcript (idle + token math —
//      the panel-equivalent numbers, F7)
//   3. startTask extraEnv overlay reaches the child (per-spawn suppression
//      lever) without disturbing the slice-A scrub

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TerminalHost, readClaudeResumeStats } = require("../../dist/runtime");
const { ResumeSettingsStore } = require("../../dist/main/settings-store");

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "duet-resume-units-"));
const failures = [];
function assert(condition, label) {
  if (!condition) {
    failures.push(label);
  }
}

// --- 1. settings store ------------------------------------------------------
const store = new ResumeSettingsStore(path.join(workspace, "resume-settings.json"));
assert(store.read().policy === "ask", "default policy is ask");
assert(store.write({ policy: "summary" }).policy === "summary", "write summary");
assert(store.read().policy === "summary", "summary round-trips");
assert(store.write({ policy: "bogus" }).policy === "ask", "bogus value normalizes to ask");
assert(new ResumeSettingsStore(path.join(workspace, "missing.json")).read().policy === "ask",
  "missing file reads as default");

// --- 2. transcript stats ----------------------------------------------------
const transcriptPath = path.join(workspace, "fixture.jsonl");
const oldTs = new Date(Date.now() - 2 * 3600_000).toISOString(); // 2h ago
fs.writeFileSync(
  transcriptPath,
  [
    JSON.stringify({ type: "user", timestamp: new Date(Date.now() - 3 * 3600_000).toISOString() }),
    JSON.stringify({
      type: "assistant",
      timestamp: oldTs,
      message: {
        usage: {
          input_tokens: 360,
          cache_read_input_tokens: 104_515,
          cache_creation_input_tokens: 482,
          output_tokens: 492,
        },
      },
    }),
    JSON.stringify({ type: "permission-mode" }), // untimestamped tail entry
    "",
  ].join("\n"),
);
const stats = readClaudeResumeStats(transcriptPath);
assert(stats.totalTokens === 105_849, `token total is panel-equivalent (got ${stats.totalTokens})`);
const idleMs = Date.now() - stats.lastActivityMs;
assert(idleMs > 1.9 * 3600_000 && idleMs < 2.1 * 3600_000, "idle derives from last timestamped entry");
const missing = readClaudeResumeStats(path.join(workspace, "nope.jsonl"));
assert(missing.totalTokens === null && missing.lastActivityMs === null, "missing transcript → nulls");

// --- 3. extraEnv overlay ----------------------------------------------------
const scriptPath = path.join(workspace, "env-dump.mjs");
const envDumpPath = path.join(workspace, "env.json");
fs.writeFileSync(
  scriptPath,
  `
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(envDumpPath)}, JSON.stringify({
  threshold: process.env.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD ?? null,
  minutes: process.env.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES ?? null,
  nested: process.env.CLAUDECODE ?? null,
}));
setTimeout(() => {}, 3000);
`,
);
process.env.CLAUDECODE = "1"; // the scrub must still win for nested markers
const host = new TerminalHost({ taskId: "resume-units", defaultWorkspace: workspace, eventSink: () => {} });
try {
  host.startTask({
    cwd: workspace,
    command: process.execPath,
    args: [scriptPath],
    extraEnv: {
      CLAUDE_CODE_RESUME_TOKEN_THRESHOLD: "999999999",
      CLAUDE_CODE_RESUME_THRESHOLD_MINUTES: "999999999",
    },
    rows: 12,
    cols: 80,
  });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(envDumpPath) && Date.now() < deadline) {
    await delay(100);
  }
  const childEnv = JSON.parse(fs.readFileSync(envDumpPath, "utf8"));
  assert(childEnv.threshold === "999999999", "extraEnv threshold reaches child");
  assert(childEnv.minutes === "999999999", "extraEnv minutes reaches child");
  assert(childEnv.nested === null, "scrub still removes nested markers");
} finally {
  host.dispose();
  await delay(200);
  fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

const success = failures.length === 0;
console.log(JSON.stringify({ success, failures }, null, 2));
process.exitCode = success ? 0 : 1;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
