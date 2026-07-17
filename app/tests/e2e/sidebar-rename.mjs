// Slice 5 production-path acceptance fence for surface-local Header/Sidebar
// rename, protected input identity, persistence failure, and queued intent.
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";
import { clickHoverRevealed } from "./helpers/hover.mjs";
import { createSidebarFixture } from "./helpers/sidebar-fixture.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const appRoot = path.join(repoRoot, "app");
// Output defaults to a throwaway directory; the committed evidence tree
// (product-thinking/sidebar-refactor-evidence/) is historical and must not
// churn on verification runs — publishing there is an explicit argv[2] act.
const outputDir = path.resolve(
  process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), "sonata-sidebar-rename-out-")),
);
const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-sidebar-rename-"));
const viewport = { width: 1280, height: 800 };
const screenshots = [];
const pageErrors = [];
let fixture = null;
let electronApp = null;

try {
  fixture = createSidebarFixture();
  electronApp = await electron.launch({
    args: [
      path.join(appRoot, "dist", "main", "main.js"),
      `--user-data-dir=${fixture.userDataDir}`,
    ],
    env: isolatedElectronEnv(fixture.env),
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(60_000);
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
  await page.setViewportSize(viewport);
  await installFixedClock(page, fixture.fixedNowMs);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".sidebar-project").first().waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready);
  await installDeterministicVisualStyle(page);

  const active = fixture.projects[0].sessions[0];
  await selectSession(page, active.id);

  await assertSidebarSessionMatrix(page, fixture, active);
  console.log("  pass: Sidebar Session Enter/Tab/blur/Escape/empty/unchanged/app-blur");
  await assertSingleFlightAndFailure(page, fixture, active);
  console.log("  pass: synchronous single-flight, true failure, retry, accessibility");
  await assertProtectedNode(page, fixture, active);
  console.log("  pass: background refresh preserves node/caret/focus/composition");
  await assertCompositionCompletionIntents(page, fixture, active);
  console.log("  pass: IME completion resumes queued navigation and app-blur intents");
  const renamedProjectName = await assertProjectMatrix(page, fixture);
  console.log("  pass: Sidebar Project inline edit and canonical persistence");
  await assertHeaderVisibleAndHidden(page, fixture, active, renamedProjectName);
  console.log("  pass: Header origin stays local and works with hidden active Session");
  await assertFailedQueuedNavigation(page, fixture, active);
  console.log("  pass: failed rename blocks queued entity switch without losing draft");
  const newGenerationTaskId = await assertStaleRequestDoesNotBlockNewEditor(page, fixture);
  console.log("  pass: a stale in-flight request cannot own a newer editor generation");
  await assertFailedSecondIntentRefocus(page, fixture, newGenerationTaskId);
  console.log("  pass: blocked second rename returns keyboard focus to the surviving draft");
  await assertSidebarDisappearance(page, fixture);
  await assertHeaderDisappearance(page);
  console.log("  pass: disappeared targets terminate into originating surface alerts");

  assertDeepEqual(pageErrors, [], "renderer page errors");
  const manifest = publishEvidence({
    metadata: {
      generatedAt: fixture.fixedNowIso,
      sourceRevision: readGitHead(repoRoot),
      viewport,
      fixedNow: fixture.fixedNowIso,
      assertions: {
        surfaceLocalDraft: true,
        headerVisibleAndHidden: true,
        enterTabShiftTabPointerAndAppBlur: true,
        escapeUnchangedAndEmpty: true,
        duplicateTriggersSingleFlight: true,
        truePersistenceFailureAndRetry: true,
        protectedNodeCaretFocusAndComposition: true,
        compositionDeferredIntents: true,
        queuedNavigationBlockedOnFailure: true,
        queuedArchiveAndDeleteBlockedOnFailure: true,
        staleRequestGenerationIsolation: true,
        failedSecondIntentRefocus: true,
        sessionAndProjectCanonicalPersistence: true,
        disappearanceAlertsBySurface: true,
        accessibleValidationAndBusyState: true,
      },
      sourceFiles: fingerprintSourceFiles(repoRoot, [
        "app/src/reading-core/state.ts",
        "app/src/reading-core/transitions/rename.ts",
        "app/src/reading-core/transitions/sidebar.ts",
        "app/src/reading-core/rename-flow.ts",
        "app/src/renderer/actions.ts",
        "app/src/renderer/main.ts",
        "app/src/renderer/render.ts",
        "app/src/renderer/flows/session-flows.ts",
        "app/src/renderer/view/rename-editor.ts",
        "app/src/renderer/view/sidebar.ts",
        "app/src/renderer/dom.ts",
        "app/src/renderer/styles.css",
        "app/tests/e2e/helpers/sidebar-fixture.mjs",
        "app/tests/e2e/sidebar-rename.mjs",
        "app/tests/smoke/sidebar-rename-core.mjs",
      ]),
    },
  });
  console.log(
    `sidebar-rename: production E2E passes; ${manifest.files.length} deterministic screenshots published`,
  );
} finally {
  try {
    if (electronApp) {
      await electronApp.close();
    }
  } finally {
    fixture?.cleanup();
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

async function assertSidebarSessionMatrix(page, fixture, task) {
  let canonical = task.title;

  canonical = "Sidebar Enter committed";
  await openSidebarSessionRename(page, task.id);
  await renameInput(page, "sidebar").fill(canonical);
  await renameInput(page, "sidebar").press("Enter");
  await waitForRenameClosed(page);
  assertEqual(readManifestTitle(fixture, task.id), canonical, "Enter persists Session manifest");
  await assertSessionProjections(page, task.id, canonical);

  canonical = "Sidebar pointer blur committed";
  await openSidebarSessionRename(page, task.id);
  await renameInput(page, "sidebar").fill(canonical);
  await page.locator("#reading-settings").click();
  await waitForRenameClosed(page);
  assertEqual(readManifestTitle(fixture, task.id), canonical, "pointer blur persists");
  assertEqual(
    await page.locator("#reading-settings").getAttribute("aria-expanded"),
    "true",
    "pointer destination click survives rename cleanup",
  );
  await page.locator("#reading-settings").click();

  canonical = "Sidebar Tab committed";
  await openSidebarSessionRename(page, task.id);
  await renameInput(page, "sidebar").fill(canonical);
  await renameInput(page, "sidebar").press("Tab");
  await waitForRenameClosed(page);
  assertEqual(readManifestTitle(fixture, task.id), canonical, "Tab persists");
  assertEqual(
    (await activeElementSnapshot(page)).focusKey?.startsWith("session:"),
    true,
    "forward Tab lands on a semantic Session target",
  );

  canonical = "Sidebar Shift Tab committed";
  await openSidebarSessionRename(page, task.id);
  await renameInput(page, "sidebar").fill(canonical);
  await renameInput(page, "sidebar").press("Shift+Tab");
  await waitForRenameClosed(page);
  assertEqual(readManifestTitle(fixture, task.id), canonical, "Shift+Tab persists");
  assertEqual(
    Boolean((await activeElementSnapshot(page)).focusKey),
    true,
    "reverse Tab preserves a semantic destination",
  );

  const unchangedMtime = fs.statSync(fixture.manifestPath(task.id)).mtimeMs;
  await openSidebarSessionRename(page, task.id);
  await page.locator("#reading-settings").click();
  await waitForRenameClosed(page);
  assertEqual(
    fs.statSync(fixture.manifestPath(task.id)).mtimeMs,
    unchangedMtime,
    "unchanged blur is a persistence no-op",
  );
  await page.locator("#reading-settings").click();

  await openSidebarSessionRename(page, task.id);
  await renameInput(page, "sidebar").fill("Escape must not persist");
  await renameInput(page, "sidebar").press("Escape");
  await waitForRenameClosed(page);
  assertEqual(readManifestTitle(fixture, task.id), canonical, "Escape is the only cancel path");

  await openSidebarSessionRename(page, task.id);
  await renameInput(page, "sidebar").fill("   ");
  await renameInput(page, "sidebar").press("Enter");
  await assertInlineError(page, "sidebar", "Name cannot be empty.");
  await capture(page, "sidebar-empty-validation");
  await renameInput(page, "sidebar").press("Escape");

  await openSidebarSessionRename(page, task.id);
  await renameInput(page, "sidebar").fill("   ");
  await page.locator("#reading-settings").click();
  await waitForRenameClosed(page);
  assertEqual(readManifestTitle(fixture, task.id), canonical, "empty blur reverts without write");
  await page.locator("#reading-settings").click();

  canonical = "Sidebar app blur committed";
  await openSidebarSessionRename(page, task.id);
  await renameInput(page, "sidebar").fill(canonical);
  await page.bringToFront();
  await page.evaluate(() => window.focus());
  await page.waitForTimeout(100);
  await electronApp.evaluate(async ({ BrowserWindow }) => {
    const reading = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().includes("index.html"),
    );
    reading?.focus();
    await new Promise((resolve) => setTimeout(resolve, 100));
    reading?.blur();
  });
  await waitForRenameClosed(page);
  assertEqual(readManifestTitle(fixture, task.id), canonical, "native BrowserWindow blur persists");
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().includes("index.html"))
      ?.focus();
  });
}

