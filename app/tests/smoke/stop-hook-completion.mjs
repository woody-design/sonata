import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TerminalHost } = require("../../dist/runtime");

const failures = [];

await check("Stop hook completes an active run as hook-stop / high confidence", async () => {
  const events = [];
  const host = makeHost(events);
  try {
    host.ptyProcess = fakePty();
    host.activeRun = activeRun();

    const finished = host.completeRunFromTurnEnd();

    assert.ok(finished, "expected the active run to be completed");
    assert.equal(finished.status, "completed");
    assert.equal(finished.completionSource, "hook-stop");
    assert.equal(finished.completionConfidence, "high");
    assert.ok(typeof finished.elapsedMs === "number" && finished.elapsedMs >= 0);
    assert.equal(host.activeRun, null, "active run should be cleared after completion");

    const completedEvents = events.filter(
      (event) => event.type === "run:updated" && event.payload.status === "completed",
    );
    assert.equal(completedEvents.length, 1, "exactly one completed run:updated");
    assert.equal(completedEvents[0].payload.completionSource, "hook-stop");

    assert.equal(host.completionTimer, null, "the fallback completion timer must be cleared");
  } finally {
    host.dispose();
  }
});

await check("StopFailure completes the run carrying the structured error", async () => {
  const events = [];
  const host = makeHost(events);
  try {
    host.ptyProcess = fakePty();
    host.activeRun = activeRun();

    const finished = host.completeRunFromTurnEnd({ errorExcerpt: "model_not_found" });

    assert.ok(finished, "expected the failed turn to complete the run");
    assert.equal(finished.status, "completed");
    assert.equal(finished.completionSource, "hook-stop");
    assert.equal(
      finished.completionHint?.errorExcerpt,
      "model_not_found",
      "the hook's structured error rides the completion hint",
    );
  } finally {
    host.dispose();
  }
});

// Contract updated by fix/dormant-resume (2026-07-03): a genuinely pending
// ask holds its turn open (the broker blocks inside the PermissionRequest
// hook; a native panel blocks the tool call), so Stop CANNOT fire while one
// is truly waiting — Stop arriving with the approval flag up proves the flag
// is a stale scrape artifact. The old "never complete while approval pending"
// guard is superseded: it was exactly the wedge that dropped Stop on claude
// ≥2.1.186's repainted panels.
await check("Stop hook outranks a stale approval flag: clears it and completes", async () => {
  const events = [];
  const host = makeHost(events);
  try {
    host.ptyProcess = fakePty();
    host.activeRun = activeRun();
    host.approvalActive = true;

    const result = host.completeRunFromTurnEnd();

    assert.equal(result?.status, "completed", "stale-approval Stop completes the run");
    assert.equal(result?.statusReason, "stop hook (turn ended)");
    assert.equal(host.approvalActive, false, "stale approval flag is cleared");
    assert.equal(host.activeRun, null, "run is finished, not left wedged");
    assert.equal(
      events.some((event) => event.type === "run:updated" && event.payload.status === "completed"),
      true,
      "completed event is emitted",
    );
  } finally {
    host.dispose();
  }
});

await check("Stop hook keeps the no-op guard for runs already mid-stop", async () => {
  const events = [];
  const host = makeHost(events);
  try {
    host.ptyProcess = fakePty();
    host.activeRun = { ...activeRun(), status: "stopping" };

    const result = host.completeRunFromTurnEnd();

    assert.equal(result, null, "a stopping run is not completed by the Stop hook");
    assert.ok(host.activeRun, "the stopping run is left for the stop path to finish");
  } finally {
    host.dispose();
  }
});

await check("Stop hook with no active run is a no-op (no double completion)", async () => {
  const events = [];
  const host = makeHost(events);
  try {
    host.ptyProcess = fakePty();
    host.activeRun = null;

    const result = host.completeRunFromTurnEnd();

    assert.equal(result, null);
    assert.equal(
      events.some((event) => event.type === "run:updated"),
      false,
      "no run:updated event should be emitted when nothing is active",
    );
  } finally {
    host.dispose();
  }
});

if (failures.length > 0) {
  process.exitCode = 1;
}

