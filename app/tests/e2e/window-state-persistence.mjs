// Cross-launch window-state persistence for the MAIN window.
//
// The floating-window lifecycle test covers within-session restore; this covers
// the headline feature: resize/move the main window, fully quit, relaunch, and
// confirm the window reopens at the same size + position — persisted to
// `<DUET_DATA_DIR>/config/window-state.json` and re-applied on next launch.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-window-state-e2e-"));
const windowStateFile = path.join(dataRoot, "config", "window-state.json");
// Within each display's work area on any reasonable test machine, and above the
// main window's 960x640 minimums so setBounds is honored verbatim.
const targetBounds = { x: 160, y: 120, width: 1120, height: 780 };
// Pin DUET_SETTINGS_DIR too: it takes precedence over duetConfigDir() in
// windowStatePath(), and the workshop launcher exports it — without this the
// app would write outside dataRoot and the test would read the wrong file.
const launchEnv = {
  ...process.env,
  DUET_DATA_DIR: dataRoot,
  DUET_WORKSPACES_DIR: dataRoot,
  DUET_SETTINGS_DIR: path.join(dataRoot, "config"),
};

let app = null;
try {
  // ── Launch 1: move/resize the main window, then quit ──────────────────────
  app = await electron.launch({ args: ["dist/main/main.js"], env: launchEnv });
  await app.firstWindow();
  await setWindowBounds(app, "Duet", targetBounds);
  const movedBounds = await waitForWindowBounds(app, "Duet", targetBounds);
  await app.close();
  app = null;

  // The quit must have written the geometry to disk.
  const persisted = JSON.parse(fs.readFileSync(windowStateFile, "utf8"));
  const persistedBounds = persisted?.main ?? null;
  const persistedOk =
    boundsMatch(persistedBounds, targetBounds) && persisted?.main?.isFullScreen !== true;

  // ── Launch 2: a fresh process must reopen the main window at those bounds ──
  app = await electron.launch({ args: ["dist/main/main.js"], env: launchEnv });
  await app.firstWindow();
  const restoredBounds = await waitForWindowBounds(app, "Duet", targetBounds);

  const restoredOk = boundsMatch(restoredBounds, targetBounds);
  const success = persistedOk && restoredOk;

  console.log(
    JSON.stringify(
      { dataRoot, movedBounds, persistedBounds, restoredBounds, persistedOk, restoredOk, success },
      null,
      2,
    ),
  );
  process.exitCode = success ? 0 : 1;
} finally {
  if (app) {
    await app.close();
  }
  fs.rmSync(dataRoot, { recursive: true, force: true });
}

async function setWindowBounds(app, title, bounds) {
  await app.evaluate(
    ({ BrowserWindow }, payload) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === payload.title);
      if (!win) {
        throw new Error(`Window not found: ${payload.title}`);
      }
      win.setBounds(payload.bounds);
    },
    { title, bounds },
  );
}

async function getWindowBounds(app, title) {
  return app.evaluate(({ BrowserWindow }, requestedTitle) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === requestedTitle);
    if (!win) {
      throw new Error(`Window not found: ${requestedTitle}`);
    }
    return win.getBounds();
  }, title);
}

async function waitForWindowBounds(app, title, expected) {
  const deadline = Date.now() + 10000;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await getWindowBounds(app, title);
    if (boundsMatch(latest, expected)) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Window bounds did not settle for ${title}: expected=${JSON.stringify(
      expected,
    )} actual=${JSON.stringify(latest)}`,
  );
}

function boundsMatch(actual, expected) {
  return ["x", "y", "width", "height"].every(
    (key) => Math.abs((actual?.[key] ?? Number.NaN) - expected[key]) <= 24,
  );
}
