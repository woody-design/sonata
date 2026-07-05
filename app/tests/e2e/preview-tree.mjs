// Preview folder panel — the lazy tree (2026-07 redesign, S3 — design record
// §5.4 / §4 "Folder tree").
//
// Drives the built app end-to-end against a real workspace and exercises the
// whole tree contract: lazy per-dir expansion (one fetch per FIRST expand,
// nested dirs fetch on THEIR first expand), dirs-first order, hidden-entry
// dimming + selected-row undim, click-a-file opens/dedups a tab, auto-reveal on
// a tab switch (ancestors expand + row selected), the honest loaded-only filter
// (narrow + auto-expand ancestors + never-expanded dir stays visible + clearing
// restores expansion), the 500-children "Show more" guard on a 600-entry dir,
// live refresh of an EXPANDED dir on a disk change, NO reveal for a change in a
// collapsed/unloaded dir, and the left-anchored canvas holding still across a
// panel toggle.
//
// Tabs/tree are opened through the same `openPreview` bridge the Eye button and
// chips use; the tree's file clicks route through it too.
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

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-preview-tree-e2e-"));
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
    "Reply exactly DUET_PREVIEW_TREE_READY.",
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

  // ── Workspace fixture ──────────────────────────────────────────────────────
  writeFile(workspace, "alpha.md", "# Alpha\n\nRoot document.\n");
  writeFile(workspace, ".gitignore", "dist\nnode_modules\n"); // hidden root FILE
  writeFile(workspace, ".hidden/secret.md", "# secret\n"); // hidden DIR
  writeFile(workspace, "docs/brief.md", "# Brief\n\nBrief body.\n");
  writeFile(workspace, "docs/notes.md", "# Notes\n");
  writeFile(workspace, "docs/research/deep.md", "# Deep\n\nNested doc.\n");
  writeFile(workspace, "src/index.ts", "export const x = 1;\n");
  writeFile(workspace, "lonely/existing.ts", "export const y = 2;\n"); // never expanded until phase 11
  // A 600-entry directory for the 500-children "Show more" guard.
  for (let i = 0; i < 600; i += 1) {
    writeFile(workspace, `big/f${String(i).padStart(3, "0")}.md`, `# ${i}\n`);
  }

  // ── Open the window with a ROOT file active (so panel-open auto-reveal does
  //    NOT expand any directory — the lazy-expand phase needs docs collapsed).
  await openTab(page, taskId, "alpha.md");
  const preview = await waitForWindowByUrl(app, "preview.html");
  preview.setDefaultTimeout(60000);
  await preview.locator('.preview-tab:has-text("alpha.md")').waitFor({ state: "visible" });

  // Open the folder panel (starts closed; S1 persists the toggle).
  await preview.locator("#preview-panel-toggle").click();
  await preview.locator(".preview-panel:not(.hidden)").waitFor({ state: "visible" });
  // Root listing lands.
  await preview.locator('[data-tree-path="docs"]').waitFor({ state: "visible" });

  // ── Phase 1: lazy expand + dirs-first ──────────────────────────────────────
  // docs is collapsed — its children are NOT in the DOM until it is expanded.
  results.lazyCollapsedInitially =
    (await preview.locator('[data-tree-path="docs/brief.md"]').count()) === 0;
  results.dirsFirst = await dirsFirstAtRoot(preview);

  await preview.locator('[data-tree-path="docs"]').click();
  await preview.locator('[data-tree-path="docs/brief.md"]').waitFor({ state: "visible" });
  // The nested dir's OWN children are still unfetched (research not expanded).
  results.nestedNotFetchedYet =
    (await preview.locator('[data-tree-path="docs/research/deep.md"]').count()) === 0;
  results.firstExpandShowedChildren =
    (await preview.locator('[data-tree-path="docs/notes.md"]').count()) === 1 &&
    (await preview.locator('[data-tree-path="docs/research"]').count()) === 1;

  await preview.locator('[data-tree-path="docs/research"]').click();
  await preview.locator('[data-tree-path="docs/research/deep.md"]').waitFor({ state: "visible" });
  results.nestedFetchOnItsFirstExpand = true; // the row only appears after expanding research

  // ── Phase 2: hidden dim + selected undim ───────────────────────────────────
  results.hiddenHasHook =
    (await preview.locator('[data-tree-path=".gitignore"][data-tree-hidden="true"]').count()) === 1 &&
    (await preview.locator('[data-tree-path=".hidden"][data-tree-hidden="true"]').count()) === 1;
  const dimmedOpacity = await labelOpacity(preview, ".gitignore");
  results.hiddenDimmed = dimmedOpacity !== null && dimmedOpacity > 0.35 && dimmedOpacity < 0.75;

  await preview.locator('[data-tree-path=".gitignore"]').click();
  await preview.locator('[data-tree-path=".gitignore"][data-tree-selected="true"]').waitFor({
    state: "visible",
  });
  const selectedOpacity = await labelOpacity(preview, ".gitignore");
  results.selectedUndims = selectedOpacity === 1;

  // ── Phase 3: click a file opens a tab; re-click dedups ──────────────────────
  await preview.locator('[data-tree-path="docs/brief.md"]').click();
  await preview.locator('.preview-tab:has-text("brief.md")').waitFor({ state: "visible" });
  const briefTabsAfterOpen = await preview.locator('.preview-tab:has-text("brief.md")').count();
  await preview.locator('[data-tree-path="docs/brief.md"]').click(); // re-click same file
  await preview.waitForTimeout(300);
  const briefTabsAfterReclick = await preview.locator('.preview-tab:has-text("brief.md")').count();
  results.clickOpensTab = briefTabsAfterOpen === 1;
  results.reclickDedups = briefTabsAfterReclick === 1;

  // ── Phase 4: auto-reveal on a tab switch ───────────────────────────────────
  // Open deep.md as a tab (its branch is currently expanded), then collapse
  // docs and switch tabs — switching back must re-reveal the branch.
  await preview.locator('[data-tree-path="docs/research/deep.md"]').click();
  await preview.locator('.preview-tab:has-text("deep.md")').waitFor({ state: "visible" });
  await preview.locator('[data-tree-path="docs"]').click(); // collapse docs
  await preview.locator('[data-tree-path="docs/research/deep.md"]').waitFor({ state: "detached" });

  await preview.locator('.preview-tab:has-text("alpha.md")').click();
  await preview.locator('.preview-tab:has-text("deep.md")').click(); // switch back → auto-reveal
  await preview.locator('[data-tree-path="docs/research/deep.md"][data-tree-selected="true"]').waitFor({
    state: "visible",
  });
  results.autoRevealExpandsAncestors =
    (await preview.locator('[data-tree-path="docs"][data-tree-expanded="true"]').count()) === 1 &&
    (await preview.locator('[data-tree-path="docs/research"][data-tree-expanded="true"]').count()) === 1;
  results.autoRevealSelectsRow = true; // the waitFor above proved the selection

  // ── Phase 5: honest filter (narrow + auto-expand + unexpanded stays) ───────
  await preview.locator('[data-tree-path="docs"]').click(); // collapse docs (loaded, so filter can force-expand it)
  await preview.locator('[data-tree-path="docs/research/deep.md"]').waitFor({ state: "detached" });

  await preview.locator(".preview-tree-filter-input").fill("deep");
  await preview.locator('[data-tree-path="docs/research/deep.md"]').waitFor({ state: "visible" });
  results.filterNarrowsToMatch =
    (await preview.locator('[data-tree-path="docs/research/deep.md"]').count()) === 1;
  results.filterAutoExpandsAncestors =
    (await preview.locator('[data-tree-path="docs"][data-tree-expanded="true"]').count()) === 1 &&
    (await preview.locator('[data-tree-path="docs/research"][data-tree-expanded="true"]').count()) === 1;
  // A LOADED, non-matching row hides; a NEVER-EXPANDED directory stays visible.
  results.filterHidesLoadedNonMatch =
    (await preview.locator('[data-tree-path="alpha.md"]').count()) === 0;
  results.filterKeepsUnexpandedDir =
    (await preview.locator('[data-tree-path="src"]').count()) === 1 &&
    (await preview.locator('[data-tree-path="big"]').count()) === 1;

  // Clearing restores the pre-filter expansion (docs was collapsed before the
  // filter → collapsed again after clearing, even though the filter force-
  // expanded it while active).
  await preview.locator(".preview-tree-filter-input").fill("");
  await preview.locator('[data-tree-path="docs/research/deep.md"]').waitFor({ state: "detached" });
  results.clearRestoresExpansion =
    (await preview.locator('[data-tree-path="docs"][data-tree-expanded="false"]').count()) === 1;

  // Restore also undoes a manual toggle made DURING the filter: expand a
  // never-matching directory while filtering, then clear — it collapses again.
  // (Without restore it would stay in the expansion set and reopen on clear.)
  await preview.locator(".preview-tree-filter-input").fill("deep");
  await preview.locator('[data-tree-path="docs/research/deep.md"]').waitFor({ state: "visible" });
  await preview.locator('[data-tree-path=".hidden"]').click(); // expand a non-matching dir mid-filter
  await preview.waitForTimeout(300); // let the toggle + its fetch settle
  await preview.locator(".preview-tree-filter-input").fill("");
  await preview.locator('[data-tree-path="docs/research/deep.md"]').waitFor({ state: "detached" });
  results.clearRestoresManualToggle =
    (await preview.locator('[data-tree-path=".hidden"][data-tree-expanded="false"]').count()) === 1 &&
    (await preview.locator('[data-tree-path=".hidden/secret.md"]').count()) === 0;

  // ── Phase 6: the 500-children "Show more" guard on a 600-entry dir ─────────
  await preview.locator('[data-tree-path="big"]').click();
  await preview.locator('[data-tree-more="big"]').waitFor({ state: "visible" });
  const shownFirst = await preview.locator('[data-tree-path^="big/"]').count();
  const moreLabel = (await preview.locator('[data-tree-more="big"]').textContent())?.trim();
  results.guardShows500 = shownFirst === 500;
  results.guardMoreRowCounts = moreLabel === "Show 100 more";
  // The Show-more row must sit at tree-row density, not balloon to the global
  // button min-height (34px) — it opts out (min-height:0). Review P3(b).
  const moreHeight = await preview.locator('[data-tree-more="big"]').evaluate((el) => el.offsetHeight);
  results.showMoreCompactHeight = moreHeight > 0 && moreHeight <= 28;

  await preview.locator('[data-tree-more="big"]').click();
  await preview.locator('[data-tree-path="big/f599.md"]').waitFor({ state: "visible" });
  results.showMoreRevealsRest =
    (await preview.locator('[data-tree-path^="big/"]').count()) === 600 &&
    (await preview.locator('[data-tree-more="big"]').count()) === 0;
  await preview.locator('[data-tree-path="big"]').click(); // collapse the big dir again

  // ── Phase 7: live refresh of an EXPANDED directory ─────────────────────────
  await preview.locator('[data-tree-path="docs"]').click(); // expand docs (cached)
  await preview.locator('[data-tree-path="docs/brief.md"]').waitFor({ state: "visible" });
  writeFile(workspace, "docs/fresh.md", "# Fresh\n\nCreated while docs is expanded.\n");
  await preview.locator('[data-tree-path="docs/fresh.md"]').waitFor({ state: "visible" });
  results.liveRefreshExpandedDir = true;

  // ── Phase 8: a change in a COLLAPSED, never-loaded dir does not reveal ──────
  // `lonely` has never been expanded, so it is unloaded; creating a file inside
  // it must NOT spawn a fetch (no children appear). Expanding it afterward
  // fetches fresh and shows BOTH files.
  results.lonelyCollapsed =
    (await preview.locator('[data-tree-path^="lonely/"]').count()) === 0;
  writeFile(workspace, "lonely/newfile.ts", "export const z = 3;\n");
  await preview.waitForTimeout(2500); // well past the 120ms watcher debounce + 200ms tree coalesce
  results.collapsedDirNoReveal =
    (await preview.locator('[data-tree-path^="lonely/"]').count()) === 0 &&
    (await preview.locator('[data-tree-path="lonely"][data-tree-expanded="true"]').count()) === 0;
  await preview.locator('[data-tree-path="lonely"]').click(); // first expand → fresh fetch
  await preview.locator('[data-tree-path="lonely/newfile.ts"]').waitFor({ state: "visible" });
  results.expandFetchesFresh =
    (await preview.locator('[data-tree-path="lonely/existing.ts"]').count()) === 1;

  // ── Phase 8b: an EXPANDED directory deleted → its row + subtree vanish;
  //    recreated at the same path → fresh listing, no stale resurrection (proves
  //    the subtree purge on a directory refresh). Review P2(b). ────────────────
  await ensureExpanded(preview, "docs");
  await ensureExpanded(preview, "docs/research");
  await preview.locator('[data-tree-path="docs/research/deep.md"]').waitFor({ state: "visible" });
  fs.rmSync(path.join(workspace, "docs/research"), { recursive: true, force: true });
  await preview.locator('[data-tree-path="docs/research"]').waitFor({ state: "detached", timeout: 15000 });
  results.deletedDirVanishes =
    (await preview.locator('[data-tree-path="docs/research/deep.md"]').count()) === 0;
  // Recreate the same path with DIFFERENT content — it must come back fresh, not
  // resurrect the purged deep.md from a stale cache.
  writeFile(workspace, "docs/research/other.md", "# Other\n");
  await preview.locator('[data-tree-path="docs/research"]').waitFor({ state: "visible", timeout: 15000 });
  await ensureExpanded(preview, "docs/research");
  await preview.locator('[data-tree-path="docs/research/other.md"]').waitFor({ state: "visible" });
  results.recreatedDirIsFresh =
    (await preview.locator('[data-tree-path="docs/research/other.md"]').count()) === 1 &&
    (await preview.locator('[data-tree-path="docs/research/deep.md"]').count()) === 0;

  // ── Phase 9: panel toggle keeps the (left-anchored) document unshifted ──────
  await preview.locator('.preview-tab:has-text("alpha.md")').click();
  await preview.locator('.preview-doc[data-doc-kind="markdown"]').waitFor({ state: "visible" });
  const before = await canvasAnchor(preview);
  await preview.locator("#preview-panel-toggle").click(); // close the panel
  await preview.locator(".preview-panel.hidden").waitFor({ state: "attached" });
  const after = await canvasAnchor(preview);
  results.panelToggleKeepsCanvasAnchored =
    before.left === after.left && before.scrollLeft === after.scrollLeft;

  const success = Object.values(results).every(Boolean);
  console.log(JSON.stringify({ dataRoot, taskId, workspace, results, success }, null, 2));
  process.exitCode = success ? 0 : 1;
} catch (error) {
  console.error("preview-tree e2e threw:", error);
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
  await page.evaluate((args) => window.duetRuntime.openPreview(args), { taskId, relativePath });
}

