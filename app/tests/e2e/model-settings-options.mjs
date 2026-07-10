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

  await page.locator("#model-chip", { hasText: "Opus 4.8 Extra High" }).click();
  assert.deepEqual(await settingOptionLabels(page, "Model"), [
    "Fable 5",
    "Opus 4.8",
    "Sonnet 5",
    "Haiku 4.5",
    "Native Default",
  ]);

  await chooseDraftProvider(page, "codex");
  await page.locator("#model-chip", { hasText: "5.6 Sol Extra High" }).click();
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
  assert.deepEqual(await settingOptionLabels(page, "Reasoning"), [
    "Light",
    "Medium",
    "High",
    "Extra High",
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
  assert.equal(
    (await settingOptionLabels(page, "Reasoning")).includes("Ultra"),
    false,
    "switching to Luna removes Ultra and falls back to Extra High",
  );

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