await check("beginRunFromHook titles a task-notification run honestly ON run:started", async () => {
  // Review P2 (2026-07-02): run:started feeds auto-titling and the run-index
  // report the moment it fires — the honest title must ride the FIRST event,
  // never a follow-up run:updated patch, or raw XML can leak into task/
  // session titles while the placeholder guard is still open.
  const events = [];
  const host = makeHost(events);
  try {
    host.ptyProcess = fakePty();
    host.beginRunFromHook(
      "<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n</task-notification>",
    );
    const started = events.find((event) => event.type === "run:started");
    assert.ok(started, "expected a run:started for the notification turn");
    assert.equal(started.payload.title, "(background task returned)");
    assert.ok(
      started.payload.prompt.startsWith("<task-notification>"),
      "prompt stays verbatim (the husk-suppression detection key)",
    );
    assert.ok(
      !events.some(
        (event) => event.type === "run:updated" && event.payload.title !== "(background task returned)",
      ),
      "no event ever carries the XML as a title",
    );
  } finally {
    host.dispose();
  }
});

await check("back-stamp refuses a finished same-text twin's late echo", async () => {
  // Review 2026-07-03: text identity cannot tell two consecutive sends of
  // identical text apart — a just-finished twin's LATE UserPromptSubmit echo
  // must not stamp ITS prompt_id onto the newer active run (cross-wired
  // attribution). With a finished twin inside the window: no stamp; without
  // one: the stamp lands.
  const events = [];
  const host = makeHost(events);
  try {
    host.ptyProcess = fakePty();
    host.activeRun = activeRun(); // prompt: "do the thing"

    host.lastFinishedPrompt = { text: "do the thing", expiresAt: Date.now() + 5000 };
    host.beginRunFromHook("do the thing", { promptId: "pid-late-echo" });
    assert.equal(host.activeRun.promptId ?? null, null, "ambiguous echo refused");

    host.lastFinishedPrompt = null;
    host.beginRunFromHook("do the thing", { promptId: "pid-own-echo" });
    assert.equal(host.activeRun.promptId, "pid-own-echo", "unambiguous echo stamps");
  } finally {
    host.dispose();
  }
});

await check("back-stamp reads through [Image #N]: image echo stamps, image twin refused", async () => {
  // 2026-07-05: the CLI decorates the hook prompt with [Image #N] while the run
  // stored the raw text. The back-stamp guard AND the twin guard must both read
  // through that decoration — else normalizing only the back-stamp (site 3)
  // leaves the twin guard (site 4) blind to image echoes and a finished twin's
  // prompt_id cross-wires onto the next run.
  const events = [];
  const host = makeHost(events);
  try {
    host.ptyProcess = fakePty();
    host.activeRun = activeRun(); // raw prompt: "do the thing"

    // Finished same-text twin in-window + a DECORATED late echo: the twin guard
    // must still fire (pre-fix it did not, because raw !== decorated) → no stamp.
    host.lastFinishedPrompt = { text: "do the thing", expiresAt: Date.now() + 5000 };
    host.beginRunFromHook("[Image #1] do the thing", { promptId: "pid-late-echo" });
    assert.equal(host.activeRun.promptId ?? null, null, "decorated twin echo refused");

    // No twin: the decorated echo of THIS run stamps — the back-stamp itself now
    // reads through the markers (the actual image double-card fix).
    host.lastFinishedPrompt = null;
    host.beginRunFromHook("[Image #2] do the thing", { promptId: "pid-own-echo" });
    assert.equal(host.activeRun.promptId, "pid-own-echo", "decorated own echo stamps");
  } finally {
    host.dispose();
  }
});

await check("echo-swallow reads through [Image #N]: a settled run's image echo spawns no phantom run", async () => {
  // 2026-07-05: a run that settled by quiescence before its UserPromptSubmit
  // fired gets its late echo swallowed. An image echo is decorated; unless
  // swallow reads through the markers it falls through to beginRun and spawns a
  // phantom run (decorated prompt, no output to ever close it) → another
  // un-attributed run → another husk card.
  const events = [];
  const host = makeHost(events);
  try {
    host.ptyProcess = fakePty();
    host.activeRun = null;
    host.recentAttributionRun = {
      id: "run-settled",
      prompt: "do the thing",
      expiresAt: Date.now() + 5000,
    };
    host.beginRunFromHook("[Image #1] do the thing", { promptId: "pid-echo" });
    assert.ok(
      !events.some((event) => event.type === "run:started"),
      "decorated echo of a settled run is swallowed — no phantom run",
    );
  } finally {
    host.dispose();
  }
});

