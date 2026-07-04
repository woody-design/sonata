// CLI Slice 5 — Bug A fix: a multiSelect AskUserQuestion must SHOW the card in
// the main view (Woody hit: real requirement-clarification prompts mix single +
// multiSelect, and the old gate suppressed the whole card → "in the terminal but
// not the main window"). The card now shows multiSelect questions as read-only
// CONTEXT with an "Answer in terminal" action (the verified single-select
// injection isn't used for multiSelect). Real claude.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { sendFirstPrompt } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-optms-e2e-"));
const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-optms-settings-"));
let electronApp = null;
const checks = {};

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: { ...process.env, DUET_DATA_DIR: workspaceRoot, DUET_WORKSPACES_DIR: workspaceRoot, DUET_SETTINGS_DIR: settingsDir },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(240000);

  await page.locator(".task-entry-panel", { hasText: "What should we work on" }).waitFor({
    state: "visible",
  });
  await page.locator("#provider-chip", { hasText: "Claude" }).waitFor({ state: "visible" });

  // Explicitly induce a prompt that INCLUDES a multiSelect question (the shape
  // that broke). One multiSelect + one single-select mirrors a real mix.
  const trigger = [
    "You are inside a UI test harness. Do EXACTLY one thing and nothing else:",
    "call the AskUserQuestion tool ONE time with these two questions, then wait.",
    "Q1 multiSelect TRUE, header 'Langs', question 'Which languages do you use?',",
    "options: label 'Python' description 'py'; label 'Rust' description 'rs'; label 'Go' description 'go'.",
    "Q2 multiSelect FALSE, header 'Editor', question 'Which editor?',",
    "options: label 'Vim' description 'v'; label 'VSCode' description 'c'.",
  ].join(" ");
  await sendFirstPrompt(page, trigger, { approveTrust: true, trustTimeout: 120000 });

  const card = page.locator("#option-prompt-card");
  await card.waitFor({ state: "visible", timeout: 180000 });
  await page.locator('#option-prompt-card[data-state="asking"]').waitFor({ state: "visible" });
  checks.cardRendered = true;

  // The multiSelect question renders as read-only CONTEXT: checkbox options + a
  // "choose one or more" tag — and the questions are legible in the main view.
  await card.locator(".option-prompt-multi-tag", { hasText: "choose one or more" }).waitFor({ state: "visible" });
  await card.locator(".option-prompt-option.checkbox .option-prompt-option-label", { hasText: "Python" }).waitFor({ state: "visible" });
  checks.multiSelectShownAsContext = true;

  // The footer routes answering to the terminal (no card-Send for
  // multiSelect). The action wears the S5 attention-banner family style —
  // one visual voice for every "waiting for you in the Terminal" pointer.
  const answerInTerminal = card.locator(
    ".option-prompt-actions button.attention-open-terminal",
    { hasText: "Answer in Terminal" },
  );
  await answerInTerminal.waitFor({ state: "visible" });
  checks.answerInTerminalCta = true;
  checks.noSendButton = (await card.locator(".option-prompt-actions button.primary", { hasText: "Send answers" }).count()) === 0;
  if (!checks.noSendButton) {
    throw new Error("A multiSelect prompt must NOT offer card-Send (only verified single-select injects).");
  }

  // The CTA surfaces the satellite terminal window (the old #terminal-drawer
  // assertion referenced the UI retired by d433caf — pre-existing debt).
  await answerInTerminal.click();
  const terminalWindow = electronApp
    .windows()
    .find((w) => w.url().includes("terminal.html"));
  if (!terminalWindow) {
    throw new Error("The Answer-in-Terminal CTA did not surface a terminal window.");
  }
  checks.ctaOpensFloor = true;

  checks.success = true;
  console.log(JSON.stringify({ success: true, checks }, null, 2));
  process.exitCode = 0;
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
