// New Chat e2e: deferred session creation (the first message creates the
// session), folder + launch settings preselection, and last-used-folder
// memory across app restarts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { sendFirstPrompt, chooseDraftProvider } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-new-chat-e2e-"));
const selectedFolder = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-new-chat-folder-"));
const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-new-chat-settings-"));
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

  // The access chip is Claude-only and follows the Settings default triad:
  // fresh settings → "Manual"; a per-session pick relabels the chip.
  await page.locator("#permission-chip", { hasText: "Manual" }).waitFor({ state: "visible" });
  await page.locator("#permission-chip").click();
  await page.locator("#access-option-acceptEdits").click();
  await page.locator("#permission-chip", { hasText: "Accept edits" }).waitFor({ state: "visible" });

  // Pick the working folder (project chip → "Use an existing folder" → native
  // dialog, answered by SONATA_TEST_PICK_FOLDER) and a launch setting before the
  // first message.
  await page.locator("#project-chip").click();
  await page.locator("#entry-choose-folder").click();
  await page.locator("#project-chip", { hasText: path.basename(selectedFolder) }).waitFor({
    state: "visible",
  });
  // New sessions default to Claude; this test exercises the Codex launch-settings
  // path (speedMode→manifest→report end-to-end), so select Codex explicitly.
  // (Claude also offers Fast on Opus now — its UI gating/unwind is covered by
  // model-settings-options.mjs, and its settings-file injection by the
  // provider-launch-settings smoke; neither needs a real spawn.)
  await chooseDraftProvider(page, "codex");
  // Codex draft: the access chip stays, now speaking Codex's own vocabulary.
  // Fresh settings → the boot-hydrated Codex default "Ask for approval". The
  // menu offers the three presets; an explicit non-default pick relabels the
  // chip AND travels on createTask (asserted against the manifest below). The
  // untouched-draft → main-process-fill path is fenced by
  // smoke:codex-approval-injection.
  await page.locator("#permission-chip", { hasText: "Ask for approval" }).waitFor({
    state: "visible",
  });
  await page.locator("#permission-chip").click();
  // Assert the three presets by their user-facing COPY, not just their IDs — an
  // ID-only check would pass on wrong/missing label text. Each option's label
  // span must equal codexPermissionModeLabel's output and its description line
  // the Codex Settings footnote clause.
  const codexMenuExpected = [
    {
      mode: "ask-for-approval",
      label: "Ask for approval",
      desc: "Read and edit in the workspace; ask before anything outside it or the internet",
    },
    {
      mode: "approve-for-me",
      label: "Approve for me",
      desc: "Only ask for actions Codex flags as potentially unsafe",
    },
    {
      mode: "full-access",
      label: "Full Access",
      desc: "Edit files anywhere and reach the internet without asking",
    },
  ];
  const codexMenuCopy = {};
  for (const option of codexMenuExpected) {
    const copy = page.locator(`#codex-access-option-${option.mode} .task-setting-option-copy`);
    await copy.waitFor({ state: "visible" });
    codexMenuCopy[option.mode] = {
      label: (await copy.locator("span").first().textContent())?.trim() ?? null,
      desc: (await copy.locator(".task-setting-option-desc").textContent())?.trim() ?? null,
    };
  }
  const codexMenuCopyMatches = codexMenuExpected.every(
    (option) =>
      codexMenuCopy[option.mode]?.label === option.label &&
      codexMenuCopy[option.mode]?.desc === option.desc,
  );
  await page.locator("#codex-access-option-full-access").click();
  await page.locator("#permission-chip", { hasText: "Full Access" }).waitFor({ state: "visible" });
  await page.locator("#model-chip").click();
  await page.locator(".task-settings-popover", { hasText: "Reasoning" }).waitFor({ state: "visible" });
  await page
    .locator(".task-setting-section", { hasText: "Speed" })
    .locator("button", { hasText: "Fast" })
    .click();

  const firstPrompt = "Reply with exactly: NEW_CHAT_READY";
  await sendFirstPrompt(page, firstPrompt);
  const taskDirectory = await waitForTaskDirectory(path.join(workspaceRoot, "data", "projects"), 60000);
  const workspace = path.join(workspaceRoot, "data", "projects", taskDirectory);
  await page.locator(".task-entry-panel").waitFor({ state: "hidden" });
  await page.locator(".turn-card", { hasText: "NEW_CHAT_READY" }).waitFor({ state: "visible" });
  await page.locator('.turn-card[data-run-status="completed"]').waitFor({ state: "visible" });

  // The session lands in the sidebar under the chosen folder's project group.
  await page
    .locator(".sidebar-project-name", { hasText: path.basename(selectedFolder) })
    .waitFor({ state: "visible" });
  await page.locator(".sidebar-session.active").waitFor({ state: "visible" });
  const activeHeaderTitle = (await page.locator("#task-title").textContent())?.trim();

  // Deferred creation consumes the New Chat draft: a fresh New Chat must NOT
  // resurrect the already-sent first prompt (the createTask→activateTask
  // handover parks the still-visible text into the New Chat slot; the send
  // path owns clearing it).
  await page.locator("#sidebar-new-chat").click();
  await assertNewChatVisible(page);
  const resurrectedDraft = await page.locator("#prompt-input").inputValue();

  const manifestPath = path.join(workspace, "task.json");
  const createdManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const createdReportPath = path.join(workspace, "runtime-report.json");
  const createdReport = fs.existsSync(createdReportPath)
    ? JSON.parse(fs.readFileSync(createdReportPath, "utf8"))
    : null;
  const selectedFolderManifestExists = fs.existsSync(path.join(selectedFolder, ".sonata", "task.json"));
  const projectsFile = JSON.parse(
    fs.readFileSync(path.join(settingsDir, "projects.json"), "utf8"),
  );

  await electronApp.close();
  electronApp = null;

  // Relaunch: New Chat preselects the last-used folder; the session is
  // listed and readable without spawning anything.
  page = await launchApp();
  await assertNewChatVisible(page);
  // Last-used-folder memory shows up twice: the project chip AND the greeting
  // ("What should we work on in <folder>?" — the greeting IS the state).
  await page.locator("#project-chip", { hasText: path.basename(selectedFolder) }).waitFor({
    state: "visible",
  });
  await page
    .locator(".task-entry-panel h2", {
      hasText: `What should we work on in ${path.basename(selectedFolder)}?`,
    })
    .waitFor({ state: "visible" });
  await page
    .locator(".sidebar-session-title", { hasText: createdManifest.task.title })
    .click();
  await page.locator(".turn-card", { hasText: "NEW_CHAT_READY" }).waitFor({ state: "visible" });
  const reopenedHeaderTitle = (await page.locator("#task-title").textContent())?.trim();
  const dormantPlaceholder = await page.locator("#prompt-input").getAttribute("placeholder");

  const success =
    !composerDisabled &&
    sendDisabledWithoutText &&
    sendEnabledWithText &&
    resurrectedDraft === "" &&
    placeholder === "Describe a task or ask a question" &&
    Boolean(dormantPlaceholder?.includes("resumes this session")) &&
    createdManifest.schemaId === "sonata.task-manifest.v1" &&
    codexMenuCopyMatches &&
    createdManifest.task.provider === "codex" &&
    createdManifest.task.model === "gpt-5.6-sol" &&
    createdManifest.task.reasoningEffort === "high" &&
    createdManifest.task.speedMode === "fast" &&
    createdManifest.task.codexPermissionMode === "full-access" &&
    createdManifest.task.providerCwd === selectedFolder &&
    createdManifest.task.title === `${localDatePrefix(createdManifest.task.createdAt)}${firstPrompt}` &&
    createdManifest.task.titleOrigin === "automatic" &&
    activeHeaderTitle === createdManifest.task.title &&
    reopenedHeaderTitle === createdManifest.task.title &&
    createdReport?.runtime?.model === "gpt-5.6-sol" &&
    createdReport?.runtime?.reasoningEffort === "high" &&
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
        codexPermissionMode: createdManifest.task.codexPermissionMode,
        codexMenuCopy,
        codexMenuCopyMatches,
        composerDisabled,
        sendDisabledWithoutText,
        sendEnabledWithText,
        placeholder,
        resurrectedDraft,
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
      SONATA_DATA_DIR: workspaceRoot, SONATA_WORKSPACES_DIR: workspaceRoot,
      SONATA_SETTINGS_DIR: settingsDir,
      SONATA_TEST_PICK_FOLDER: selectedFolder,
    },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(240000);
  return page;
}

function localDatePrefix(iso) {
  const date = new Date(iso);
  return `${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}-`;
}

// The canonical "what the New Chat screen must show" (2026-07-04 redesign):
// the greeting (folder-aware, so match the invariant prefix) and the three
// always-present composer chips — provider, model+reasoning, project.
async function assertNewChatVisible(page) {
  await page.locator(".task-entry-panel", { hasText: "What should we work on" }).waitFor({
    state: "visible",
  });
  await page.locator("#provider-chip").waitFor({ state: "visible" });
  await page.locator("#model-chip").waitFor({ state: "visible" });
  await page.locator("#project-chip").waitFor({ state: "visible" });
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
