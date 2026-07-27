// Preview routing seam (Preview 分工, S1 — plan v0; design record §6.1).
//
// Sonata's job at the preview seam is ROUTING, not rendering. This drives the
// built app end-to-end and asserts `openPreview` classifies a target BEFORE it
// opens a tab and sends it to the right destination:
//   - markdown / non-binary text        → a Preview tab (as today)
//   - a nonexistent path                 → a Preview tab → tombstone (three-truths)
//   - `.html`                            → the default browser (shell.openPath), NO tab
//   - media extension (.mp4)             → macOS Quick Look (previewFile), NO tab
//   - binary-probe-positive (.bin + NUL) → macOS Quick Look (previewFile), NO tab
//
// And the silent-swallow fix on the MAIN window's transcript link handler:
//   - a relative file link               → routes through openPreview
//   - an absolute path INSIDE the root   → normalized to relative + routed
//   - an absolute path OUTSIDE the root  → a principled no-op (sandbox boundary)
//   - an `https?://` link                → today's behavior (window.open → openExternal)
//   - a `mailto:` / `#frag` link         → left as-is (no route)
//
// Tabs are driven through the same `openPreview` bridge the Eye button and chips
// use; the OS handoffs (shell.openPath, BrowserWindow.previewFile) are stubbed in
// main so the assertions observe the route without launching a browser/Quick Look.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import {
  activeSessionTaskId,
  sendFirstPrompt,
  waitForCompletedTurns,
  waitForWindowByUrl,
} from "./helpers/session.mjs";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-preview-routing-e2e-"));
const launchEnv = {
  ...process.env,
  SONATA_DATA_DIR: dataRoot,
  SONATA_WORKSPACES_DIR: dataRoot,
  SONATA_SETTINGS_DIR: path.join(dataRoot, "config"),
};

