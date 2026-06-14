// Sidebar resume e2e: a session created in one app launch is listed in the
// sidebar after a relaunch, its transcript renders WITHOUT spawning a PTY,
// and the first new message lazily spawns a NATIVE RESUME — verified by the
// agent recalling a codeword planted before the restart.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { approveAnyVisibleApproval, approveIfVisible } from "./helpers/approval.mjs";
import { activeSessionTaskId, selectSidebarSession, sendFirstPrompt, sendPrompt } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-open-task-e2e-"));
// Isolate the projects/settings store too — NOT just DUET_PROJECTS_DIR. Without
// this the renderer boot preselects the global store's `lastUsedFolder` as the
// New Chat cwd (Settings persist in Electron userData, shared with the real
// app and across runs), so the provider launches in whatever folder was used
// last — e.g. this repo — and writes its artifacts THERE instead of the temp
// workspace this test polls. A hermetic settings dir keeps `lastUsedFolder`
// null, so the provider cwd falls back to the task's own storage root.
const settingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-open-task-settings-"));
// Failure forensics (report excerpt + screenshot) land here and SURVIVE the
// workspace cleanup so a flake is inspectable after the run.
const diagnosticsRoot = path.join(os.tmpdir(), "duet-open-task-diagnostics");
const COMPLETED_OUTCOME = "Completed by terminal idle heuristic";
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
  // Drain whichever native approval Codex raises this turn — apply_patch
  // surfaces as a File-edit banner, a shell write as a Command banner, and the
  // model picks per run — until the turn reports completion. Answering a single
  // fixed-title banner once raced that choice and stalled the run whenever
  // Codex took the path the test wasn't waiting on.
  await settleTurnUntilCompleted(page, 1, 180000, { workspace, label: "original-turn" });
  await expectArtifactItem(page, "open_original.md", 15000, { workspace, label: "original-artifact" });
  await assertOnDisk(page, "open_original.md", { workspace, label: "original-on-disk" });
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
  await page.locator(".turn-outcome", { hasText: COMPLETED_OUTCOME }).waitFor({
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
  // Second turn, same title-agnostic drain. The reopened transcript already
  // shows the restored first turn's completion, so we wait for the SECOND
  // completed outcome (restored + followup).
  await settleTurnUntilCompleted(page, 2, 240000, { workspace, label: "followup-turn" });
  await expectArtifactItem(page, "open_followup.md", 15000, { workspace, label: "followup-artifact" });
  await assertOnDisk(page, "open_followup.md", { workspace, label: "followup-on-disk" });

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
  fs.rmSync(settingsRoot, { recursive: true, force: true });
}

async function launchApp(label) {
  try {
    electronApp = await electron.launch({
      args: ["dist/main/main.js"],
      env: {
        ...process.env,
        DUET_PROJECTS_DIR: workspaceRoot,
        DUET_SETTINGS_DIR: settingsRoot,
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

/**
 * Approve any native approval as it appears and return once the requested
 * number of turns report completion. This replaces a single approve-once +
 * blind `fs.existsSync` wait, which stalled whenever Codex raised an approval
 * the test wasn't watching for — the dominant first-turn flake.
 */
async function settleTurnUntilCompleted(page, targetCompleted, deadlineMs, diag) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    await approveAnyVisibleApproval(page);
    const completed = await page.locator(".turn-outcome", { hasText: COMPLETED_OUTCOME }).count();
    if (completed >= targetCompleted) {
      return;
    }
    await delay(500);
  }
  throw await diagnosticError(
    page,
    `Timed out waiting for ${targetCompleted} completed turn(s) [${diag.label}]`,
    diag,
  );
}

async function expectArtifactItem(page, name, timeoutMs, diag) {
  try {
    await page.locator(".artifact-item", { hasText: name }).waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    throw await diagnosticError(page, `Artifact "${name}" never surfaced in the inspector [${diag.label}]`, diag);
  }
}

async function assertOnDisk(page, name, diag) {
  if (fs.existsSync(path.join(diag.workspace, name))) {
    return;
  }
  throw await diagnosticError(
    page,
    `Turn completed but ${name} is absent from the task workspace [${diag.label}]`,
    diag,
  );
}

/**
 * Build an Error carrying enough state to tell the failure modes apart at a
 * glance: an unanswered approval (banner still visible), the provider-cwd leak
 * (artifacts recorded as repo-relative paths), or genuine non-compliance (turn
 * completed, no matching artifact). Full detail goes to stderr + a screenshot.
 */
async function diagnosticError(page, message, diag) {
  const diagnostics = await captureDiagnostics(page, diag);
  console.error(JSON.stringify({ diagnostic: message, ...diagnostics }, null, 2));
  return new Error(
    `${message}. headline=${diagnostics.headline} status=${diagnostics.status} ` +
      `approval=${diagnostics.approvalTitle ?? "none"} runs=${JSON.stringify(diagnostics.runs)} ` +
      `screenshot=${diagnostics.screenshotPath ?? "n/a"}`,
  );
}

async function captureDiagnostics(page, { workspace, label }) {
  const headline = await safeText(page.locator("#workflow-headline"));
  const status = await safeText(page.locator("#runtime-status"));
  const approvalVisible = await page
    .locator("#approval-banner:not(.hidden)")
    .isVisible({ timeout: 500 })
    .catch(() => false);
  const approvalTitle = approvalVisible ? await safeText(page.locator("#approval-title")) : null;

  let runs = null;
  try {
    const report = JSON.parse(
      fs.readFileSync(path.join(workspace, ".duet", "runtime-report.json"), "utf8"),
    );
    runs = report.runs.map((run) => ({
      kind: run.kind,
      status: run.status,
      approvalKind: run.approvalKind ?? null,
      approvals: (run.approvalEvents ?? []).map(
        (event) => `${event.action}:${event.kind ?? ""}${event.decision ? `=${event.decision}` : ""}`,
      ),
      // A wrong provider cwd shows up here as repo-relative paths
      // (e.g. "app/dist/...") instead of the bare filename the prompt asked for.
      changedFiles: (run.changedFiles ?? []).map((change) => change.path).slice(0, 12),
      artifactCandidates: (run.artifactCandidates ?? []).map((artifact) => artifact.path),
    }));
  } catch (error) {
    runs = { reportError: error instanceof Error ? error.message : String(error) };
  }

  let screenshotPath = null;
  try {
    fs.mkdirSync(diagnosticsRoot, { recursive: true });
    screenshotPath = path.join(diagnosticsRoot, `${label}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
  } catch {
    screenshotPath = null;
  }

  return { label, headline, status, approvalVisible, approvalTitle, runs, screenshotPath };
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

async function safeText(locator) {
  try {
    return (await locator.textContent({ timeout: 1000 })) ?? "";
  } catch {
    return "";
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