async function assertSingleFlightAndFailure(page, fixture, task) {
  await electronApp.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers;
    const original = handlers.get("session:rename");
    if (typeof original !== "function") {
      throw new Error("Missing production session:rename IPC handler");
    }
    globalThis.__renameRequestCount = 0;
    globalThis.__releaseRenameRequest = null;
    globalThis.__restoreRenameHandler = () => handlers.set("session:rename", original);
    handlers.set("session:rename", async (...args) => {
      globalThis.__renameRequestCount += 1;
      await new Promise((resolve) => {
        globalThis.__releaseRenameRequest = resolve;
      });
      return original(...args);
    });
  });
  await openSidebarSessionRename(page, task.id);
  const input = renameInput(page, "sidebar");
  await input.fill("Single flight committed");
  await input.press("Enter");
  assertEqual(await input.getAttribute("aria-busy"), "true", "committing input is busy");
  assertEqual(await input.getAttribute("readonly"), "", "committing input is read-only");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await input.dispatchEvent("blur");
  assertEqual(
    await electronApp.evaluate(() => globalThis.__renameRequestCount),
    1,
    "duplicates send one IPC",
  );
  await page.waitForTimeout(340);
  assertEqual(
    await page.locator(".rename-progress").textContent(),
    "Saving…",
    "delayed progress appears without replacing input",
  );
  await electronApp.evaluate(() => globalThis.__releaseRenameRequest?.());
  await waitForRenameClosed(page);
  await electronApp.evaluate(() => globalThis.__restoreRenameHandler?.());

  const beforeFailure = readManifestTitle(fixture, task.id);
  const restoreWrites = fixture.blockManifestWrites(task.id);
  await openSidebarSessionRename(page, task.id);
  await renameInput(page, "sidebar").fill("Failure draft survives");
  await renameInput(page, "sidebar").press("Enter");
  await page.locator(".rename-error.visible").waitFor({ state: "visible" });
  assertEqual(await renameInput(page, "sidebar").inputValue(), "Failure draft survives", "failure draft");
  assertEqual(readManifestTitle(fixture, task.id), beforeFailure, "failed write leaves manifest unchanged");
  await assertInlineError(
    page,
    "sidebar",
    "Couldn’t save this name. Your draft is still here—try again.",
  );
  await capture(page, "sidebar-persistence-failure");
  restoreWrites();
  await renameInput(page, "sidebar").press("Enter");
  await waitForRenameClosed(page);
  assertEqual(readManifestTitle(fixture, task.id), "Failure draft survives", "retry persists same draft");
}

