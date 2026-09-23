import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// Stop over a LIVE approval panel must settle the approval (ask-flows S1 / B1).
//
// `stopRun()` writes ESC, which the CLI reads as a DENY while a native panel
// owns the screen — but the path used to clear nothing: `approvalActive` stayed
// true with no clearer reachable from a stop, and the scraped ask never earned
// its `approval:decision` (before X2 that also held every later send "Queued"
// behind the since-deleted delivery gate until the user typed in the Terminal).
//
// Driven through the REAL scrape path (real PTY, real grid) so the assertions
// are about the shipped detector, not a stub. Two phases, because a stop over a
// panel has two materially different shapes:
//
//   PHASE 1 — a stop followed at once by a send (the original bug report's
//     shape). The send must find the stop's `cliInputMaybeDirty` already set,
//     or the pre-submit kill-line flood is skipped and the paste concatenates
//     onto the prompt Esc restored into the composer. And the send legitimately
//     disarms the stop's one-shot Esc retry — asserted behaviourally.
//
//   PHASE 2 — a stop with nothing sent after it, which leaves that Esc retry
//     armed. A fresh panel then surfaces and `noteToolActivityAfterStop`
//     resends the Esc into it — the second site the same settlement is wired at.
//
// Fixture bytes:
//  - the approval panel frames are ADAPTED from the since-deleted
//    tests/smoke/submit-approval-guard.mjs
//    (claude file-edit panel, legacy hint grammar — "Allow this edit?" avoids the
//    v2 "do you want to" anchor, so the shared detector takes the hint-fallback
//    path and sets approvalActive). One distinct filename per panel so each
//    surfaces on its own fingerprint rather than as a timing-coupled resurface.
//  - the idle-composer, echo and activity frames are COMPOSED: the minimum bytes
//    that satisfy detectIdlePrompt's ordering rule (`❯` after any panel/activity
//    text, "? for shortcuts" as the idle footer) and the claude activityHints
//    vocabulary. They are not a captured layout.
const require = createRequire(import.meta.url);
const { TerminalHost } = require("../../dist/runtime");

// Mirrors of terminal-host constants the byte-ordering assertion reads. Built
// from char codes so no control byte is a literal in this source file.
const KILL_LINE = String.fromCharCode(0x15);
const CLI_INPUT_CLEAR_MIN_KILLS = 40;
const BARE_ESC = "\\u001b(?![[O])";

const taskId = "task-stop-over-approval-smoke";
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-stop-over-approval-"));
const scriptPath = path.join(workspace, "fake-approval-cli.mjs");
const inputLogPath = path.join(workspace, "stdin.log");
const promptText = "Please edit stop-over-approval.txt";
const heldText = "A send right after the stop.";
// Typed into the Terminal (writeUserInput) to make the fake ask again without
// starting a run — `noteToolActivityAfterStop` refuses while one is active.
const panelBTrigger = "ASK-B";
const panelCTrigger = "ASK-C";
const finalText = "And sends keep reaching the CLI afterwards.";

