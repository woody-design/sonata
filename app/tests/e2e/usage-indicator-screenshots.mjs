import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { chooseDraftProvider, openNewChat, sendFirstPrompt } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-usage-shots-"));
const settingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-usage-settings-"));
const screenshotRoot = path.resolve("..", "product-thinking", "usage-indicator-slice-1-evidence");
fs.mkdirSync(screenshotRoot, { recursive: true });

let electronApp = null;

try {
  fs.writeFileSync(
    path.join(settingsRoot, "reading-settings.json"),
    `${JSON.stringify({ theme: "default", mode: "light", textStep: 16 }, null, 2)}\n`,
    "utf8",
  );

  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      SONATA_DATA_DIR: workspaceRoot, SONATA_WORKSPACES_DIR: workspaceRoot,
      SONATA_SETTINGS_DIR: settingsRoot,
    },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(240000);

  // Sessions are born from the first composer message; the indicator is
  // disabled until the session exists, so the degraded (no usage data yet)
  // state is captured between session creation and the first usage snapshot.
  await sendFirstPrompt(page, "Reply exactly SONATA_USAGE_CODEX.");
  await stageComposerForScreenshot(page);
  await page.locator("#usage-indicator").click();
  await page.locator(".usage-popover", { hasText: "No usage data yet" }).waitFor({
    state: "visible",
  });
  await page.screenshot({ path: path.join(screenshotRoot, "06-degraded-no-data.png") });
  await page.locator("#usage-indicator").click();

  await page.locator(".turn-card", { hasText: "Reply exactly SONATA_USAGE_CODEX." }).first().waitFor({
    state: "visible",
    timeout: 180000,
  });
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

  await openNewChat(page);
  await chooseDraftProvider(page, "claude");
  await runPrompt(page, "Reply exactly SONATA_USAGE_CLAUDE.");
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
  // The first prompt of a fresh chat creates the session (deferred creation)
  // and answers the workspace-trust approval during the provider cold start.
  await sendFirstPrompt(page, prompt);
  await page.locator(".turn-card", { hasText: prompt }).first().waitFor({
    state: "visible",
    timeout: 180000,
  });
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
