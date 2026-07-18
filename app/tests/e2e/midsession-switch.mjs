import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { sendFirstPrompt, waitForEngagement } from "./helpers/session.mjs";

// Mid-session model/effort switch, end-to-end (S1). Drives a REAL Claude session
// and switches its model via the composer's now-interactive model chip:
//   1. while the cold-start turn runs, the chip is a designed DISABLED state;
//   2. at idle it is interactive and opens the model+effort menu (same visual
//      family as New Chat — Model + Reasoning sections + the CLI-default caption,
//      current value marked);
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
  const projectsDir = path.join(workspaceRoot, "data", "projects");

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

  // Menu structure: Model + Reasoning sections and the CLI-default caption.
  assert.deepEqual(
    await settingOptionLabels(page, "Model"),
    ["Fable 5", "Opus 4.8", "Sonnet 5", "Haiku 4.5"],
    "the Model section is the curated list, WITHOUT Native Default (no mid-session meaning)",
  );
  assert.deepEqual(
    await settingOptionLabels(page, "Reasoning"),
    ["Low", "Medium", "High", "Extra High", "Max"],
    "the Reasoning section is the v1 effort set (low → max), WITHOUT Native Default",
  );
  const captionText = (await menu.locator(".task-setting-caption").textContent())?.trim();
  assert.match(
    captionText ?? "",
    /default for sessions outside/i,
    "the caption notes the CLI-default side effect",
  );

  // Current model is marked selected in the menu.
  const selectedModelLabel = (
    await settingSection(page, "Model").locator("button.selected").first().evaluate(
      (el) => el.childNodes.item(0)?.textContent?.trim() ?? "",
    )
  );
  assert.ok(selectedModelLabel.length > 0, "the current model is marked in the menu");

  if (evidenceDir) {
    await page.screenshot({ path: path.join(evidenceDir, "01-session-model-menu.png") });
  }

  // (3) DRIVE A REAL SWITCH — pick a DIFFERENT model. Two probe-verified outcomes,
  //     both valid, both proving the injection was driven AND observed:
  //       - clean settle → the chip follows the statusline immediately; OR
  //       - the CLI pops its cache-miss confirm ("the full history gets re-read…
  //         Yes / No") → the RED LINE fires: a needs-attention banner, Sonata does
  //         NOTHING (never auto-answers). The switch completes only once the USER
  //         answers in the CLI — which this test then simulates.
  const target = ["Sonnet 5", "Opus 4.8", "Haiku 4.5"].find(
    (label) => label !== selectedModelLabel,
  );
  await settingSection(page, "Model").locator("button", { hasText: exact(target) }).click();

  const followed = page.locator("#model-chip", { hasText: target });
  const needsAttention = page.locator('.attention-banner[data-kind="control-switch"]');
  await Promise.race([
    followed.waitFor({ state: "visible", timeout: 30000 }),
    needsAttention.waitFor({ state: "visible", timeout: 30000 }),
  ]);

  let sawNeedsAttention = false;
  if (await needsAttention.isVisible().catch(() => false)) {
    // RED LINE path (cache-miss confirm). Screenshot the banner, then play the
    // user answering natively in the terminal (Enter selects the default "Yes").
    // This is the TEST simulating the user — Sonata itself never answers.
    sawNeedsAttention = true;
    if (evidenceDir) {
      await page.screenshot({ path: path.join(evidenceDir, "02-needs-attention.png") });
    }
    // (S5 item F) Double-surface check: the cache-miss confirm dialog is a plain
    // TUI select prompt (about re-reading history), NOT a tool-approval panel — its
    // prose carries none of parseClaudeApprovalPanel's anchors (do-you-want-to /
    // quick-safety-check / by-proceeding-you-accept), so the approval scrape must
    // NOT mis-read it as a phantom approval card alongside the designed banner.
    // Empirically confirmed here on the real CLI: the approval banner stays hidden.
    assert.equal(
      await page.locator("#approval-banner").isVisible(),
      false,
      "F: the cache-miss dialog is not double-surfaced as a phantom approval card",
    );
    // Send is gated while the switch is unresolved (review fix A): the CLI's
    // Yes/No confirm is still on screen, so a send here would bracket-paste into
    // it. Type text FIRST so the empty-composer disable can't mask the result —
    // the switch gate must be the ONLY reason send stays disabled.
    await page.locator("#prompt-input").fill("this must not send into the confirm dialog");
    assert.equal(
      await page.locator("#send-prompt").isDisabled(),
      true,
      "send is gated (with a non-empty composer) while the switch is unresolved",
    );
    await page.locator("#prompt-input").fill("");
    const taskId = await waitForTaskId(projectsDir, 30000);
    await page.evaluate(
      ({ id }) => window.sonataRuntime.writeTerminalUserInput({ taskId: id, data: "\r" }),
      { id: taskId },
    );
  }

  // Either way, the chip must end up following the live model via the statusline
  // mirror — the switch actually took effect (verification 3b).
  await followed.waitFor({ state: "visible", timeout: 60000 });
  const switchedLabel = (await chip.textContent())?.trim() ?? "";
  assert.ok(switchedLabel.includes(target), `the chip followed the /model switch to ${target}`);

  if (evidenceDir) {
    await page.screenshot({ path: path.join(evidenceDir, "03-after-model-switch.png") });
  }

  // (S5 item D) Auto-clear on confirmed landing: once the statusline mirror (the
  // SSOT) confirmed the switched model — the chip followed, above — the lingering
  // needs-attention banner clears ITSELF, no manual dismiss, so it never reads
  // "Confirm the switch…" while the chip already shows the new model. Send
  // re-enables in the same paint. Only meaningful on the RED LINE path (a banner
  // existed to clear); on a clean settle there was never a banner.
  let bannerAutoCleared = null;
  if (sawNeedsAttention) {
    await needsAttention.waitFor({ state: "detached", timeout: 15000 });
    bannerAutoCleared = true;
    await page.locator("#prompt-input").fill("now this should be sendable");
    assert.equal(
      await page.locator("#send-prompt").isDisabled(),
      false,
      "D: send re-enables once the statusline auto-clears the switch pointer",
    );
    await page.locator("#prompt-input").fill("");
  }

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        evidenceDir,
        disabledWhileRunning,
        interactiveWhileRunning,
        startingLabel,
        selectedModelLabel,
        target,
        sawNeedsAttention,
        bannerAutoCleared,
        switchedLabel,
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

/** Exact-match RegExp for Playwright hasText (so "Opus 4.8" doesn't also match a
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

/** The session's taskId is the directory name Sonata creates under data/projects
 *  (deferred creation — it appears once the first prompt lands). */
async function waitForTaskId(projectsDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let entry = null;
    try {
      entry = fs
        .readdirSync(projectsDir, { withFileTypes: true })
        .find((item) => item.isDirectory())?.name;
    } catch {
      entry = null;
    }
    if (entry) {
      return entry;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the session's task directory.");
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
