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
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  TerminalHost,
  claudeRewindPanelOpen,
  detectIdleComposerForProvider,
  detectIdlePromptForProvider,
  normalizeTerminalDimensions,
} = require("../../dist/runtime");
// Deep import ON PURPOSE: `TaskScreenModel` is a TerminalHost-internal class and
// the SL-2 alt-screen fence needs the production one, not a stand-in. Widening
// the runtime barrel purely for a test would put test scaffolding in the
// product; the same deep-require convention is already used by other smokes.
const { TaskScreenModel } = require("../../dist/runtime/terminal-host/task-screen-model");

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

// ── codex boot screens re-walked at 0.152.0 — upstream sync 2026-09-01, SL-6 ──
//
// The three fixtures below are VERBATIM tails of the pty window production
// actually scans (`cleanTerminal(rawTail).slice(-8000)`), snapshotted at the
// instant each screen owned the display. Captures:
//   spikes/upstream-sync-2026-09/codex/q20-boot-ceremony.fresh-untrusted.capture.txt
//     (`rawAtDialog`, `rawAtFirstReady`)
//   spikes/upstream-sync-2026-09/codex/q23-hooks-review.capture.txt
//     (`productionWindow`, no-bypass arm)
// Not paraphrased: the space-collapsed spellings ("2.No,quit",
// "Trustallandcontinue") are the cell-diff repaint, and a tidied fixture would
// silently test a stream codex never emits.

await check("codex 0.152.0 trust dialog still holds readiness (re-pin)", async () => {
  // Same shape as the 0.144.x fixture above — re-measured rather than assumed,
  // and note what PRECEDES the dialog: codex's startup draft already painted a
  // composer glyph in this same window. The guard works because the dialog's
  // footers paint AFTER it.
  const window =
    "el:     loading   /model to change ││ directory: loading                    │" +
    "╰───────────────────────────────────────╯  › Ask Codex to do anything   ? for shortcuts" +
    "╭╭╭╭╭╭──────────────╮              │              │              │" +
    "/private/tmp/…/fresh-untrusted/workspace │──────────────╯╭╭╭╭╭╭" +
    ">You are in /private/tmp/sonata-sync-2026-09/codex-boot/fresh-untrusted/workspace" +
    "Doyoutrustthecontentsofthisdirectory?Workingwithuntrustedcontentscomeswith" +
    "higherriskofpromptinjection.Trustingthedirectoryallowsproject-localconfig,hooks," +
    "andexecpoliciestoload.› 1. Yes, continue2.No,quitPress enter to continue";
  const hint = detectIdlePromptForProvider(window, "codex");

  assert.equal(hint.ready, false, "the 0.152.0 trust dialog must still hold readiness");
});

// The hooks-review screen (`startup_hooks_review.rs`, reworked at 0.148). Its
// first row renders `› 1. Review hooks` — the composer glyph — and NONE of the
// five trust-dialog needles appear anywhere in the window, so before SL-6 this
// read `ready: true` and a delivery's Enter would have selected "Review hooks".
// Sonata's own spawn suppresses the screen with `--dangerously-bypass-hook-trust`;
// this is the DEGRADED path, where a profile-write failure drops that flag and a
// user's own untrusted hooks raise it.
await check("codex hooks-review screen is NOT an idle composer prompt", async () => {
  const window =
    " model:     loading   /model to change ││ directory: loading                    │" +
    "╰───────────────────────────────────────╯  › Ask Codex to do anything   ? for shortcuts" +
    "╭╭╭╭╭╭────────╮        │        │        │/private/tmp/…/no-bypass/workspace │────────╯" +
    "╭╭╭╭╭╭╭╭╭Hooks need review10 hooks are new or changed." +
    "Hooks can run outside the sandbox after you trust them." +
    "› 1. Review hooks2.Trustallandcontinue3.Continuewithouttrusting(hookswon'trun)" +
    "Press enter to confirm or esc to go back";
  const hint = detectIdlePromptForProvider(window, "codex");

  assert.equal(hint.ready, false, "the hooks-review screen must hold readiness");
  // WHICH needle carries it, pinned so a future edit cannot delete the working
  // one and leave the assertion passing on an accident. The stream collapses
  // both rows, so it is the automatic `compactText` twins that match — the plain
  // spellings alone appear nowhere in these bytes.
  assert.ok(
    !window.includes("trust all and continue") && !window.includes("continue without trusting"),
    "the plain spellings are NOT in the stream — the compacted twins are what match",
  );
  assert.ok(
    window.includes("Trustallandcontinue") && window.includes("Continuewithouttrusting"),
    "both collapsed rows are present, so the guard has two independent needles",
  );
});

// ── the codex boot latch (SL-6) ──────────────────────────────────────────────
// Three VERBATIM captures at codex-cli 0.152.0, from
// spikes/upstream-sync-2026-09/codex/q20-boot-ceremony.*.capture.txt.

/** The startup draft, ~147ms in: a real composer glyph and placeholder under a
 *  box whose model and directory rows still say `loading`. */
const CODEX_STARTUP_DRAFT_WINDOW =
  "──────────────────────╮│ >_ OpenAI Codex (v0.152.0)            ││                                       │" +
  "│ model:     loading   /model to change ││ directory: loading                    │" +
  "╰───────────────────────────────────────╯  › Ask Codex to do anything   ? for shortcuts" +
  "╭╭╭╭╭╭──────────────╮              │              │              │" +
  "/private/tmp/…/fresh-untrusted/workspace │──────────────╯╭╭╭";

/** The same session ~850ms later: the footer has resolved to a real
 *  `<model> <effort> · <cwd>`, which is what carries MEDIUM confidence. */
const CODEX_RESOLVED_COMPOSER_WINDOW =
  "╭────────────────────────────────────────────────╮\n" +
  "│ >_ OpenAI Codex (v0.152.0)                     │\n" +
  "│ model:     gpt-5.6-sol high   /model to change │\n" +
  "│ directory: /private/tmp/…/production/workspace │\n" +
  "╰────────────────────────────────────────────────╯\n\n" +
  "⚠ `--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.\n\n" +
  "• You have 1 usage limit reset available. Run /usage to use one.\n \n \n" +
  "› Ask Codex to do anything\n \n" +
  "  gpt-5.6-sol high · /private/tmp/sonata-sync-2026-09/codex-boot/production/workspace";

