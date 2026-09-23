import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { chooseDraftProvider } from "./helpers/session.mjs";

// Pure launch-settings UI regression: no provider process is started and no
// model call is made. The test pins the current native option order while
// preserving Sonata's existing single-popover architecture.
const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-model-options-e2e-"));
let electronApp = null;

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      SONATA_DATA_DIR: workspaceRoot,
      SONATA_WORKSPACES_DIR: workspaceRoot,
    },
  });
  const page = await electronApp.firstWindow();
  await page.locator(".task-entry-panel", { hasText: "What should we work on" }).waitFor({
    state: "visible",
  });

  await page.locator("#model-chip", { hasText: "Opus 5.5 High" }).click();
  // The labels are the CLI's own display names, MEASURED at claude 2.1.280
  // (probe q38: boot banner + statusline `model.display_name` per alias). Both
  // Opus aliases float with the server — "Opus 5…" at 2.1.258, "Opus 5.5…" now.
  assert.deepEqual(await settingOptionLabels(page, "Model"), [
    "Fable 5.1",
    "Opus 5.5 (1M context)",
    "Opus 5.5",
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
  // …and the 1M variant is Opus too (probe q15 at 2.1.258, re-measured by q38 at
  // 2.1.280: it accepts the same fastMode injection). `/^Opus 5\.5 \(1M context\)$/`
  // rather than a substring: two rows start with "Opus 5.5", so an unanchored
  // locator is ambiguous.
  await settingSection(page, "Model")
    .locator("button", { hasText: /^Opus 5\.5 \(1M context\)$/ })
    .click();
  await page.locator("#model-chip", { hasText: "Opus 5.5 (1M context) High" }).waitFor({
    state: "visible",
  });
  assert.deepEqual(
    await settingOptionLabels(page, "Speed"),
    ["Standard", "Fast"],
    "Claude Opus (1M context) offers the Speed section with Fast too",
  );
  await settingSection(page, "Model").locator("button", { hasText: /^Opus 5\.5$/ }).click();
  await page.locator("#model-chip", { hasText: "Opus 5.5 High" }).waitFor({ state: "visible" });
  // Select Fast, then verify the model-switch unwind: switching Opus→Sonnet must
  // drop the now-unsupported `fast` back to Standard AND remove the section
  // entirely (a lone "Standard" is no real choice). The chip must NOT carry
  // "Fast" after the switch — that is the passes-while-broken hole S1 warned of.
  await settingSection(page, "Speed").locator("button", { hasText: "Fast" }).click();
  await page.locator("#model-chip", { hasText: "Opus 5.5 High Fast" }).waitFor({ state: "visible" });
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
  await settingSection(page, "Model").locator("button", { hasText: /^Opus 5\.5$/ }).click();
  await page.locator("#model-chip", { hasText: "Opus 5.5 High" }).waitFor({ state: "visible" });
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
  await page.locator("#model-chip", { hasText: "6 Astra High" }).click();
  // The live picker's rows at codex 0.156.1 (q39/q39b), minus the pruned GPT-5.5.
  assert.deepEqual(await settingOptionLabels(page, "Model"), [
    "6 Astra",
    "6 Sol",
    "6 Luna",
    "5.6 Sol",
    "5.6 Terra",
    "5.6 Luna",
    "Native Default",
  ]);
  // Astra offers both gated top tiers (Max between Extra High and Ultra) —
  // its `More reasoning…` submenu, re-measured at codex 0.156.1 (q39b).
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
  if (process.env.SONATA_TEST_SCREENSHOT) {
    await page.screenshot({ path: process.env.SONATA_TEST_SCREENSHOT });
  }

  await settingSection(page, "Reasoning").locator("button", { hasText: "Ultra" }).click();
  await page.locator("#model-chip", { hasText: "6 Astra Ultra" }).waitFor({ state: "visible" });
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
  // Luna, then switch to a choice that offers NEITHER gated tier. If the
  // model-change fallback in renderer/main.ts only unwound `ultra`, Max would
  // survive here as an unsupported launch combination. Since codex 0.156.1 every
  // served row offers Max (q39b; gpt-5.5, the last row without it, is pruned),
  // so Native Default is the one choice left that offers neither — Sonata cannot
  // know which model it resolves to, so it promises no gated tier.
  await settingSection(page, "Reasoning").locator("button", { hasText: "Max" }).click();
  await page.locator("#model-chip", { hasText: "5.6 Luna Max" }).waitFor({ state: "visible" });
  await settingSection(page, "Model").locator("button", { hasText: "Native Default" }).click();
  await page.locator("#model-chip", { hasText: "Default Extra High" }).waitFor({ state: "visible" });
  const nativeDefaultReasoning = await settingOptionLabels(page, "Reasoning");
  assert.equal(
    nativeDefaultReasoning.includes("Max"),
    false,
    "switching to Native Default removes Max and falls back to Extra High",
  );
  assert.equal(nativeDefaultReasoning.includes("Ultra"), false, "Native Default offers no Ultra either");

  console.log(
    JSON.stringify(
      {
        claudeModels: ["Fable 5.1", "Opus 5.5 (1M context)", "Opus 5.5", "Sonnet 5", "Haiku 4.5"],
        codexModels: ["6 Astra", "6 Sol", "6 Luna", "5.6 Sol", "5.6 Terra", "5.6 Luna"],
        ultraFallback: "5.6 Luna Extra High",
        maxFallback: "Default Extra High",
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