async function assertProtectedNode(page, fixture, task) {
  await openSidebarSessionRename(page, task.id);
  const input = renameInput(page, "sidebar");
  await input.fill("Protected composition draft");
  await input.evaluate((element) => {
    window.__protectedRenameNode = element;
    element.setSelectionRange(4, 11);
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "中" }));
    for (const key of ["Enter", "Escape", "Tab"]) {
      element.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key,
          keyCode: 229,
          isComposing: true,
        }),
      );
    }
  });
  const otherProject = fixture.projects[1];
  await page.evaluate(
    ({ projectPath, displayName }) =>
      window.sonataRuntime.renameProject({ path: projectPath, displayName }),
    { projectPath: otherProject.path, displayName: "Zulu background refresh" },
  );
  await page.waitForTimeout(350);
  const protectedSnapshot = await input.evaluate((element) => ({
    sameNode: window.__protectedRenameNode === element,
    connected: element.isConnected,
    focused: document.activeElement === element,
    value: element.value,
    selectionStart: element.selectionStart,
    selectionEnd: element.selectionEnd,
  }));
  assertDeepEqual(
    protectedSnapshot,
    {
      sameNode: true,
      connected: true,
      focused: true,
      value: "Protected composition draft",
      selectionStart: 4,
      selectionEnd: 11,
    },
    "background index refresh preserves protected editor",
  );
  await page.locator("#reading-settings").click();
  assertEqual(
    await page.locator("#reading-settings").getAttribute("aria-expanded"),
    "true",
    "IME blur preserves the destination click while commit is suppressed",
  );
  await input.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中" }));
  });
  await waitForRenameClosed(page);
  assertEqual(
    readManifestTitle(fixture, task.id),
    "Protected composition draft",
    "compositionend retries the blur commit after IME suppression",
  );
  await page.locator("#reading-settings").click();
  await page.evaluate(
    ({ projectPath, displayName }) =>
      window.sonataRuntime.renameProject({ path: projectPath, displayName }),
    { projectPath: otherProject.path, displayName: otherProject.name },
  );
}

async function assertCompositionCompletionIntents(page, fixture, task) {
  await selectSession(page, task.id);
  await openSidebarSessionRename(page, task.id);
  let input = renameInput(page, "sidebar");
  await input.fill("IME app blur committed");
  await input.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "中" }));
  });
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  assertEqual(
    await input.evaluate((element) => document.activeElement === element),
    true,
    "native app blur leaves the composing input as the document focus owner",
  );
  await input.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中" }));
  });
  await waitForRenameClosed(page);
  assertEqual(
    readManifestTitle(fixture, task.id),
    "IME app blur committed",
    "compositionend resumes the latched app-blur commit",
  );

  const destinationButton = page
    .locator(`.sidebar-session:not([data-task-id="${task.id}"]) .sidebar-session-button`)
    .first();
  await destinationButton.waitFor({ state: "visible" });
  const destinationId = await destinationButton.evaluate((button) =>
    button.closest(".sidebar-session")?.getAttribute("data-task-id"),
  );
  if (!destinationId) {
    throw new Error("Missing IME queued-navigation destination identity");
  }
  await openSidebarSessionRename(page, task.id);
  input = renameInput(page, "sidebar");
  await input.fill("IME queued navigation committed");
  await input.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "中" }));
  });
  await destinationButton.click();
  assertEqual(
    await sessionRow(page, task.id).evaluate((element) => element.classList.contains("active")),
    true,
    "queued destination waits while IME owns the editor",
  );
  await input.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中" }));
  });
  await waitForRenameClosed(page);
  await sessionRow(page, destinationId)
    .locator('.sidebar-session-button[aria-current="page"]')
    .waitFor({ state: "visible" });
  assertEqual(
    readManifestTitle(fixture, task.id),
    "IME queued navigation committed",
    "compositionend persists before continuing queued navigation",
  );
  await selectSession(page, task.id);
}

