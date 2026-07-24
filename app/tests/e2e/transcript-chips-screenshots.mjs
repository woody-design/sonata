// Screenshot self-verify for the transcript file chips (S4). Drives the BUILT
// app in an isolated data dir, births one session, writes a .md / .ts / .json
// fixture, and captures a reply whose inline-code mentions became chips — in
// BOTH light and dark, plus a hover state. Saves to preview-slice-4-evidence/.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import {
  activeSessionTaskId,
  chooseDraftProvider,
  sendFirstPrompt,
  sendPrompt,
  waitForCompletedTurns,
} from "./helpers/session.mjs";

const evidenceDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../product-thinking/preview-slice-4-evidence",
);
fs.mkdirSync(evidenceDir, { recursive: true });

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-chips-shots-"));
const launchEnv = {
  ...process.env,
  SONATA_DATA_DIR: dataRoot,
  SONATA_WORKSPACES_DIR: dataRoot,
  SONATA_SETTINGS_DIR: path.join(dataRoot, "config"),
};

const shots = [];
let app = null;
try {
  app = await electron.launch({ args: ["dist/main/main.js"], env: launchEnv });
  const page = await app.firstWindow();
  page.setDefaultTimeout(180000);

  await chooseDraftProvider(page, "codex");
  await sendFirstPrompt(page, [
    "Reply exactly SONATA_CHIPS_SHOTS_READY.",
    "Do not create or modify any files.",
  ]);
  const taskId = await activeSessionTaskId(page);
  await waitForCompletedTurns(page, 1);

  const workspace = JSON.parse(
    fs.readFileSync(path.join(dataRoot, "data", "projects", taskId, "task.json"), "utf8"),
  ).task.providerCwd;
  fs.writeFileSync(path.join(workspace, "guide.md"), "# Guide\n\nThe guide body.\n");
  fs.writeFileSync(path.join(workspace, "config.ts"), "export const config = {};\n");
  fs.writeFileSync(path.join(workspace, "package.json"), '{\n  "name": "demo"\n}\n');

  await sendPrompt(page, [
    "Reply with exactly this text, preserving every backtick character, and nothing else:",
    "Start with `guide.md`, then wire up `config.ts`, and check `package.json` for deps.",
  ]);
  await waitForCompletedTurns(page, 2);

  for (const name of ["guide.md", "config.ts", "package.json"]) {
    await page.locator(`code[data-chip-path="${name}"]`).first().waitFor({ state: "visible", timeout: 30000 });
  }
  const card = page.locator(".turn-card:has(code[data-chip-path])").last();

  await setMode(page, "light");
  await capture(card, "chips", "light");

  await setMode(page, "dark");
  await capture(card, "chips", "dark");

  await setMode(page, "light");
  await page.locator('code[data-chip-path="guide.md"]').first().hover();
  await page.waitForTimeout(180);
  await capture(card, "chips-hover", "light");

  console.log(JSON.stringify({ evidenceDir, shots, success: true }, null, 2));
  process.exitCode = 0;
} catch (error) {
  console.error("transcript-chips-screenshots threw:", error);
  process.exitCode = 1;
} finally {
  if (app) {
    await app.close();
  }
  fs.rmSync(dataRoot, { recursive: true, force: true });
}

async function setMode(page, mode) {
  // The Reading window flips mode through its own settings UI (the raw
  // writeReadingSettings broadcast re-stamps satellites only), so drive the Aa
  // popover the way settings-screenshots.mjs does.
  const label = mode === "dark" ? "Dark" : "Light";
  await page.locator("#reading-settings").click();
  await page.locator(".reading-segment", { hasText: label }).click();
  await page.keyboard.press("Escape");
  await page.locator(`html[data-mode="${mode}"]`).waitFor({ state: "attached" });
  await page.waitForTimeout(150);
}

async function capture(locator, state, mode) {
  const file = path.join(evidenceDir, `transcript-${state}-${mode}.png`);
  await locator.screenshot({ path: file });
  shots.push(path.basename(file));
}
