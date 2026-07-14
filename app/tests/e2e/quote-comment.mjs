// Quote & Comment — durable e2e fence (plan
// `product-thinking/2026-07-14-quote-comment-plan-v0.md` §Interaction contract
// + §Serialization contract). Promoted from the S1 throwaway probe.
//
// Pins the whole selection→comment→composer flow in ONE app launch with exactly
// ONE real CLI turn (cost + determinism): the turn produces selectable
// transcript text, and every subsequent step is driven by programmatic
// selection over that already-settled text. What this fence guarantees:
//
//   a. A non-collapsed selection inside a completed turn shows the trigger.
//   b. Clicking the trigger opens the bar, focuses the input, and keeps the
//      confirm checkmark hidden while the input is empty OR whitespace-only,
//      with Enter a no-op in that state (D4).
//   c. Escape closes the bar with no trace — composer text unchanged.
//   d. Re-select a strict SUBSTRING → trigger → type → checkmark appears → Enter
//      appends the EXACT serialized paragraph (of what selection.toString()
//      returned, not the nearest element's full text) to the composer, closes
//      trigger+bar, and does NOT steal focus into the composer (D6).
//   e. A second comment on a different selection appends at the END even with
//      the composer caret at position 0 — proving append-at-end, not
//      insert-at-caret (D5).
//   f. A whitespace-only selection that HAS a real client rect shows no trigger
//      (isolating the S1 normalizeQuote dead-trigger guard from lastRectOf's
//      zero-rect rejection).
//
// The serialized paragraph is asserted against a string computed INLINE here
// (importing nothing) so this fence is an independent witness of the contract,
// not a tautology against the module it guards. Truncation (>180-char quotes)
// is nondeterministic to produce from a live CLI turn and stays pinned at the
// pure-smoke layer (tests/smoke/quote-comment.mjs) only.
//
//   npm run e2e:quote-comment

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { _electron as electron } from "playwright-core";
import { sendFirstPrompt, waitForCompletedTurns } from "./helpers/session.mjs";

// Inline mirrors of the reading-core serialization contract (plan
// §Serialization) — deliberately NOT imported, so a regression in the pure
// module can't hide behind a shared implementation.
const normalizeQuote = (raw) => raw.replace(/\s+/g, " ").trim();
const formatParagraph = (rawQuote, rawComment) =>
  `About "${normalizeQuote(rawQuote)}", My comments "${rawComment.trim()}"`;

/** Select the full contents of the first element matching `selector` inside the
 *  first turn card, and return the resulting selection string. Setting the range
 *  fires selectionchange, which the view debounces (150 ms) before it decides on
 *  the trigger. */
async function selectContents(page, selector) {
  return page.evaluate((sel) => {
    const card = document.querySelectorAll(".turn-card")[0];
    const target = card?.querySelector(sel);
    if (!target) {
      return { ok: false, why: `no element matching ${sel} in turn card 0` };
    }
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return { ok: true, text: selection.toString() };
  }, selector);
}

/** Select a strict SUBSTRING of the first substantial text node inside the first
 *  element matching `selector`, bounded on both ends by whitespace (start at the
 *  first space, end just after the last space in the node). A whole-element
 *  selection would let an implementation that serialized "the nearest transcript
 *  element's full text" pass; a mid-node substring with whitespace boundaries
 *  witnesses BOTH that the view used `selection.toString()` AND that it
 *  normalizes (the boundary spaces must be trimmed away). */
