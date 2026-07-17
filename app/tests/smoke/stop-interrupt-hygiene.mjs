import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Fences the stop → edit → resend fixes (2026-07-17,
// spikes/stop-restore-probe): Esc-interrupt restores the interrupted prompt
// into the CLI's own input box (claude 2.1.212 + codex 0.144.5), and
// submitPrompt's deferred text/Enter timers could fire AFTER a stop —
// starting the very turn the user stopped. Fenced here:
//   1. stopRun cancels pending deferred PROMPT writes (no post-stop paste);
//      canceled CONTROL writes (/rc Enter) never count as a canceled prompt.
//   2. stopRun arms the belt clear — a Ctrl+U flood sized from the session's
//      high-water pasted line count (2×lines+2, floor 40) so a 1-line
//      mid-turn steer can't undersize the flood for a multi-line turn. The
//      belt does NOT consume the dirty flag (slow-restore coverage).
//   3. The next submission prefixes the same flood ahead of its paste and is
//      the only consumer of the flag.
//   4. The one-shot Esc resend fires ONLY on post-stop tool evidence inside
//      [800ms, 45s], never at idle, never into a new run (a blind repeat
//      opens Claude's rewind menu / prefills Codex's edit-previous buffer),
//      and carries the stopped run's id for the durable report.
//   5. A lone human Esc in the Terminal during a run marks the line dirty.
//   6. DeliveryController.handleStopRequested disarms the Enter-retry ladder
//      and reports a write-canceled in-flight item undelivered immediately —
//      unless UPS already corroborated the submission.
// Fake pty, no real CLI.
const require = createRequire(import.meta.url);
const { TerminalHost, DeliveryController, KILL_LINE, ESC, CSI_U_ENTER } = require("../../dist/runtime");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];

const PASTE_START = "\x1b[200~";

function makeHost(events = []) {
  return new TerminalHost({
    taskId: "stop-interrupt-hygiene-smoke",
    provider: "claude",
    defaultWorkspace: process.cwd(),
    eventSink: (event) => events.push(event),
  });
}

function fakePty(writes) {
  return {
    pid: 0,
    write(data) {
      writes.push(data);
    },
    kill() {},
    resize() {},
    onData() {},
    onExit() {},
  };
}

const isEsc = (write) => write === ESC;
const isKillFlood = (write) => write.length > 0 && [...write].every((ch) => ch === KILL_LINE);
const hasPaste = (writes) => writes.some((write) => write.includes(PASTE_START));
const hasEnter = (writes) => writes.some((write) => write.includes(CSI_U_ENTER));

await check("stopRun cancels the deferred text/Enter writes of a just-sent prompt", async () => {
  const writes = [];
  const host = makeHost();
  try {
    host.ptyProcess = fakePty(writes);
    host.submitPrompt("stop me before I start");
    // Deferred text (0ms) / Enter (120ms) timers are pending — stop NOW.
    const { canceledPendingPromptWrite } = await host.stopRun({ inspectDelayMs: 500 });
    assert.equal(canceledPendingPromptWrite, true, "stop should report canceled prompt writes");
    await delay(300);
    assert.ok(!hasPaste(writes), "the canceled paste must never reach the pty");
    assert.ok(!hasEnter(writes), "the canceled Enter must never reach the pty");
    assert.ok(writes.some(isEsc), "the interrupt Esc still goes out");
  } finally {
    host.dispose();
  }
});

await check("belt clear: a floored kill flood lands after the settle delay; the flag stays armed", async () => {
  const writes = [];
  const host = makeHost();
  try {
    host.ptyProcess = fakePty(writes);
    host.submitPrompt("line one\nline two\nline three");
    await delay(250); // let the paste + Enter fire so nothing is canceled
    assert.ok(hasPaste(writes), "precondition: the prompt pasted");
    const { canceledPendingPromptWrite } = await host.stopRun({ inspectDelayMs: 500 });
    assert.equal(canceledPendingPromptWrite, false, "nothing pending → nothing canceled");
    await delay(1_200); // CLI_INPUT_CLEAR_DELAY_MS = 900
    const floods = writes.filter(isKillFlood);
    assert.equal(floods.length, 1, "exactly one belt flood");
    assert.equal(floods[0].length, 40, "small prompts flood at the floor (wrapped-line blanket)");
    // Review F1: the belt must NOT stand the submit-time guard down — a
    // restore landing after 900ms is only covered by the pre-submit prefix.
    writes.length = 0;
    host.submitPrompt("sent after the belt fired");
    await delay(250);
    const floodIndex = writes.findIndex(isKillFlood);
    const pasteIndex = writes.findIndex((write) => write.includes(PASTE_START));
    assert.ok(floodIndex !== -1 && floodIndex < pasteIndex, "the post-belt send still pre-clears");
  } finally {
    host.dispose();
  }
});

