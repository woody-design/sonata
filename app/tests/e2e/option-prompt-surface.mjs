// CLI Slice 5 e2e — native option prompts (AskUserQuestion) as an in-view card,
// end to end against REAL claude. Triggers a real 3-question single-select
// prompt, asserts it renders as a stacked card in the main view, picks a
// DISTINCT option per question, sends — and asserts the card freezes into a
// receipt whose VERBATIM labels are RECONCILED from Claude's own answer
// (data-state="answered" + "Answered"), proving the chosen digits reached
// Claude. The floor fallback + single-writer guard are covered by the runtime
// live probe (Temp/probes/cli-slice5-live-probe.mjs).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { sendFirstPrompt } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-optionprompt-e2e-"));
const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-optionprompt-settings-"));
let electronApp = null;
const checks = {};

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: { ...process.env, DUET_DATA_DIR: workspaceRoot, DUET_WORKSPACES_DIR: workspaceRoot, DUET_SETTINGS_DIR: settingsDir },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(240000);

  await page.locator(".task-entry-panel", { hasText: "What should we work on?" }).waitFor({
    state: "visible",
  });
  await page.locator("#entry-provider-claude").click();

  // The trigger reliably induces a 3-question single-select AskUserQuestion.
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

  // The card surfaces, structured from the PreToolUse hook.
  const card = page.locator("#option-prompt-card");
  await card.waitFor({ state: "visible", timeout: 180000 });
  await page.locator('#option-prompt-card[data-state="asking"]').waitFor({ state: "visible" });
  checks.cardRendered = true;

  const questions = card.locator(".option-prompt-question");
  await questions.nth(2).waitFor({ state: "visible" });
  checks.questionCount = await questions.count();
  if (checks.questionCount !== 3) {
    throw new Error(`Expected 3 questions in the card, saw ${checks.questionCount}.`);
  }
  // Headers + options + descriptions present (provenance + the label/desc rows).
  await card.locator(".option-prompt-badge", { hasText: "Fruit" }).first().waitFor({ state: "visible" });
  await card.locator(".option-prompt-option-label", { hasText: "Banana" }).waitFor({ state: "visible" });
  await card.locator(".option-prompt-option-desc", { hasText: "a pome fruit" }).waitFor({ state: "visible" });
  checks.labelsAndDescriptionsShown = true;

  // Fix #1 (card scroll): force a short window so the card overflows, then
  // assert the questions region actually scrolls AND the Send footer stays
  // pinned/visible (never scrolled away). Playwright clicks auto-scroll into
  // view, so this must be verified explicitly.
  await page.setViewportSize({ width: 1000, height: 600 });
  const sendFooter = card.locator(".option-prompt-actions button.primary");
  await sendFooter.waitFor({ state: "visible" });
  const scrollMetrics = await card.locator(".option-prompt-scroll").evaluate((el) => {
    el.scrollTop = el.scrollHeight; // scroll the questions to the very bottom
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollTop: el.scrollTop };
  });
  const sendBox = await sendFooter.boundingBox();
  const viewport = page.viewportSize();
  checks.scroll = {
    overflows: scrollMetrics.scrollHeight > scrollMetrics.clientHeight + 1,
    scrolled: scrollMetrics.scrollTop > 0,
    // Send stays within the window even after the questions scrolled to bottom.
    sendPinnedVisible: Boolean(sendBox) && sendBox.y >= 0 && sendBox.y + sendBox.height <= viewport.height + 1,
  };
  if (!checks.scroll.overflows || !checks.scroll.scrolled || !checks.scroll.sendPinnedVisible) {
    throw new Error(`Card scroll fix failed: ${JSON.stringify(checks.scroll)}`);
  }

  // Pick a DISTINCT option per question: Apple (Q1 opt 3), One (Q2 opt 1), Bee (Q3 opt 2).
  await questions.nth(0).locator(".option-prompt-option").nth(2).click();
  await questions.nth(1).locator(".option-prompt-option").nth(0).click();
  await questions.nth(2).locator(".option-prompt-option").nth(1).click();
  // Selection reflected (radio state).
  await questions.nth(0).locator(".option-prompt-option.selected", { hasText: "Apple" }).waitFor({ state: "visible" });

  const send = card.locator(".option-prompt-actions button.primary");
  await send.waitFor({ state: "visible" });
  if (await send.isDisabled()) {
    throw new Error("Send button stayed disabled after all questions were answered.");
  }
  await send.click();

  // The card freezes into a receipt and RECONCILES from Claude's own answer
  // (verbatim labels) — proving our chosen digits reached Claude.
  await page.locator('#option-prompt-card[data-state="answered"]').waitFor({ state: "visible", timeout: 180000 });
  await card.locator(".option-prompt-sub", { hasText: "Answered" }).waitFor({ state: "visible", timeout: 180000 });
  await card.locator(".option-prompt-receipt-choice", { hasText: "Apple" }).waitFor({ state: "visible" });
  await card.locator(".option-prompt-receipt-choice", { hasText: "One" }).waitFor({ state: "visible" });
  await card.locator(".option-prompt-receipt-choice", { hasText: "Bee" }).waitFor({ state: "visible" });
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
