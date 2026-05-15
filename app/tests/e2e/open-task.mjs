import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { approveIfVisible } from "./helpers/approval.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-open-task-e2e-"));
let electronApp = null;

try {
  let page = await launchApp("initial");

  await page.locator("#new-task").click();
  const taskDirectory = await waitForTaskDirectory(workspaceRoot, 45000);
  const workspace = path.join(workspaceRoot, taskDirectory);
  await waitForRuntimeReady(page, 240000);
  await page.locator("#workflow-headline", { hasText: "Ready for first Run" }).waitFor({
    state: "visible",
  });

  const originalPrompt = [
    "Create a Markdown file named open_original.md with exactly this content:",
    "# Open Task Original",
    "This artifact existed before reopening the Task.",
    "Do not modify any other files.",
  ].join("\n");
  const expectedTaskTitle = originalPrompt.split("\n", 1)[0];

  await page.locator("#prompt-input").fill(originalPrompt);
  await page.locator("#send-prompt").click();
  await approveIfVisible(page, "File edit approval requested", 180000);
  await waitUntil(() => fs.existsSync(path.join(workspace, "open_original.md")), 180000, "original artifact");
  await page.locator(".artifact-item", { hasText: "open_original.md" }).waitFor({ state: "visible" });
  await page.locator(".run-outcome", { hasText: "Completed by terminal idle heuristic" }).waitFor({
    state: "visible",
  });
  await page.locator("#task-title", { hasText: expectedTaskTitle }).waitFor({ state: "visible" });
  await page.locator(".task-tab-label", { hasText: expectedTaskTitle }).waitFor({ state: "visible" });
  await page.locator("#workflow-headline", { hasText: "Review ready" }).waitFor({ state: "visible" });

  const manifestPath = path.join(workspace, ".duet", "task.json");
  const reportPath = path.join(workspace, ".duet", "runtime-report.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("Task manifest was not persisted.");
  }

  await electronApp.close();
  electronApp = null;

  page = await launchApp("reopen");
  await page.locator("#open-task").click();
  await page.locator("#task-title", { hasText: expectedTaskTitle }).waitFor({ state: "visible" });
  await page.locator(".task-tab-label", { hasText: expectedTaskTitle }).waitFor({ state: "visible" });
  await page.locator(".artifact-item", { hasText: "open_original.md" }).waitFor({ state: "visible" });
  await page.locator(".run-outcome", { hasText: "Completed by terminal idle heuristic" }).waitFor({
    state: "visible",
  });
  await page.locator("#workflow-headline", { hasText: "Review ready" }).waitFor({ state: "visible" });
  await page.locator("#send-prompt", { hasText: "Continue" }).waitFor({ state: "visible" });
  const previewWindowPromise = electronApp.waitForEvent("window");
  await page.locator(".artifact-item", { hasText: "open_original.md" }).click();
  const previewPage = await previewWindowPromise;
  previewPage.setDefaultTimeout(240000);
  await previewPage.locator(".artifact-review", { hasText: "Review candidate" }).waitFor({
    state: "visible",
  });
  await previewPage.locator(".artifact-review", { hasText: "Floating Preview" }).waitFor({
    state: "visible",
  });
  await previewPage.locator(".artifact-review", { hasText: ".duet/runtime-report.json" }).waitFor({
    state: "visible",
  });
  await previewPage.locator(".artifact-review", { hasText: "markdown" }).waitFor({ state: "visible" });
  await previewPage.locator(".text-preview", { hasText: "before reopening the Task" }).waitFor({
    state: "visible",
  });
  await waitForRuntimeReady(page, 240000);

  const followupPrompt = [
    "Create a Markdown file named open_followup.md with exactly this content:",
    "# Open Task Followup",
    "The reopened Task accepted a new prompt.",
    "Do not modify any other files.",
  ].join("\n");

  await page.locator("#prompt-input").fill(followupPrompt);
  await page.locator("#send-prompt").click();
  await approveIfVisible(page, "File edit approval requested", 180000);
  await waitUntil(() => fs.existsSync(path.join(workspace, "open_followup.md")), 180000, "followup artifact");
  await page.locator(".artifact-item", { hasText: "open_followup.md" }).waitFor({ state: "visible" });

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const reportText = JSON.stringify(report);
  const rawTerminalPersisted =
    reportText.includes("pty:data") ||
    reportText.includes("OpenAI Codex") ||
    reportText.includes("Do you trust the contents of this directory");
  const originalRun = report.runs.find((run) =>
    run.artifactCandidates?.some((artifact) => artifact.path === "open_original.md"),
  );
  const followupRun = report.runs.find((run) =>
    run.artifactCandidates?.some((artifact) => artifact.path === "open_followup.md"),
  );
  const success =
    manifest.schemaId === "duet.task-manifest.v1" &&
    manifest.task.id === report.taskId &&
    manifest.task.title === expectedTaskTitle &&
    Boolean(originalRun) &&
    Boolean(followupRun) &&
    report.runs.length >= 2 &&
    !rawTerminalPersisted;

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        taskDirectory,
        manifestPath,
        reportPath,
        manifestSchema: manifest.schemaId,
        manifestTaskId: manifest.task.id,
        manifestTaskTitle: manifest.task.title,
        reportTaskId: report.taskId,
        runCount: report.runs.length,
        originalRestored: Boolean(originalRun),
        followupCreated: Boolean(followupRun),
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

async function launchApp(label) {
  try {
    electronApp = await electron.launch({
      args: ["dist/main/main.js"],
      env: {
        ...process.env,
        DUET_PROJECTS_DIR: workspaceRoot,
      },
    });
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          error: error instanceof Error ? error.message : String(error),
          launch: label,
          workspaceRoot,
        },
        null,
        2,
      ),
    );
    throw error;
  }
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(240000);
  return page;
}

async function waitForRuntimeReady(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await page
      .locator("#runtime-status", { hasText: "Ready" })
      .isVisible({ timeout: 500 })
      .catch(() => false);
    if (ready) {
      return true;
    }

    await approveIfVisible(page, "Workspace trust requested", 500);
    await delay(250);
  }
  throw new Error("Timed out waiting for runtime ready.");
}

async function waitForTaskDirectory(root, timeoutMs) {
  let found = null;
  await waitUntil(() => {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    found = entries.find((entry) => entry.isDirectory())?.name ?? null;
    return Boolean(found);
  }, timeoutMs, "task directory");
  return found;
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
