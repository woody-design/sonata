// Layer-2c verification — session-setup approvals leave a forensic trail, AND
// Sonata's Approve on the workspace-trust screen actually grants trust.
//
// The workspace-trust screen fires before any run exists, so its
// approval:detected / approval:decision carry runId=null. Routing them
// through upsertRun(null) silently dropped them — the empty approvalEvents
// in the 148-approval incident report. They must now land in the report's
// unassignedApprovals bucket (mirroring unassignedChanges).
//
// The fake CLI below is the claude 2.1.252 trust dialog (MEASURED —
// spikes/upstream-sync-2026-09/claude/q3-trust-variants.capture.txt; the row
// text and order are the fixture app/tests/fixtures/approval-panels/
// trust-2.1.252.txt, captured off a live 2.1.252 screen). Three measured facts
// make it the regression this file exists to catch:
//
//   1. `❯ No, exit` is the DEFAULT row; `Yes, I trust this folder` is second.
//   2. The rows carry no digits, and a digit is inert.
//   3. Enter on the default row EXITS the CLI (status 1) — as did CSI-u Enter,
//      the encoding Sonata's legacy path used. Either blind key = a user tapping
//      Approve kills their session.
//
// so the fake CLI EXITS on an Enter taken from the decline row, and grants only
// from the affirm one. It also swallows its first keypress, reproducing the
// measured input-ARMING window after the dialog's paint — which is why the
// answer is a verify-and-retry walk and not a fixed `ArrowDown + CR`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { RunIndex, TerminalHost, isRunIndexEvent } = require("../../dist/runtime");

const taskId = "task-approval-trust-trail-smoke";
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-approval-trust-trail-smoke-"));
const scriptPath = path.join(workspace, "fake-claude-trust-cli.mjs");
const reportPath = path.join(workspace, ".sonata", "runtime-report.json");
// The fake CLI's verdict, written where the assertions can read it: `granted`
// only if the confirming Enter arrived while the affirm row held the cursor.
// The verdict path is an argv so the blind-CR control arm below can use its own.
const verdictPath = path.join(workspace, "trust-verdict.txt");
const controlVerdictPath = path.join(workspace, "trust-verdict-control.txt");

fs.writeFileSync(
  scriptPath,
  `
import fs from "node:fs";
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();

const VERDICT = process.argv[2];
// 2.1.252 row order: the DECLINE row is first and default.
const ROWS = ["No, exit", "Yes, I trust this folder"];
let cursor = 0;          // ❯ boots on "No, exit"
let answered = false;
// The measured input-arming window: the first key after the paint is swallowed.
let armed = false;

function paint() {
  let out = "\\u001b[2J\\u001b[H";
  out += "\\n";
  out += " Accessing workspace:\\n\\n";
  out += " /private/tmp/fake-workspace\\n\\n";
  out += " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source\\n";
  out += " project, or work from your team). If not, take a moment to review what's in this folder first.\\n\\n";
  out += " Claude Code'll be able to read, edit, and execute files here.\\n\\n";
  out += " Security guide\\n\\n";
  ROWS.forEach((row, index) => {
    out += (index === cursor ? " \\u276F " : "   ") + row + "\\n";
  });
  out += "\\n Enter to confirm \\u00B7 Esc to cancel\\n";
  process.stdout.write(out);
}
paint();

process.stdin.on("data", (data) => {
  if (answered) {
    return;
  }
  const text = data.toString("utf8");
  if (!armed) {
    // Swallowed, exactly as the real dialog swallows a key sent inside its
    // arming window: no cursor move, no repaint, no answer.
    armed = true;
    return;
  }
  if (text.includes("\\u001b[B")) {
    cursor = (cursor + 1) % ROWS.length;
    paint();
    return;
  }
  if (text.includes("\\u001b[A")) {
    cursor = (cursor - 1 + ROWS.length) % ROWS.length;
    paint();
    return;
  }
  // Digits are inert on this screen (measured) — swallow without moving.
  if (/^[0-9]+$/.test(text)) {
    return;
  }
  if (text.includes("\\r")) {
    answered = true;
    if (cursor === 1) {
      fs.writeFileSync(VERDICT, "granted");
      process.stdout.write("\\u001b[2J\\u001b[HTrusted.\\n\\u276F opus xhigh ~\\n");
      return;
    }
    // Enter on "No, exit" — the real CLI leaves with status 1.
    fs.writeFileSync(VERDICT, "declined-and-exited");
    process.exit(1);
  }
});
`,
  "utf8",
);

const events = [];
const runIndex = new RunIndex({ taskId, reportPath });
const host = new TerminalHost({
  taskId,
  provider: "claude",
  defaultWorkspace: workspace,
  eventSink: (event) => {
    if (event.type === "pty:data" || event.type === "report:updated") {
      return;
    }
    events.push(event);
    // Mirror the controller's consume boundary (OBS S6): file:changed LEFT the
    // run-index allowlist, so only real RunIndex events cross into consume.
    if (isRunIndexEvent(event)) {
      runIndex.consume(event);
    }
  },
  completionQuietMs: 600,
});

