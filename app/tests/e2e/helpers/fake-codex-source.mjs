// The source of the fake `codex` binary used by codex control-plane e2es.
// Exported as a string so the test writes it to a temp PATH dir + chmods it.
//
// It stands in for the real Codex TUI just enough to exercise Duet's S2 wiring:
//   - records its argv + DUET_RUNTIME_DIR to prove `-p duet` and the per-task
//     env binding reached the spawn;
//   - UNLESS a `DUET_FAKE_SILENT` marker exists in its cwd, emits a SessionStart
//     hook (a rollout file + the `hook-*.json` tmp+rename payload the sink shim
//     would write) — the handshake that carries identity + proves liveness;
//   - stays alive so the PTY does not exit (which would end the run).
export const FAKE_CODEX_SOURCE = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
const cIndex = argv.indexOf("-C");
const cwd = cIndex >= 0 && argv[cIndex + 1] ? argv[cIndex + 1] : process.cwd();
const runtimeDir = process.env.DUET_RUNTIME_DIR;

if (runtimeDir) {
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(
      path.join(runtimeDir, "spawn-record.json"),
      JSON.stringify({ argv, duetRuntimeDir: runtimeDir, cwd, hasProfileFlag: argv.includes("-p") && argv[argv.indexOf("-p") + 1] === "duet" }),
    );
  } catch (_e) {}
}

const has = (marker) => { try { return fs.existsSync(path.join(cwd, marker)); } catch (_e) { return false; } };
const silent = has("DUET_FAKE_SILENT") || has("DUET_FAKE_EXIT");

// A crash/quit stand-in: exit before the liveness window elapses, emitting no
// hook — the PTY exit must retire the pending liveness so no banner appears.
if (has("DUET_FAKE_EXIT")) {
  setTimeout(() => process.exit(0), 800);
}

if (runtimeDir && !silent) {
  try {
    const sessionId = "codexsess-" + path.basename(runtimeDir);
    const now = new Date().toISOString();
    const rolloutPath = path.join(runtimeDir, "rollout-" + sessionId + ".jsonl");
    fs.writeFileSync(
      rolloutPath,
      JSON.stringify({ timestamp: now, type: "session_meta", payload: { id: sessionId, cwd, timestamp: now } }) + "\\n",
    );
    const hooksDir = path.join(runtimeDir, "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    const payload = {
      hook_event_name: "SessionStart",
      session_id: sessionId,
      transcript_path: rolloutPath,
      cwd: cwd,
      model: "gpt-5.5",
      permission_mode: "default",
      source: "startup",
    };
    const seq = Date.now().toString(36) + "-" + process.hrtime.bigint().toString(36) + "-" + process.pid;
    const file = path.join(hooksDir, "hook-" + seq + ".json");
    fs.writeFileSync(file + ".tmp", JSON.stringify(payload), "utf8");
    fs.renameSync(file + ".tmp", file);
  } catch (_e) {}
}

// Stay alive — a real TUI holds the PTY open until the user quits.
process.stdin.resume();
setInterval(() => {}, 1 << 30);
`;
