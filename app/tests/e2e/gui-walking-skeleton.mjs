import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-gui-e2e-"));
let electronApp = null;

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      DUET_PROJECTS_DIR: workspaceRoot,
    },
  });

  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(180000);

  await page.locator("#new-task").click();
  await approveIfVisible(page, "Workspace trust requested", 45000);
  await page.locator("#workflow-headline", { hasText: "Ready for first Run" }).waitFor({
    state: "visible",
  });
  await page.locator("#send-prompt", { hasText: "Start Run" }).waitFor({ state: "visible" });

  const prompt = [
    "Create exactly two files in this workspace:",
    "1. report.md with the heading '# Duet GUI Gate' and one sentence saying 'Markdown artifact ready.'",
    "2. page.html with a minimal HTML page whose body contains 'HTML artifact ready.'",
    "Do not modify any other files.",
  ].join("\n");

  await page.locator("#prompt-input").fill(prompt);
  await page.locator("#send-prompt").click();
  await page.locator("#workflow-headline", { hasText: /Codex is working|File edit approval needed/ }).waitFor({
    state: "visible",
  });

  await approveIfVisible(page, "File edit approval requested", 180000);
  await approveIfVisible(page, "Command approval requested", 15000);

  await page.locator(".artifact-item", { hasText: "report.md" }).waitFor({ state: "visible" });
  await page.locator(".artifact-item", { hasText: "page.html" }).waitFor({ state: "visible" });
  await page.locator(".run-outcome", { hasText: "Completed by terminal idle heuristic" }).waitFor({
    state: "visible",
  });
  await page.locator(".run-evidence", { hasText: "terminal-idle-heuristic" }).waitFor({
    state: "visible",
  });
  await page.locator(".run-timeline", { hasText: "2 files changed" }).waitFor({ state: "visible" });
  await page.locator(".run-timeline", { hasText: "2 artifacts ready" }).waitFor({ state: "visible" });
  await page.locator(".run-card", { hasText: "Run 1" }).waitFor({ state: "visible" });
  await page.locator(".run-card", { hasText: "Request" }).waitFor({ state: "visible" });
  await page.locator(".run-card", { hasText: "Outcome" }).waitFor({ state: "visible" });
  await page.locator(".run-card", { hasText: "Transcript" }).waitFor({ state: "visible" });
  const transcriptText = await page.locator(".run-transcript-text").first().textContent();
  const transcriptObserved =
    Boolean(transcriptText) && transcriptText.trim().length > 40 && !transcriptText.includes("\u001b");
  if (!transcriptObserved) {
    throw new Error("Main Chat live transcript was not captured cleanly.");
  }
  await page.locator(".run-card", { hasText: "Review" }).waitFor({ state: "visible" });
  await page.locator(".run-card", { hasText: "2 artifacts ready for review" }).waitFor({
    state: "visible",
  });
  await page.locator(".run-card", { hasText: "Next" }).waitFor({ state: "visible" });
  await page.locator(".run-card", { hasText: "Review artifacts, then continue or redirect." }).waitFor({
    state: "visible",
  });
  await page.locator("#workflow-headline", { hasText: "Review ready" }).waitFor({
    state: "visible",
  });
  await page.locator("#workflow-facts", { hasText: "1 Run" }).waitFor({ state: "visible" });
  await page.locator("#workflow-facts", { hasText: "2 changes" }).waitFor({ state: "visible" });
  await page.locator("#workflow-facts", { hasText: "2 artifacts" }).waitFor({ state: "visible" });
  await page.locator("#workflow-facts", { hasText: "Terminal available" }).waitFor({
    state: "visible",
  });
  await page.locator("#send-prompt", { hasText: "Continue" }).waitFor({ state: "visible" });

  const previewWindowPromise = electronApp.waitForEvent("window");
  await page.locator(".artifact-item", { hasText: "report.md" }).click();
  const previewPage = await previewWindowPromise;
  previewPage.setDefaultTimeout(180000);
  await previewPage.locator(".floating-preview-shell", { hasText: "report.md" }).waitFor({
    state: "visible",
  });
  await previewPage.locator(".preview-window-tab", { hasText: "report.md" }).waitFor({
    state: "visible",
  });
  await previewPage.locator(".artifact-review", { hasText: "Floating Preview" }).waitFor({
    state: "visible",
  });
  await previewPage.locator(".artifact-review", { hasText: ".duet/runtime-report.json" }).waitFor({
    state: "visible",
  });
  await previewPage.locator(".text-preview", { hasText: "Markdown artifact ready." }).waitFor({
    state: "visible",
  });
  await page.locator(".side-column").waitFor({ state: "hidden" });
  await page.locator("#terminal-drawer").waitFor({ state: "hidden" });
  await page.locator("#toggle-terminal").click();
  await page.locator("#terminal-drawer").waitFor({ state: "visible" });
  await page.locator("#terminal").waitFor({ state: "visible" });
  await page.locator("#close-terminal").click();
  await page.locator("#terminal-drawer").waitFor({ state: "hidden" });

  await page.locator(".artifact-item", { hasText: "page.html" }).click();
  await previewPage.locator(".preview-window-tab", { hasText: "page.html" }).waitFor({
    state: "visible",
  });
  await previewPage.locator(".floating-preview-shell", { hasText: "page.html" }).waitFor({
    state: "visible",
  });
  await previewPage.locator(".html-preview").waitFor({ state: "visible" });

  const inspectorWindowPromise = electronApp.waitForEvent("window");
  await page.locator("#open-inspector-window").click();
  const inspectorPage = await inspectorWindowPromise;
  inspectorPage.setDefaultTimeout(180000);
  await inspectorPage.locator(".floating-inspector-shell", { hasText: "Inspector" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".inspector-window-tab", { hasText: "Run" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".inspector-window-tab", { hasText: "Change" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".inspector-window-tab", { hasText: "Artifact" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".inspector-window-tab", { hasText: "Folder" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".inspector-section", { hasText: "Runtime report summary" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".inspector-section", { hasText: "Run 1" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".inspector-section", { hasText: "report.md" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".inspector-section", { hasText: "page.html" }).waitFor({
    state: "visible",
  });

  await inspectorPage.locator(".inspector-window-tab", { hasText: "Change" }).click();
  await inspectorPage.locator(".change-summary", { hasText: "Changed files summary" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".change-summary", { hasText: "2 changed files" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".change-summary", { hasText: "not used in MVP" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".inspector-file-list", { hasText: "report.md" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".inspector-file-list", { hasText: "page.html" }).waitFor({
    state: "visible",
  });

  await inspectorPage.locator(".inspector-window-tab", { hasText: "Artifact" }).click();
  await inspectorPage.locator(".inspector-section", { hasText: "Artifact candidates" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".inspector-section", { hasText: "report-listed candidates only" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".artifact-item", { hasText: "report.md" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".artifact-item", { hasText: "page.html" }).waitFor({
    state: "visible",
  });

  await inspectorPage.locator(".inspector-window-tab", { hasText: "Folder" }).click();
  await inspectorPage.locator(".workspace-tree-item", { hasText: "report.md" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".workspace-tree-item", { hasText: "page.html" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".workspace-tree-item", { hasText: "report.md" }).click();
  await inspectorPage.locator(".workspace-file-preview", { hasText: "Markdown artifact ready." }).waitFor({
    state: "visible",
  });

  await page.locator("#toggle-terminal").click();
  await page.locator("#terminal-drawer").waitFor({ state: "visible" });
  await page.locator("#terminal").waitFor({ state: "visible" });

  const workspaceEntries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
  const taskDirectory = workspaceEntries.find((entry) => entry.isDirectory())?.name ?? null;
  const reportPath = taskDirectory
    ? path.join(workspaceRoot, taskDirectory, ".duet", "runtime-report.json")
    : null;
  const report = reportPath && fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : null;
  const reportText = report ? JSON.stringify(report) : "";
  const rawTerminalPersisted =
    reportText.includes("pty:data") ||
    reportText.includes("Do you trust the contents of this directory") ||
    reportText.includes("OpenAI Codex");

  const latestRun = report?.runs?.at(-1) ?? null;
  const success =
    Boolean(report) &&
    latestRun?.changedFiles?.some((file) => file.path === "report.md") &&
    latestRun?.changedFiles?.some((file) => file.path === "page.html") &&
    latestRun?.artifactCandidates?.some((artifact) => artifact.path === "report.md") &&
    latestRun?.artifactCandidates?.some((artifact) => artifact.path === "page.html") &&
    transcriptObserved &&
    !rawTerminalPersisted;

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        taskDirectory,
        reportPath,
        runCount: report?.runs?.length ?? 0,
        changedFiles: latestRun?.changedFiles?.map((file) => `${file.changeKind}:${file.path}`) ?? [],
        artifactCandidates: latestRun?.artifactCandidates?.map((artifact) => artifact.path) ?? [],
        transcriptObserved,
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

async function approveIfVisible(page, title, timeoutMs) {
  const banner = page.locator("#approval-banner", { hasText: title });
  try {
    await banner.waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    return false;
  }

  await page.locator("#approve-approval").click();
  await banner.waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
  return true;
}
