import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { approveIfVisible } from "./helpers/approval.mjs";
import { activeSessionTaskId, sendFirstPrompt } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-inspector-linkage-e2e-"));
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
    "Create exactly one Markdown file named inspector_link.md.",
    "The file must contain exactly this sentence: Inspector review linkage ready.",
    "Do not modify any other files.",
  ]);

  const taskId = await activeSessionTaskId(page);
  if (!taskId) {
    throw new Error("Sidebar session did not expose a task id.");
  }
  await page.locator(".artifact-item", { hasText: "inspector_link.md" }).waitFor({
    state: "visible",
  });

  const inspectorWindowPromise = electronApp.waitForEvent("window");
  await page.locator("#open-inspector-window").click();
  const inspectorPage = await inspectorWindowPromise;
  inspectorPage.setDefaultTimeout(180000);

  const runSection = inspectorPage.locator(".inspector-section", { hasText: "Run 1" });
  await runSection.waitFor({ state: "visible" });
  await runSection.locator(".inspector-action", { hasText: "Show in Main Chat" }).first().click();
  await page.locator(".turn-card.highlighted", { hasText: "inspector_link.md" }).waitFor({
    state: "visible",
  });

  await inspectorPage.locator(".inspector-window-tab", { hasText: "Artifact" }).click();
  const artifactItem = inspectorPage.locator(".inspector-artifact-item", {
    hasText: "inspector_link.md",
  });
  await artifactItem.waitFor({ state: "visible" });
  const previewWindowPromise = electronApp.waitForEvent("window");
  await artifactItem.locator(".inspector-action", { hasText: "Open Preview" }).click();
  const previewPage = await previewWindowPromise;
  previewPage.setDefaultTimeout(180000);
  await previewPage.locator(".text-preview", { hasText: "Inspector review linkage ready." }).waitFor({
    state: "visible",
  });
  await artifactItem.locator(".inspector-action", { hasText: "Show Run" }).click();
  await page.locator(".turn-card.highlighted", { hasText: "inspector_link.md" }).waitFor({
    state: "visible",
  });

  await inspectorPage.locator(".inspector-window-tab", { hasText: "Change" }).click();
  const changeItem = inspectorPage.locator(".inspector-review-list li", {
    hasText: "inspector_link.md",
  });
  await changeItem.waitFor({ state: "visible" });
  await changeItem.locator(".inspector-action", { hasText: "Show Run" }).click();
  await page.locator(".turn-card.highlighted", { hasText: "inspector_link.md" }).waitFor({
    state: "visible",
  });
  await changeItem.locator(".inspector-action", { hasText: "Open Preview" }).click();
  await previewPage.locator(".text-preview", { hasText: "Inspector review linkage ready." }).waitFor({
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
    latestRun?.changedFiles?.some((file) => file.path === "inspector_link.md") &&
    latestRun?.artifactCandidates?.some((artifact) => artifact.path === "inspector_link.md") &&
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
