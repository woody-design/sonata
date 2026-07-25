import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DeliveryController, RunIndex, TerminalHost, isRunIndexEvent } = require("../../dist/runtime");

const taskId = "task-submit-approval-guard-smoke";
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-submit-approval-guard-"));
const scriptPath = path.join(workspace, "fake-active-approval-cli.mjs");
const inputLogPath = path.join(workspace, "stdin.log");
const reportPath = path.join(workspace, ".sonata", "runtime-report.json");
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
process.stdout.write("\\nAllow this edit?\\n");
process.stdout.write("- submit-approval-guard.txt\\n");
process.stdout.write("Enter to confirm\\n");
process.stdin.on("data", (data) => {
  fs.appendFileSync(inputLogPath, data);
});
`,
  "utf8",
);

const events = [];
const runIndex = new RunIndex({ taskId, reportPath });
// Repointed to Claude in S4: the terminal-host submitPrompt guard (throw while
// a native approval screen is up) is a Claude-scrape contract. Codex approvals
// arrive via the hook broker and never set terminal-host `approvalActive`, so
// the codex scrape that used to drive this test is retired (the funeral). The
// fake paints a Claude file-edit panel (legacy hint grammar; "Allow this edit?"
// avoids the v2 "do you want to" anchor, so the shared detector takes the
// hint-fallback path and sets approvalActive).
const host = new TerminalHost({
  taskId,
  provider: "claude",
  defaultWorkspace: workspace,
  eventSink: (event) => {
    if (event.type === "pty:data" || event.type === "report:updated") {
      return;
    }
    events.push(event);
    // Mirror the controller's consume boundary (OBS S6): only real RunIndex
    // events cross into consume (isRunIndexEvent already excludes delivery:* and,
    // post-S6, file:changed — which the live watcher now emits into this sink).
    if (isRunIndexEvent(event)) {
      runIndex.consume(event);
    }
  },
});
const delivery = new DeliveryController({
  taskId,
  provider: "claude",
  terminalHost: host,
  eventSink: (event) => {
    events.push(event);
  },
  hasLiveTranscriptSource: () => false,
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

  const queued = delivery.enqueue(blockedPrompt);
  await delay(250);
  const queuedState = delivery.state().queue.find((item) => item.id === queued.id) ?? null;

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
    queuedState?.status === "queued" &&
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
        queuedStatus: queuedState?.status ?? null,
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
