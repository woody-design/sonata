// The source of the fake `codex` binary used by codex control-plane e2es.
// Exported as a string so the test writes it to a temp PATH dir + chmods it.
//
// It stands in for the real Codex TUI just enough to exercise Sonata's S2 wiring:
//   - answers the CLI readiness probe and exits, through the shared arms in
//     `fake-cli.mjs` (see that file's header: without them this script HANGS on
//     `codex --version` and every launch of the seven e2e that use it leaves an
//     immortal node process behind — MEASURED 2026-08-06). Only the arms are
//     shared; the body below is too bespoke to generate;
//   - records its argv + SONATA_RUNTIME_DIR + SONATA_NODE to prove `-p sonata`,
//     the per-task env binding, and the interpreter binding all reached the spawn;
//   - UNLESS a `SONATA_FAKE_SILENT` marker exists in its cwd, emits a SessionStart
//     hook (a rollout file + the `hook-*.json` tmp+rename payload the sink shim
//     would write) — the handshake that carries identity + proves liveness;
//   - stays alive so the PTY does not exit (which would end the run).
import { fakeCliProbeArms } from "./fake-cli.mjs";

export const FAKE_CODEX_SOURCE = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");

${fakeCliProbeArms("codex")}

// Anything else is the CLI itself being run: this is the session.
const argv = process.argv.slice(2);
const cIndex = argv.indexOf("-C");
const cwd = cIndex >= 0 && argv[cIndex + 1] ? argv[cIndex + 1] : process.cwd();
const runtimeDir = process.env.SONATA_RUNTIME_DIR;
// A native resume reads \`codex resume <ref>\` as the leading positional (see
// codexArgs). Capture the ref so a reopen fence can prove Sonata reconstructed it
// from the persisted transcript-sources tail; startup spawns have neither.
const isResume = argv[0] === "resume";
const resumeArg = isResume ? (argv[1] ?? null) : null;

if (runtimeDir) {
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(
      path.join(runtimeDir, "spawn-record.json"),
      JSON.stringify({ argv, sonataRuntimeDir: runtimeDir, sonataNode: process.env.SONATA_NODE || null, cwd, resumeArg, hasProfileFlag: argv.includes("-p") && argv[argv.indexOf("-p") + 1] === "sonata" }),
    );
  } catch (_e) {}
}

const has = (marker) => { try { return fs.existsSync(path.join(cwd, marker)); } catch (_e) { return false; } };
const silent = has("SONATA_FAKE_SILENT") || has("SONATA_FAKE_EXIT");

// A crash/quit stand-in: exit before the liveness window elapses, emitting no
// hook — the PTY exit must retire the pending liveness so no banner appears.
if (has("SONATA_FAKE_EXIT")) {
  setTimeout(() => process.exit(0), 800);
}

if (runtimeDir && !silent) {
  try {
    const sessionId = "codexsess-" + path.basename(runtimeDir);
    const now = new Date().toISOString();
    const rolloutPath = path.join(runtimeDir, "rollout-" + sessionId + ".jsonl");
    if (isResume) {
      // Resume CONTINUES the same session file (real codex appends). Don't
      // clobber; append a fresh post-resume line so a reopen fence can prove
      // the re-attached tailer keeps following the rollout.
      fs.appendFileSync(
        rolloutPath,
        JSON.stringify({ timestamp: now, type: "event_msg", payload: { type: "agent_message", message: "resumed and continuing", phase: "final_answer" } }) + "\\n",
      );
    } else {
      fs.writeFileSync(
        rolloutPath,
        JSON.stringify({ timestamp: now, type: "session_meta", payload: { id: sessionId, cwd, timestamp: now } }) + "\\n",
      );
    }
    // Observable proof of the emitted handshake source (hook files are consumed
    // by Sonata's watcher, so a durable marker lets the fence read it).
    try {
      fs.writeFileSync(path.join(runtimeDir, "last-session-start.json"), JSON.stringify({ source: isResume ? "resume" : "startup", sessionId }));
    } catch (_e) {}
    const hooksDir = path.join(runtimeDir, "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    const payload = {
      hook_event_name: "SessionStart",
      session_id: sessionId,
      transcript_path: rolloutPath,
      cwd: cwd,
      model: "gpt-5.5",
      permission_mode: "default",
      // Real codex re-fires SessionStart on \`codex resume\` with source:"resume"
      // (probe-verified); mirror it so a reopen fence can assert re-adoption
      // rode a genuine resume handshake, not a fresh start.
      source: isResume ? "resume" : "startup",
    };
    const seq = Date.now().toString(36) + "-" + process.hrtime.bigint().toString(36) + "-" + process.pid;
    const file = path.join(hooksDir, "hook-" + seq + ".json");
    fs.writeFileSync(file + ".tmp", JSON.stringify(payload), "utf8");
    fs.renameSync(file + ".tmp", file);
  } catch (_e) {}
}

// Stay alive — a real TUI holds the PTY open until the user quits. Raw mode
// (like a real TUI) so PTY input surfaces as data events byte-by-byte — Sonata
// terminates prompts with CSI-u Enter (\\x1b[13u), not a newline, so a
// canonical-mode TTY would line-buffer them forever and never emit "data".
if (process.stdin.isTTY) { try { process.stdin.setRawMode(true); } catch (_e) {} }
process.stdin.resume();
// Record what Sonata writes to the PTY (delivered prompts, answer keys) so a test
// can prove a send actually reached the CLI — i.e. the delivery gate was open.
process.stdin.on("data", (chunk) => {
  try {
    fs.appendFileSync(path.join(cwd, "SONATA_FAKE_STDIN.log"), chunk);
  } catch (_e) {}
});
setInterval(() => {}, 1 << 30);

// --- S3 approval flow (opt-in) ---------------------------------------------
// When SONATA_FAKE_BROKER_SHIM is set, poll cwd for a SONATA_FAKE_ASK.json trigger.
// On trigger: emit a UserPromptSubmit hook (busy), spawn the REAL generated
// broker shim with a PermissionRequest payload (the path a live Codex takes —
// the shim holds, surfaces ask-<id>.json, and echoes Sonata's reply), then on the
// broker's exit record its stdout (the decision, or empty on native fallback)
// and emit a Stop hook (turn-ended). This exercises Sonata's full card→reply
// channel, the busy/turn-end cli-state, and the expiry→native-fallback path.
const brokerShim = process.env.SONATA_FAKE_BROKER_SHIM;
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
  const triggerPath = path.join(cwd, "SONATA_FAKE_ASK.json");
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
        env: { ...process.env, SONATA_RUNTIME_DIR: runtimeDir, SONATA_BROKER_HOLD_MS: String(trigger.holdMs || 60000) },
      });
      let out = "";
      child.stdout.on("data", (c) => { out += c.toString(); });
      child.on("close", () => {
        try {
          fs.writeFileSync(path.join(cwd, "SONATA_FAKE_ASK_RESULT.json"), JSON.stringify({ stdout: out }));
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
          // Sonata's D6 quiescence net (checkCompletionHeuristic) closes the run.
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
