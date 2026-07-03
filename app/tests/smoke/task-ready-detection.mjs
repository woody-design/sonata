// task:ready contract locks (S6 world): the between-runs poller
// (checkTaskReady) and the `task:accepts-input` announcement are RETIRED —
// the idle claude TUI emits a ~200ms control-only heartbeat forever
// (s4-diags/zzz-completion-trace), which starved both, so neither ever fired
// in the full app (probe s6-diags/taskready-timeline-diag). What remains:
//  - `task:ready` fires ONLY from a quiescence-completed run
//    (finishActiveRun, terminal-idle-heuristic) — the cli-state
//    busy→turn-ended fallback for turns with no Stop hook (slash, Esc,
//    codex) depends on it.
//  - Between runs, no amount of PTY traffic (or quiet) manufactures
//    readiness events.
//  - The structural idle-prompt detection (the boot-latch fence and the
//    run-closer's composer evidence) keeps working.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  TerminalHost,
  detectIdleComposerForProvider,
  detectIdlePromptForProvider,
} = require("../../dist/runtime");

const failures = [];

// A 5-byte-class control-only chunk (cursor-hide + cursor-move): printable
// content strips to nothing — the idle TUI's housekeeping heartbeat.
const HEARTBEAT_CHUNK = "[?25l[1;1H";

await check("Claude suggestion placeholder is an idle composer prompt", async () => {
  const hint = detectIdlePromptForProvider(claudePlaceholderTail(), "claude");

  assert.equal(hint.ready, true);
  assert.ok(hint.lastPromptIndex >= 0, "expected Claude prompt glyph to be detected");
});

await check(
  "between runs, the control-only heartbeat produces NO readiness events (poller retired)",
  async () => {
    const events = [];
    const host = makeHost(events, { completionQuietMs: 250 });
    try {
      host.ptyProcess = fakePty();
      host.startedAt = Date.now() - 60_000;
      host.rawTail = claudePlaceholderTail();

      // Idle composer on screen + heartbeat flowing + long quiet stretches:
      // none of it may manufacture task:ready or task:accepts-input.
      for (let i = 0; i < 8; i++) {
        host.handlePtyData(HEARTBEAT_CHUNK);
        await delay(50);
      }
      await delay(600); // fully quiet — the retired poller would have fired here

      assert.equal(
        events.some((event) => event.type === "task:ready"),
        false,
        "no task:ready between runs",
      );
      assert.equal(
        events.some((event) => event.type === "task:accepts-input"),
        false,
        "task:accepts-input is retired",
      );
      assert.equal(host.acceptsPromptInput(), true, "the structural boot-latch gate still reads ready");
    } finally {
      host.dispose();
    }
  },
);

await check(
  "a quiescence-completed run fires exactly one task:ready UNDER the heartbeat",
  async () => {
    const events = [];
    const host = makeHost(events, { completionQuietMs: 250 });
    try {
      host.ptyProcess = fakePty();
      host.startedAt = Date.now() - 60_000;
      host.activeRun = slashRun();

      // The run paints once (printable arms the completion debounce), then the
      // TUI goes back to control-only housekeeping — the S4 printable clock
      // must still complete the run, and completion must carry task:ready.
      host.handlePtyData("[2m⏺ Unknown command[0m\r\n");
      for (let i = 0; i < 14; i++) {
        host.handlePtyData(HEARTBEAT_CHUNK);
        await delay(50);
      }

      const completed = events.filter(
        (event) => event.type === "run:updated" && event.payload.status === "completed",
      );
      assert.equal(completed.length, 1, "exactly one completed run:updated");
      assert.equal(completed[0].payload.completionSource, "terminal-idle-heuristic");

      const ready = events.filter((event) => event.type === "task:ready");
      assert.equal(ready.length, 1, "exactly one task:ready, from the completion path");
      assert.equal(ready[0].payload.source, "terminal-idle-composer-heuristic");
      assert.ok(
        ready[0].ts >= completed[0].ts,
        "task:ready rides the completion, never precedes it",
      );
    } finally {
      host.dispose();
    }
  },
);

await check("Claude welcome screen still does not complete a run", async () => {
  const hint = detectIdleComposerForProvider(claudePlaceholderTail(), "claude");

  assert.equal(hint.completed, false);
});

if (failures.length > 0) {
  process.exitCode = 1;
}

function makeHost(events, options = {}) {
  return new TerminalHost({
    taskId: "task-ready-detection-smoke",
    provider: "claude",
    defaultWorkspace: process.cwd(),
    eventSink: (event) => events.push(event),
    ...options,
  });
}

function slashRun() {
  const now = Date.now();
  return {
    taskId: "task-ready-detection-smoke",
    id: `run-${now}-1`,
    kind: "slash",
    prompt: "/zzz-not-a-command",
    title: "/zzz-not-a-command",
    status: "active",
    lifecyclePhase: "active",
    startedAt: new Date(now).toISOString(),
    endedAt: null,
    elapsedMs: null,
  };
}

function claudePlaceholderTail() {
  return [
    "Welcome to Claude Code",
    "cwd ~/Workspace/Product/duet",
    '❯ Try "fix typecheck errors"',
    "Opus 4.1 · low · ? for shortcuts",
  ].join("\n");
}

function fakePty() {
  return {
    pid: 0,
    write() {},
    kill() {},
    resize() {},
    onData() {},
    onExit() {},
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}
