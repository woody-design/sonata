// Cross-launch fullscreen persistence for the MAIN window.
//
// Guards the trickiest correctness property: a fullscreen window persists the
// fullscreen *flag* separately from its *normal* bounds (via getNormalBounds),
// so on relaunch it reopens fullscreen, and leaving fullscreen returns to the
// size it had before — never the full-screen rectangle.
//
// Requires a real window server (setFullScreen is a no-op under headless/xvfb),
// so this is a local-mac check rather than a headless-CI one.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-window-fs-e2e-"));
const stateFile = path.join(dataRoot, "config", "window-state.json");
// Above the main window's minimums so setBounds is honored verbatim.
const normalBounds = { x: 200, y: 140, width: 1100, height: 760 };
// Pin SONATA_SETTINGS_DIR too (precedence over sonataConfigDir, exported by the
// workshop launcher) so the app and this test agree on the state file path.
const env = {
  ...process.env,
  SONATA_DATA_DIR: dataRoot,
  SONATA_WORKSPACES_DIR: dataRoot,
  SONATA_SETTINGS_DIR: path.join(dataRoot, "config"),
};

let app = null;
try {
  // ── Launch 1: establish normal bounds, enter fullscreen, quit ─────────────
  app = await electron.launch({ args: ["dist/main/main.js"], env });
  await app.firstWindow();
  await setBounds(app, normalBounds);
  await waitBounds(app, normalBounds);
  await setFullScreen(app, true);
  const enteredFs = await pollFullScreen(app, true, 8000);
  await app.close();
  app = null;

  // Persisted state keeps the fullscreen flag AND the normal (pre-fullscreen)
  // bounds — not the full-screen rectangle.
  const persisted = JSON.parse(fs.readFileSync(stateFile, "utf8")).main ?? {};
  const flagPersisted = persisted.isFullScreen === true;
  const normalBoundsPersisted = boundsMatch(persisted, normalBounds);

  // ── Launch 2: reopen fullscreen; exiting returns to the normal bounds ─────
  app = await electron.launch({ args: ["dist/main/main.js"], env });
  await app.firstWindow();
  const restoredFs = await pollFullScreen(app, true, 12000);
  await setFullScreen(app, false);
  await pollFullScreen(app, false, 8000);
  const boundsAfterExit = await getBounds(app);
  const returnedToNormal = boundsMatch(boundsAfterExit, normalBounds);

  const success =
    enteredFs && flagPersisted && normalBoundsPersisted && restoredFs && returnedToNormal;
  console.log(
    JSON.stringify(
      {
        dataRoot,
        persisted,
        flagPersisted,
        normalBoundsPersisted,
        restoredFs,
        boundsAfterExit,
        returnedToNormal,
        success,
      },
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

async function setBounds(app, bounds) {
  await app.evaluate(({ BrowserWindow }, b) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === "Sonata");
    if (!win) throw new Error("main window not found");
    win.setBounds(b);
  }, bounds);
}

async function getBounds(app) {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === "Sonata");
    if (!win) throw new Error("main window not found");
    return win.getBounds();
  });
}

async function setFullScreen(app, value) {
  await app.evaluate(({ BrowserWindow }, v) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === "Sonata");
    if (!win) throw new Error("main window not found");
    win.setFullScreen(v);
  }, value);
}

async function pollFullScreen(app, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const isFs = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === "Sonata");
      return win ? win.isFullScreen() : null;
    });
    if (isFs === expected) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function waitBounds(app, expected) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (boundsMatch(await getBounds(app), expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("main window bounds did not settle");
}

function boundsMatch(actual, expected) {
  return ["x", "y", "width", "height"].every(
    (key) => Math.abs((actual?.[key] ?? Number.NaN) - expected[key]) <= 24,
  );
}
