import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { approveIfVisible } from "./helpers/approval.mjs";
import { sendFirstPrompt, waitForCompletedTurns } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-attachment-shots-"));
const screenshotRoot = path.resolve("..", "product-thinking", "composer-slice-4-screenshots");
fs.mkdirSync(screenshotRoot, { recursive: true });

let electronApp = null;
let taskDirectory = null;
let workspace = null;

try {
  const imagePath = path.join(workspaceRoot, "red.png");
  fs.writeFileSync(imagePath, redPngBytes());

  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      DUET_DATA_DIR: workspaceRoot, DUET_WORKSPACES_DIR: workspaceRoot,
    },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(240000);

  // Sessions are born from the first composer message, and attachments only
  // work for a live session — so create the session with a no-op prompt first.
  await sendFirstPrompt(page, "Reply exactly DUET_ATTACHMENT_SESSION_READY. Do not create or modify any files.");
  taskDirectory = await waitForTaskDirectory(path.join(workspaceRoot, "data", "projects"), 45000);
  workspace = path.join(workspaceRoot, "data", "projects", taskDirectory);
  await waitForCompletedTurns(page, 1);

  await attachImage(page, imagePath);
  await page.locator("#prompt-input").fill("Reply exactly DUET_ATTACHMENT_CHIP_SCREENSHOT.");
  await page.locator(".attachment-chip", { hasText: "red.png" }).waitFor({ state: "visible" });
  await page.screenshot({ path: path.join(screenshotRoot, "01-composer-chip.png"), fullPage: true });

  await page.locator(".attachment-remove").click();
  await page.locator(".attachment-chip").waitFor({ state: "hidden" });

  const longCommand = [
    "Run exactly this shell command and no other commands.",
    "Do not use apply_patch.",
    "Do not edit files directly.",
    "Command: python3 -c \"import time; time.sleep(8)\"",
  ].join(" ");
  await page.locator("#prompt-input").fill(longCommand);
  await page.locator("#send-prompt").click();
  await approveIfVisible(page, "Command approval requested", 180000);
  await page.locator("#workflow-headline", { hasText: /Codex is working|Delivering to Codex/ }).waitFor({
    state: "visible",
  });

  const deliveredPrompt = "Reply exactly DUET_ATTACHMENT_DELIVERED_TURN.";
  await attachImage(page, imagePath);
  await page.locator("#prompt-input").fill(deliveredPrompt);
  await page.locator("#prompt-input").press("Enter");
  await page.locator(".delivery-item.queued", { hasText: "1 image" }).waitFor({ state: "visible" });
  await page.screenshot({ path: path.join(screenshotRoot, "02-queued-attachment.png"), fullPage: true });

  await page.locator("#send-prompt").click();
  await waitForQueuedPromptDelivery(page, deliveredPrompt, 180000);
  await page.locator(".turn-card", { hasText: "DUET_ATTACHMENT_DELIVERED_TURN" }).first().waitFor({
    state: "visible",
    timeout: 120000,
  });
  await page.screenshot({ path: path.join(screenshotRoot, "03-delivered-turn.png"), fullPage: true });

  console.log(JSON.stringify({ screenshotRoot, success: true }, null, 2));
} finally {
  if (electronApp) {
    await electronApp.close();
  }
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
}

async function attachImage(page, imagePath) {
  await page.locator("#attachment-picker").setInputFiles(imagePath);
  await page.locator(".attachment-chip", { hasText: "red.png" }).waitFor({ state: "visible" });
}

async function waitForTaskDirectory(root, timeoutMs) {
  let found = null;
  await waitUntil(() => {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      entries = [];
    }
    found = entries.find((entry) => entry.isDirectory() && entry.name.startsWith("task-"))?.name ?? null;
    return Boolean(found);
  }, timeoutMs);
  return found;
}

async function waitForQueuedPromptDelivery(page, prompt, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await approveIfVisible(page, "Command approval requested", 500);
    await approveIfVisible(page, "File edit approval requested", 500);
    const undelivered = await page
      .locator(".delivery-item.undelivered", { hasText: prompt })
      .isVisible({ timeout: 500 })
      .catch(() => false);
    if (undelivered) {
      throw new Error("Queued attachment prompt became undelivered.");
    }
    const queued = await page
      .locator(".delivery-item", { hasText: prompt })
      .isVisible({ timeout: 500 })
      .catch(() => false);
    if (!queued) {
      return true;
    }
    await page.waitForTimeout(500);
  }
  throw new Error("Timed out waiting for queued attachment prompt delivery.");
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for condition.");
}

function redPngBytes() {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAC0lEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64",
  );
}
