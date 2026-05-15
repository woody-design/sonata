import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-gui-e2e-"));
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

  const prompt = [
    "Create exactly two files in this workspace:",
    "1. report.md with the heading '# Duet GUI Gate' and one sentence saying 'Markdown artifact ready.'",
    "2. page.html with a minimal HTML page whose body contains 'HTML artifact ready.'",
    "Do not modify any other files.",
  ].join("\n");

  await page.locator("#prompt-input").fill(prompt);
  await page.locator("#send-prompt").click();

  await approveIfVisible(page, "File edit approval requested", 180000);
  await approveIfVisible(page, "Command approval requested", 15000);

  await page.locator(".artifact-item", { hasText: "report.md" }).waitFor({ state: "visible" });
  await page.locator(".artifact-item", { hasText: "page.html" }).waitFor({ state: "visible" });

  await page.locator(".artifact-item", { hasText: "report.md" }).click();
  await page.locator(".preview-header", { hasText: "report.md" }).waitFor({ state: "visible" });
  await page.locator(".text-preview", { hasText: "Markdown artifact ready." }).waitFor({
    state: "visible",
  });

  await page.locator(".artifact-item", { hasText: "page.html" }).click();
  await page.locator(".preview-header", { hasText: "page.html" }).waitFor({ state: "visible" });
  await page.locator(".html-preview").waitFor({ state: "visible" });

  await page.locator("#inspector-tab").click();
  await page.locator(".inspector-content", { hasText: "Changed files" }).waitFor({
    state: "visible",
  });
  await page.locator(".inspector-content", { hasText: "Approvals" }).waitFor({ state: "visible" });

  await page.locator("#terminal-tab").click();
  await page.locator("#terminal").waitFor({ state: "visible" });

  const workspaceEntries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
  const taskDirectory = workspaceEntries.find((entry) => entry.isDirectory())?.name ?? null;
  const reportPath = taskDirectory
    ? path.join(workspaceRoot, taskDirectory, ".duet", "runtime-report.json")
    : null;
  const report = reportPath && fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, "utf8")) : null;
  const reportText = report ? JSON.stringify(report) : "";
  const rawTerminalPersisted =
    reportText.includes("pty:data") ||
    reportText.includes("Do you trust the contents of this directory") ||
    reportText.includes("OpenAI Codex");

  const latestRun = report?.runs?.at(-1) ?? null;
  const success =
    Boolean(report) &&
    latestRun?.changedFiles?.some((file) => file.path === "report.md") &&
    latestRun?.changedFiles?.some((file) => file.path === "page.html") &&
    latestRun?.artifactCandidates?.some((artifact) => artifact.path === "report.md") &&
    latestRun?.artifactCandidates?.some((artifact) => artifact.path === "page.html") &&
    !rawTerminalPersisted;

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        taskDirectory,
        reportPath,
        runCount: report?.runs?.length ?? 0,
        changedFiles: latestRun?.changedFiles?.map((file) => `${file.changeKind}:${file.path}`) ?? [],
        artifactCandidates: latestRun?.artifactCandidates?.map((artifact) => artifact.path) ?? [],
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