// ── Turn-Signal Authority S1a: confidence-gate the quiescence run-closer ──
//
// Field incident (claude 2.1.211, 2026-07-16): a big-session post-submit stall
// leaves the TUI printable-silent past the completion quiet window while the
// model still works for minutes. The submit frame paints an activity hint
// (spinner glyph / "esc to interrupt"), then the composer ❯ — no idle footer —
// so detectIdleComposer reads prompt-after-activity as completed at LOW
// confidence and the run was closed ~2s in. With the SessionStart handshake
// alive, Stop/StopFailure OWN a prompt turn's end; the scrape may only close it
// at MEDIUM confidence (the true "? for shortcuts" idle footer). These frames
// are byte-shaped after the field evidence + the 2.1.209 idle-footer probe.
//
// SL-2b (2026-09-01, claude 2.1.257) added a SECOND admitting arm beside medium,
// so "only at MEDIUM" above is no longer the whole rule: a run that reads idle
// CONTINUOUSLY for `stoplessTurnEndConfirmMs` while the GRID shows a composer
// with no panel owning it also closes, at LOW confidence. It exists because the
// medium gate is unreachable for the two turn endings that fire no hook at all —
// a user Esc mid-turn and a native tool denial (q11, MEASURED). The checks below
// keep their meaning: none of them supplies a screen model, and the default
// window is 30s, so nothing here can reach that arm by accident. The trade-off
// it introduces is pinned explicitly at the end of this file rather than left
// implicit.

// Activity glyph + "esc to interrupt", then a bare composer ❯ (NO footer) →
// detectIdleComposer: ready + prompt-after-activity, hasModelOrCwdHint false →
// completed at LOW confidence. This is the exact shape of all 5 field misfires.
const FIELD_LOW_CONFIDENCE_FRAME = "✻ Levitating… (esc to interrupt)\r\n❯ \r\n";
// A TRUE idle composer: the "? for shortcuts" footer lands in the forward-700
// promptTail → hasModelOrCwdHint true → MEDIUM confidence (covers the
// silent-tool-stop gap #29881 where no Stop ever fires).
const TRUE_IDLE_FOOTER_FRAME =
  "✻ Baked for 2s\r\n❯ \r\n" +
  "─".repeat(40) +
  "\n⏸ manual mode on · ? for shortcuts · ← for agents\n";

await check(
  "hooks alive + prompt + field frame: run STAYS active (low-confidence closure demoted), then Stop closes it",
  async () => {
    const events = [];
    const host = makeHost(events, { completionQuietMs: 250 });
    try {
      host.ptyProcess = fakePty();
      host.noteHookSessionStart(); // SessionStart handshake seen → hooks own turn-end
      host.activeRun = activeRun(); // kind: "prompt"

      // Submit frame paints (arms the completion debounce), then byte silence
      // past the quiet window — the field stall.
      host.handlePtyData(FIELD_LOW_CONFIDENCE_FRAME);
      await delay(400);

      assert.ok(host.activeRun, "the live run must NOT be heuristic-closed at low confidence while hooks are alive");
      assert.equal(host.activeRun.status, "active", "run stays active");
      assert.equal(
        events.some((event) => event.type === "run:updated" && event.payload.status === "completed"),
        false,
        "no premature completion event",
      );
      assert.ok(
        host.completionTimer !== null,
        "the demoted verdict re-arms the completion check so a later Stop / medium idle still closes it",
      );

      // The authoritative turn-end signal closes it honestly as a hook-stop.
      const finished = host.completeRunFromTurnEnd();
      assert.equal(finished?.status, "completed");
      assert.equal(finished?.completionSource, "hook-stop");
      assert.equal(finished?.completionConfidence, "high");
      assert.equal(host.activeRun, null, "run finished by the Stop hook");
    } finally {
      host.dispose();
    }
  },
);

