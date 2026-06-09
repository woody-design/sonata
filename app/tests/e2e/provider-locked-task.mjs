import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { approveIfVisible } from "./helpers/approval.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-provider-locked-e2e-"));
let electronApp = null;

try {
  const page = await launchApp();
  await page.locator(".task-entry-panel", { hasText: "Provider and launch settings" }).waitFor({
    state: "visible",
  });
  await page.locator("#entry-provider-claude", { hasText: "Claude" }).click();
  await page.locator("#entry-launch-settings", { hasText: "Opus Extra High" }).waitFor({
    state: "visible",
  });
  await page.locator("#entry-new-task", { hasText: "Start Claude Task" }).click();

  const taskDirectory = await waitForTaskDirectory(workspaceRoot, 45000);
  const workspace = path.join(workspaceRoot, taskDirectory);
  await waitForRuntimeReady(page, 240000);

  await page.locator(".task-tab-meta", { hasText: "Claude" }).waitFor({ state: "visible" });
  await page.locator("#runtime-status", { hasText: /Ready|Claude PTY/ }).waitFor({ state: "visible" });
  await page.locator("#send-prompt").waitFor({ state: "visible" });

  const manifestPath = path.join(workspace, ".duet", "task.json");
  const reportPath = path.join(workspace, ".duet", "runtime-report.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const reportText = JSON.stringify(report);
  const rawTerminalPersisted =
    reportText.includes("ClaudeCode") ||
    reportText.includes("Quick safety check") ||
    reportText.includes("Loginmethod") ||
    reportText.includes("SessionID");

  const success =
    manifest.task.provider === "claude" &&
    manifest.task.model === "opus" &&
    manifest.task.reasoningEffort === "xhigh" &&
    manifest.task.speedMode === null &&
    report.runtime?.provider === "claude" &&
    report.runtime?.model === "opus" &&
    report.runtime?.reasoningEffort === "xhigh" &&
    report.runtime?.speedMode === null &&
    report.rawTerminalPointer === null &&
    !rawTerminalPersisted;

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        taskDirectory,
        taskId: manifest.task.id,
        provider: manifest.task.provider,
        model: manifest.task.model,
        reasoningEffort: manifest.task.reasoningEffort,
        speedMode: manifest.task.speedMode,
        reportProvider: report.runtime?.provider ?? null,
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
