// Layer-2 smoke — the post-decision settle window (S4 defense-in-depth for
// the fresh-workspace trust wedge, s3-diags/trust-wedge-gui-diag).
//
// The wedge: a panel repaint lands milliseconds after the answer. Repaints
// hash to a NEW fingerprint (the fingerprint slice is a line WINDOW — even a
// byte-identical repaint shifts it), so fingerprint dedupe misses, a phantom
// `approval:detected` re-arms `approvalPending`, and no decision ever comes —
// an invisible permanent delivery hold.
//
// Scenario A (suppression): panel → approve → identical repaint 10ms later →
//   composer. EXACTLY ONE approval:detected; the phantom is swallowed.
// Scenario B (honesty backstop): panel → approve → repaint → the panel is
//   GENUINELY still there and never yields to a prompt. The settle re-check
//   (re-armed while bytes still flow) resurfaces it as resurfacedAfterDecision
//   — suppression can delay a real ask by ~a settle window, never eat it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TerminalHost } = require("../../dist/runtime");

const failures = [];
const assert = (cond, label) => {
  if (!cond) failures.push(label);
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`timeout: ${label}`);
}

const PANEL_PAINT = `
process.stdout.write("\\n");
process.stdout.write("Accessing workspace:\\n\\n");
process.stdout.write("/private/tmp/fake-workspace\\n\\n");
process.stdout.write("Quick safety check: Is this a project you created or one you trust?\\n\\n");
process.stdout.write("Claude Code'll be able to read, edit, and execute files here.\\n\\n");
process.stdout.write("\\u276F1.Yes, I trust this folder\\n\\n");
process.stdout.write("2.No, exit\\n\\n");
process.stdout.write("Enter to confirm \\u00B7 Esc to cancel\\n");
`;

/** Fake claude: trust panel at startup; on CR, either a phantom repaint then
 *  a composer prompt (scenario A — truly answered), a phantom then another
 *  full panel and silence (scenario B — the answer did not take), or a
 *  prompt FIRST then a full panel repaint (scenario C — the native-answer
 *  path records a decision from the prompt-after evidence, THEN the panel
 *  comes back inside the settle window). */
function fakeCliScript(scenario) {
  const onAnswer =
    scenario === "answered"
      ? `setTimeout(paintPanel, 10); // the phantom repaint (the wedge trigger)
  setTimeout(() => process.stdout.write("\\nTrusted.\\n\\u276F opus xhigh ~\\n"), 500);`
      : scenario === "still-open"
        ? `setTimeout(paintPanel, 10);
  setTimeout(paintPanel, 600); // still unanswered; never a prompt`
        : `setTimeout(() => process.stdout.write("\\nTrusted.\\n\\u276F opus xhigh ~\\n"), 50);
  setTimeout(paintPanel, 400); // back inside the settle window, after the decision`;
  return `
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
let answered = false;
const paintPanel = () => {${PANEL_PAINT}};
paintPanel();
process.stdin.on("data", (data) => {
  if (answered || !data.toString("utf8").includes("\\r")) {
    return;
  }
  answered = true;
  ${onAnswer}
});
setInterval(() => {}, 1000);
`;
}

