import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-tabs-e2e-"));
let electronApp = null;

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      DUET_PROJECTS_DIR: workspaceRoot,
    },
  });

  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(180000);

  await page.locator("#new-task").click();
  await approveIfVisible(page, "Workspace trust requested", 45000);
  await page.locator("#workflow-headline", { hasText: "Ready for first Run" }).waitFor({
    state: "visible",
  });
  const firstTaskId = await page.locator(".task-tab").first().getAttribute("data-task-id");
  if (!firstTaskId) {
    throw new Error("First Task tab did not expose a task id.");
  }

  await runFilePrompt(page, {
    fileName: "alpha.md",
    body: "Alpha artifact ready.",
  });
  await page.locator(".artifact-item", { hasText: "alpha.md" }).waitFor({ state: "visible" });

  await page.locator("#new-task").click();
  await approveIfVisible(page, "Workspace trust requested", 45000);
  await page.locator("#workflow-headline", { hasText: "Ready for first Run" }).waitFor({
    state: "visible",
  });
  await page.locator(".task-tab").nth(1).waitFor({ state: "visible" });
  const secondTaskId = await page.locator(".task-tab").nth(1).getAttribute("data-task-id");
  if (!secondTaskId || secondTaskId === firstTaskId) {
    throw new Error("Second Task tab did not create an independent task id.");
  }
  await page.locator(".empty-state", { hasText: "No Runs yet" }).waitFor({ state: "visible" });
  await expectArtifactAbsent(page, "alpha.md");

  await runFilePrompt(page, {
    fileName: "beta.md",
    body: "Beta artifact ready.",
  });
  await page.locator(".artifact-item", { hasText: "beta.md" }).waitFor({ state: "visible" });
  await expectArtifactAbsent(page, "alpha.md");

  await page.locator(`.task-tab[data-task-id="${firstTaskId}"]`).click();
  await page.locator(".artifact-item", { hasText: "alpha.md" }).waitFor({ state: "visible" });
  await page.locator(".run-card", { hasText: "alpha.md" }).waitFor({ state: "visible" });
  await expectArtifactAbsent(page, "beta.md");

  await page.locator(`.task-tab[data-task-id="${secondTaskId}"]`).click();
  await page.locator(".artifact-item", { hasText: "beta.md" }).waitFor({ state: "visible" });
  await page.locator(".run-card", { hasText: "beta.md" }).waitFor({ state: "visible" });
  await expectArtifactAbsent(page, "alpha.md");

  const reports = readReports(workspaceRoot);
  const alphaReport = reports.find((report) =>
    report.runs?.some((run) => run.artifactCandidates?.some((artifact) => artifact.path === "alpha.md")),
  );
  const betaReport = reports.find((report) =>
    report.runs?.some((run) => run.artifactCandidates?.some((artifact) => artifact.path === "beta.md")),
  );
  const reportText = JSON.stringify(reports);
  const rawTerminalPersisted =
    reportText.includes("pty:data") ||
    reportText.includes("Do you trust the contents of this directory") ||
    reportText.includes("OpenAI Codex");

  const success =
    Boolean(alphaReport) &&
    Boolean(betaReport) &&
    alphaReport?.taskId !== betaReport?.taskId &&
    reports.length === 2 &&
    !rawTerminalPersisted;

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        firstTaskId,
        secondTaskId,
        reportTaskIds: reports.map((report) => report.taskId),
        alphaRunCount: alphaReport?.runs?.length ?? 0,
        betaRunCount: betaReport?.runs?.length ?? 0,
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

async function runFilePrompt(page, options) {
  const prompt = [
    `Create exactly one file named ${options.fileName}.`,
    `The file must contain the sentence '${options.body}'`,
    "Do not modify any other files.",
  ].join("\n");

  await page.locator("#prompt-input").fill(prompt);
  await page.locator("#send-prompt").click();
  await page.locator("#workflow-headline", { hasText: /Codex is working|File edit approval needed/ }).waitFor({
    state: "visible",
  });
  await approveIfVisible(page, "File edit approval requested", 180000);
  await approveIfVisible(page, "Command approval requested", 15000);
  await page.locator(".run-outcome", { hasText: "Completed by terminal idle heuristic" }).waitFor({
    state: "visible",
  });
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

async function expectArtifactAbsent(page, name) {
  const count = await page.locator(".artifact-item", { hasText: name }).count();
  if (count > 0) {
    throw new Error(`Unexpected artifact visible in active Task: ${name}`);
  }
}

function readReports(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, ".duet", "runtime-report.json"))
    .filter((reportPath) => fs.existsSync(reportPath))
    .map((reportPath) => JSON.parse(fs.readFileSync(reportPath, "utf8")));
}
