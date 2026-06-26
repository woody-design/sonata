import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { approveIfVisible } from "./helpers/approval.mjs";
import { activeSessionTaskId, sendFirstPrompt } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-run-reading-e2e-"));
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
    "Create exactly two files.",
    "First, create run_reading.md containing exactly: Run reading artifact ready.",
    "Second, create run_notes.txt containing exactly: Run reading snapshot ready.",
    "Do not modify any other files.",
  ]);

  const taskId = await activeSessionTaskId(page);
  if (!taskId) {
    throw new Error("Sidebar session did not expose a task id.");
  }

  const runCard = page.locator(".turn-card").first();
  await runCard.locator(".turn-user", { hasText: "You" }).waitFor({ state: "visible" });
  await runCard.locator(".turn-facts", { hasText: "2 changes" }).waitFor({ state: "visible" });
  await runCard.locator(".turn-outcome", { hasText: "Completed" }).waitFor({ state: "visible" });

  const artifactChip = runCard.locator(".turn-artifacts .artifact-link", { hasText: "run_reading.md" });
  await artifactChip.waitFor({ state: "visible" });
  const ordinaryPreviewActions = await runCard
    .locator(".turn-artifacts .artifact-link", { hasText: "run_notes.txt" })
    .count();

  const previewWindowPromise = electronApp.waitForEvent("window");
  await artifactChip.click();
  const previewPage = await previewWindowPromise;
  previewPage.setDefaultTimeout(180000);
  await previewPage.locator(".text-preview", { hasText: "Run reading artifact ready." }).waitFor({
    state: "visible",
  });

  const reports = readReports(workspaceRoot);
  const latestRun = reports.at(-1)?.runs?.at(-1) ?? null;
  const reportText = JSON.stringify(reports);
  const rawTerminalPersisted =
    reportText.includes("pty:data") ||
    reportText.includes("OpenAI Codex") ||
    reportText.includes("Do you trust the contents of this directory");
  const success =
    reports.length === 1 &&
    latestRun?.changedFiles?.some((file) => file.path === "run_reading.md") &&
    latestRun?.changedFiles?.some((file) => file.path === "run_notes.txt") &&
    latestRun?.artifactCandidates?.some((artifact) => artifact.path === "run_reading.md") &&
    !latestRun?.artifactCandidates?.some((artifact) => artifact.path === "run_notes.txt") &&
    ordinaryPreviewActions === 0 &&
    !rawTerminalPersisted;

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        taskId,
        runId: latestRun?.runId,
        changedFiles: latestRun?.changedFiles?.map((file) => file.path) ?? [],
        artifactCandidates: latestRun?.artifactCandidates?.map((artifact) => artifact.path) ?? [],
        ordinaryPreviewActions,
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
