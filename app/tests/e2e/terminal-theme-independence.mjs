// Terminal-theme independence fence (S1 findings §2b P1 follow-up).
//
// The preload gate `isReadingThemedDocument()` excludes terminal.html: the
// terminal owns its OWN theme (its Aa picker) and must NOT follow the Reading
// window's theme. S1's near-regression was the content-fallback sweeping
// terminal.html into the reading-stamp path (a static data-theme="duet" that
// equals the reading default), which armed the readingSettingsChanged listener
// and fought terminal.ts's theme ownership. This fences that the terminal's root
// theme SURVIVES a Reading-theme change — i.e. it stays excluded.
//
// The terminal window is default-on, so it appears beside the main window with
// no extra setup. We change the reading appearance (a full-settings broadcast
// that reaches EVERY window), witness it landing on the Preview satellite (which
// DOES follow the reading theme), and assert the terminal's root theme/mode did
// not move — the two satellites diverge exactly at the preload gate.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { waitForWindowByUrl } from "./helpers/session.mjs";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-terminal-theme-e2e-"));
const launchEnv = {
  ...process.env,
  DUET_DATA_DIR: dataRoot,
  DUET_WORKSPACES_DIR: dataRoot,
  DUET_SETTINGS_DIR: path.join(dataRoot, "config"),
};

const results = {};
let app = null;
try {
  app = await electron.launch({ args: ["dist/main/main.js"], env: launchEnv });
  const page = await app.firstWindow();
  page.setDefaultTimeout(120000);
  await page.locator(".task-entry-panel, #run-list").first().waitFor({ state: "visible" });

  // The terminal window is default-on; wait for it and record its own theme.
  const terminal = await waitForWindowByUrl(app, "terminal.html");
  terminal.setDefaultTimeout(60000);
  const terminalThemeBefore = await terminal.evaluate(() => ({
    theme: document.documentElement.dataset.theme ?? "",
    mode: document.documentElement.dataset.mode ?? "",
  }));
  results.terminalHasOwnTheme = terminalThemeBefore.theme.length > 0;

  // Change the reading appearance through the settings popover (Focus + Dark) —
  // the same gesture reading-settings.mjs uses. This both applies to the Reading
  // window locally AND broadcasts readingSettingsChanged to EVERY window; the
  // terminal receives it and must ignore it. Focus differs from the terminal's
  // default ("duet"), so a leak would be unmistakable.
  const readingTheme = "focus";
  await page.locator("#reading-settings").click();
  await page.locator(".reading-settings-popover").waitFor({ state: "visible" });
  await page.locator(".reading-theme-card", { hasText: "Focus" }).click();
  await page.locator(".reading-segment", { hasText: "Dark" }).click();

  // The change landed: the Reading window followed it (its renderer applied the
  // theme, which fires the broadcast the terminal also receives).
  await page.locator(`html[data-theme="${readingTheme}"]`).waitFor({ state: "attached" });
  await page.locator('html[data-mode="dark"]').waitFor({ state: "attached" });
  results.readingFollowedTheme = true;

  // Give the terminal's (nonexistent) listener the same beat, then assert it did
  // NOT move — it is excluded from the reading-stamp path.
  await terminal.waitForTimeout(300);
  const terminalThemeAfter = await terminal.evaluate(() => ({
    theme: document.documentElement.dataset.theme ?? "",
    mode: document.documentElement.dataset.mode ?? "",
  }));
  results.terminalThemeUnchanged = terminalThemeAfter.theme === terminalThemeBefore.theme;
  results.terminalDidNotFollow = terminalThemeAfter.theme !== readingTheme;
  results.terminalModeUnchanged = terminalThemeAfter.mode === terminalThemeBefore.mode;

  const success = Object.values(results).every(Boolean);
  console.log(
    JSON.stringify(
      { dataRoot, readingTheme, terminalThemeBefore, terminalThemeAfter, results, success },
      null,
      2,
    ),
  );
  process.exitCode = success ? 0 : 1;
} catch (error) {
  console.error("terminal-theme-independence e2e threw:", error);
  console.log(JSON.stringify({ results }, null, 2));
  process.exitCode = 1;
} finally {
  if (app) {
    await app.close();
  }
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
