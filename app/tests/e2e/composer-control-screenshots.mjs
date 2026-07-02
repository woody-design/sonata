import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { approveIfVisible } from "./helpers/approval.mjs";
import { sendFirstPrompt, waitForCompletedTurns, waitForEngagement } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-control-shots-"));
const screenshotRoot = path.resolve("..", "product-thinking", "composer-slice-3-screenshots");
fs.mkdirSync(screenshotRoot, { recursive: true });

let electronApp = null;

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      DUET_DATA_DIR: workspaceRoot, DUET_WORKSPACES_DIR: workspaceRoot,
    },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(240000);

  // Sessions are born from the first composer message, and the permission and
  // model chips only render for a live session — so start one with a no-op
  // prompt before staging the idle-state menu screenshots.
  await sendFirstPrompt(page, "Reply exactly DUET_CONTROL_SESSION_READY. Do not create or modify any files.");
  await waitForCompletedTurns(page, 1);

  await page.locator("#permission-chip").click();
  await page.screenshot({ path: path.join(screenshotRoot, "01-permission-menu.png"), fullPage: true });
  await page.locator("#permission-chip").click();

  await page.locator("#model-chip").click();
  await page.locator(".composer-submenu-section", { hasText: "Model" }).hover();
  await page.screenshot({ path: path.join(screenshotRoot, "02-model-menu.png"), fullPage: true });
  await page.locator("#model-chip").click();

  const longCommand = [
    "Run exactly this shell command and no other commands.",
    "Do not use apply_patch.",
    "Do not edit files directly.",
    "Command: python3 -c \"import time; time.sleep(45)\"",
  ].join(" ");
  await page.locator("#prompt-input").fill(longCommand);
  await page.locator("#send-prompt").click();
  await approveIfVisible(page, "Command approval requested", 180000);
  await waitForEngagement(page);

  await page.locator("#permission-chip").click();
  await page.locator(".composer-menu-option", { hasText: "Approve for me" }).click();
  await page.locator(".delivery-item.queued", { hasText: "Permission: Approve for me" }).waitFor({
    state: "visible",
  });
  await page.screenshot({ path: path.join(screenshotRoot, "03-pending-control.png"), fullPage: true });
  await page.locator(".delivery-item.queued .compact-action", { hasText: "Cancel" }).click();
  await page.locator("#send-prompt").click();
  // Stopped + ready to continue: the send button leaves stop-mode (■ → ↑).
  await page.locator("#send-prompt:not(.stop-mode)").waitFor({ state: "attached", timeout: 90000 });

  await page.locator("#model-chip").click();
  await page.locator(".composer-submenu-section", { hasText: "Model" }).hover();
  await page.screenshot({ path: path.join(screenshotRoot, "04-model-submenu.png"), fullPage: true });

  console.log(JSON.stringify({ screenshotRoot, success: true }, null, 2));
} finally {
  if (electronApp) {
    await electronApp.close();
  }
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
}