async function assertProjectMatrix(page, fixture) {
  const project = fixture.projects[0];
  let canonical = "Mango renamed";
  await openProjectRename(page, project.name);
  await renameInput(page, "sidebar").fill(canonical);
  await renameInput(page, "sidebar").press("Enter");
  await waitForRenameClosed(page);
  await projectByName(page, canonical).waitFor({ state: "visible" });
  assertEqual(readProjectName(fixture, project.path), canonical, "Project Enter persists");

  canonical = "Mango blur renamed";
  await openProjectRename(page, "Mango renamed");
  await renameInput(page, "sidebar").fill(canonical);
  await page.locator("#reading-settings").click();
  await waitForRenameClosed(page);
  await page.locator("#reading-settings").click();
  await projectByName(page, canonical).waitFor({ state: "visible" });

  await openProjectRename(page, canonical);
  await renameInput(page, "sidebar").fill("Project Escape must not persist");
  await renameInput(page, "sidebar").press("Escape");
  await waitForRenameClosed(page);
  assertEqual(readProjectName(fixture, project.path), canonical, "Project Escape cancels");
  await projectByName(page, canonical).waitFor({ state: "visible" });

  canonical = "Mango Tab renamed";
  await openProjectRename(page, "Mango blur renamed");
  await renameInput(page, "sidebar").fill(canonical);
  await renameInput(page, "sidebar").press("Tab");
  await waitForRenameClosed(page);
  assertEqual(readProjectName(fixture, project.path), canonical, "Project Tab persists");
  assertEqual(Boolean((await activeElementSnapshot(page)).focusKey), true, "Project Tab preserves focus intent");

  canonical = "Mango Shift Tab renamed";
  await openProjectRename(page, "Mango Tab renamed");
  await renameInput(page, "sidebar").fill(canonical);
  await renameInput(page, "sidebar").press("Shift+Tab");
  await waitForRenameClosed(page);
  assertEqual(readProjectName(fixture, project.path), canonical, "Project Shift+Tab persists");
  assertEqual(
    Boolean((await activeElementSnapshot(page)).focusKey),
    true,
    "Project Shift+Tab preserves focus intent",
  );

  const unchangedMtime = fs.statSync(path.join(fixture.settingsRoot, "projects.json")).mtimeMs;
  await openProjectRename(page, canonical);
  await renameInput(page, "sidebar").press("Enter");
  await waitForRenameClosed(page);
  assertEqual(
    fs.statSync(path.join(fixture.settingsRoot, "projects.json")).mtimeMs,
    unchangedMtime,
    "unchanged Project rename is a persistence no-op",
  );

  await openProjectRename(page, canonical);
  await renameInput(page, "sidebar").fill("");
  await renameInput(page, "sidebar").press("Enter");
  await assertInlineError(page, "sidebar", "Name cannot be empty.");
  await renameInput(page, "sidebar").press("Escape");

  await openProjectRename(page, canonical);
  await renameInput(page, "sidebar").fill("   ");
  await page.locator("#reading-settings").click();
  await waitForRenameClosed(page);
  assertEqual(readProjectName(fixture, project.path), canonical, "empty Project blur reverts");
  await page.locator("#reading-settings").click();

  canonical = "Mango app blur renamed";
  await openProjectRename(page, "Mango Shift Tab renamed");
  await renameInput(page, "sidebar").fill(canonical);
  await commitRenameByNativeAppBlur(page);
  assertEqual(readProjectName(fixture, project.path), canonical, "Project app blur persists");

  const restoreProjectWrites = fixture.blockProjectSettingsWrites();
  await openProjectRename(page, canonical);
  await renameInput(page, "sidebar").fill("Mango failure retry renamed");
  await renameInput(page, "sidebar").press("Enter");
  await assertInlineError(
    page,
    "sidebar",
    "Couldn’t save this name. Your draft is still here—try again.",
  );
  assertEqual(readProjectName(fixture, project.path), canonical, "failed Project write is atomic");
  restoreProjectWrites();
  canonical = "Mango failure retry renamed";
  await renameInput(page, "sidebar").press("Enter");
  await waitForRenameClosed(page);
  assertEqual(readProjectName(fixture, project.path), canonical, "Project retry persists draft");
  await projectByName(page, canonical).waitFor({ state: "visible" });
  return canonical;
}

