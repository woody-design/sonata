import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// Stop over a LIVE approval panel must settle the approval (ask-flows S1 / B1).
//
// `stopRun()` writes ESC, which the CLI reads as a DENY while a native panel
// owns the screen — but the path used to clear nothing: `approvalActive` stayed
// true with no clearer reachable from a stop, and the scrape's
// SCRAPE_APPROVAL_KEY in DeliveryController.pendingApprovalKeys is released ONLY
// by an `approval:decision`. Two independent gates then read closed forever and
// every later send sat "Queued" until the user typed in the Terminal.
//
// Driven through the REAL scrape path (real PTY, real grid, real delivery
// controller) so the assertions are about the shipped detector, not a stub:
//   1. a live panel closes the delivery gate      (canDeliver() === false)
//   2. stopRun emits ONE approval:decision — deny / Esc / previousKind / the
//      STOPPED run's id (not null: finishActiveRun runs after it)
//   3. isApprovalActive() flips false and canDeliver() === true, and it holds
//      past the 1.2s approval settle window
//   4. the one-shot Esc RETRY (noteToolActivityAfterStop), which can land on a
//      FRESH panel, settles that one the same way
//   5. submitPrompt stops throwing and a freshly queued item reaches the CLI
//   6. exactly TWO bare Escs on the wire — the stop's and the retry's, each
//      accounted for; the fix adds none (an Esc PAIR ≤700ms apart is the
//      documented Rewind-panel opener)
//
// The delivery gate is only meaningful once the BOOT LATCH is open, and the
// latch opens inside pump() — so the first prompt is enqueued through the
// controller (not submitted on the host) and the fake echoes it back, which
// earns the pty-composer-echo receipt and clears `inFlight`. From there the
// approval is the ONLY thing canDeliver() can be blocked on, which is what makes
// the false→true swing diagnostic.
//
// Fixture bytes:
//  - the approval panel frame is ADAPTED from tests/smoke/submit-approval-guard.mjs
//    (claude file-edit panel, legacy hint grammar — "Allow this edit?" avoids the
//    v2 "do you want to" anchor, so the shared detector takes the hint-fallback
//    path and sets approvalActive).
//  - the idle-composer, echo and activity frames are COMPOSED: the minimum bytes
//    that satisfy detectIdlePrompt's ordering rule (`❯` after any panel/activity
//    text, "? for shortcuts" as the idle footer) and the claude activityHints
//    vocabulary. They are not a captured layout.
const require = createRequire(import.meta.url);
const { DeliveryController, TerminalHost } = require("../../dist/runtime");

const taskId = "task-stop-over-approval-smoke";
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-stop-over-approval-"));
const scriptPath = path.join(workspace, "fake-approval-cli.mjs");
const inputLogPath = path.join(workspace, "stdin.log");
const promptText = "Please edit stop-over-approval.txt";
// Typed into the Terminal (writeUserInput) to make the fake ask AGAIN without
// starting a run — `noteToolActivityAfterStop` refuses while one is active.
const retryTrigger = "ASK-AGAIN";
const queuedText = "This send must flow once the stop settles the panel.";

fs.writeFileSync(
  scriptPath,
  `
import fs from "node:fs";

const inputLogPath = ${JSON.stringify(inputLogPath)};
const promptNeedle = ${JSON.stringify(promptText)};
const retryNeedle = ${JSON.stringify(retryTrigger)};
// A BARE Esc — the stop's interrupt. Every other byte Sonata writes that starts
// with \\x1b is a CSI sequence (bracketed paste, CSI-u Enter, arrows), so the
// negative lookahead is what tells the interrupt from ordinary keys.
const bareEsc = /\\u001b(?![[O])/;

process.stdin.setEncoding("utf8");
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();

// Boot: an idle composer, so the boot latch opens.
process.stdout.write("❯ \\n? for shortcuts\\n");

let seen = "";
let panelUp = false;
let asked = 0;
process.stdin.on("data", (data) => {
  fs.appendFileSync(inputLogPath, data);
  seen += data;
  if (panelUp && bareEsc.test(data)) {
    panelUp = false;
    // The deny lands and the TUI repaints PAST the panel. Clearing the screen is
    // what makes the grid honestly panel-free, so the settle re-check has
    // nothing to resurface.
    process.stdout.write("\\u001b[2J\\u001b[H❯ \\n? for shortcuts\\n");
    return;
  }
  if (asked === 0 && seen.includes(promptNeedle)) {
    asked = 1;
    panelUp = true;
    // Echo the prompt into the composer (earns the pty-composer-echo receipt),
    // then work, then ask. Painted in one turn so the run's raw never reads as
    // an idle composer in between.
    process.stdout.write(promptNeedle + "\\n");
    process.stdout.write("✻ Cerebrating… (esc to interrupt)\\n");
    process.stdout.write("\\nAllow this edit?\\n");
    process.stdout.write("- stop-over-approval.txt\\n");
    process.stdout.write("Enter to confirm\\n");
    return;
  }
  if (asked === 1 && seen.includes(retryNeedle)) {
    asked = 2;
    panelUp = true;
    // The stop's Esc was swallowed: the turn lived and the next tool asks. A
    // DIFFERENT path, so a different fingerprint — this surfaces as a fresh ask
    // rather than a resurface, with no timing coupling to the settle window.
    process.stdout.write("\\u001b[2J\\u001b[H");
    process.stdout.write("✻ Cerebrating… (esc to interrupt)\\n");
    process.stdout.write("\\nAllow this edit?\\n");
    process.stdout.write("- stop-over-approval-again.txt\\n");
    process.stdout.write("Enter to confirm\\n");
  }
});
`,
  "utf8",
);

