import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { RunIndex, TerminalHost } = require("../../dist/runtime");

const taskId = "task-approval-reliability-smoke";
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "duet-approval-reliability-smoke-"));
const scriptPath = path.join(workspace, "fake-approval-cli.mjs");
const reportPath = path.join(workspace, ".duet", "runtime-report.json");

fs.writeFileSync(
  scriptPath,
  `
process.stdin.setEncoding("utf8");
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
let promptSeen = false;
let approvalShown = false;
let approvalConfirms = 0;

function showApproval() {
  approvalShown = true;
  process.stdout.write("\\nWould you like to make the following edits?\\n");
  process.stdout.write("- approval-reliability.txt\\n");
  process.stdout.write("Press Enter to confirm\\n");
}

process.stdin.on("data", (data) => {
  if (data.includes("\\x1b[200~")) {
    promptSeen = true;
  }
  if (!data.includes("\\x1b[13u")) {
    return;
  }
  if (promptSeen && !approvalShown) {
    setTimeout(showApproval, 50);
    return;
  }
  if (!approvalShown) {
    return;
  }
  approvalConfirms += 1;
  if (approvalConfirms === 1) {
    return;
  }
  process.stdout.write("\\nWorking\\nApproval accepted after retry.\\n› ");
});
`,
  "utf8",
);

const events = [];
const runIndex = new RunIndex({ taskId, reportPath });
const host = new TerminalHost({
  taskId,
  defaultWorkspace: workspace,
  eventSink: (event) => {
    if (event.type === "pty:data" || event.type === "report:updated") {
      return;
    }
    events.push(event);
    runIndex.consume(event);
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

  host.submitPrompt("Trigger a fake native approval.");
  await waitUntil(
    () => events.some((event) => event.type === "approval:detected" && event.payload.kind === "file-edit"),
    5000,
    "initial approval detection",
  );
  host.sendApprove();
  await waitUntil(
    () =>
      events.some(
        (event) =>
          event.type === "approval:detected" &&
          event.payload.kind === "file-edit" &&
          event.payload.resurfacedAfterDecision,
      ),
    5000,
    "approval resurface after unadvanced decision",
  );
  host.sendApprove();
  await waitUntil(() => latestRun()?.status === "completed", 8000, "completed run");

  const report = runIndex.read();
  const run = latestRun();
  const approvalEvents = run?.approvalEvents ?? [];
  const success =
    run?.status === "completed" &&
    approvalEvents.some((event) => event.action === "detected" && event.kind === "file-edit") &&
    approvalEvents.some((event) => event.action === "detected" && event.resurfacedAfterDecision) &&
    approvalEvents.filter((event) => event.action === "decision" && event.decision === "approve").length >= 2 &&
    !JSON.stringify(report).includes("pty:data");

  console.log(
    JSON.stringify(
      {
        workspace,
        runStatus: run?.status,
        approvalEvents,
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
