import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { RunIndex, TerminalHost } = require("../../dist/runtime");

const taskId = "task-submit-approval-guard-smoke";
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "duet-submit-approval-guard-"));
const scriptPath = path.join(workspace, "fake-active-approval-cli.mjs");
const inputLogPath = path.join(workspace, "stdin.log");
const reportPath = path.join(workspace, ".duet", "runtime-report.json");
const blockedPrompt = "This prompt must not reach an active approval screen.";

fs.writeFileSync(
  scriptPath,
  `
import fs from "node:fs";

const inputLogPath = ${JSON.stringify(inputLogPath)};
process.stdin.setEncoding("utf8");
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdout.write("\\nWould you like to make the following edits?\\n");
process.stdout.write("- submit-approval-guard.txt\\n");
process.stdout.write("Don't ask again for these files\\n");
process.stdout.write("Press Enter to confirm\\n");
process.stdin.on("data", (data) => {
  fs.appendFileSync(inputLogPath, data);
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
});

try {
  host.startTask({
    cwd: workspace,
    command: process.execPath,
    args: [scriptPath],
    rows: 16,
    cols: 100,
  });

  await waitUntil(
    () => events.some((event) => event.type === "approval:detected" && event.payload.kind === "file-edit"),
    5000,
    "active approval detection",
  );

  let rejected = false;
  let rejectionMessage = "";
  try {
    host.submitPrompt(blockedPrompt);
  } catch (error) {
    rejected = true;
    rejectionMessage = error instanceof Error ? error.message : String(error);
  }

  await delay(250);
  const stdinLog = fs.existsSync(inputLogPath) ? fs.readFileSync(inputLogPath, "utf8") : "";
  const report = runIndex.read();
  const success =
    rejected &&
    rejectionMessage.includes("native approval screen") &&
    !stdinLog.includes(blockedPrompt) &&
    !stdinLog.includes("\u001b[200~") &&
    !stdinLog.includes("\u001b[13u") &&
    report.runs.length === 0 &&
    !events.some((event) => event.type === "prompt:submitted");

  console.log(
    JSON.stringify(
      {
        workspace,
        rejected,
        rejectionMessage,
        stdinChars: stdinLog.length,
        runCount: report.runs.length,
        eventTypes: events.map((event) => event.type),
        success,
      },
      null,
      2,
    ),
  );

  process.exitCode = success ? 0 : 1;
} finally {
  host.dispose();
  await delay(250);
  fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
