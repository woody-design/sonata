// Global "Auto-enable Remote Control" also covers RESUME (one setting): with the
// default ON, a DORMANT session (reopened after restart) comes up ARMED, so
// resuming it brings RC up too. Verifies the dormant view auto-arms from the
// default (the resume→connect path itself is covered by remote-control-dormant).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { sendFirstPrompt, activeSessionTaskId, selectSidebarSession } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-rcdr-e2e-"));
const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-rcdr-settings-"));
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-rcdr-userdata-"));
const selectedFolder = fs.mkdtempSync(path.join(os.tmpdir(), "duet-rcdr-folder-"));
let electronApp = null;
const pageErrors = [];

try {
  // Launch 1: turn the global default ON, then create a session and quit.
  let page = await launchApp();
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  await page.locator(".task-entry-panel").waitFor({ state: "visible" });
  await openSettings(page);
  await page.locator(".settings-group[aria-label='Remote control'] .settings-toggle").click();
  await page.locator(".settings-group[aria-label='Remote control'] .settings-toggle", { hasText: "On" }).waitFor();
  await page.keyboard.press("Escape");
  await page.locator(".settings-window").waitFor({ state: "hidden" });

  await sendFirstPrompt(page, "Reply with exactly: DORM_DEFAULT_SEED");
  await page.locator(".turn-card", { hasText: "DORM_DEFAULT_SEED" }).waitFor({ state: "visible" });
  await page.locator('.turn-card[data-run-status="completed"]').first().waitFor({ state: "visible" });
  const taskId = await activeSessionTaskId(page);
  await electronApp.close();
  electronApp = null;

  // Launch 2: reopen the (now dormant) session — it must come up ARMED from the default.
  page = await launchApp();
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  await page.locator(".task-entry-panel").waitFor({ state: "visible" });
  await selectSidebarSession(page, taskId);
  await page.locator(".turn-card", { hasText: "DORM_DEFAULT_SEED" }).waitFor({ state: "visible" });

  const dormantArmed = await page.locator('#remote-control-toggle[aria-pressed="true"]').count();
  await page.locator("#remote-control-toggle").click();
  await page.locator(".remote-control-popover").waitFor({ state: "visible" });
  const dormantStatus = (await page.locator(".remote-control-popover-status").textContent())?.trim();

  const success = dormantArmed === 1 && dormantStatus === "Armed" && pageErrors.length === 0;
  console.log(JSON.stringify({ dormantArmed, dormantStatus, pageErrors, success }, null, 2));
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