await check("flood sizing rides the session high-water, not the last (steering) send", async () => {
  const writes = [];
  const host = makeHost();
  try {
    host.ptyProcess = fakePty(writes);
    const bigPrompt = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    host.submitPrompt(bigPrompt); // starts the run; high-water 30
    await delay(250);
    host.submitPrompt("one-line mid-turn steer"); // write-through; must NOT shrink the flood
    await delay(250);
    await host.stopRun({ inspectDelayMs: 500 });
    await delay(1_200);
    const floods = writes.filter(isKillFlood);
    assert.equal(floods.length, 1, "one belt flood");
    assert.equal(
      floods[0].length,
      30 * 2 + 2,
      "the flood covers the interrupted 30-line turn, not the 1-line steer (review F2)",
    );
  } finally {
    host.dispose();
  }
});

await check("a canceled CONTROL write never claims the prompt was canceled", async () => {
  const writes = [];
  const host = makeHost();
  try {
    host.ptyProcess = fakePty(writes);
    host.submitPrompt("a prompt whose bytes fully land");
    await delay(250); // prompt paste + Enter are out
    host.injectRemoteControl(); // defers a CONTROL-owned Enter (120ms)
    const { canceledPendingPromptWrite } = await host.stopRun({ inspectDelayMs: 500 });
    assert.equal(
      canceledPendingPromptWrite,
      false,
      "the /rc Enter cancel must not count as a canceled prompt write (review F3)",
    );
  } finally {
    host.dispose();
  }
});

await check("fast resend: the next submission prefixes the flood; the belt stands down", async () => {
  const writes = [];
  const host = makeHost();
  try {
    host.ptyProcess = fakePty(writes);
    host.submitPrompt("first prompt");
    await delay(250);
    await host.stopRun({ inspectDelayMs: 500 });
    writes.length = 0;
    host.submitPrompt("second prompt"); // beats the 900ms belt
    await delay(250);
    const floodIndex = writes.findIndex(isKillFlood);
    const pasteIndex = writes.findIndex((write) => write.includes(PASTE_START));
    assert.ok(floodIndex !== -1, "the resend pre-clears the dirty line");
    assert.ok(pasteIndex !== -1, "the resend still pastes");
    assert.ok(floodIndex < pasteIndex, "the flood lands BEFORE the paste");
    await delay(1_200);
    assert.equal(
      writes.filter(isKillFlood).length,
      1,
      "the belt must not fire a second flood after the prefix consumed the flag",
    );
  } finally {
    host.dispose();
  }
});

await check("Esc resend fires once on post-stop tool evidence, inside the window only", async () => {
  const events = [];
  const writes = [];
  const host = makeHost(events);
  try {
    host.ptyProcess = fakePty(writes);
    host.submitPrompt("runaway turn");
    const stoppedRunId = host.activeRun?.id ?? null;
    assert.ok(stoppedRunId, "precondition: the send began a run");
    await delay(250);
    await host.stopRun({ inspectDelayMs: 500 });
    const escsAfterStop = () => writes.filter(isEsc).length;
    const baseline = escsAfterStop();

    host.noteToolActivityAfterStop(); // too early (<800ms) — in-flight hook race
    assert.equal(escsAfterStop(), baseline, "evidence inside the lower bound must not retry");

    host.stopEscRetry.requestedAt = Date.now() - 2_000; // step past the lower bound
    host.noteToolActivityAfterStop();
    assert.equal(escsAfterStop(), baseline + 1, "tool evidence after the stop resends the Esc once");
    const retryEvents = events.filter(
      (event) => event.type === "run:stop-requested" && event.payload.phase === "interrupt-retry",
    );
    assert.equal(retryEvents.length, 1, "the resend is recorded as interrupt-retry");
    assert.equal(
      retryEvents[0].payload.runId,
      stoppedRunId,
      "the retry carries the STOPPED run's id so run-index can record it (review F4)",
    );

    host.noteToolActivityAfterStop();
    assert.equal(escsAfterStop(), baseline + 1, "the resend is one-shot");
  } finally {
    host.dispose();
  }
});

await check("Esc resend never fires into a new run, and a new send disarms it", async () => {
  const writes = [];
  const host = makeHost();
  try {
    host.ptyProcess = fakePty(writes);
    host.submitPrompt("first turn");
    await delay(250);
    await host.stopRun({ inspectDelayMs: 500 });
    host.submitPrompt("second turn"); // supersedes the stop
    await delay(250);
    const baseline = writes.filter(isEsc).length;
    assert.equal(host.stopEscRetry, null, "a new send disarms the armed retry");
    host.noteToolActivityAfterStop();
    assert.equal(writes.filter(isEsc).length, baseline, "no Esc into the new turn");
  } finally {
    host.dispose();
  }
});

await check("a lone human Esc during a run marks the CLI line dirty for the next send", async () => {
  const writes = [];
  const host = makeHost();
  try {
    host.ptyProcess = fakePty(writes);
    host.submitPrompt("native interrupt incoming");
    await delay(250);
    assert.ok(host.activeRun, "precondition: a run is active");
    host.writeUserInput(ESC); // human presses Esc in the Terminal window
    writes.length = 0;
    host.submitPrompt("typed after the native interrupt");
    await delay(250);
    const floodIndex = writes.findIndex(isKillFlood);
    const pasteIndex = writes.findIndex((write) => write.includes(PASTE_START));
    assert.ok(floodIndex !== -1 && floodIndex < pasteIndex, "the next send pre-clears");
  } finally {
    host.dispose();
  }
});

