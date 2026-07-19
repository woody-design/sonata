import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { chooseDraftProvider } from "./helpers/session.mjs";

// The EFFECT half of "Default model" settings (effect-vs-artifact): pre-write
// the three settings files in the fixture dir, boot the app, and assert the New
// Chat chips wear the PERSISTED defaults — not merely that the JSON was written.
//
// The codex fixture pairs gpt-5.4 with the gated `ultra` tier (a hand-editable
// but invalid combination): copy-at-entry seeding must clamp it through
// reasoningOptionsForModel, so the chip reads "Extra High", never "Ultra".

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-default-model-seed-workspace-"));
const settingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-default-model-seed-store-"));
let electronApp = null;

try {
  fs.writeFileSync(
    path.join(settingsRoot, "sonata-settings.json"),
    `${JSON.stringify({ defaultProvider: "codex" }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(settingsRoot, "claude-settings.json"),
    `${JSON.stringify(
      {
        defaultPermissionMode: "default",
        defaultRemoteControl: false,
        defaultModel: "sonnet",
        defaultReasoningEffort: "medium",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(settingsRoot, "codex-settings.json"),
    `${JSON.stringify(
      { defaultModel: "gpt-5.4", defaultReasoningEffort: "ultra" },
      null,
      2,
    )}\n`,
    "utf8",
  );

  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      SONATA_DATA_DIR: workspaceRoot,
      SONATA_WORKSPACES_DIR: workspaceRoot,
      SONATA_SETTINGS_DIR: settingsRoot,
    },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(60000);
  await page.locator(".task-entry-panel", { hasText: "What should we work on" }).waitFor({
    state: "visible",
  });

  // Provider seeded from sonata-settings.json → the draft opens on Codex.
  await page.locator("#provider-chip", { hasText: "Codex" }).waitFor({ state: "visible" });

  // Codex model chip: gpt-5.4 → "5.4"; the gated `ultra` clamps to Extra High.
  await page.locator("#model-chip", { hasText: "5.4 Extra High" }).waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#model-chip").textContent(),
    "5.4 Extra High",
    "the gated Ultra tier never survives seeding onto a model that can't accept it",
  );

  // The Claude seed proves independently: switching the draft to Claude shows
  // its persisted model + effort (medium is un-gated, so it passes through).
  await chooseDraftProvider(page, "claude");
  await page.locator("#model-chip", { hasText: "Sonnet 5 Medium" }).waitFor({ state: "visible" });

  console.log(
    JSON.stringify(
      {
        codexChip: "5.4 Extra High",
        claudeChip: "Sonnet 5 Medium",
        provider: "codex",
        success: true,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (electronApp) {
    await electronApp.close();
  }
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(settingsRoot, { recursive: true, force: true });
}
