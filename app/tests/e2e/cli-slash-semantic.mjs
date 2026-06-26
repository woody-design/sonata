// CLI Slice 4 e2e — semantic slash routing, end to end against REAL claude.
//
// Locks the keystone: Problem 2 (the /architect hang) — a skill prepends into
// the composer, composes with multiline args, submits, and DISPATCHES a real
// turn. Plus the one new route built this slice: panel + unknown commands open
// the take-over floor (S3) instead of blind-injecting an invisible TUI dialog.
//
//   npm run e2e:cli-slash-semantic
//
// Requires a logged-in `claude` (network). Mirrors tests/e2e/terminal-takeover.mjs.

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
  const drawer = page.locator("#terminal-drawer");

  // Warm the slash registry so /config is classified (not blind-forwarded as an
  // unknown): open the picker, wait for options, then clear.
  await input.fill("/");
  await page.locator(".slash-picker-option").first().waitFor({ state: "visible" });
  await input.fill("");
  await page.locator(".slash-picker").waitFor({ state: "hidden" });

  const turnCardsBefore = await page.locator(".turn-card").count();

  // --- Panel → floor: /config opens the drawer, dispatches NO turn ----------
  await input.fill("/config");
  await page.locator("#send-prompt").click();
  await drawer.waitFor({ state: "visible", timeout: 15000 });
  checks.panelOpensFloor = !(await drawer.evaluate((el) => el.classList.contains("hidden")));
  checks.panelClearsComposer = (await input.inputValue()) === "";
  checks.panelDispatchedNoTurn = (await page.locator(".turn-card").count()) === turnCardsBefore;
  // Close the drawer (no take-over happened, so this is a plain toggle).
  await page.locator("#toggle-terminal").click();
  await drawer.waitFor({ state: "hidden", timeout: 10000 });

  // --- Unknown → gentle confirm, then floor ---------------------------------
  await input.fill("/zzz-not-a-command");
  await page.locator("#send-prompt").click();
  // First Enter: a gentle confirm, NOT the floor.
  await page.waitForTimeout(400);
  checks.unknownFirstStaysClosed = await drawer.evaluate((el) => el.classList.contains("hidden"));
  // Second Enter (same text): hand it to the floor.
  await page.locator("#send-prompt").click();
  await drawer.waitFor({ state: "visible", timeout: 15000 });
  checks.unknownOpensFloor = !(await drawer.evaluate((el) => el.classList.contains("hidden")));
  await page.locator("#toggle-terminal").click();
  await drawer.waitFor({ state: "hidden", timeout: 10000 });

  // --- Skill: /architect is discovered, prepends, composes, submits, DISPATCHES
  // This runs AFTER the floor tests above (which resized the PTY), so it also
  // exercises the re-pump fix end to end: before that fix the message stuck
  // "Queued" forever after floor interaction; now it delivers and dispatches.
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
  checks.skillPrependNoTurn = (await page.locator(".turn-card").count()) === turnCardsBefore;
  // Compose the multiline args and submit — the composer clears (submit accepted).
  await input.fill(`/architect ${MULTILINE}`);
  await page.locator("#send-prompt").click();
  checks.skillSubmitAccepted = await waitFor(
    async () => (await input.inputValue()) === "",
    10000,
  );
  // Dispatch: a real turn starts (the re-pump delivers it despite the prior
  // floor resize). Signals: send button flips to "Stop" (active run), a busy
  // spinner appears, or a new turn card lands — and it is NOT stuck queued.
  checks.skillDispatched = await waitFor(async () => {
    const stop = (await page.locator("#send-prompt").getAttribute("aria-label")) === "Stop";
    const spinner = (await page.locator(".sidebar-session-spinner").count()) > 0;
    const newCard = (await page.locator(".turn-card").count()) > turnCardsBefore;
    return stop || spinner || newCard;
  }, 90000);
  if (!checks.skillDispatched) {
    checks._stuckQueue = await page.locator("#delivery-queue").innerText().catch(() => "<none>");
  }

  const success =
    checks.sessionLive &&
    checks.panelOpensFloor &&
    checks.panelClearsComposer &&
    checks.panelDispatchedNoTurn &&
    checks.unknownFirstStaysClosed &&
    checks.unknownOpensFloor &&
    checks.skillDiscovered &&
    checks.skillPrepended &&
    checks.skillPrependNoTurn &&
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
