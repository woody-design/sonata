// Quote & Comment — S1 live sanity probe (throwaway; the durable fence is S2).
// Drives the built app end-to-end: real completed turn → programmatic selection
// over the assistant answer → floating trigger appears → open the bar → type →
// checkmark appears → Enter → the composer holds the exact serialized paragraph
// → trigger/bar gone. Screenshots at the trigger-visible and bar-open moments
// land in Temp/Comment/s1-verify/ for the leader's visual pass.
//
//   node tests/e2e/quote-comment-probe.mjs   (run from app/, after npm run build)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { _electron as electron } from "playwright-core";
import { sendFirstPrompt, waitForCompletedTurns } from "./helpers/session.mjs";

const SHOT_DIR = path.resolve("../Temp/Comment/s1-verify");
fs.mkdirSync(SHOT_DIR, { recursive: true });

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-quote-comment-probe-"));
let electronApp = null;

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: { ...process.env, DUET_DATA_DIR: workspaceRoot, DUET_WORKSPACES_DIR: workspaceRoot },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(180000);

  // A completed, stable turn with selectable assistant text.
  await sendFirstPrompt(page, [
    "Write exactly one short sentence about the color blue, and nothing else.",
  ]);
  await waitForCompletedTurns(page, 1);

  // Select the last substantial text node inside turn 1's answer. Creating the
  // range fires selectionchange, which the view debounces (150 ms) before it
  // shows the trigger.
  const selected = await page.evaluate(() => {
    const card = document.querySelectorAll(".turn-card")[0];
    const answer = card.querySelector(".turn-answer") ?? card;
    const candidates = Array.from(answer.querySelectorAll("*")).filter(
      (el) => (el.textContent ?? "").trim().length > 8,
    );
    const target = candidates[candidates.length - 1] ?? answer;
    const range = document.createRange();
    range.selectNodeContents(target);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return sel.toString();
  });
  assert.ok(selected.trim().length > 0, "selection is non-empty");

  // Trigger appears above the selection.
  const trigger = page.locator(".quote-comment-trigger");
  await trigger.waitFor({ state: "visible" });
  await page.screenshot({ path: path.join(SHOT_DIR, "1-trigger-visible.png") });

  // mousedown opens the bar (the handler preventDefaults to keep the selection).
  await trigger.click();
  const bar = page.locator(".quote-comment-bar");
  const input = page.locator(".quote-comment-input");
  await bar.waitFor({ state: "visible" });
  await input.waitFor({ state: "visible" });

  const focused = await page.evaluate(() =>
    document.activeElement?.classList.contains("quote-comment-input"),
  );
  assert.ok(focused, "the input bar is focused on open (no bar screenshot yet — empty state)");

  // Confirm is hidden until the input has non-whitespace text (D4).
  assert.ok(
    await page.locator(".quote-comment-confirm[hidden]").count(),
    "confirm is hidden while the input is empty",
  );

  await input.fill("test comment");
  const confirm = page.locator(".quote-comment-confirm:not([hidden])");
  await confirm.waitFor({ state: "visible" });
  await page.screenshot({ path: path.join(SHOT_DIR, "2-bar-open-with-text.png") });

  // Enter confirms.
  await input.press("Enter");

  const composer = await page.locator("#prompt-input").inputValue();
  assert.ok(composer.startsWith('About "'), `composer starts with the About prefix: ${composer}`);
  assert.ok(
    composer.includes('My comments "test comment"'),
    `composer carries the comment: ${composer}`,
  );

  // Trigger + bar gone after confirm; selection collapsed so nothing re-shows.
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".quote-comment-bar").count(), 0, "bar closed");
  assert.equal(await page.locator(".quote-comment-trigger").count(), 0, "trigger not re-shown");

  console.log(
    JSON.stringify(
      { pass: true, selectedChars: selected.trim().length, composer },
      null,
      2,
    ),
  );
  console.log("quote-comment probe: OK — select → trigger → type → confirm → composer paragraph");
} catch (error) {
  console.error("quote-comment probe FAILED:", error);
  process.exitCode = 1;
} finally {
  await electronApp?.close();
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
}
