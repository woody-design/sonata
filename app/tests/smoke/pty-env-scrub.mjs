// Slice A smoke — nested-session env scrub.
// A `claude` child that inherits CLAUDECODE/CLAUDE_CODE_* registers NO
// ~/.claude/sessions/<pid>.json (research 2026-06-12 §4.2), so the host must
// scrub them at spawn. CLAUDE_CONFIG_DIR is user-owned config and must pass
// through untouched.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TerminalHost } = require("../../dist/runtime");

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "duet-env-scrub-"));
const scriptPath = path.join(workspace, "print-env.mjs");
const envDumpPath = path.join(workspace, "env.json");

fs.writeFileSync(
  scriptPath,
  `
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(envDumpPath)}, JSON.stringify({
  CLAUDECODE: process.env.CLAUDECODE ?? null,
  CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT ?? null,
  CLAUDE_CODE_SSE_PORT: process.env.CLAUDE_CODE_SSE_PORT ?? null,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
  TERM: process.env.TERM ?? null,
}));
process.stdout.write("env dumped\\n");
setTimeout(() => {}, 5000);
`,
  "utf8",
);

// Simulate a Duet that was itself launched from inside a Claude Code session.
process.env.CLAUDECODE = "1";
process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
process.env.CLAUDE_CODE_SSE_PORT = "12345";
process.env.CLAUDE_CONFIG_DIR = "/tmp/duet-smoke-keepme";

const host = new TerminalHost({
  taskId: "task-env-scrub-smoke",
  defaultWorkspace: workspace,
  eventSink: () => {},
});

try {
  host.startTask({
    cwd: workspace,
    command: process.execPath,
    args: [scriptPath],
    rows: 16,
    cols: 100,
  });

  const deadline = Date.now() + 5000;
  while (!fs.existsSync(envDumpPath) && Date.now() < deadline) {
    await delay(100);
  }
  const childEnv = JSON.parse(fs.readFileSync(envDumpPath, "utf8"));
  const success =
    childEnv.CLAUDECODE === null &&
    childEnv.CLAUDE_CODE_ENTRYPOINT === null &&
    childEnv.CLAUDE_CODE_SSE_PORT === null &&
    childEnv.CLAUDE_CONFIG_DIR === "/tmp/duet-smoke-keepme" &&
    childEnv.TERM === "xterm-256color";

  console.log(JSON.stringify({ success, childEnv }, null, 2));
  process.exitCode = success ? 0 : 1;
} finally {
  host.dispose();
  await delay(200);
  fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