/** The dialog as the GRID renders it (unwrapped rows, cursor on the affirm
 *  row) — the channel `isCodexTrustDialogOpen` reads. */
const CODEX_TRUST_DIALOG_SCREEN =
  "> You are in /private/tmp/sonata-sync-2026-09/codex-boot/fresh-untrusted/workspace\n\n" +
  "  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt\n" +
  "  injection. Trusting the directory allows project-local config, hooks, and exec policies to load.\n\n" +
  "› 1. Yes, continue\n  2. No, quit\n\n  Press enter to continue";

// The codex startup DRAFT, and the boot latch that must NOT open on it
// (upstream sync 2026-09-01, SL-6 — measured as a gap, then closed).
//
// At 0.152.0 codex paints a startup DRAFT ~120ms before any onboarding screen:
// the welcome box with `model: loading` / `directory: loading`, then the
// composer glyph and its placeholder. The idle-prompt SCRAPE reads ready on it
// — that is upstream's screen and this file does not argue with it — and the
// delivery boot latch is ONE-WAY, so a pump landing in that window used to latch
// on it. The trust dialog replaced the draft at ~270ms and the first delivery's
// paste and Enter went into the dialog: `prompt:submitted` emitted, directory
// trust granted, prompt discarded.
//
// The reproduction is an A/B PAIR under
// spikes/upstream-sync-2026-09/codex/, both at codex-cli 0.152.1 — read the
// right half: `q25-boot-latch-vs-trust.untrusted-forced.PRE-FIX.capture.txt` is
// the incident (latch 161ms, delivery 1028ms with the dialog on screen), and
// `…untrusted-forced.capture.txt` is the SHIPPED build, which records the
// opposite (never latches, `deliveredAtMs: null`, dialog still unanswered).
//
// WHY NOT A `bootDialogHints` NEEDLE, restated correctly. The first write-up
// claimed no needle could discriminate because every post-glyph string is
// "equally present at a real idle composer". The captures say otherwise:
// `? for shortcuts` is draft-TRANSIENT at 0.152.0 — it appears in the ≤270ms
// frames of all three boot arms and is absent from every resolved composer — so
// by last-index ranking it would in fact discriminate. The real reasons it is
// still the wrong tool are (1) it is not reliably MATCHABLE on the channel the
// guard reads: the string reached the reconstructed grid but not the pty tail
// contiguously in 2 of 3 arms (cell-diff repaint); and (2) it is upstream
// trivia — a loading-footer string that moves every release — where the
// confidence term is a semantic fact.
//
// THE FIX, asserted below: the latch now consults `acceptsFirstPrompt()`, which
// for codex additionally requires MEDIUM confidence (`hasModelOrCwdHint` — the
// footer has resolved to a real model and cwd). The scrape's own verdict is
// unchanged; only the irreversible decision got stricter.
await check("codex's 0.152.0 startup draft reads ready, but only at LOW confidence", async () => {
  const draft = detectIdlePromptForProvider(CODEX_STARTUP_DRAFT_WINDOW, "codex");

  assert.equal(draft.ready, true, "the scrape still reads the draft as a composer — unchanged");
  assert.equal(
    draft.confidence,
    "low",
    "…but only at LOW: the model/cwd footer has not resolved yet",
  );
  assert.equal(
    draft.hasModelOrCwdHint,
    false,
    "which is the term the boot latch now requires",
  );
});

// The fix itself, on the real host: same bytes, latch verdict FALSE. Verified to
// fail against the pre-fix build (which returned true here), so this case is
// load-bearing rather than decorative.
await check("SL-6: the boot latch does NOT open on the codex startup draft", async () => {
  const host = makeHost([], { provider: "codex" });
  try {
    host.ptyProcess = fakePty([]);
    host.rawTail = CODEX_STARTUP_DRAFT_WINDOW;

    assert.equal(
      host.acceptsPromptInput(),
      true,
      "the general readiness predicate is deliberately unchanged",
    );
    assert.equal(
      host.acceptsFirstPrompt(),
      false,
      "…but the one-way boot latch refuses the draft",
    );

    // The resolved composer — the SAME session, one footer later — latches.
    host.rawTail = CODEX_RESOLVED_COMPOSER_WINDOW;
    assert.equal(host.acceptsFirstPrompt(), true, "a resolved footer latches normally");
  } finally {
    host.dispose();
  }
});

// The chosen consequence, pinned so it can never be mistaken for a regression:
// a codex CLI whose footer never resolves never latches. The reachable case is a
// session that cannot take a prompt anyway — logged out (the boot parks on the
// login onboarding screen, MEASURED in q26-unauthenticated-latch.capture.txt) or
// offline so the model catalog never answers. The queue then reads "still
// starting" (`bootLatched` is surfaced on DeliveryTaskState) rather than
// pretending to have sent into a screen that will never run it.
await check("SL-6: a codex composer whose footer never resolves never latches", async () => {
  const host = makeHost([], { provider: "codex" });
  try {
    host.ptyProcess = fakePty([]);
    host.rawTail = CODEX_STARTUP_DRAFT_WINDOW;
    assert.equal(host.acceptsFirstPrompt(), false, "no footer, no latch");

    // …unless the CLI declares the session up itself. SessionStart is stronger
    // evidence than any footer scrape, so the hook still short-circuits — which
    // is what keeps a hook-live session from being held hostage to a footer.
    host.noteHookSessionStart();
    assert.equal(
      host.acceptsFirstPrompt(),
      true,
      "the SessionStart hook outranks the footer requirement",
    );
  } finally {
    host.dispose();
  }
});

