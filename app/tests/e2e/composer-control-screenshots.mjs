import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { approveIfVisible } from "./helpers/approval.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-control-shots-"));
const screenshotRoot = path.resolve("..", "product-thinking", "composer-slice-3-screenshots");
fs.mkdirSync(screenshotRoot, { recursive: true });

let electronApp = null;

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      DUET_PROJECTS_DIR: workspaceRoot,
    },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(240000);

  await page.locator("#new-task").click();
  await waitForRuntimeReady(page, 240000);

  await page.locator("#permission-chip").click();
  await page.screenshot({ path: path.join(screenshotRoot, "01-permission-menu.png"), fullPage: true });
  await page.locator("#permission-chip").click();

  await page.locator("#model-chip").click();
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
  await page.locator("#workflow-headline", { hasText: /Codex is working|Command approval needed/ }).waitFor({
    state: "visible",
  });

  await page.locator("#permission-chip").click();
  await page.locator(".composer-menu-option", { hasText: "Approve for me" }).click();
  await page.locator(".delivery-item.queued", { hasText: "Permission: Approve for me" }).waitFor({
    state: "visible",
  });
  await page.screenshot({ path: path.join(screenshotRoot, "03-pending-control.png"), fullPage: true });
  await page.locator(".delivery-item.queued .compact-action", { hasText: "Cancel" }).click();
  await page.locator("#send-prompt").click();
  await page.locator("#workflow-headline", { hasText: "Stopped. Ready to continue" }).waitFor({
    state: "visible",
    timeout: 90000,
  });

  await page.locator("#model-chip").click();
  await page.locator(".composer-menu-section", { hasText: "Model" }).locator(".composer-menu-option", { hasText: "Native Default" }).click();
  await page.locator(".delivery-item.undelivered", { hasText: "Setting change failed" }).waitFor({
    state: "visible",
    timeout: 30000,
  });
  await page.screenshot({ path: path.join(screenshotRoot, "04-failed-control.png"), fullPage: true });

  console.log(JSON.stringify({ screenshotRoot, success: true }, null, 2));
} finally {
  if (electronApp) {
    await electronApp.close();
  }
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
}

async function waitForRuntimeReady(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await page
      .locator("#runtime-status", { hasText: "Ready" })
      .isVisible({ timeout: 500 })
      .catch(() => false);
    if (ready) {
      return;
    }

    await approveIfVisible(page, "Workspace trust requested", 500);
    await page.waitForTimeout(250);
  }
  throw new Error("Timed out waiting for runtime ready.");
}
