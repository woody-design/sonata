import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { approveAnyVisibleApproval, approveIfVisible } from "./helpers/approval.mjs";
import { sendFirstPrompt, waitForEngagement } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-stop-e2e-"));
let electronApp = null;
let page = null;
let taskDirectory = null;
let workspace = null;
let recordDir = null;

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      DUET_DATA_DIR: workspaceRoot, DUET_WORKSPACES_DIR: workspaceRoot,
    },
  });

  page = await electronApp.firstWindow();
  page.setDefaultTimeout(240000);

  const commandText = [
    "python3 -c \"from pathlib import Path; import os, time;",
    "Path('stop_start.flag').write_text('start');",
    "Path('stop_pid.flag').write_text(str(os.getpid()));",
    "time.sleep(120);",
    "Path('stop_end.flag').write_text('end')\"",
  ].join(" ");
  const longCommand = [
    "Run exactly this shell command and no other commands.",
    "Do not use apply_patch.",
    "Do not edit files directly.",
    // Premise pin: the sleep must HOLD THE TURN OPEN so the test can Esc a
    // live command — newer claude sometimes backgrounds long sleeps
    // (run_in_background), completing the turn in seconds and leaving
    // nothing to stop (flake observed 2026-07-03).
    "Run it in the foreground and wait for it to finish — do NOT run it in the background.",
    `Command: ${commandText}`,
  ].join(" ");

  // The first prompt creates the session (deferred creation) and answers the
  // workspace-trust approval that surfaces during the provider cold start.
  await sendFirstPrompt(page, longCommand);
  taskDirectory = await waitForTaskDirectory(path.join(workspaceRoot, "data", "projects"), 45000);
  recordDir = path.join(workspaceRoot, "data", "projects", taskDirectory);
  // Project-less sessions run in an unpredictable date-slug working directory,
  // not the record dir — read the real cwd from the manifest's providerCwd. The
  // agent writes its flag/recovery files there.
  workspace = await waitForProviderCwd(recordDir, 45000);
  const paths = {
    start: path.join(workspace, "stop_start.flag"),
    pid: path.join(workspace, "stop_pid.flag"),
    end: path.join(workspace, "stop_end.flag"),
    recovery: path.join(workspace, "stop_recovery.md"),
  };
  const commandApprovalSeen = await approveIfVisible(page, "Command approval requested", 180000);
  await waitForEngagement(page);

  await waitUntil(() => fs.existsSync(paths.start), 180000, "long command start file");
  await waitUntil(() => fs.existsSync(paths.pid), 15000, "long command pid file");
  const commandPid = readPid(paths.pid);
  const commandAliveBeforeStop = pidAlive(commandPid);

  await page.locator("#send-prompt").click();
  // Stopped + ready to continue: the send button leaves stop-mode (■ → ↑).
  await page.locator("#send-prompt:not(.stop-mode)").waitFor({ state: "attached", timeout: 90000 });
  await page.locator("#send-prompt").waitFor({ state: "visible" });
  // The stopped state survives the footer retirement as the outcome note;
  // completion provenance moved to the card's data attributes (the report
  // checks below assert native-control/high durably).
  await page.locator(".turn-outcome-note", { hasText: "Stopped by Esc" }).waitFor({
    state: "visible",
  });
  await page
    .locator('.turn-card[data-run-status="stopped"][data-completion-source="native-control"]')
    .waitFor({ state: "attached" });
  await page.locator(".turn-card", { hasText: "Run exactly this shell command" }).waitFor({
    state: "visible",
  });

  const commandStopped = await waitUntil(() => !pidAlive(commandPid), 45000).then(
    () => true,
    () => false,
  );
  const endFileSeen = fs.existsSync(paths.end);

  // Stop S2: the stopped prompt is handed back into the composer for editing
  // (no select-all; an occupied composer would win — here it was empty). The
  // recovery `.fill()` below replaces it, which doubles as the "user edits
  // and resends" step of the field flow.
  const composerAfterStop = await page.locator("#prompt-input").inputValue();
  const composerRefilledWithStoppedPrompt = composerAfterStop.includes(
    "Run exactly this shell command",
  );

  const recoveryPrompt = [
    "Create a Markdown file named stop_recovery.md with exactly this content:",
    "# Stop Recovery",
    "The same Codex session continued after Stop.",
    "Do not modify any other files.",
  ].join("\n");

  await page.locator("#prompt-input").fill(recoveryPrompt);
  await page.locator("#send-prompt").click();
  let recoveryApprovalSeen = false;
  await waitUntil(async () => {
    recoveryApprovalSeen =
      (await approveAnyVisibleApproval(page)) ||
      recoveryApprovalSeen;
    return fs.existsSync(paths.recovery);
  }, 180000, "recovery file");
  // The strip-entered Preview review of the recovery artifact retired with
  // the artifact strip (2026-07-03) — the durable report carries the
  // recovery-run evidence. Poll it explicitly: the report write trails the
  // recovery file's appearance on disk.
  const reportPath = path.join(recordDir, "runtime-report.json");
  await waitUntil(() => {
    try {
      const snapshot = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      return snapshot?.runs?.some((run) =>
        run.artifactCandidates?.some((artifact) => artifact.path === "stop_recovery.md"),
      );
    } catch {
      return false;
    }
  }, 60000, "recovery run in report");
  const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : null;
  const runs = report?.runs ?? [];
  const stoppedRun = runs.find((run) => run.status === "stopped") ?? null;
  const recoveryRun = runs.find((run) =>
    run.artifactCandidates?.some((artifact) => artifact.path === "stop_recovery.md"),
  ) ?? null;
  const reportText = report ? JSON.stringify(report) : "";
  const rawTerminalPersisted =
    reportText.includes("pty:data") ||
    reportText.includes("OpenAI Codex") ||
    reportText.includes("Do you trust the contents of this directory");

  const success =
    Boolean(report) &&
    commandAliveBeforeStop &&
    commandStopped &&
    !endFileSeen &&
    composerRefilledWithStoppedPrompt &&
    stoppedRun?.completionSource === "native-control" &&
    stoppedRun?.completionConfidence === "high" &&
    stoppedRun?.stopEvents?.some((event) => event.action === "stopped") &&
    Boolean(recoveryRun) &&
    fs.readFileSync(paths.recovery, "utf8").includes("same Codex session continued") &&
    !rawTerminalPersisted;

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        taskDirectory,
        reportPath,
        commandApprovalSeen,
        recoveryApprovalSeen,
        commandPid,
        commandAliveBeforeStop,
        commandStopped,
        endFileSeen,
        composerRefilledWithStoppedPrompt,
        stoppedRunStatus: stoppedRun?.status,
        stoppedCompletionSource: stoppedRun?.completionSource,
        stoppedCompletionConfidence: stoppedRun?.completionConfidence,
        stopEvents: stoppedRun?.stopEvents ?? [],
        recoveryCreated: fs.existsSync(paths.recovery),
        runCount: runs.length,
        rawTerminalPersisted,
        success,
      },
      null,
      2,
    ),
  );

  process.exitCode = success ? 0 : 1;
} catch (error) {
  console.error(
    JSON.stringify(
      await collectDiagnostics({
        page,
        workspaceRoot,
        taskDirectory,
        workspace,
        recordDir,
        error,
      }),
      null,
      2,
    ),
  );
  throw error;
} finally {
  if (electronApp) {
    await electronApp.close();
  }
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
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
  }, timeoutMs);
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
  }, timeoutMs);
  return providerCwd;
}

