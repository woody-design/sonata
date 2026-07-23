import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TerminalHost, cleanTerminal, codexArgs } = require("../../dist/runtime");
const {
  CODEX_SMOKE_PROFILE,
  ensureSmokeTrustProfile,
  removeSmokeTrustProfile,
  isCodexUpdatePrompt,
  CODEX_UPDATE_PROMPT_SKIP_REASON,
  SmokeSkip,
} = await import("./codex-smoke-trust.mjs");

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
    // Terminal. This live smoke drives a GENUINELY pre-trusted temp workspace
    // (the sonata-smoke profile carries the trust entry — codex-smoke-trust.mjs),
    // so no dir trust prompt renders. (workspaceTrustApproved stays false by
    // design.)
  },
});

try {
  // Pre-trust the temp workspace via the throwaway smoke profile: a fresh dir
  // otherwise pops the directory-trust dialog, whose `›` option cursor reads
  // as an idle composer to a timing bet — the 8s-delay submit this smoke used
  // to make typed its prompt INTO the dialog (text discarded, Enter silently
  // answered "Yes, continue"; probed spikes/codex-boot-input-window,
  // upstream-sync 2026-07-17). With the profile, boot goes straight to the
  // real composer and readiness is the structural gate, not a clock.
  ensureSmokeTrustProfile(workspace);
  host.startTask({
    cwd: workspace,
    args: codexArgs({
      cwd: workspace,
      permissionMode: "ask-for-approval",
      profile: CODEX_SMOKE_PROFILE,
    }),
    rows: 36,
    cols: 120,
  });

  await waitUntil(() => host.acceptsPromptInput() || ptyExited, 60000);
  if (ptyExited || !host.acceptsPromptInput()) {
    const tail = redactedTail(rawTail);
    // ONLY codex's boot "Update available!" gate skips (env drift — the real app
    // is blocked identically; S4 owns the product-side surfacing). Every OTHER
    // readiness failure stays a hard FAIL.
    if (isCodexUpdatePrompt(tail)) {
      throw new SmokeSkip(CODEX_UPDATE_PROMPT_SKIP_REASON);
    }
    if (ptyExited) {
      throw new Error(`Codex PTY exited before prompt submission.\n${tail}`);
    }
    throw new Error(`Codex composer never reached readiness.\n${tail}`);
  }
  // One paint-tick of settle: the composer can render before the boot
  // banner's model line fills, and input-retention at first paint is
  // unprobed. Production hedges the same window with bootDeliveryGraceMs
  // (500ms) + the Enter-retry ladder; this bare-host smoke has neither, so
  // 1s stands in for that heal layer (2× the production grace).
  await delay(1000);
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
} catch (error) {
  // Environmental SKIP (exit 77) for codex's boot update gate only; any other
  // throw propagates unchanged after cleanup (uncaught → exit 1, as before).
  if (error instanceof SmokeSkip) {
    console.log(`SKIP: ${error.message}`);
    process.exitCode = 77;
  } else {
    throw error;
  }
} finally {
  host.dispose();
  removeSmokeTrustProfile();
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
