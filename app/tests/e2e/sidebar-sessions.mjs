// Sidebar multi-session e2e: two sessions born from first messages, switched
// via the sidebar, with task-scoped Preview/Inspector surfaces, and archive
// cleaning up the surfaces (the sidebar-era successor of tab close).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { approveIfVisible } from "./helpers/approval.mjs";
import {
  activeSessionTaskId,
  openNewChat,
  selectSidebarSession,
  sendFirstPrompt,
} from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-sidebar-e2e-"));
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

  await startFileSession(page, { fileName: "report.md", body: "Alpha artifact ready." });
  const firstTaskId = await activeSessionTaskId(page);
  if (!firstTaskId) {
    throw new Error("First session did not expose a task id in the sidebar.");
  }

  await page.locator(".artifact-item", { hasText: "report.md" }).waitFor({ state: "visible" });
  const previewWindowPromise = electronApp.waitForEvent("window");
  await page.locator(".artifact-item", { hasText: "report.md" }).click();
  const previewPage = await previewWindowPromise;
  previewPage.setDefaultTimeout(180000);
  await previewPage.locator(".text-preview", { hasText: "Alpha artifact ready." }).waitFor({
    state: "visible",
  });
  await previewPage.locator(".preview-window-tab", { hasText: shortId(firstTaskId) }).waitFor({
    state: "visible",
  });

  // Second session via New chat (deferred creation: entry panel first).
  await openNewChat(page);
  await page.locator(".task-entry-panel").waitFor({ state: "visible" });
  await startFileSession(page, { fileName: "report.md", body: "Beta artifact ready." });
  const secondTaskId = await activeSessionTaskId(page);
  if (!secondTaskId || secondTaskId === firstTaskId) {
    throw new Error("Second session did not create an independent task id.");
  }

  await page.locator(".artifact-item", { hasText: "report.md" }).waitFor({ state: "visible" });
  await page.locator(".artifact-item", { hasText: "report.md" }).click();
  await previewPage.locator(".text-preview", { hasText: "Beta artifact ready." }).waitFor({
    state: "visible",
  });
  await previewPage.locator(".preview-window-tab", { hasText: shortId(secondTaskId) }).waitFor({
    state: "visible",
  });
  const reportTabCount = await previewPage.locator(".preview-window-tab", { hasText: "report.md" }).count();
  if (reportTabCount !== 2) {
    throw new Error(`Expected two task-scoped report.md Preview tabs; found ${reportTabCount}.`);
  }

  // Sidebar switching isolates the reading surfaces.
  await selectSidebarSession(page, firstTaskId);
  await page.locator(".artifact-item", { hasText: "report.md" }).waitFor({ state: "visible" });
  await page.locator(".turn-card", { hasText: "Alpha artifact ready." }).waitFor({ state: "visible" });
  await page.locator(".turn-card", { hasText: "Beta artifact ready." }).waitFor({ state: "hidden" });

  await selectSidebarSession(page, secondTaskId);
  await page.locator(".artifact-item", { hasText: "report.md" }).waitFor({ state: "visible" });
  await page.locator(".turn-card", { hasText: "Beta artifact ready." }).waitFor({ state: "visible" });
  await page.locator(".turn-card", { hasText: "Alpha artifact ready." }).waitFor({ state: "hidden" });

  await previewPage.locator(".preview-window-tab", { hasText: shortId(firstTaskId) }).click();
  await previewPage.locator(".text-preview", { hasText: "Alpha artifact ready." }).waitFor({
    state: "visible",
  });
  await previewPage.locator(".preview-window-tab", { hasText: shortId(secondTaskId) }).click();
  await previewPage.locator(".text-preview", { hasText: "Beta artifact ready." }).waitFor({
    state: "visible",
  });

  // Inspector follows the active session and lists both.
  await selectSidebarSession(page, firstTaskId);
  const inspectorWindowPromise = electronApp.waitForEvent("window");
  await page.locator("#open-inspector-window").click();
  const inspectorPage = await inspectorWindowPromise;
  inspectorPage.setDefaultTimeout(180000);
  await inspectorPage.locator("#inspector-window-title", { hasText: shortId(firstTaskId) }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".inspector-task-tab", { hasText: shortId(secondTaskId) }).waitFor({
    state: "visible",
  });

  // Archive replaces tab close: stops the PTY and cleans up surfaces.
  const firstRow = page.locator(`.sidebar-session[data-task-id="${firstTaskId}"]`);
  await firstRow.hover();
  await firstRow.locator(".sidebar-row-hover-action").click();
  await page.locator(".sidebar-menu-item", { hasText: "Archive" }).click();
  await firstRow.waitFor({ state: "detached" });
  await inspectorPage.locator("#inspector-window-title", { hasText: "No active Task" }).waitFor({
    state: "visible",
  });
  await previewPage.locator(".preview-window-tab", { hasText: shortId(firstTaskId) }).waitFor({
    state: "hidden",
  });
  await previewPage.locator(".preview-window-tab", { hasText: shortId(secondTaskId) }).waitFor({
    state: "visible",
  });
  const remainingReportTabCount = await previewPage
    .locator(".preview-window-tab", { hasText: "report.md" })
    .count();
  if (remainingReportTabCount !== 1) {
    throw new Error(
      `Expected one report.md Preview tab after archiving session A; found ${remainingReportTabCount}.`,
    );
  }

  const reports = readReports(workspaceRoot);
  const alphaReport = reports.find((report) =>
    report.runs?.some((run) => run.prompt?.includes("Alpha artifact ready.")),
  );
  const betaReport = reports.find((report) =>
    report.runs?.some((run) => run.prompt?.includes("Beta artifact ready.")),
  );
  const alphaManifest = readManifest(workspaceRoot, alphaReport?.taskId);
  const reportText = JSON.stringify(reports);
  const rawTerminalPersisted =
    reportText.includes("pty:data") ||
    reportText.includes("Do you trust the contents of this directory") ||
    reportText.includes("OpenAI Codex");

  const success =
    Boolean(alphaReport) &&
    Boolean(betaReport) &&
    alphaReport?.taskId !== betaReport?.taskId &&
    alphaReport?.runs?.some((run) =>
      run.artifactCandidates?.some((artifact) => artifact.path === "report.md"),
    ) &&
    betaReport?.runs?.some((run) =>
      run.artifactCandidates?.some((artifact) => artifact.path === "report.md"),
    ) &&
    alphaManifest?.task?.archived === true &&
    reportTabCount === 2 &&
    remainingReportTabCount === 1 &&
    reports.length === 2 &&
    !rawTerminalPersisted;

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        firstTaskId,
        secondTaskId,
        reportTaskIds: reports.map((report) => report.taskId),
        alphaArchived: alphaManifest?.task?.archived ?? null,
        reportPreviewTabs: reportTabCount,
        reportPreviewTabsAfterArchive: remainingReportTabCount,
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

async function startFileSession(page, options) {
  const prompt = [
    `Create exactly one file named ${options.fileName}.`,
    `The file must contain the sentence '${options.body}'`,
    "Do not modify any other files.",
  ].join("\n");

  await sendFirstPrompt(page, prompt);
  await approveIfVisible(page, "File edit approval requested", 180000);
  await approveIfVisible(page, "Command approval requested", 15000);
  await page.locator(".turn-outcome", { hasText: "Completed by terminal idle heuristic" }).waitFor({
    state: "visible",
  });
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

function readManifest(root, taskId) {
  if (!taskId) {
    return null;
  }
  const manifestPath = path.join(root, "data", "projects", taskId, "task.json");
  return fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
}

function shortId(value) {
  return value.length > 18 ? `${value.slice(0, 18)}...` : value;
}
