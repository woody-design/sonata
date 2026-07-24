// Screenshot self-verify for the Preview window (S1). Drives the BUILT app in
// an isolated data dir, birthing one session and capturing the three headline
// states — empty, tabs populated, tombstone — in BOTH light and dark. The mode
// is flipped through writeReadingSettings, which doubles as a live check of the
// R6 satellite-follow path (main broadcasts → preview preload re-stamps).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { activeSessionTaskId, sendFirstPrompt, waitForCompletedTurns, waitForWindowByUrl } from "./helpers/session.mjs";

const evidenceDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../product-thinking/preview-slice-1-evidence",
);
fs.mkdirSync(evidenceDir, { recursive: true });

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-preview-shots-"));
const launchEnv = {
  ...process.env,
  SONATA_DATA_DIR: dataRoot,
  SONATA_WORKSPACES_DIR: dataRoot,
  SONATA_SETTINGS_DIR: path.join(dataRoot, "config"),
};

let app = null;
const shots = [];
try {
  app = await electron.launch({ args: ["dist/main/main.js"], env: launchEnv });
  const page = await app.firstWindow();
  page.setDefaultTimeout(180000);

  await sendFirstPrompt(page, ["Reply exactly SONATA_PREVIEW_SHOTS_READY.", "Do not create or modify any files."], { provider: "codex" });
  const taskId = await activeSessionTaskId(page);
  await waitForCompletedTurns(page, 1);
  const workspace = JSON.parse(
    fs.readFileSync(path.join(dataRoot, "data", "projects", taskId, "task.json"), "utf8"),
  ).task.providerCwd;

  writeFile(workspace, "protocol.md", "# Protocol\n\nThe reading surface renders documents, calmly.\n\n- one\n- two\n");
  writeFile(workspace, "brief.txt", "A plain-text brief.\nSelectable, read-only.\n");
  writeFile(workspace, "config.json", '{\n  "calm": true,\n  "pullOnly": true\n}\n');

  // Empty state — open the window before any tabs.
  await page.locator("#open-preview-window").click();
  const preview = await waitForWindowByUrl(app, "preview.html");
  preview.setDefaultTimeout(60000);
  await preview.locator("#preview-content[data-preview-reader='empty']").waitFor({ state: "visible" });
  await capture(preview, "empty", "light");
  await setMode(page, preview, "dark");
  await capture(preview, "empty", "dark");
  await setMode(page, preview, "light");

  // Tabs populated.
  await openTab(page, taskId, "protocol.md");
  await openTab(page, taskId, "brief.txt");
  await openTab(page, taskId, "config.json");
  await preview.locator(".preview-tab").nth(2).waitFor({ state: "visible" });
  await preview.locator('.preview-doc[data-doc-kind="text"]').waitFor({ state: "visible" });
  await capture(preview, "tabs", "light");
  await setMode(page, preview, "dark");
  await capture(preview, "tabs", "dark");
  await setMode(page, preview, "light");

  // Tombstone — delete a file, focus its tab.
  fs.rmSync(path.join(workspace, "brief.txt"));
  await preview.locator('.preview-tab:has-text("brief.txt")').first().click();
  await preview.locator(".preview-tombstone").waitFor({ state: "visible" });
  await capture(preview, "tombstone", "light");
  await setMode(page, preview, "dark");
  await capture(preview, "tombstone", "dark");

  console.log(JSON.stringify({ evidenceDir, shots, success: true }, null, 2));
  process.exitCode = 0;
} catch (error) {
  console.error("preview-screenshots threw:", error);
  process.exitCode = 1;
} finally {
  if (app) {
    await app.close();
  }
  fs.rmSync(dataRoot, { recursive: true, force: true });
}

function writeFile(root, relative, contents) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, "utf8");
}

async function openTab(page, taskId, relativePath) {
  await page.evaluate((args) => window.sonataRuntime.openPreview(args), { taskId, relativePath });
}

async function setMode(page, preview, mode) {
  const current = await page.evaluate(() => window.sonataRuntime.readReadingSettings());
  await page.evaluate((next) => window.sonataRuntime.writeReadingSettings(next), { ...current, mode });
  await preview.locator(`html[data-mode="${mode}"]`).waitFor({ state: "attached" });
  await preview.waitForTimeout(120);
}

async function capture(preview, state, mode) {
  const file = path.join(evidenceDir, `preview-${state}-${mode}.png`);
  await preview.screenshot({ path: file });
  shots.push(path.basename(file));
}
