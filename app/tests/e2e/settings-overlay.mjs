import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { chooseDraftProvider } from "./helpers/session.mjs";

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
const sonataSettingsPath = path.join(settingsRoot, "sonata-settings.json");
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

  // Default model group (FIRST group): the two combined model/effort popovers,
  // and NOTHING that picks a provider — a new chat opens on the one the last
  // session started on (S3/L3), so the group holds exactly two rows.
  const defaultModelGroup = page.locator('section[aria-label="Default model"]');
  assert.equal(
    await defaultModelGroup.locator(".settings-row").count(),
    2,
    "the Default model group holds Claude and Codex model/effort — no provider picker",
  );
  assert.equal(
    await defaultModelGroup.locator(".settings-row", { hasText: "Default provider" }).count(),
    0,
    "the Default provider row is gone, with no replacement row in its place",
  );
  // Nothing on this page writes sonata-settings.json anymore; the file appears
  // only when a session actually starts (main-side, S3/L3).
  assert.equal(
    readPersistedSonataSettings(),
    null,
    "opening Settings records no provider",
  );

  // Claude model & effort: one combined popover, two label-only sections. The
  // Settings menu excludes Native Default (concrete value only); each pick
  // persists instantly and the menu stays open across picks.
  const claudeModelRow = defaultModelGroup.locator(".settings-row", {
    hasText: "Claude model & effort",
  });
  const claudeModelPopup = claudeModelRow.locator(".settings-popup");
  await claudeModelPopup.filter({ hasText: "Opus 5 · High" }).waitFor({ state: "visible" });
  await claudeModelPopup.click();
  const claudeMenu = claudeModelRow.locator(".settings-popup-menu");
  await claudeMenu.waitFor({ state: "visible" });
  const claudeMenuLabels = await claudeMenu.locator(".settings-popup-option-label").allTextContents();
  assert.equal(
    claudeMenuLabels.includes("Native Default"),
    false,
    "the Settings model/effort menu excludes Native Default (per-session only)",
  );
  assert.ok(claudeMenuLabels.includes("Opus 5"), "the model section lists concrete models");
  await claudeMenu.locator(".settings-popup-option", { hasText: "Sonnet 5" }).click();
  await waitUntil(() => readPersistedClaudeSettings()?.defaultModel === "sonnet", 8000);
  // The menu stays open across picks (two-axis adjustment).
  await claudeMenu.waitFor({ state: "visible" });
  await claudeMenu.locator(".settings-popup-option", { hasText: "Medium" }).click();
  await waitUntil(() => readPersistedClaudeSettings()?.defaultReasoningEffort === "medium", 8000);
  await claudeModelPopup.filter({ hasText: "Sonnet 5 · Medium" }).waitFor({ state: "visible" });
  // The Claude menu stays open across picks; close it (outside-click) before the
  // Codex row, since its tall dropdown overlaps the rows below.
  await page.locator(".settings-title").click();
  await claudeMenu.waitFor({ state: "hidden" });

  // Codex model & effort: the settings menu clamps a now-gated effort on a model
  // switch (Sol offers Ultra; Luna does not) — Ultra must never survive the
  // switch to Luna (it lands on Extra High), the same rule as the launch menu.
  const codexModelRow = defaultModelGroup.locator(".settings-row", {
    hasText: "Codex model & effort",
  });
  const codexModelPopup = codexModelRow.locator(".settings-popup");
  await codexModelPopup.filter({ hasText: "5.6 Sol · High" }).waitFor({ state: "visible" });
  await codexModelPopup.click();
  const codexMenu = codexModelRow.locator(".settings-popup-menu");
  await codexMenu.waitFor({ state: "visible" });
  await codexMenu.locator(".settings-popup-option", { hasText: "Ultra" }).click();
  await waitUntil(() => readPersistedCodexSettings()?.defaultReasoningEffort === "ultra", 8000);
  await codexMenu.locator(".settings-popup-option", { hasText: "5.6 Luna" }).click();
  await waitUntil(() => {
    const persisted = readPersistedCodexSettings();
    return persisted?.defaultModel === "gpt-5.6-luna" && persisted?.defaultReasoningEffort === "xhigh";
  }, 8000);
  await codexModelPopup.filter({ hasText: "5.6 Luna · Extra High" }).waitFor({ state: "visible" });
  // Outside-click close: a mousedown inside the dialog but outside any popup
  // wrap (the header title) closes the open menu without closing the overlay.
  await page.locator(".settings-title").click();
  await codexMenu.waitFor({ state: "hidden" });

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

  // The Codex permission default is mirrored LIVE onto an untouched draft's
  // access chip (unlike model/effort, which are copy-at-entry). The chip is
  // provider-scoped, so declare the draft's provider rather than inheriting the
  // seed — which is now last-used semantics and reads the machine's own CLIs.
  await chooseDraftProvider(page, "codex");
  await page.locator("#permission-chip", { hasText: "Full Access" }).waitFor({ state: "visible" });
  // Choosing a provider in the composer is a DRAFT choice, not a record: only a
  // real session start writes sonata-settings.json (S3/L3).
  assert.equal(
    readPersistedSonataSettings(),
    null,
    "switching the draft's provider records nothing",
  );

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

  // F1 fix C — the MECHANISM the F2 block below rests on: the dialog keeps its scroll
  // position across a re-render. Settings is instant-apply, so every picker click
  // rebuilds the whole dialog, and `scrollTop` is browser state that dies with the
  // node holding it — without a capture/restore the dialog snapped to the top and
  // took the row the user had just clicked out of view.
  //
  // Asserted DIRECTLY, and that is the point: the F2 check below reads the
  // consequence (a menu that fits) and reaches this bug only through a chain —
  // anchor scrolls offscreen, so the upward flip has nothing useful to flip against,
  // so the menu clips. Any future change that keeps the anchor visible some other way
  // would leave scroll retention silently un-fenced.
  await setContentSize(960, 640);
  const dialogScrollTop = () =>
    page.locator(".settings-window").evaluate((node) => node.scrollTop);
  await page.locator(".settings-window").evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  const scrolledTo = await dialogScrollTop();
  assert.ok(scrolledTo > 0, "the dialog scrolls at 640px height (otherwise this proves nothing)");
  await page.locator('section[aria-label="Sessions"] .settings-popup').click();
  assert.equal(
    await dialogScrollTop(),
    scrolledTo,
    "opening a picker keeps the dialog where the user left it",
  );

  // F2 regression: at the minimum window height (640px) an opened picker menu must
  // stay fully inside the dialog scrollport. The Sessions row sits near the bottom,
  // so its (description-bearing, ~160px) menu would clip on first open without the
  // upward flip — and the flip only has something useful to flip against because the
  // scroll restore above kept the anchor inside the visible rect. Assert the menu's
  // box is contained in the dialog's box; poll so the post-mount rAF flip settles.
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
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === "Sonata")
        ?.setContentSize(size.width, size.height);
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

function readPersistedCodexSettings() {
  try {
    return JSON.parse(fs.readFileSync(codexSettingsPath, "utf8"));
  } catch {
    return null;
  }
}

function readPersistedSonataSettings() {
  try {
    return JSON.parse(fs.readFileSync(sonataSettingsPath, "utf8"));
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
