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

// Stay alive — a real TUI holds the PTY open until the user quits. Raw mode
// (like a real TUI) so PTY input surfaces as data events byte-by-byte — Duet
// terminates prompts with CSI-u Enter (\\x1b[13u), not a newline, so a
// canonical-mode TTY would line-buffer them forever and never emit "data".
if (process.stdin.isTTY) { try { process.stdin.setRawMode(true); } catch (_e) {} }
process.stdin.resume();
// Record what Duet writes to the PTY (delivered prompts, answer keys) so a test
// can prove a send actually reached the CLI — i.e. the delivery gate was open.
process.stdin.on("data", (chunk) => {
  try {
    fs.appendFileSync(path.join(cwd, "DUET_FAKE_STDIN.log"), chunk);
  } catch (_e) {}
});
setInterval(() => {}, 1 << 30);

// --- S3 approval flow (opt-in) ---------------------------------------------
// When DUET_FAKE_BROKER_SHIM is set, poll cwd for a DUET_FAKE_ASK.json trigger.
// On trigger: emit a UserPromptSubmit hook (busy), spawn the REAL generated
// broker shim with a PermissionRequest payload (the path a live Codex takes —
// the shim holds, surfaces ask-<id>.json, and echoes Duet's reply), then on the
// broker's exit record its stdout (the decision, or empty on native fallback)
// and emit a Stop hook (turn-ended). This exercises Duet's full card→reply
// channel, the busy/turn-end cli-state, and the expiry→native-fallback path.
const brokerShim = process.env.DUET_FAKE_BROKER_SHIM;
if (runtimeDir && brokerShim) {
  const { spawn } = require("node:child_process");
  const emitHook = (payload) => {
    try {
      const hooksDir = path.join(runtimeDir, "hooks");
      fs.mkdirSync(hooksDir, { recursive: true });
      const seq = Date.now().toString(36) + "-" + process.hrtime.bigint().toString(36) + "-h";
      const file = path.join(hooksDir, "hook-" + seq + ".json");
      fs.writeFileSync(file + ".tmp", JSON.stringify(payload), "utf8");
      fs.renameSync(file + ".tmp", file);
    } catch (_e) {}
  };
  const sessionId = "codexsess-" + path.basename(runtimeDir);
  const rolloutPath = path.join(runtimeDir, "rollout-" + sessionId + ".jsonl");
  const base = { session_id: sessionId, transcript_path: rolloutPath, cwd: cwd, model: "gpt-5.5", permission_mode: "default" };
  const triggerPath = path.join(cwd, "DUET_FAKE_ASK.json");
  let handling = false;
  setInterval(() => {
    if (handling) return;
    let trigger = null;
    try {
      if (fs.existsSync(triggerPath)) { trigger = JSON.parse(fs.readFileSync(triggerPath, "utf8")); }
    } catch (_e) { return; }
    if (!trigger) return;
    handling = true;
    try { fs.rmSync(triggerPath, { force: true }); } catch (_e) {}

    emitHook({ ...base, hook_event_name: "UserPromptSubmit", turn_id: "turn-1", prompt: trigger.prompt || "do the thing" });

    // Let the UserPromptSubmit hook be consumed (→ beginRunFromHook) before the
    // broker's ask arrives, so the approval attributes to the open run — mirrors
    // the real ordering (a PermissionRequest lives INSIDE a turn already begun).
    setTimeout(() => {
      const permissionPayload = {
        ...base,
        hook_event_name: "PermissionRequest",
        turn_id: "turn-1",
        tool_name: trigger.tool_name || "Bash",
        tool_input: trigger.tool_input || { command: "echo hi", description: "Allow this?" },
      };
      const child = spawn("node", [brokerShim], {
        env: { ...process.env, DUET_RUNTIME_DIR: runtimeDir, DUET_BROKER_HOLD_MS: String(trigger.holdMs || 60000) },
      });
      let out = "";
      child.stdout.on("data", (c) => { out += c.toString(); });
      child.on("close", () => {
        try {
          fs.writeFileSync(path.join(cwd, "DUET_FAKE_ASK_RESULT.json"), JSON.stringify({ stdout: out }));
        } catch (_e) {}
        // A card answer (allow/deny) ends the turn → Stop. A broker timeout
        // (empty stdout) means Codex's NATIVE card is now up and the turn is
        // still live waiting on the user — no Stop fires until they answer it.
        if (out) {
          emitHook({ ...base, hook_event_name: "Stop", turn_id: "turn-1", stop_hook_active: false, last_assistant_message: "done" });
          handling = false;
        } else if (trigger.afterExpiry === "stop") {
          // Simulate: user answered the native card in the Terminal → the turn
          // resumes and ends via the Stop hook (the hook-Stop turn-end path).
          setTimeout(() => {
            emitHook({ ...base, hook_event_name: "Stop", turn_id: "turn-1", stop_hook_active: false, last_assistant_message: "done" });
            handling = false;
          }, 700);
        } else if (trigger.afterExpiry === "quiescence") {
          // Simulate: an API-failed turn after the expiry — NO Stop ever fires;
          // the composer just returns. Paint a codex idle composer to stdout so
          // Duet's D6 quiescence net (checkCompletionHeuristic) closes the run.
          setTimeout(() => {
            try {
              process.stdout.write("• Working (1s · esc to interrupt)\\r\\ngpt-5.5 · medium\\r\\n\\u203a \\r\\n");
            } catch (_e) {}
            handling = false;
          }, 300);
        } else {
          handling = false;
        }
      });
      child.stdin.write(JSON.stringify(permissionPayload));
      child.stdin.end();
    }, 500);
  }, 200);
}
`;
