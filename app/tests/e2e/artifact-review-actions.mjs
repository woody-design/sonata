import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { approveAnyVisibleApproval } from "./helpers/approval.mjs";
import { activeSessionTaskId, sendFirstPrompt, waitForEngagement } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-artifact-review-e2e-"));
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
    "Create exactly one Markdown file named artifact_review.md.",
    "The file must contain exactly this sentence: Artifact review actions ready.",
    "Do not modify any other files.",
  ]);

  const taskId = await activeSessionTaskId(page);
  if (!taskId) {
    throw new Error("Sidebar session did not expose a task id.");
  }

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
  await page.locator(".turn-card.highlighted", { hasText: "artifact_review.md" }).waitFor({
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
      .locator(".turn-outcome", { hasText: "Completed" })
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