async function assertHeaderVisibleAndHidden(page, fixture, task, projectName) {
  const current = readManifestTitle(fixture, task.id);
  await openHeaderSessionRename(page);
  const input = renameInput(page, "header");
  await input.fill("Header visible committed");
  assertEqual(
    await sessionRow(page, task.id).locator(".sidebar-session-title").textContent(),
    current,
    "Header draft is not mirrored into Sidebar before persistence",
  );
  await capture(page, "header-surface-local-draft");
  await input.press("Enter");
  await waitForRenameClosed(page);
  await assertSessionProjections(page, task.id, "Header visible committed");

  await openHeaderSessionRename(page);
  await renameInput(page, "header").fill("Header Escape must not persist");
  await renameInput(page, "header").press("Escape");
  await waitForRenameClosed(page);
  await assertSessionProjections(page, task.id, "Header visible committed");

  await openHeaderSessionRename(page);
  await renameInput(page, "header").fill("");
  await renameInput(page, "header").press("Enter");
  await assertInlineError(page, "header", "Name cannot be empty.");
  await renameInput(page, "header").press("Escape");

  await openHeaderSessionRename(page);
  await renameInput(page, "header").fill("Header pointer blur committed");
  await page.locator("#reading-settings").click();
  await waitForRenameClosed(page);
  assertEqual(
    await page.locator("#reading-settings").getAttribute("aria-expanded"),
    "true",
    "Header pointer destination survives",
  );
  await page.locator("#reading-settings").click();
  await assertSessionProjections(page, task.id, "Header pointer blur committed");

  await openHeaderSessionRename(page);
  await renameInput(page, "header").fill("Header Tab committed");
  await page.bringToFront();
  await page.evaluate(() => window.focus());
  await renameInput(page, "header").focus();
  await renameInput(page, "header").press("Tab");
  await waitForRenameClosed(page);
  const headerTabFocus = await activeElementSnapshot(page);
  assertEqual(
    headerTabFocus.id,
    "session-menu-trigger",
    `Header Tab preserves its forward destination (${JSON.stringify(headerTabFocus)})`,
  );
  await assertSessionProjections(page, task.id, "Header Tab committed");

  await openHeaderSessionRename(page);
  await renameInput(page, "header").fill("Header Shift Tab committed");
  await renameInput(page, "header").press("Shift+Tab");
  await waitForRenameClosed(page);
  const headerShiftTabFocus = await activeElementSnapshot(page);
  assertEqual(
    Boolean(headerShiftTabFocus.id || headerShiftTabFocus.focusKey),
    true,
    `Header Shift+Tab preserves its reverse destination (${JSON.stringify(headerShiftTabFocus)})`,
  );
  await assertSessionProjections(page, task.id, "Header Shift Tab committed");

  const unchangedMtime = fs.statSync(fixture.manifestPath(task.id)).mtimeMs;
  await openHeaderSessionRename(page);
  await renameInput(page, "header").press("Enter");
  await waitForRenameClosed(page);
  assertEqual(
    fs.statSync(fixture.manifestPath(task.id)).mtimeMs,
    unchangedMtime,
    "unchanged Header rename is a persistence no-op",
  );

  await openHeaderSessionRename(page);
  await renameInput(page, "header").fill("   ");
  await page.locator("#reading-settings").click();
  await waitForRenameClosed(page);
  assertEqual(
    await page.locator("#reading-settings").getAttribute("aria-expanded"),
    "true",
    "empty Header blur preserves its pointer destination",
  );
  await page.locator("#reading-settings").click();
  await assertSessionProjections(page, task.id, "Header Shift Tab committed");

  await openHeaderSessionRename(page);
  await renameInput(page, "header").fill("Header app blur committed");
  await commitRenameByNativeAppBlur(page);
  await assertSessionProjections(page, task.id, "Header app blur committed");

  const restoreWrites = fixture.blockManifestWrites(task.id);
  await openHeaderSessionRename(page);
  await renameInput(page, "header").fill("Header failure draft survives");
  await renameInput(page, "header").press("Enter");
  await assertInlineError(
    page,
    "header",
    "Couldn’t save this name. Your draft is still here—try again.",
  );
  assertEqual(
    await sessionRow(page, task.id).locator(".sidebar-session-title").textContent(),
    "Header app blur committed",
    "failed Header draft is not mirrored into Sidebar",
  );
  restoreWrites();
  await renameInput(page, "header").press("Enter");
  await waitForRenameClosed(page);
  await assertSessionProjections(page, task.id, "Header failure draft survives");

  const project = projectByName(page, projectName);
  await project.locator(".sidebar-project-label").click();
  await sessionRow(page, task.id).waitFor({ state: "detached" });
  await openHeaderSessionRename(page);
  await renameInput(page, "header").fill("Header hidden committed");
  await renameInput(page, "header").press("Enter");
  await waitForRenameClosed(page);
  assertEqual(await page.locator("#task-title").textContent(), "Header hidden committed", "hidden Header sync");
  await projectByName(page, projectName).locator(".sidebar-project-label").click();
  await sessionRow(page, task.id).waitFor({ state: "visible" });
  await assertSessionProjections(page, task.id, "Header hidden committed");
}

async function assertFailedQueuedNavigation(page, fixture, active) {
  await selectSession(page, active.id);
  const destinationButton = page
    .locator(`.sidebar-session:not([data-task-id="${active.id}"]) .sidebar-session-button`)
    .first();
  await destinationButton.waitFor({ state: "visible" });
  const destinationId = await destinationButton.evaluate((button) =>
    button.closest(".sidebar-session")?.getAttribute("data-task-id"),
  );
  if (!destinationId) {
    throw new Error("Missing queued-navigation destination identity");
  }
  const restoreWrites = fixture.blockManifestWrites(active.id);
  await openSidebarSessionRename(page, active.id);
  await renameInput(page, "sidebar").fill("Queued navigation failure draft");
  await destinationButton.click();
  await page.locator(".rename-error.visible").waitFor({ state: "visible" });
  assertEqual(
    await sessionRow(page, active.id).evaluate((element) => element.classList.contains("active")),
    true,
    "failed commit blocks destination activation",
  );
  assertEqual(
    await renameInput(page, "sidebar").inputValue(),
    "Queued navigation failure draft",
    "blocked navigation retains exact draft",
  );
  const owningProjectToggle = sessionRow(page, active.id)
    .locator("xpath=ancestor::div[contains(@class, 'sidebar-project')]")
    .locator(".sidebar-project-label");
  await owningProjectToggle.click();
  await page.locator(".rename-error.visible").waitFor({ state: "visible" });
  assertEqual(
    await owningProjectToggle.getAttribute("aria-expanded"),
    "true",
    "failed rename blocks a collapse that would hide the editor",
  );
  await page.locator("#sidebar-new-chat").click();
  await page.locator(".rename-error.visible").waitFor({ state: "visible" });
  assertEqual(
    await sessionRow(page, active.id).evaluate((element) => element.classList.contains("active")),
    true,
    "failed rename blocks the top-level New Chat switch",
  );
  restoreWrites();
  await renameInput(page, "sidebar").press("Enter");
  await waitForRenameClosed(page);

  await openSidebarSessionRename(page, active.id);
  await renameInput(page, "sidebar").fill("Queued navigation success");
  await sessionRow(page, destinationId).locator(".sidebar-session-button").click();
  await waitForRenameClosed(page);
  await page
    .locator(`.sidebar-session[data-task-id="${destinationId}"] .sidebar-session-button[aria-current="page"]`)
    .waitFor({ state: "visible" });
}

