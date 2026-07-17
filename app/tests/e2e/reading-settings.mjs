import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-reading-settings-workspace-"));
const settingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-reading-settings-store-"));
const settingsPath = path.join(settingsRoot, "reading-settings.json");
let electronApp = null;

try {
  fs.writeFileSync(
    settingsPath,
    `${JSON.stringify({ theme: "calm", mode: "dark", textStep: 20 }, null, 2)}\n`,
    "utf8",
  );

  let page = await launchApp();
  await page.locator(".task-entry-panel", { hasText: "What should we work on" }).waitFor({
    state: "visible",
  });
  const coldBoot = await readReadingDom(page);
  assertEqual(coldBoot.firstFrame, "calm/dark/20px", "cold boot first frame");
  assertEqual(coldBoot.theme, "calm", "cold boot theme");
  assertEqual(coldBoot.mode, "dark", "cold boot resolved mode");
  assertEqual(coldBoot.modeSetting, "dark", "cold boot mode setting");
  assertEqual(coldBoot.textBody, "20px", "cold boot text size");

  await page.locator("#reading-settings").click();
  await page.locator(".reading-settings-popover").waitFor({ state: "visible" });
  await page.locator(".reading-theme-card", { hasText: "Focus" }).click();
  await page.locator(".reading-segment", { hasText: "Light" }).click();
  for (let index = 0; index < 4; index += 1) {
    await page.locator(".reading-size-button", { hasText: "A-" }).click();
  }

  await waitUntil(() => {
    const persisted = readPersistedSettings();
    return persisted.theme === "focus" && persisted.mode === "light" && persisted.textStep === 14;
  }, 8000);

  const changed = await readReadingDom(page);
  assertEqual(changed.theme, "focus", "changed theme");
  assertEqual(changed.mode, "light", "changed resolved mode");
  assertEqual(changed.modeSetting, "light", "changed mode setting");
  assertEqual(changed.textBody, "14px", "changed text size");

  await electronApp.close();
  electronApp = null;

  page = await launchApp();
  await page.locator(".task-entry-panel", { hasText: "What should we work on" }).waitFor({
    state: "visible",
  });
  const relaunched = await readReadingDom(page);
  assertEqual(relaunched.firstFrame, "focus/light/14px", "relaunch first frame");
  assertEqual(relaunched.theme, "focus", "relaunch theme");
  assertEqual(relaunched.mode, "light", "relaunch resolved mode");
  assertEqual(relaunched.modeSetting, "light", "relaunch mode setting");
  assertEqual(relaunched.textBody, "14px", "relaunch text size");

  await electronApp.close();
  electronApp = null;

  fs.writeFileSync(settingsPath, "{ not valid json", "utf8");
  page = await launchApp();
  await page.locator(".task-entry-panel", { hasText: "What should we work on" }).waitFor({
    state: "visible",
  });
  const defaults = await readReadingDom(page);
  assertEqual(defaults.theme, "sonata", "corrupt settings default theme");
  assertEqual(defaults.modeSetting, "auto", "corrupt settings default mode setting");
  assertEqual(defaults.textBody, "16px", "corrupt settings default text size");
  if (defaults.mode !== "light" && defaults.mode !== "dark") {
    throw new Error(`Corrupt settings did not resolve auto to an explicit mode: ${defaults.mode}`);
  }
  assertEqual(defaults.firstFrame, `sonata/${defaults.mode}/16px`, "corrupt settings first frame");
  await setNativeThemeSource("light");
  await waitForResolvedMode(page, "light");
  await setNativeThemeSource("dark");
  await waitForResolvedMode(page, "dark");
  await setNativeThemeSource("light");
  await waitForResolvedMode(page, "light");
  await setNativeThemeSource("system");

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        settingsPath,
        coldBoot,
        changed,
        relaunched,
        defaults,
        success: true,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (electronApp) {
    await electronApp.close();
  }
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(settingsRoot, { recursive: true, force: true });
}

async function launchApp() {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      SONATA_DATA_DIR: workspaceRoot, SONATA_WORKSPACES_DIR: workspaceRoot,
      SONATA_SETTINGS_DIR: settingsRoot,
    },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(60000);
  return page;
}

async function readReadingDom(page) {
  await page.waitForFunction(() => Boolean(document.documentElement.dataset.readingFirstFrame));
  return page.evaluate(() => {
    const root = document.documentElement;
    return {
      theme: root.dataset.theme ?? "",
      mode: root.dataset.mode ?? "",
      modeSetting: root.dataset.readingModeSetting ?? "",
      textBody: window.getComputedStyle(root).getPropertyValue("--text-body").trim(),
      firstFrame: root.dataset.readingFirstFrame ?? "",
    };
  });
}

async function setNativeThemeSource(source) {
  await electronApp.evaluate(
    ({ nativeTheme }, nextSource) => {
      nativeTheme.themeSource = nextSource;
    },
    source,
  );
}

async function waitForResolvedMode(page, mode) {
  await page.waitForFunction(
    (expectedMode) => document.documentElement.dataset.mode === expectedMode,
    mode,
  );
}

function readPersistedSettings() {
  return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for persisted reading settings.");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
