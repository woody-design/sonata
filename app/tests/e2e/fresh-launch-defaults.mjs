import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { chooseDraftProvider, waitForWindowByUrl } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-fresh-defaults-workspace-"));
const settingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-fresh-defaults-settings-"));
const sonataSettingsPath = path.join(settingsRoot, "sonata-settings.json");
const codexSettingsPath = path.join(settingsRoot, "codex-settings.json");
let app = null;

try {
  // Launch 1: no settings files means the product defaults are authoritative.
  let page = await launch();
  await assertNewChatDefault(page, "Claude", "Opus 5 High");
  await assertFreshAppearance(page);

  await openSettings();
  const defaultModelGroup = page.locator('section[aria-label="Default model"]');
  const providerRow = defaultModelGroup.locator(".settings-row", {
    hasText: "Default provider",
  });
  const providerPopup = providerRow.locator(".settings-popup");
  await providerPopup.filter({ hasText: "Claude" }).waitFor({ state: "visible" });

  const codexRow = defaultModelGroup.locator(".settings-row", {
    hasText: "Codex model & effort",
  });
  await codexRow.locator(".settings-popup").click();
  const codexMenu = codexRow.locator(".settings-popup-menu");
  await codexMenu.locator(".settings-popup-option", { hasText: "5.6 Luna" }).click();
  await codexMenu.locator(".settings-popup-option", { hasText: "Extra High" }).click();
  await page.locator(".settings-title").click();

  await providerPopup.click();
  await providerRow.locator(".settings-popup-option", { hasText: "Codex" }).click();
  await waitUntil(
    () =>
      readJson(sonataSettingsPath)?.defaultProvider === "codex" &&
      readJson(codexSettingsPath)?.defaultModel === "gpt-5.6-luna" &&
      readJson(codexSettingsPath)?.defaultReasoningEffort === "xhigh",
  );

  await app.close();
  app = null;

  // Launch 2: the explicit Settings choices override the fresh-install defaults.
  page = await launch();
  await assertNewChatDefault(page, "Codex", "5.6 Luna Extra High");
  await assertFreshAppearance(page);
  await chooseDraftProvider(page, "claude");
  await page.locator("#model-chip", { hasText: "Opus 5 High" }).waitFor({
    state: "visible",
  });

  assert.deepEqual(readJson(sonataSettingsPath), { defaultProvider: "codex" });
  assert.equal(readJson(codexSettingsPath)?.defaultModel, "gpt-5.6-luna");
  assert.equal(readJson(codexSettingsPath)?.defaultReasoningEffort, "xhigh");

  console.log(
    JSON.stringify(
      {
        fresh: {
          provider: "claude",
          model: "opus",
          effort: "high",
          mainMode: "light",
          cliMode: "dark",
        },
        persisted: {
          provider: "codex",
          codexModel: "gpt-5.6-luna",
          codexEffort: "xhigh",
        },
        success: true,
      },
      null,
      2,
    ),
  );
} finally {
  if (app) await app.close();
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(settingsRoot, { recursive: true, force: true });
}

async function launch() {
  app = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      SONATA_DATA_DIR: workspaceRoot,
      SONATA_WORKSPACES_DIR: workspaceRoot,
      SONATA_SETTINGS_DIR: settingsRoot,
      SONATA_NOTIFICATIONS: "0",
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await page.locator(".task-entry-panel").waitFor({ state: "visible" });
  return page;
}

async function openSettings() {
  await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById("settings");
    if (!item) throw new Error("Settings menu item is missing");
    item.click();
  });
}

async function assertNewChatDefault(page, provider, model) {
  await page.locator("#provider-chip", { hasText: provider }).waitFor({ state: "visible" });
  await page.locator("#model-chip", { hasText: model }).waitFor({ state: "visible" });
}

async function assertFreshAppearance(page) {
  await page.locator('html[data-reading-mode-setting="light"][data-mode="light"]').waitFor({
    state: "attached",
  });
  const cli = await waitForWindowByUrl(app, "terminal.html");
  cli.setDefaultTimeout(30000);
  await cli.locator('html[data-mode="dark"]').waitFor({ state: "attached" });
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function waitUntil(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for settings persistence");
}