// The belt (fix b): the trust dialog's own identity, read off the GRID, is a
// second independent reason the latch stays shut — keyed on the dialog rather
// than on a footer having resolved.
await check("SL-6: the boot latch does NOT open while the trust dialog owns the grid", async () => {
  const host = makeHost([], { provider: "codex" });
  try {
    host.ptyProcess = fakePty([]);
    // A tail whose LAST thing is a resolved composer — so the confidence term
    // alone would let the latch open. Only the grid can refuse this one.
    host.rawTail = CODEX_RESOLVED_COMPOSER_WINDOW;
    assert.equal(host.acceptsFirstPrompt(), true, "control: the tail alone would latch");

    host.screenModel = stubScreenModel(CODEX_TRUST_DIALOG_SCREEN);
    assert.equal(host.isCodexTrustDialogOpen(), true, "the dialog owns the grid");
    assert.equal(host.acceptsPromptInput(), false, "readiness refuses it");
    assert.equal(host.acceptsFirstPrompt(), false, "so the latch stays shut");
  } finally {
    host.dispose();
  }
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

// ── claude Rewind panel (2.1.216+) — upstream sync 2026-08-03 ───────────────
//
// An Esc PAIR at an idle composer opens a restore picker over the composer. Its
// `Enter to continue` is a RESTORE of the conversation (and possibly the code),
// so a prompt delivered into it would answer it — the codex trust-dialog
// silent-Yes class, one worse, because a restore is not recoverable. Sonata's
// own exposure is the stop/interrupt Esc retry (STOP_ESC_RETRY_MIN_MS, raised
// 800 → 1200 in this slice); the user pressing Esc Esc in the co-visible CLI is
// the other way in, and that one no constant can prevent.
//
// `claudeRewindPanelOpen` reads a RENDERED VIEWPORT, never a pty tail (D-1: a
// state query belongs on the grid). The fixtures below are therefore screens.
//
// PROVENANCE.
//   MEASURED — every line of the two panel screens is transcribed from the
//   rendered `--- screen ---` blocks of the S2 captures: the with-history frame
//   from spikes/upstream-sync-2026-08/claude/q4q3b-activity-esc.capture.txt
//   (section "Q3b — Esc, 50ms, Esc (with history)") and the empty-history frame
//   from q3a-esc-nohistory.capture.txt (section "B — Esc, 50ms, Esc"), including
//   the two-space indents, the `…` ellipsis, the `·` separator and the
//   `❯ (current)` row. The idle screen and its footer come from the same
//   captures' baseline frames; the 120-column rules are the captured widths.
//   ADAPTED — the region above each panel is shortened to the turn lines the
//   ordering rules read; the captured screens also carry the welcome box, which
//   no assertion depends on. The capture's own turn text (`❯ reply with the
//   single word: ok` / `⏺ ok` / `✻ Cooked for 2s`) is kept verbatim.
//   COMPOSED — the ARROWED panel screen (the probe never pressed ↓ inside the
//   Rewind list) and the arrowed STREAM tail below it. Both are extrapolated
//   from behaviour measured elsewhere in this capture family: q2a-model-picker's
//   RAW stream shows claude's per-line diffing emit the footer exactly ONCE for
//   a whole four-arrow session, each arrow emitting only a fresh `❯` + row
//   fragment. The panel's row labels come from the measured with-history frame.
const REWIND_RULE = "─".repeat(120);
const CLAUDE_IDLE_FOOTER = "  ⏸ manual mode on · ? for shortcuts · ← for agents";
const CLAUDE_TURN_TAIL =
  "❯ reply with the single word: ok\n" + "\n" + "⏺ ok\n" + "\n" + "✻ Cooked for 2s\n";
// The panel replaces the composer region; the turn transcript stays above it.
const rewindScreenWithHistory = (cursorRow) =>
  CLAUDE_TURN_TAIL +
  `${REWIND_RULE}\n` +
  "  Rewind\n" +
  "\n" +
  "  Restore the code and/or conversation to the point before…\n" +
  "\n" +
  `  ${cursorRow === "checkpoint" ? "❯ " : "  "}  reply with the single word: ok\n` +
  "    No code changes\n" +
  "\n" +
  `  ${cursorRow === "current" ? "❯ " : "  "}(current)\n` +
  "\n" +
  "  Enter to continue · Esc to cancel\n";
const REWIND_SCREEN_WITH_HISTORY = rewindScreenWithHistory("current");
// B1. The state the deleted stream-liveness rule got WRONG — and the one where
// Enter actually destroys something (on `(current)` a restore is a no-op).
const REWIND_SCREEN_ARROWED = rewindScreenWithHistory("checkpoint");
const REWIND_SCREEN_EMPTY_HISTORY =
  CLAUDE_TURN_TAIL +
  `${REWIND_RULE}\n` +
  "  Rewind\n" +
  "\n" +
  "  Nothing to rewind to yet.\n" +
  "\n" +
  "  Esc to cancel\n";
// Dismissal on the GRID is simply the panel's absence — one Esc repaints the
// composer over it and the viewport converges. No liveness rule needed; this is
// the whole reason the predicate moved off the stream.
const CLAUDE_IDLE_SCREEN =
  CLAUDE_TURN_TAIL +
  `${REWIND_RULE}\n` +
  "❯ \n" +
  `${REWIND_RULE}\n` +
  `${CLAUDE_IDLE_FOOTER}\n`;
// The BYTE shape of the same arrowed panel: the footer was emitted once, when
// the panel opened, and the ↓ emits only the two moved rows — so the stream ends
// with a bare `❯` AFTER the last footer. The deleted rule ("the last `❯` must
// precede the footer") read this as CLOSED while the panel was on screen.
const REWIND_ARROWED_STREAM_TAIL =
  `${REWIND_RULE}\n` +
  "  Rewind\n  Restore the code and/or conversation to the point before…\n" +
  "    reply with the single word: ok\n    No code changes\n" +
  "  ❯ (current)\n" +
  "  Enter to continue · Esc to cancel\n" +
  // the ↓ repaint: two row fragments, no footer, no rule
  "  ❯   reply with the single word: ok\n    (current)\n";

for (const [variant, screen] of [
  ["with history", REWIND_SCREEN_WITH_HISTORY],
  ["with history, arrowed off (current)", REWIND_SCREEN_ARROWED],
  ["empty history", REWIND_SCREEN_EMPTY_HISTORY],
]) {
  await check(`claude Rewind panel (${variant}) is recognized on the grid`, async () => {
    assert.equal(claudeRewindPanelOpen(screen), true, "the panel is identified as on screen");
  });
}

await check("claude Rewind recognition is cursor-position-INDEPENDENT (B1)", async () => {
  // The whole point of the grid: an arrow move inside the list changes which row
  // carries `❯` and nothing else. A predicate that reasons about where the cursor
  // sits relative to the footer is defeated by exactly this event.
  assert.equal(
    claudeRewindPanelOpen(REWIND_SCREEN_ARROWED),
    claudeRewindPanelOpen(REWIND_SCREEN_WITH_HISTORY),
    "arrowing off (current) must not change the verdict",
  );
});

await check("the dismissed panel leaves the viewport — no liveness rule needed", async () => {
  assert.equal(claudeRewindPanelOpen(CLAUDE_IDLE_SCREEN), false, "the panel is simply gone");
  const hint = detectIdlePromptForProvider(CLAUDE_IDLE_SCREEN, "claude");
  assert.equal(hint.ready, true, "and the composer beneath it is a normal idle prompt");
  assert.equal(hint.confidence, "medium");
});

// Forge resistance, the S2 lesson applied (and this panel's body is exactly the
// sentence a session ABOUT this code would print). Both needles must be in the
// SAME frame. COMPOSED negatives.
await check("claude Rewind recognition needs body AND footer in one frame", async () => {
  const bodyOnly =
    "✻ Cooked for 2s\n" +
    "Restore the code and/or conversation to the point before the last turn — that is what Esc Esc does.\n" +
    `${REWIND_RULE}\n❯ \n${CLAUDE_IDLE_FOOTER}\n`;
  assert.equal(claudeRewindPanelOpen(bodyOnly), false, "body without footer is prose");

  const footerOnly = `${REWIND_RULE}\n  Rewind\n\n  Enter to continue · Esc to cancel\n`;
  assert.equal(claudeRewindPanelOpen(footerOnly), false, "footer without body is not enough");

  // The approval panel shares the `Esc to cancel` footer token with the EMPTY
  // variant. On the grid this cannot collide: both are full-screen modals in the
  // alternate buffer, so an approval frame never carries a rewind body. Pinned
  // because on the STREAM a stale rewind body could pair with a live approval
  // footer and mislabel the status line "press Esc" — which on an approval means
  // DENY (review M2).
  const approvalScreen =
    "Do you want to make this edit to terminal-host.ts?\n" +
    "❯ 1. Yes\n  2. No, and tell Claude what to do differently\n" +
    "Esc to cancel · Tab to amend\n";
  assert.equal(claudeRewindPanelOpen(approvalScreen), false, "shared footer token is not enough");
  assert.equal(detectIdlePromptForProvider(approvalScreen, "claude").ready, false);
});

// The plain idle composer — the screen the panel replaces — must stay ready, or
// the guard would cost every claude delivery.
await check("the plain idle composer is unaffected by the Rewind guard", async () => {
  assert.equal(claudeRewindPanelOpen(CLAUDE_IDLE_SCREEN), false);
  assert.equal(detectIdlePromptForProvider(CLAUDE_IDLE_SCREEN, "claude").ready, true);
});

/** A stand-in for the per-task `TaskScreenModel` — these tests drive no PTY, so
 *  `startTask` never built one. `isRewindPanelOpen` only needs `viewportText()`
 *  (it reads synchronously by design; see its doc for the staleness argument). */
function stubScreenModel(screen) {
  return {
    write: () => {},
    whenSettled: (fn) => fn(),
    viewportText: () => screen,
    resize: () => {},
    dispose: () => {},
  };
}

// The host predicate — what the six gates actually call — must read the GRID.
// Every case below sets `rawTail` to a tail that CONTRADICTS the screen, so a
// predicate that regressed to the stream fails loudly instead of passing by
// coincidence.
await check("the host predicate reads the screen, not the pty tail (B1)", async () => {
  const host = makeHost([], { provider: "claude" });
  try {
    host.ptyProcess = fakePty();
    // The arrowed panel: on screen, while its byte tail ends with a bare `❯`
    // after the footer — the exact shape that defeated the stream rule.
    host.rawTail = REWIND_ARROWED_STREAM_TAIL;
    host.screenModel = stubScreenModel(REWIND_SCREEN_ARROWED);
    assert.equal(host.isRewindPanelOpen(), true, "an arrowed panel is still open");

    // Converse: the panel's bytes are still in the tail, but the screen has
    // repainted past it. The stream could not tell; the grid simply does not
    // show it.
    host.screenModel = stubScreenModel(CLAUDE_IDLE_SCREEN);
    assert.equal(host.isRewindPanelOpen(), false, "a repainted-past panel is closed");

    // No screen model (no PTY) reads closed rather than holding forever.
    host.screenModel = null;
    assert.equal(host.isRewindPanelOpen(), false, "no grid → no hold");
  } finally {
    host.dispose();
  }
});

// The panel is claude's. A codex frame must never reach the claude needles.
await check("the Rewind guard is claude-only, and outranks the SessionStart hook", async () => {
  for (const [provider, expected] of [
    ["claude", true],
    ["codex", false],
  ]) {
    const host = makeHost([], { provider });
    try {
      host.ptyProcess = fakePty();
      host.screenModel = stubScreenModel(REWIND_SCREEN_WITH_HISTORY);
      assert.equal(host.isRewindPanelOpen(), expected, `${provider}: isRewindPanelOpen`);
      // The readiness gate must outrank the SessionStart hook short-circuit: the
      // hook says the composer came up, which stays true while a modal covers it.
      host.noteHookSessionStart();
      assert.equal(
        host.acceptsPromptInput(),
        !expected,
        `${provider}: acceptsPromptInput under a hooked session`,
      );
    } finally {
      host.dispose();
    }
  }
});

// The submitPrompt backstop (the TOCTOU leg of the same guard). It must throw a
// DELIVERY-GUARD error — matched by isDeliveryGuardError on the "rewind panel is
// open" phrase — so the item is re-queued rather than marked undelivered.
await check("submitPrompt refuses to write into an open Rewind panel", async () => {
  const host = makeHost([], { provider: "claude" });
  try {
    host.ptyProcess = fakePty();
    host.screenModel = stubScreenModel(REWIND_SCREEN_ARROWED);
    assert.throws(
      () => host.submitPrompt("do the thing"),
      /rewind panel is open/i,
      "the phrase is load-bearing: isDeliveryGuardError matches on it",
    );
    assert.equal(host.nudgePromptSubmit(), false, "and the bare Enter retry refuses too");

    // Same host, panel dismissed: the hold is a state, not a latch.
    host.screenModel = stubScreenModel(CLAUDE_IDLE_SCREEN);
    assert.ok(host.submitPrompt("do the thing"), "delivery resumes once the panel closes");
  } finally {
    host.dispose();
  }
});

// ── claude 2.1.252 PRODUCTION-SHAPE idle footer — upstream sync 2026-09, SL-2 ──
//
// Everything above pins BARE-spawn shapes. Sonata never spawns claude bare: it
// injects a statusLine on every launch (claude-runtime-settings.ts), and the q1
// strict A/B measured that config suppressing `? for shortcuts`, the
// `◐ … · /effort` line and `esc to interrupt` outright (findings.md F5). What a
// production idle footer actually paints is the fixture below.
//
// PROVENANCE — MEASURED. `tests/fixtures/claude-idle/production-idle-2.1.252.raw.json`
// is the VERBATIM pty stream of a real claude 2.1.252 session spawned with
// `--permission-mode default --settings {statusLine only}`, captured by
// spikes/upstream-sync-2026-09/claude/q5-readiness-channel.mjs (capture
// q5-readiness-channel.capture.txt) in a /private/tmp workspace: boot → trust
// walk → one real turn ("Reply with exactly: OK") → 42s of post-turn idle. The
// only edit is a TRUNCATION at a paint boundary (the `CSI ?25h` that ends the
// last batch before the probe's Shift+Tab mode walk began), so the fixture ends
// in the post-turn idle state the assertions are about. Nothing was reworded.
//
// It carries `CSI ?1049h` — 2.1.252 boots into the ALTERNATE SCREEN (F3), which
// is why this is stored as a stream and replayed, not as a flat frame.
const productionIdleRaw = JSON.parse(
  fs.readFileSync(
    path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../fixtures/claude-idle/production-idle-2.1.252.raw.json",
    ),
    "utf8",
  ),
);

/** The production screen model, fed the fixture, settled, read. */
async function productionGrid(raw) {
  // 120×40 is the geometry the fixture was captured at; the PTY's own clamp is
  // the only one allowed to touch it (terminal-grid-substrate's FENCE 1).
  const model = new TaskScreenModel(normalizeTerminalDimensions(120, 40));
  model.write(raw);
  await new Promise((resolve) => model.whenSettled(resolve));
  const view = model.viewportText();
  model.dispose();
  return view;
}

// FENCE for the fullscreen substrate (SL-2 objective 3). The alt-screen switch
// is the 2.1.252 change with the widest blast radius, and the claim that Sonata
// still sees the screen rests entirely on `buffer.active` following the switch.
// This proves it with the PRODUCTION class, on a real alt-screen stream, rather
// than on a spike driver's own emulator.
await check("TaskScreenModel reconstructs the 2.1.252 alt-screen idle frame", async () => {
  assert.ok(
    productionIdleRaw.includes("[?1049h"),
    "the fixture is an alt-screen stream (or it is not testing what this test says)",
  );
  const grid = await productionGrid(productionIdleRaw);
  const rows = grid.split("\n").filter((row) => row.trim());
  assert.ok(
    rows.some((row) => row.trim() === "❯"),
    `the composer row is on the reconstructed grid:\n${rows.slice(-6).join("\n")}`,
  );
  assert.ok(
    rows.some((row) => /⏸ manual mode on · ← for agents/.test(row)),
    "the production idle footer is on the reconstructed grid",
  );
  assert.ok(
    rows.some((row) => /Churned for 1s/.test(row)),
    "the turn transcript above the composer survives the differential repaints",
  );
  assert.ok(
    !/\? for shortcuts/.test(grid) && !/esc to interrupt/i.test(grid),
    "and the statusLine really has suppressed the pre-2.1.252 needles",
  );
});

// The footer line as production paints it, lifted from the reconstructed grid —
// the single row that has to keep carrying readiness confidence.
const PRODUCTION_FOOTER = "  ⏸ manual mode on · ← for agents";

await check("the production idle GRID is a medium-confidence idle prompt", async () => {
  const grid = await productionGrid(productionIdleRaw);
  const hint = detectIdlePromptForProvider(grid, "claude");
  assert.equal(hint.ready, true, "the reconstructed idle composer is ready");
  assert.equal(hint.hasModelOrCwdHint, true, "the production footer is inside the promptTail window");
  assert.equal(hint.confidence, "medium");
});

// THE REDUNDANCY. Before SL-2, exactly one alternation of
// `idlePromptModelHints` could match a production footer — `for agents` — and
// that affordance is upstream-churned territory (2.1.232 moved `/tasks` and a
// `← N done` pulse into it). Each half of the footer must now carry the signal
// ALONE, so one reword cannot silently drop readiness to low.
//
// This buys single-token independence, NOT working production readiness: on the
// channel `detectIdlePrompt` actually reads today there is no footer near the
// composer at all — see the MEASURED GAP check at the end of this file, which is
// the honest statement of what is still broken.
await check("either half of the production footer carries confidence alone", async () => {
  const grid = await productionGrid(productionIdleRaw);
  assert.ok(grid.includes(PRODUCTION_FOOTER), "the fixture footer is byte-exact");

  // (a) the agents affordance is REWORDED away (the churn this guards against).
  const rewordedAgents = grid.replace("· ← for agents", "· ← 3 done");
  assert.equal(
    detectIdlePromptForProvider(rewordedAgents, "claude").confidence,
    "medium",
    "the mode line alone must hold medium when `for agents` is reworded",
  );

  // (b) the mode line is gone, the agents affordance remains.
  const modeLineDropped = grid.replace(PRODUCTION_FOOTER, "  ← for agents");
  assert.equal(
    detectIdlePromptForProvider(modeLineDropped, "claude").confidence,
    "medium",
    "`for agents` alone must still hold medium (this is the pre-SL-2 behaviour)",
  );

  // (c) both gone → low. Without this the test above proves nothing: it would
  // pass on any footer at all.
  const bothDropped = grid.replace(PRODUCTION_FOOTER, "  ← 3 done");
  assert.equal(
    detectIdlePromptForProvider(bothDropped, "claude").confidence,
    "low",
    "with neither token the footer carries no confidence — the tokens are what do it",
  );
});

// Redundancy has to cover every permission mode, not just the launch one — a
// user on accept-edits or plan must not lose readiness confidence.
//
// PROVENANCE — the four mode lines are MEASURED, transcribed byte-for-byte from
// q5-readiness-channel.capture.txt section C (a Shift+Tab walk through the full
// native cycle under the same statusLine spawn; all four were reachable on this
// account). ADAPTED: each is pasted into the fixture's own reconstructed frame
// in place of the manual-mode line, because a capture per mode would pin four
// nearly identical frames to test one row.
const MEASURED_MODE_FOOTERS = {
  manual: "  ⏸ manual mode on · ← for agents",
  "accept edits": "  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents",
  plan: "  ⏸ plan mode on (shift+tab to cycle) · ← for agents",
  auto: "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
};
for (const [mode, footer] of Object.entries(MEASURED_MODE_FOOTERS)) {
  await check(`the ${mode} footer carries confidence with the agents token reworded`, async () => {
    const grid = (await productionGrid(productionIdleRaw)).replace(PRODUCTION_FOOTER, footer);
    const rewordedAgents = grid.replace("· ← for agents", "· ← 3 done");
    const hint = detectIdlePromptForProvider(rewordedAgents, "claude");
    assert.equal(hint.ready, true);
    assert.equal(
      hint.confidence,
      "medium",
      `the ${mode} mode line must be an independent readiness token`,
    );
  });
}

// The mode phrases are reused from the S2 receipt parser, glyph anchor included
// (`CLAUDE_MODE_LINE_ON_SCREEN_RE`). Prose that merely contains a phrase is not
// a footer — the same forgery the parser's anchor was added to reject, applied
// to a screen-state answer. COMPOSED negative.
await check("assistant prose about permission modes is not an idle footer", async () => {
  const proseTail = '✻ Cooked for 2s\n────\n❯ \n────\n  I turned plan mode on, then auto mode on.\n';
  const hint = detectIdlePromptForProvider(proseTail, "claude");
  assert.equal(hint.hasModelOrCwdHint, false, "no glyph, no footer");
  assert.equal(hint.confidence, "low");
});

// The claude activity vocabulary's OTHER measured casualty (SL-2 objective 2).
// The statusLine suppresses `esc to interrupt` completely — it is absent from
// this whole real session's bytes — so the 2.x spinner/summary glyphs are the
// only thing left telling `detectIdleComposer` that work happened. If they ever
// stop being activity hints, a production claude turn stops closing by
// quiescence at all (not just at reduced confidence), so the dependency is
// pinned rather than assumed.
await check("claude activity evidence now rests entirely on the spinner glyphs", async () => {
  assert.ok(
    !/esc to interrupt/i.test(productionIdleRaw),
    "the phrase really is absent from a real production session's stream",
  );
  assert.equal(
    detectIdleComposerForProvider(productionIdleRaw, "claude").completed,
    true,
    "the turn closes on glyph evidence alone",
  );
  const glyphless = productionIdleRaw.replace(/[✢✳✶✻✽]/g, "•");
  assert.equal(
    detectIdleComposerForProvider(glyphless, "claude").completed,
    false,
    "and with the glyphs gone there is no activity evidence left at all",
  );
});

// ── The channel asymmetry — a standing FACT, no longer a pending gap ────────
//
// `detectIdlePrompt` reads the pty STREAM, and the alt-screen differential
// repaint emits the footer BEFORE the composer glyph and then homes the cursor
// to the composer, so after a real turn the forward-700 promptTail is literally
// `"❯ "` — no footer in it, so NO token can match however many are added.
// MEASURED across 14 consecutive samples over 42s of post-turn idle (q5 section
// B, 2.1.252) and re-confirmed at 2.1.257 in every q11 arm: raw channel
// `confidence=low`, reconstructed grid `medium`.
//
// SL-2 left this as an open gap ("the fix is a CHANNEL question"). SL-2b
// measured the answer and it is NOT a channel swap — see the
// `stoplessTurnEndConfirmed` block below and its doc comment in terminal-host.
// This assertion stays as the pin on the asymmetry itself, which is what makes
// the medium gate unreachable on the stream after a normal turn.
await check("the same session read from the STREAM is only low (channel asymmetry)", async () => {
  const hint = detectIdlePromptForProvider(productionIdleRaw, "claude");
  assert.equal(hint.ready, true, "readiness itself survives — the composer glyph is last");
  assert.equal(
    hint.hasModelOrCwdHint,
    false,
    "the alt-screen repaint left no footer after the composer glyph in the stream",
  );
  assert.equal(hint.confidence, "low", "so the stream channel cannot reach medium here");
  const grid = await productionGrid(productionIdleRaw);
  assert.equal(
    detectIdlePromptForProvider(grid, "claude").confidence,
    "medium",
    "same bytes, same detector, reconstructed screen — the asymmetry is the CHANNEL",
  );
});

// ── SL-2b: the STOP-LESS turn end ───────────────────────────────────────────
//
// Claude turn completion is hook-primary (Stop / StopFailure). q11 measured what
// that family actually covers at 2.1.257, driving a real TerminalHost + the
// production HookWatcher through seven scenarios (an eighth arm re-measures the
// Esc gap against this fix — 108s wedged before, closed at +32.5s after):
//
//   normal turn end ............ SessionStart→UserPromptSubmit→Stop   COVERED
//   turn whose tool failed ..... +PreToolUse, PostToolUseFailure, Stop COVERED
//   91s foreground tool call ... +PermissionRequest, PostToolUse, Stop COVERED
//   `/exit` .................... Stop, then SessionEnd(prompt_input_exit)
//   pty killed mid-turn ........ no hooks; Sonata's own pty:exit closes it
//   user Esc mid-turn .......... NO HOOK AT ALL                        GAP
//   user denies a tool natively. PreToolUse, PermissionRequest, then nothing GAP
//
// The two gaps are Stop-less turn ENDS, and no wiring closes them: `SessionEnd`
// fires only on process teardown, `PermissionDenied` (injected for the probe)
// does not fire for a native-UI deny, and `Notification(idle_prompt)` — which
// DOES fire at 2.1.257, 60s after a turn ends, falsifying the Phase-0 note in
// cli-signal.ts — is anchored on the same turn-end Stop is: it never arrived in
// the 100s following either Stop-less ending.
//
// So the backstop stays a screen judgement. What changed is that it no longer
// rests on the medium gate alone, which at 2.1.257 is a coin flip on repaint
// order: the natively-denied turn happened to re-emit its footer after the
// composer (stream medium → closed in 3.5s), the Esc'd turn did not (stream low
// → the run sat `active` for the full 108s of the probe, re-judged every 1.8s).
//
// PROVENANCE — MEASURED. `tests/fixtures/claude-idle/esc-interrupted-2.1.257.raw.json`
// is the VERBATIM `activeRunRaw` of a real claude 2.1.257 prompt run, captured by
// spikes/upstream-sync-2026-09/claude/q11-hook-coverage.mjs (arm s3-esc-mid-turn)
// under Sonata's own production spawn: the run was submitted through
// `submitPrompt`, ran ~6s, and was interrupted by an Esc written through
// `writeUserInput` — the co-visible-Terminal path a human takes. Nothing edited.
// The grid below is reconstructed from these same bytes through the production
// `TaskScreenModel`; the live session's own viewport read `ready/medium` in all
// 20 post-Esc samples, so the reconstruction agrees with what was on screen.
const escInterruptedRaw = JSON.parse(
  fs.readFileSync(
    path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../fixtures/claude-idle/esc-interrupted-2.1.257.raw.json",
    ),
    "utf8",
  ),
);

