import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { approveIfVisible } from "./helpers/approval.mjs";
import { chooseDraftProvider, sendFirstPrompt } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-provider-locked-e2e-"));
let electronApp = null;

try {
  const page = await launchApp();
  await page.locator(".task-entry-panel", { hasText: "your first message starts the session" }).waitFor({
    state: "visible",
  });
  await chooseDraftProvider(page, "claude");
  await page.locator("#entry-launch-settings", { hasText: "Opus 4.8 Extra High" }).waitFor({
    state: "visible",
  });
  // Draft state surfaces the chosen provider in the composer placeholder.
  await page
    .locator('#prompt-input[placeholder="Message Claude — starts the session"]')
    .waitFor({ state: "visible" });

  // The first composer message creates the provider-locked session.
  await sendFirstPrompt(page, "Reply exactly DUET_PROVIDER_LOCKED. Do not create or modify any files.");

  const taskDirectory = await waitForTaskDirectory(path.join(workspaceRoot, "data", "projects"), 45000);
  const workspace = path.join(workspaceRoot, "data", "projects", taskDirectory);
  await waitForRuntimeReady(page, 240000);

  await page.locator("#send-prompt").waitFor({ state: "visible" });

  const manifestPath = path.join(workspace, "task.json");
  const reportPath = path.join(workspace, "runtime-report.json");
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
      DUET_DATA_DIR: workspaceRoot, DUET_WORKSPACES_DIR: workspaceRoot,
    },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(240000);
  return page;
}

async function waitForRuntimeReady(page, timeoutMs) {
  // "Ready" was the retired header pill's copy; the honest turn-done beacon
  // is the completed run on the turn card (2026-07-03).
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await page
      .locator('.turn-card[data-run-status="completed"]')
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
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      entries = [];
    }
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