async function assertStaleRequestDoesNotBlockNewEditor(page, fixture) {
  const reservedDisappearanceTarget = fixture.projects[0].sessions[4].id;
  const visibleTaskIds = await page.locator(".sidebar-session:visible").evaluateAll((rows) =>
    rows
      .map((row) => row.getAttribute("data-task-id"))
      .filter((taskId) => Boolean(taskId)),
  );
  const [staleTargetId, nextTargetId] = visibleTaskIds.filter(
    (taskId) => taskId !== reservedDisappearanceTarget,
  );
  if (!staleTargetId || !nextTargetId) {
    throw new Error("Need two visible Sessions for rename-generation isolation");
  }
  await electronApp.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers;
    const original = handlers.get("session:rename");
    if (typeof original !== "function") {
      throw new Error("Missing production session:rename IPC handler");
    }
    globalThis.__staleRenameRequestCount = 0;
    globalThis.__releaseStaleRenameRequest = null;
    globalThis.__restoreStaleRenameHandler = () => handlers.set("session:rename", original);
    handlers.set("session:rename", async (...args) => {
      globalThis.__staleRenameRequestCount += 1;
      if (globalThis.__staleRenameRequestCount === 1) {
        await new Promise((resolve) => {
          globalThis.__releaseStaleRenameRequest = resolve;
        });
      }
      return original(...args);
    });
  });

  await openSidebarSessionRename(page, staleTargetId);
  await renameInput(page, "sidebar").fill("Stale generation must not win");
  await renameInput(page, "sidebar").press("Enter");
  assertEqual(await renameInput(page, "sidebar").getAttribute("aria-busy"), "true", "A is in flight");
  assertEqual(
    await electronApp.evaluate(() => globalThis.__staleRenameRequestCount),
    1,
    "A owns the first production IPC",
  );

  await page.evaluate(
    (taskId) => window.sonataRuntime.deleteSession({ taskId }),
    staleTargetId,
  );
  await renameInput(page, "sidebar").waitFor({ state: "detached" });
  await page.locator("#sidebar-rename-notice").waitFor({ state: "visible" });

  await openSidebarSessionRename(page, nextTargetId);
  await renameInput(page, "sidebar").fill("New generation committed");
  await renameInput(page, "sidebar").press("Enter");
  await waitForRenameClosed(page);
  assertEqual(
    await electronApp.evaluate(() => globalThis.__staleRenameRequestCount),
    2,
    "B owns an independent production IPC while A is unresolved",
  );
  assertEqual(
    readManifestTitle(fixture, nextTargetId),
    "New generation committed",
    "B persists before A settles",
  );

  await electronApp.evaluate(async () => {
    globalThis.__releaseStaleRenameRequest?.();
    await new Promise((resolve) => setTimeout(resolve, 100));
    globalThis.__restoreStaleRenameHandler?.();
  });
  await page.waitForTimeout(100);
  assertEqual(
    readManifestTitle(fixture, nextTargetId),
    "New generation committed",
    "late A settlement cannot overwrite B",
  );
  assertEqual(await page.locator(".rename-editor input").count(), 0, "late A cannot revive an editor");
  return nextTargetId;
}