fs.writeFileSync(
  scriptPath,
  `
import fs from "node:fs";

const inputLogPath = ${JSON.stringify(inputLogPath)};
const promptNeedle = ${JSON.stringify(promptText)};
const triggers = [${JSON.stringify(panelBTrigger)}, ${JSON.stringify(panelCTrigger)}];
// A BARE Esc — the stop's interrupt. Every other byte Sonata writes that starts
// with \\x1b is a CSI sequence (bracketed paste, CSI-u Enter, arrows), so the
// negative lookahead is what tells the interrupt from ordinary keys.
const bareEsc = /${BARE_ESC}/;

process.stdin.setEncoding("utf8");
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();

// Boot: an idle composer, so the boot latch opens.
process.stdout.write("❯ \\n? for shortcuts\\n");

function paintPanel(file) {
  process.stdout.write("✻ Cerebrating… (esc to interrupt)\\n");
  process.stdout.write("\\nAllow this edit?\\n");
  process.stdout.write("- " + file + "\\n");
  process.stdout.write("Enter to confirm\\n");
}

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
    // Echo the prompt into the composer, then work, then ask. Painted in one turn so the run's raw never reads as
    // an idle composer in between.
    process.stdout.write(promptNeedle + "\\n");
    paintPanel("stop-over-approval.txt");
    return;
  }
  const nextTrigger = triggers[asked - 1];
  if (asked >= 1 && nextTrigger && seen.includes(nextTrigger)) {
    asked += 1;
    panelUp = true;
    process.stdout.write("\\u001b[2J\\u001b[H");
    paintPanel("stop-over-approval-" + nextTrigger + ".txt");
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
  },
});

const failures = [];
const check = (label, condition, detail) => {
  if (!condition) {
    failures.push(detail === undefined ? label : `${label} — ${detail}`);
  }
};
const decisionsSoFar = () => events.filter((event) => event.type === "approval:decision");
const detectionsSoFar = () => events.filter((event) => event.type === "approval:detected");
const bareEscCount = () => (readLog().match(new RegExp(BARE_ESC, "g")) ?? []).length;

let observed = {};

try {
  host.startTask({
    cwd: workspace,
    command: process.execPath,
    args: [scriptPath],
    rows: 16,
    cols: 100,
  });

  // === PHASE 0: boot, one run, one panel ===================================
  await waitUntil(() => host.acceptsPromptInput(), 5000, "idle composer");
  host.submitPrompt(promptText);
  await waitUntil(
    () => events.some((event) => event.type === "run:started"),
    5000,
    "the first prompt starting a run",
  );
  const runId = events.find((event) => event.type === "run:started")?.payload.id ?? null;
  await waitUntil(() => detectionsSoFar().length === 1, 5000, "approval detection");
  const detected = detectionsSoFar()[0];
  check("panel sets approvalActive", host.isApprovalActive() === true);
  check(
    "panel is attributed to the run",
    detected.payload.runId === runId,
    `runId=${detected.payload.runId} run=${runId}`,
  );
  check("panel kind is file-edit", detected.payload.kind === "file-edit", `kind=${detected.payload.kind}`);

  // === PHASE 1: a stop, then a send at once =================================
  await delay(250);
  const logBeforeStop = readLog();

  // The /stop inspection is codex-only (claude has supportsSlashStop false); the
  // long delay keeps its timer out of this fence's window regardless.
  await host.stopRun({ inspectDelayMs: 60_000 });

  const decision = decisionsSoFar()[0];
  check("exactly one approval:decision", decisionsSoFar().length === 1, `count=${decisionsSoFar().length}`);
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
  check("isApprovalActive() is false after the stop", host.isApprovalActive() === false);

  // A send right after the stop — its bytes are ORDERED behind the stop's own
  // composer hygiene. A missing flood means the send did not see
  // `cliInputMaybeDirty`: the Esc-restored prompt would then be concatenated
  // with this paste (review 1).
  host.submitPrompt(heldText);
  await waitUntil(() => readLog().includes(heldText), 5000, "the send reaching the CLI");
  const logAfterStop = readLog();
  const heldPasteAt = logAfterStop.indexOf(heldText);
  const preSubmitWindow = logAfterStop.slice(logBeforeStop.length, heldPasteAt);
  const floodBeforePaste = new RegExp(`${KILL_LINE}{${CLI_INPUT_CLEAR_MIN_KILLS},}`).test(preSubmitWindow);
  check(
    "the pre-submit kill-line flood precedes the send's paste",
    floodBeforePaste,
    `window=${JSON.stringify(preSubmitWindow.slice(0, 120))}`,
  );

  // The send legitimately disarms the stop's one-shot Esc retry — an Esc now
  // would kill the turn that send is starting. Asserted behaviourally: the retry
  // must be a no-op here. (This is also why PHASE 2 needs its own stop with no
  // send after it to exercise the retry at all.)
  const escsAfterPhase1 = bareEscCount();
  check("exactly one bare Esc after phase 1", escsAfterPhase1 === 1, `count=${escsAfterPhase1}`);
  await delay(1500); // clear STOP_ESC_RETRY_MIN_MS so only the disarm can explain a no-op
  host.noteToolActivityAfterStop();
  await delay(100);
  check(
    "the send disarmed the stop's Esc retry (no resend)",
    bareEscCount() === 1 && decisionsSoFar().length === 1,
    `escs=${bareEscCount()} decisions=${decisionsSoFar().length}`,
  );
  check(
    "no approval resurfaced past the settle window",
    detectionsSoFar().length === 1,
    `count=${detectionsSoFar().length}`,
  );
  check("still not approvalActive past the settle window", host.isApprovalActive() === false);

  // === PHASE 2: a stop with nothing sent after it leaves the retry armed ====
  host.writeUserInput(panelBTrigger);
  await waitUntil(() => detectionsSoFar().length === 2, 5000, "the second approval panel");
  check("the fresh panel sets approvalActive", host.isApprovalActive() === true);

  await host.stopRun({ inspectDelayMs: 60_000 });
  check("the second stop settles its panel too", decisionsSoFar().length === 2, `count=${decisionsSoFar().length}`);
  check("isApprovalActive() is false after the second stop", host.isApprovalActive() === false);

  // A third panel, then the one-shot Esc resend lands on it. The `activeRun`
  // guard does not exclude this: `surfaceApproval` sets the flag with no run
  // open. The 1500ms wait clears STOP_ESC_RETRY_MIN_MS.
  await delay(1500);
  host.writeUserInput(panelCTrigger);
  await waitUntil(() => detectionsSoFar().length === 3, 5000, "the third approval panel");
  check("the third panel sets approvalActive", host.isApprovalActive() === true);
  host.noteToolActivityAfterStop();
  const retryDecision = decisionsSoFar()[2];
  check("the Esc retry emits its own decision", retryDecision !== undefined);
  check(
    "retry decision is deny/Esc",
    retryDecision?.payload.decision === "deny" && retryDecision?.payload.encodedAs === "Esc",
    `decision=${retryDecision?.payload.decision} encodedAs=${retryDecision?.payload.encodedAs}`,
  );
  check(
    "retry decision carries previousKind",
    retryDecision?.payload.previousKind === "file-edit",
    `previousKind=${retryDecision?.payload.previousKind}`,
  );
  check("the retry clears approvalActive", host.isApprovalActive() === false);

  // === PHASE 3: sends keep reaching the CLI ===============================
  host.submitPrompt(finalText);
  await waitUntil(() => readLog().includes(finalText), 5000, "the final send reaching the CLI");

  // Three bare Escs total: two stops and one retry, each accounted for. The fix
  // adds none — an Esc PAIR ≤700ms apart is the documented Rewind-panel opener.
  await delay(500);
  const totalEscs = bareEscCount();
  check("exactly three bare Escs on the wire", totalEscs === 3, `count=${totalEscs}`);
  check("exactly three decisions in total", decisionsSoFar().length === 3, `count=${decisionsSoFar().length}`);

  observed = {
    runId,
    detectedRunId: detected.payload.runId,
    detectedKind: detected.payload.kind,
    preSubmitFloodBeforeSendPaste: floodBeforePaste,
    decisions: decisionsSoFar().map((event) => ({
      decision: event.payload.decision,
      encodedAs: event.payload.encodedAs,
      previousKind: event.payload.previousKind,
      runId: event.payload.runId,
    })),
    approvalActiveAtEnd: host.isApprovalActive(),
    bareEscCount: totalEscs,
    eventTypes: events.map((event) => event.type),
  };
} catch (error) {
  failures.push(`threw: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  const success = failures.length === 0;
  console.log(JSON.stringify({ workspace, ...observed, failures, success }, null, 2));
  process.exitCode = success ? 0 : 1;
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
