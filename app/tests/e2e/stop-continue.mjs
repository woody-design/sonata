import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-stop-e2e-"));
let electronApp = null;
let page = null;
let taskDirectory = null;
let workspace = null;

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      DUET_PROJECTS_DIR: workspaceRoot,
    },
  });

  page = await electronApp.firstWindow();
  page.setDefaultTimeout(240000);

  await page.locator("#new-task").click();
  taskDirectory = await waitForTaskDirectory(workspaceRoot, 45000);
  workspace = path.join(workspaceRoot, taskDirectory);
  await waitForRuntimeReady(page, 240000);

  const paths = {
    start: path.join(workspace, "stop_start.flag"),
    pid: path.join(workspace, "stop_pid.flag"),
    end: path.join(workspace, "stop_end.flag"),
    recovery: path.join(workspace, "stop_recovery.md"),
  };

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
    `Command: ${commandText}`,
  ].join(" ");

  await page.locator("#prompt-input").fill(longCommand);
  await page.locator("#send-prompt").click();
  const commandApprovalSeen = await approveIfVisible(page, "Command approval requested", 180000);

  await waitUntil(() => fs.existsSync(paths.start), 180000, "long command start file");
  await waitUntil(() => fs.existsSync(paths.pid), 15000, "long command pid file");
  const commandPid = readPid(paths.pid);
  const commandAliveBeforeStop = pidAlive(commandPid);

  await page.locator("#stop-run").click();
  await page.locator("#runtime-status", { hasText: "Stopped" }).waitFor({ timeout: 90000 });

  const commandStopped = await waitUntil(() => !pidAlive(commandPid), 45000).then(
    () => true,
    () => false,
  );
  const endFileSeen = fs.existsSync(paths.end);

  const recoveryPrompt = [
    "Create a Markdown file named stop_recovery.md with exactly this content:",
    "# Stop Recovery",
    "The same Codex session continued after Stop.",
    "Do not modify any other files.",
  ].join("\n");

  await page.locator("#prompt-input").fill(recoveryPrompt);
  await page.locator("#send-prompt").click();
  const recoveryApprovalSeen = await approveIfVisible(page, "File edit approval requested", 180000);

  await waitUntil(() => fs.existsSync(paths.recovery), 180000, "recovery file");
  await page.locator(".artifact-item", { hasText: "stop_recovery.md" }).waitFor({
    state: "visible",
  });

  const reportPath = path.join(workspace, ".duet", "runtime-report.json");
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

async function approveIfVisible(page, title, timeoutMs) {
  const banner = page.locator("#approval-banner", { hasText: title });
  try {
    await banner.waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    return false;
  }

  await page.locator("#approve-approval").click();
  await banner.waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
  return true;
}

async function waitForRuntimeReady(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await page
      .locator("#runtime-status", { hasText: "Ready" })
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
    const entries = fs.readdirSync(root, { withFileTypes: true });
    found = entries.find((entry) => entry.isDirectory())?.name ?? null;
    return Boolean(found);
  }, timeoutMs);
  return found;
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

async function collectDiagnostics({ page, workspaceRoot, taskDirectory, workspace, error }) {
  const reportPath = workspace ? path.join(workspace, ".duet", "runtime-report.json") : null;
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
