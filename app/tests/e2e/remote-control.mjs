// Remote Control e2e: the header toggle rides Claude Code's native
// `/remote-control`. Flow: create a live Claude session → open the RC popover
// (Off / Turn on) → Turn on → assert the button shows the active fill, the
// popover flips to On, and the scraped session URL appears.
//
// NOTE: this drives a REAL authenticated `claude`, so it registers a real
// Remote Control session on the signed-in account (disconnected when the app
// closes). Fully isolated (--user-data-dir + DUET_* temp dirs) so it never
// collides with a running Duet.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { sendFirstPrompt } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-rc-e2e-"));
const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-rc-settings-"));
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-rc-userdata-"));
const selectedFolder = fs.mkdtempSync(path.join(os.tmpdir(), "duet-rc-folder-"));
const shotDir = process.env.RC_SHOT_DIR || workspaceRoot;
let electronApp = null;
const pageErrors = [];

try {
  const page = await launchApp();
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  // Create the session with a fast first turn; the helper answers workspace trust.
  await sendFirstPrompt(page, "Reply with exactly: RC_READY");
  await page.locator(".turn-card", { hasText: "RC_READY" }).waitFor({ state: "visible" });
  await page.locator(".turn-outcome", { hasText: "Completed" }).first().waitFor({ state: "visible" });

  const rcButton = page.locator("#remote-control-toggle");
  await rcButton.waitFor({ state: "visible" });
  const buttonEnabled = !(await rcButton.isDisabled());
  await page.screenshot({ path: path.join(shotDir, "rc-1-header.png") });

  // Open popover → Off state.
  await rcButton.click();
  await page.locator(".remote-control-popover").waitFor({ state: "visible" });
  const offStatus = (await page.locator(".remote-control-popover-status").textContent())?.trim();
  const turnOn = page.locator(".remote-control-popover-action.primary", { hasText: "Turn on" });
  const turnOnVisible = await turnOn.isVisible();
  await page.screenshot({ path: path.join(shotDir, "rc-2-popover-off.png") });

  // Turn on → optimistic active fill, then the scraped session URL.
  await turnOn.click();
  await page.locator("#remote-control-toggle.remote-on").waitFor({ state: "visible", timeout: 45000 });
  await page
    .locator(".remote-control-popover-url", { hasText: "claude.ai/code/session_" })
    .waitFor({ state: "visible", timeout: 45000 });
  const onStatus = (await page.locator(".remote-control-popover-status").textContent())?.trim();
  const url = (await page.locator(".remote-control-popover-url").textContent())?.trim();
  const buttonActive = await page.locator("#remote-control-toggle.remote-on").count();
  await page.screenshot({ path: path.join(shotDir, "rc-3-popover-on.png") });

  const success =
    buttonEnabled &&
    offStatus === "Off" &&
    turnOnVisible &&
    onStatus === "On" &&
    buttonActive === 1 &&
    /^https:\/\/claude\.(ai|com)\/code\/session_[A-Za-z0-9_-]+$/.test(url ?? "") &&
    pageErrors.length === 0;

  console.log(
    JSON.stringify(
      {
        buttonEnabled,
        offStatus,
        turnOnVisible,
        onStatus,
        buttonActive,
        // Redact the real session id from logs/CI — keep host/path for debugging.
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
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(settingsDir, { recursive: true, force: true });
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(selectedFolder, { recursive: true, force: true });
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
