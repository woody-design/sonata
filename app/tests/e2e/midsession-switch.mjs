import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { chooseDraftProvider, sendFirstPrompt, waitForEngagement } from "./helpers/session.mjs";

// Mid-session model/effort switch, end-to-end (S1). Drives a REAL Claude session
// and switches its model via the composer's now-interactive model chip:
//   1. while the cold-start turn runs, the chip is a designed DISABLED state;
//   2. at idle it is interactive and opens the model+effort menu (same visual
//      family as New Chat — Model + Reasoning sections, current value marked; no
//      CLI-default caption — removed S6);
//   3. selecting a model injects `/model <id>` and the chip FOLLOWS the live
//      statusline once the receipt lands (the switch actually took).
//
// A mid-session switch persists `model`/`effortLevel` into ~/.claude/settings.json
// (measured). This test snapshots those two fields and restores them in `finally`
// so it leaves the user's real config as it found it.
const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-midsession-e2e-"));
const evidenceDir = process.env.SONATA_MIDSESSION_EVIDENCE
  ? fs.mkdtempSync(path.join(os.tmpdir(), "sonata-midsession-evidence-"))
  : null;
const claudeSettingsPath = path.join(os.homedir(), ".claude", "settings.json");
const settingsBackup = readClaudeSettingsDefaults();

