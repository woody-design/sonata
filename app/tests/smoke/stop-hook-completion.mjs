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

function makeHost(events) {
  return new TerminalHost({
    taskId: "stop-hook-completion-smoke",
    provider: "claude",
    defaultWorkspace: process.cwd(),
    eventSink: (event) => events.push(event),
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
