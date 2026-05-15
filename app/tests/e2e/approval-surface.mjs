import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-approval-surface-e2e-"));
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

  await page.locator("#entry-new-task").click();
  await approveWithSurface(page, {
    title: "Workspace trust requested",
    badge: "Workspace trust",
    scope: "Task workspace trust",
    run: "session setup",
  });
  await page.locator("#workflow-headline", { hasText: "Ready for first Run" }).waitFor({
    state: "visible",
  });

  const taskId = await page.locator(".task-tab").first().getAttribute("data-task-id");
  if (!taskId) {
    throw new Error("Task tab did not expose a task id.");
  }

  const commandText = [
    "python3 -c \"from pathlib import Path;",
    "Path('approval_command.md').write_text('# Approval Command\\\\nCommand approval surface ready.\\\\n')\"",
  ].join(" ");
  const prompt = [
    "Run exactly this shell command and no other commands.",
    "Do not use apply_patch.",
    "Do not edit files directly.",
    `Command: ${commandText}`,
  ].join("\n");
  await page.locator("#prompt-input").fill(prompt);
  await page.locator("#send-prompt").click();
  await approveWithSurface(page, {
    title: "Command approval requested",
    badge: "Command",
    scope: "terminal command execution",
    run: "run-",
  });

  await page.locator(".artifact-item", { hasText: "approval_command.md" }).waitFor({
    state: "visible",
  });
  await page.locator(".run-outcome", { hasText: "Completed by terminal idle heuristic" }).waitFor({
    state: "visible",
  });
  await page.locator(".run-approval-history", { hasText: "Approval history" }).waitFor({
    state: "visible",
  });
  await page.locator(".approval-history-item", { hasText: "Command approval requested" }).waitFor({
    state: "visible",
  });
  await page.locator(".approval-history-item", { hasText: "native Codex PTY approval screen" }).waitFor({
    state: "visible",
  });
  await page.locator(".approval-history-item", { hasText: "Command approval approved" }).waitFor({
    state: "visible",
  });
  await page.locator(".approval-history-item", { hasText: "CSI-u Enter" }).waitFor({
    state: "visible",
  });

  const reports = readReports(workspaceRoot);
  const latestRun = reports.at(-1)?.runs?.at(-1) ?? null;
  const reportText = JSON.stringify(reports);
  const rawTerminalPersisted =
    reportText.includes("pty:data") ||
    reportText.includes("OpenAI Codex") ||
    reportText.includes("Do you trust the contents of this directory");
  const success =
    reports.length === 1 &&
    latestRun?.approvalEvents?.some(
      (event) => event.action === "detected" && event.kind === "command",
    ) &&
    latestRun?.approvalEvents?.some(
      (event) => event.action === "decision" && event.decision === "approve",
    ) &&
    latestRun?.artifactCandidates?.some((artifact) => artifact.path === "approval_command.md") &&
    !rawTerminalPersisted;

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        taskId,
        approvalEvents: latestRun?.approvalEvents ?? [],
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

async function approveWithSurface(page, expected) {
  const banner = page.locator("#approval-banner", { hasText: expected.title });
  await banner.waitFor({ state: "visible", timeout: 180000 });
  await banner.locator("#approval-kind-badge", { hasText: expected.badge }).waitFor({
    state: "visible",
  });
  await banner.locator("#approval-context", { hasText: "Source: native Codex PTY approval screen" }).waitFor({
    state: "visible",
  });
  await banner.locator("#approval-context", { hasText: `Scope: ${expected.scope}` }).waitFor({
    state: "visible",
  });
  await banner.locator("#approval-context", { hasText: `Run: ${expected.run}` }).waitFor({
    state: "visible",
  });
  await banner.locator("#approval-context", { hasText: "Approve: send native Enter" }).waitFor({
    state: "visible",
  });
  await banner.locator("#approval-context", { hasText: "Deny: send native Esc" }).waitFor({
    state: "visible",
  });
  await page.locator("#approve-approval").click();
  await banner.waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
}

function readReports(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, ".duet", "runtime-report.json"))
    .filter((reportPath) => fs.existsSync(reportPath))
    .map((reportPath) => JSON.parse(fs.readFileSync(reportPath, "utf8")));
}
