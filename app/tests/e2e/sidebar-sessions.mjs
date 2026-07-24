// Sidebar multi-session e2e: two sessions born from first messages, switched
// via the sidebar with isolated reading surfaces, the Preview window following
// the active task (§6.1 — a tab opened for task A does NOT carry across when
// task B, which has no claims, is selected), and archive cleaning up the
// surfaces (the sidebar-era successor of tab close). The Inspector this once
// rode for its Preview entry point retired in S5; the openPreview bridge (what
// chips/tree/links use) drives the tab open now.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { approveIfVisible } from "./helpers/approval.mjs";
import {
  activeSessionTaskId,
  chooseDraftProvider,
  openNewChat,
  selectSidebarSession,
  sendFirstPrompt,
  waitForWindowByUrl,
} from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-sidebar-e2e-"));
let electronApp = null;

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      SONATA_DATA_DIR: workspaceRoot, SONATA_WORKSPACES_DIR: workspaceRoot,
    },
  });

  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(180000);

  await startFileSession(page, { fileName: "report.md", body: "Alpha artifact ready." });
  const firstTaskId = await activeSessionTaskId(page);
  if (!firstTaskId) {
    throw new Error("First session did not expose a task id in the sidebar.");
  }

  // Second session via New chat (deferred creation: entry panel first).
  await openNewChat(page);
  await page.locator(".task-entry-panel").waitFor({ state: "visible" });
  await startFileSession(page, { fileName: "report.md", body: "Beta artifact ready." });
  const secondTaskId = await activeSessionTaskId(page);
  if (!secondTaskId || secondTaskId === firstTaskId) {
    throw new Error("Second session did not create an independent task id.");
  }

  // Sidebar switching isolates the reading surfaces.
  await selectSidebarSession(page, firstTaskId);
  await page.locator(".turn-card", { hasText: "Alpha artifact ready." }).waitFor({ state: "visible" });
  await page.locator(".turn-card", { hasText: "Beta artifact ready." }).waitFor({ state: "hidden" });

  await selectSidebarSession(page, secondTaskId);
  await page.locator(".turn-card", { hasText: "Beta artifact ready." }).waitFor({ state: "visible" });
  await page.locator(".turn-card", { hasText: "Alpha artifact ready." }).waitFor({ state: "hidden" });

  // Task-scoped Preview (§6.1): open task A's report.md as a tab through the
  // openPreview bridge (the same open-or-focus path chips/tree/links use), then
  // switch to task B and hit the header Preview button. The pathless open must
  // NOT carry task A's tab across — task B has no claims, so it clears to the
  // honest empty state.
  await selectSidebarSession(page, firstTaskId);
  await openPreviewTab(page, firstTaskId, "report.md");
  const previewPage = await waitForWindowByUrl(electronApp, "preview.html");
  previewPage.setDefaultTimeout(180000);
  await previewPage.locator(".preview-tab", { hasText: "report.md" }).waitFor({
    state: "visible",
  });

  await selectSidebarSession(page, secondTaskId);
  await page.locator("#open-preview-window").click();
  // The window follows the active task; task B has no claims, so the strip
  // swaps to task B's empty state — task A's tab does not carry across.
  await previewPage.locator("#preview-content[data-preview-reader='empty']").waitFor({
    state: "visible",
  });
  await previewPage.locator(".preview-tab", { hasText: "report.md" }).waitFor({
    state: "detached",
  });

  // Back to task A for the archive leg.
  await selectSidebarSession(page, firstTaskId);

  // Archive replaces tab close: stops the PTY and cleans up surfaces. The
  // archived task's row detaches; its report + manifest (asserted below on disk)
  // are the surviving contract.
  const firstRow = page.locator(`.sidebar-session[data-task-id="${firstTaskId}"]`);
  await firstRow.hover();
  await firstRow.locator(".sidebar-row-hover-action").click();
  await page.locator(".sidebar-menu-item", { hasText: "Archive" }).click();
  await firstRow.waitFor({ state: "detached" });

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

  await chooseDraftProvider(page, "codex");
  await sendFirstPrompt(page, prompt);
  await approveIfVisible(page, "File edit approval requested", 180000);
  await approveIfVisible(page, "Command approval requested", 15000);
  await page.locator('.turn-card[data-run-status="completed"]').waitFor({
    state: "visible",
  });
}

// Open (or focus) a Preview tab through the same bridge the header Eye button,
// transcript chips, folder tree, and in-doc links all use.
async function openPreviewTab(page, taskId, relativePath) {
  await page.evaluate(
    (args) => window.sonataRuntime.openPreview(args),
    { taskId, relativePath },
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

function readManifest(root, taskId) {
  if (!taskId) {
    return null;
  }
  const manifestPath = path.join(root, "data", "projects", taskId, "task.json");
  return fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : null;
}
