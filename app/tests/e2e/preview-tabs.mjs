// Preview window tab behaviors (2026-07 redesign, S1 — design record §5.2/§4).
//
// Covers the browser-pure tab contract end-to-end against the built app: open,
// dedup (focus existing), close, MRU-after-close-active, session restore ACROSS
// AN APP RESTART, tombstone-not-prune, and the Cmd+9 / Cmd+W keyboard manners.
//
// A tab open in S1 has no in-app entry yet (chips are S4, the tree is S3), so
// tabs are opened through the same `openPreview` bridge the Eye button and the
// future chips use — driven here from the main window. The restore leg exploits
// that WorkspaceFiles + PreviewSessions answer for a DORMANT task (the manifest
// is on disk), so a relaunch restores with no second provider spawn.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import {
  activeSessionTaskId,
  selectSidebarSession,
  sendFirstPrompt,
  waitForCompletedTurns,
  waitForWindowByUrl,
} from "./helpers/session.mjs";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-preview-tabs-e2e-"));
const launchEnv = {
  ...process.env,
  DUET_DATA_DIR: dataRoot,
  DUET_WORKSPACES_DIR: dataRoot,
  DUET_SETTINGS_DIR: path.join(dataRoot, "config"),
};

const results = {};
let app = null;
try {
  // ── Launch 1: birth a session, populate its workspace ─────────────────────
  app = await electron.launch({ args: ["dist/main/main.js"], env: launchEnv });
  let page = await app.firstWindow();
  page.setDefaultTimeout(180000);

  await sendFirstPrompt(page, [
    "Reply exactly DUET_PREVIEW_TABS_READY.",
    "Do not create or modify any files.",
  ]);
  const taskId = await activeSessionTaskId(page);
  if (!taskId) {
    throw new Error("Sidebar session did not expose a task id.");
  }
  await waitForCompletedTurns(page, 1);

  const manifestPath = path.join(dataRoot, "data", "projects", taskId, "task.json");
  const workspace = JSON.parse(fs.readFileSync(manifestPath, "utf8")).task.providerCwd;
  if (!workspace || !fs.existsSync(workspace)) {
    throw new Error(`Manifest providerCwd is not an existing directory: ${workspace}`);
  }
  writeFile(workspace, "alpha.md", "# Alpha\n\nAlpha document body.\n");
  writeFile(workspace, "beta.txt", "beta text body\n");
  writeFile(workspace, "gamma.json", '{ "gamma": true }\n');
  writeFile(workspace, "delta.md", "# Delta\n\nDelta body.\n");
  writeFile(workspace, "one/notes.md", "# One notes\n");
  writeFile(workspace, "two/notes.md", "# Two notes\n");

  // ── Open + the window ─────────────────────────────────────────────────────
  await openTab(page, taskId, "alpha.md");
  const preview = await waitForWindowByUrl(app, "preview.html");
  preview.setDefaultTimeout(60000);
  await openTab(page, taskId, "beta.txt");
  await openTab(page, taskId, "gamma.json");
  await openTab(page, taskId, "delta.md");
  await preview.locator(".preview-tab").nth(3).waitFor({ state: "visible" });
  results.openedFour = (await tabCount(preview)) === 4;
  results.lastOpenActive = (await activeLabel(preview)) === "delta.md";
  // The active document actually rendered.
  await preview.locator('.preview-doc[data-doc-kind="text"]', { hasText: "Delta body." }).waitFor({
    state: "visible",
  });

  // ── Dedup: re-opening a path focuses its tab, never a second slot ──────────
  await openTab(page, taskId, "alpha.md");
  await waitForActive(preview, "alpha.md");
  results.dedupNoNewTab = (await tabCount(preview)) === 4;
  results.dedupFocusedExisting = (await activeLabel(preview)) === "alpha.md";

  // ── Same-name disambiguator (dimmed parent dir) ───────────────────────────
  await openTab(page, taskId, "one/notes.md");
  await openTab(page, taskId, "two/notes.md");
  await preview.locator(".preview-tab").nth(5).waitFor({ state: "visible" });
  const dirLabels = await preview.locator(".preview-tab-dir").allTextContents();
  results.disambiguator = dirLabels.includes("one") && dirLabels.includes("two");

  // ── Cmd+9 activates the LAST tab ──────────────────────────────────────────
  await focusPreview(preview);
  await preview.keyboard.press("Meta+9");
  await waitForActive(preview, "notes.md", "two");
  results.cmd9Last = await isActiveDir(preview, "two");

  // ── Tombstone: a deleted file → tombstone body, tab NOT pruned ─────────────
  fs.rmSync(path.join(workspace, "beta.txt"));
  await clickTab(preview, "beta.txt");
  await preview.locator(".preview-tombstone", { hasText: "no longer exists" }).waitFor({
    state: "visible",
  });
  results.tombstoneBody = true;
  results.tombstoneKeepsTab = (await preview.locator('.preview-tab:has-text("beta.txt")').count()) === 1;

  // ── MRU: closing the active tab activates the most-recently-used survivor ──
  // Visit delta → gamma → alpha → delta; delta's strip neighbors are gamma and
  // one/notes, so an MRU winner of alpha proves it is not "the neighbor".
  await clickTab(preview, "delta.md");
  await clickTab(preview, "gamma.json");
  await clickTab(preview, "alpha.md");
  await clickTab(preview, "delta.md");
  await waitForActive(preview, "delta.md");
  await closeTab(preview, "delta.md");
  await waitForActive(preview, "alpha.md");
  results.mruAfterClose = (await activeLabel(preview)) === "alpha.md";

  // ── Middle-click closes a tab ─────────────────────────────────────────────
  const beforeMiddle = await tabCount(preview);
  await preview.locator('.preview-tab:has-text("gamma.json")').click({ button: "middle" });
  await preview.locator('.preview-tab:has-text("gamma.json")').waitFor({ state: "detached" });
  results.middleClickClose = (await tabCount(preview)) === beforeMiddle - 1;

  // ── Context menu: Close Others leaves exactly the clicked tab ──────────────
  await preview.locator('.preview-tab:has-text("alpha.md")').click({ button: "right" });
  await preview.locator(".preview-context-item", { hasText: "Close Others" }).click();
  await waitForActive(preview, "alpha.md");
  results.closeOthers = (await tabCount(preview)) === 1;

  // Re-open a set for the restore + Cmd+W legs.
  await openTab(page, taskId, "gamma.json");
  await openTab(page, taskId, "delta.md");
  await preview.locator(".preview-tab").nth(2).waitFor({ state: "visible" });
  await clickTab(preview, "alpha.md");
  await waitForActive(preview, "alpha.md");
  const beforeRestart = await tabLabels(preview);

  // Let the debounced session write land, then quit.
  await preview.waitForTimeout(600);
  await app.close();
  app = null;

  // The session persisted to disk.
  const sessionsFile = path.join(dataRoot, "config", "preview-sessions.json");
  const persisted = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
  const persistedTabs = persisted?.sessions?.[taskId]?.tabs?.map((tab) => tab.path) ?? [];
  results.persistedToDisk =
    persistedTabs.length === 3 && persisted.sessions[taskId].activePath === "alpha.md";

  // ── Launch 2: a fresh process restores the tabs for the DORMANT task ───────
  app = await electron.launch({ args: ["dist/main/main.js"], env: launchEnv });
  page = await app.firstWindow();
  page.setDefaultTimeout(180000);
  // Select the dormant session first — the window follows the active task, so
  // this is what binds it (no provider resume: WorkspaceFiles + PreviewSessions
  // both answer from disk for a dormant task). Then open the preview.
  await page.locator(`.sidebar-session[data-task-id="${taskId}"]`).waitFor({ state: "visible" });
  await selectSidebarSession(page, taskId);
  await page.locator("#open-preview-window").click();
  const preview2 = await waitForWindowByUrl(app, "preview.html");
  preview2.setDefaultTimeout(60000);
  await preview2.locator(".preview-tab").first().waitFor({ state: "visible" });
  const restored = await tabLabels(preview2);
  results.restoredTabs = JSON.stringify(restored) === JSON.stringify(beforeRestart);
  results.restoredActive = (await activeLabel(preview2)) === "alpha.md";

  // ── Cmd+W closes tabs; the last one closes the window ─────────────────────
  await focusPreview(preview2);
  const restoredCount = await tabCount(preview2);
  for (let i = 0; i < restoredCount - 1; i += 1) {
    const before = await tabCount(preview2);
    await preview2.keyboard.press("Meta+w");
    await preview2.locator(".preview-tab").nth(before - 1).waitFor({ state: "detached" });
  }
  results.cmdWClosesTabs = (await tabCount(preview2)) === 1;
  // The final Cmd+W closes the window itself — the press rejects because the
  // page closes as a direct result of the keystroke, which is the point.
  await preview2.keyboard.press("Meta+w").catch(() => {});
  await waitForWindowGone(app, "preview.html");
  results.lastTabClosesWindow = true;

  const success = Object.values(results).every(Boolean);
  console.log(JSON.stringify({ dataRoot, taskId, workspace, results, success }, null, 2));
  process.exitCode = success ? 0 : 1;
} catch (error) {
  console.error("preview-tabs e2e threw:", error);
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
  await page.evaluate(
    (args) => window.duetRuntime.openPreview(args),
    { taskId, relativePath },
  );
}

