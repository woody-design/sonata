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

// Codex 0.144.x directory-trust dialog (byte-derived from
// spikes/codex-boot-input-window/field-repro.json, probe 2026-07-17). The
// dialog paints its option cursor with the composer's `›`, so before the
// bootDialogHints guard this screen read as an idle composer — the boot latch
// opened and the first delivery's Enter silently answered "Yes, continue"
// while the pasted prompt was discarded (field-hit: the 07-17 BeDog session).
await check("codex trust dialog screen is NOT an idle composer prompt", async () => {
  const dialogScreen =
    ">You are in /var/folders/xx/T/sonata-task-dir\n" +
    "Do you trust the contents of this directory?\n" +
    "Working with untrusted contents comes with higher risk of prompt injection.\n" +
    "Trusting the directory allows project-local config, hooks, and exec policies to load.\n" +
    "› 1. Yes, continue2.No,quitPress enter to continue";
  const hint = detectIdlePromptForProvider(dialogScreen, "codex");

  assert.equal(hint.ready, false, "trust dialog must hold readiness");
});

// After the human answers in the Terminal, the real composer renders AFTER
// the dialog text (same capture, post-trust screen): readiness restores even
// with the dialog still in the scanned scrollback window.
await check("codex composer after an answered trust dialog is ready again", async () => {
  const postTrustScreen =
    "Do you trust the contents of this directory?\n" +
    "› 1. Yes, continue2.No,quitPress enter to continue\n" +
    "╭───╮\n│ >_ OpenAI Codex (v0.144.5) │\n│ model: gpt-5.6-sol high │\n╰───╯\n" +
    "• Starting MCP servers (0/4): codex_apps, node_repl (0s • esc to interrupt)\n" +
    "›Use /skills to list available skillsgpt-5.6-sol high · /var/folders/xx/T/sonata-task-dir";
  const hint = detectIdlePromptForProvider(postTrustScreen, "codex");

  assert.equal(hint.ready, true, "composer painted after the dialog is the real idle prompt");
});

// ── codex Max/Ultra composer glyph `»` (U+00BB) — upstream sync 2026-08-03 ──
//
// Byte-derived from the S1 probe against a real codex 0.146.0
// (spikes/upstream-sync-2026-08/codex/out-q2b-model-walk.frames.log, screens
// AFTER-CONFIRM-t+1.2s and FULL SCROLLBACK). After a switch to Ultra the
// composer paints `»` instead of `›` and STAYS `»` at idle — a tier state, not
// a transient — while the idle footer reads `<model> <effort> · <cwd>` (codex
// has no `? for shortcuts` line). Reverting terminal-host.ts's
// `composerPromptGlyphs` to the `>`/`›`/`❯` triple fails these: the last prompt
// found in an Ultra tail is then the STALE `>_` of the welcome box, which sits
// BEFORE the run's activity text, so the ordering rule reads not-ready forever.
// Every tail below therefore CARRIES that box — a production tail always has it
// (or an earlier `›` composer paint) inside the 8000-char window, and without it
// these cases would fail on a degenerate `lastPromptIndex === -1` instead of on
// the ordering mechanism the fix actually restores.
//
// PROVENANCE. Verbatim from the capture: the welcome box, the `»` composer line,
// the `• Model changed to …` receipt, the Ultra footer, the banner row. Adapted:
// the absolute cwd is shortened (nothing reads this path) and the MCP activity
// line is de-compacted from the capture's COMPACT view (the rendered boot frame
// had already scrolled). Composed: the `• Working …`/`• ok` turn, and — in the
// boot case only — an `ultra` model line and an `»` composer at BOOT, since the
// probe session launched at `high` and switched later. No assertion depends on
// any composed part being verbatim; they set up the ordering, and the glyph is
// what is under test.
const CODEX_ULTRA_FOOTER = "  gpt-5.6-sol ultra · /private/tmp/s1-probe/ws";
// The welcome box keeps showing the LAUNCH model after a mid-session switch
// (measured: box `high` while the footer already reads `ultra`).
const CODEX_WELCOME_BOX = (modelLine) =>
  "╭──────────────────────────────────────────────────────────╮\n" +
  "│ >_ OpenAI Codex (v0.146.0)                               │\n" +
  "│                                                          │\n" +
  `│ model:     gpt-5.6-sol ${modelLine}   /model to change${" ".repeat(11 - modelLine.length)}│\n` +
  "│ directory: /private/tmp/s1-probe/ws                      │\n" +
  "╰──────────────────────────────────────────────────────────╯\n";
