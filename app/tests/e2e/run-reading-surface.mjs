import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-run-reading-e2e-"));
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

  await page.locator("#entry-new-task").click();
  await approveIfVisible(page, "Workspace trust requested", 45000);
  await page.locator("#workflow-headline", { hasText: "Ready for first Run" }).waitFor({
    state: "visible",
  });

  const taskId = await page.locator(".task-tab").first().getAttribute("data-task-id");
  if (!taskId) {
    throw new Error("Task tab did not expose a task id.");
  }

  await runPrompt(page, 1, [
    "Create exactly two files.",
    "First, create run_reading.md containing exactly: Run reading artifact ready.",
    "Second, create run_notes.txt containing exactly: Run reading snapshot ready.",
    "Do not modify any other files.",
  ]);

  const runCard = page.locator(".run-card").first();
  await runCard.locator(".run-stage-strip").waitFor({ state: "visible" });
  await runCard.locator(".run-stage", { hasText: "Request" }).locator("strong", { hasText: "Submitted" }).waitFor({
    state: "visible",
  });
  await runCard.locator(".run-stage", { hasText: "Changes" }).locator("strong", { hasText: "2" }).waitFor({
    state: "visible",
  });
  await runCard.locator(".run-stage", { hasText: "Artifacts" }).locator("strong", { hasText: "1" }).waitFor({
    state: "visible",
  });
  await runCard.locator(".run-stage", { hasText: "Completion" }).locator("strong", { hasText: "Done" }).waitFor({
    state: "visible",
  });
  await runCard.locator(".run-stage", { hasText: "Approval" }).waitFor({ state: "visible" });

  const artifactChange = runCard.locator(".run-change-item", { hasText: "run_reading.md" });
  const snapshotChange = runCard.locator(".run-change-item", { hasText: "run_notes.txt" });
  await artifactChange.locator("small", { hasText: "md artifact candidate" }).waitFor({
    state: "visible",
  });
  await snapshotChange.locator("small", { hasText: "snapshot review in Inspector" }).waitFor({
    state: "visible",
  });
  await artifactChange.locator(".artifact-link", { hasText: "Open Preview" }).waitFor({
    state: "visible",
  });
  const ordinaryPreviewActions = await snapshotChange.locator(".artifact-link", { hasText: "Open Preview" }).count();

  const previewWindowPromise = electronApp.waitForEvent("window");
  await artifactChange.locator(".artifact-link", { hasText: "Open Preview" }).click();
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
      .locator(".run-outcome", { hasText: "Completed by terminal idle heuristic" })
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

function readReports(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, ".duet", "runtime-report.json"))
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
