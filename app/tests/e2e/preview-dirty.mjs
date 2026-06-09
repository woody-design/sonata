import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { approveIfVisible } from "./helpers/approval.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-preview-dirty-e2e-"));
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

  const taskId = await page.locator(".task-tab").first().getAttribute("data-task-id");
  if (!taskId) {
    throw new Error("Task tab did not expose a task id.");
  }

  await runPrompt(page, 1, [
    "Create exactly two files in this workspace:",
    "1. report.md with exactly this content: Initial report artifact.",
    "2. notes.md with exactly this content: Notes artifact stays selected.",
    "Do not modify any other files.",
  ]);
  await page.locator(".artifact-item", { hasText: "report.md" }).waitFor({ state: "visible" });
  await page.locator(".artifact-item", { hasText: "notes.md" }).waitFor({ state: "visible" });

  const previewWindowPromise = electronApp.waitForEvent("window");
  await page.locator(".artifact-item", { hasText: "report.md" }).click();
  const previewPage = await previewWindowPromise;
  previewPage.setDefaultTimeout(180000);
  await previewPage.locator(".text-preview", { hasText: "Initial report artifact." }).waitFor({
    state: "visible",
  });

  await page.locator(".artifact-item", { hasText: "notes.md" }).click();
  await previewPage.locator(".text-preview", { hasText: "Notes artifact stays selected." }).waitFor({
    state: "visible",
  });

  const taskDirectory = fs
    .readdirSync(workspaceRoot, { withFileTypes: true })
    .find((entry) => entry.isDirectory())?.name;
  if (!taskDirectory) {
    throw new Error("Task workspace was not created.");
  }
  const reportFile = path.join(workspaceRoot, taskDirectory, "report.md");
  fs.writeFileSync(reportFile, "Report updated while another Preview tab is selected.\n");

  const reportTab = previewPage.locator(".preview-window-tab", { hasText: "report.md" });
  const notesTab = previewPage.locator(".preview-window-tab", { hasText: "notes.md" });
  await notesTab.waitFor({ state: "visible" });
  await previewPage.locator(".text-preview", { hasText: "Notes artifact stays selected." }).waitFor({
    state: "visible",
  });
  await reportTab.locator(".preview-dirty-dot").waitFor({ state: "visible" });

  await reportTab.click();
  await previewPage
    .locator(".text-preview", { hasText: "Report updated while another Preview tab is selected." })
    .waitFor({ state: "visible" });
  await reportTab.locator(".preview-dirty-dot").waitFor({ state: "hidden" });

  const reportPath = path.join(workspaceRoot, taskDirectory, ".duet", "runtime-report.json");
  const report = reportPath && fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : null;
  const reportText = report ? JSON.stringify(report) : "";
  const rawTerminalPersisted =
    reportText.includes("pty:data") ||
    reportText.includes("Do you trust the contents of this directory") ||
    reportText.includes("OpenAI Codex");
  const latestRun = report?.runs?.at(-1) ?? null;
  const reportChanged =
    latestRun?.changedFiles?.some((file) => file.path === "report.md") ||
    report?.unassignedChanges?.some((file) => file.path === "report.md");
  const success =
    Boolean(report) &&
    report?.runs?.length === 1 &&
    reportChanged &&
    latestRun?.artifactCandidates?.some((artifact) => artifact.path === "report.md") &&
    !rawTerminalPersisted;

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        taskId,
        reportPath,
        runCount: report?.runs?.length ?? 0,
        latestChangedFiles: latestRun?.changedFiles?.map((file) => `${file.changeKind}:${file.path}`) ?? [],
        unassignedChanges: report?.unassignedChanges?.map((file) => `${file.changeKind}:${file.path}`) ?? [],
        latestArtifactCandidates: latestRun?.artifactCandidates?.map((artifact) => artifact.path) ?? [],
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
  await page.locator("#prompt-input").fill(lines.join("\n"));
  await page.locator("#send-prompt").click();
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

async function safeText(locator) {
  try {
    return (await locator.textContent({ timeout: 1000 })) ?? "";
  } catch {
    return "";
  }
}