await check("the Esc-interrupted run is the shape the medium gate cannot close", async () => {
  assert.ok(/Interrupted · What should Claude do instead\?/.test(escInterruptedRaw), "the fixture is the interrupt frame");
  const hint = detectIdleComposerForProvider(escInterruptedRaw, "claude");
  assert.equal(hint.completed, true, "the run's own bytes went activity → composer: the turn IS over");
  assert.equal(hint.confidence, "low", "and the stream carries no footer after the composer — medium is unreachable");
  const grid = await productionGrid(escInterruptedRaw);
  assert.equal(
    detectIdlePromptForProvider(grid, "claude").ready,
    true,
    "while the GRID shows a real composer with nothing owning the screen",
  );
});

/** Drive a claude prompt run through the completion judge with hooks alive, the
 *  given run-raw bytes and the given screen, and report what closed it.
 *  `stoplessTurnEndConfirmMs` is squeezed so a smoke can prove a window without
 *  waiting one; the window's LENGTH is a product constant, not the mechanism. */
async function judgeClaudeRun(runRaw, screen, options = {}) {
  const events = [];
  const host = makeHost(events, {
    provider: "claude",
    completionQuietMs: 150,
    stoplessTurnEndConfirmMs: 600,
    ...options.hostOptions,
  });
  try {
    host.ptyProcess = fakePty();
    host.startedAt = Date.now() - 60_000;
    host.screenModel = screen === null ? null : stubScreenModel(screen);
    // Hooks alive: SessionStart landed, so Stop OWNS this turn's end and the
    // scrape is only the backstop — the exact production state under test.
    host.noteHookSessionStart();
    host.activeRun = claudePromptRun();
    host.activeRunRaw = runRaw;
    host.handlePtyData("."); // one printable byte arms the completion debounce
    await delay(options.waitMs ?? 2400);
    const completed = events.filter(
      (event) => event.type === "run:updated" && event.payload.status === "completed",
    );
    // The host is disposed in `finally`, so it is deliberately NOT returned —
    // only the events it emitted, which outlive it.
    return { events, completed };
  } finally {
    host.dispose();
  }
}

