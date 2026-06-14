// Slice A e2e — the floor, end to end, against a REAL native interstitial.
// A fresh folder guarantees Claude's workspace-trust screen. The first
// message queues behind it. The human opens the drawer, takes over, answers
// the screen with their own keys (Enter), hands back — and the queued
// message delivers by itself. Asserts along the way: single-writer UI
// (approval buttons disable), native-answer clearing (banner hides without
// any Duet keypress), delivery pause/resume semantics.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { sendFirstPrompt } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-takeover-e2e-"));
const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-takeover-settings-"));
let electronApp = null;
const checks = {};

try {
  const page = await launchApp();
  await page.locator(".task-entry-panel", { hasText: "What should we work on?" }).waitFor({
    state: "visible",
  });
  await page.locator("#entry-provider-claude").click();

  // First message creates the session; the fresh folder guarantees the
  // trust interstitial, and the message queues behind it.
  await sendFirstPrompt(page, "Reply with exactly: TAKEOVER_OK", { approveTrust: false });
  const trustBanner = page.locator("#approval-banner", { hasText: "Workspace trust requested" });
  await trustBanner.waitFor({ state: "visible", timeout: 120000 });
  checks.trustDetected = true;

  // Auto-surface (S3.3), gentle default: a needs-you accent appears on the
  // terminal button while the floor is closed and the active task is blocked —
  // the floor advertises itself without stealing the surface.
  await page
    .locator("#toggle-terminal.needs-you")
    .waitFor({ state: "visible", timeout: 15000 });
  checks.autoSurfaceSignal = true;

  // Open the drawer and take over.
  await page.locator("#toggle-terminal").click();
  // Opening the floor clears the needs-you signal (it is now visible).
  await page
    .locator("#toggle-terminal.needs-you")
    .waitFor({ state: "hidden", timeout: 5000 });
  checks.autoSurfaceCleared = true;
  await page.locator("#terminal-drawer").waitFor({ state: "visible" });
  await page.locator("#takeover-toggle").click();
  await page
    .locator("#terminal-drawer-eyebrow", { hasText: "You hold the keys" })
    .waitFor({ state: "visible" });
  checks.takeoverActive = true;

  // Single writer: Duet's own approval buttons disable while the human
  // holds the keys.
  checks.approveDisabled = await page.locator("#approve-approval").isDisabled();
  checks.denyDisabled = await page.locator("#deny-approval").isDisabled();

  // The queued message is visible and held.
  checks.queueVisible = await page.locator("#delivery-queue .delivery-item").isVisible();

  // Answer the trust screen natively: Enter confirms the default
  // "Yes, I trust this folder".
  await page.locator("#terminal .xterm-helper-textarea").focus();
  await page.keyboard.press("Enter");

  // Native-answer clearing: the banner hides with NO Duet keypress.
  await trustBanner.waitFor({ state: "hidden", timeout: 30000 });
  checks.bannerClearedNatively = true;

  // Delivery stays paused while control is held (the queue item remains).
  await page.waitForTimeout(2500);
  checks.stillQueuedDuringTakeover = await page
    .locator("#delivery-queue .delivery-item")
    .isVisible();

  // Hand back — the queued message should now deliver and complete.
  await page.locator("#takeover-toggle").click();
  await page
    .locator("#terminal-drawer-title", { hasText: "Live terminal" })
    .waitFor({ state: "visible" });
  await page.locator(".turn-card", { hasText: "TAKEOVER_OK" }).waitFor({
    state: "visible",
    timeout: 240000,
  });
  await page.locator(".turn-outcome", { hasText: "Completed" }).waitFor({
    state: "visible",
    timeout: 240000,
  });
  checks.deliveredAfterHandback = true;

  const success =
    checks.trustDetected &&
    checks.autoSurfaceSignal &&
    checks.autoSurfaceCleared &&
    checks.takeoverActive &&
    checks.approveDisabled &&
    checks.denyDisabled &&
    checks.queueVisible &&
    checks.bannerClearedNatively &&
    checks.stillQueuedDuringTakeover &&
    checks.deliveredAfterHandback;
  console.log(JSON.stringify({ success, checks }, null, 2));
  process.exitCode = success ? 0 : 1;
} catch (error) {
  console.error(JSON.stringify({ success: false, checks, error: String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  if (electronApp) {
    await electronApp.close().catch(() => {});
  }
  fs.rmSync(workspaceRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  fs.rmSync(settingsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

async function launchApp() {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      DUET_PROJECTS_DIR: workspaceRoot,
      DUET_SETTINGS_DIR: settingsDir,
    },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(240000);
  return page;
}
