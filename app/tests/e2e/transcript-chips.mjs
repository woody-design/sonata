// Transcript file chips (Preview Window Redesign, S4 — design record §5.6, R2).
//
// Drives the built app end-to-end and exercises the Reading-window chip entry:
//   - an assistant reply that mentions an EXISTING file in inline code renders
//     a chip (data-chip-path hook)
//   - a mention of a NON-EXISTENT path stays plain inline code (no chip)
//   - the chip survives a later turn's transcript re-render (reconcile reuse:
//     the card's node identity is preserved, the chip rides along)
//   - clicking the chip opens the Preview window with that file as the active
//     tab (cross-window assertion)
//   - a chip whose file was since DELETED opens the tombstone, not an error
//     (chips are entry points, not state — stale is correct three-truths)
//
// The reply is produced by the real provider (as in preview-reader.mjs): the
// task is born from the first prompt, fixtures are written into its real
// providerCwd, and the chip-bearing reply is an exact-echo the model reproduces
// verbatim (backticks preserved → marked renders <code>). Assertions locate the
// code spans by text, so prose variation around them can't destabilize them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { _electron as electron } from "playwright-core";
import {
  activeSessionTaskId,
  sendFirstPrompt,
  sendPrompt,
  waitForCompletedTurns,
  waitForWindowByUrl,
} from "./helpers/session.mjs";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-transcript-chips-e2e-"));
const launchEnv = {
  ...process.env,
  DUET_DATA_DIR: dataRoot,
  DUET_WORKSPACES_DIR: dataRoot,
  DUET_SETTINGS_DIR: path.join(dataRoot, "config"),
};

const results = {};
let app = null;
try {
  app = await electron.launch({ args: ["dist/main/main.js"], env: launchEnv });
  const page = await app.firstWindow();
  page.setDefaultTimeout(180000);

  // ── Turn 1: birth the task ───────────────────────────────────────────────
  await sendFirstPrompt(page, [
    "Reply exactly DUET_CHIPS_READY.",
    "Do not create or modify any files.",
  ]);
  const taskId = await activeSessionTaskId(page);
  if (!taskId) {
    throw new Error("Sidebar session did not expose a task id.");
  }
  await waitForCompletedTurns(page, 1);

  const workspace = JSON.parse(
    fs.readFileSync(path.join(dataRoot, "data", "projects", taskId, "task.json"), "utf8"),
  ).task.providerCwd;
  if (!workspace || !fs.existsSync(workspace)) {
    throw new Error(`Manifest providerCwd is not an existing directory: ${workspace}`);
  }

  // ── Fixtures: two real files the chips must resolve to ────────────────────
  fs.writeFileSync(path.join(workspace, "README.md"), "# Readme\n\nThe readme body.\n");
  fs.writeFileSync(path.join(workspace, "doomed.ts"), "export const doomed = true;\n");

  // ── Turn 2: a reply that mentions all three in inline code ────────────────
  await sendPrompt(page, [
    "Reply with exactly this text, preserving every backtick character, and nothing else:",
    "Open `README.md` and `doomed.ts` to begin. The file `nope.ts` does not exist yet.",
  ]);
  await waitForCompletedTurns(page, 2);

  // Existing files resolve → chips (data-chip-path is the contract hook).
  const readmeChip = page.locator('code[data-chip-path="README.md"]');
  const doomedChip = page.locator('code[data-chip-path="doomed.ts"]');
  await readmeChip.first().waitFor({ state: "visible", timeout: 30000 });
  await doomedChip.first().waitFor({ state: "visible", timeout: 30000 });
  results.existingFileBecomesChip = (await readmeChip.count()) >= 1 && (await doomedChip.count()) >= 1;

  // The chip carries a Lucide type icon + the filename, and is keyboard-openable.
  results.chipHasIconAndName = await readmeChip.first().evaluate((el) => {
    const icon = el.querySelector("svg");
    const name = el.querySelector(".transcript-file-chip-name");
    return Boolean(
      icon &&
        name &&
        name.textContent === "README.md" &&
        el.getAttribute("role") === "button" &&
        el.getAttribute("tabindex") === "0" &&
        el.classList.contains("transcript-file-chip"),
    );
  });

  // The non-existent mention is a <code> that never became a chip. Waiting on
  // the README chip above already proved resolution ran, so nope.ts is settled.
  const nopeCode = page.locator("code", { hasText: "nope.ts" }).first();
  await nopeCode.waitFor({ state: "visible", timeout: 30000 });
  results.nonexistentStaysPlain = await nopeCode.evaluate(
    (el) => !el.hasAttribute("data-chip-path") && !el.classList.contains("transcript-file-chip"),
  );

  // ── Re-render survival: stamp turn 2's card, add a turn, confirm both the
  //    node identity AND the chip survived (reconcile reused the card). ──────
  await page.evaluate(() => {
    const cards = document.querySelectorAll(".turn-card");
    cards[cards.length - 1]?.setAttribute("data-chip-e2e-marker", "turn2");
  });
  await sendPrompt(page, ["Reply exactly DUET_CHIPS_TURN3."]);
  await waitForCompletedTurns(page, 3);
  results.chipSurvivesReRender = await page.evaluate(() => {
    const card = document.querySelector('[data-chip-e2e-marker="turn2"]');
    return Boolean(card && card.querySelector('code[data-chip-path="README.md"]'));
  });

  // ── Chip click opens the Preview window with that file active ─────────────
  await readmeChip.first().click();
  const preview = await waitForWindowByUrl(app, "preview.html");
  preview.setDefaultTimeout(60000);
  await preview
    .locator('.preview-tab[data-active="true"]:has-text("README.md")')
    .waitFor({ state: "visible" });
  await preview
    .locator('.preview-doc[data-doc-kind="markdown"] .preview-md h1', { hasText: "Readme" })
    .waitFor({ state: "visible" });
  results.chipClickOpensPreview = true;

  // ── A since-deleted file's chip opens the tombstone, not an error ─────────
  fs.rmSync(path.join(workspace, "doomed.ts"));
  await doomedChip.first().click();
  await preview
    .locator('.preview-tab[data-active="true"]:has-text("doomed.ts")')
    .waitFor({ state: "visible" });
  await preview
    .locator(".preview-tombstone", { hasText: "no longer exists" })
    .waitFor({ state: "visible", timeout: 15000 });
  results.staleChipOpensTombstone = true;

  const success = Object.values(results).every(Boolean);
  console.log(JSON.stringify({ dataRoot, taskId, workspace, results, success }, null, 2));
  assert.ok(success, "all transcript-chips checks passed");
  console.log("transcript-chips e2e: OK — inline-code mentions become Preview entries");
  process.exitCode = 0;
} catch (error) {
  console.error("transcript-chips e2e threw:", error);
  console.log(JSON.stringify({ results }, null, 2));
  process.exitCode = 1;
} finally {
  if (app) {
    await app.close();
  }
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
