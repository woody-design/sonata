import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";

// The Settings page (centered overlay): menu entrance, moment-born
// provenance display + retirement on page revision, threshold row description,
// and the Claude bridge row (visibility-first, restore-on-click).
// HOME is pointed at a temp dir so ~/.claude.json is hermetic.

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-settings-overlay-workspace-"));
const settingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-settings-overlay-store-"));
const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-settings-overlay-home-"));
const resumeSettingsPath = path.join(settingsRoot, "resume-settings.json");
const claudeSettingsPath = path.join(settingsRoot, "claude-settings.json");
const codexSettingsPath = path.join(settingsRoot, "codex-settings.json");
const claudeConfigPath = path.join(homeRoot, ".claude.json");
let electronApp = null;

try {
  // Moment-born default, as the resume chooser would have written it.
  fs.writeFileSync(
    resumeSettingsPath,
    `${JSON.stringify(
      {
        policy: "summary",
        provenance: { source: "moment", at: "2026-06-12T08:00:00.000Z" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // A pre-existing LEGACY codex default (`-a on-failure`, retired on 0.144)
  // migrates on read to the permission vocabulary — by ask-frequency intent and
  // never escalating: on-failure → "Ask for approval".
  fs.writeFileSync(
    codexSettingsPath,
    `${JSON.stringify({ defaultApprovalMode: "on-failure" }, null, 2)}\n`,
    "utf8",
  );

  const page = await launchApp();
  await page.locator(".task-entry-panel", { hasText: "What should we work on" }).waitFor({
    state: "visible",
  });

  // Entrance: the real App-menu item (the same path ⌘, takes).
  await openSettingsFromMenu();
  await page.locator(".settings-window").waitFor({ state: "visible" });

  // Moment-born state renders with attribution + threshold disclosure.
  const popup = page.locator('section[aria-label="Sessions"] .settings-popup');
  await popup.filter({ hasText: "Resume from summary" }).waitFor({ state: "visible" });
  const provenanceNote = page.locator(".settings-row-note", {
    hasText: "Set from the resume chooser",
  });
  await provenanceNote.waitFor({ state: "visible" });
  const provenanceText = await provenanceNote.textContent();
  if (!provenanceText.includes("2026")) {
    throw new Error(`Provenance line is missing the date: ${provenanceText}`);
  }
  const rowDesc = await page
    .locator('section[aria-label="Sessions"] .settings-row-desc')
    .textContent();
  if (!rowDesc.includes("70 minutes") || !rowDesc.includes("100k tokens")) {
    throw new Error(`Threshold description drifted: ${rowDesc}`);
  }

  // Bridge row: hermetic ~/.claude.json absent -> Claude's warning is On.
  await page.locator(".settings-value", { hasText: "On" }).waitFor({ state: "visible" });

  // Permissions group, Claude sessions row: the default permission mode for
  // new Claude sessions. Defaults to "Manual" (the `default` mode's label since
  // Claude 2.1.200); choosing Auto persists to the Sonata-owned
  // claude-settings.json (never ~/.claude.json). The Permissions box holds two
  // popups now (Claude + Codex), so scope by row title.
  const claudeRow = page.locator('section[aria-label="Permissions"] .settings-row', {
    hasText: "Claude sessions",
  });
  const approvalsPopup = claudeRow.locator(".settings-popup");
  await approvalsPopup.filter({ hasText: "Manual" }).waitFor({ state: "visible" });
  await approvalsPopup.click();
  await claudeRow.locator(".settings-popup-option", { hasText: "Auto" }).click();
  await waitUntil(() => {
    const persisted = readPersistedClaudeSettings();
    return persisted?.defaultPermissionMode === "auto";
  }, 8000);
  await approvalsPopup.filter({ hasText: "Auto" }).waitFor({ state: "visible" });

  // Permissions group, Codex sessions row: the stored legacy `on-failure`
  // default migrated on read to "Ask for approval"; the menu offers EXACTLY
  // Codex 0.144's three picker labels (no "(legacy)" machinery), and choosing
  // "Full Access" persists the new `defaultPermissionMode` key.
  const codex = page.locator('section[aria-label="Permissions"] .settings-row', {
    hasText: "Codex sessions",
  });
  const codexPopup = codex.locator(".settings-popup");
  await codexPopup.filter({ hasText: "Ask for approval" }).waitFor({ state: "visible" });
  await codexPopup.click();
  const codexOptionLabels = await codex.locator(".settings-popup-option-label").allTextContents();
  assert.deepEqual(
    codexOptionLabels,
    ["Ask for approval", "Approve for me", "Full Access"],
    "the menu offers exactly Codex 0.144's three permission modes, no legacy entries",
  );
  const askOption = codex.locator(".settings-popup-option", { hasText: "Ask for approval" });
  assert.equal(
    await askOption.getAttribute("aria-checked"),
    "true",
    "the migrated mode (Ask for approval) is marked selected",
  );
  await codex.locator(".settings-popup-option", { hasText: "Full Access" }).click();
  await waitUntil(() => {
    const persisted = JSON.parse(fs.readFileSync(codexSettingsPath, "utf8"));
    return persisted.defaultPermissionMode === "full-access";
  }, 8000);
  await codexPopup.filter({ hasText: "Full Access" }).waitFor({ state: "visible" });

  // Permissions group, Project folder trust row: a real switch (not a picker)
  // bound to codex `autoTrustProjectFolders`. The stored legacy file omits the
  // key, so it normalizes to the safe default (off — codex's dialog stays).
  // The group now holds exactly three rows (Claude, Codex, Project folder trust).
  assert.equal(
    await page.locator('section[aria-label="Permissions"] .settings-row').count(),
    3,
    "the Permissions group holds Claude, Codex, and Project folder trust rows",
  );
  const trustRow = page.locator('section[aria-label="Permissions"] .settings-row', {
    hasText: "Project folder trust",
  });
  const trustSwitch = trustRow.locator(".settings-switch");
  await trustSwitch.waitFor({ state: "visible" });
  assert.equal(
    await trustSwitch.getAttribute("aria-checked"),
    "false",
    "the trust switch defaults off (a legacy codex file omits the flag → prompt preserved)",
  );
  // Turning it on persists the boolean to the Sonata-owned codex-settings.json.
  await trustSwitch.click();
  await waitUntil(() => {
    const persisted = JSON.parse(fs.readFileSync(codexSettingsPath, "utf8"));
    return persisted.autoTrustProjectFolders === true;
  }, 8000);
  await trustRow.locator('.settings-switch[aria-checked="true"]').waitFor({ state: "visible" });

  // Revising on the page persists with settings provenance and retires
  // the attribution line (the page is now the last author).
  await popup.click();
  await page.locator(".settings-popup-option", { hasText: "Ask each time" }).click();
  await waitUntil(() => {
    const persisted = readPersistedResumeSettings();
    return persisted.policy === "ask" && persisted.provenance?.source === "settings";
  }, 8000);
  await popup.filter({ hasText: "Ask each time" }).waitFor({ state: "visible" });
  if (await provenanceNote.isVisible()) {
    throw new Error("Moment-born attribution should retire after a page revision.");
  }

  // Esc closes the overlay.
  await page.keyboard.press("Escape");
  await page.locator(".settings-window").waitFor({ state: "hidden" });

  // The New Chat access chip mirrors the new default LIVE (external review
  // P2, 2026-07-04): an untouched draft follows Settings without a relaunch.
  await page.locator("#permission-chip", { hasText: "Auto" }).waitFor({ state: "visible" });

  // Bridge off -> the row attributes the bridge and offers Restore.
  fs.writeFileSync(claudeConfigPath, `${JSON.stringify({ resumeReturnDismissed: true })}\n`, "utf8");
  await openSettingsFromMenu();
  await page.locator(".settings-window").waitFor({ state: "visible" });

  // Round-trip: the trust switch turned on above survives the overlay
  // close/reopen — the reopened overlay reads the persisted codex settings.
  await page
    .locator('section[aria-label="Permissions"] .settings-row', {
      hasText: "Project folder trust",
    })
    .locator('.settings-switch[aria-checked="true"]')
    .waitFor({ state: "visible" });

  await page.locator(".settings-value", { hasText: "Off" }).waitFor({ state: "visible" });
  await page
    .locator(".settings-row-note", { hasText: "Turned off by Sonata's earlier bridge" })
    .waitFor({ state: "visible" });
  await page.locator(".settings-restore").click();
  await page.locator(".settings-value", { hasText: "On" }).waitFor({ state: "visible" });
  await waitUntil(() => {
    const config = JSON.parse(fs.readFileSync(claudeConfigPath, "utf8"));
    return config.resumeReturnDismissed === undefined;
  }, 8000);

  // F2 regression: at the minimum window height (640px) an opened picker menu
  // must stay fully inside the dialog scrollport. The Sessions row sits near the
  // bottom, so its (now description-bearing, ~160px) menu would clip on first
  // open without the upward flip. Assert the menu's box is contained in the
  // dialog's box; poll so the post-mount rAF flip has time to settle.
  await setContentSize(960, 640);
  await page.locator('section[aria-label="Sessions"] .settings-popup').click();
  const sessionsMenu = page.locator('section[aria-label="Sessions"] .settings-popup-menu');
  await sessionsMenu.waitFor({ state: "visible" });
  const menuFitsDialog = async () => {
    const menuBox = await sessionsMenu.boundingBox();
    const dialogBox = await page.locator(".settings-window").boundingBox();
    if (!menuBox || !dialogBox) {
      return false;
    }
    return (
      menuBox.y >= dialogBox.y - 1 &&
      menuBox.y + menuBox.height <= dialogBox.y + dialogBox.height + 1
    );
  };
  const menuFitDeadline = Date.now() + 3000;
  let menuFits = false;
  while (Date.now() < menuFitDeadline) {
    menuFits = await menuFitsDialog();
    if (menuFits) {
      break;
    }
    await delay(100);
  }
  if (!menuFits) {
    const menuBox = await sessionsMenu.boundingBox();
    const dialogBox = await page.locator(".settings-window").boundingBox();
    throw new Error(
      `Picker menu clips the dialog at 640px height: menu ${JSON.stringify(
        menuBox,
      )} vs dialog ${JSON.stringify(dialogBox)}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        resumeSettingsPath,
        claudeConfigPath,
        persisted: readPersistedResumeSettings(),
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
  fs.rmSync(homeRoot, { recursive: true, force: true });
}

async function launchApp() {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      HOME: homeRoot,
      SONATA_DATA_DIR: workspaceRoot, SONATA_WORKSPACES_DIR: workspaceRoot,
      SONATA_SETTINGS_DIR: settingsRoot,
    },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(60000);
  return page;
}

async function setContentSize(width, height) {
  await electronApp.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
    },
    { width, height },
  );
}

async function openSettingsFromMenu() {
  await electronApp.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById("settings");
    if (!item) {
      throw new Error("Settings menu item is missing from the application menu.");
    }
    item.click();
  });
}

function readPersistedResumeSettings() {
  return JSON.parse(fs.readFileSync(resumeSettingsPath, "utf8"));
}

function readPersistedClaudeSettings() {
  try {
    return JSON.parse(fs.readFileSync(claudeSettingsPath, "utf8"));
  } catch {
    return null;
  }
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for a persisted settings change.");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
