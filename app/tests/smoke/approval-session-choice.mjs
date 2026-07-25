import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { RunIndex, TerminalHost, isRunIndexEvent } = require("../../dist/runtime");

const taskId = "task-approval-session-choice-smoke";
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-approval-session-choice-smoke-"));
const scriptPath = path.join(workspace, "fake-claude-approval-cli.mjs");
const reportPath = path.join(workspace, ".sonata", "runtime-report.json");
// Numbered panels are answered by digit instant-select (probe findings
// 2026-06-13); the session option is option 2.
const expectedKeyHex = "32";

fs.writeFileSync(
  scriptPath,
  `
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
let promptSubmitted = false;
let approvalShown = false;

function showApproval() {
  approvalShown = true;
  process.stdout.write("\\nThinking with fake Claude\\n");
  process.stdout.write(" Read file\\n\\n");
  process.stdout.write("Read(/tmp/mp4probe.py:lines22-33)\\n\\n");
  process.stdout.write("Do you want to proceed?\\n\\n");
  process.stdout.write("❯1.Yes\\n\\n");
  process.stdout.write("2.Yes, allow reading from tmp/ during this session\\n\\n");
  process.stdout.write("3.No\\n\\n");
  process.stdout.write("Esc to cancel · Tab to amend\\n");
}

process.stdout.write("Fake Claude ready\\n❯ opus xhigh ~\\n");

let pasteSeen = false;
process.stdin.on("data", (data) => {
  const text = data.toString("utf8");
  const hex = data.toString("hex");
  if (!promptSubmitted) {
    // Production submits paste and Enter as separate writes (+120ms).
    if (text.includes("\\x1b[200~")) {
      pasteSeen = true;
    }
    if (pasteSeen && text.includes("\\x1b[13u")) {
      promptSubmitted = true;
      setTimeout(showApproval, 50);
    }
    return;
  }
  if (!approvalShown) {
    return;
  }
  process.stdout.write("\\nKEY_HEX:" + hex + "\\n");
  if (text === "2") {
    process.stdout.write("Thinking with fake Claude\\n");
    process.stdout.write("Session approval accepted.\\n❯ opus xhigh ~\\n");
  }
});
`,
  "utf8",
);

const events = [];
let ptyText = "";
const runIndex = new RunIndex({ taskId, reportPath });
const host = new TerminalHost({
  taskId,
  provider: "claude",
  defaultWorkspace: workspace,
  eventSink: (event) => {
    if (event.type === "pty:data") {
      ptyText += event.payload.data;
      return;
    }
    if (event.type === "report:updated") {
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
    args: [scriptPath],
    approval: "never",
    rows: 16,
    cols: 100,
  });

  host.submitPrompt("Trigger a fake Claude file read approval.");
  await waitUntil(
    () => {
      const detected = events.find(
        (event) => event.type === "approval:detected" && event.payload.kind === "file-read",
      );
      return Boolean(
        detected?.payload.choices?.some((choice) => choice.decision === "approve-for-session"),
      );
    },
    5000,
    "file read approval with session choice",
  );

  host.sendApproveForSession();
  await waitUntil(
    () =>
      events.some(
        (event) =>
          event.type === "approval:decision" &&
          event.payload.decision === "approve-for-session" &&
          event.payload.encodedAs === "digit 2",
      ),
    5000,
    "approve-for-session decision event",
  );
  await waitUntil(() => ptyText.includes(`KEY_HEX:${expectedKeyHex}`), 5000, "native key sequence");
  await waitUntil(() => latestRun()?.status === "completed", 8000, "completed run");

  const report = runIndex.read();
  const run = latestRun();
  const approvalEvents = run?.approvalEvents ?? [];
  const success =
    run?.status === "completed" &&
    approvalEvents.some(
      (event) =>
        event.action === "detected" &&
        event.kind === "file-read" &&
        event.choices?.some((choice) => choice.decision === "approve-for-session"),
    ) &&
    approvalEvents.some(
      (event) =>
        event.action === "decision" &&
        event.decision === "approve-for-session" &&
        event.encodedAs === "digit 2",
    ) &&
    ptyText.includes(`KEY_HEX:${expectedKeyHex}`) &&
    !JSON.stringify(report).includes("pty:data");

  console.log(
    JSON.stringify(
      {
        workspace,
        runStatus: run?.status,
        approvalEvents,
        expectedKeyHex,
        rawTerminalPersisted: false,
        success,
      },
      null,
      2,
    ),
  );

  process.exitCode = success ? 0 : 1;
} finally {
  host.dispose();
  fs.rmSync(workspace, { recursive: true, force: true });
}

function latestRun() {
  return runIndex.read().runs.at(-1) ?? null;
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