const events = [];
const host = new TerminalHost({
  taskId,
  provider: "claude",
  defaultWorkspace: workspace,
  eventSink: (event) => {
    if (event.type !== "pty:data" && event.type !== "report:updated") {
      events.push(event);
    }
    // Everything the controller sees in production, pty:data included (its
    // echo-receipt feed): the gate must open on the real event stream.
    delivery.handleRuntimeEvent(event);
  },
});
const delivery = new DeliveryController({
  taskId,
  provider: "claude",
  terminalHost: host,
  eventSink: () => {},
  hasLiveTranscriptSource: () => false,
  pumpRetryIntervalMs: 50,
  // This fence asserts the gate, not the boot Enter-swallow grace or the heal
  // ladder — both have their own fences (delivery-enter-retry.mjs).
  bootDeliveryGraceMs: 0,
  enterRetryDelaysMs: [],
});

const failures = [];
const check = (label, condition, detail) => {
  if (!condition) {
    failures.push(detail === undefined ? label : `${label} — ${detail}`);
  }
};

let observed = {};

try {
  host.startTask({
    cwd: workspace,
    command: process.execPath,
    args: [scriptPath],
    rows: 16,
    cols: 100,
  });

  await waitUntil(() => host.acceptsPromptInput(), 5000, "idle composer");
  delivery.enqueue(promptText);
  await waitUntil(
    () => events.some((event) => event.type === "run:started"),
    5000,
    "the first prompt starting a run",
  );
  const runId = events.find((event) => event.type === "run:started")?.payload.id ?? null;

  await waitUntil(
    () => events.some((event) => event.type === "approval:detected"),
    5000,
    "approval detection",
  );
  const detected = events.find((event) => event.type === "approval:detected");
  await waitUntil(
    () => delivery.state().queue.length === 0,
    5000,
    "the first prompt's echo receipt (clears inFlight)",
  );

  // --- 1. the live panel holds the delivery gate ----------------------------
  const gateClosed = delivery.state().deliverable;
  check("panel sets approvalActive", host.isApprovalActive() === true);
  check(
    "panel is attributed to the run",
    detected.payload.runId === runId,
    `runId=${detected.payload.runId} run=${runId}`,
  );
  check("panel kind is file-edit", detected.payload.kind === "file-edit", `kind=${detected.payload.kind}`);
  check("canDeliver() is false under a live panel", gateClosed === false);

  // --- 2. the stop settles it as a deny -------------------------------------
  // The /stop inspection is codex-only (claude has supportsSlashStop false); the
  // long delay keeps its timer out of this fence's window regardless.
  await host.stopRun({ inspectDelayMs: 60_000 });

  const decisions = events.filter((event) => event.type === "approval:decision");
  const decision = decisions[0];
  check("exactly one approval:decision", decisions.length === 1, `count=${decisions.length}`);
  check("decision is deny", decision?.payload.decision === "deny", `decision=${decision?.payload.decision}`);
  check(
    "decision encodedAs Esc",
    decision?.payload.encodedAs === "Esc",
    `encodedAs=${decision?.payload.encodedAs}`,
  );
  check(
    "decision carries previousKind",
    decision?.payload.previousKind === "file-edit",
    `previousKind=${decision?.payload.previousKind}`,
  );
  // The runId lesson (runtime-controller `abortPendingBrokerApprovals`): the id
  // must be captured BEFORE finishActiveRun nulls the pointer, or the decision
  // lands unassigned beside a run-attributed `approval:detected`.
  check(
    "decision carries the stopped run's id",
    decision?.payload.runId === runId,
    `runId=${decision?.payload.runId} stopped=${runId}`,
  );
  // `run:stopped` must land LAST so the surface reads "Stopped" — the honest
  // reason the run is over — rather than the decision's "Approval denied".
  const decisionIndex = events.indexOf(decision);
  const stoppedIndex = events.findIndex((event) => event.type === "run:stopped");
  check(
    "decision is emitted before run:stopped",
    decisionIndex >= 0 && stoppedIndex > decisionIndex,
    `decision=${decisionIndex} stopped=${stoppedIndex}`,
  );

  // --- 3. the gate reopens --------------------------------------------------
  check("isApprovalActive() is false after the stop", host.isApprovalActive() === false);
  const gateOpen = delivery.state().deliverable;
  check("canDeliver() is true after the stop", gateOpen === true);

  // --- 4. and it holds past the 1.2s settle window --------------------------
  await delay(1500);
  check(
    "no approval resurfaced past the settle window",
    events.filter((event) => event.type === "approval:detected").length === 1,
  );
  check("still not approvalActive past the settle window", host.isApprovalActive() === false);
  check(
    "still exactly one decision past the settle window",
    events.filter((event) => event.type === "approval:decision").length === 1,
  );

  // --- 5. the one-shot Esc RETRY over a fresh panel settles the same way ----
  // The stop's Esc was swallowed, the turn lived, and the next tool asks —
  // `noteToolActivityAfterStop` then resends the Esc into a LIVE panel. Its
  // `activeRun` guard does not exclude this: `surfaceApproval` sets the flag
  // with no run open. The 1500ms above also clears STOP_ESC_RETRY_MIN_MS.
  host.writeUserInput(retryTrigger);
  await waitUntil(
    () => events.filter((event) => event.type === "approval:detected").length === 2,
    5000,
    "the second approval panel",
  );
  check("the fresh panel re-closes the gate", delivery.state().deliverable === false);
  host.noteToolActivityAfterStop();
  const retryDecision = events.filter((event) => event.type === "approval:decision")[1];
  check("the Esc retry emits its own decision", retryDecision !== undefined);
  check(
    "retry decision is deny/Esc",
    retryDecision?.payload.decision === "deny" && retryDecision?.payload.encodedAs === "Esc",
    `decision=${retryDecision?.payload.decision} encodedAs=${retryDecision?.payload.encodedAs}`,
  );
  check(
    "retry decision carries previousKind and the stopped run's id",
    retryDecision?.payload.previousKind === "file-edit" && retryDecision?.payload.runId === runId,
    `previousKind=${retryDecision?.payload.previousKind} runId=${retryDecision?.payload.runId}`,
  );
  check("the retry clears approvalActive", host.isApprovalActive() === false);
  const gateOpenAfterRetry = delivery.state().deliverable;
  check("canDeliver() is true after the retry", gateOpenAfterRetry === true);

  // --- 6. submitPrompt stops refusing, and a queued send flows --------------
  let submitThrew = "";
  try {
    host.submitPrompt("A send the approval guard used to refuse.");
  } catch (error) {
    submitThrew = error instanceof Error ? error.message : String(error);
  }
  check("submitPrompt no longer throws the approval guard", submitThrew === "", submitThrew);

  delivery.enqueue(queuedText);
  await waitUntil(() => readLog().includes(queuedText), 5000, "the queued send reaching the CLI");

  // --- 7. exactly TWO bare Escs: the stop's and the retry's, no more --------
  await delay(500);
  // A BARE Esc — the same needle the fake watches for. Built from a string so
  // the control byte is never a literal in this source file.
  const bareEscapes = readLog().match(new RegExp("\\u001b(?![[O])", "g")) ?? [];
  check("exactly two bare Escs on the wire", bareEscapes.length === 2, `count=${bareEscapes.length}`);
  check(
    "exactly two decisions in total",
    events.filter((event) => event.type === "approval:decision").length === 2,
  );

  observed = {
    runId,
    detectedRunId: detected.payload.runId,
    detectedKind: detected.payload.kind,
    deliverableUnderPanel: gateClosed,
    decisions: events
      .filter((event) => event.type === "approval:decision")
      .map((event) => ({
        decision: event.payload.decision,
        encodedAs: event.payload.encodedAs,
        previousKind: event.payload.previousKind,
        runId: event.payload.runId,
      })),
    approvalActiveAfterStop: host.isApprovalActive(),
    deliverableAfterStop: gateOpen,
    deliverableAfterRetry: gateOpenAfterRetry,
    submitThrew,
    bareEscCount: bareEscapes.length,
    eventTypes: events.map((event) => event.type),
  };
} catch (error) {
  failures.push(`threw: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  const success = failures.length === 0;
  console.log(JSON.stringify({ workspace, ...observed, failures, success }, null, 2));
  process.exitCode = success ? 0 : 1;
  delivery.dispose();
  host.dispose();
  await delay(250);
  fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function readLog() {
  return fs.existsSync(inputLogPath) ? fs.readFileSync(inputLogPath, "utf8") : "";
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
