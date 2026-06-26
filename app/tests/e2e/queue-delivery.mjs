import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { approveIfVisible } from "./helpers/approval.mjs";
import { sendFirstPrompt } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-queue-delivery-e2e-"));
// Without an isolated settings dir, the global lastUsedFolder leaks in as the
// provider cwd, so the command's flag files land outside workspaceRoot and the
// test times out waiting for "first command start" (see memory: duet-e2e-test
// -isolation). Isolate settings too.
const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-queue-delivery-settings-"));
let electronApp = null;
let page = null;
let workspace = null;
let recordDir = null;
let taskDirectory = null;

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      DUET_DATA_DIR: workspaceRoot, DUET_WORKSPACES_DIR: workspaceRoot,
      DUET_SETTINGS_DIR: settingsDir,
    },
  });

  page = await electronApp.firstWindow();
  page.setDefaultTimeout(240000);

  const firstCommand = [
    "python3 -c \"from pathlib import Path; import time;",
    "Path('queue_first_start.flag').write_text('start');",
    "time.sleep(8);",
    "Path('queue_first_done.flag').write_text('done')\"",
  ].join(" ");
  const firstPrompt = [
    "Run exactly this shell command and no other commands.",
    "Do not use apply_patch.",
    "Do not edit files directly.",
    `Command: ${firstCommand}`,
  ].join(" ");
  const secondPrompt = [
    "Create a Markdown file named queue_second.md with exactly this content:",
    "# Queue Delivery",
    "This message was delivered after the earlier run finished.",
    "Do not modify any other files.",
  ].join("\n");

  // The first prompt creates the session (deferred creation) and answers the
  // workspace-trust approval that surfaces during the provider cold start.
  await sendFirstPrompt(page, firstPrompt);
  taskDirectory = await waitForTaskDirectory(path.join(workspaceRoot, "data", "projects"), 45000);
  recordDir = path.join(workspaceRoot, "data", "projects", taskDirectory);
  // Project-less sessions run in an unpredictable date-slug working directory,
  // not the record dir — read the real cwd from the manifest's providerCwd. The
  // agent writes its flag/artifact files there.
  workspace = await waitForProviderCwd(recordDir, 45000);
  const paths = {
    firstStart: path.join(workspace, "queue_first_start.flag"),
    firstDone: path.join(workspace, "queue_first_done.flag"),
    second: path.join(workspace, "queue_second.md"),
  };
  await approveIfVisible(page, "Command approval requested", 180000);
  await waitUntil(() => fs.existsSync(paths.firstStart), 180000, "first command start");
  await page.locator("#workflow-headline", { hasText: /Codex is working|Delivering to Codex/ }).waitFor({
    state: "visible",
  });

  await page.locator("#prompt-input").fill(secondPrompt);
  await page.locator("#prompt-input").press("Enter");
  await page.locator(".delivery-item.queued", { hasText: "Queued" }).waitFor({ state: "visible" });
  await page.locator(".delivery-item.queued", { hasText: "queue_second.md" }).waitFor({
    state: "visible",
  });

  await waitUntil(() => fs.existsSync(paths.firstDone), 180000, "first command done");
  await waitUntil(async () => {
    await approveIfVisible(page, "Command approval requested", 1000);
    await approveIfVisible(page, "File edit approval requested", 1000);
    return fs.existsSync(paths.second);
  }, 180000, "queued prompt artifact");
  await page.locator(".delivery-item.undelivered").waitFor({ state: "hidden", timeout: 30000 });
  await page.locator(".delivery-item", { hasText: "queue_second.md" }).waitFor({
    state: "hidden",
    timeout: 30000,
  });
  await page.locator(".turn-card", { hasText: "queue_second.md" }).waitFor({ state: "visible" });

  const reportPath = path.join(recordDir, "runtime-report.json");
  const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : null;
  const runs = report?.runs ?? [];
  const firstRunIndex = runs.findIndex((run) => run.prompt.includes("queue_first_start.flag"));
  const secondRunIndex = runs.findIndex((run) => run.prompt.includes("queue_second.md"));
  const secondRun = secondRunIndex >= 0 ? runs[secondRunIndex] : null;
  const reportText = report ? JSON.stringify(report) : "";
  const rawTerminalPersisted =
    reportText.includes("pty:data") ||
    reportText.includes("OpenAI Codex") ||
    reportText.includes("Do you trust the contents of this directory");
  const success =
    Boolean(report) &&
    firstRunIndex >= 0 &&
    secondRunIndex > firstRunIndex &&
    Boolean(secondRun) &&
    fs.readFileSync(paths.second, "utf8").includes("delivered after the earlier run finished") &&
    !rawTerminalPersisted;

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        taskDirectory,
        reportPath,
        runCount: runs.length,
        firstRunIndex,
        secondRunIndex,
        queuedArtifactCreated: fs.existsSync(paths.second),
        secondRunChanges: secondRun?.changedFiles?.map((file) => file.path) ?? [],
        secondRunArtifacts: secondRun?.artifactCandidates?.map((artifact) => artifact.path) ?? [],
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
        error,
        page,
        workspaceRoot,
        taskDirectory,
        workspace,
        recordDir,
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
  fs.rmSync(settingsDir, { recursive: true, force: true });
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
  }, timeoutMs, "provider cwd");
  return providerCwd;
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

async function collectDiagnostics({ error, page, workspaceRoot, taskDirectory, workspace, recordDir }) {
  const reportPath = recordDir ? path.join(recordDir, "runtime-report.json") : null;
  const report = reportPath && fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : null;
  return {
    error: error instanceof Error ? error.message : String(error),
    workspaceRoot,
    taskDirectory,
    reportPath,
    runtimeStatus: page ? await safeText(page.locator("#runtime-status")) : null,
    workflowHeadline: page ? await safeText(page.locator("#workflow-headline")) : null,
    deliveryQueue: page ? await safeText(page.locator("#delivery-queue")) : null,
    runListText: page ? redact(await safeText(page.locator("#run-list"))) : null,
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
  return value?.replaceAll(os.homedir(), "~") ?? null;
}
