import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { approveIfVisible, approveVisibleBanner } from "./helpers/approval.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-run-chat-e2e-"));
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

  const taskId = await page.locator(".task-tab").first().getAttribute("data-task-id");
  if (!taskId) {
    throw new Error("Task tab did not expose a task id.");
  }

  const prompt = [
    "Create exactly one file named transcript.md.",
    "The file must contain exactly this sentence: DUET_TRANSCRIPT_VISIBLE artifact ready.",
    "After creating it, include the phrase DUET_TRANSCRIPT_VISIBLE in your response.",
    "Do not modify any other files.",
  ].join("\n");

  await runPrompt(page, 1, prompt);

  const runCard = page.locator(".turn-card").first();
  await runCard.locator(".turn-user", { hasText: "You" }).waitFor({
    state: "visible",
  });
  await runCard.locator(".turn-user", { hasText: "DUET_TRANSCRIPT_VISIBLE" }).waitFor({
    state: "visible",
  });
  await runCard.locator(".turn-provenance", { hasText: /provider transcript|terminal approximation/ }).waitFor({
    state: "visible",
  });

  const assistantBody = runCard.locator(".turn-body .md-body, .turn-body .turn-fallback-text").first();
  await assistantBody.waitFor({ state: "visible" });
  const userText = await runCard.locator(".turn-user-text").textContent();
  const assistantText = await runCard.locator(".turn-body").textContent();
  const transcriptMaxHeight = await assistantBody.evaluate((element) =>
    getComputedStyle(element).maxHeight,
  );
  const transcriptOverflow = await assistantBody.evaluate((element) =>
    getComputedStyle(element).overflowY,
  );
  const transcriptClean =
    Boolean(assistantText) &&
    assistantText.trim().length > 40 &&
    !assistantText.includes("\u001b") &&
    !assistantText.includes("[?25");
  const promptComplete = userText === prompt;
  const transcriptUsesMainScroll = transcriptMaxHeight === "none" && transcriptOverflow === "visible";

  await page.locator(".artifact-item", { hasText: "transcript.md" }).waitFor({ state: "visible" });
  await page.locator(".turn-outcome", { hasText: "Completed by terminal idle heuristic" }).waitFor({
    state: "visible",
  });
  await page.locator(".turn-artifacts .artifact-link", { hasText: "transcript.md" }).waitFor({
    state: "visible",
  });

  const reports = readReports(workspaceRoot);
  const reportText = JSON.stringify(reports);
  const rawTerminalPersisted =
    reportText.includes("pty:data") ||
    reportText.includes("Do you trust the contents of this directory") ||
    reportText.includes("OpenAI Codex");
  const latestRun = reports.at(-1)?.runs?.at(-1) ?? null;
  const success =
    reports.length === 1 &&
    latestRun?.artifactCandidates?.some((artifact) => artifact.path === "transcript.md") &&
    promptComplete &&
    transcriptClean &&
    transcriptUsesMainScroll &&
    !rawTerminalPersisted;

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        taskId,
        promptComplete,
        assistantTranscriptChars: assistantText?.length ?? 0,
        transcriptMaxHeight,
        transcriptOverflow,
        transcriptClean,
        transcriptUsesMainScroll,
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

async function runPrompt(page, expectedCompletedRuns, prompt) {
  await page.locator("#prompt-input").fill(prompt);
  await page.locator("#send-prompt").click();
  await page.locator("#workflow-headline", { hasText: /Codex is working|File edit approval needed/ }).waitFor({
    state: "visible",
  });
  await waitForCompletedRuns(page, expectedCompletedRuns, 240000);
}

async function waitForCompletedRuns(page, expectedCompletedRuns, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await approveIfVisible(page, "File edit approval requested", 1000);
    await approveIfVisible(page, "Command approval requested", 1000);
    await approveAnyVisibleApproval(page);
    const completed = await page
      .locator(".turn-outcome", { hasText: "Completed by terminal idle heuristic" })
      .count();
    if (completed >= expectedCompletedRuns) {
      return;
    }
    await page.waitForTimeout(1000);
  }

  const headline = await safeText(page.locator("#workflow-headline"));
  const status = await safeText(page.locator("#runtime-status"));
  const approval = await safeText(page.locator("#approval-title"));
  throw new Error(
    `Timed out waiting for ${expectedCompletedRuns} completed Runs. ` +
      `headline=${headline} status=${status} approval=${approval}`,
  );
}

async function approveAnyVisibleApproval(page) {
  const banner = page.locator("#approval-banner:not(.hidden)");
  const visible = await banner.isVisible({ timeout: 500 }).catch(() => false);
  if (visible) {
    await approveVisibleBanner(page, banner);
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

async function safeText(locator) {
  try {
    return (await locator.textContent({ timeout: 1000 })) ?? "";
  } catch {
    return "";
  }
}