const results = {};
let app = null;
try {
  app = await electron.launch({ args: ["dist/main/main.js"], env: launchEnv });
  const page = await app.firstWindow();
  page.setDefaultTimeout(180000);

  await sendFirstPrompt(page, [
    "Reply exactly SONATA_PREVIEW_ROUTING_READY.",
    "Do not create or modify any files.",
  ], { provider: "codex" });
  const taskId = await activeSessionTaskId(page);
  if (!taskId) {
    throw new Error("Sidebar session did not expose a task id.");
  }
  await waitForCompletedTurns(page, 1);

  const workspace = JSON.parse(
    fs.readFileSync(path.join(dataRoot, "data", "projects", taskId, "task.json"), "utf8"),
  ).task.providerCwd;
  if (!workspace || !fs.existsSync(workspace)) {
    throw new Error(`Manifest providerCwd is not an existing directory: ${workspace}`);
  }

  // ── Fixtures ───────────────────────────────────────────────────────────────
  writeFile(workspace, "note.md", "# Note\n\nPreviewable markdown body.\n");
  writeFile(workspace, "plain.log", "a plain non-binary log line\nanother line\n");
  writeFile(workspace, "page.html", "<!doctype html><title>Doc</title><p>hi</p>\n");
  writeFile(workspace, "clip.mp4", "not really an mp4 — routed by extension, never probed\n");
  fs.writeFileSync(path.join(workspace, "blob.bin"), Buffer.from([0x50, 0x00, 0x4b, 0x01, 0x02]));
  // Bilingual fixtures for the percent-encoded-href regression (review R1/F1): a
  // CJK-named file and a spaced-name file, both existing on disk.
  writeFile(workspace, "报告.md", "# 报告\n\nCJK 报告 body renders.\n");
  writeFile(workspace, "My Notes.md", "# My Notes\n\nSpaced-name notes body renders.\n");

  // ── Route 1: previewable markdown opens a Preview tab (creates the window) ──
  await openTab(page, taskId, "note.md");
  const preview = await waitForWindowByUrl(app, "preview.html");
  preview.setDefaultTimeout(60000);
  await preview.locator('.preview-tab[data-active="true"]:has-text("note.md")').waitFor({ state: "visible" });
  results.markdownOpensTab = (await tabCount(preview)) === 1;

  // Stub the OS handoffs now that the window exists.
  await installOsHandoffProbes(app);

  // ── Route 2: `.html` → default browser, NO tab ─────────────────────────────
  let before = await tabCount(preview);
  await openTab(page, taskId, "page.html");
  await settle(app);
  results.htmlToBrowser = (await openPathCalls(app)).includes(path.join(workspace, "page.html"));
  results.htmlNoTab = (await tabCount(preview)) === before;

  // ── Route 3: media extension → Quick Look, NO tab ──────────────────────────
  before = await tabCount(preview);
  await openTab(page, taskId, "clip.mp4");
  await settle(app);
  results.mediaToQuickLook = (await quickLookCalls(app)).includes(path.join(workspace, "clip.mp4"));
  results.mediaNoTab = (await tabCount(preview)) === before;

  // ── Route 4: binary-probe-positive → Quick Look, NO tab ────────────────────
  before = await tabCount(preview);
  await openTab(page, taskId, "blob.bin");
  await settle(app);
  results.binaryToQuickLook = (await quickLookCalls(app)).includes(path.join(workspace, "blob.bin"));
  results.binaryNoTab = (await tabCount(preview)) === before;

  // ── Route 5: non-binary text opens a Preview tab ───────────────────────────
  before = await tabCount(preview);
  await openTab(page, taskId, "plain.log");
  await preview.locator('.preview-tab[data-active="true"]:has-text("plain.log")').waitFor({ state: "visible" });
  results.textOpensTab = (await tabCount(preview)) === before + 1;

  // ── Route 6: a nonexistent path opens a tab → tombstone (three-truths) ─────
  before = await tabCount(preview);
  await openTab(page, taskId, "ghost.md");
  await preview.locator(".preview-tombstone", { hasText: "no longer exists" }).waitFor({ state: "visible" });
  results.nonexistentTombstone = (await tabCount(preview)) === before + 1;

  // ── Silent-swallow fix: the main window's transcript link handler ──────────
  // Exercise the exact delegated `#run-list` listener the fix touches by
  // injecting an <a href> and clicking it — the active task is real, the IPC and
  // main-side routing are real. (Only the anchor's origin is synthetic, mirroring
  // how the tab tests drive `openPreview` directly rather than through chips.)

  // A relative file link routes (→ Quick Look here, observed without a tab).
  let qlBefore = (await quickLookCalls(app)).length;
  await clickInjectedLink(page, "clip.mp4");
  await settle(app);
  results.linkRelativeRoutes = (await quickLookCalls(app)).length === qlBefore + 1;

  // An absolute path INSIDE the workspace is normalized to relative and routed.
  qlBefore = (await quickLookCalls(app)).length;
  await clickInjectedLink(page, path.join(workspace, "clip.mp4"));
  await settle(app);
  results.linkAbsoluteInsideRoutes = (await quickLookCalls(app)).length === qlBefore + 1;

  // An absolute path OUTSIDE the workspace is a principled no-op — no OS handoff,
  // no new tab.
  const tabsBeforeOutside = await tabCount(preview);
  const qlBeforeOutside = (await quickLookCalls(app)).length;
  const openPathBeforeOutside = (await openPathCalls(app)).length;
  await clickInjectedLink(page, "/etc/hosts");
  await settle(app);
  results.linkAbsoluteOutsideNoop =
    (await quickLookCalls(app)).length === qlBeforeOutside &&
    (await openPathCalls(app)).length === openPathBeforeOutside &&
    (await tabCount(preview)) === tabsBeforeOutside;

  // An `https?://` link keeps today's behavior (window.open → openExternal).
  const externalBefore = (await openExternalCalls(app)).length;
  await clickInjectedLink(page, "https://example.com/landing");
  await settle(app);
  const externalCalls = await openExternalCalls(app);
  results.httpsKeepsBehavior =
    externalCalls.length === externalBefore + 1 &&
    externalCalls.some((u) => u.includes("example.com/landing"));

  // A `mailto:` scheme (and an in-page `#frag`) is left as-is — no route.
  const qlBeforeMailto = (await quickLookCalls(app)).length;
  const externalBeforeMailto = (await openExternalCalls(app)).length;
  await clickInjectedLink(page, "mailto:someone@example.com");
  await clickInjectedLink(page, "#a-section");
  await settle(app);
  results.mailtoAndAnchorLeftAsIs =
    (await quickLookCalls(app)).length === qlBeforeMailto &&
    (await openExternalCalls(app)).length === externalBeforeMailto;

  // A percent-encoded href — exactly what marked emits for a CJK / spaced link
  // destination — must DECODE to the real file and open it as a Preview tab, not
  // route the literal `%..` string into a false tombstone (review R1/F1). These
  // encoded strings are marked@18's confirmed output (see review trace).
  results.cjkEncodedLinkOpensRealFile = await encodedLinkOpensRealTab(
    page,
    preview,
    "%E6%8A%A5%E5%91%8A.md", // marked's encoding of 报告.md
    "报告.md",
    "CJK 报告 body renders.",
  );
  results.spacedEncodedLinkOpensRealFile = await encodedLinkOpensRealTab(
    page,
    preview,
    "My%20Notes.md", // marked's encoding of a `<My Notes.md>` destination
    "My Notes.md",
    "Spaced-name notes body renders.",
  );

  const success = Object.values(results).every(Boolean);
  console.log(JSON.stringify({ dataRoot, taskId, workspace, results, success }, null, 2));
  process.exitCode = success ? 0 : 1;
} catch (error) {
  console.error("preview-routing e2e threw:", error);
  console.log(JSON.stringify({ results }, null, 2));
  process.exitCode = 1;
} finally {
  if (app) {
    await app.close();
  }
  fs.rmSync(dataRoot, { recursive: true, force: true });
}