await check(
  "NO handshake + prompt + field frame: heuristic still closes it (hook-less backstop preserved)",
  async () => {
    const events = [];
    const host = makeHost(events, { completionQuietMs: 250 });
    try {
      host.ptyProcess = fakePty();
      // No noteHookSessionStart() → hookSessionStarted stays false. The scrape
      // is this session's only completion signal, so LOW confidence still closes.
      host.activeRun = activeRun();

      host.handlePtyData(FIELD_LOW_CONFIDENCE_FRAME);
      await delay(400);

      const completed = events.filter(
        (event) => event.type === "run:updated" && event.payload.status === "completed",
      );
      assert.equal(completed.length, 1, "hook-less session: the heuristic backstop closes the run");
      assert.equal(completed[0].payload.completionSource, "terminal-idle-heuristic");
      assert.equal(completed[0].payload.completionConfidence, "low", "closed at low confidence, as the backstop must");
      assert.equal(host.activeRun, null);
    } finally {
      host.dispose();
    }
  },
);

await check(
  "hooks alive + prompt + TRUE idle footer (medium): heuristic closes it (silent-tool-stop backstop)",
  async () => {
    const events = [];
    const host = makeHost(events, { completionQuietMs: 250 });
    try {
      host.ptyProcess = fakePty();
      host.noteHookSessionStart();
      host.activeRun = activeRun();

      host.handlePtyData(TRUE_IDLE_FOOTER_FRAME);
      await delay(400);

      const completed = events.filter(
        (event) => event.type === "run:updated" && event.payload.status === "completed",
      );
      assert.equal(completed.length, 1, "a genuine idle footer closes the run even with hooks alive");
      assert.equal(completed[0].payload.completionSource, "terminal-idle-heuristic");
      assert.equal(
        completed[0].payload.completionConfidence,
        "medium",
        "the idle-footer signal is the medium gate that clears heuristic closure",
      );
      assert.equal(host.activeRun, null);
    } finally {
      host.dispose();
    }
  },
);

await check(
  "hooks alive + slash run: quiescence still closes it (no Stop hook exists for a slash)",
  async () => {
    const events = [];
    const host = makeHost(events, { completionQuietMs: 250 });
    try {
      host.ptyProcess = fakePty();
      host.noteHookSessionStart();
      host.activeRun = slashRun();

      // A slash command paints, then goes quiet: quiescence IS its honest
      // completion — the confidence gate does not apply (kind === "slash").
      host.handlePtyData("⏺ Running /model\r\n");
      await delay(400);

      const completed = events.filter(
        (event) => event.type === "run:updated" && event.payload.status === "completed",
      );
      assert.equal(completed.length, 1, "a slash run still completes on quiescence with hooks alive");
      assert.equal(completed[0].payload.completionSource, "terminal-idle-heuristic");
      assert.equal(completed[0].payload.completionConfidence, "medium", "slash quiescence carries medium confidence");
      assert.equal(host.activeRun, null);
    } finally {
      host.dispose();
    }
  },
);

// ── SL-2b: the trade-off, pinned where the fence it touches lives ───────────
//
// The field-misfire frame above is the shape the medium gate was built to
// refuse. The Stop-less arm admits a close on the ABSENCE of liveness evidence,
// so that same frame IS closable once the sustained window elapses. That is a
// deliberate, bounded cost — pinned here so it is a tested fact rather than a
// surprise, and so a future change to either side fails loudly.
//
// What bounds it: the window resets on ANY fresh printable output, and a live
// claude turn at 2.1.257 renders an animated spinner with a running
// elapsed/token counter (measured repainting ~every second across a 91-second
// tool call, q11 s7) — so reaching the window needs genuine continuous silence,
// roughly 17x longer than the ~1.75s windows the misfires actually had.
await check(
  "SL-2b trade-off: the field-stall frame IS closable once the window elapses (bounded, deliberate)",
  async () => {
    const events = [];
    const host = makeHost(events, { completionQuietMs: 250, stoplessTurnEndConfirmMs: 500 });
    try {
      host.ptyProcess = fakePty();
      // The grid the arm reads: a composer with nothing owning the screen.
      host.screenModel = idleComposerGrid();
      host.noteHookSessionStart();
      host.activeRun = activeRun();

      host.handlePtyData(FIELD_LOW_CONFIDENCE_FRAME);
      await delay(400);
      assert.ok(host.activeRun, "still open at 400ms — the medium gate refuses it, exactly as before");

      // Nothing further is printed: the silence the arm requires.
      await delay(900);
      const completed = events.filter(
        (event) => event.type === "run:updated" && event.payload.status === "completed",
      );
      assert.equal(completed.length, 1, "and after the window it closes — the documented cost");
      assert.equal(completed[0].payload.completionConfidence, "low");
      assert.equal(completed[0].payload.statusReason, "sustained idle composer (Stop-less turn end)");
    } finally {
      host.dispose();
    }
  },
);

