import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TerminalHost, cleanTerminal } = require("../../dist/runtime");

const taskId = "task-command-approval-smoke";
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "duet-command-approval-smoke-"));
const target = path.join(workspace, "command_approval_smoke.txt");
const commandText =
  "python3 -c \"from pathlib import Path; Path('command_approval_smoke.txt').write_text('Duet command approval smoke')\"";
const prompt = [
  "Run exactly this shell command and no other commands.",
  "Do not use apply_patch.",
  "Do not edit files directly.",
  `Command: ${commandText}`,
].join(" ");

let rawTail = "";
let commandApprovalDetected = false;
let commandApprovalApproved = false;
let workspaceTrustApproved = false;
const eventTypes = [];

const host = new TerminalHost({
  taskId,
  defaultWorkspace: workspace,
  eventSink: (event) => {
    if (event.type === "pty:data") {
      rawTail = `${rawTail}${event.payload.data}`.slice(-64 * 1024);
      return;
    }

    eventTypes.push(event.type);
    if (event.type === "approval:detected" && event.payload.kind === "workspace-trust") {
      workspaceTrustApproved = true;
      host.sendApprove();
    }
    if (event.type === "approval:detected" && event.payload.kind === "command") {
      commandApprovalDetected = true;
      host.sendApprove();
    }
    if (event.type === "approval:decision" && event.payload.previousKind === "command") {
      commandApprovalApproved = true;
    }
  },
});

try {
  host.startTask({
    cwd: workspace,
    sandbox: "read-only",
    approval: "on-request",
    rows: 40,
    cols: 120,
  });

  await delay(8000);
  if (workspaceTrustApproved) {
    await delay(1000);
  }

  host.submitPrompt(prompt);
  await waitUntil(() => commandApprovalDetected, 180000, "command approval");
  await waitUntil(() => fs.existsSync(target), 180000, "command approval target file");

  const success =
    commandApprovalDetected &&
    commandApprovalApproved &&
    fs.readFileSync(target, "utf8").includes("Duet command approval smoke");

  console.log(
    JSON.stringify(
      {
        provider: "codex",
        transport: "node-pty",
        workspace,
        commandApprovalDetected,
        commandApprovalApproved,
        workspaceTrustApproved,
        targetCreated: fs.existsSync(target),
        eventTypes: [...new Set(eventTypes)],
        rawScrollbackPersisted: false,
        failureTail: success ? null : redactedTail(rawTail),
        success,
      },
      null,
      2,
    ),
  );

  process.exitCode = success ? 0 : 1;
} catch (error) {
  console.error(
    JSON.stringify(
      {
        error: error instanceof Error ? error.message : String(error),
        commandApprovalDetected,
        commandApprovalApproved,
        workspaceTrustApproved,
        targetCreated: fs.existsSync(target),
        eventTypes: [...new Set(eventTypes)],
        tail: redactedTail(rawTail),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  host.dispose();
  fs.rmSync(workspace, { recursive: true, force: true });
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactedTail(text) {
  return cleanTerminal(text)
    .replaceAll(os.homedir(), "~")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email redacted]")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      "[session id redacted]",
    )
    .slice(-2600);
}
