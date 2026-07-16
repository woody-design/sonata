// Regression for the review finding: enabling "Auto-enable Remote Control" must
// apply to a dormant session that is ALREADY OPEN — not only to sessions opened
// afterward. A dormant view's armed state follows the global default (unless the
// user overrode it), so toggling the default updates its header button live.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { sendFirstPrompt, activeSessionTaskId, selectSidebarSession } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-rcretro-e2e-"));
const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-rcretro-settings-"));
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-rcretro-userdata-"));
const selectedFolder = fs.mkdtempSync(path.join(os.tmpdir(), "duet-rcretro-folder-"));
let electronApp = null;
const pageErrors = [];

try {
  // Launch 1: default OFF (initial). Create a session, then quit (dormant).
  let page = await launchApp();
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  await sendFirstPrompt(page, "Reply with exactly: RETRO_SEED");
  await page.locator(".turn-card", { hasText: "RETRO_SEED" }).waitFor({ state: "visible" });
  await page.locator('.turn-card[data-run-status="completed"]').first().waitFor({ state: "visible" });
  const taskId = await activeSessionTaskId(page);
  await electronApp.close();
  electronApp = null;

  // Launch 2: open the dormant session FIRST (default still off → button off),
  // THEN turn the default on → the already-open dormant button must arm.
  page = await launchApp();
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  await page.locator(".task-entry-panel").waitFor({ state: "visible" });
  await selectSidebarSession(page, taskId);
  await page.locator(".turn-card", { hasText: "RETRO_SEED" }).waitFor({ state: "visible" });
  const armedBefore = await page.locator('#remote-control-toggle[aria-pressed="true"]').count();

  await openSettings(page);
  await page.locator(".settings-group[aria-label='Remote control'] .settings-switch").click();
  await page.locator(".settings-group[aria-label='Remote control'] .settings-switch[aria-checked='true']").waitFor();
  await page.keyboard.press("Escape");
  await page.locator(".settings-window").waitFor({ state: "hidden" });

  // The already-open dormant session's button now reflects the default (live).
  await page.locator('#remote-control-toggle[aria-pressed="true"]').waitFor({ state: "visible", timeout: 10000 });
  const armedAfter = await page.locator('#remote-control-toggle[aria-pressed="true"]').count();
  await page.locator("#remote-control-toggle").click();
  await page.locator(".remote-control-popover").waitFor({ state: "visible" });
  const status = (await page.locator(".remote-control-popover-status").textContent())?.trim();

  const success =
    armedBefore === 0 && armedAfter === 1 && status === "Armed" && pageErrors.length === 0;
  console.log(JSON.stringify({ armedBefore, armedAfter, status, pageErrors, success }, null, 2));
  process.exitCode = success ? 0 : 1;
} finally {
  if (electronApp) await electronApp.close();
  for (const d of [workspaceRoot, settingsDir, userDataDir, selectedFolder]) {
    fs.rmSync(d, { recursive: true, force: true });
  }
}

async function openSettings(page) {
  await electronApp.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById("settings")?.click();
  });
  await page.locator(".settings-window").waitFor();
}

async function launchApp() {
  electronApp = await electron.launch({
    args: ["dist/main/main.js", `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      DUET_DATA_DIR: workspaceRoot,
      DUET_WORKSPACES_DIR: workspaceRoot,
      DUET_SETTINGS_DIR: settingsDir,
      DUET_TEST_PICK_FOLDER: selectedFolder,
    },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(240000);
  return page;
}
