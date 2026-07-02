import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { RunIndex, TerminalHost, cleanTerminal, isRunIndexEvent } = require("../../dist/runtime");

const taskId = "task-claude-smoke";
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "duet-claude-smoke-"));
const reportPath = path.join(workspace, ".duet", "runtime-report.json");
const marker = "FORMAL_DUET_CLAUDE_TERMINALHOST_READY";

let rawTail = "";
let sawMarker = false;
let sawStatusLanguage = false;
let ptyExited = false;
let workspaceTrustApproved = false;
const eventTypes = [];
const runIndex = new RunIndex({ taskId, reportPath });

const host = new TerminalHost({
  taskId,
  provider: "claude",
  defaultWorkspace: workspace,
  eventSink: (event) => {
    if (event.type === "pty:data") {
      rawTail = `${rawTail}${event.payload.data}`.slice(-64 * 1024);
      const clean = cleanTerminal(rawTail);
      sawMarker = sawMarker || clean.includes(marker);
      sawStatusLanguage =
        sawStatusLanguage ||
        ["version", "session", "model", "login", "cwd"].some((token) =>
          clean.toLowerCase().includes(token),
        );
      return;
    }

    eventTypes.push(event.type);
    // Mirror the real runtime-controller: only RunIndex events reach the index
    // (it asserts-never on the rest). Without this guard a `/status` panel's
    // modal:state event crashes the harness — the controller guards it in prod
    // (runtime-controller isRunIndexEvent), the harness must too.
    if (isRunIndexEvent(event)) {
      runIndex.consume(event);
    }
    if (event.type === "pty:exit") {
      ptyExited = true;
    }
    if (event.type === "approval:detected" && event.payload.kind === "workspace-trust") {
      workspaceTrustApproved = true;
      host.sendApprove();
    }
  },
});

try {
  host.startTask({
    cwd: workspace,
    permissionMode: "default",
    rows: 36,
    cols: 120,
  });

  await waitUntil(() => workspaceTrustApproved || eventTypes.includes("task:ready"), 120000, "Claude startup");
  if (ptyExited) {
    throw new Error(`Claude PTY exited before prompt submission.\n${redactedTail(rawTail)}`);
  }
  await waitUntil(() => eventTypes.includes("task:ready"), 120000, "Claude task ready");

  host.submitPrompt(`Reply exactly ${marker}. Do not run commands and do not edit files.`);
  await waitUntil(() => sawMarker, 180000, "Claude marker response");

  host.submitPrompt("/status");
  await waitUntil(() => sawStatusLanguage, 60000, "Claude slash status");

  const report = runIndex.read();
  const reportText = JSON.stringify(report);
  const rawStatusPersisted =
    reportText.includes("ClaudeCode") ||
    reportText.includes("Loginmethod") ||
    reportText.includes("SessionID") ||
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(reportText);
  const success =
    sawMarker &&
    sawStatusLanguage &&
    workspaceTrustApproved &&
    report.runtime?.provider === "claude" &&
    !rawStatusPersisted;

  console.log(
    JSON.stringify(
      {
        provider: "claude",
        transport: "node-pty",
        workspace,
        promptSubmission: sawMarker,
        slashStatus: sawStatusLanguage,
        workspaceTrustApproved,
        eventTypes: [...new Set(eventTypes)],
        reportProvider: report.runtime?.provider ?? null,
        rawStatusPersisted,
        rawScrollbackPersisted: false,
        failureTail: success ? null : redactedTail(rawTail),
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}.\n${redactedTail(rawTail)}`);
}

function redactedTail(text) {
  return cleanTerminal(text)
    .replaceAll(os.homedir(), "~")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email redacted]")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      "[session id redacted]",
    )
    .slice(-2400);
}