async function assertFailedSecondIntentRefocus(page, fixture, taskId) {
  await selectSession(page, taskId);
  const actionTargetId = await page
    .locator(`.sidebar-session:not([data-task-id="${taskId}"])`)
    .first()
    .getAttribute("data-task-id");
  if (!actionTargetId) {
    throw new Error("Missing secondary Session for queued destructive rename tests");
  }
  const restoreWrites = fixture.blockManifestWrites(taskId);
  await openSidebarSessionRename(page, taskId);
  const draft = "Blocked second intent draft";
  await renameInput(page, "sidebar").fill(draft);
  await renameInput(page, "sidebar").press("Enter");
  await assertInlineError(
    page,
    "sidebar",
    "Couldn’t save this name. Your draft is still here—try again.",
  );

  await page.locator("#session-menu-trigger").click();
  const secondRename = page
    .locator("#sidebar-menu-root")
    .getByRole("menuitem", { name: "Rename", exact: true });
  await secondRename.waitFor({ state: "visible" });
  await secondRename.click();
  await page.locator("#sidebar-menu-root .sidebar-menu").waitFor({ state: "detached" });
  await assertInlineError(
    page,
    "sidebar",
    "Couldn’t save this name. Your draft is still here—try again.",
  );
  assertEqual(await renameInput(page, "sidebar").inputValue(), draft, "blocked intent preserves draft");
  assertEqual(
    await renameInput(page, "sidebar").evaluate((input) => document.activeElement === input),
    true,
    "blocked intent returns focus to the surviving editor",
  );

  await openSidebarSessionMenu(page, actionTargetId);
  await page.locator("#sidebar-menu-root").getByRole("menuitem", { name: "Archive" }).click();
  await assertInlineError(
    page,
    "sidebar",
    "Couldn’t save this name. Your draft is still here—try again.",
  );
  assertEqual(
    readManifest(fixture, actionTargetId).task.archived,
    false,
    "failed rename blocks queued Archive",
  );
  assertEqual(
    await renameInput(page, "sidebar").evaluate((input) => document.activeElement === input),
    true,
    "blocked Archive returns focus to the editor",
  );

  let deleteDialogOpened = false;
  const dismissUnexpectedDelete = async (dialog) => {
    deleteDialogOpened = true;
    await dialog.dismiss();
  };
  page.on("dialog", dismissUnexpectedDelete);
  await openSidebarSessionMenu(page, actionTargetId);
  await page.locator("#sidebar-menu-root").getByRole("menuitem", { name: "Delete" }).click();
  await page.waitForTimeout(100);
  page.off("dialog", dismissUnexpectedDelete);
  assertEqual(deleteDialogOpened, false, "failed rename blocks Delete before confirmation");
  assertEqual(
    fs.existsSync(fixture.manifestPath(actionTargetId)),
    true,
    "blocked Delete preserves manifest",
  );
  assertEqual(
    await renameInput(page, "sidebar").evaluate((input) => document.activeElement === input),
    true,
    "blocked Delete returns focus to the editor",
  );

  restoreWrites();
  await renameInput(page, "sidebar").press("Enter");
  await waitForRenameClosed(page);
  assertEqual(readManifestTitle(fixture, taskId), draft, "focused retry persists the same draft");
}

async function assertSidebarDisappearance(page, fixture) {
  const target = fixture.projects[0].sessions[4];
  await openSidebarSessionRename(page, target.id);
  await renameInput(page, "sidebar").fill("Orphaned Sidebar draft");
  await page.evaluate((taskId) => window.sonataRuntime.deleteSession({ taskId }), target.id);
  await renameInput(page, "sidebar").waitFor({ state: "detached" });
  const notice = page.locator("#sidebar-rename-notice");
  await notice.waitFor({ state: "visible" });
  assertEqual((await notice.textContent())?.includes("no longer available"), true, "Sidebar orphan alert");
}

async function assertHeaderDisappearance(page) {
  const targetId = await page
    .locator(".sidebar-session .sidebar-session-button")
    .first()
    .evaluate((button) => button.closest(".sidebar-session")?.getAttribute("data-task-id"));
  if (!targetId) {
    throw new Error("Missing visible Session for Header disappearance fence");
  }
  await selectSession(page, targetId);
  await openHeaderSessionRename(page);
  await renameInput(page, "header").fill("Orphaned Header draft");
  await page.evaluate((taskId) => window.sonataRuntime.deleteSession({ taskId }), targetId);
  await renameInput(page, "header").waitFor({ state: "detached" });
  const notice = page.locator("#header-rename-notice");
  await notice.waitFor({ state: "visible" });
  assertEqual((await notice.textContent())?.includes("no longer available"), true, "Header orphan alert");
}

async function blurReadingWindow() {
  await electronApp.evaluate(async ({ BrowserWindow }) => {
    const reading = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().includes("index.html"),
    );
    reading?.focus();
    await new Promise((resolve) => setTimeout(resolve, 100));
    reading?.blur();
  });
}

async function focusReadingWindow() {
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().includes("index.html"))
      ?.focus();
  });
}

async function commitRenameByNativeAppBlur(page) {
  await page.bringToFront();
  await page.evaluate(() => window.focus());
  await page.waitForTimeout(100);
  await blurReadingWindow();
  await waitForRenameClosed(page);
  await focusReadingWindow();
}

async function openSidebarSessionRename(page, taskId) {
  await openSidebarSessionMenu(page, taskId);
  await page.locator("#sidebar-menu-root").getByRole("menuitem", { name: "Rename", exact: true }).click();
  await renameInput(page, "sidebar").waitFor({ state: "visible" });
}

async function openSidebarSessionMenu(page, taskId) {
  const row = sessionRow(page, taskId);
  await row.waitFor({ state: "visible" });
  // No force-click: engage :hover for real so the hover-revealed action is
  // genuinely visible — force masked exactly the race clickHoverRevealed removes.
  await clickHoverRevealed(page, row, row.locator(".sidebar-row-hover-action"));
  await page.locator("#sidebar-menu-root .sidebar-menu").waitFor({ state: "visible" });
}

async function openHeaderSessionRename(page) {
  await page.locator("#session-menu-trigger").click();
  await page.locator("#sidebar-menu-root").getByRole("menuitem", { name: "Rename", exact: true }).click();
  await renameInput(page, "header").waitFor({ state: "visible" });
}