async function selectSubstring(page, selector) {
  return page.evaluate((sel) => {
    const card = document.querySelectorAll(".turn-card")[0];
    const host = card?.querySelector(sel);
    if (!host) return { ok: false, why: `no element matching ${sel} in turn card 0` };
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let node = null;
    while (walker.nextNode()) {
      const data = walker.currentNode.data ?? "";
      if (data.trim().length > 8 && data.indexOf(" ") !== data.lastIndexOf(" ")) {
        node = walker.currentNode;
        break;
      }
    }
    if (!node) return { ok: false, why: "no text node with two-plus spaces to bound a substring" };
    const data = node.data;
    const start = data.indexOf(" "); // selection begins ON a space
    const end = data.lastIndexOf(" ") + 1; // ...and ends just AFTER the last space
    if (!(start >= 0 && end > start + 1)) return { ok: false, why: "not enough interior text" };
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return { ok: true, text: selection.toString(), whole: data };
  }, selector);
}

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-quote-comment-e2e-"));
let electronApp = null;

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: { ...process.env, DUET_DATA_DIR: workspaceRoot, DUET_WORKSPACES_DIR: workspaceRoot },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(180000);

  // ── The one CLI turn: a short, deterministic exact-echo gives clean
  //    selectable transcript text (assistant answer + the user's own prompt).
  //    Content need not be asserted — the fence captures whatever string the
  //    selection yields and computes the expected paragraph from it. ──────────
  await sendFirstPrompt(page, [
    "Reply with exactly this text and nothing else: The morning sky is a calm shade of blue.",
  ]);
  await waitForCompletedTurns(page, 1);
  // The completion beacon (`data-run-status="completed"`) can fire from the Stop
  // hook / quiescence BEFORE the assistant's transcript blocks render into the
  // body — a completed turn with no blocks yet omits `.turn-answer` entirely.
  // Wait for the answer body itself so the selection has real text to grab.
  await page.locator(".turn-card .turn-answer").first().waitFor({ state: "visible" });

  const trigger = page.locator(".quote-comment-trigger");
  const bar = page.locator(".quote-comment-bar");
  const input = page.locator(".quote-comment-input");
  const confirmHidden = page.locator(".quote-comment-confirm[hidden]");
  const confirmShown = page.locator(".quote-comment-confirm:not([hidden])");
  const composer = page.locator("#prompt-input");

  // Baseline: the composer is empty after the send cleared it.
  const composerBaseline = await composer.inputValue();
  assert.equal(composerBaseline, "", "composer starts empty after the first send");

  // ─── (a) Selection in a completed turn → trigger appears ───────────────────
  const sel1 = await selectContents(page, ".turn-answer");
  assert.ok(sel1.ok, `could select the assistant answer (${sel1.why ?? ""})`);
  assert.ok(sel1.text.trim().length > 0, "assistant-answer selection is non-empty");
  await trigger.waitFor({ state: "visible" });
  assert.equal(await trigger.count(), 1, "(a) exactly one trigger for a qualifying selection");

  // ─── (b) Click trigger → bar opens, input focused, confirm hidden (D4) ─────
  await trigger.click();
  await bar.waitFor({ state: "visible" });
  await input.waitFor({ state: "visible" });
  const inputFocused = await page.evaluate(() =>
    document.activeElement?.classList.contains("quote-comment-input"),
  );
  assert.ok(inputFocused, "(b) the input bar is focused on open");
  assert.equal(await confirmHidden.count(), 1, "(b) confirm hidden while the input is empty (D4)");
  assert.equal(await confirmShown.count(), 0, "(b) confirm not visible in the empty state");

  // ─── (b′) Whitespace-only input is treated as empty (D4 — guards a `.trim()`
  //    → `.length` regression): confirm stays hidden, and Enter is a no-op that
  //    leaves the bar open and the composer untouched. ─────────────────────────
  await input.fill("   ");
  await page.waitForTimeout(50); // let the input listener run
  assert.equal(await confirmHidden.count(), 1, "(b′) confirm stays hidden for whitespace-only text");
  assert.equal(await confirmShown.count(), 0, "(b′) confirm not shown for whitespace-only text");
  await input.press("Enter");
  await page.waitForTimeout(150);
  assert.equal(await bar.count(), 1, "(b′) Enter on a whitespace-only input is a no-op (bar stays open)");
  assert.equal(
    await composer.inputValue(),
    composerBaseline,
    "(b′) a whitespace-only confirm appended nothing to the composer",
  );

  // ─── (c) Esc → bar closes, no trace, composer unchanged ────────────────────
  await input.press("Escape");
  await bar.waitFor({ state: "detached" });
  assert.equal(await bar.count(), 0, "(c) Esc closed the bar");
  assert.equal(await trigger.count(), 0, "(c) no trigger lingers after cancel");
  assert.equal(
    await composer.inputValue(),
    composerBaseline,
    "(c) cancel left the composer text untouched — no trace",
  );

  // ─── (d) Re-select a SUBSTRING → trigger → type → checkmark → Enter → exact ─
  const sel2 = await selectSubstring(page, ".turn-answer");
  assert.ok(sel2.ok, `(d) selected an answer substring (${sel2.why ?? ""})`);
  assert.ok(sel2.text.length < sel2.whole.length, "(d) the selection is a STRICT substring");
  assert.notEqual(
    normalizeQuote(sel2.text),
    sel2.text,
    "(d) the substring carries boundary whitespace, so normalization is witnessed too",
  );
  await trigger.waitFor({ state: "visible" });
  await trigger.click();
  await input.waitFor({ state: "visible" });

  const comment1 = "first thought";
  await input.fill(comment1);
  await confirmShown.waitFor({ state: "visible" }); // (d) checkmark appears once there is text
  assert.equal(await confirmHidden.count(), 0, "(d) confirm no longer hidden once the input has text");

  await input.press("Enter");
  await bar.waitFor({ state: "detached" });

  const expected1 = formatParagraph(sel2.text, comment1);
  assert.equal(
    await composer.inputValue(),
    expected1,
    "(d) composer holds the EXACT serialized paragraph of the SUBSTRING selection",
  );
  assert.equal(await trigger.count(), 0, "(d) trigger gone after confirm (selection collapsed)");
  assert.equal(await bar.count(), 0, "(d) bar gone after confirm");
  const stoleFocus = await page.evaluate(() => document.activeElement?.id === "prompt-input");
  assert.equal(stoleFocus, false, "(d) confirm did NOT steal focus into the composer (D6)");

  // ─── (e) Second comment, composer caret forced to 0 → still appends at END ──
  // Select the user's own prompt bubble (a different transcript subtree, still
  // inside the same turn card). Any transcript text is fair game.
  const sel3 = await selectContents(page, ".turn-user-text");
  assert.ok(sel3.ok && sel3.text.trim().length > 0, "(e) selected the user prompt bubble");
  await trigger.waitFor({ state: "visible" });
  await trigger.click();
  await input.waitFor({ state: "visible" });

  const comment2 = "second thought";
  await input.fill(comment2);
  await confirmShown.waitFor({ state: "visible" });
  // Park the composer caret at the very START. Append-at-end (D5) must ignore it;
  // an insert-at-caret implementation would drop the paragraph at position 0 and
  // fail the ordering assertion below.
  await composer.evaluate((el) => {
    el.focus();
    el.setSelectionRange(0, 0);
  });
  await input.press("Enter");
  await bar.waitFor({ state: "detached" });

  const expected2 = `${expected1}\n\n${formatParagraph(sel3.text, comment2)}`;
  assert.equal(
    await composer.inputValue(),
    expected2,
    "(e) second paragraph appended at the END despite caret 0 — append-at-end, not insert-at-caret (D5)",
  );

  // ─── (f) Whitespace-only selection WITH a real client rect → no trigger ─────
  // A pure-whitespace selection is not reliably harvestable from rendered prose
  // (marked emits no inter-element whitespace text nodes between block
  // children), so construct one: inject an INLINE element with `white-space:
  // pre` holding only spaces. Under `pre` the spaces render with real width, so
  // the range has a non-zero client rect — which means `lastRectOf`'s zero-rect
  // rejection CANNOT be what hides the trigger. The only remaining suppressor is
  // the S1 normalizeQuote()-is-empty guard, so this isolates exactly that guard.
  const wsSelected = await page.evaluate(() => {
    const answer = document.querySelector(".turn-card .turn-answer");
    if (!answer) return { ok: false, why: "no answer body to host the whitespace node" };
    const span = document.createElement("span");
    span.style.whiteSpace = "pre";
    span.textContent = "        "; // spaces only — real width under `pre`
    answer.appendChild(span);
    const range = document.createRange();
    range.selectNodeContents(span);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const rects = range.getClientRects();
    const rect = rects.length > 0 ? rects[rects.length - 1] : null;
    return {
      ok: true,
      text: selection.toString(),
      collapsed: selection.isCollapsed,
      rectWidth: rect ? rect.width : 0,
      rectHeight: rect ? rect.height : 0,
    };
  });
  assert.ok(wsSelected.ok, `(f) injected a whitespace-only selection (${wsSelected.why ?? ""})`);
  assert.ok(!wsSelected.collapsed, "(f) the whitespace selection is non-collapsed");
  assert.equal(wsSelected.text.trim(), "", "(f) the selection carries only whitespace");
  assert.ok(
    wsSelected.rectWidth > 0 && wsSelected.rectHeight > 0,
    "(f) the whitespace selection HAS a real client rect — lastRectOf would NOT reject it, so only the normalizeQuote guard can suppress the trigger",
  );
  // Past the 150 ms selection debounce with margin: a trigger would have shown.
  await page.waitForTimeout(400);
  assert.equal(
    await trigger.count(),
    0,
    "(f) no trigger for a whitespace-only selection (S1 dead-trigger guard, rect-rejection excluded)",
  );

  console.log(
    JSON.stringify(
      { pass: true, composer: await composer.inputValue() },
      null,
      2,
    ),
  );
  console.log(
    "quote-comment e2e: OK — trigger, empty/whitespace confirm, cancel, exact substring paragraph, append-at-end, whitespace guard",
  );
  process.exitCode = 0;
} catch (error) {
  console.error("quote-comment e2e FAILED:", error);
  process.exitCode = 1;
} finally {
  await electronApp?.close();
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
}