// The ~2.1s post-switch animation, measured OCCUPYING the footer line (present
// at t+0 and t+1.2s, gone by t+2.4s) — the model/effort tokens are simply not
// on screen while it runs.
const CODEX_ULTRA_BANNER = " ".repeat(56) + "U L T R A";

await check("codex Ultra composer (`»`) after a worked turn is an idle prompt", async () => {
  const ultraTail =
    CODEX_WELCOME_BOX("high") +
    "• Working (2s · esc to interrupt)\n" +
    "• ok\n" +
    "\n" +
    "• Model changed to gpt-5.6-sol ultra for this conversation\n" +
    "\n" +
    "\n" +
    "» Run /review on my current changes\n" +
    "\n" +
    `${CODEX_ULTRA_FOOTER}\n`;
  const hint = detectIdlePromptForProvider(ultraTail, "codex");

  assert.equal(hint.ready, true, "the `»` composer is the real idle prompt");
  // No escapes and no CR in the fixture, so cleanTerminal is the identity here
  // and the reported index addresses the same string.
  assert.equal(
    hint.lastPromptIndex,
    ultraTail.indexOf("»"),
    "readiness is anchored on the `»` composer, not a stale scrollback glyph",
  );
  assert.equal(
    hint.hasModelOrCwdHint,
    true,
    "the Ultra idle footer's model/effort tokens are the medium-confidence evidence",
  );
  assert.equal(hint.confidence, "medium");
});

// The banner does NOT flip readiness — `ready` rides the glyph + ordering, both
// of which survive it. It only costs the medium-confidence footer for its ~2.1s,
// which at most defers a hook-owned prompt run's quiescence closure to the next
// judge pass (checkCompletionHeuristic re-arms on exactly this demotion, and the
// animation keeps the stream printable-fresh anyway). No settle constant needed.
await check("codex ULTRA banner window holds readiness, costing only confidence", async () => {
  const bannerTail =
    CODEX_WELCOME_BOX("high") +
    "• Working (2s · esc to interrupt)\n" +
    "• ok\n" +
    "\n" +
    "• Model changed to gpt-5.6-sol ultra for this conversation\n" +
    "\n" +
    "\n" +
    "» Run /review on my current changes\n" +
    "\n" +
    `${CODEX_ULTRA_BANNER}\n`;
  const hint = detectIdlePromptForProvider(bannerTail, "codex");

  assert.equal(hint.ready, true, "the banner never makes the composer un-ready");
  assert.equal(
    hint.hasModelOrCwdHint,
    false,
    "the banner owns the footer line, so the model/effort tokens are off screen",
  );
  assert.equal(hint.confidence, "low", "low for ~2.1s → closure waits one judge pass, no lie");
});

// The launch path, not just a native switch: `reasoningOptionsForModel` offers
// max/ultra for the models that allow them, so a Sonata-launched codex task can
// paint `»` from its FIRST composer frame — and this is the screen the boot latch
// (acceptsPromptInput → detectIdlePrompt) reads before the first delivery. Both
// launch-at-Ultra marks — the box's model line and the `»` at boot — are the
// composed part here (see PROVENANCE above); the frame and the MCP activity line
// come from the capture.
await check("codex booting at Ultra is ready for the first delivery", async () => {
  const bootTail =
    CODEX_WELCOME_BOX("ultra") +
    "  Tip: Try the Desktop app. Run 'codex app' or visit https://chatgpt.com/codex\n" +
    "• Booting MCP server: codex_apps (0s • esc to interrupt)\n" +
    "» Run /review on my current changes\n" +
    `${CODEX_ULTRA_FOOTER}\n`;
  const hint = detectIdlePromptForProvider(bootTail, "codex");

  assert.equal(
    hint.ready,
    true,
    "without `»` the last prompt is the banner's `>_`, which precedes the MCP activity line",
  );
});

// The glyph is codex-only ON PURPOSE (composerPromptGlyphs is per-provider):
// claude never paints `»`, so admitting it there would let a `»` in model PROSE
// forge a prompt position after the activity text and close a live run.
await check("claude does not inherit codex's `»` as a prompt glyph", async () => {
  const claudeProseTail =
    "✻ Baked for 2s\n" + "The French quotation marks « and » are typographic guillemets.\n";
  const hint = detectIdlePromptForProvider(claudeProseTail, "claude");

  assert.equal(hint.ready, false, "`»` in prose is not a claude composer prompt");
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
