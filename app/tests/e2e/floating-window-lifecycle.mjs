import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { approveIfVisible } from "./helpers/approval.mjs";
import { activeSessionTaskId, sendFirstPrompt } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-floating-window-e2e-"));
const previewTargetBounds = { x: 120, y: 120, width: 840, height: 620 };
const inspectorTargetBounds = { x: 180, y: 150, width: 900, height: 640 };
let electronApp = null;

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      DUET_DATA_DIR: workspaceRoot, DUET_WORKSPACES_DIR: workspaceRoot,
    },
  });

  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(180000);

  await runPrompt(page, 1, [
    "Create exactly one file named lifecycle.md.",
    "The file must contain exactly this sentence: Floating lifecycle artifact ready.",
    "Do not modify any other files.",
  ]);

  const taskId = await activeSessionTaskId(page);
  if (!taskId) {
    throw new Error("Sidebar session did not expose a task id.");
  }
  await page.locator(".artifact-item", { hasText: "lifecycle.md" }).waitFor({ state: "visible" });

  const previewWindowPromise = electronApp.waitForEvent("window");
  await page.locator(".artifact-item", { hasText: "lifecycle.md" }).click();
  const previewPage = await previewWindowPromise;
  previewPage.setDefaultTimeout(180000);
  await previewPage.locator(".text-preview", { hasText: "Floating lifecycle artifact ready." }).waitFor({
    state: "visible",
  });

  await setWindowBounds(electronApp, "Duet Preview", previewTargetBounds);
  const firstPreviewBounds = await waitForWindowBounds(electronApp, "Duet Preview", previewTargetBounds);
  const previewClosePromise = previewPage.waitForEvent("close");
  await closeWindow(electronApp, "Duet Preview");
  await previewClosePromise;

  const reopenedPreviewPromise = electronApp.waitForEvent("window");
  await page.locator("#open-preview-window").click();
  const reopenedPreviewPage = await reopenedPreviewPromise;
  reopenedPreviewPage.setDefaultTimeout(180000);
  await reopenedPreviewPage.locator(".preview-window-tab", { hasText: "lifecycle.md" }).waitFor({
    state: "visible",
  });
  await reopenedPreviewPage.locator(".text-preview", { hasText: "Floating lifecycle artifact ready." }).waitFor({
    state: "visible",
  });
  const restoredPreviewBounds = await waitForWindowBounds(
    electronApp,
    "Duet Preview",
    previewTargetBounds,
  );

  await setWindowBounds(electronApp, "Duet Preview", {
    x: -20000,
    y: -20000,
    width: 840,
    height: 620,
  });
  const offscreenPreviewClosePromise = reopenedPreviewPage.waitForEvent("close");
  await closeWindow(electronApp, "Duet Preview");
  await offscreenPreviewClosePromise;

  const fallbackPreviewPromise = electronApp.waitForEvent("window");
  await page.locator("#open-preview-window").click();
  const fallbackPreviewPage = await fallbackPreviewPromise;
  fallbackPreviewPage.setDefaultTimeout(180000);
  await fallbackPreviewPage.locator(".text-preview", { hasText: "Floating lifecycle artifact ready." }).waitFor({
    state: "visible",
  });
  const fallbackPreviewBounds = await getWindowBounds(electronApp, "Duet Preview");
  const fallbackPreviewVisible = await isWindowVisibleOnAnyDisplay(electronApp, "Duet Preview");

  const inspectorWindowPromise = electronApp.waitForEvent("window");
  await page.locator("#open-inspector-window").click();
  const inspectorPage = await inspectorWindowPromise;
  inspectorPage.setDefaultTimeout(180000);
  await inspectorPage.locator(".inspector-window-tab.selected", { hasText: "Run" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".inspector-window-tab", { hasText: "Artifact" }).click();
  await inspectorPage.locator(".inspector-window-tab.selected", { hasText: "Artifact" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".artifact-item", { hasText: "lifecycle.md" }).waitFor({
    state: "visible",
  });

  await setWindowBounds(electronApp, "Duet Inspector", inspectorTargetBounds);
  const firstInspectorBounds = await waitForWindowBounds(
    electronApp,
    "Duet Inspector",
    inspectorTargetBounds,
  );
  const inspectorClosePromise = inspectorPage.waitForEvent("close");
  await closeWindow(electronApp, "Duet Inspector");
  await inspectorClosePromise;

  const reopenedInspectorPromise = electronApp.waitForEvent("window");
  await page.locator("#open-inspector-window").click();
  const reopenedInspectorPage = await reopenedInspectorPromise;
  reopenedInspectorPage.setDefaultTimeout(180000);
  await reopenedInspectorPage.locator(".inspector-window-tab.selected", { hasText: "Artifact" }).waitFor({
    state: "visible",
  });
  await reopenedInspectorPage.locator(".artifact-item", { hasText: "lifecycle.md" }).waitFor({
    state: "visible",
  });
  const restoredInspectorBounds = await waitForWindowBounds(
    electronApp,
    "Duet Inspector",
    inspectorTargetBounds,
  );

  const reports = readReports(workspaceRoot);
  const reportText = JSON.stringify(reports);
  const rawTerminalPersisted =
    reportText.includes("pty:data") ||
    reportText.includes("Do you trust the contents of this directory") ||
    reportText.includes("OpenAI Codex");
  const latestRun = reports.at(-1)?.runs?.at(-1) ?? null;
  const previewBoundsRestored =
    boundsMatch(firstPreviewBounds, previewTargetBounds) &&
    boundsMatch(restoredPreviewBounds, previewTargetBounds);
  const inspectorBoundsRestored =
    boundsMatch(firstInspectorBounds, inspectorTargetBounds) &&
    boundsMatch(restoredInspectorBounds, inspectorTargetBounds);
  const inspectorLensRestored = await reopenedInspectorPage
    .locator(".inspector-window-tab.selected", { hasText: "Artifact" })
    .isVisible();
  const previewTabRestored = await fallbackPreviewPage
    .locator(".preview-window-tab", { hasText: "lifecycle.md" })
    .isVisible();
  const success =
    reports.length === 1 &&
    latestRun?.artifactCandidates?.some((artifact) => artifact.path === "lifecycle.md") &&
    previewTabRestored &&
    previewBoundsRestored &&
    fallbackPreviewVisible &&
    inspectorLensRestored &&
    inspectorBoundsRestored &&
    !rawTerminalPersisted;

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        taskId,
        firstPreviewBounds,
        restoredPreviewBounds,
        fallbackPreviewBounds,
        fallbackPreviewVisible,
        firstInspectorBounds,
        restoredInspectorBounds,
        inspectorLensRestored,
        previewTabRestored,
        rawTerminalPersisted,
        success,
      },
      null,
      2,
    ),
  );

  process.exitCode = success ? 0 : 1;
} finally {
  if (electronApp) {
    await electronApp.close();
  }
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
}