await check("SL-2b: a Stop-less claude turn closes once the idle verdict is SUSTAINED", async () => {
  const grid = await productionGrid(escInterruptedRaw);
  const { completed } = await judgeClaudeRun(escInterruptedRaw, grid);

  assert.equal(completed.length, 1, "exactly one completed run:updated");
  assert.equal(completed[0].payload.completionSource, "terminal-idle-heuristic");
  assert.equal(
    completed[0].payload.completionConfidence,
    "low",
    "LOW is the honest confidence — the evidence is sustained quiescence, not an idle footer",
  );
  assert.equal(
    completed[0].payload.statusReason,
    "sustained idle composer (Stop-less turn end)",
    "the reason names WHICH backstop closed it (field triage must not have to guess)",
  );
});

await check("SL-2b: it does NOT close before the window elapses", async () => {
  const grid = await productionGrid(escInterruptedRaw);
  const { completed } = await judgeClaudeRun(escInterruptedRaw, grid, {
    hostOptions: { stoplessTurnEndConfirmMs: 60_000 },
    waitMs: 1200,
  });
  assert.equal(completed.length, 0, "the run is still under judgment until the window is met");
});

// Term 2 (STATE, on the grid). The whole point of reading the screen is to
// refuse when something OWNS it — an approval or option panel is a live turn
// waiting for the human, and closing it as "done" is the lie this guards.
//
// Asserted on the PREDICATE, not on the absence of a completion event: a
// panel-shaped grid also trips the host's own approval scrape (`approvalActive`
// → `checkCompletionHeuristic` guard-exits), so an event-level assertion here
// would pass for the wrong reason and prove nothing about term 2. Same host,
// same aged window, two grids, one variable.
await check("SL-2b: a panel owning the screen holds the sustained close", async () => {
  const panelScreen =
    "Do you want to create hello.txt?\n" +
    "❯ 1. Yes\n  2. Yes, and switch to accept edits for this session (shift+tab)\n  3. No\n" +
    "Esc to cancel · Tab to amend\n";
  assert.equal(
    detectIdlePromptForProvider(panelScreen, "claude").ready,
    false,
    "the panel frame is not an idle prompt (the premise this guard rests on)",
  );

  const grid = await productionGrid(escInterruptedRaw);
  const host = makeHost([], { provider: "claude", stoplessTurnEndConfirmMs: 0 });
  try {
    host.ptyProcess = fakePty();
    host.activeRun = claudePromptRun();
    // The window is already satisfied — so the ONLY thing left to decide the
    // verdict is which screen is on the grid.
    host.sustainedIdleVerdict = { runId: host.activeRun.id, since: Date.now() - 60_000 };

    host.screenModel = stubScreenModel(grid);
    assert.equal(host.stoplessTurnEndConfirmed(), true, "an idle composer grid confirms");

    host.screenModel = stubScreenModel(panelScreen);
    assert.equal(host.stoplessTurnEndConfirmed(), false, "a panel owning the grid refuses");
  } finally {
    host.dispose();
  }
});

