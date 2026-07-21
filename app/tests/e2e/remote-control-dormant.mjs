// Remote Control on a DORMANT session (#2): after an app restart, a session
// reopened from the sidebar (not yet resumed) must let you ARM the toggle; the
// next message resumes it WITH `--remote-control`, so it comes up phone-reachable.
//
// Drives a REAL authenticated `claude` (registers a real RC session, dropped on
// close). Fully isolated (--user-data-dir + SONATA_* temp dirs).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import {
  activeSessionTaskId,
  chooseDraftProvider,
  selectSidebarSession,
  sendFirstPrompt,
  sendPrompt,
} from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-rcdorm-e2e-"));
const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-rcdorm-settings-"));
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-rcdorm-userdata-"));
const selectedFolder = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-rcdorm-folder-"));
const shotDir = process.env.RC_SHOT_DIR || workspaceRoot;
let electronApp = null;
const pageErrors = [];

try {
  // ── Launch 1: create a small session, then quit (leaving it dormant). ──
  let page = await launchApp();
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  await chooseDraftProvider(page, "claude");
  await sendFirstPrompt(page, "Reply with exactly: DORMANT_SEED");
  await page.locator(".turn-card", { hasText: "DORMANT_SEED" }).waitFor({ state: "visible" });
  await page.locator('.turn-card[data-run-status="completed"]').first().waitFor({ state: "visible" });
  const taskId = await activeSessionTaskId(page);
  await electronApp.close();
  electronApp = null;

  // ── Launch 2: reopen the dormant session, ARM RC, then resume by sending. ──
  page = await launchApp();
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  await selectSidebarSession(page, taskId);
  await page.locator(".turn-card", { hasText: "DORMANT_SEED" }).waitFor({ state: "visible" });

  const rcButton = page.locator("#remote-control-toggle");
  await rcButton.waitFor({ state: "visible" });
  const enabledWhileDormant = !(await rcButton.isDisabled());
  await rcButton.click();
  await page.locator(".remote-control-popover").waitFor({ state: "visible" });
  const dormantOffStatus = (await page.locator(".remote-control-popover-status").textContent())?.trim();
  await page.locator(".remote-control-popover-action.primary", { hasText: "Turn on" }).click();
  await page.locator(".remote-control-popover-status", { hasText: "Armed" }).waitFor({ state: "visible" });
  const armedClass = await page.locator('#remote-control-toggle[aria-pressed="true"]').count();
  await page.keyboard.press("Escape");

  // Resume by sending — must spawn the resume WITH --remote-control.
  await sendPrompt(page, "Reply with exactly: DORMANT_RESUMED");
  await page.locator(".turn-card", { hasText: "DORMANT_RESUMED" }).waitFor({ state: "visible", timeout: 240000 });

  // No /rc injection: RC must be on purely from the resume spawn flag.
  await page.locator('#remote-control-toggle[aria-pressed="true"]').waitFor({ state: "visible", timeout: 45000 });
  await rcButton.click();
  await page
    .locator(".remote-control-popover-url", { hasText: "claude.ai/code/session_" })
    .waitFor({ state: "visible", timeout: 45000 });
  const liveStatus = (await page.locator(".remote-control-popover-status").textContent())?.trim();
  const url = (await page.locator(".remote-control-popover-url").textContent())?.trim();
  await page.screenshot({ path: path.join(shotDir, "rcdorm-live-on.png") });

  const success =
    enabledWhileDormant &&
    dormantOffStatus === "Off" &&
    armedClass === 1 &&
    liveStatus === "On" &&
    /^https:\/\/claude\.(ai|com)\/code\/session_[A-Za-z0-9_-]+$/.test(url ?? "") &&
    pageErrors.length === 0;

  console.log(
    JSON.stringify(
      {
        enabledWhileDormant,
        dormantOffStatus,
        armedClass,
        liveStatus,
        url: url ? url.replace(/(session_)[A-Za-z0-9_-]+/, "$1<redacted>") : url,
        pageErrors,
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
      SONATA_DATA_DIR: workspaceRoot,
      SONATA_WORKSPACES_DIR: workspaceRoot,
      SONATA_SETTINGS_DIR: settingsDir,
      SONATA_TEST_PICK_FOLDER: selectedFolder,
    },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(240000);
  return page;
}