async function runPrompt(page, expectedCompletedRuns, lines) {
  // The first prompt creates the session (deferred creation) and answers the
  // workspace-trust approval that surfaces during the provider cold start.
  await sendFirstPrompt(page, lines);
  await page.locator("#workflow-headline", { hasText: /Codex is working|File edit approval needed/ }).waitFor({
    state: "visible",
  });
  await waitForCompletedRuns(page, expectedCompletedRuns, 240000);
}

async function waitForCompletedRuns(page, expectedCompletedRuns, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await approveIfVisible(page, "File edit approval requested", 1000);
    await approveIfVisible(page, "Command approval requested", 1000);
    const completed = await page
      .locator(".turn-outcome", { hasText: "Completed by terminal idle heuristic" })
      .count();
    if (completed >= expectedCompletedRuns) {
      return;
    }
    await page.waitForTimeout(1000);
  }

  const headline = await safeText(page.locator("#workflow-headline"));
  const status = await safeText(page.locator("#runtime-status"));
  const approval = await safeText(page.locator("#approval-title"));
  throw new Error(
    `Timed out waiting for ${expectedCompletedRuns} completed Runs. ` +
      `headline=${headline} status=${status} approval=${approval}`,
  );
}

async function setWindowBounds(electronApp, title, bounds) {
  await electronApp.evaluate(
    ({ BrowserWindow }, payload) => {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.getTitle() === payload.title,
      );
      if (!window) {
        throw new Error(`Window not found: ${payload.title}`);
      }
      window.setBounds(payload.bounds);
    },
    { title, bounds },
  );
}

async function waitForWindowBounds(electronApp, title, expectedBounds) {
  const deadline = Date.now() + 10000;
  let latestBounds = null;
  while (Date.now() < deadline) {
    latestBounds = await getWindowBounds(electronApp, title);
    if (boundsMatch(latestBounds, expectedBounds)) {
      return latestBounds;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Window bounds did not settle for ${title}: expected=${JSON.stringify(
      expectedBounds,
    )} actual=${JSON.stringify(latestBounds)}`,
  );
}

async function getWindowBounds(electronApp, title) {
  return electronApp.evaluate(
    ({ BrowserWindow }, requestedTitle) => {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.getTitle() === requestedTitle,
      );
      if (!window) {
        throw new Error(`Window not found: ${requestedTitle}`);
      }
      return window.getBounds();
    },
    title,
  );
}

async function closeWindow(electronApp, title) {
  await electronApp.evaluate(
    ({ BrowserWindow }, requestedTitle) => {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.getTitle() === requestedTitle,
      );
      if (!window) {
        throw new Error(`Window not found: ${requestedTitle}`);
      }
      window.close();
    },
    title,
  );
}

async function isWindowVisibleOnAnyDisplay(electronApp, title) {
  return electronApp.evaluate(
    ({ BrowserWindow, screen }, requestedTitle) => {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.getTitle() === requestedTitle,
      );
      if (!window) {
        throw new Error(`Window not found: ${requestedTitle}`);
      }
      const bounds = window.getBounds();
      return screen.getAllDisplays().some((display) => {
        const visibleWidth =
          Math.min(bounds.x + bounds.width, display.workArea.x + display.workArea.width) -
          Math.max(bounds.x, display.workArea.x);
        const visibleHeight =
          Math.min(bounds.y + bounds.height, display.workArea.y + display.workArea.height) -
          Math.max(bounds.y, display.workArea.y);
        return visibleWidth >= 80 && visibleHeight >= 80;
      });
    },
    title,
  );
}

function boundsMatch(actual, expected) {
  return ["x", "y", "width", "height"].every(
    (key) => Math.abs((actual?.[key] ?? Number.NaN) - expected[key]) <= 24,
  );
}

function readReports(root) {
  const projectsRoot = path.join(root, "data", "projects");
  if (!fs.existsSync(projectsRoot)) {
    return [];
  }
  return fs
    .readdirSync(projectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(projectsRoot, entry.name, "runtime-report.json"))
    .filter((reportPath) => fs.existsSync(reportPath))
    .map((reportPath) => JSON.parse(fs.readFileSync(reportPath, "utf8")));
}

async function safeText(locator) {
  try {
    return (await locator.textContent({ timeout: 1000 })) ?? "";
  } catch {
    return "";
  }
}
