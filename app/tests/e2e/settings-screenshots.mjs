import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";

// One-off probe: captures the Settings overlay states for Woody's eye.
// Not a regression test — visual acceptance material.

const outDir = process.argv[2] ?? path.join(process.cwd(), "..", "Temp", "screenshots", "settings");
fs.mkdirSync(outDir, { recursive: true });

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-settings-shots-workspace-"));
const settingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-settings-shots-store-"));
const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-settings-shots-home-"));
let electronApp = null;

try {
  fs.writeFileSync(
    path.join(settingsRoot, "resume-settings.json"),
    `${JSON.stringify(
      { policy: "summary", provenance: { source: "moment", at: "2026-06-12T08:00:00.000Z" } },
      null,
      2,
    )}\n`,
    "utf8",
  );

  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      HOME: homeRoot,
      DUET_DATA_DIR: workspaceRoot, DUET_WORKSPACES_DIR: workspaceRoot,
      DUET_SETTINGS_DIR: settingsRoot,
    },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(60000);
  await page.locator(".task-entry-panel", { hasText: "What should we work on" }).waitFor();

  await openSettings(page);
  // Three .settings-popup buttons live in the overlay now (Permissions holds
  // Claude + Codex; Sessions holds the resume policy); scope to the Sessions
  // group so strict mode resolves one.
  const sessionsGroup = page.locator('.settings-group[aria-label="Sessions"]');
  await sessionsGroup.locator(".settings-popup", { hasText: "Resume from summary" }).waitFor();
  await page.screenshot({ path: path.join(outDir, "01-overlay-moment-born-light.png") });

  await sessionsGroup.locator(".settings-popup").click();
  await sessionsGroup.locator(".settings-popup-menu").waitFor();
  await page.screenshot({ path: path.join(outDir, "02-policy-menu-open.png") });
  await page.keyboard.press("Escape");

  // Bridge-off state.
  await page.keyboard.press("Escape");
  fs.writeFileSync(
    path.join(homeRoot, ".claude.json"),
    `${JSON.stringify({ resumeReturnDismissed: true })}\n`,
    "utf8",
  );
  await openSettings(page);
  await page.locator(".settings-value", { hasText: "Off" }).waitFor();
  await page.screenshot({ path: path.join(outDir, "03-bridge-off-restore.png") });

  // Dark mode (two doors, one state: flip via the Aa popover underneath).
  await page.keyboard.press("Escape");
  await page.locator("#reading-settings").click();
  await page.locator(".reading-segment", { hasText: "Dark" }).click();
  await page.keyboard.press("Escape");
  await openSettings(page);
  await page.locator(".settings-window").waitFor();
  await page.screenshot({ path: path.join(outDir, "04-overlay-dark.png") });

  // Dark-mode ON state: the neutral system inverts ink in dark, so the ON
  // track is bright — the one state where thumb/track contrast can silently
  // die. Worth a standing frame.
  await page.locator(".settings-switch").click();
  await page.locator(".settings-switch[aria-checked='true']").waitFor();
  await page.screenshot({ path: path.join(outDir, "05-overlay-dark-on.png") });

  console.log(JSON.stringify({ outDir, success: true }, null, 2));
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

async function openSettings(page) {
  await electronApp.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById("settings")?.click();
  });
  await page.locator(".settings-window").waitFor();
}
