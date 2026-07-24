// G1b — the authoritative in-app confirmation for D8: Claude's hooks/usage/settings
// live OUTSIDE the agent cwd (~/.sonata/data/runtime/<taskId>), and the live app still
// detects turn-end from them. A real Claude turn (driven through the normal composer
// send path) whose run completes with completionSource "hook-stop" proves the whole
// chain: Claude fires the Stop hook from a --settings file outside its cwd → into the
// external hooks dir → the watcher (pointed at that dir) reads it → routing (by runtime
// dir) matches it → the run completes. (terminal-idle scrape is the FALLBACK; "hook-stop"
// specifically means the hook drove it.) Also asserts the user's repo stays clean.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { chooseDraftProvider, sendFirstPrompt } from "./helpers/session.mjs";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-g1b-data-"));
const workspacesDir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-g1b-workspaces-"));
const selectedFolder = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-g1b-folder-"));
let electronApp = null;

try {
  const page = await launchApp();
  await page.locator(".task-entry-panel", { hasText: "What should we work on" }).waitFor({
    state: "visible",
  });
  await chooseDraftProvider(page, "claude");

  // Auto-approve any approval (a fresh folder triggers a workspace-trust prompt; the
  // Stop hook deliberately won't complete a run while one is pending). This is what the
  // user does by clicking approve — it does not weaken the hook test.
  await page.evaluate(() => {
    window.sonataRuntime.onRuntimeEvent((event) => {
      if (event.type === "approval:detected") {
        void window.sonataRuntime.decideApproval({
          taskId: event.payload.taskId,
          decision: "approve-always",
        });
      }
    });
  });

  // Normal new-chat path: pick the folder through the project chip's menu,
  // then send the first message through the explicitly selected Claude provider. The
  // composer send path is what actually starts a run.
  await page.locator("#project-chip").click();
  await page.locator("#entry-choose-folder").click();
  await page.locator("#project-chip", { hasText: path.basename(selectedFolder) }).waitFor({
    state: "visible",
  });
  await sendFirstPrompt(page, "Reply with exactly: G1B_OK", { provider: "claude" });

  await page.locator('.turn-card[data-run-status="completed"]').waitFor({ state: "visible" });

  // Read the completed run's provenance from the report (records live in ~/.sonata).
  const projectsDir = path.join(dataRoot, "data", "projects");
  const taskId = fs
    .readdirSync(projectsDir)
    .find((name) => fs.existsSync(path.join(projectsDir, name, "runtime-report.json")));
  const report = JSON.parse(
    fs.readFileSync(path.join(projectsDir, taskId, "runtime-report.json"), "utf8"),
  );
  const completedRun = report.runs.find((run) => run.status === "completed");
  const runtimeDir = path.join(dataRoot, "data", "runtime", taskId);

  const result = {
    taskId,
    completionSource: completedRun?.completionSource ?? null,
    completionConfidence: completedRun?.completionConfidence ?? null,
    runCount: report.runs.length,
    selectedFolderHasSonata: fs.existsSync(path.join(selectedFolder, ".sonata")),
    settingsAtRuntimeDir: fs.existsSync(path.join(runtimeDir, "claude-runtime-settings.json")),
    hooksDirAtRuntimeDir: fs.existsSync(path.join(runtimeDir, "hooks")),
    usageDirAtRuntimeDir: fs.existsSync(path.join(runtimeDir, "usage")),
  };

  const success =
    completedRun?.completionSource === "hook-stop" &&
    !result.selectedFolderHasSonata &&
    result.settingsAtRuntimeDir &&
    result.hooksDirAtRuntimeDir;

  console.log(JSON.stringify({ ...result, success }, null, 2));
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
      SONATA_DATA_DIR: dataRoot,
      SONATA_WORKSPACES_DIR: workspacesDir,
      SONATA_TEST_PICK_FOLDER: selectedFolder,
    },
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(240000);
  return page;
}
