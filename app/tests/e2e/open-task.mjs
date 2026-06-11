// Sidebar resume e2e: a session created in one app launch is listed in the
// sidebar after a relaunch, its transcript renders WITHOUT spawning a PTY,
// and the first new message lazily spawns a NATIVE RESUME — verified by the
// agent recalling a codeword planted before the restart.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { approveIfVisible } from "./helpers/approval.mjs";
import { activeSessionTaskId, selectSidebarSession, sendFirstPrompt, sendPrompt } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-open-task-e2e-"));
const CODEWORD = "OPENTASK-99";
let electronApp = null;

try {
  let page = await launchApp("initial");

  const originalPrompt = [
    "Create a Markdown file named open_original.md with exactly this content:",
    "# Open Task Original",
    "This artifact existed before reopening the session.",
    `Also remember this codeword for later: ${CODEWORD}.`,
    "Do not modify any other files.",
  ].join("\n");
  const expectedTaskTitle = originalPrompt.split("\n", 1)[0];

  await sendFirstPrompt(page, originalPrompt);
  const taskDirectory = await waitForTaskDirectory(workspaceRoot, 45000);
  const workspace = path.join(workspaceRoot, taskDirectory);
  await approveIfVisible(page, "File edit approval requested", 180000);
  await waitUntil(() => fs.existsSync(path.join(workspace, "open_original.md")), 180000, "original artifact");
  await page.locator(".artifact-item", { hasText: "open_original.md" }).waitFor({ state: "visible" });
  await page.locator(".turn-outcome", { hasText: "Completed by terminal idle heuristic" }).waitFor({
    state: "visible",
  });
  await page.locator("#task-title", { hasText: expectedTaskTitle }).waitFor({ state: "visible" });
  await page
    .locator(".sidebar-session-title", { hasText: expectedTaskTitle })
    .waitFor({ state: "visible" });

  const taskId = await activeSessionTaskId(page);
  const manifestPath = path.join(workspace, ".duet", "task.json");
  const reportPath = path.join(workspace, ".duet", "runtime-report.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("Task manifest was not persisted.");
  }

  await electronApp.close();
  electronApp = null;

  page = await launchApp("reopen");

  // The relaunched sidebar lists the session from disk.
  await page
    .locator(".sidebar-session-title", { hasText: expectedTaskTitle })
    .waitFor({ state: "visible" });

  // Clicking renders the transcript read-only — no PTY yet.
  await selectSidebarSession(page, taskId);
  await page.locator("#task-title", { hasText: expectedTaskTitle }).waitFor({ state: "visible" });
  await page.locator(".turn-outcome", { hasText: "Completed by terminal idle heuristic" }).waitFor({
    state: "visible",
  });
  const dormantPlaceholder = await page.locator("#prompt-input").getAttribute("placeholder");
  if (!dormantPlaceholder?.includes("resumes this session")) {
    throw new Error(`Dormant composer placeholder unexpected: ${dormantPlaceholder}`);
  }

  // First new message lazily spawns a native resume.
  const followupPrompt = [
    `Reply with the codeword I asked you to remember, then create a Markdown`,
    `file named open_followup.md containing exactly that codeword.`,
    "Do not modify any other files.",
  ].join("\n");
  await sendPrompt(page, followupPrompt);
  await waitForResumeSpawn(page, 240000);
  await approveIfVisible(page, "File edit approval requested", 240000);
  await waitUntil(() => fs.existsSync(path.join(workspace, "open_followup.md")), 240000, "followup artifact");
  await page.locator(".artifact-item", { hasText: "open_followup.md" }).waitFor({ state: "visible" });

  // Memory continuity: the resumed agent recalled the planted codeword.
  const followupContent = fs.readFileSync(path.join(workspace, "open_followup.md"), "utf8");
  const codewordRecalled = followupContent.includes(CODEWORD);

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
    manifest.task.id === taskId &&
    manifest.task.title === expectedTaskTitle &&
    Boolean(originalRun) &&
    Boolean(followupRun) &&
    codewordRecalled &&
    report.runs.length >= 2 &&
    !rawTerminalPersisted;

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        taskDirectory,
        taskId,
        manifestTaskTitle: manifest.task.title,
        runCount: report.runs.length,
        originalRestored: Boolean(originalRun),
        followupCreated: Boolean(followupRun),
        codewordRecalled,
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

async function waitForResumeSpawn(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const working = await page
      .locator(".sidebar-session-spinner, .turn-outcome")
      .first()
      .isVisible({ timeout: 500 })
      .catch(() => false);
    if (working) {
      return;
    }
    await approveIfVisible(page, "Workspace trust requested", 500);
    await delay(250);
  }
  throw new Error("Timed out waiting for the resumed session to spawn.");
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
