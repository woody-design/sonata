import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TerminalHost, cleanTerminal } = require("../../dist/runtime");

const taskId = "task-codex-smoke";
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-codex-smoke-"));
const marker = "FORMAL_SONATA_CODEX_TERMINALHOST_READY";

let rawTail = "";
let sawMarker = false;
let sawStatusLanguage = false;
let ptyExited = false;
let workspaceTrustApproved = false;
const eventTypes = [];

const host = new TerminalHost({
  taskId,
  defaultWorkspace: workspace,
  eventSink: (event) => {
    if (event.type === "pty:data") {
      rawTail = `${rawTail}${event.payload.data}`.slice(-64 * 1024);
      const clean = cleanTerminal(rawTail);
      sawMarker = sawMarker || clean.includes(marker);
      sawStatusLanguage =
        sawStatusLanguage ||
        ["model", "sandbox", "approval", "status"].some((token) =>
          clean.toLowerCase().includes(token),
        );
      return;
    }

    eventTypes.push(event.type);
    if (event.type === "pty:exit") {
      ptyExited = true;
    }
    // The codex native-panel approval scrape + PTY-key replay were retired in
    // S4 (the funeral): a bare hookless TerminalHost no longer surfaces a
    // `workspace-trust` approval:detected, and `host.sendApprove()` (Claude
    // panel grammar) now throws for codex. Codex approvals flow through the hook
    // broker; a hookless codex trust prompt is answered by the human in the
    // Terminal. This live smoke drives a pre-trusted temp workspace, so no dir
    // trust prompt is expected. (workspaceTrustApproved stays false by design.)
  },
});

try {
  host.startTask({
    cwd: workspace,
    codexPermissionMode: "ask-for-approval",
    rows: 36,
    cols: 120,
  });

  await delay(8000);
  if (ptyExited) {
    throw new Error(`Codex PTY exited before prompt submission.\n${redactedTail(rawTail)}`);
  }
  if (workspaceTrustApproved) {
    await delay(1000);
  }
  host.submitPrompt(`Reply exactly ${marker}. Do not run commands and do not edit files.`);
  await waitUntil(() => sawMarker, 120000);
  host.submitPrompt("/status");
  await waitUntil(() => sawStatusLanguage, 20000);

  const success = sawMarker && sawStatusLanguage;
  console.log(
    JSON.stringify(
      {
        provider: "codex",
        transport: "node-pty",
        workspace,
        promptSubmission: sawMarker,
        slashStatus: sawStatusLanguage,
        workspaceTrustApproved,
        eventTypes: [...new Set(eventTypes)],
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

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await delay(250);
  }
  return false;
}

function redactedTail(text) {
  return cleanTerminal(text)
    .replaceAll(os.homedir(), "~")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email redacted]")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      "[session id redacted]",
    )
    .slice(-2200);
}
