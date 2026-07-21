// Drawer S2 e2e — the question drawer (AskUserQuestion) as a stepped 1/N form
// in the composer slot, end to end against REAL claude. Triggers a real
// 3-question single-select prompt and walks the whole stepper: composer card
// hides (drawer-active), step indicator advances on pick, back-chevron
// re-opens an answered question, Q2 is answered via the FREE-TEXT row (live
// verification of the P3/P9c editor injection), the Review step lists every
// answer, Send — and the card freezes into a receipt whose VERBATIM labels are
// RECONCILED from Claude's own PostToolUse (data-state="answered"), proving
// digits + free text reached Claude.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { chooseDraftProvider, sendFirstPrompt } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-optionprompt-e2e-"));
const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-optionprompt-settings-"));
let electronApp = null;
const checks = {};

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: { ...process.env, SONATA_DATA_DIR: workspaceRoot, SONATA_WORKSPACES_DIR: workspaceRoot, SONATA_SETTINGS_DIR: settingsDir },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(240000);

  await page.locator(".task-entry-panel", { hasText: "What should we work on" }).waitFor({
    state: "visible",
  });
  await chooseDraftProvider(page, "claude");
  await page.locator("#provider-chip", { hasText: "Claude" }).waitFor({ state: "visible" });

  const trigger = [
    "You are inside a UI test harness. Do EXACTLY one thing and nothing else:",
    "call the AskUserQuestion tool ONE time with exactly these three single-select",
    "questions (multiSelect false), then stop and wait. Write no other text.",
    "Q1 header 'Fruit' question 'Which fruit?' options: label 'Banana' description 'a tropical fruit';",
    "label 'Cherry' description 'a stone fruit'; label 'Apple' description 'a pome fruit'.",
    "Q2 header 'Number' question 'Which number?' options: label 'One' description 'the first';",
    "label 'Two' description 'the second'.",
    "Q3 header 'Animal' question 'Which animal?' options: label 'Ant' description 'an insect';",
    "label 'Bee' description 'a flying insect'; label 'Cat' description 'a mammal'.",
  ].join(" ");
  await sendFirstPrompt(page, trigger, { approveTrust: true, trustTimeout: 120000 });

  // The drawer surfaces in the composer slot; the composer card hides.
  const card = page.locator("#option-prompt-card");
  await card.waitFor({ state: "visible", timeout: 180000 });
  await page.locator('#option-prompt-card[data-state="asking"]').waitFor({ state: "visible" });
  await page.locator("#composer.drawer-active").waitFor({ state: "visible" });
  if (await page.locator("#composer .composer-card").isVisible()) {
    throw new Error("The composer card must hide while the drawer owns the slot.");
  }
  checks.composerTransformed = true;

  // Step 1 of 3: only Q1 renders; the indicator says so.
  await card.locator(".drawer-step", { hasText: "1 of 3" }).waitFor({ state: "visible" });
  await card.locator(".option-prompt-badge", { hasText: "Fruit" }).waitFor({ state: "visible" });
  if ((await card.locator(".option-prompt-question").count()) !== 1) {
    throw new Error("The stepper must render exactly ONE question per step.");
  }
  await card.locator(".option-prompt-option-desc", { hasText: "a pome fruit" }).waitFor({ state: "visible" });
  checks.steppedOneQuestion = true;

  // Pick Apple → auto-advance to step 2.
  await card.locator(".option-prompt-option", { hasText: "Apple" }).click();
  await card.locator(".drawer-step", { hasText: "2 of 3" }).waitFor({ state: "visible" });
  checks.singleSelectAutoAdvances = true;

  // Back-chevron re-opens Q1 with the selection intact; forward returns.
  await card.locator('.drawer-nav-button[aria-label="Previous question"]').click();
  await card.locator(".option-prompt-option.selected", { hasText: "Apple" }).waitFor({ state: "visible" });
  await card.locator('.drawer-nav-button[aria-label="Next question"]').click();
  await card.locator(".option-prompt-badge", { hasText: "Number" }).waitFor({ state: "visible" });
  checks.backNavigation = true;

  // Q2: answer via the FREE-TEXT row (live editor-injection coverage).
  const freeText = card.locator(".option-prompt-freetext-input");
  await freeText.click();
  await freeText.fill("Seven");
  // The explicit Next lives in the step footer (S5) — never inside the field.
  await card.locator(".option-prompt-actions .option-prompt-step-next", { hasText: "Next" }).click();
  await card.locator(".drawer-step", { hasText: "3 of 3" }).waitFor({ state: "visible" });
  checks.freeTextAdvances = true;

  // Q3: pick Bee → Review step lists all three answers.
  await card.locator(".option-prompt-option", { hasText: "Bee" }).click();
  await card.locator(".drawer-step", { hasText: "Review" }).waitFor({ state: "visible" });
  await card.locator(".option-prompt-review-row", { hasText: "Apple" }).waitFor({ state: "visible" });
  await card.locator(".option-prompt-review-row", { hasText: "Seven" }).waitFor({ state: "visible" });
  await card.locator(".option-prompt-review-row", { hasText: "Bee" }).waitFor({ state: "visible" });
  checks.reviewStep = true;

  const send = card.locator(".option-prompt-actions button.primary");
  await send.waitFor({ state: "visible" });
  if (await send.isDisabled()) {
    throw new Error("Send button stayed disabled after all questions were answered.");
  }
  await send.click();

  // Corroborated receipt: reconciled from Claude's own answers — digits AND
  // the free-text editor sequence landed.
  await page.locator('#option-prompt-card[data-state="answered"]').waitFor({ state: "visible", timeout: 180000 });
  await card.locator(".eyebrow", { hasText: "Your answer:" }).waitFor({ state: "visible", timeout: 180000 });
  await card.locator(".option-prompt-receipt-choice", { hasText: "Apple" }).waitFor({ state: "visible" });
  await card.locator(".option-prompt-receipt-choice", { hasText: "Seven" }).waitFor({ state: "visible" });
  await card.locator(".option-prompt-receipt-choice", { hasText: "Bee" }).waitFor({ state: "visible" });
  // The composer returns once the drawer resolves.
  await page.locator("#composer:not(.drawer-active)").waitFor({ state: "visible" });
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