async function runScenario(name, scenario) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `sonata-resurface-${scenario}-`));
  const scriptPath = path.join(workspace, "fake-claude.mjs");
  fs.writeFileSync(scriptPath, fakeCliScript(scenario), "utf8");

  const events = [];
  const host = new TerminalHost({
    taskId: `task-resurface-${scenario}`,
    provider: "claude",
    defaultWorkspace: workspace,
    eventSink: (event) => {
      if (event.type === "approval:detected" || event.type === "approval:decision") {
        events.push(event);
      }
    },
    completionQuietMs: 600,
  });

  try {
    host.startTask({
      approvalBroker: false, // scrape/keys fallback — the path the wedge lives on
      cwd: workspace,
      command: process.execPath,
      args: [scriptPath],
      approval: "never",
      rows: 24,
      cols: 110,
    });

    await waitUntil(
      () => events.some((e) => e.type === "approval:detected"),
      6000,
      `${name}: initial trust detection`,
    );
    if (scenario === "native-still-open") {
      // The HUMAN answers in the terminal: the decision is recorded from
      // screen evidence (answered-natively) — the one decision path that
      // never armed a settle check of its own (review P2).
      host.writeUserInput("\r");
      await waitUntil(
        () =>
          events.some(
            (e) => e.type === "approval:decision" && e.payload.decision === "answered-natively",
          ),
        8000,
        `${name}: answered-natively decision from screen evidence`,
      );
    } else {
      host.sendApprove();
      await waitUntil(
        () => events.some((e) => e.type === "approval:decision"),
        6000,
        `${name}: approve decision`,
      );
    }

    if (scenario === "answered") {
      // Past the phantom (+10ms), the composer (+500ms), and both settle
      // re-checks (+1.2s/+2.4s): the phantom must have been swallowed.
      await delay(3600);
      const detected = events.filter((e) => e.type === "approval:detected");
      assert(detected.length === 1, `${name}: phantom repaint suppressed (got ${detected.length})`);
      assert(
        events.filter((e) => e.type === "approval:decision").length === 1,
        `${name}: single decision`,
      );
    } else {
      // The genuinely-unanswered panel must come back — as an honest
      // post-decision resurface, once the screen settles. For the
      // native-answer scenario this is exactly the review-P2 lock: the
      // suppression site itself must arm the re-check, because the
      // answered-natively decision never scheduled one.
      const resurfaced = await waitUntil(
        () =>
          events.find(
            (e) => e.type === "approval:detected" && e.payload.resurfacedAfterDecision === true,
          ),
        8000,
        `${name}: honest resurface of the still-open panel`,
      );
      assert(resurfaced.payload.kind === "workspace-trust", `${name}: resurfaced as trust`);
      const detected = events.filter((e) => e.type === "approval:detected");
      assert(detected.length === 2, `${name}: exactly one resurface (got ${detected.length})`);
    }
  } finally {
    host.dispose();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

/** Scenario D (S5): a broker-held approval's PREVIEW bytes false-positive the
 *  scrape mid-run — `surfaceApproval` flips the run to waiting-for-approval —
 *  and the decision then arrives on the HOOK channel (no keys). Without the
 *  reply-channel resync (`noteHookApprovalDecision`), nothing ever resumes
 *  the run: the Stop hook's completion is guarded on status, so the run
 *  wedges "Waiting for approval" forever and the approval guard blocks every
 *  later send (s5-diags/evidence-walking-skeleton). Locks: the resync
 *  resumes the run AND the Stop-hook completion then lands. */
async function runBrokerResyncScenario(name, mode) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-resurface-broker-"));
  const scriptPath = path.join(workspace, "fake-claude.mjs");
  fs.writeFileSync(
    scriptPath,
    `
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdout.write("\\u276F opus xhigh ~\\n");
let ran = false;
const paintPanel = () => {${PANEL_PAINT}};
process.stdin.on("data", (data) => {
  const text = data.toString("utf8");
  // W1 delivers a bracketed paste and encodes Enter as CSI-u — accept either.
  if (ran || !(text.includes("\\r") || text.includes("201~") || text.includes("[13"))) {
    return;
  }
  ran = true;
  process.stdout.write("\\nRunning Write(page.html) \\u00B7 Computing\\u2026\\n");
  setTimeout(paintPanel, 50); // the broker-held preview the scrape misreads
});
setInterval(() => {}, 1000);
`,
    "utf8",
  );

  const events = [];
  const host = new TerminalHost({
    taskId: "task-resurface-broker",
    provider: "claude",
    defaultWorkspace: workspace,
    eventSink: (event) => {
      if (
        event.type === "approval:detected" ||
        event.type === "approval:decision" ||
        event.type === "run:updated"
      ) {
        events.push(event);
      }
    },
    completionQuietMs: 600,
  });

  try {
    host.startTask({
      approvalBroker: false,
      cwd: workspace,
      command: process.execPath,
      args: [scriptPath],
      approval: "never",
      rows: 24,
      cols: 110,
    });
    await delay(400); // let the composer paint
    host.submitPrompt("create two files");
    await waitUntil(
      () => events.some((e) => e.type === "approval:detected"),
      6000,
      `${name}: mid-run scrape detection`,
    );
    const wedged = events.find(
      (e) => e.type === "run:updated" && e.payload.status === "waiting-for-approval",
    );
    assert(Boolean(wedged), `${name}: run flipped to waiting-for-approval by the scrape`);

    if (mode === "stop-outranks") {
      // fix/dormant-resume (2026-07-03): Stop arriving while the approval flag
      // is up proves the flag stale (a truly pending ask blocks the turn, so
      // Stop cannot race it) — it clears the state and completes, instead of
      // the pre-fix guarded no-op that wedged the run and dropped the Stop.
      const finished = host.completeRunFromTurnEnd();
      assert(finished?.status === "completed", `${name}: Stop completes over the stale flag`);
      assert(
        events.some((e) => e.type === "run:updated" && e.payload.status === "completed"),
        `${name}: completed run:updated is emitted`,
      );
      return;
    }

    // mode === "watermark": the decision arrives on the hook channel — the
    // watermark advances (the answered panel's bytes are settled history) and
    // the >1.2s recheck must NOT re-detect them as a phantom "resurfaced" ask.
    // Pre-decision re-emits of the still-unanswered panel are legitimate; the
    // contract is zero NEW detections AFTER the decision.
    const detectionsBeforeDecision = events.filter((e) => e.type === "approval:detected").length;
    host.noteHookApprovalDecision("approve", "file-edit");
    const resumed = events.find(
      (e) => e.type === "run:updated" && e.payload.lifecyclePhase === "resumed-after-approval",
    );
    assert(Boolean(resumed), `${name}: reply-channel decision resumed the run`);
    await delay(2200); // past the recheck window that used to fire the phantom
    const detectionsAfterDecision =
      events.filter((e) => e.type === "approval:detected").length - detectionsBeforeDecision;
    assert(
      detectionsAfterDecision === 0,
      `${name}: the answered panel must not re-detect after the decision (saw ${detectionsAfterDecision})`,
    );
    const finished = host.completeRunFromTurnEnd();
    assert(finished?.status === "completed", `${name}: Stop-hook completion lands cleanly`);
  } finally {
    host.dispose();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

/** Scenario F (S3 review C1): a hook-broker approval TIMED OUT, so the CLI's
 *  native card now repaints for the SAME request. The broker ask painted no
 *  native panel, so it left NO scrape fingerprint — the fingerprint path can't
 *  recognize the resurface. `noteBrokerApprovalExpiry()` arms a one-shot timing
 *  signal so the scrape's re-detection is marked `resurfacedAfterDecision`
 *  (notification-policy then stays quiet — the user was already told). Locks the
 *  no-double-notification contract. */
async function runBrokerExpiryResurfaceScenario(name) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-resurface-bexpire-"));
  const scriptPath = path.join(workspace, "fake-claude.mjs");
  fs.writeFileSync(
    scriptPath,
    `
if (process.stdin.isTTY) { process.stdin.setRawMode(true); }
process.stdin.resume();
process.stdout.write("\\u276F opus xhigh ~\\n");
let ran = false;
const paintPanel = () => {${PANEL_PAINT}};
process.stdin.on("data", (data) => {
  const text = data.toString("utf8");
  if (ran || !(text.includes("\\r") || text.includes("201~") || text.includes("[13"))) { return; }
  ran = true;
  process.stdout.write("\\nRunning Bash(echo hi) \\u00B7 Computing\\u2026\\n");
  setTimeout(paintPanel, 400); // the NATIVE card codex renders after the broker gave up
});
setInterval(() => {}, 1000);
`,
    "utf8",
  );

  const events = [];
  const host = new TerminalHost({
    taskId: "task-resurface-bexpire",
    provider: "claude",
    defaultWorkspace: workspace,
    eventSink: (event) => {
      if (event.type === "approval:detected") events.push(event);
    },
    completionQuietMs: 600,
  });

  try {
    host.startTask({
      approvalBroker: false,
      cwd: workspace,
      command: process.execPath,
      args: [scriptPath],
      approval: "never",
      rows: 24,
      cols: 110,
    });
    await delay(400);
    host.submitPrompt("run echo");
    // The broker held this request, timed out, and Sonata is about to raise its
    // native card — arm the resurface recognition BEFORE the card paints.
    host.noteBrokerApprovalExpiry();
    const detected = await waitUntil(
      () => events.find((e) => e.type === "approval:detected"),
      6000,
      `${name}: native card detected after broker expiry`,
    );
    assert(
      detected.payload.resurfacedAfterDecision === true,
      `${name}: the post-expiry native card is marked as a resurface (no double needs-you)`,
    );
  } finally {
    host.dispose();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

try {
  await runScenario("A/answered", "answered");
  await runScenario("B/still-open", "still-open");
  await runScenario("C/native-still-open", "native-still-open");
  await runBrokerResyncScenario("D/stop-outranks-stale", "stop-outranks");
  await runBrokerResyncScenario("E/broker-watermark-no-resurface", "watermark");
  await runBrokerExpiryResurfaceScenario("F/broker-expiry-resurface");
} catch (error) {
  failures.push(String(error));
}

const success = failures.length === 0;
console.log(JSON.stringify({ success, failures }, null, 2));
process.exitCode = success ? 0 : 1;
