// Auto-update S2 acceptance fence: the sidebar update pill, driven end-to-end
// through the REAL updater-state broadcast channel from the main side (the same
// mechanism the sidebar-chrome e2e uses for runtime events — webContents.send on
// the production channel, no test-only renderer hook). Exercises all four states
// and the two revert gestures, and asserts the confirm click reaches the restart
// IPC without ever letting a real quitAndInstall run.
//
// Injection choice: main-side `webContents.send(IPC_CHANNELS.updaterState, …)`
// drives the exact channel `broadcastUpdaterState` uses, so the preload
// subscription + renderer wiring are the production path. The restart IPC is
// OBSERVED by swapping the main-side ipcMain handler for a recorder before the
// confirm click — this proves the renderer→preload→ipcMain invocation on the
// real channel while guaranteeing no ShipIt handoff (the dev gate would no-op it
// anyway, but the swap makes that independent of the gate).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { createSidebarFixture } from "./helpers/sidebar-fixture.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const appRoot = path.join(repoRoot, "app");
const outputDir = path.resolve(
  process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), "sonata-update-button-out-")),
);
fs.mkdirSync(outputDir, { recursive: true });

const UPDATER_STATE_CHANNEL = "updater:state";
const UPDATER_RESTART_CHANNEL = "updater:restart";
const STAGED_VERSION = "0.2.0";
const viewport = { width: 1280, height: 800 };
const screenshots = [];
const pageErrors = [];
let fixture = null;
let electronApp = null;

try {
  fixture = createSidebarFixture();
  electronApp = await electron.launch({
    args: [path.join(appRoot, "dist", "main", "main.js"), `--user-data-dir=${fixture.userDataDir}`],
    env: isolatedElectronEnv(fixture.env),
  });
  const page = await electronApp.firstWindow();
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
  page.setDefaultTimeout(60_000);
  await page.setViewportSize(viewport);
  await page.locator(".sidebar").waitFor({ state: "visible" });

  const slot = page.locator("#sidebar-update-slot");
  const button = page.locator("#sidebar-update-button");

  // (a) hidden at idle — the pill reserves no visible space when nothing is
  // staged. Hydration read on boot returns idle (dev gate), so it starts hidden.
  assertEqual(await button.isVisible(), false, "pill hidden at idle");
  assertEqual(
    await slot.evaluate((element) => getComputedStyle(element).display),
    "none",
    "idle slot reserves no layout (display:none)",
  );

  // (b) appears on staged — a downloaded+staged broadcast lights the resting pill.
  await sendUpdaterState(electronApp, { status: "staged", version: STAGED_VERSION });
  await button.waitFor({ state: "visible" });
  assertEqual(await button.textContent(), "Update", "resting label");
  assertEqual(
    await button.getAttribute("data-tooltip"),
    `Sonata ${STAGED_VERSION}`,
    "staged-version tooltip",
  );
  await captureSidebar(page, "01-update");

  // (c) arm on click — the inline confirm.
  await button.click();
  await waitForLabel(page, "Restart to Update");
  assertEqual(await button.textContent(), "Restart to Update", "armed label");
  await captureSidebar(page, "02-armed");

  // (d) auto-revert after the arm timeout (~6s) with no confirmation.
  await waitForLabel(page, "Update", 12_000);
  assertEqual(await button.textContent(), "Update", "armed reverts on timeout");

  // (e) revert on outside interaction — arm, then click elsewhere in the sidebar.
  await button.click();
  await waitForLabel(page, "Restart to Update");
  await page.locator("#sidebar-new-chat").click();
  await waitForLabel(page, "Update");
  assertEqual(await button.textContent(), "Update", "armed reverts on outside click");

  // (f) + (g) confirm reaches the restart IPC; the pill goes to a disabled
  // "Updating…". Swap the main-side handler for a recorder first, so the real
  // path is exercised up to ipcMain but no quitAndInstall can fire.
  await installRestartRecorder(electronApp);
  await button.click();
  await waitForLabel(page, "Restart to Update");
  await button.click();
  await waitForLabel(page, "Updating…");
  assertEqual(await button.textContent(), "Updating…", "updating label");
  assertEqual(await button.isDisabled(), true, "updating pill is disabled");
  assertEqual(await readRestartCount(electronApp), 1, "confirm invoked the restart IPC exactly once");
  await captureSidebar(page, "03-updating");

  assertDeepEqual(pageErrors, [], "renderer page errors");
  console.log(
    JSON.stringify({ success: true, outputDir, screenshots }, null, 2),
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    if (electronApp) {
      await electronApp.close();
    }
  } catch (error) {
    console.error("Failed to close update-button Electron app:", error);
    process.exitCode = 1;
  } finally {
    fixture?.cleanup();
  }
}

async function sendUpdaterState(app, state) {
  await app.evaluate(
    ({ BrowserWindow }, { channel, payload }) => {
      const target = BrowserWindow.getAllWindows().find(
        (window) =>
          !window.isDestroyed() && /\/index\.html(?:$|[?#])/.test(window.webContents.getURL()),
      );
      if (!target) {
        throw new Error("Reading window not found for updater-state broadcast");
      }
      target.webContents.send(channel, payload);
    },
    { channel: UPDATER_STATE_CHANNEL, payload: state },
  );
}

async function installRestartRecorder(app) {
  await app.evaluate(({ ipcMain }, channel) => {
    ipcMain.removeHandler(channel);
    globalThis.__sonataRestartCount = 0;
    ipcMain.handle(channel, () => {
      globalThis.__sonataRestartCount += 1;
    });
  }, UPDATER_RESTART_CHANNEL);
}

async function readRestartCount(app) {
  return app.evaluate(() => globalThis.__sonataRestartCount ?? 0);
}

async function waitForLabel(page, label, timeout = 60_000) {
  await page.waitForFunction(
    ({ text }) => {
      const node = document.getElementById("sidebar-update-button");
      return node instanceof HTMLElement && node.textContent === text;
    },
    { text: label },
    { timeout },
  );
}

async function captureSidebar(page, name) {
  const file = path.join(outputDir, `${name}.png`);
  await page.locator(".sidebar").screenshot({ path: file, animations: "disabled" });
  screenshots.push(file);
}

function isolatedElectronEnv(overrides) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("SONATA_")) {
      delete env[key];
    }
  }
  return { ...env, ...overrides, SONATA_LOCAL_API: "0", SONATA_NOTIFICATIONS: "0" };
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, label) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${label}: expected ${expectedJson}, got ${actualJson}`);
  }
}