// No grid, no claim — same rule every other screen predicate on this class
// follows. A bare host in a test has no screen model, and must not inherit a
// closure it cannot justify.
await check("SL-2b: no screen model means no sustained close", async () => {
  const { completed } = await judgeClaudeRun(escInterruptedRaw, null);
  assert.equal(completed.length, 0, "the state term is unanswerable, so the gate refuses");

  // …and the predicate itself refuses, so the check above cannot be passing on
  // some other guard.
  const host = makeHost([], { provider: "claude", stoplessTurnEndConfirmMs: 0 });
  try {
    host.ptyProcess = fakePty();
    host.activeRun = claudePromptRun();
    host.sustainedIdleVerdict = { runId: host.activeRun.id, since: Date.now() - 60_000 };
    host.screenModel = null;
    assert.equal(host.stoplessTurnEndConfirmed(), false, "no grid → no claim");
  } finally {
    host.dispose();
  }
});

// Term 1 (EVENT, on the stream) is the one carrying the real weight: across 18
// samples spanning a genuinely live 91-second foreground tool call (q11 s7) the
// run-raw verdict read NOT-completed every time, while every grid-side reading
// said "idle". A live turn must never reach the window at all.
//
// PROVENANCE — MEASURED/ADAPTED. The run-raw text below is the q11 s7 turn's own
// shape: the echoed prompt, claude's `⏺ Running 1 shell command…` line and the
// `⎿  $ python3 …` tool line, transcribed from that arm's captured stream. The
// grid is the production idle frame — deliberately the MOST permissive screen
// there is, so the assertion can only pass on the stream term.
await check("SL-2b: a LIVE turn never reaches the window (the stream term holds it)", async () => {
  const liveTurnRaw =
    "❯ Run this exact bash command in the FOREGROUND and wait for it to finish\n" +
    "⏺ Running 1 shell command…\n" +
    "  ⎿  $ python3 -c \"import time; time.sleep(90); print('slept')\"\n" +
    "✻ Honking… (2s · ↓25 tokens)\n";
  assert.equal(
    detectIdleComposerForProvider(liveTurnRaw, "claude").completed,
    false,
    "the run's own bytes end in activity, not a composer — the turn is not over",
  );
  const grid = await productionGrid(productionIdleRaw);
  assert.equal(
    detectIdlePromptForProvider(grid, "claude").confidence,
    "medium",
    "and the grid says `medium` anyway — which is why the grid's CONFIDENCE is not the gate",
  );
  const { completed } = await judgeClaudeRun(liveTurnRaw, grid);
  assert.equal(completed.length, 0, "a live turn is never closed by the sustained path");
});

