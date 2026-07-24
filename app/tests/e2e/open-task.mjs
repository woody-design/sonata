// Sidebar resume e2e: a session created in one app launch is listed in the
// sidebar after a relaunch, its transcript renders WITHOUT spawning a PTY,
// and the first new message lazily spawns a NATIVE RESUME — verified by the
// agent recalling a codeword planted before the restart.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { approveAnyVisibleApproval, approveIfVisible } from "./helpers/approval.mjs";
import { activeSessionTaskId, chooseDraftProvider, selectSidebarSession, sendFirstPrompt, sendPrompt } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-open-task-e2e-"));
// Isolate the projects/settings store too — NOT just SONATA_DATA_DIR. Without
// this the renderer boot preselects the global store's `lastUsedFolder` as the
// New Chat cwd (Settings persist in Electron userData, shared with the real
// app and across runs), so the provider launches in whatever folder was used
// last — e.g. this repo — and writes its artifacts THERE instead of the temp
// workspace this test polls. A hermetic settings dir keeps `lastUsedFolder`
// null, so the provider cwd falls back to the task's own storage root.
const settingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-open-task-settings-"));
// Failure forensics (report excerpt + screenshot) land here and SURVIVE the
// workspace cleanup so a flake is inspectable after the run.
const diagnosticsRoot = path.join(os.tmpdir(), "sonata-open-task-diagnostics");
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
  // Title premise (S6 rehab): the provider's statusline `session_name` takes
  // the task title (auto-naming since c0eea72 + claude default f6dd283), so
  // the exact text is model-generated and non-deterministic. The honest
  // assertions are structural: a non-empty title, the sidebar row addressed
  // by task id, and header/sidebar/manifest agreeing on the SAME title.

  await chooseDraftProvider(page, "codex");
  await sendFirstPrompt(page, originalPrompt);
  const taskDirectory = await waitForTaskDirectory(path.join(workspaceRoot, "data", "projects"), 45000);
  const recordDir = path.join(workspaceRoot, "data", "projects", taskDirectory);
  // Project-less sessions run in an unpredictable date-slug working directory,
  // not the record dir — read the real cwd from the manifest's providerCwd. The
  // agent writes its artifact files there.
  const workspace = await waitForProviderCwd(recordDir, 45000);
  // Drain whichever native approval Codex raises this turn — apply_patch
  // surfaces as a File-edit banner, a shell write as a Command banner, and the
  // model picks per run — until the turn reports completion. Answering a single
  // fixed-title banner once raced that choice and stalled the run whenever
  // Codex took the path the test wasn't waiting on.
  await settleTurnUntilCompleted(page, 1, 180000, { workspace, recordDir, label: "original-turn" });
  await expectArtifactItem(page, "open_original.md", 15000, { workspace, recordDir, label: "original-artifact" });
  await assertOnDisk(page, "open_original.md", { workspace, recordDir, label: "original-on-disk" });
  await page.locator("#task-title").waitFor({ state: "visible" });
  const taskId = await activeSessionTaskId(page);
  await page
    .locator(`.sidebar-session[data-task-id="${taskId}"] .sidebar-session-title`)
    .waitFor({ state: "visible" });
  const manifestPath = path.join(recordDir, "task.json");
  const reportPath = path.join(recordDir, "runtime-report.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("Task manifest was not persisted.");
  }

  await electronApp.close();
  electronApp = null;

  page = await launchApp("reopen");

  // The relaunched sidebar lists the session from disk (addressed by id —
  // the title text is the model-generated session_name).
  await page
    .locator(`.sidebar-session[data-task-id="${taskId}"] .sidebar-session-title`)
    .waitFor({ state: "visible" });
  const sidebarTitle = (
    await page
      .locator(`.sidebar-session[data-task-id="${taskId}"] .sidebar-session-title`)
      .textContent()
  )?.trim();

  // Clicking renders the transcript read-only — no PTY yet.
  await selectSidebarSession(page, taskId);
  await page.locator("#task-title").waitFor({ state: "visible" });
  const headerTitle = (await page.locator("#task-title").textContent())?.trim();
  if (!headerTitle || headerTitle !== sidebarTitle) {
    throw new Error(
      `Header/sidebar title mismatch after reopen: header=${JSON.stringify(headerTitle)} sidebar=${JSON.stringify(sidebarTitle)}`,
    );
  }
  await page.locator('.turn-card[data-run-status="completed"]').waitFor({
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
  await settleTurnUntilCompleted(page, 2, 240000, { workspace, recordDir, label: "followup-turn" });
  await expectArtifactItem(page, "open_followup.md", 15000, { workspace, recordDir, label: "followup-artifact" });
  await assertOnDisk(page, "open_followup.md", { workspace, recordDir, label: "followup-on-disk" });

  // Memory continuity: the resumed agent recalled the planted codeword.
  const followupContent = fs.readFileSync(path.join(workspace, "open_followup.md"), "utf8");
  const codewordRecalled = followupContent.includes(CODEWORD);

  // Re-read the header at the end: the provider may re-name the session on a
  // later statusline tick, and the manifest tracks that (auto-title follows).
  const finalHeaderTitle = (await page.locator("#task-title").textContent())?.trim();
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
    manifest.schemaId === "sonata.task-manifest.v1" &&
    manifest.task.id === report.taskId &&
    manifest.task.id === taskId &&
    typeof manifest.task.title === "string" &&
    manifest.task.title.trim().length > 0 &&
    manifest.task.title.trim() === finalHeaderTitle &&
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
        SONATA_DATA_DIR: workspaceRoot, SONATA_WORKSPACES_DIR: workspaceRoot,
        SONATA_SETTINGS_DIR: settingsRoot,
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
    const completed = await page.locator('.turn-card[data-run-status="completed"]').count();
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

// The artifact strip is gone (2026-07-03) — the durable runtime report is the
// artifact-candidate surface now.
async function expectArtifactItem(page, name, timeoutMs, diag) {
  const reportPath = path.join(diag.recordDir, "runtime-report.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      if (report?.runs?.some((run) => run.artifactCandidates?.some((a) => a.path === name))) {
        return;
      }
    } catch {
      // report not written yet — keep polling
    }
    await delay(250);
  }
  throw await diagnosticError(
    page,
    `Artifact "${name}" never surfaced in the runtime report [${diag.label}]`,
    diag,
  );
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
    `${message}. strip=${diagnostics.strip} status=${diagnostics.status} ` +
      `approval=${diagnostics.approvalTitle ?? "none"} runs=${JSON.stringify(diagnostics.runs)} ` +
      `screenshot=${diagnostics.screenshotPath ?? "n/a"}`,
  );
}

async function captureDiagnostics(page, { recordDir, label }) {
  const strip = await safeText(page.locator("#status-strip"));
  const status = await safeText(page.locator("#runtime-status"));
  const approvalVisible = await page
    .locator("#approval-banner:not(.hidden)")
    .isVisible({ timeout: 500 })
    .catch(() => false);
  const approvalTitle = approvalVisible ? await safeText(page.locator("#approval-title")) : null;

  let runs = null;
  try {
    const report = JSON.parse(
      fs.readFileSync(path.join(recordDir, "runtime-report.json"), "utf8"),
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

  return { label, strip, status, approvalVisible, approvalTitle, runs, screenshotPath };
}

async function waitForResumeSpawn(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const working = await page
      .locator('.sidebar-session-spinner, .turn-card[data-run-status]')
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

async function waitForProviderCwd(recordDir, timeoutMs) {
  const manifestPath = path.join(recordDir, "task.json");
  let providerCwd = null;
  await waitUntil(() => {
    if (!fs.existsSync(manifestPath)) {
      return false;
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    providerCwd = manifest.task?.providerCwd ?? null;
    return Boolean(providerCwd);
  }, timeoutMs, "provider cwd");
  return providerCwd;
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