// THE PROPERTY THE FIRST VERSION GOT WRONG (SL-2b review, BLOCKING). The check
// below and the one after it prove the window cannot BEGIN under output; this
// one proves it RESTARTS. They are different claims, and only this one catches
// the real bug: the judge never runs during dense output (every printable chunk
// re-arms it to `now + completionQuietMs`), so a window armed by one early stall
// used to survive an arbitrarily long live stretch and the next brief pause
// closed a live run. The exposure this pins is not hypothetical — it is the
// post-submit-stall-then-stream shape, and the approval shape too (the judge's
// approval guard-exit returns before any bookkeeping, so a whole panel episode
// is invisible to the run-side term; the panel's PAINT is what saves it).
// The construction matters, and a weaker one gave a false pass first time: the
// STREAMING stretch has to be denser than `completionQuietMs`, because that is
// what makes the judge stop running entirely. That silence-of-the-judge — not
// the output itself — is the mechanism, and it is why wall-clock kept
// accumulating against a frozen `since`. Timings below are chosen so that under
// the pre-fix code the first judge pass AFTER the stream is unambiguously past
// the original deadline (armed ~150ms, fires ~1100ms, window 700ms).
await check(
  "SL-2b: a window armed before a live stream cannot close on the first pause after it",
  async () => {
    const events = [];
    const host = makeHost(events, { completionQuietMs: 150, stoplessTurnEndConfirmMs: 700 });
    try {
      host.ptyProcess = fakePty();
      host.screenModel = idleComposerGrid();
      host.noteHookSessionStart();
      host.activeRun = activeRun();

      // (1) An early post-submit stall arms the window.
      host.handlePtyData(FIELD_LOW_CONFIDENCE_FRAME);
      await delay(400);
      assert.equal(closedCount(events), 0, "the first window has not elapsed yet");

      // (2) The turn was alive all along and streams for ~800ms — chunks every
      // 80ms, denser than the 150ms quiet window, so NO judge pass runs at all
      // and nothing on the run side can observe any of it.
      for (let i = 0; i < 10; i++) {
        host.handlePtyData(`⏺ still working (${i}s)\r\n❯ \r\n`);
        await delay(80);
      }

      // (3) The first pause. Wall clock since arming is now ~1.2s, well past the
      // 700ms window — closing here is the bug, and it is a LIVE turn.
      await delay(400);
      assert.equal(
        closedCount(events),
        0,
        "wall-clock since arming is past the window, but the stretch was not idle — no close",
      );

      // (4) A genuinely full fresh window of silence, and it may close.
      await delay(700);
      assert.equal(closedCount(events), 1, "after a FULL fresh window of silence it closes");
      assert.equal(
        events.find((e) => e.type === "run:updated" && e.payload.status === "completed").payload
          .statusReason,
        "sustained idle composer (Stop-less turn end)",
      );
    } finally {
      host.dispose();
    }
  },
);