// A single non-idle pass RESTARTS the window: the run has to be continuously
// idle, not idle-then-busy-then-idle. Without the reset a turn that stalled once
// early would carry an aged window into its next quiet moment.
await check("SL-2b: activity resets the sustained window", async () => {
  const grid = await productionGrid(escInterruptedRaw);
  const events = [];
  const host = makeHost(events, {
    provider: "claude",
    completionQuietMs: 150,
    stoplessTurnEndConfirmMs: 900,
  });
  try {
    host.ptyProcess = fakePty();
    host.startedAt = Date.now() - 60_000;
    host.screenModel = stubScreenModel(grid);
    host.noteHookSessionStart();
    host.activeRun = claudePromptRun();

    // Idle for most of the window…
    host.activeRunRaw = escInterruptedRaw;
    host.handlePtyData(".");
    await delay(700);
    // …then the model speaks again: the turn was NOT over.
    host.activeRunRaw = `${escInterruptedRaw}\n✻ Honking… (2s · ↓25 tokens)\n`;
    host.handlePtyData(".");
    await delay(700);
    assert.equal(
      events.filter((e) => e.type === "run:updated" && e.payload.status === "completed").length,
      0,
      "the pre-activity idle time must not count toward the window",
    );
  } finally {
    host.dispose();
  }
});