function readPid(filePath) {
  const value = Number.parseInt(fs.readFileSync(filePath, "utf8").trim(), 10);
  return Number.isFinite(value) ? value : null;
}

function pidAlive(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

async function waitUntil(predicate, timeoutMs, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectDiagnostics({ page, workspaceRoot, taskDirectory, workspace, recordDir, error }) {
  const reportPath = recordDir ? path.join(recordDir, "runtime-report.json") : null;
  const report = reportPath && fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : null;
  return {
    error: error instanceof Error ? error.message : String(error),
    workspaceRoot,
    taskDirectory,
    reportPath,
    runtimeStatus: page ? await safeText(page.locator("#runtime-status")) : null,
    approvalTitle: page ? await safeText(page.locator("#approval-title")) : null,
    approvalVisible: page
      ? await page
          .locator("#approval-banner")
          .evaluate((node) => !node.classList.contains("hidden"))
          .catch(() => null)
      : null,
    runListText: page ? redact(await safeText(page.locator("#run-list"))) : null,
    terminalTextTail: page ? redact(await safeText(page.locator("#terminal")))?.slice(-2200) : null,
    workspaceEntries: workspace && fs.existsSync(workspace) ? fs.readdirSync(workspace).sort() : [],
    reportRunCount: report?.runs?.length ?? 0,
    latestRun: report?.runs?.at(-1) ?? null,
  };
}

async function safeText(locator) {
  try {
    return await locator.textContent({ timeout: 1000 });
  } catch {
    return null;
  }
}

function redact(value) {
  if (!value) {
    return value;
  }
  return value
    .replaceAll(os.homedir(), "~")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email redacted]")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      "[session id redacted]",
    );
}
