// Remote Control "arm at session start" e2e (#1): in New Chat the header toggle
// ARMS the `--remote-control` spawn flag; the very first prompt creates a Claude
// session that comes up phone-reachable WITHOUT any `/rc` injection. Verifies the
// armed state pre-creation, then that RC is active + the URL scraped post-creation.
//
// Drives a REAL authenticated `claude` (registers a real RC session, dropped on
// close). Fully isolated (--user-data-dir + DUET_* temp dirs).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { sendFirstPrompt } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-rcarm-e2e-"));
const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-rcarm-settings-"));
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-rcarm-userdata-"));
const selectedFolder = fs.mkdtempSync(path.join(os.tmpdir(), "duet-rcarm-folder-"));
const shotDir = process.env.RC_SHOT_DIR || workspaceRoot;
let electronApp = null;
const pageErrors = [];

try {
  const page = await launchApp();
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  await page.locator(".task-entry-panel", { hasText: "What should we work on" }).waitFor({ state: "visible" });

  // In New Chat (Claude default) the button is clickable and ARMS the flag.
  const rcButton = page.locator("#remote-control-toggle");
  const enabledInNewChat = !(await rcButton.isDisabled());
  await rcButton.click();
  await page.locator(".remote-control-popover").waitFor({ state: "visible" });
  const draftOffStatus = (await page.locator(".remote-control-popover-status").textContent())?.trim();
  await page.locator(".remote-control-popover-action.primary", { hasText: "Turn on" }).click();
  // Armed: popover flips to "Armed", header button gets the active fill.
  await page.locator(".remote-control-popover-status", { hasText: "Armed" }).waitFor({ state: "visible" });
  const armedClass = await page.locator('#remote-control-toggle[aria-pressed="true"]').count();
  await page.screenshot({ path: path.join(shotDir, "rcarm-1-armed.png") });
  // Close the popover before composing.
  await page.keyboard.press("Escape");

  // First prompt creates the session — which must spawn WITH --remote-control.
  await sendFirstPrompt(page, "Reply with exactly: RC_ARMED_READY");
  await page.locator(".turn-card", { hasText: "RC_ARMED_READY" }).waitFor({ state: "visible" });

  // No /rc injection anywhere: RC must be on purely from the spawn flag.
  await page.locator('#remote-control-toggle[aria-pressed="true"]').waitFor({ state: "visible", timeout: 45000 });
  await rcButton.click();
  await page
    .locator(".remote-control-popover-url", { hasText: "claude.ai/code/session_" })
    .waitFor({ state: "visible", timeout: 45000 });
  const liveStatus = (await page.locator(".remote-control-popover-status").textContent())?.trim();
  const url = (await page.locator(".remote-control-popover-url").textContent())?.trim();
  await page.screenshot({ path: path.join(shotDir, "rcarm-2-live-on.png") });

  const success =
    enabledInNewChat &&
    draftOffStatus === "Off" &&
    armedClass === 1 &&
    liveStatus === "On" &&
    /^https:\/\/claude\.(ai|com)\/code\/session_[A-Za-z0-9_-]+$/.test(url ?? "") &&
    pageErrors.length === 0;

  console.log(
    JSON.stringify(
      {
        enabledInNewChat,
        draftOffStatus,
        armedClass,
        liveStatus,
        url: url ? url.replace(/(session_)[A-Za-z0-9_-]+/, "$1<redacted>") : url,
        pageErrors,
        shotDir,
        success,
      },
      null,
      2,
    ),
  );
  process.exitCode = success ? 0 : 1;
} finally {
  if (electronApp) {
    await electronApp.close();
  }
  for (const d of [workspaceRoot, settingsDir, userDataDir, selectedFolder]) {
    fs.rmSync(d, { recursive: true, force: true });
  }
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
