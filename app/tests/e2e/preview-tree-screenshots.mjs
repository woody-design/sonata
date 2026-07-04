// Screenshot self-verify for the S3 folder tree. Drives the BUILT app in an
// isolated data dir, births one session, and captures the headline tree states —
// a deep expansion (docs → research → deep.md) with dimmed dotfiles and a
// selected row, plus the active filter — in BOTH light and dark. Evidence lands
// in preview-slice-3-evidence/.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { activeSessionTaskId, sendFirstPrompt, waitForCompletedTurns, waitForWindowByUrl } from "./helpers/session.mjs";

const evidenceDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../product-thinking/preview-slice-3-evidence",
);
fs.mkdirSync(evidenceDir, { recursive: true });

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-preview-tree-shots-"));
const launchEnv = {
  ...process.env,
  DUET_DATA_DIR: dataRoot,
  DUET_WORKSPACES_DIR: dataRoot,
  DUET_SETTINGS_DIR: path.join(dataRoot, "config"),
};

let app = null;
const shots = [];
try {
  app = await electron.launch({ args: ["dist/main/main.js"], env: launchEnv });
  const page = await app.firstWindow();
  page.setDefaultTimeout(180000);

  await sendFirstPrompt(page, ["Reply exactly DUET_PREVIEW_S3_SHOTS_READY.", "Do not create or modify any files."]);
  const taskId = await activeSessionTaskId(page);
  await waitForCompletedTurns(page, 1);
  const workspace = JSON.parse(
    fs.readFileSync(path.join(dataRoot, "data", "projects", taskId, "task.json"), "utf8"),
  ).task.providerCwd;

  // A realistic small project: nested docs, source, hidden entries.
  writeFile(workspace, "README.md", "# inkAI\n");
  writeFile(workspace, "package.json", '{ "name": "inkai" }\n');
  writeFile(workspace, ".gitignore", "dist\n"); // hidden file (dimmed)
  writeFile(workspace, ".git/HEAD", "ref: refs/heads/main\n"); // hidden dir (dimmed)
  writeFile(workspace, "docs/brief.md", brief());
  writeFile(workspace, "docs/decisions.md", "# Decisions\n");
  writeFile(workspace, "docs/protocol.md", "# Protocol\n");
  writeFile(workspace, "docs/research/prior-art.md", "# Prior art\n");
  writeFile(workspace, "docs/research/deep.md", "# Deep dive\n");
  writeFile(workspace, "src/main.ts", "export const main = () => {};\n");
  writeFile(workspace, "src/state.ts", "export type State = {};\n");

  await openTab(page, taskId, "docs/brief.md");
  const preview = await waitForWindowByUrl(app, "preview.html");
  preview.setDefaultTimeout(60000);
  await preview.locator('.preview-doc[data-doc-kind="markdown"] .preview-md h1').waitFor({ state: "visible" });

  // Open the folder panel; opening brief.md auto-revealed its docs ancestor.
  await preview.locator("#preview-panel-toggle").click();
  await preview.locator(".preview-panel:not(.hidden)").waitFor({ state: "visible" });
  await preview.locator('[data-tree-path="docs/brief.md"][data-tree-selected="true"]').waitFor({ state: "visible" });
  // Expand src and the nested research dir → a deep expansion with a selected row.
  await preview.locator('[data-tree-path="src"]').click();
  await preview.locator('[data-tree-path="docs/research"]').click();
  await preview.locator('[data-tree-path="docs/research/deep.md"]').waitFor({ state: "visible" });

  // Tree — light + dark (dirs expanded, dotfiles dimmed, brief.md selected).
  await capture(preview, "tree", "light");
  await setMode(page, preview, "dark");
  await capture(preview, "tree", "dark");
  await setMode(page, preview, "light");

  // Active filter — narrows to the match with ancestors auto-expanded.
  await preview.locator(".preview-tree-filter-input").fill("deep");
  await preview.locator('[data-tree-path="docs/research/deep.md"]').waitFor({ state: "visible" });
  await capture(preview, "filter", "light");
  await setMode(page, preview, "dark");
  await capture(preview, "filter", "dark");

  console.log(JSON.stringify({ evidenceDir, shots, success: true }, null, 2));
  process.exitCode = 0;
} catch (error) {
  console.error("preview-tree-screenshots threw:", error);
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

function brief() {
  return [
    "# inkAI — Product Brief",
    "",
    "## Thesis",
    "",
    "AI coding agents changed the shape of attention. A session runs for minutes",
    "at a time; the human's job is no longer typing — it is reading, judging, and",
    "occasionally steering.",
    "",
    "## What it is",
    "",
    "- A companion server that runs on your Mac",
    "- A web client designed e-ink-first",
    "- Works on iPhone/iPad Safari from day one",
  ].join("\n");
}

async function openTab(page, taskId, relativePath) {
  await page.evaluate((args) => window.duetRuntime.openPreview(args), { taskId, relativePath });
}

async function setMode(page, preview, mode) {
  const current = await page.evaluate(() => window.duetRuntime.readReadingSettings());
  await page.evaluate((next) => window.duetRuntime.writeReadingSettings(next), { ...current, mode });
  await preview.locator(`html[data-mode="${mode}"]`).waitFor({ state: "attached" });
  await preview.waitForTimeout(120);
}

async function capture(preview, state, mode) {
  const file = path.join(evidenceDir, `preview-${state}-${mode}.png`);
  await preview.screenshot({ path: file });
  shots.push(path.basename(file));
}
