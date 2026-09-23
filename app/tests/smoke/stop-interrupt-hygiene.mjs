import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Fences the stop → edit → resend fixes (2026-07-17,
// spikes/stop-restore-probe): Esc-interrupt restores the interrupted prompt
// into the CLI's own input box (claude 2.1.212 + codex 0.144.5), and
// submitPrompt's deferred text/Enter timers could fire AFTER a stop —
// starting the very turn the user stopped. Fenced here:
//   1. stopRun cancels pending deferred PROMPT writes (no post-stop paste).
//   2. Sonata sends no bytes the user did not write (X2 fix round, ruling 2):
//      no Ctrl+U kill-line flood after a stop or ahead of the next send — an
//      Esc-restored prompt stays in the CLI composer for the user, exactly as
//      at a terminal. (Replaces the belt/prefix-flood fences of 2026-07-17.)
//   3. The one-shot Esc resend fires ONLY on post-stop tool evidence inside
//      [1200ms, 45s], never at idle, never into a new run (a blind repeat
//      opens Claude's rewind menu / prefills Codex's edit-previous buffer),
//      and carries the stopped run's id for the durable report. The lower bound
//      was 800ms until the 2026-08-03 upstream sync measured claude 2.1.220's
//      Esc-pair rewind window as (700, 800] — see the boundary case below.
// Runs begin only on the CLI's own UserPromptSubmit (X2 fix round, ruling 1),
// so every case that needs a live run simulates that hook (COMPOSED) with
// `beginRunFromHook` right after the send. Fake pty, no real CLI.
const require = createRequire(import.meta.url);
const { TerminalHost, ESC, CSI_U_ENTER } = require("../../dist/runtime");

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
const KILL_LINE = String.fromCharCode(0x15);
const hasKillLine = (writes) => writes.some((write) => write.includes(KILL_LINE));
/** Send, then the CLI's own UserPromptSubmit (COMPOSED) — what begins a run. */
function sendAndStart(host, text) {
  host.submitPrompt(text);
  host.beginRunFromHook(text);
}
const hasPaste = (writes) => writes.some((write) => write.includes(PASTE_START));
const hasEnter = (writes) => writes.some((write) => write.includes(CSI_U_ENTER));

await check("stopRun cancels the deferred text/Enter writes of a just-sent prompt", async () => {
  const writes = [];
  const host = makeHost();
  try {
    host.ptyProcess = fakePty(writes);
    host.submitPrompt("stop me before I start");
    // Deferred text (0ms) / Enter (120ms) timers are pending — stop NOW.
    await host.stopRun({ inspectDelayMs: 500 });
    await delay(300);
    assert.ok(!hasPaste(writes), "the canceled paste must never reach the pty");
    assert.ok(!hasEnter(writes), "the canceled Enter must never reach the pty");
    assert.ok(writes.some(isEsc), "the interrupt Esc still goes out");
  } finally {
    host.dispose();
  }
});

await check("no kill-line bytes: not after a stop, not ahead of the next send", async () => {
  const writes = [];
  const host = makeHost();
  try {
    host.ptyProcess = fakePty(writes);
    sendAndStart(host, "line one\nline two\nline three");
    await delay(250);
    await host.stopRun({ inspectDelayMs: 500 });
    await delay(1_200); // past where the retired 900ms belt used to fire
    sendAndStart(host, "sent after the stop");
    await delay(250);
    assert.ok(!hasKillLine(writes), "Sonata wrote no Ctrl+U anywhere");
    const last = writes.filter((write) => write.includes(PASTE_START)).at(-1) ?? "";
    assert.equal(last, `${PASTE_START}sent after the stop\x1b[201~`, "the next send is only the user's paste");
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
    sendAndStart(host, "runaway turn");
    const stoppedRunId = host.activeRun?.id ?? null;
    assert.ok(stoppedRunId, "precondition: the send began a run");
    await delay(250);
    await host.stopRun({ inspectDelayMs: 500 });
    const escsAfterStop = () => writes.filter(isEsc).length;
    const baseline = escsAfterStop();

    host.noteToolActivityAfterStop(); // too early (~0ms) — the in-flight hook race
    assert.equal(escsAfterStop(), baseline, "evidence inside the lower bound must not retry");

    // The lower bound's SECOND job (upstream sync 2026-08-03): stopRun's Esc plus
    // this retry Esc are the only pair a claude path can emit, and since claude
    // 2.1.216 an Esc pair at an idle composer opens the Rewind restore picker.
    // Measured live at 2.1.220 (spikes/upstream-sync-2026-08/claude/q3c-esc-window
    // captures): the pair fires at gaps ≤700ms and not at ≥800ms. 800 is therefore
    // INSIDE the interval the threshold lives in — and `elapsed < MIN` means the
    // old MIN of 800 fired at exactly 800. Reverting STOP_ESC_RETRY_MIN_MS to 800
    // fails here, which is the point of pinning the boundary rather than a
    // comfortable value.
    host.stopEscRetry.requestedAt = Date.now() - 800;
    host.noteToolActivityAfterStop();
    assert.equal(
      escsAfterStop(),
      baseline,
      "an 800ms gap is inside the measured rewind-pair window — it must NOT retry",
    );

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
    sendAndStart(host, "first turn");
    await delay(250);
    await host.stopRun({ inspectDelayMs: 500 });
    sendAndStart(host, "second turn"); // supersedes the stop
    await delay(250);
    const baseline = writes.filter(isEsc).length;
    assert.equal(host.stopEscRetry, null, "a new send disarms the armed retry");
    host.noteToolActivityAfterStop();
    assert.equal(writes.filter(isEsc).length, baseline, "no Esc into the new turn");
  } finally {
    host.dispose();
  }
});

await check("codex /stop inspection stands down when a NEW run started (stop→edit→resend)", async () => {
  const writes = [];
  const host = new TerminalHost({
    taskId: "stop-interrupt-hygiene-smoke",
    provider: "codex",
    defaultWorkspace: process.cwd(),
    eventSink: () => {},
  });
  try {
    host.ptyProcess = fakePty(writes);
    sendAndStart(host, "codex turn to stop");
    await delay(250);
    await host.stopRun({ inspectDelayMs: 300, forceSlashStop: true });
    sendAndStart(host, "corrected turn sent before the inspection"); // the S2 happy path
    await delay(700);
    assert.ok(
      !writes.some((write) => write.includes("/stop")),
      "the deferred /stop must not kill the corrected turn (S2 review F1)",
    );
  } finally {
    host.dispose();
  }
});

await check("codex /stop inspection still runs when nothing new started", async () => {
  const writes = [];
  const host = new TerminalHost({
    taskId: "stop-interrupt-hygiene-smoke",
    provider: "codex",
    defaultWorkspace: process.cwd(),
    eventSink: () => {},
  });
  try {
    host.ptyProcess = fakePty(writes);
    sendAndStart(host, "codex turn to stop");
    await delay(250);
    await host.stopRun({ inspectDelayMs: 300, forceSlashStop: true });
    await delay(700);
    assert.ok(
      writes.some((write) => write.includes("/stop")),
      "with no new run the cleanup /stop still goes out",
    );
  } finally {
    host.dispose();
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