async function openProjectRename(page, name) {
  const project = projectByName(page, name);
  const header = project.locator(".sidebar-project-header");
  await clickHoverRevealed(page, header, header.locator(".sidebar-row-actions button").first());
  await page.locator("#sidebar-menu-root").getByRole("menuitem", { name: "Rename project" }).click();
  await renameInput(page, "sidebar").waitFor({ state: "visible" });
}

function renameInput(page, surface) {
  return page.locator(`.rename-editor-${surface} input`);
}

function sessionRow(page, taskId) {
  return page.locator(`.sidebar-session[data-task-id="${taskId}"]`);
}

function projectByName(page, name) {
  return page.locator(".sidebar-project").filter({
    has: page.locator(".sidebar-project-name", { hasText: name }),
  });
}

async function selectSession(page, taskId) {
  await sessionRow(page, taskId).locator(".sidebar-session-button").click();
  await page.locator("#task-title").waitFor({ state: "visible" });
  await page.locator("#session-menu-trigger").waitFor({ state: "visible" });
}

async function waitForRenameClosed(page) {
  await page.locator(".rename-editor input").waitFor({ state: "detached" });
}

async function assertSessionProjections(page, taskId, title) {
  assertEqual(await page.locator("#task-title").textContent(), title, "Header canonical title");
  assertEqual(
    await sessionRow(page, taskId).locator(".sidebar-session-title").textContent(),
    title,
    "Sidebar canonical title",
  );
}

async function assertInlineError(page, surface, expected) {
  const input = renameInput(page, surface);
  assertEqual(await input.getAttribute("aria-invalid"), "true", "invalid input semantics");
  const describedBy = await input.getAttribute("aria-describedby");
  assertEqual(Boolean(describedBy), true, "invalid input has description");
  assertEqual(await page.locator(`#${describedBy}`).textContent(), expected, "inline error copy");
}

async function assertInlineErrorContains(page, surface, expectedFragment) {
  const input = renameInput(page, surface);
  const describedBy = await input.getAttribute("aria-describedby");
  const text = describedBy ? await page.locator(`#${describedBy}`).textContent() : "";
  assertEqual(text?.includes(expectedFragment), true, `inline error contains ${expectedFragment}`);
}

async function activeElementSnapshot(page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement
      ? {
          id: active.id || null,
          focusKey: active.dataset.sidebarFocusKey ?? null,
          tag: active.tagName,
          className: active.className,
        }
      : { id: null, focusKey: null, tag: null, className: null };
  });
}

function readManifestTitle(fixture, taskId) {
  return readManifest(fixture, taskId).task.title;
}

function readManifest(fixture, taskId) {
  return JSON.parse(fs.readFileSync(fixture.manifestPath(taskId), "utf8"));
}

function readProjectName(fixture, projectPath) {
  const settings = JSON.parse(
    fs.readFileSync(path.join(fixture.settingsRoot, "projects.json"), "utf8"),
  );
  return settings.folders[projectPath].displayName;
}

async function installFixedClock(page, nowMs) {
  await page.addInitScript((fixedNow) => {
    const NativeDate = Date;
    class FixedDate extends NativeDate {
      constructor(...args) {
        super(...(args.length === 0 ? [fixedNow] : args));
      }
      static now() {
        return fixedNow;
      }
    }
    globalThis.Date = FixedDate;
  }, nowMs);
}

async function installDeterministicVisualStyle(page) {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        transition-duration: 0s !important;
        caret-color: transparent !important;
        scrollbar-width: none !important;
      }
      *::-webkit-scrollbar {
        width: 0 !important;
        height: 0 !important;
        display: none !important;
      }
    `,
  });
}

async function capture(page, name) {
  const fileName = `${name}.png`;
  const stagingPath = path.join(stagingDir, fileName);
  await page.screenshot({ path: stagingPath, animations: "disabled" });
  screenshots.push({ name: fileName, stagingPath });
}

function publishEvidence({ metadata }) {
  fs.mkdirSync(outputDir, { recursive: true });
  for (const entry of fs.readdirSync(outputDir)) {
    fs.rmSync(path.join(outputDir, entry), { recursive: true, force: true });
  }
  const files = screenshots.map(({ name, stagingPath }) => {
    const destination = path.join(outputDir, name);
    fs.copyFileSync(stagingPath, destination);
    return { name, sha256: sha256File(destination) };
  });
  const manifest = { ...metadata, files };
  const manifestPath = path.join(outputDir, "manifest.json");
  const temporaryManifest = `${manifestPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryManifest, manifestPath);
  return manifest;
}

function fingerprintSourceFiles(root, files) {
  return Object.fromEntries(
    files.map((relativePath) => [relativePath, sha256File(path.join(root, relativePath))]),
  );
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readGitHead(root) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function isolatedElectronEnv(overrides) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("SONATA_")) {
      delete env[key];
    }
  }
  return {
    ...env,
    ...overrides,
    SONATA_DISABLE_TERMINAL_WINDOW: "1",
    SONATA_DISABLE_AUTO_UPDATE: "1",
    SONATA_DISABLE_NOTIFICATIONS: "1",
  };
}

function assertEqual(actual, expected, message) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
