// CLI Slice 2 acceptance e2e — streaming must NOT destroy text selection in an
// earlier, completed message.
//
// Flow matches the bug: turn 1 completes → turn 2 starts streaming → WHILE it
// streams, select text in turn 1 and stamp the card with an identity marker →
// let turn 2 finish (many content batches). The fix (keyed reconcile) reuses
// turn 1's card untouched, so both the marker and the selection survive. Before
// the fix, renderRuns recreated every card ~6×/sec → marker gone, selection
// wiped. The marker is the hard proof (node identity); the selection string is
// the user-facing assertion.
//
//   npm run e2e:transcript-selection

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { _electron as electron } from "playwright-core";
import { sendFirstPrompt, sendPrompt, waitForCompletedTurns } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-transcript-selection-e2e-"));
let electronApp = null;

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: { ...process.env, DUET_DATA_DIR: workspaceRoot, DUET_WORKSPACES_DIR: workspaceRoot },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(180000);

  // Turn 1 — a completed, stable message with selectable assistant text.
  await sendFirstPrompt(page, [
    "Write exactly one short sentence about the color blue, and nothing else.",
  ]);
  await waitForCompletedTurns(page, 1);

  // Turn 2 — long enough to stream across several content batches.
  await sendPrompt(page, [
    "Write a short paragraph of four or five sentences about the color red.",
  ]);
  // Wait until turn 2's card has appeared (streaming has begun).
  await page.locator(".turn-card").nth(1).waitFor({ state: "visible" });

  // WHILE turn 2 streams: select text in turn 1 and stamp its card identity.
  const selected = await page.evaluate(() => {
    const card = document.querySelectorAll(".turn-card")[0];
    if (!card) return { ok: false, why: "no first card" };
    card.setAttribute("data-selection-test-marker", "turn1");
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
    return { ok: true, text: sel.toString().trim() };
  });
  assert.ok(selected.ok, `could select turn 1 text (${selected.why ?? ""})`);
  assert.ok(selected.text.length > 0, "turn 1 selection is non-empty");

  // Let turn 2 finish — the stream of content batches that used to wipe it.
  await waitForCompletedTurns(page, 2);

  const after = await page.evaluate(() => ({
    markerSurvived: Boolean(document.querySelector('[data-selection-test-marker="turn1"]')),
    cardCount: document.querySelectorAll(".turn-card").length,
    selection: (window.getSelection()?.toString() ?? "").trim(),
  }));

  assert.ok(
    after.markerSurvived,
    "turn 1's card was NOT recreated during turn 2 streaming (node identity preserved)",
  );
  assert.equal(after.selection, selected.text, "the selection in turn 1 survived streaming");
  assert.ok(after.cardCount >= 2, "both turns rendered");

  console.log(
    JSON.stringify(
      { pass: true, selectedChars: selected.text.length, cardCount: after.cardCount },
      null,
      2,
    ),
  );
  console.log("transcript-selection e2e: OK — selection survives streaming");
} catch (error) {
  console.error("transcript-selection e2e FAILED:", error);
  process.exitCode = 1;
} finally {
  await electronApp?.close();
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
}
