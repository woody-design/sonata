import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { approveAnyVisibleApproval } from "./helpers/approval.mjs";
import { activeSessionTaskId, sendFirstPrompt, waitForEngagement } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-run-reading-e2e-"));
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

  // Reading = reply + state (2026-07-03): the card shows the prompt and the
  // reply; the retired process surfaces (work trace / footer / facts /
  // artifact chips) must NOT render, and a completed run shows no outcome
  // note (the note is reserved for stopped/failed/denied runs). The runtime
  // report on disk stays the durable carrier of changed files and artifact
  // candidates — asserted below, including the eligibility filter.
  const runCard = page.locator(".turn-card").first();
  await runCard.locator(".turn-user .turn-prompt").waitFor({ state: "visible" });
  await page.locator('.turn-card[data-run-status="completed"]').waitFor({ state: "visible" });
  await runCard.locator(".turn-body").waitFor({ state: "visible" });
  const processSurfaces = await runCard
    .locator(".turn-work-trace, .turn-footer, .turn-facts, .turn-artifacts, .turn-outcome-note")
    .count();
  if (processSurfaces !== 0) {
    throw new Error(`Retired process surfaces rendered on the completed turn card: ${processSurfaces}`);
  }

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

  const status = await safeText(page.locator("#runtime-status"));
  const approval = await safeText(page.locator("#approval-title"));
  const strip = await safeText(page.locator("#status-strip"));
  throw new Error(
    `Timed out waiting for ${expectedCompletedRuns} completed Runs. ` +
      `status=${status} approval=${approval} strip=${strip}`,
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
