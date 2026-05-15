import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { approveIfVisible } from "./helpers/approval.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-artifact-review-e2e-"));
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
    "Create exactly one Markdown file named artifact_review.md.",
    "The file must contain exactly this sentence: Artifact review actions ready.",
    "Do not modify any other files.",
  ]);
  await page.locator(".artifact-item", { hasText: "artifact_review.md" }).waitFor({
    state: "visible",
  });
  await page.locator(".artifact-item", { hasText: "Needs review" }).waitFor({
    state: "visible",
  });

  const previewWindowPromise = electronApp.waitForEvent("window");
  await page.locator(".artifact-item", { hasText: "artifact_review.md" }).click();
  const previewPage = await previewWindowPromise;
  previewPage.setDefaultTimeout(180000);
  await previewPage.locator(".artifact-review", { hasText: "Needs review" }).waitFor({
    state: "visible",
  });
  await previewPage.locator(".artifact-review-action", { hasText: "Back to Main Chat" }).waitFor({
    state: "visible",
  });
  await previewPage.locator(".artifact-review-action", { hasText: "Show Run" }).waitFor({
    state: "visible",
  });
  await previewPage.locator(".artifact-review-action", { hasText: "Mark Reviewed" }).click();
  await previewPage.locator(".artifact-review", { hasText: "Reviewed" }).waitFor({
    state: "visible",
  });
  await previewPage.locator(".preview-reviewed-mark", { hasText: "Reviewed" }).waitFor({
    state: "visible",
  });
  await page.locator(".artifact-item.reviewed", { hasText: "artifact_review.md" }).waitFor({
    state: "visible",
  });
  await page.locator(".artifact-item", { hasText: "Reviewed" }).waitFor({
    state: "visible",
  });

  await previewPage.locator(".artifact-review-action", { hasText: "Back to Main Chat" }).click();
  await page.locator(".artifact-item.selected", { hasText: "artifact_review.md" }).waitFor({
    state: "visible",
  });

  await previewPage.locator(".artifact-review-action", { hasText: "Show Run" }).click();
  await page.locator(".run-card.highlighted", { hasText: "artifact_review.md" }).waitFor({
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
    latestRun?.artifactCandidates?.some((artifact) => artifact.path === "artifact_review.md") &&
    !rawTerminalPersisted;

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        taskId,
        runId: latestRun?.runId,
        artifactCandidates: latestRun?.artifactCandidates?.map((artifact) => artifact.path) ?? [],
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