try {
  host.startTask({
    approvalBroker: false, // S2: drives the scrape/keys fallback (broker verified in s2b-e2e-verify)
    cwd: workspace,
    command: process.execPath,
    args: [scriptPath, verdictPath],
    approval: "never",
    rows: 24,
    cols: 110,
  });

  const trust = await waitUntil(
    () =>
      events.find(
        (event) => event.type === "approval:detected" && event.payload.kind === "workspace-trust",
      ),
    6000,
    "workspace-trust detection (runId null at session setup)",
  );
  const trustHadNullRun = trust.payload.runId === null;
  const trustApproveEncoding = trust.payload.choices?.find((c) => c.decision === "approve")?.encodedAs;

  await host.sendApprove();
  const decision = await waitUntil(
    () =>
      events.find(
        (event) =>
          event.type === "approval:decision" &&
          event.payload.previousKind === "workspace-trust" &&
          event.payload.decision === "approve",
      ),
    6000,
    "workspace-trust approve decision",
  );
  const decisionEncodedAs = decision.payload.encodedAs;

  // THE regression assertion: the CLI's own verdict. A blind `\r` (or CSI-u
  // Enter) answers the default row and this reads "declined-and-exited".
  const verdict = await waitUntil(
    () => (fs.existsSync(verdictPath) ? fs.readFileSync(verdictPath, "utf8") : null),
    4000,
    "the fake CLI's trust verdict",
  );
  const trustActuallyGranted = verdict === "granted";
  // `pty:exit` — the event terminal-host actually emits. (An earlier `pty:exited`
  // here matched nothing, so this conjunct was unconditionally true: the control
  // arm below is what proves it can go false.)
  const sessionSurvived = !events.some((event) => event.type === "pty:exit");

  // Let the report settle.
  await delay(400);
  const report = runIndex.read();
  const unassigned = report.unassignedApprovals ?? [];
  const detectedInUnassigned = unassigned.some(
    (entry) => entry.action === "detected" && entry.kind === "workspace-trust",
  );
  const decisionInUnassigned = unassigned.some(
    (entry) => entry.action === "decision" && entry.decision === "approve",
  );
  // None of these runId-null approvals should have invented a phantom run.
  const noPhantomRun = report.runs.every(
    (run) => !run.approvalEvents.some((entry) => entry.kind === "workspace-trust"),
  );

  // CONTROL ARM. The grant above only means something if this fake CLI can also
  // say no — i.e. if a blind Enter on this dialog really is fatal, the way it
  // MEASURED fatal at 2.1.252 (both `\r` and CSI-u Enter exited status 1 from
  // the default row). A second session takes exactly the shortcut the fix
  // refuses: two bare CRs, the first spent on the arming window, the second
  // landing on the untouched cursor — i.e. `No, exit`.
  const control = await runBlindCarriageReturnControl();

  const success =
    trustHadNullRun &&
    trustApproveEncoding === "grid-verified Arrow + CR" &&
    decisionEncodedAs === "grid-verified Arrow + CR" &&
    trustActuallyGranted &&
    sessionSurvived &&
    control.blindCarriageReturnDeclined &&
    control.ptyExitObserved &&
    detectedInUnassigned &&
    decisionInUnassigned &&
    noPhantomRun;

  console.log(
    JSON.stringify(
      {
        workspace,
        trustHadNullRun,
        trustApproveEncoding,
        decisionEncodedAs,
        verdict,
        trustActuallyGranted,
        sessionSurvived,
        control,
        detectedInUnassigned,
        decisionInUnassigned,
        noPhantomRun,
        unassignedApprovals: unassigned,
        runCount: report.runs.length,
        success,
      },
      null,
      2,
    ),
  );
  process.exitCode = success ? 0 : 1;
} catch (error) {
  console.log(
    JSON.stringify(
      { workspace, success: false, error: String(error && error.message ? error.message : error) },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  host.dispose();
  fs.rmSync(workspace, { recursive: true, force: true });
}

/** The control arm: drive the SAME fake dialog with bare CRs and confirm it
 *  declines and exits — the outcome the grid-verified walk exists to avoid, and
 *  the proof that this fixture's "granted" verdict discriminates. */
async function runBlindCarriageReturnControl() {
  const controlEvents = [];
  const controlHost = new TerminalHost({
    taskId: `${taskId}-blind-cr-control`,
    provider: "claude",
    defaultWorkspace: workspace,
    eventSink: (event) => {
      if (event.type === "pty:data" || event.type === "report:updated") {
        return;
      }
      controlEvents.push(event);
    },
    completionQuietMs: 600,
  });
  try {
    controlHost.startTask({
      approvalBroker: false,
      cwd: workspace,
      command: process.execPath,
      args: [scriptPath, controlVerdictPath],
      approval: "never",
      rows: 24,
      cols: 110,
    });
    await waitUntil(
      () =>
        controlEvents.find(
          (event) => event.type === "approval:detected" && event.payload.kind === "workspace-trust",
        ),
      6000,
      "control workspace-trust detection",
    );
    controlHost.writeRaw("\r"); // spent on the arming window
    await delay(300);
    controlHost.writeRaw("\r"); // lands on the untouched cursor: "No, exit"
    const verdict = await waitUntil(
      () => (fs.existsSync(controlVerdictPath) ? fs.readFileSync(controlVerdictPath, "utf8") : null),
      4000,
      "control verdict",
    );
    // The blind CR ends the session, so this arm is also where `pty:exit` is
    // OBSERVED firing — which is what keeps the main run's `sessionSurvived`
    // conjunct honest. (It was spelled `pty:exited` once, matched nothing, and
    // was therefore unconditionally true; asserting the event here means the
    // spelling is tested, not just reviewed.)
    await waitUntil(
      () => controlEvents.some((event) => event.type === "pty:exit"),
      4000,
      "control pty:exit",
    );
    return {
      verdict,
      blindCarriageReturnDeclined: verdict === "declined-and-exited",
      ptyExitObserved: true,
    };
  } catch (error) {
    return {
      verdict: null,
      blindCarriageReturnDeclined: false,
      ptyExitObserved: false,
      error: String(error && error.message ? error.message : error),
    };
  } finally {
    controlHost.dispose();
  }
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) {
      return value;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