async function tabCount(preview) {
  return preview.locator(".preview-tab").count();
}

async function tabLabels(preview) {
  return preview.locator(".preview-tab .preview-tab-label").allTextContents();
}

async function activeLabel(preview) {
  const active = preview.locator('.preview-tab[data-active="true"] .preview-tab-label');
  return (await active.count()) > 0 ? (await active.first().textContent())?.trim() : null;
}

async function isActiveDir(preview, dir) {
  const active = preview.locator('.preview-tab[data-active="true"] .preview-tab-dir');
  return (await active.count()) > 0 && (await active.first().textContent())?.trim() === dir;
}

async function waitForActive(preview, label, dir) {
  const selector = dir
    ? `.preview-tab[data-active="true"]:has(.preview-tab-dir:text-is("${dir}"))`
    : `.preview-tab[data-active="true"]:has-text("${label}")`;
  await preview.locator(selector).waitFor({ state: "visible" });
}

async function clickTab(preview, label) {
  await preview.locator(`.preview-tab:has-text("${label}")`).first().click();
}

async function closeTab(preview, label) {
  const tab = preview.locator(`.preview-tab:has-text("${label}")`).first();
  await tab.hover();
  await tab.locator(".preview-tab-close").click();
  await tab.waitFor({ state: "detached" });
}

async function focusPreview(preview) {
  // Keyboard grammar is a document listener; focus the window first.
  await preview.locator("#preview-content").click({ position: { x: 5, y: 5 } }).catch(() => {});
  await preview.locator(".preview-tabstrip").click({ position: { x: 2, y: 2 } }).catch(() => {});
}

async function waitForWindowGone(app, urlPart, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!app.windows().some((w) => w.url().includes(urlPart))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Window "${urlPart}" did not close within ${timeout}ms.`);
}
