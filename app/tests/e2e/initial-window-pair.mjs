import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright-core";

const require = createRequire(import.meta.url);
const { planInitialWindowPair } = require("../../dist/main/initial-window-layout");
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-initial-window-pair-e2e-"));
const configDir = path.join(dataRoot, "config");
const launchEnv = {
  ...process.env,
  SONATA_DATA_DIR: dataRoot,
  SONATA_WORKSPACES_DIR: dataRoot,
  SONATA_SETTINGS_DIR: configDir,
  SONATA_NOTIFICATIONS: "0",
};

let app = null;
try {
  app = await electron.launch({ args: ["dist/main/main.js"], env: launchEnv });
  await app.firstWindow();
  const snapshot = await waitForWindowPair(app);
  const expected = planInitialWindowPair(snapshot.workArea);
  if (!expected) {
    throw new Error(`Test display is too small for the initial pair: ${JSON.stringify(snapshot)}`);
  }

  const mainMatches = boundsMatch(snapshot.windows.Sonata, expected.main);
  const terminalMatches = boundsMatch(snapshot.windows["Sonata CLI"], expected.terminal);
  const minimumsMatch =
    JSON.stringify(snapshot.minimums.Sonata) === JSON.stringify([720, 640]) &&
    JSON.stringify(snapshot.minimums["Sonata CLI"]) === JSON.stringify([420, 360]);
  const adjacent =
    snapshot.windows.Sonata.x + snapshot.windows.Sonata.width + 8 ===
      snapshot.windows["Sonata CLI"].x &&
    snapshot.windows.Sonata.y === snapshot.windows["Sonata CLI"].y &&
    snapshot.windows.Sonata.height === snapshot.windows["Sonata CLI"].height;
  const success = mainMatches && terminalMatches && minimumsMatch && adjacent;

  console.log(
    JSON.stringify(
      {
        workArea: snapshot.workArea,
        expected,
        actual: snapshot.windows,
        mainMatches,
        terminalMatches,
        minimums: snapshot.minimums,
        minimumsMatch,
        adjacent,
        success,
      },
      null,
      2,
    ),
  );
  process.exitCode = success ? 0 : 1;
} finally {
  if (app) await app.close();
  fs.rmSync(dataRoot, { recursive: true, force: true });
}

async function waitForWindowPair(app) {
  const deadline = Date.now() + 15000;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await app.evaluate(({ BrowserWindow, screen }) => ({
      workArea: screen.getPrimaryDisplay().workArea,
      windows: Object.fromEntries(
        BrowserWindow.getAllWindows().map((window) => [window.getTitle(), window.getBounds()]),
      ),
      minimums: Object.fromEntries(
        BrowserWindow.getAllWindows().map((window) => [window.getTitle(), window.getMinimumSize()]),
      ),
    }));
    if (latest.windows.Sonata && latest.windows["Sonata CLI"]) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Window pair did not open: ${JSON.stringify(latest)}`);
}

function boundsMatch(actual, expected) {
  return ["x", "y", "width", "height"].every(
    (key) => Math.abs((actual?.[key] ?? Number.NaN) - expected[key]) <= 2,
  );
}