/** Expand a directory row only if it is currently collapsed (clicking blindly
 *  would toggle an already-open dir shut). */
async function ensureExpanded(preview, treePath) {
  const collapsed = await preview
    .locator(`[data-tree-path="${treePath}"][data-tree-expanded="false"]`)
    .count();
  if (collapsed > 0) {
    await preview.locator(`[data-tree-path="${treePath}"]`).click();
  }
  await preview
    .locator(`[data-tree-path="${treePath}"][data-tree-expanded="true"]`)
    .waitFor({ state: "visible" });
}

/** True iff every root-level directory row precedes every root-level file row. */
async function dirsFirstAtRoot(preview) {
  const types = await preview.evaluate(() =>
    [...document.querySelectorAll(".preview-tree-body .preview-tree-row")]
      .filter((row) => !(row.dataset.treePath ?? "").includes("/"))
      .map((row) => row.dataset.treeType),
  );
  const firstFile = types.indexOf("file");
  const lastDir = types.lastIndexOf("directory");
  return firstFile === -1 || lastDir === -1 || lastDir < firstFile;
}

/** Computed opacity of a tree row's label (the dim/undim signal). */
async function labelOpacity(preview, treePath) {
  return preview.evaluate((p) => {
    const row = document.querySelector(`[data-tree-path="${p}"]`);
    const label = row?.querySelector(".preview-tree-label");
    return label ? Number.parseFloat(getComputedStyle(label).opacity) : null;
  }, treePath);
}

/** The document canvas's left edge + horizontal scroll — both must hold across a
 *  panel toggle (the panel lives on the RIGHT; the canvas is left-anchored). */
async function canvasAnchor(preview) {
  const box = await preview.locator("#preview-content").boundingBox();
  const scrollLeft = await preview.locator("#preview-content").evaluate((el) => el.scrollLeft);
  return { left: box ? Math.round(box.x) : null, scrollLeft };
}
