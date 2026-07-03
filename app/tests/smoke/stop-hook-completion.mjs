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

await check("Stop hook does NOT complete a run while an approval is pending", async () => {
  const events = [];
  const host = makeHost(events);
  try {
    host.ptyProcess = fakePty();
    host.activeRun = activeRun();
    host.approvalActive = true;

    const result = host.completeRunFromTurnEnd();

    assert.equal(result, null, "must not complete a run that is waiting on an approval");
    assert.ok(host.activeRun, "active run should be left intact");
    assert.equal(host.activeRun.status, "active");
    assert.equal(
      events.some((event) => event.type === "run:updated" && event.payload.status === "completed"),
      false,
      "no completed event should be emitted",
    );
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
