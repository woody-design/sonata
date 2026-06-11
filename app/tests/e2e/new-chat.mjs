// New Chat e2e: deferred session creation (the first message creates the
// session), folder + launch settings preselection, and last-used-folder
// memory across app restarts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { sendFirstPrompt } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-new-chat-e2e-"));
const selectedFolder = fs.mkdtempSync(path.join(os.tmpdir(), "duet-new-chat-folder-"));
const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-new-chat-settings-"));
let electronApp = null;

try {
  let page = await launchApp();
  await assertNewChatVisible(page);

  // The composer is the create action: enabled, send gated on text.
  const composerDisabled = await page.locator("#prompt-input").isDisabled();
  const sendDisabledWithoutText = await page.locator("#send-prompt").isDisabled();
  const placeholder = await page.locator("#prompt-input").getAttribute("placeholder");
  await page.locator("#prompt-input").fill("draft");
  const sendEnabledWithText = !(await page.locator("#send-prompt").isDisabled());
  await page.locator("#prompt-input").fill("");

  // Pick the working folder and a launch setting before the first message.
  await page.locator("#entry-choose-folder").click();
  await page.locator("#entry-choose-folder", { hasText: path.basename(selectedFolder) }).waitFor({
    state: "visible",
  });
  await page.locator("#entry-launch-settings").click();
  await page.locator(".task-settings-popover", { hasText: "Reasoning" }).waitFor({ state: "visible" });
  await page
    .locator(".task-setting-section", { hasText: "Speed" })
    .locator("button", { hasText: "Fast" })
    .click();

  const firstPrompt = "Reply with exactly: NEW_CHAT_READY";
  await sendFirstPrompt(page, firstPrompt);
  const taskDirectory = await waitForTaskDirectory(workspaceRoot, 60000);
  const workspace = path.join(workspaceRoot, taskDirectory);
  await page.locator(".task-entry-panel").waitFor({ state: "hidden" });
  await page.locator(".turn-card", { hasText: "NEW_CHAT_READY" }).waitFor({ state: "visible" });
  await page.locator(".turn-outcome", { hasText: "Completed" }).waitFor({ state: "visible" });

  // The session lands in the sidebar under the chosen folder's project group.
  await page
    .locator(".sidebar-project-name", { hasText: path.basename(selectedFolder) })
    .waitFor({ state: "visible" });
  await page.locator(".sidebar-session.active").waitFor({ state: "visible" });

  const manifestPath = path.join(workspace, ".duet", "task.json");
  const createdManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const createdReportPath = path.join(workspace, ".duet", "runtime-report.json");
  const createdReport = fs.existsSync(createdReportPath)
    ? JSON.parse(fs.readFileSync(createdReportPath, "utf8"))
    : null;
  const selectedFolderManifestExists = fs.existsSync(path.join(selectedFolder, ".duet", "task.json"));
  const projectsFile = JSON.parse(
    fs.readFileSync(path.join(settingsDir, "projects.json"), "utf8"),
  );

  await electronApp.close();
  electronApp = null;

  // Relaunch: New Chat preselects the last-used folder; the session is
  // listed and readable without spawning anything.
  page = await launchApp();
  await assertNewChatVisible(page);
  await page.locator("#entry-choose-folder", { hasText: path.basename(selectedFolder) }).waitFor({
    state: "visible",
  });
  await page
    .locator(".sidebar-session-title", { hasText: createdManifest.task.title })
    .click();
  await page.locator(".turn-card", { hasText: "NEW_CHAT_READY" }).waitFor({ state: "visible" });
  const dormantPlaceholder = await page.locator("#prompt-input").getAttribute("placeholder");

  const success =
    !composerDisabled &&
    sendDisabledWithoutText &&
    sendEnabledWithText &&
    Boolean(placeholder?.includes("starts the session")) &&
    Boolean(dormantPlaceholder?.includes("resumes this session")) &&
    createdManifest.schemaId === "duet.task-manifest.v1" &&
    createdManifest.task.provider === "codex" &&
    createdManifest.task.model === "gpt-5.5" &&
    createdManifest.task.reasoningEffort === "xhigh" &&
    createdManifest.task.speedMode === "fast" &&
    createdManifest.task.sandbox === "read-only" &&
    createdManifest.task.approval === "on-request" &&
    createdManifest.task.providerCwd === selectedFolder &&
    createdManifest.task.title === firstPrompt &&
    createdReport?.runtime?.model === "gpt-5.5" &&
    createdReport?.runtime?.speedMode === "fast" &&
    !selectedFolderManifestExists &&
    projectsFile.lastUsedFolder === selectedFolder;

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        taskDirectory,
        taskId: createdManifest.task.id,
        taskTitle: createdManifest.task.title,
        providerCwd: createdManifest.task.providerCwd,
        speedMode: createdManifest.task.speedMode,
        composerDisabled,
        sendDisabledWithoutText,
        sendEnabledWithText,
        placeholder,
        dormantPlaceholder,
        selectedFolderManifestExists,
        lastUsedFolder: projectsFile.lastUsedFolder,
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
  fs.rmSync(selectedFolder, { recursive: true, force: true });
  fs.rmSync(settingsDir, { recursive: true, force: true });
}

async function launchApp() {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      DUET_PROJECTS_DIR: workspaceRoot,
      DUET_SETTINGS_DIR: settingsDir,
      DUET_TEST_PICK_FOLDER: selectedFolder,
    },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(240000);
  return page;
}

async function assertNewChatVisible(page) {
  await page.locator(".task-entry-panel", { hasText: "What should we work on?" }).waitFor({
    state: "visible",
  });
  await page.locator("#entry-provider-codex", { hasText: "Codex" }).waitFor({ state: "visible" });
  await page.locator("#entry-provider-claude", { hasText: "Claude" }).waitFor({ state: "visible" });
  await page.locator("#entry-launch-settings").waitFor({ state: "visible" });
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
