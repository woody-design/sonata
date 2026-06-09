import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-task-folder-root-"));
const selectedFolder = fs.mkdtempSync(path.join(os.tmpdir(), "duet-selected-task-folder-"));
let electronApp = null;

try {
  const page = await launchApp();
  await page.locator(".task-entry-panel", { hasText: "Start a Task" }).waitFor({
    state: "visible",
  });

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

  let duplicateBlocked = false;
  try {
    await page.evaluate(async (cwd) => {
      return window.duetRuntime.createTask({
        provider: "claude",
        cwd,
        model: "opus",
        reasoningEffort: "xhigh",
        approval: "on-request",
        sandbox: "read-only",
      });
    }, selectedFolder);
  } catch {
    duplicateBlocked = true;
  }

  const manifestPath = path.join(selectedFolder, ".duet", "task.json");
  const reportPath = path.join(selectedFolder, ".duet", "runtime-report.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const defaultRootEntries = fs.existsSync(workspaceRoot)
    ? fs.readdirSync(workspaceRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    : [];
  const reportText = JSON.stringify(report);
  const rawTerminalPersisted =
    reportText.includes("pty:data") ||
    reportText.includes("OpenAI Codex") ||
    reportText.includes("Do you trust the contents of this directory");

  const success =
    created.task.workingDirectory === selectedFolder &&
    created.runtime.cwd === selectedFolder &&
    manifest.task.id === created.task.id &&
    manifest.task.provider === "codex" &&
    manifest.task.workingDirectory === selectedFolder &&
    manifest.task.model === "gpt-5.5" &&
    manifest.task.reasoningEffort === "xhigh" &&
    manifest.task.speedMode === "default" &&
    report.runtime?.provider === "codex" &&
    report.runtime?.cwd === selectedFolder.replace(os.homedir(), "~") &&
    duplicateBlocked &&
    defaultRootEntries.length === 0 &&
    !rawTerminalPersisted;

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        selectedFolder,
        taskId: manifest.task.id,
        provider: manifest.task.provider,
        model: manifest.task.model,
        reasoningEffort: manifest.task.reasoningEffort,
        speedMode: manifest.task.speedMode,
        duplicateBlocked,
        defaultRootEntries: defaultRootEntries.map((entry) => entry.name),
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
  fs.rmSync(selectedFolder, { recursive: true, force: true });
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
