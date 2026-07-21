// Terminal appearance persistence fence (theme M2 review MINOR-1).
//
// The one seam no unit fence can see: the renderer's picker click must travel
// the WHOLE chain — IPC → main's writeTerminalWindowSettings merge (the line a
// silent deletion would orphan: renderer-local state masks the loss until the
// next launch) → normalize → store → disk — and the next launch must read it
// back and APPLY it. Effect over artifact: we assert the settings file's bytes
// AND the relaunched window's stamped root + picker state, for all three axes
// (scheme, mode, fontSize) in one pass.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { waitForWindowByUrl } from "./helpers/session.mjs";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-terminal-appearance-e2e-"));
const launchEnv = {
  ...process.env,
  SONATA_DATA_DIR: dataRoot,
  SONATA_WORKSPACES_DIR: dataRoot,
  SONATA_SETTINGS_DIR: path.join(dataRoot, "config"),
};
const settingsFile = path.join(dataRoot, "config", "terminal-window-settings.json");

const results = {};
let app = null;

async function launchAndGetTerminal() {
  const launched = await electron.launch({ args: ["dist/main/main.js"], env: launchEnv });
  const main = await waitForWindowByUrl(launched, "index.html");
  main.setDefaultTimeout(120000);
  await main.locator(".task-entry-panel, #run-list").first().waitFor({ state: "visible" });
  const terminal = await waitForWindowByUrl(launched, "terminal.html");
  terminal.setDefaultTimeout(60000);
  await terminal.locator(".terminal-window-shell").waitFor({ state: "visible" });
  return { launched, terminal };
}

try {
  // ── Session 1: pick a non-default triple through the real picker. ──────────
  const first = await launchAndGetTerminal();
  app = first.launched;
  const cli = first.terminal;

  await cli.locator("#terminal-theme-trigger").click();
  await cli.locator(".terminal-theme-popover").waitFor({ state: "visible" });
  await cli.locator('[data-scheme-choice="gruvbox"]').click();
  await cli.locator('[data-mode-choice="light"]').click();
  await cli.locator('.terminal-size-btn[aria-label="Increase text size"]').click();
  await cli.locator('html[data-term-scheme="gruvbox"][data-mode="light"]').waitFor({
    state: "attached",
  });
  results.pickedValueShown =
    (await cli.locator(".terminal-size-value").textContent()) === "14";

  // The write is fire-and-forget from the renderer; poll the disk for the
  // effect rather than trusting any in-memory echo.
  const deadline = Date.now() + 10000;
  let persisted = null;
  while (Date.now() < deadline) {
    try {
      persisted = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
      if (
        persisted.scheme === "gruvbox" &&
        persisted.mode === "light" &&
        persisted.fontSize === 14
      ) {
        break;
      }
    } catch {
      // Not written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  results.diskHoldsPickedTriple =
    persisted?.scheme === "gruvbox" && persisted?.mode === "light" && persisted?.fontSize === 14;

  await app.close();
  app = null;

  // ── Session 2: the same data dir must come back wearing the choice. ────────
  const second = await launchAndGetTerminal();
  app = second.launched;
  const cli2 = second.terminal;

  await cli2
    .locator('html[data-term-scheme="gruvbox"][data-mode="light"]')
    .waitFor({ state: "attached" });
  results.rebootRestoredRoot = true;

  await cli2.locator("#terminal-theme-trigger").click();
  await cli2.locator(".terminal-theme-popover").waitFor({ state: "visible" });
  results.rebootPickerScheme = await cli2
    .locator('[data-scheme-choice="gruvbox"]')
    .evaluate((el) => el.classList.contains("selected") && el.getAttribute("aria-pressed") === "true");
  results.rebootPickerMode = await cli2
    .locator('[data-mode-choice="light"]')
    .evaluate((el) => el.classList.contains("selected"));
  results.rebootPickerSize =
    (await cli2.locator(".terminal-size-value").textContent()) === "14";

  const success = Object.values(results).every(Boolean);
  console.log(JSON.stringify({ dataRoot, results, success }, null, 2));
  process.exitCode = success ? 0 : 1;
} catch (error) {
  console.error("terminal-appearance-persistence e2e threw:", error);
  console.log(JSON.stringify({ results }, null, 2));
  process.exitCode = 1;
} finally {
  if (app) {
    await app.close();
  }
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
