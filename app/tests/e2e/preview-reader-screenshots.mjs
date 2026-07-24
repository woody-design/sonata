// Screenshot self-verify for the S2 reader. Drives the BUILT app in an isolated
// data dir, birthing one session, and captures the headline S2 states — a real
// document-scale markdown render (headings, list, table, an embedded image) and
// the too-large banner (head slice + honest byte counts + Reveal in Finder) —
// in BOTH light and dark. Evidence lands in preview-slice-2-evidence/.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { activeSessionTaskId, chooseDraftProvider, sendFirstPrompt, waitForCompletedTurns, waitForWindowByUrl } from "./helpers/session.mjs";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const evidenceDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../product-thinking/preview-slice-2-evidence",
);
fs.mkdirSync(evidenceDir, { recursive: true });

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-preview-reader-shots-"));
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

  await chooseDraftProvider(page, "codex");
  await sendFirstPrompt(page, ["Reply exactly SONATA_PREVIEW_S2_SHOTS_READY.", "Do not create or modify any files."]);
  const taskId = await activeSessionTaskId(page);
  await waitForCompletedTurns(page, 1);
  const workspace = JSON.parse(
    fs.readFileSync(path.join(dataRoot, "data", "projects", taskId, "task.json"), "utf8"),
  ).task.providerCwd;

  fs.writeFileSync(path.join(workspace, "diagram.png"), PNG_1x1);
  writeFile(
    workspace,
    "report.md",
    [
      "# Preview, the reading surface",
      "",
      "The Preview window reads the documents an agent writes — calmly, pull-only.",
      "It renders markdown at **document scale**: a centered measure, real heading",
      "hierarchy, and typography drawn entirely from the theme tokens.",
      "",
      "## What it renders",
      "",
      "- Headings and prose on `--font-reading`",
      "- Lists, `inline code`, and fenced blocks",
      "- Tables that scroll inside their own measure",
      "- Local images through the `sonata-file://` protocol",
      "",
      "![a diagram](./diagram.png)",
      "",
      "## A small table",
      "",
      "| Surface  | Reads          | Character   |",
      "| -------- | -------------- | ----------- |",
      "| Reading  | the conversation | habitual  |",
      "| Preview  | the documents  | calm        |",
      "| Terminal | raw process    | low-signal  |",
      "",
      "> Everything in a tab is a promise that the reading position is safe.",
      "",
      "### Fenced code",
      "",
      "```ts",
      "function reconcile(event: RuntimeEvent): void {",
      "  // one operation: project a claim against disk truth",
      "}",
      "```",
      "",
      ...Array.from({ length: 8 }, (_, i) => `Closing paragraph ${i + 1}: the surface stays out of the way.`),
    ].join("\n"),
  );
  // A >1MB file → the too-large ladder (head slice + banner).
  writeFile(workspace, "huge.txt", `${"A calm line of the oversized log.\n".repeat(42000)}`);

  await page.locator("#open-preview-window").click();
  const preview = await waitForWindowByUrl(app, "preview.html");
  preview.setDefaultTimeout(60000);

  // Markdown document — light + dark.
  await openTab(page, taskId, "report.md");
  await preview.locator('.preview-doc[data-doc-kind="markdown"] .preview-md h1').waitFor({ state: "visible" });
  await preview.waitForFunction(() => {
    const el = document.querySelector(".preview-md img");
    return el instanceof HTMLImageElement && el.complete && el.naturalWidth > 0;
  });
  await capture(preview, "markdown", "light");
  await setMode(page, preview, "dark");
  await capture(preview, "markdown", "dark");
  await setMode(page, preview, "light");

  // Too-large banner — light + dark.
  await openTab(page, taskId, "huge.txt");
  await preview.locator('.preview-doc[data-doc-kind="too-large"] .preview-banner').waitFor({ state: "visible" });
  await preview.locator(".preview-banner-action", { hasText: "Reveal in Finder" }).waitFor({ state: "visible" });
  await capture(preview, "too-large", "light");
  await setMode(page, preview, "dark");
  await capture(preview, "too-large", "dark");

  console.log(JSON.stringify({ evidenceDir, shots, success: true }, null, 2));
  process.exitCode = 0;
} catch (error) {
  console.error("preview-reader-screenshots threw:", error);
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