// ── helpers ──────────────────────────────────────────────────────────────────
function writeFile(root, relative, contents) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, "utf8");
}

async function openTab(page, taskId, relativePath) {
  await page.evaluate((args) => window.sonataRuntime.openPreview(args), { taskId, relativePath });
}

async function tabCount(preview) {
  return preview.locator(".preview-tab").count();
}

// Inject an <a href> into the main window's transcript container (#run-list) and
// click it, so the delegated link handler runs with the RAW href attribute the
// fix inspects. The raw attribute is set explicitly (never `a.href = …`, which
// would resolve a relative value to an absolute URL).
async function clickInjectedLink(page, href) {
  await page.evaluate((raw) => {
    const list = document.getElementById("run-list");
    const anchor = document.createElement("a");
    anchor.setAttribute("href", raw);
    anchor.textContent = "injected link";
    list.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, href);
}

// Click an injected link carrying a percent-ENCODED href and assert it opens the
// DECODED file as a real markdown tab (not a tombstone for the literal `%..`
// string). Returns false on timeout — the tombstone tab would be labeled with the
// still-encoded name, so the decoded-name tab + rendered body never appear.
async function encodedLinkOpensRealTab(page, preview, encodedHref, decodedName, bodyText) {
  await clickInjectedLink(page, encodedHref);
  try {
    await preview
      .locator(`.preview-tab[data-active="true"]:has-text("${decodedName}")`)
      .waitFor({ state: "visible", timeout: 8000 });
    await preview
      .locator('.preview-doc[data-doc-kind="markdown"] .preview-md', { hasText: bodyText })
      .waitFor({ state: "visible", timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

// Stub the OS handoffs in main: `shell.openPath` (browser), `shell.openExternal`
// (window.open target), and `BrowserWindow.prototype.previewFile` (Quick Look).
async function installOsHandoffProbes(electronApp) {
  await electronApp.evaluate(({ shell, BrowserWindow }) => {
    globalThis.__openPathCalls = [];
    globalThis.__openExternalCalls = [];
    globalThis.__quickLookCalls = [];
    shell.openPath = async (targetPath) => {
      globalThis.__openPathCalls.push(targetPath);
      return "";
    };
    shell.openExternal = async (url) => {
      globalThis.__openExternalCalls.push(url);
    };
    BrowserWindow.prototype.previewFile = function previewFileStub(targetPath) {
      globalThis.__quickLookCalls.push(targetPath);
    };
  });
}

async function openPathCalls(electronApp) {
  return electronApp.evaluate(() => globalThis.__openPathCalls ?? []);
}

async function openExternalCalls(electronApp) {
  return electronApp.evaluate(() => globalThis.__openExternalCalls ?? []);
}

async function quickLookCalls(electronApp) {
  return electronApp.evaluate(() => globalThis.__quickLookCalls ?? []);
}

// Give an async openPreview round-trip time to land before reading the probes
// (mirrors the 300ms settle the preview-reader external-link leg uses).
async function settle(electronApp) {
  await electronApp.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
}
