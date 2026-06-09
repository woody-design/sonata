import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { approveIfVisible } from "./helpers/approval.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-task-entry-e2e-"));
const existingTaskFolder = fs.mkdtempSync(path.join(os.tmpdir(), "duet-existing-task-folder-e2e-"));
let electronApp = null;

try {
  fs.mkdirSync(path.join(existingTaskFolder, ".duet"), { recursive: true });
  fs.writeFileSync(path.join(existingTaskFolder, ".duet", "task.json"), "{}", "utf8");

  let page = await launchApp();
  await assertEntryVisible(page);
  await page.locator("#prompt-input").waitFor({ state: "visible" });
  const composerDisabledBeforeTask = await page.locator("#prompt-input").isDisabled();
  const sendDisabledBeforeTask = await page.locator("#send-prompt").isDisabled();

  await page.locator("#entry-open-task").click();
  await page.locator("#runtime-status", { hasText: "No persisted Duet Task was found." }).waitFor({
    state: "visible",
  });
  await assertEntryVisible(page);

  await page.evaluate((folder) => {
    window.duetRuntime.pickFolder = async () => ({ path: folder });
  }, existingTaskFolder);
  await page.locator("#entry-choose-folder").click();
  await page.locator("#entry-open-task", { hasText: "Open Folder Task" }).waitFor({
    state: "visible",
  });
  await page.locator("#entry-provider-claude", { hasText: "Claude" }).click();
  await page.locator("#entry-new-task", { hasText: "Start Claude Task" }).click();
  await page
    .locator(".task-entry-message.error", {
      hasText: "Selected folder already contains a Duet Task. Open it instead.",
    })
    .waitFor({ state: "visible" });
  await page.locator(".task-entry-panel", { hasText: "Start Claude Task" }).waitFor({
    state: "visible",
  });
  await page.locator("#entry-clear-folder", { hasText: "Default Workspace" }).click();
  await page.locator("#entry-provider-codex", { hasText: "Codex" }).click();

  await page.locator("#entry-launch-settings").click();
  await page.locator(".task-settings-popover", { hasText: "Reasoning" }).waitFor({
    state: "visible",
  });
  await page.locator(".task-setting-section", { hasText: "Speed" }).locator("button", { hasText: "Fast" }).click();
  await page.locator("#entry-new-task", { hasText: "Start Codex Task" }).click();
  const taskDirectory = await waitForTaskDirectory(workspaceRoot, 45000);
  const workspace = path.join(workspaceRoot, taskDirectory);
  await waitForRuntimeReady(page, 240000);
  await page.locator(".task-entry-panel").waitFor({ state: "hidden" });
  await page.locator(".task-tab-label", { hasText: "New Task" }).waitFor({ state: "visible" });
  await page.locator(".empty-state", { hasText: "No Runs yet" }).waitFor({ state: "visible" });
  await page.locator("#send-prompt", { hasText: "Start Run" }).waitFor({ state: "visible" });

  const manifestPath = path.join(workspace, ".duet", "task.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("Task manifest was not persisted after entry New Task.");
  }
  const createdManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const createdReportPath = path.join(workspace, ".duet", "runtime-report.json");
  const createdReport = fs.existsSync(createdReportPath)
    ? JSON.parse(fs.readFileSync(createdReportPath, "utf8"))
    : null;

  await electronApp.close();
  electronApp = null;

  page = await launchApp();
  await assertEntryVisible(page);
  await page.locator("#entry-open-task").click();
  await waitForRuntimeReady(page, 240000);
  await page.locator(".task-entry-panel").waitFor({ state: "hidden" });
  await page.locator("#task-title", { hasText: createdManifest.task.title }).waitFor({
    state: "visible",
  });
  await page.locator(".task-tab-label", { hasText: createdManifest.task.title }).waitFor({
    state: "visible",
  });
  await page.locator(".empty-state", { hasText: "No Runs yet" }).waitFor({ state: "visible" });
  await page.locator("#send-prompt", { hasText: "Start Run" }).waitFor({ state: "visible" });

  const reopenedManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const reportPath = path.join(workspace, ".duet", "runtime-report.json");
  const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : null;
  const reportText = report ? JSON.stringify(report) : "";
  const rawTerminalPersisted =
    reportText.includes("pty:data") ||
    reportText.includes("OpenAI Codex") ||
    reportText.includes("Do you trust the contents of this directory");
  const success =
    composerDisabledBeforeTask &&
    sendDisabledBeforeTask &&
    createdManifest.schemaId === "duet.task-manifest.v1" &&
    createdManifest.task.provider === "codex" &&
    createdManifest.task.model === "gpt-5.5" &&
    createdManifest.task.reasoningEffort === "xhigh" &&
    createdManifest.task.speedMode === "fast" &&
    createdReport?.runtime?.model === "gpt-5.5" &&
    createdReport?.runtime?.reasoningEffort === "xhigh" &&
    createdReport?.runtime?.speedMode === "fast" &&
    reopenedManifest.task.id === createdManifest.task.id &&
    reopenedManifest.task.provider === "codex" &&
    reopenedManifest.task.model === "gpt-5.5" &&
    reopenedManifest.task.reasoningEffort === "xhigh" &&
    reopenedManifest.task.speedMode === "fast" &&
    reopenedManifest.task.title === createdManifest.task.title &&
    !rawTerminalPersisted;

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        taskDirectory,
        manifestPath,
        taskId: createdManifest.task.id,
        taskTitle: createdManifest.task.title,
        model: createdManifest.task.model,
        reasoningEffort: createdManifest.task.reasoningEffort,
        speedMode: createdManifest.task.speedMode,
        composerDisabledBeforeTask,
        sendDisabledBeforeTask,
        reportPath,
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
  fs.rmSync(existingTaskFolder, { recursive: true, force: true });
}

async function launchApp() {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      DUET_PROJECTS_DIR: workspaceRoot,
    },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(240000);
  return page;
}

async function assertEntryVisible(page) {
  await page.locator(".task-entry-panel", { hasText: "Start a Task" }).waitFor({
    state: "visible",
  });
  await page.locator(".task-entry-panel", { hasText: "Provider and launch settings" }).waitFor({
    state: "visible",
  });
  await page.locator("#entry-provider-codex", { hasText: "Codex" }).waitFor({ state: "visible" });
  await page.locator("#entry-provider-claude", { hasText: "Claude" }).waitFor({
    state: "visible",
  });
  await page.locator("#entry-choose-folder", { hasText: "Choose Folder" }).waitFor({
    state: "visible",
  });
  await page.locator("#entry-launch-settings", { hasText: "5.5 Extra High" }).waitFor({
    state: "visible",
  });
  await page.locator("#entry-new-task", { hasText: "Start Codex Task" }).waitFor({ state: "visible" });
  await page.locator("#entry-open-task", { hasText: "Open Latest Task" }).waitFor({
    state: "visible",
  });
  await page.locator(".task-entry-fact", { hasText: "Codex" }).waitFor({
    state: "visible",
  });
  await page.locator(".task-entry-fact", { hasText: "5.5" }).waitFor({
    state: "visible",
  });
  await page.locator(".task-entry-fact", { hasText: "Duet workspace" }).waitFor({
    state: "visible",
  });
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
