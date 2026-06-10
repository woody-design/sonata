import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { approveIfVisible } from "./helpers/approval.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-usage-shots-"));
const settingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-usage-settings-"));
const screenshotRoot = path.resolve("..", "product-thinking", "usage-indicator-slice-1-evidence");
fs.mkdirSync(screenshotRoot, { recursive: true });

let electronApp = null;

try {
  fs.writeFileSync(
    path.join(settingsRoot, "reading-settings.json"),
    `${JSON.stringify({ theme: "duet", mode: "light", textStep: 16 }, null, 2)}\n`,
    "utf8",
  );

  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      DUET_PROJECTS_DIR: workspaceRoot,
      DUET_SETTINGS_DIR: settingsRoot,
    },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(240000);

  await page.locator("#new-task").click();
  await waitForRuntimeReady(page, 240000);
  await stageComposerForScreenshot(page);
  await page.locator("#usage-indicator").click();
  await page.locator(".usage-popover", { hasText: "No usage data yet" }).waitFor({
    state: "visible",
  });
  await page.screenshot({ path: path.join(screenshotRoot, "06-degraded-no-data.png") });
  await page.locator("#usage-indicator").click();

  await runPrompt(page, "Reply exactly DUET_USAGE_CODEX.");
  await waitForUsageSnapshot(page, 180000);
  await stageComposerForScreenshot(page);
  await page.screenshot({ path: path.join(screenshotRoot, "01-low-light.png") });

  await setReadingMode(page, "dark");
  await stageComposerForScreenshot(page);
  await page.screenshot({ path: path.join(screenshotRoot, "02-low-dark.png") });

  await simulateHighUsageRing(page);
  await stageComposerForScreenshot(page);
  await page.screenshot({ path: path.join(screenshotRoot, "03-high-warn-simulated.png") });

  await setReadingMode(page, "light");
  await stageComposerForScreenshot(page);
  await page.locator("#usage-indicator").click();
  await page.locator(".usage-popover", { hasText: /5-hour limit|Weekly/ }).waitFor({
    state: "visible",
  });
  await page.screenshot({ path: path.join(screenshotRoot, "04-popover-codex-live.png") });
  await page.locator("#usage-indicator").click();

  await page.locator("#new-claude-task").click();
  await waitForRuntimeReady(page, 240000);
  await runPrompt(page, "Reply exactly DUET_USAGE_CLAUDE.");
  await waitForUsageSnapshot(page, 240000);
  await stageComposerForScreenshot(page);
  await page.locator("#usage-indicator").click();
  await page.locator(".usage-popover", { hasText: /5-hour limit|Weekly/ }).waitFor({
    state: "visible",
  });
  await page.screenshot({ path: path.join(screenshotRoot, "05-popover-claude-live.png") });

  console.log(JSON.stringify({ screenshotRoot, success: true }, null, 2));
} finally {
  if (electronApp) {
    await electronApp.close();
  }
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(settingsRoot, { recursive: true, force: true });
}

async function runPrompt(page, prompt) {
  await page.locator("#prompt-input").fill(prompt);
  await page.locator("#send-prompt").click();
  await approveIfVisible(page, "Workspace trust requested", 1000);
  await page.locator(".turn-card", { hasText: prompt }).first().waitFor({
    state: "visible",
    timeout: 180000,
  });
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

async function waitForUsageSnapshot(page, timeoutMs) {
  await page.waitForFunction(
    () => {
      const indicator = document.querySelector("#usage-indicator");
      return (
        indicator instanceof HTMLButtonElement &&
        !indicator.disabled &&
        (indicator.getAttribute("title") ?? "").includes("context left")
      );
    },
    undefined,
    { timeout: timeoutMs },
  );
}

async function stageComposerForScreenshot(page) {
  await page.evaluate(() => {
    const composer = document.querySelector("#composer");
    if (!(composer instanceof HTMLElement)) {
      throw new Error("Composer was not found.");
    }
    Object.assign(composer.style, {
      position: "fixed",
      left: "42px",
      right: "220px",
      top: "260px",
      bottom: "auto",
      margin: "0",
      zIndex: "9999",
    });
  });
  await page.waitForTimeout(100);
}

async function setReadingMode(page, mode) {
  await page.evaluate((nextMode) => {
    document.documentElement.dataset.mode = nextMode;
    document.documentElement.dataset.readingModeSetting = nextMode;
  }, mode);
}

async function simulateHighUsageRing(page) {
  await page.evaluate(() => {
    const indicator = document.querySelector("#usage-indicator");
    if (!(indicator instanceof HTMLElement)) {
      throw new Error("Usage indicator was not found.");
    }
    indicator.classList.remove("empty");
    indicator.classList.add("high");
    indicator.style.setProperty("--usage-ring-dashoffset", "12");
    indicator.title = "12% context left";
    indicator.setAttribute("aria-label", "12% context left");
  });
}
