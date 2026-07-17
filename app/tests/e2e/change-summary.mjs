import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { approveAnyVisibleApproval } from "./helpers/approval.mjs";
import { activeSessionTaskId, sendFirstPrompt, waitForEngagement } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-change-summary-e2e-"));
let electronApp = null;
let page = null;
let taskId = null;

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      SONATA_DATA_DIR: workspaceRoot, SONATA_WORKSPACES_DIR: workspaceRoot,
    },
  });

  page = await electronApp.firstWindow();
  page.setDefaultTimeout(180000);

  await runPrompt(page, 1, [
    "Create exactly two files.",
    "First, create change_summary.md containing exactly: Change summary artifact ready.",
    "Second, create change_notes.txt containing exactly: Change summary snapshot ready.",
    "Do not modify any other files.",
  ]);

  taskId = await activeSessionTaskId(page);
  if (!taskId) {
    throw new Error("Sidebar session did not expose a task id.");
  }

  await waitForReportChangedFiles(["change_summary.md", "change_notes.txt"], 30000);

  const reports = readReports(workspaceRoot);
  const latestRun = reports.at(-1)?.runs?.at(-1) ?? null;
  const reportText = JSON.stringify(reports);
  const rawTerminalPersisted =
    reportText.includes("pty:data") ||
    reportText.includes("OpenAI Codex") ||
    reportText.includes("Do you trust the contents of this directory");
  const success =
    reports.length === 1 &&
    latestRun?.changedFiles?.some((file) => file.path === "change_summary.md") &&
    latestRun?.changedFiles?.some((file) => file.path === "change_notes.txt") &&
    latestRun?.artifactCandidates?.some((artifact) => artifact.path === "change_summary.md") &&
    !latestRun?.artifactCandidates?.some((artifact) => artifact.path === "change_notes.txt") &&
    !rawTerminalPersisted;

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        taskId,
        runId: latestRun?.runId,
        changedFiles: latestRun?.changedFiles?.map((file) => file.path) ?? [],
        artifactCandidates: latestRun?.artifactCandidates?.map((artifact) => artifact.path) ?? [],
        rawTerminalPersisted,
        success,
      },
      null,
      2,
    ),
  );

  process.exitCode = success ? 0 : 1;
} catch (error) {
  console.error(
    JSON.stringify(
      {
        workspaceRoot,
        taskId,
        error: error instanceof Error ? error.message : String(error),
        statusStrip: page ? await safeText(page.locator("#status-strip")) : "",
        runtimeStatus: page ? await safeText(page.locator("#runtime-status")) : "",
        approvalTitle: page ? await safeText(page.locator("#approval-title")) : "",
        reports: summarizeReports(workspaceRoot),
      },
      null,
      2,
    ),
  );
  throw error;
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
  await waitForEngagement(page);
  await waitForCompletedRuns(page, expectedCompletedRuns, 240000);
}

async function waitForCompletedRuns(page, expectedCompletedRuns, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Drain by visibility: Claude asks per tool call (edit/read/command) and
    // broker card titles are tool summaries — kind-bound waits under-match.
    await approveAnyVisibleApproval(page);
    const completed = await page
      .locator('.turn-card[data-run-status="completed"]')
      .count();
    if (completed >= expectedCompletedRuns) {
      return;
    }
    await page.waitForTimeout(1000);
  }

  const strip = await safeText(page.locator("#status-strip"));
  const status = await safeText(page.locator("#runtime-status"));
  const approval = await safeText(page.locator("#approval-title"));
  throw new Error(
    `Timed out waiting for ${expectedCompletedRuns} completed Runs. ` +
      `strip=${strip} status=${status} approval=${approval}`,
  );
}

async function waitForReportChangedFiles(paths, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const latestRun = readReports(workspaceRoot).at(-1)?.runs?.at(-1) ?? null;
    const changedPaths = new Set(latestRun?.changedFiles?.map((file) => file.path) ?? []);
    if (paths.every((filePath) => changedPaths.has(filePath))) {
      return;
    }
    await delay(500);
  }

  throw new Error(`Timed out waiting for runtime report changed files: ${paths.join(", ")}`);
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

function summarizeReports(root) {
  return readReports(root).map((report) => ({
    taskId: report.taskId,
    runs: (report.runs ?? []).map((run) => ({
      runId: run.runId,
      status: run.status,
      changedFiles: run.changedFiles?.map((file) => `${file.changeKind}:${file.path}`) ?? [],
      artifactCandidates: run.artifactCandidates?.map((artifact) => artifact.path) ?? [],
      approvalEvents: run.approvalEvents ?? [],
    })),
    unassignedChanges: report.unassignedChanges?.map((file) => `${file.changeKind}:${file.path}`) ?? [],
  }));
}

async function safeText(locator) {
  try {
    return (await locator.textContent({ timeout: 1000 })) ?? "";
  } catch {
    return "";
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