// Codex is UNTOUCHED by this slice. Its stream is fine (`--no-alt-screen` keeps
// the footer inside the promptTail window), so the medium gate is a real test
// there and the sustained path must never fire for it — a codex turn that reads
// idle at LOW confidence with hooks alive stays under judgment exactly as before.
await check("SL-2b: the sustained close is claude-only — codex is unchanged", async () => {
  const grid = await productionGrid(escInterruptedRaw);
  const events = [];
  const host = makeHost(events, {
    provider: "codex",
    completionQuietMs: 150,
    stoplessTurnEndConfirmMs: 600,
  });
  try {
    host.ptyProcess = fakePty();
    host.startedAt = Date.now() - 60_000;
    host.screenModel = stubScreenModel(grid);
    host.noteHookSessionStart();
    host.activeRun = codexPromptRun();
    // A codex idle composer with NO model/effort footer → ready at LOW.
    host.activeRunRaw = "• Working (2s · esc to interrupt)\n• ok\n› \n";
    assert.equal(detectIdleComposerForProvider(host.activeRunRaw, "codex").completed, true);
    assert.equal(detectIdleComposerForProvider(host.activeRunRaw, "codex").confidence, "low");
    host.handlePtyData(".");
    await delay(2400);
    assert.equal(
      events.filter((e) => e.type === "run:updated" && e.payload.status === "completed").length,
      0,
      "codex keeps the medium-only gate — no sustained path",
    );
  } finally {
    host.dispose();
  }
});

// The MEDIUM path is untouched and still closes promptly — this is the shape the
// natively-denied turn takes (q11 s6: closed 3.5s after the deny, medium).
await check("SL-2b: a medium-confidence idle footer still closes immediately", async () => {
  const grid = await productionGrid(productionIdleRaw);
  const { completed } = await judgeClaudeRun(grid, grid, {
    hostOptions: { stoplessTurnEndConfirmMs: 60_000 },
    waitMs: 1200,
  });
  assert.equal(detectIdleComposerForProvider(grid, "claude").confidence, "medium");
  assert.equal(completed.length, 1, "medium closes on the first judge pass, no window involved");
  assert.equal(completed[0].payload.completionConfidence, "medium");
  assert.equal(
    completed[0].payload.statusReason,
    "terminal idle/composer heuristic",
    "and it keeps the original reason string",
  );
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

function claudePromptRun() {
  const now = Date.now();
  return {
    taskId: "task-ready-detection-smoke",
    id: `run-${now}-1`,
    kind: "prompt",
    prompt: "Write out the numbers 1 to 400, one per line",
    title: "Write out the numbers 1 to 400, one per line",
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
