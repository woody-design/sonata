import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// Codex resumable-exit classification (upstream sync 2026-08-03, SL-6). codex
// 0.146.0 carries an open, untriaged silent-exit class on macOS — the TUI dies
// with no stderr and no crash report as the final agent message of a turn
// finishes rendering (openai/codex #36005; no fix even in 0.147.0-alpha.4). For a
// PTY wrapper that death is invisible: the task just turns dormant wearing the
// same face as a session the user closed. The rollout survives, so
// `codex resume <session-id>` brings the conversation back.
//
// Two levels, matching where the decision actually lives:
//   - classifyCodexSessionExit: the pure verdict over the three ingredients the
//     user-facing claim needs ("codex" / "ended" without Sonata asking /
//     "intact — resume?"). It claims nothing about INTENT: a deliberate `/quit`
//     leaves the same fingerprint as a silent death, so the copy it drives says
//     the session ended, not that it ended unexpectedly.
//   - TerminalHost: the outside-Sonata ingredient itself — `pty:exit` must say
//     whether SONATA killed the process, attributed PER PROCESS so a respawn
//     cannot smear one process's teardown onto another's crash.
//
// The host half drives REAL PTYs (short-lived `sh` processes, no provider
// install needed) rather than a fake, because the thing under test is exactly
// the node-pty onExit closure wiring that a fake would replace.
const require = createRequire(import.meta.url);
const { TerminalHost, classifyCodexSessionExit } = require("../../dist/runtime");

const failures = [];

async function check(label, fn) {
  try {
    await fn();
  } catch (error) {
    failures.push(`${label}: ${error?.message ?? error}`);
  }
}

// ── classifyCodexSessionExit: the ingredient matrix ─────────────────────────
// Baseline = every ingredient present. Each case below removes exactly one, so
// a verdict flip is attributable to that ingredient alone.
const RESUMABLE = {
  provider: "codex",
  sonataInitiated: false,
  resumableSessionId: "0198f0aa-1c7d-7000-9d3c-2b1f4e5a6c7d",
  midTurn: false,
};

await check("resumable: codex + outside-Sonata death + a resumable session id", () => {
  assert.deepEqual(classifyCodexSessionExit(RESUMABLE), {
    kind: "resumable",
    sessionId: "0198f0aa-1c7d-7000-9d3c-2b1f4e5a6c7d",
    midTurn: false,
  });
});

await check("resumable: midTurn rides through verbatim (it drives honest copy)", () => {
  // A mid-stream death (#36697's macOS streaming-tail race, and any crash while
  // the agent is answering) is just as resumable — the conversation before the
  // cut is intact — but the answer in flight is lost, and the banner says so.
  assert.deepEqual(classifyCodexSessionExit({ ...RESUMABLE, midTurn: true }), {
    kind: "resumable",
    sessionId: RESUMABLE.resumableSessionId,
    midTurn: true,
  });
});

await check("generic: claude is out of scope — its exit paths carry no such defect", () => {
  assert.deepEqual(classifyCodexSessionExit({ ...RESUMABLE, provider: "claude" }), {
    kind: "generic",
    reason: "not-codex",
  });
});

await check("generic: Sonata's OWN teardown is never surfaced as a session end", () => {
  // Task close, app teardown, and a respawn's pre-spawn dispose all land here.
  assert.deepEqual(classifyCodexSessionExit({ ...RESUMABLE, sonataInitiated: true }), {
    kind: "generic",
    reason: "sonata-initiated",
  });
});

await check("generic: no resumable session id — the offer would be a lie", () => {
  for (const id of [null, undefined, "", "   "]) {
    assert.deepEqual(
      classifyCodexSessionExit({ ...RESUMABLE, resumableSessionId: id }),
      { kind: "generic", reason: "no-resumable-session" },
      `resumableSessionId ${JSON.stringify(id)} must not classify resumable`,
    );
  }
});

await check("generic: a Sonata teardown WITHOUT an id still reports the teardown", () => {
  // Ordering is deliberate: the reason names the first missing ingredient, so a
  // clean close of a session that never bound an id reads as a teardown (what
  // happened) rather than as a lost conversation (what did not).
  assert.deepEqual(
    classifyCodexSessionExit({
      ...RESUMABLE,
      sonataInitiated: true,
      resumableSessionId: null,
    }),
    { kind: "generic", reason: "sonata-initiated" },
  );
});

// ── TerminalHost: per-PROCESS teardown attribution on pty:exit ──────────────
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-resumable-exit-"));

/** Collects pty:exit payloads from one host. */
function makeHost(taskId) {
  const exits = [];
  const host = new TerminalHost({
    taskId,
    provider: "codex",
    defaultWorkspace: workspace,
    eventSink: (event) => {
      if (event.type === "pty:exit") {
        exits.push(event.payload);
      }
    },
  });
  return { host, exits };
}

function waitForExits(exits, count, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (exits.length >= count) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`timed out waiting for ${count} pty:exit (saw ${exits.length})`));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

await check("pty:exit: a process that dies on its own is NOT sonataInitiated", async () => {
  const { host, exits } = makeHost("resumable-exit-self");
  try {
    // Stands in for codex vanishing: the process ends without Sonata asking.
    host.startTask({ command: "sh", args: ["-c", "exit 0"], cwd: workspace });
    await waitForExits(exits, 1);
    assert.equal(exits.length, 1);
    assert.equal(exits[0].sonataInitiated, false, "an outside death must not claim a teardown");
    // The midTurn ingredient the controller derives: no run was in flight.
    assert.equal(exits[0].runId, null);
  } finally {
    host.dispose();
  }
});

await check("pty:exit: a Sonata dispose IS sonataInitiated", async () => {
  const { host, exits } = makeHost("resumable-exit-dispose");
  try {
    host.startTask({ command: "sh", args: ["-c", "sleep 30"], cwd: workspace });
    host.dispose();
    await waitForExits(exits, 1);
    assert.equal(exits.length, 1);
    assert.equal(exits[0].sonataInitiated, true, "Sonata's own kill must be stamped");
  } finally {
    host.dispose();
  }
});

await check("pty:exit: a RESPAWN attributes each process its own teardown", async () => {
  // The case a host-level flag gets wrong in both directions. startTask disposes
  // the outgoing PTY and immediately spawns a replacement: process #1's
  // (asynchronous) exit must report Sonata's teardown, and #2's later natural
  // death must NOT inherit it.
  const { host, exits } = makeHost("resumable-exit-respawn");
  try {
    host.startTask({ command: "sh", args: ["-c", "sleep 30"], cwd: workspace });
    host.startTask({ command: "sh", args: ["-c", "sleep 0.6"], cwd: workspace });
    await waitForExits(exits, 2);
    assert.equal(exits.length, 2);
    assert.equal(exits[0].sonataInitiated, true, "#1 was killed by startTask's dispose");
    assert.equal(exits[1].sonataInitiated, false, "#2 died on its own — no inherited stamp");
  } finally {
    host.dispose();
  }
});

fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5 });

const success = failures.length === 0;
console.log(JSON.stringify({ success, failures }, null, 2));
if (success) {
  console.log("codex-resumable-exit smoke: ok");
}
process.exitCode = success ? 0 : 1;
