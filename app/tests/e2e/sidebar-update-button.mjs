// Auto-update S2 acceptance fence: the sidebar update pill, driven end-to-end
// through the REAL updater-state broadcast channel from the main side (the same
// mechanism the sidebar-chrome e2e uses for runtime events — webContents.send on
// the production channel, no test-only renderer hook). Exercises both pill
// states, asserts the ONE click reaches the restart IPC without ever letting a
// real quitAndInstall run, and holds the footer's always-visible contract (the
// pill's slot hides at idle; the Settings entry beside it does not).
//
// Re-scoped 2026-07-27 with the pill's two-state collapse: the armed inline
// confirm and its two revert gestures (timeout, outside click) are gone, so the
// single click that used to only ARM now restarts.
//
// Injection choice: main-side `webContents.send(IPC_CHANNELS.updaterState, …)`
// drives the exact channel `broadcastUpdaterState` uses, so the preload
// subscription + renderer wiring are the production path. The restart IPC is
// OBSERVED by swapping the main-side ipcMain handler for a recorder before the
// restart click — this proves the renderer→preload→ipcMain invocation on the
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
// The retired armed confirm reverted on a 6s timer (ARM_REVERT_MS). Step (c)
// settles past that window before re-asserting, so a regression that brings
// back a TIMER-driven dismiss fails here instead of passing a same-tick check.
const RETIRED_ARM_REVERT_SETTLE_MS = 7_000;
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
  // The footer around it stays put: its Settings entry is always reachable.
  assertEqual(await button.isVisible(), false, "pill hidden at idle");
  assertEqual(
    await slot.evaluate((element) => getComputedStyle(element).display),
    "none",
    "idle slot reserves no layout (display:none)",
  );
  assertEqual(
    await page.locator("#sidebar-settings").isVisible(),
    true,
    "footer settings entry visible at idle",
  );

  // (b) appears on staged — a downloaded+staged broadcast lights the resting pill.
  await sendUpdaterState(electronApp, { status: "staged", version: STAGED_VERSION });
  await button.waitFor({ state: "visible" });
  assertEqual(await button.textContent(), "Restart to Update", "resting label");
  assertEqual(
    await button.getAttribute("data-tooltip"),
    `Sonata ${STAGED_VERSION}`,
    "staged-version tooltip",
  );
  await captureSidebar(page, "01-restart-to-update");

  // (c) the resting pill survives unrelated interaction — with the armed
  // confirm retired there is nothing left to stand down, so a click elsewhere
  // in the sidebar must leave the label exactly where it is. Asserted twice:
  // immediately (catches a dismiss re-added to a click handler) and again past
  // the retired arm-revert window (catches a timer-driven one — the exact shape
  // of the mechanism this slice deleted, which a same-tick check cannot see).
  await page.locator("#sidebar-new-chat").click();
  assertEqual(
    await button.textContent(),
    "Restart to Update",
    "resting label survives an outside click",
  );
  await page.waitForTimeout(RETIRED_ARM_REVERT_SETTLE_MS);
  assertEqual(
    await button.textContent(),
    "Restart to Update",
    "resting label still stands after the retired arm-revert window",
  );

  // (d) + (e) ONE click reaches the restart IPC; the pill goes to a disabled
  // "Installing…". Swap the main-side handler for a recorder first, so the real
  // path is exercised up to ipcMain but no quitAndInstall can fire.
  await installRestartRecorder(electronApp);
  await button.click();
  await waitForLabel(page, "Installing…");
  assertEqual(await button.textContent(), "Installing…", "updating label");
  assertEqual(await button.isDisabled(), true, "updating pill is disabled");
  assertEqual(
    await readRestartCount(electronApp),
    1,
    "one click invoked the restart IPC exactly once",
  );
  await captureSidebar(page, "02-installing");

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
