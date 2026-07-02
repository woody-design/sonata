// S3 e2e — slash verbatim passthrough, end to end against REAL claude.
//
// Locks the keystone: Problem 2 (the /architect hang) — a skill prepends into
// the composer, composes with multiline args, submits, and DISPATCHES a real
// turn. Plus the 2-way contract (two-window §1 machine #2 retired): panel and
// unknown commands submit VERBATIM — no Reading floor, no popover, no modal
// banner; the panel opens in the co-visible terminal window where the user
// operates it natively (verified here by closing /config with a real Esc in
// that window, then dispatching a follow-up turn).
//
//   npm run e2e:cli-slash-semantic
//
// Requires a logged-in `claude` (network).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { sendFirstPrompt, waitForCompletedTurns } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-slash-e2e-"));
const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-slash-settings-"));
let electronApp = null;
const checks = {};

const MULTILINE = [
  "I'm sketching a tiny two-way-door UI choice and want your instinct.",
  "",
  "Context:",
  "- low blast radius, easy to change later",
  "- no files need reading",
  "",
  "Give me a 2-sentence gut read. Do not read any files or run any tools.",
].join("\n");

try {
  const page = await launchApp();
  await page.locator(".task-entry-panel", { hasText: "What should we work on?" }).waitFor({
    state: "visible",
  });
  await page.locator("#entry-provider-claude").click();

  // A live, idle Claude session to route slash commands into.
  await sendFirstPrompt(page, "Reply with exactly: READY", { approveTrust: true });
  await waitForCompletedTurns(page, 1);
  checks.sessionLive = true;

  const input = page.locator("#prompt-input");

  // Warm the slash registry so /config is classified as known: open the
  // picker, wait for options, then clear.
  await input.fill("/");
  await page.locator(".slash-picker-option").first().waitFor({ state: "visible" });
  await input.fill("");
  await page.locator(".slash-picker").waitFor({ state: "hidden" });

  // A verbatim slash submit begins a Duet run (kind "slash") — the send button
  // is Stop (■) while it is active, so each step must wait for the run to
  // settle before the next submit. The settle itself is load-bearing: it is
  // the quiescence completion that replaced armModalPanel's close-the-slash-run
  // side effect (S3, decision A).
  const composerIdle = () =>
    waitFor(async () => (await page.locator("#send-prompt").textContent()) === "↑", 60000);

  // --- Panel command → verbatim passthrough --------------------------------
  // /config submits like any text: the composer clears and nothing floors or
  // banners in Reading; the panel renders in the terminal window.
  await input.fill("/config");
  await page.locator("#send-prompt").click();
  checks.panelSubmitAccepted = await waitFor(async () => (await input.inputValue()) === "", 15000);
  await page.waitForTimeout(2500); // let the panel render in the terminal
  checks.panelNoReadingBanner = (await page.locator("#modal-banner").count()) === 0;

  // The panel is operable in the co-visible terminal window: open it, press
  // Esc on the real xterm, and the session keeps working (follow-up below).
  const terminal = await openTerminalWindow(page);
  checks.terminalWindowOpen = Boolean(terminal);
  if (terminal) {
    await terminal.locator(".xterm-helper-textarea").focus();
    await terminal.keyboard.press("Escape");
    await page.waitForTimeout(800);
    checks.panelClosedNatively = true;
  }
  // The slash run settles by quiescence (no wedged busy state after a panel).
  checks.panelRunSettles = await composerIdle();

  // --- Unknown command → gentle confirm, then verbatim forward -------------
  await input.fill("/zzz-not-a-command");
  await page.locator("#send-prompt").click();
  await page.waitForTimeout(400);
  // First Enter: the typo caution — the text stays composed, nothing sent.
  checks.unknownFirstHolds = (await input.inputValue()) === "/zzz-not-a-command";
  // Second Enter: forwards verbatim; the CLI reports it locally.
  await page.locator("#send-prompt").click();
  checks.unknownForwarded = await waitFor(async () => (await input.inputValue()) === "", 15000);
  checks.unknownRunSettles = await composerIdle();

  // --- Skill: /architect is discovered, prepends, composes, submits, DISPATCHES
  await input.fill("/arch");
  await page.locator(".slash-picker-option", { hasText: "/architect" }).first().waitFor({
    state: "visible",
    timeout: 15000,
  });
  checks.skillDiscovered = true;
  // Enter on the selected skill PREPENDS "/architect " and keeps composing —
  // it must NOT submit (a premature skill turn is the cost we avoid).
  await dispatchKey(page, "Enter");
  checks.skillPrepended = (await input.inputValue()) === "/architect ";
  const turnCardsBeforeSkill = await page.locator(".turn-card").count();
  // Compose the multiline args and submit — the composer clears (submit accepted).
  await input.fill(`/architect ${MULTILINE}`);
  await page.locator("#send-prompt").click();
  checks.skillSubmitAccepted = await waitFor(
    async () => (await input.inputValue()) === "",
    10000,
  );
  // Dispatch: a real turn starts. Signals: send button flips to "Stop" (active
  // run), a busy spinner appears, or a new turn card lands.
  checks.skillDispatched = await waitFor(async () => {
    const stop = (await page.locator("#send-prompt").getAttribute("aria-label")) === "Stop";
    const spinner = (await page.locator(".sidebar-session-spinner").count()) > 0;
    const newCard = (await page.locator(".turn-card").count()) > turnCardsBeforeSkill;
    return stop || spinner || newCard;
  }, 90000);

  const success =
    checks.sessionLive &&
    checks.panelSubmitAccepted &&
    checks.panelNoReadingBanner &&
    checks.terminalWindowOpen &&
    checks.panelClosedNatively &&
    checks.panelRunSettles &&
    checks.unknownFirstHolds &&
    checks.unknownForwarded &&
    checks.unknownRunSettles &&
    checks.skillDiscovered &&
    checks.skillPrepended &&
    checks.skillSubmitAccepted &&
    checks.skillDispatched;
  console.log(JSON.stringify({ success, checks }, null, 2));
  process.exitCode = success ? 0 : 1;
} catch (error) {
  console.error(JSON.stringify({ success: false, checks, error: String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  if (electronApp) {
    await electronApp.close().catch(() => {});
  }
  fs.rmSync(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  fs.rmSync(settingsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

async function launchApp() {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      DUET_DATA_DIR: workspaceRoot, DUET_WORKSPACES_DIR: workspaceRoot,
      DUET_SETTINGS_DIR: settingsDir,
    },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(240000);
  return page;
}

/** Surface the satellite terminal window and return its Playwright page. */
async function openTerminalWindow(page) {
  const already = findTerminalWindow();
  if (already) {
    return already;
  }
  await page.locator("#toggle-terminal-window").click();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const found = findTerminalWindow();
    if (found) {
      await found.locator(".xterm").first().waitFor({ state: "visible", timeout: 10000 });
      return found;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

function findTerminalWindow() {
  for (const candidate of electronApp.windows()) {
    if (candidate.url().includes("terminal.html")) {
      return candidate;
    }
  }
  return null;
}

async function dispatchKey(page, key) {
  await page.locator("#prompt-input").evaluate((element, keyName) => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: keyName }),
    );
  }, key);
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}