// The same property stated on the OTHER term, so neither can silently carry the
// test alone: with the run-side window deliberately pre-aged past the deadline,
// recent printable output must still refuse the close on the stream term.
await check(
  "SL-2b: an aged run-side window cannot close while the STREAM is still noisy",
  async () => {
    const host = makeHost([], { completionQuietMs: 150, stoplessTurnEndConfirmMs: 700 });
    try {
      host.ptyProcess = fakePty();
      host.screenModel = idleComposerGrid();
      host.activeRun = activeRun();
      host.sustainedIdleVerdict = { runId: host.activeRun.id, since: Date.now() - 60_000 };

      host.lastPrintablePtyDataAt = Date.now();
      assert.equal(
        host.stoplessTurnEndConfirmed(),
        false,
        "printable output just landed — the stream term refuses however old the run-side window is",
      );

      host.lastPrintablePtyDataAt = Date.now() - 60_000;
      assert.equal(
        host.stoplessTurnEndConfirmed(),
        true,
        "and with the stream silent that long too, both terms are satisfied",
      );
    } finally {
      host.dispose();
    }
  },
);

// The bound that makes the cost above acceptable, and the FIRST line of defence:
// every printable chunk re-schedules the judge, so output arriving faster than
// `completionQuietMs` means the judge never runs at all — the window cannot even
// begin. This is the property the "a live claude turn animates its spinner"
// argument actually cashes out to, so it is pinned rather than assumed. Written
// at the production RATIO (paints ~7× faster than the quiet window: ~1s repaints
// against the 1800ms default), not at production's absolute timings.
await check(
  "SL-2b: output faster than the quiet window never reaches the judge at all",
  async () => {
    const events = [];
    const host = makeHost(events, { completionQuietMs: 700, stoplessTurnEndConfirmMs: 300 });
    try {
      host.ptyProcess = fakePty();
      host.screenModel = idleComposerGrid();
      host.noteHookSessionStart();
      host.activeRun = activeRun();

      // A spinner repainting on the measured cadence of a LIVE turn, for well
      // past the (squeezed) confirm window.
      for (let i = 0; i < 20; i++) {
        host.handlePtyData(`✻ Levitating… (${i}s · ↓${i * 20} tokens)\r\n❯ \r\n`);
        await delay(100);
      }
      assert.equal(
        events.filter((event) => event.type === "run:updated" && event.payload.status === "completed").length,
        0,
        "2s of elapsed time, no continuous silence — the run is never even judged",
      );
      assert.ok(host.activeRun, "the live run is still open");
    } finally {
      host.dispose();
    }
  },
);

if (failures.length > 0) {
  process.exitCode = 1;
}

/** A stand-in `TaskScreenModel` showing a plain idle composer — the MOST
 *  permissive grid the Stop-less arm can read, so a check that still refuses to
 *  close is refusing on the stream/time terms, not on the screen. */
function closedCount(events) {
  return events.filter((event) => event.type === "run:updated" && event.payload.status === "completed")
    .length;
}

function idleComposerGrid() {
  const screen = "✻ Levitating…\n────────\n❯ \n────────\n  ⏸ manual mode on · ← for agents\n";
  return {
    write: () => {},
    whenSettled: (fn) => fn(),
    viewportText: () => screen,
    resize: () => {},
    dispose: () => {},
  };
}

function makeHost(events, options = {}) {
  return new TerminalHost({
    taskId: "stop-hook-completion-smoke",
    provider: "claude",
    defaultWorkspace: process.cwd(),
    eventSink: (event) => events.push(event),
    ...options,
  });
}

function activeRun() {
  const now = Date.now();
  return {
    taskId: "stop-hook-completion-smoke",
    id: `run-${now}-1`,
    kind: "prompt",
    prompt: "do the thing",
    title: "do the thing",
    status: "active",
    lifecyclePhase: "active",
    startedAt: new Date(now - 4200).toISOString(),
    endedAt: null,
    elapsedMs: null,
    completionSource: null,
    completionConfidence: null,
  };
}

function slashRun() {
  const now = Date.now();
  return {
    taskId: "stop-hook-completion-smoke",
    id: `run-${now}-slash`,
    kind: "slash",
    prompt: "/model",
    title: "/model",
    status: "active",
    lifecyclePhase: "active",
    startedAt: new Date(now).toISOString(),
    endedAt: null,
    elapsedMs: null,
    completionSource: null,
    completionConfidence: null,
  };
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
