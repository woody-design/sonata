import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { chooseDraftProvider } from "./helpers/session.mjs";

// Pure launch-settings UI regression: no provider process is started and no
// model call is made. The test pins the current native option order while
// preserving Duet's existing single-popover architecture.
const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-model-options-e2e-"));
let electronApp = null;

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      DUET_DATA_DIR: workspaceRoot,
      DUET_WORKSPACES_DIR: workspaceRoot,
    },
  });
  const page = await electronApp.firstWindow();
  await page.locator(".task-entry-panel", { hasText: "What should we work on" }).waitFor({
    state: "visible",
  });

  await page.locator("#model-chip", { hasText: "Opus 4.8 High" }).click();
  assert.deepEqual(await settingOptionLabels(page, "Model"), [
    "Fable 5",
    "Opus 4.8",
    "Sonnet 5",
    "Haiku 4.5",
    "Native Default",
  ]);

  // Claude launch Speed (S3): native fast mode is Opus-only. The default draft
  // model is Opus, so the Speed section is offered with both options.
  assert.deepEqual(
    await settingOptionLabels(page, "Speed"),
    ["Standard", "Fast"],
    "Claude Opus offers the Speed section with Fast",
  );
  // Select Fast, then verify the model-switch unwind: switching Opus→Sonnet must
  // drop the now-unsupported `fast` back to Standard AND remove the section
  // entirely (a lone "Standard" is no real choice). The chip must NOT carry
  // "Fast" after the switch — that is the passes-while-broken hole S1 warned of.
  await settingSection(page, "Speed").locator("button", { hasText: "Fast" }).click();
  await page.locator("#model-chip", { hasText: "Opus 4.8 High Fast" }).waitFor({ state: "visible" });
  await settingSection(page, "Model").locator("button", { hasText: "Sonnet 5" }).click();
  await page.locator("#model-chip", { hasText: "Sonnet 5 High" }).waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#model-chip").textContent(),
    "Sonnet 5 High",
    "switching Opus→Sonnet unwinds Fast (no 'Fast' left on the chip)",
  );
  assert.equal(
    await page.locator(".task-setting-heading", { hasText: "Speed" }).count(),
    0,
    "non-Opus Claude hides the Speed section entirely",
  );
  // Switching back to Opus re-offers the section, now at the unwound Standard.
  await settingSection(page, "Model").locator("button", { hasText: "Opus 4.8" }).click();
  await page.locator("#model-chip", { hasText: "Opus 4.8 High" }).waitFor({ state: "visible" });
  const reofferedSpeed = await settingOptionLabels(page, "Speed");
  assert.deepEqual(reofferedSpeed, ["Standard", "Fast"], "Opus re-offers the Speed section");
  const selectedSpeed = await settingSection(page, "Speed")
    .locator("button.selected")
    .evaluate((button) => button.childNodes.item(0)?.textContent?.trim() ?? "");
  assert.equal(
    selectedSpeed,
    "Standard",
    "Fast did not survive the round-trip through a non-fast model",
  );

  await chooseDraftProvider(page, "codex");
  await page.locator("#model-chip", { hasText: "5.6 Sol High" }).click();
  assert.deepEqual(await settingOptionLabels(page, "Model"), [
    "5.6 Sol",
    "5.6 Terra",
    "5.6 Luna",
    "5.5",
    "5.4",
    "5.4 Mini",
    "5.3 Codex Spark",
    "Native Default",
  ]);
  // Sol offers both gated top tiers (Max between Extra High and Ultra) — codex
  // 0.144.4 /model picker, spikes/codex-effort-max-ultra/.
  assert.deepEqual(await settingOptionLabels(page, "Reasoning"), [
    "Light",
    "Medium",
    "High",
    "Extra High",
    "Max",
    "Ultra",
    "Native Default",
  ]);
  assert.deepEqual(await settingOptionLabels(page, "Speed"), ["Standard", "Fast"]);
  if (process.env.DUET_TEST_SCREENSHOT) {
    await page.screenshot({ path: process.env.DUET_TEST_SCREENSHOT });
  }

  await settingSection(page, "Reasoning").locator("button", { hasText: "Ultra" }).click();
  await page.locator("#model-chip", { hasText: "5.6 Sol Ultra" }).waitFor({ state: "visible" });
  await settingSection(page, "Model").locator("button", { hasText: "5.6 Luna" }).click();
  await page.locator("#model-chip", { hasText: "5.6 Luna Extra High" }).waitFor({
    state: "visible",
  });
  const lunaReasoning = await settingOptionLabels(page, "Reasoning");
  assert.equal(
    lunaReasoning.includes("Ultra"),
    false,
    "switching to Luna removes Ultra and falls back to Extra High",
  );
  assert.equal(
    lunaReasoning.includes("Max"),
    true,
    "Luna keeps Max (offers Max but not Ultra)",
  );

  // Max-fallback path (distinct from the Ultra-fallback above): pick Max on
  // Luna, then switch to a model that offers NEITHER gated tier. If the
  // model-change fallback in renderer/main.ts only unwound `ultra`, Max would
  // survive here as an unsupported launch combination.
  await settingSection(page, "Reasoning").locator("button", { hasText: "Max" }).click();
  await page.locator("#model-chip", { hasText: "5.6 Luna Max" }).waitFor({ state: "visible" });
  await settingSection(page, "Model").locator("button", { hasText: /^5\.4$/ }).click();
  await page.locator("#model-chip", { hasText: "5.4 Extra High" }).waitFor({ state: "visible" });
  const fiveFourReasoning = await settingOptionLabels(page, "Reasoning");
  assert.equal(
    fiveFourReasoning.includes("Max"),
    false,
    "switching to 5.4 removes Max and falls back to Extra High",
  );
  assert.equal(fiveFourReasoning.includes("Ultra"), false, "5.4 offers no Ultra either");

  console.log(
    JSON.stringify(
      {
        claudeModels: ["Fable 5", "Opus 4.8", "Sonnet 5", "Haiku 4.5"],
        codexModels: [
          "5.6 Sol",
          "5.6 Terra",
          "5.6 Luna",
          "5.5",
          "5.4",
          "5.4 Mini",
          "5.3 Codex Spark",
        ],
        ultraFallback: "5.6 Luna Extra High",
        maxFallback: "5.4 Extra High",
        success: true,
      },
      null,
      2,
    ),
  );
} finally {
  if (electronApp) {
    await electronApp.close();
  }
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
}

function settingSection(page, heading) {
  return page.locator(".task-setting-heading", { hasText: heading }).locator("..");
}

async function settingOptionLabels(page, heading) {
  return settingSection(page, heading)
    .locator("button")
    .evaluateAll((buttons) =>
      buttons.map((button) => button.childNodes.item(0)?.textContent?.trim() ?? ""),
    );
}
