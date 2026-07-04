// Preview window reader behaviors (2026-07 redesign, S2 — design record §4).
//
// Drives the built app end-to-end and exercises the document-scale reader:
//   - rich markdown renders (heading / list / inline-code / table / blockquote)
//   - a relative image resolves via duet-file:// and actually PAINTS (naturalWidth > 0)
//   - a #fragment link scrolls within the document
//   - a relative .md link opens a new Preview tab
//   - an external http(s) link routes to shell.openExternal and NEVER navigates the window
//   - a live file change preserves the reader's scroll mid-document (morph, not replace)
//   - tail-follow sticks the reader to the bottom as content appends
//   - tombstone → file recreated → content returns
//
// Tabs are opened through the same `openPreview` bridge the Eye button and the
// future chips use (chips are S4), driven from the main window.
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

// A genuinely valid 1×1 RGBA PNG (signature + IHDR + IDAT + IEND). The image
// test asserts it decodes to naturalWidth > 0 through the protocol.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-preview-reader-e2e-"));
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
  page.setDefaultTimeout(180000);

  await sendFirstPrompt(page, [
    "Reply exactly DUET_PREVIEW_READER_READY.",
    "Do not create or modify any files.",
  ]);
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
  fs.writeFileSync(path.join(workspace, "pixel.png"), PNG_1x1);
  writeText(
    workspace,
    "doc.md",
    [
      "# Reader Title",
      "",
      "An intro paragraph with some `inline code` in it.",
      "",
      "- first item",
      "- second item",
      "",
      "| Col A | Col B |",
      "| ----- | ----- |",
      "| a1    | b1    |",
      "",
      "> a calm blockquote",
      "",
      "![the pixel](./pixel.png)",
      "",
      "[jump to section](#section-two)",
      "",
      "[open beta](./beta.md)",
      "",
      "[external site](https://example.com/landing)",
      "",
      "## Section Two",
      "",
      ...Array.from({ length: 60 }, (_, i) => `Filler paragraph ${i + 1} to make the document scroll.`),
    ].join("\n"),
  );
  writeText(workspace, "beta.md", "# Beta Doc\n\nThe beta target opened as a tab.\n");
  writeText(
    workspace,
    "long.md",
    ["# Long Doc", "", ...Array.from({ length: 120 }, (_, i) => `Line paragraph number ${i + 1}.`)].join(
      "\n",
    ),
  );
  writeText(workspace, "phoenix.md", "# Phoenix\n\nOriginal phoenix body.\n");

  // ── Open the window on doc.md ───────────────────────────────────────────────
  await openTab(page, taskId, "doc.md");
  const preview = await waitForWindowByUrl(app, "preview.html");
  preview.setDefaultTimeout(60000);
  const md = preview.locator('.preview-doc[data-doc-kind="markdown"] .preview-md');
  await md.waitFor({ state: "visible" });

  // ── Rich markdown structure ────────────────────────────────────────────────
  results.heading = (await md.locator("h1", { hasText: "Reader Title" }).count()) === 1;
  results.list = (await md.locator("ul li").count()) >= 2;
  results.inlineCode = (await md.locator("code", { hasText: "inline code" }).count()) === 1;
  results.table =
    (await md.locator("table th", { hasText: "Col A" }).count()) === 1 &&
    (await md.locator("table td", { hasText: "b1" }).count()) === 1;
  results.blockquote = (await md.locator("blockquote", { hasText: "calm blockquote" }).count()) === 1;

  // ── Relative image resolves via duet-file:// and PAINTS ────────────────────
  const img = md.locator("img").first();
  await img.waitFor({ state: "visible" });
  const imgSrc = await img.getAttribute("src");
  results.imageProtocol = Boolean(imgSrc && imgSrc.startsWith("duet-file://") && imgSrc.endsWith("/pixel.png"));
  await preview.waitForFunction(
    () => {
      const el = document.querySelector('.preview-md img');
      return el instanceof HTMLImageElement && el.complete && el.naturalWidth > 0;
    },
    undefined,
    { timeout: 15000 },
  );
  results.imagePaints = true;

  // ── Fragment link scrolls within the document ──────────────────────────────
  await preview.evaluate(() => {
    document.querySelector("#preview-content").scrollTop = 0;
  });
  await md.locator('a[href="#section-two"]').click();
  await preview.waitForFunction(
    () => document.querySelector("#preview-content").scrollTop > 40,
    undefined,
    { timeout: 8000 },
  );
  // The Section Two heading sits near the top of the viewport after the scroll.
  results.fragmentScroll = await preview.evaluate(() => {
    const scroller = document.querySelector("#preview-content");
    const heading = document.getElementById("section-two");
    if (!scroller || !heading) return false;
    const top = heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    return scroller.scrollTop > 40 && Math.abs(top) < 6;
  });

  // ── Relative .md link opens a new tab ──────────────────────────────────────
  const tabsBefore = await tabCount(preview);
  await md.locator('a[href="./beta.md"]').click();
  await preview.locator('.preview-tab[data-active="true"]:has-text("beta.md")').waitFor({ state: "visible" });
  await preview
    .locator('.preview-doc[data-doc-kind="markdown"] .preview-md h1', { hasText: "Beta Doc" })
    .waitFor({ state: "visible" });
  results.relativeLinkOpensTab = (await tabCount(preview)) === tabsBefore + 1;

  // ── External link routes to shell.openExternal and does NOT navigate ───────
  // Stub the OS opener in main so the assertion records the route without
  // actually opening a browser.
  await app.evaluate(({ shell }) => {
    globalThis.__openedExternally = [];
    shell.openExternal = async (url) => {
      globalThis.__openedExternally.push(url);
    };
  });
  await preview.locator('.preview-tab:has-text("doc.md")').first().click();
  await md.waitFor({ state: "visible" });
  const urlBeforeExternal = preview.url();
  await md.locator('a[href="https://example.com/landing"]').click();
  await app
    .evaluate(() => new Promise((r) => setTimeout(() => r(globalThis.__openedExternally ?? []), 300)))
    .then((opened) => {
      results.externalRouted = opened.some((u) => u.includes("example.com/landing"));
    });
  results.externalNoNavigate =
    preview.url() === urlBeforeExternal && preview.url().includes("preview.html");

  // ── Live update preserves scroll mid-document (morph, not replace) ──────────
  await openTab(page, taskId, "long.md");
  await preview.locator('.preview-tab[data-active="true"]:has-text("long.md")').waitFor({ state: "visible" });
  await preview.locator('.preview-md', { hasText: "Line paragraph number 1." }).waitFor({ state: "visible" });
  // Scroll to the middle and let it report.
  const midTop = await preview.evaluate(() => {
    const el = document.querySelector("#preview-content");
    el.scrollTop = Math.round(el.scrollHeight / 2);
    return el.scrollTop;
  });
  await preview.waitForTimeout(200);
  fs.appendFileSync(path.join(workspace, "long.md"), "\n\nAppended tail paragraph after scroll.\n");
  await preview.locator('.preview-md', { hasText: "Appended tail paragraph after scroll." }).waitFor({
    state: "visible",
    timeout: 15000,
  });
  const afterTop = await preview.evaluate(() => document.querySelector("#preview-content").scrollTop);
  results.liveScrollPreserved = Math.abs(afterTop - midTop) <= 6;

  // ── Tail-follow: pinned at bottom stays pinned as content appends ──────────
  await preview.evaluate(() => {
    const el = document.querySelector("#preview-content");
    el.scrollTop = el.scrollHeight;
  });
  await preview.waitForTimeout(200);
  fs.appendFileSync(path.join(workspace, "long.md"), "\n\nBrand new bottom line for tail follow.\n");
  await preview.locator('.preview-md', { hasText: "Brand new bottom line for tail follow." }).waitFor({
    state: "visible",
    timeout: 15000,
  });
  results.tailFollowSticks = await preview.evaluate(() => {
    const el = document.querySelector("#preview-content");
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 26;
  });

  // ── Tombstone → recreate → content returns ─────────────────────────────────
  await openTab(page, taskId, "phoenix.md");
  await preview.locator('.preview-md', { hasText: "Original phoenix body." }).waitFor({ state: "visible" });
  fs.rmSync(path.join(workspace, "phoenix.md"));
  await preview.locator('.preview-tab:has-text("phoenix.md")').first().click();
  await preview.locator(".preview-tombstone", { hasText: "no longer exists" }).waitFor({ state: "visible" });
  results.tombstoneShown = true;
  writeText(workspace, "phoenix.md", "# Phoenix\n\nRisen phoenix body.\n");
  await preview.locator('.preview-md', { hasText: "Risen phoenix body." }).waitFor({
    state: "visible",
    timeout: 15000,
  });
  results.resurrectionReturns = true;

  const success = Object.values(results).every(Boolean);
  console.log(JSON.stringify({ dataRoot, taskId, workspace, results, success }, null, 2));
  process.exitCode = success ? 0 : 1;
} catch (error) {
  console.error("preview-reader e2e threw:", error);
  console.log(JSON.stringify({ results }, null, 2));
  process.exitCode = 1;
} finally {
  if (app) {
    await app.close();
  }
  fs.rmSync(dataRoot, { recursive: true, force: true });
}

// ── helpers ──────────────────────────────────────────────────────────────────
function writeText(root, relative, contents) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, "utf8");
}

async function openTab(page, taskId, relativePath) {
  await page.evaluate((args) => window.duetRuntime.openPreview(args), { taskId, relativePath });
}

async function tabCount(preview) {
  return preview.locator(".preview-tab").count();
}
