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

// Real claude 2.1.209 idle promptTail regions, byte-derived from
// spikes/claude-idle-prompt-fable/capture-{fable,opus,none}.json (probe P1,
// 2026-07-14). On 2.1.x the model/effort/cwd line renders ABOVE the composer,
// so the forward-scan window after the prompt glyph holds ONLY the idle footer
// ("? for shortcuts", "← for agents") — none of the pre-2.1.x model/effort
// tokens (the driver's OLD regex matched nothing on all three captures). The
// `shortcuts`/`for agents` needles are what restore the medium-confidence
// signal; reverting terminal-host.ts idlePromptModelHints drops these to "low"
// and fails these checks. (The synthetic claudePlaceholderTail below keeps
// model tokens after the glyph, so it can't discriminate old vs new regex.)
const CLAUDE_2_1_209_IDLE_RULE = "─".repeat(120);
const CLAUDE_2_1_209_IDLE_TAILS = {
  fable: `❯ Try "create a util logging.py that..."\n${CLAUDE_2_1_209_IDLE_RULE}\n⏸ manual mode on · ? for shortcuts · ← for agents\n`,
  opus: `❯ Try "fix typecheck errors"\n${CLAUDE_2_1_209_IDLE_RULE}\n⏸ manual mode on · ? for shortcuts · ← for agents\n`,
  none: `> to..."\n${CLAUDE_2_1_209_IDLE_RULE}\n⏸ manual mode on · ? for shortcuts · ← for agents\n`,
};
for (const [model, tail] of Object.entries(CLAUDE_2_1_209_IDLE_TAILS)) {
  await check(
    `claude 2.1.209 idle footer restores medium confidence (${model})`,
    async () => {
      const hint = detectIdlePromptForProvider(tail, "claude");
      assert.equal(hint.ready, true, "real idle composer is ready");
      assert.equal(
        hint.hasModelOrCwdHint,
        true,
        "the idle footer token matches idlePromptModelHints",
      );
      assert.equal(
        hint.confidence,
        "medium",
        "shortcuts/for-agents footer restores medium (reverting the regex → low)",
      );
    },
  );
}

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

await check(
  "codex: a no-Stop turn ends via the KEPT composer-quiescence net (task:ready → cli-state)",
  async () => {
    // D6 safety net, re-proven scrape-free (S4): codex has no StopFailure hook,
    // so an API-failed turn emits neither Stop nor StopFailure and would sit
    // busy forever. The composer-quiescence net (checkCompletionHeuristic →
    // detectIdleComposer on codex `›` + "working"/activity, → finishActiveRun
    // terminal-idle-heuristic → task:ready → cli-state busy→turn-ended) is the
    // ONLY path off busy for it. This must survive the approval-scrape funeral —
    // the codex approval hints are gone but the completion net is deliberately
    // kept.
    const events = [];
    const host = makeHost(events, { provider: "codex", completionQuietMs: 250 });
    try {
      host.ptyProcess = fakePty();
      host.startedAt = Date.now() - 60_000;
      host.activeRun = codexPromptRun();

      // The turn worked, then the composer `›` came back with NO Stop hook (the
      // API-failure shape). A printable paint arms the debounce; then the TUI
      // falls to control-only housekeeping — the net must still fire.
      host.handlePtyData("• Working (2s · esc to interrupt)\r\n");
      host.handlePtyData("gpt-5.5 · medium\r\n› \r\n");
      for (let i = 0; i < 14; i++) {
        host.handlePtyData(HEARTBEAT_CHUNK);
        await delay(50);
      }

      const completed = events.filter(
        (event) => event.type === "run:updated" && event.payload.status === "completed",
      );
      assert.equal(completed.length, 1, "exactly one completed run:updated");
      assert.equal(
        completed[0].payload.completionSource,
        "terminal-idle-heuristic",
        "codex no-Stop turn completes via the quiescence heuristic, not a hook",
      );

      const ready = events.filter((event) => event.type === "task:ready");
      assert.equal(ready.length, 1, "exactly one task:ready — the cli-state busy→turn-ended net");
      assert.equal(ready[0].payload.source, "terminal-idle-composer-heuristic");
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

function codexPromptRun() {
  const now = Date.now();
  return {
    taskId: "task-ready-detection-smoke",
    id: `run-${now}-1`,
    kind: "prompt",
    prompt: "do the thing",
    title: "do the thing",
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
    "cwd ~/Workspace/Product/sonata",
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
