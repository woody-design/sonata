// Drawer S1 — multiSelect AskUserQuestion is fully card-answerable: options
// toggle (☑/☐), Send maps toggles to the verified 2.1.212 key grammar (digits
// toggle, RIGHT advances, Submit CR — spikes/drawer-option-prompt-probe
// P2b/P9b), and the receipt RECONCILES from Claude's own PostToolUse answers —
// proving the injected sequence reached the real CLI. (Supersedes the pre-S1
// contract where multiSelect rendered read-only with an "Answer in Terminal"
// CTA.) Real claude.

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

  // One multiSelect + one single-select mirrors a real requirement-clarification mix.
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

  const questions = card.locator(".option-prompt-question");
  await questions.nth(1).waitFor({ state: "visible" });
  const langs = questions.nth(0);
  const editor = questions.nth(1);

  // The multiSelect question still announces itself…
  await card.locator(".option-prompt-multi-tag", { hasText: "choose one or more" }).waitFor({ state: "visible" });

  // …and its options TOGGLE (S1): select Python + Go, then untoggle Go —
  // the checkbox marker and .selected state must follow every click.
  const python = langs.locator(".option-prompt-option", { hasText: "Python" });
  const go = langs.locator(".option-prompt-option", { hasText: "Go" });
  await python.click();
  await go.click();
  await langs.locator(".option-prompt-option.selected", { hasText: "Python" }).waitFor({ state: "visible" });
  await langs.locator(".option-prompt-option.selected", { hasText: "Go" }).waitFor({ state: "visible" });
  await go.click(); // untoggle
  if ((await langs.locator(".option-prompt-option.selected").count()) !== 1) {
    throw new Error("Untoggling a multiSelect option must deselect it.");
  }
  await go.click(); // re-toggle — final picks: Python + Go
  checks.multiSelectToggles = true;

  // Send stays disabled until EVERY question is answered.
  const send = card.locator(".option-prompt-actions button.primary", { hasText: "Send answers" });
  await send.waitFor({ state: "visible" });
  if (!(await send.isDisabled())) {
    throw new Error("Send must stay disabled while the single-select question is unanswered.");
  }
  checks.sendGatedOnAllAnswered = true;

  await editor.locator(".option-prompt-option", { hasText: "VSCode" }).click();
  await editor.locator(".option-prompt-option.selected", { hasText: "VSCode" }).waitFor({ state: "visible" });
  if (await send.isDisabled()) {
    throw new Error("Send stayed disabled after all questions were answered.");
  }
  await send.click();

  // Corroborated receipt: the card flips to answered ONLY after Claude's own
  // PostToolUse (option-prompt:resolved) — the receipt labels are Claude's
  // verbatim answers, proving the toggle/advance/submit sequence landed.
  await page.locator('#option-prompt-card[data-state="answered"]').waitFor({ state: "visible", timeout: 180000 });
  await card.locator(".option-prompt-sub", { hasText: "Answered" }).waitFor({ state: "visible", timeout: 180000 });
  await card.locator(".option-prompt-receipt-choice", { hasText: "Python" }).waitFor({ state: "visible" });
  await card.locator(".option-prompt-receipt-choice", { hasText: "Go" }).waitFor({ state: "visible" });
  await card.locator(".option-prompt-receipt-choice", { hasText: "VSCode" }).waitFor({ state: "visible" });
  checks.reconciledReceipt = true;

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
