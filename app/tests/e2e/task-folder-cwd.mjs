import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";

// DUET_DATA_DIR — Duet's hidden home (records / runtime / attachments).
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-data-root-"));
// DUET_WORKSPACES_DIR — the user's VISIBLE work area for project-less sessions.
const workspacesDir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-workspaces-"));
// A user-chosen project folder.
const selectedFolder = fs.mkdtempSync(path.join(os.tmpdir(), "duet-selected-task-folder-"));
let electronApp = null;

const recordRoot = (taskId) => path.join(dataRoot, "data", "projects", taskId);

try {
  const page = await launchApp();
  await page.locator(".task-entry-panel", { hasText: "What should we work on" }).waitFor({
    state: "visible",
  });

  // 1) A chosen-folder task — provider works IN the user's folder; Duet's records
  //    live OUT in ~/.duet.
  const created = await page.evaluate(async (cwd) => {
    return window.duetRuntime.createTask({
      provider: "codex",
      cwd,
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      speedMode: "default",
      approval: "on-request",
      sandbox: "read-only",
    });
  }, selectedFolder);

  const second = await page.evaluate(async (cwd) => {
    return window.duetRuntime.createTask({
      provider: "claude",
      cwd,
      model: "opus",
      reasoningEffort: "xhigh",
      approval: "on-request",
      sandbox: "read-only",
    });
  }, selectedFolder);

  // 2) A project-less task — NO cwd. Duet generates a VISIBLE workspace (D7) and
  //    marks it autoWorkspace.
  const chat = await page.evaluate(async () => {
    return window.duetRuntime.createTask({
      provider: "claude",
      model: "opus",
      reasoningEffort: "xhigh",
      approval: "on-request",
      sandbox: "read-only",
    });
  });

  const opened = await page.evaluate(async (cwd) => {
    return window.duetRuntime.openTask({ cwd });
  }, selectedFolder);

  const manifestPath = path.join(recordRoot(created.task.id), "task.json");
  const secondManifestPath = path.join(recordRoot(second.task.id), "task.json");
  const reportPath = path.join(recordRoot(created.task.id), "runtime-report.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const secondManifest = JSON.parse(fs.readFileSync(secondManifestPath, "utf8"));
  const chatManifest = JSON.parse(fs.readFileSync(path.join(recordRoot(chat.task.id), "task.json"), "utf8"));
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));

  // Records — all three task record dirs sit under <dataRoot>/data/projects.
  const projectsDir = path.join(dataRoot, "data", "projects");
  const recordDirs = fs.existsSync(projectsDir)
    ? fs.readdirSync(projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : [];

  // D8: the chosen folder holds NOTHING Duet-owned — no `.duet` at all. Claude's
  // runtime sink (hooks/usage/settings) now lives under ~/.duet/data/runtime/<id>,
  // not in the user's repo. (`second` is the Claude task — the only writer.)
  const selectedFolderHasDuet = fs.existsSync(path.join(selectedFolder, ".duet"));
  const claudeRuntimeDir = path.join(dataRoot, "data", "runtime", second.task.id);
  const claudeSettingsAtRuntimeDir = fs.existsSync(
    path.join(claudeRuntimeDir, "claude-runtime-settings.json"),
  );
  const claudeHooksAtRuntimeDir = fs.existsSync(path.join(claudeRuntimeDir, "hooks"));

  // The project-less workspace is VISIBLE (under DUET_WORKSPACES_DIR) and exists.
  const chatCwd = chatManifest.task.providerCwd;
  const chatCwdIsVisible = chatCwd.startsWith(`${workspacesDir}${path.sep}`);
  const chatCwdExists = fs.existsSync(chatCwd);

  // D7 naming: LOCAL-date prefix (name-sort = time-sort) + short session id.
  const chatCwdName = path.basename(chatCwd);
  const slugOk = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(-\d+)?$/.test(chatCwdName);

  // C4 — deleting the project-less session removes its hidden record dir but NEVER
  // the user's visible work folder.
  await page.evaluate(async (taskId) => window.duetRuntime.deleteSession({ taskId }), chat.task.id);
  const chatRecordGoneAfterDelete = !fs.existsSync(recordRoot(chat.task.id));
  const chatWorkSurvivesDelete = fs.existsSync(chatCwd);

  const reportText = JSON.stringify(report);
  const rawTerminalPersisted =
    reportText.includes("pty:data") ||
    reportText.includes("OpenAI Codex") ||
    reportText.includes("Do you trust the contents of this directory");

  const success =
    // chosen-folder task: works in the user folder, not an auto-workspace
    created.task.workingDirectory === selectedFolder &&
    created.runtime.cwd === selectedFolder &&
    manifest.task.id === created.task.id &&
    manifest.task.provider === "codex" &&
    manifest.task.providerCwd === selectedFolder &&
    manifest.task.model === "gpt-5.5" &&
    manifest.task.reasoningEffort === "xhigh" &&
    manifest.task.speedMode === "default" &&
    !manifest.task.autoWorkspace &&
    second.task.workingDirectory === selectedFolder &&
    secondManifest.task.providerCwd === selectedFolder &&
    !secondManifest.task.autoWorkspace &&
    opened.task.id === second.task.id &&
    // project-less task: visible generated workspace, flagged autoWorkspace
    chatManifest.task.autoWorkspace === true &&
    chatCwdIsVisible &&
    chatCwdExists &&
    // D7 naming
    slugOk &&
    // records live in ~/.duet, keyed by taskId; chosen folder stays clean (D8)
    recordDirs.includes(created.task.id) &&
    recordDirs.includes(second.task.id) &&
    !selectedFolderHasDuet &&
    claudeSettingsAtRuntimeDir &&
    claudeHooksAtRuntimeDir &&
    // C4: delete spares the user's visible work
    chatRecordGoneAfterDelete &&
    chatWorkSurvivesDelete &&
    // report provenance unchanged
    report.runtime?.provider === "codex" &&
    report.runtime?.cwd === selectedFolder.replace(os.homedir(), "~") &&
    !rawTerminalPersisted;

  console.log(
    JSON.stringify(
      {
        dataRoot,
        workspacesDir,
        selectedFolder,
        codexTaskId: created.task.id,
        claudeTaskId: second.task.id,
        chatTaskId: chat.task.id,
        chatCwd,
        chatCwdName,
        chatCwdIsVisible,
        openedTaskId: opened.task.id,
        recordDirs,
        selectedFolderHasDuet,
        claudeSettingsAtRuntimeDir,
        claudeHooksAtRuntimeDir,
        chatRecordGoneAfterDelete,
        chatWorkSurvivesDelete,
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
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(workspacesDir, { recursive: true, force: true });
  fs.rmSync(selectedFolder, { recursive: true, force: true });
}

async function launchApp() {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      DUET_DATA_DIR: dataRoot,
      DUET_WORKSPACES_DIR: workspacesDir,
    },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(240000);
  return page;
}