let electronApp = null;
let page = null;

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      SONATA_DATA_DIR: workspaceRoot,
      SONATA_WORKSPACES_DIR: workspaceRoot,
    },
  });

  page = await electronApp.firstWindow();
  page.setDefaultTimeout(240000);
  await page.locator(".task-entry-panel").waitFor({ state: "visible" });
  await chooseDraftProvider(page, "claude");

  // A prompt that streams for a few seconds (no tool approval) so the running
  // turn is observable — long enough to assert the disabled chip.
  await sendFirstPrompt(page, "Count slowly from 1 to 12, one number per line, then say done.");
  await waitForEngagement(page);

  // (1) DISABLED WHILE RUNNING — the chip is interactive-shaped (Claude) but
  //     inert while the turn is live (turnActivity SSOT; no queueing).
  await page.locator("#send-prompt.stop-mode").waitFor({ state: "attached" });
  const disabledWhileRunning = await page.locator("#model-chip").isDisabled();
  const interactiveWhileRunning = await page
    .locator("#model-chip")
    .evaluate((el) => el.classList.contains("interactive"));
  assert.equal(disabledWhileRunning, true, "the model chip is disabled while the turn runs");
  assert.equal(interactiveWhileRunning, true, "…and keeps the interactive (caret) shape — a designed disabled state");

  // Wait for idle (the turn returned the composer).
  await page.locator("#send-prompt:not(.stop-mode)").waitFor({ state: "attached", timeout: 180000 });

  // (2) INTERACTIVE AT IDLE — enabled, opens the menu.
  const chip = page.locator("#model-chip");
  await chip.waitFor({ state: "visible" });
  assert.equal(await chip.isDisabled(), false, "the model chip is interactive at idle");
  const startingLabel = (await chip.textContent())?.trim() ?? "";

  await chip.click();
  const menu = page.locator(".composer-session-menu");
  await menu.waitFor({ state: "visible" });

  // Menu structure: Model + Reasoning sections (no CLI-default caption — removed
  // S6, field revision 5; the disclosure lives in docs, not menu chrome).
  assert.deepEqual(
    await settingOptionLabels(page, "Model"),
    ["Fable 5", "Opus 5", "Sonnet 5", "Haiku 4.5"],
    "the Model section is the curated list, WITHOUT Native Default (no mid-session meaning)",
  );
  assert.deepEqual(
    await settingOptionLabels(page, "Reasoning"),
    ["Low", "Medium", "High", "Extra High", "Max"],
    "the Reasoning section is the v1 effort set (low → max), WITHOUT Native Default",
  );
  assert.equal(
    await menu.locator(".task-setting-caption").count(),
    0,
    "the CLI-default caption is gone (S6 removal)",
  );

  // (S7 Part 1) The menu is a STAGED selector — a Save/Cancel footer, Save disabled
  // while the staged pair equals current (clean). Staging seeds to the current pair,
  // so on open the current model + effort carry the `selected` badge.
  const footer = menu.locator(".composer-staged-footer");
  await footer.waitFor({ state: "visible" });
  const saveBtn = footer.locator(".composer-staged-action.primary");
  assert.equal(await saveBtn.isDisabled(), true, "Save is disabled while the staged pair == current (clean)");

  const currentModelLabel = await settingSection(page, "Model")
    .locator("button.selected")
    .first()
    .evaluate((el) => el.childNodes.item(0)?.textContent?.trim() ?? "");
  const currentEffortLabel = await settingSection(page, "Reasoning")
    .locator("button.selected")
    .first()
    .evaluate((el) => el.childNodes.item(0)?.textContent?.trim() ?? "");
  assert.ok(currentModelLabel.length > 0, "the current model is marked in the menu");

  if (evidenceDir) {
    await page.screenshot({ path: path.join(evidenceDir, "01-session-model-menu.png") });
  }

  // (S7 verification b) DRAWER NO → CLEAN REVERT, run FIRST (this fresh session's
  // first switch reliably raises the cache-miss dialog). Stage a model, Save → the
  // confirm PARKS in the drawer → answer NO. Nothing changes: the chip holds, no
  // needs-attention banner, and the session is left intact for the Yes demo below
  // (a cancel applies nothing, so the cache is still primed to raise the dialog).
  const noTarget = ["Sonnet 5", "Opus 5", "Haiku 4.5"].find((l) => l !== currentModelLabel);
  await settingSection(page, "Model").locator("button", { hasText: exact(noTarget) }).click();
  await menu.locator(".composer-staged-action.primary").click();
  const noDrawer = page.locator("#control-confirm-card:not(.hidden)");
  await noDrawer.waitFor({ state: "visible", timeout: 30000 });
  assert.ok(
    (await noDrawer.locator(".control-confirm-row", { hasText: `Yes, switch to ${noTarget}` }).count()) > 0,
    "the No-leg drawer surfaces the verbatim Yes/No rows",
  );
  await noDrawer.locator(".control-confirm-row", { hasText: "No, go back" }).click();
  await page.locator("#control-confirm-card.hidden").waitFor({ state: "attached", timeout: 30000 });
  await chip.waitFor({ state: "visible", timeout: 30000 });
  const afterNoLabel = (await chip.textContent())?.trim() ?? "";
  const noRevert = { currentModelLabel, afterNoLabel, unchanged: afterNoLabel.startsWith(currentModelLabel) };
  assert.ok(
    afterNoLabel.startsWith(currentModelLabel),
    `No, go back → the model chip held (${afterNoLabel} still starts with ${currentModelLabel})`,
  );
  assert.equal(
    await page.locator('.attention-banner[data-kind="control-switch"]').isVisible().catch(() => false),
    false,
    "the No path shows no needs-attention banner — the user chose it",
  );

  // (S7 THE DEMO FLOW) Reopen the menu (the No leg closed it) and stage a DIFFERENT
  // model AND a DIFFERENT effort — both axes — then Save applies them as ONE logical
  // switch, the cache-miss confirm relayed through the drawer.
  await chip.click();
  await menu.waitFor({ state: "visible" });
  const targetModel = ["Sonnet 5", "Opus 5", "Haiku 4.5"].find((l) => l !== currentModelLabel);
  const targetEffort = ["Low", "Medium", "High", "Extra High", "Max"].find(
    (l) => l !== currentEffortLabel,
  );
  await settingSection(page, "Model").locator("button", { hasText: exact(targetModel) }).click();
  await settingSection(page, "Reasoning").locator("button", { hasText: exact(targetEffort) }).click();

  // Staged markers: the live value now carries `.is-current` (muted "Current"
  // badge), the staged pick carries `.selected` — visually distinct (S7 Part 1).
  const liveModelRow = settingSection(page, "Model").locator("button.is-current");
  assert.equal(await liveModelRow.count(), 1, "exactly one model row is the muted Current (the live value)");
  assert.equal(
    await liveModelRow.first().evaluate((el) => el.childNodes.item(0)?.textContent?.trim() ?? ""),
    currentModelLabel,
    "the Current-marked model row is the session's live model",
  );
  const stagedModelLabel = await settingSection(page, "Model")
    .locator("button.selected")
    .first()
    .evaluate((el) => el.childNodes.item(0)?.textContent?.trim() ?? "");
  assert.equal(stagedModelLabel, targetModel, "the staged model pick carries the selected badge");
  assert.equal(
    await saveBtn.isDisabled(),
    false,
    "Save enables once the staged pair differs from current",
  );
  if (evidenceDir) {
    await page.screenshot({ path: path.join(evidenceDir, "02-staged.png") });
  }

  // (S7 Part 2) SAVE. On a session WITH history the `/model` inject raises the
  // cache-miss confirm — which PARKS in the Action Drawer (revision 3), NOT a
  // needs-attention banner (the whole point: the dialog stays put, the user answers
  // it in Reading).
  await saveBtn.click();

  const drawer = page.locator("#control-confirm-card:not(.hidden)");
  const followedModel = page.locator("#model-chip", { hasText: targetModel });
  const needsAttention = page.locator('.attention-banner[data-kind="control-switch"]');
  await Promise.race([
    drawer.waitFor({ state: "visible", timeout: 30000 }),
    followedModel.waitFor({ state: "visible", timeout: 30000 }),
    needsAttention.waitFor({ state: "visible", timeout: 30000 }),
  ]);

  let usedDrawer = false;
  if (await drawer.isVisible().catch(() => false)) {
    usedDrawer = true;
    // The drawer surfaces the dialog's rows VERBATIM — the Yes row carries the
    // target's display name (composed from the curated list).
    await drawer.locator(".drawer-title").waitFor({ state: "visible" });
    const yesRow = drawer.locator(".control-confirm-row", {
      hasText: `Yes, switch to ${targetModel}`,
    });
    assert.ok(
      (await yesRow.count()) > 0,
      "the drawer surfaces the CLI's `Yes, switch to <model>` row verbatim",
    );
    assert.ok(
      (await drawer.locator(".control-confirm-row", { hasText: "No, go back" }).count()) > 0,
      "the drawer surfaces the `No, go back` row",
    );
    // No phantom approval card; the drawer OWNS the composer slot while parked
    // (composer card hidden → no send is even reachable — stronger than gating).
    assert.equal(
      await page.locator("#approval-banner").isVisible(),
      false,
      "the cache-miss dialog is not double-surfaced as a phantom approval card",
    );
    assert.equal(
      await page.locator("#composer.drawer-active").count(),
      1,
      "the parked confirm owns the composer slot (composer hidden — send unreachable)",
    );
    assert.equal(
      await page.locator("#prompt-input").isVisible(),
      false,
      "the composer input is hidden while the confirm is parked",
    );
    if (evidenceDir) {
      await page.screenshot({ path: path.join(evidenceDir, "03-drawer.png") });
    }
    // Answer YES in the drawer — the ONLY answer injected (RED LINE). THE demo flow.
    await yesRow.click();
  }

  // The staged EFFORT leg runs after the model leg settles; usually the pending
  // reread suppresses a second dialog (measured), but if one appears it PARKS the
  // same way — drain it FIRST (nothing else answers it), THEN wait for the whole
  // composite to settle (the chip shows the summary with the new model only once
  // controlSwitch clears — i.e. both legs done).
  await drainPendingConfirms(page, 4000, 40000);
  await followedModel.waitFor({ state: "visible", timeout: 60000 });

  const switchedLabel = (await chip.textContent())?.trim() ?? "";
  assert.ok(
    switchedLabel.includes(targetModel),
    `the chip followed the staged Save to ${targetModel}`,
  );
  assert.equal(
    await needsAttention.isVisible().catch(() => false),
    false,
    "no needs-attention banner — the confirm was relayed via the drawer",
  );

  // BOTH axes applied: reopen the menu and confirm the effort leg landed too — its
  // row is now the current/selected value. Reopen-and-poll (the menu re-seeds staged
  // to the live pair each open), robust to the effort leg settling a beat late.
  let effortApplied = false;
  for (let i = 0; i < 40 && !effortApplied; i++) {
    if (!(await menu.isVisible().catch(() => false))) {
      await chip.click().catch(() => {});
    }
    if (await menu.isVisible().catch(() => false)) {
      const label = await settingSection(page, "Reasoning")
        .locator("button.selected")
        .first()
        .evaluate((el) => el.childNodes.item(0)?.textContent?.trim() ?? "")
        .catch(() => "");
      if (label === targetEffort) {
        effortApplied = true;
        break;
      }
      await page.keyboard.press("Escape");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(effortApplied, `the effort leg applied: Reasoning shows ${targetEffort} as current`);
  await page.keyboard.press("Escape").catch(() => {});

  if (evidenceDir) {
    await page.screenshot({ path: path.join(evidenceDir, "04-after-save.png") });
  }

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        evidenceDir,
        disabledWhileRunning,
        interactiveWhileRunning,
        startingLabel,
        currentModelLabel,
        currentEffortLabel,
        targetModel,
        targetEffort,
        noRevert,
        usedDrawer,
        switchedLabel,
        effortApplied,
        success: true,
      },
      null,
      2,
    ),
  );
  process.exitCode = 0;
} catch (error) {
  console.error(
    JSON.stringify(
      {
        error: error instanceof Error ? error.message : String(error),
        workspaceRoot,
        runtimeStatus: page ? await safeText(page.locator("#runtime-status")) : null,
        chipText: page ? await safeText(page.locator("#model-chip")) : null,
        menuVisible: page
          ? await page.locator(".composer-session-menu").isVisible().catch(() => null)
          : null,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  if (electronApp) {
    await electronApp.close();
  }
  restoreClaudeSettingsDefaults(settingsBackup);
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
}

/** Exact-match RegExp for Playwright hasText (so "Opus 5" doesn't also match a
 *  longer superstring). */
function exact(text) {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

function settingSection(page, label) {
  return page
    .locator(".composer-session-menu .task-setting-section")
    .filter({ has: page.locator(".task-setting-heading", { hasText: exact(label) }) });
}

async function settingOptionLabels(page, label) {
  return settingSection(page, label)
    .locator(".task-setting-option")
    .evaluateAll((buttons) =>
      buttons.map((button) => button.childNodes.item(0)?.textContent?.trim() ?? ""),
    );
}

/** Answer every parked recognized-confirm drawer with its affirmative (Yes) row
 *  until none appears for `quietMs` continuously. The staged EFFORT leg may raise
 *  its own cache-miss dialog (rare — the pending reread usually suppresses it), and
 *  it appears a beat after the model leg settles, so a quiet window (not a single
 *  check) is what reliably catches or clears it. */
async function drainPendingConfirms(page, quietMs, maxMs) {
  const deadline = Date.now() + maxMs;
  const drawer = page.locator("#control-confirm-card:not(.hidden)");
  let lastSeen = Date.now();
  while (Date.now() < deadline) {
    if (await drawer.isVisible().catch(() => false)) {
      const yes = drawer.locator(".control-confirm-row", { hasText: "Yes, switch to" }).first();
      // Tolerant click: the model drawer may be mid-CLOSE when we arrive (already
      // answered in the main flow), so a detaching element must not hang the drain.
      // A short timeout + catch lets the loop fall through to the quiet-period exit.
      if ((await yes.count().catch(() => 0)) > 0) {
        await yes.click({ timeout: 2500 }).catch(() => {});
      }
      lastSeen = Date.now();
    } else if (Date.now() - lastSeen > quietMs) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function safeText(locator) {
  try {
    return await locator.textContent({ timeout: 1000 });
  } catch {
    return null;
  }
}

/** Read the two fields a mid-session switch persists globally, so the test can
 *  restore them. Returns `{ present, model, effortLevel }`. */
function readClaudeSettingsDefaults() {
  try {
    const parsed = JSON.parse(fs.readFileSync(claudeSettingsPath, "utf8"));
    return {
      present: true,
      model: Object.prototype.hasOwnProperty.call(parsed, "model") ? parsed.model : undefined,
      effortLevel: Object.prototype.hasOwnProperty.call(parsed, "effortLevel")
        ? parsed.effortLevel
        : undefined,
    };
  } catch {
    return { present: false };
  }
}

function restoreClaudeSettingsDefaults(backup) {
  if (!backup?.present) {
    return;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(claudeSettingsPath, "utf8"));
    setOrDelete(parsed, "model", backup.model);
    setOrDelete(parsed, "effortLevel", backup.effortLevel);
    fs.writeFileSync(claudeSettingsPath, `${JSON.stringify(parsed, null, 2)}\n`);
  } catch {
    // Best-effort restore; the harness also keeps a file backup in scratchpad.
  }
}

function setOrDelete(object, key, value) {
  if (value === undefined) {
    delete object[key];
  } else {
    object[key] = value;
  }
}