await check("handleStopRequested reports a write-canceled in-flight item undelivered", async () => {
  const states = [];
  const host = {
    hasActiveRun: () => false,
    isApprovalActive: () => false,
    acceptsPromptInput: () => true,
    isHumanActivelyTyping: () => false,
    nudges: 0,
    submitPrompt: (text) => ({
      taskId: "t",
      runId: "r1",
      kind: "prompt",
      submittedAt: new Date().toISOString(),
    }),
    nudgePromptSubmit() {
      this.nudges += 1;
      return true;
    },
  };
  const controller = new DeliveryController({
    taskId: "stop-interrupt-hygiene-smoke",
    provider: "claude",
    terminalHost: host,
    eventSink: (event) => {
      if (event.type === "delivery:state") {
        states.push(event.payload);
      }
    },
    hasLiveTranscriptSource: () => true,
    bootDeliveryGraceMs: 0,
    enterRetryDelaysMs: [80],
  });
  try {
    controller.enqueue("stopped before delivery finished");
    await delay(30);
    controller.handleStopRequested({ promptWriteCanceled: true });
    const last = states.at(-1);
    const item = last?.queue.find(() => true);
    assert.ok(item, "the item is still reported");
    assert.equal(item.status, "undelivered", "canceled write → undelivered now, not after 45s");
    assert.match(item.failureReason ?? "", /Stop/, "the reason names the stop");
    await delay(200);
    assert.equal(host.nudges, 0, "the Enter-retry ladder is disarmed by the stop");
  } finally {
    controller.dispose(); // the receipt timer is non-unref'd — don't hold the process
  }
});

await check("a UPS-corroborated in-flight item survives handleStopRequested intact", async () => {
  const states = [];
  const host = {
    hasActiveRun: () => false,
    isApprovalActive: () => false,
    acceptsPromptInput: () => true,
    isHumanActivelyTyping: () => false,
    submitPrompt: (text) => ({
      taskId: "t",
      runId: "r1",
      kind: "prompt",
      submittedAt: new Date().toISOString(),
    }),
    nudgePromptSubmit: () => true,
  };
  const controller = new DeliveryController({
    taskId: "stop-interrupt-hygiene-smoke",
    provider: "claude",
    terminalHost: host,
    eventSink: (event) => {
      if (event.type === "delivery:state") {
        states.push(event.payload);
      }
    },
    hasLiveTranscriptSource: () => true,
    bootDeliveryGraceMs: 0,
    enterRetryDelaysMs: [],
  });
  try {
    controller.enqueue("proven submitted before the stop");
    await delay(30);
    controller.notePromptSubmittedByCli("proven submitted before the stop");
    controller.handleStopRequested({ promptWriteCanceled: true });
    const last = states.at(-1);
    const item = last?.queue.find(() => true);
    assert.equal(
      item?.status,
      "delivering",
      "UPS proof outranks the cancel signal — no false undelivered (review F3)",
    );
  } finally {
    controller.dispose();
  }
});

await check("handleStopRequested without canceled writes only disarms the ladder", async () => {
  const states = [];
  const host = {
    hasActiveRun: () => false,
    isApprovalActive: () => false,
    acceptsPromptInput: () => true,
    isHumanActivelyTyping: () => false,
    nudges: 0,
    submitPrompt: () => ({
      taskId: "t",
      runId: "r1",
      kind: "prompt",
      submittedAt: new Date().toISOString(),
    }),
    nudgePromptSubmit() {
      this.nudges += 1;
      return true;
    },
  };
  const controller = new DeliveryController({
    taskId: "stop-interrupt-hygiene-smoke",
    provider: "claude",
    terminalHost: host,
    eventSink: (event) => {
      if (event.type === "delivery:state") {
        states.push(event.payload);
      }
    },
    hasLiveTranscriptSource: () => true,
    bootDeliveryGraceMs: 0,
    enterRetryDelaysMs: [80],
  });
  try {
    controller.enqueue("delivered before the stop");
    await delay(30);
    controller.handleStopRequested({ promptWriteCanceled: false });
    const last = states.at(-1);
    const item = last?.queue.find(() => true);
    assert.equal(item?.status, "delivering", "a delivered-in-flight item keeps its receipt watch");
    await delay(200);
    assert.equal(host.nudges, 0, "but its Enter-retry ladder is still disarmed");
  } finally {
    controller.dispose();
  }
});

async function check(label, fn) {
  try {
    await fn();
    console.log(`ok - ${label}`);
  } catch (error) {
    failures.push({ label, error });
    console.error(`FAIL - ${label}`);
    console.error(error);
  }
}

if (failures.length > 0) {
  process.exit(1);
}
console.log("stop-interrupt-hygiene smoke passed");
