// Remote Control global default (#4): the Settings toggle "Start new sessions
// with Remote Control" persists to claude-settings.json, immediately arms the
// New Chat header button, and re-arms it on the next launch (boot hydrate).
// No `claude` is spawned — this is pure settings + draft wiring.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-rcdef-e2e-"));
const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-rcdef-settings-"));
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-rcdef-userdata-"));
const selectedFolder = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-rcdef-folder-"));
let electronApp = null;
const pageErrors = [];

try {
  // ── Launch 1: default is OFF; toggle it ON in Settings. ──
  let page = await launchApp();
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  await page.locator(".task-entry-panel", { hasText: "What should we work on" }).waitFor({ state: "visible" });
  const armedBeforeSetting = await page.locator('#remote-control-toggle[aria-pressed="true"]').count();

  await openSettings(page);
  await page.locator(".settings-group[aria-label='Remote control'] .settings-switch[aria-checked='false']").waitFor();
  await page.locator(".settings-group[aria-label='Remote control'] .settings-switch").click();
  await page.locator(".settings-group[aria-label='Remote control'] .settings-switch[aria-checked='true']").waitFor();
  await page.keyboard.press("Escape");
  await page.locator(".settings-window").waitFor({ state: "hidden" });

  // Immediately reflected in the New Chat header button (no relaunch).
  await page.locator('#remote-control-toggle[aria-pressed="true"]').waitFor({ state: "visible", timeout: 10000 });
  const armedAfterSetting = await page.locator('#remote-control-toggle[aria-pressed="true"]').count();

  // Persisted to disk.
  const persisted = JSON.parse(fs.readFileSync(path.join(settingsDir, "claude-settings.json"), "utf8"));

  await electronApp.close();
  electronApp = null;

  // ── Launch 2: the New Chat button is armed on boot (hydrate from setting). ──
  page = await launchApp();
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  await page.locator(".task-entry-panel", { hasText: "What should we work on" }).waitFor({ state: "visible" });
  await page.locator('#remote-control-toggle[aria-pressed="true"]').waitFor({ state: "visible", timeout: 10000 });
  const armedOnBoot = await page.locator('#remote-control-toggle[aria-pressed="true"]').count();

  const success =
    armedBeforeSetting === 0 &&
    armedAfterSetting === 1 &&
    persisted.defaultRemoteControl === true &&
    armedOnBoot === 1 &&
    pageErrors.length === 0;

  console.log(
    JSON.stringify(
      { armedBeforeSetting, armedAfterSetting, persistedFlag: persisted.defaultRemoteControl, armedOnBoot, pageErrors, success },
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

async function openSettings(page) {
  await electronApp.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById("settings")?.click();
  });
  await page.locator(".settings-window").waitFor();
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
  page.setDefaultTimeout(60000);
  return page;
}
