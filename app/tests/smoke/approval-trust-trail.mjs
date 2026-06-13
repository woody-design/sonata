// Layer-2c verification — session-setup approvals leave a forensic trail.
//
// The workspace-trust screen fires before any run exists, so its
// approval:detected / approval:decision carry runId=null. Routing them
// through upsertRun(null) silently dropped them — the empty approvalEvents
// in the 148-approval incident report. They must now land in the report's
// unassignedApprovals bucket (mirroring unassignedChanges).
//
// Also exercises the 2a trust path: a v2 trust panel detected as
// workspace-trust, answered by plain CR (not CSI-u Enter).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { RunIndex, TerminalHost } = require("../../dist/runtime");

const taskId = "task-approval-trust-trail-smoke";
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "duet-approval-trust-trail-smoke-"));
const scriptPath = path.join(workspace, "fake-claude-trust-cli.mjs");
const reportPath = path.join(workspace, ".duet", "runtime-report.json");

// Fake claude that opens with a v2 workspace-trust panel at startup (no run
// yet), then drops to a composer once the panel is answered with CR.
fs.writeFileSync(
  scriptPath,
  `
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
let trustAnswered = false;

process.stdout.write("\\n");
process.stdout.write("Accessing workspace:\\n\\n");
process.stdout.write("/private/tmp/fake-workspace\\n\\n");
process.stdout.write("Quick safety check: Is this a project you created or one you trust?\\n\\n");
process.stdout.write("Claude Code'll be able to read, edit, and execute files here.\\n\\n");
process.stdout.write("\\u276F1.Yes, I trust this folder\\n\\n");
process.stdout.write("2.No, exit\\n\\n");
process.stdout.write("Enter to confirm \\u00B7 Esc to cancel\\n");

process.stdin.on("data", (data) => {
  const text = data.toString("utf8");
  if (!trustAnswered && text.includes("\\r")) {
    trustAnswered = true;
    process.stdout.write("\\nTrusted.\\n\\u276F opus xhigh ~\\n");
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
    runIndex.consume(event);
  },
  completionQuietMs: 600,
});

try {
  host.startTask({
    cwd: workspace,
    command: process.execPath,
    args: [scriptPath],
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

  host.sendApprove();
  await waitUntil(
    () =>
      events.some(
        (event) =>
          event.type === "approval:decision" &&
          event.payload.previousKind === "workspace-trust" &&
          event.payload.decision === "approve",
      ),
    6000,
    "workspace-trust approve decision",
  );

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

  const success =
    trustHadNullRun &&
    trustApproveEncoding === "CR" &&
    detectedInUnassigned &&
    decisionInUnassigned &&
    noPhantomRun;

  console.log(
    JSON.stringify(
      {
        workspace,
        trustHadNullRun,
        trustApproveEncoding,
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
} finally {
  host.dispose();
  fs.rmSync(workspace, { recursive: true, force: true });
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
