import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { approveAnyVisibleApproval, approveVisibleBanner } from "./helpers/approval.mjs";
import { activeSessionTaskId, chooseDraftProvider, sendFirstPrompt, waitForEngagement } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-run-chat-e2e-"));
let electronApp = null;

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      SONATA_DATA_DIR: workspaceRoot, SONATA_WORKSPACES_DIR: workspaceRoot,
    },
  });

  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(180000);

  const prompt = [
    "Create exactly one file named transcript.md.",
    "The file must contain exactly this sentence: SONATA_TRANSCRIPT_VISIBLE artifact ready.",
    "After creating it, include the phrase SONATA_TRANSCRIPT_VISIBLE in your response.",
    "Do not modify any other files.",
  ].join("\n");

  await chooseDraftProvider(page, "codex");
  await runPrompt(page, 1, prompt);

  const taskId = await activeSessionTaskId(page);
  if (!taskId) {
    throw new Error("Sidebar session did not expose a task id.");
  }

  const runCard = page.locator(".turn-card").first();
  await runCard.locator(".turn-user", { hasText: "SONATA_TRANSCRIPT_VISIBLE" }).waitFor({
    state: "visible",
  });

  // Reading = reply + state (2026-07-03): the work trace, provenance line,
  // and footer no longer render. The reply must read clean, and no process
  // block (tool call / thinking / plan / agents) may leak into the card.
  const processBlocks = await runCard
    .locator(".turn-work-trace, .turn-tool, .turn-thinking, .turn-plan, .turn-agents, .turn-provenance")
    .count();

  const assistantBody = runCard.locator(".turn-body .md-body").first();
  await assistantBody.waitFor({ state: "visible" });
  const userText = await runCard.locator(".turn-user-text").textContent();
  const assistantText = await runCard.locator(".turn-body").textContent();
  const transcriptMaxHeight = await assistantBody.evaluate((element) =>
    getComputedStyle(element).maxHeight,
  );
  const transcriptOverflow = await assistantBody.evaluate((element) =>
    getComputedStyle(element).overflowY,
  );
  // Content-based, not length-based: Claude's reply to this prompt can be
  // a single short sentence, so the old 40-char floor flaked on brevity.
  // The prompt demands the codeword in the response - assert THAT, plus no
  // raw ANSI.
  const transcriptClean =
    Boolean(assistantText) &&
    assistantText.includes("SONATA_TRANSCRIPT_VISIBLE") &&
    !assistantText.includes("\u001b") &&
    !assistantText.includes("[?25");
  const promptComplete = userText === prompt;
  const transcriptUsesMainScroll = transcriptMaxHeight === "none" && transcriptOverflow === "visible";

  await page.locator('.turn-card[data-run-status="completed"]').waitFor({
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
    processBlocks === 0 &&
    transcriptClean &&
    transcriptUsesMainScroll &&
    !rawTerminalPersisted;

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        taskId,
        promptComplete,
        processBlocks,
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
  // The first prompt creates the session (deferred creation) and answers the
  // workspace-trust approval that surfaces during the provider cold start.
  await sendFirstPrompt(page, prompt);
  await waitForEngagement(page);
  await waitForCompletedRuns(page, expectedCompletedRuns, 240000);
}

async function waitForCompletedRuns(page, expectedCompletedRuns, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Drain by visibility: Claude asks per tool call (edit/read/command) and
    // broker card titles are tool summaries — kind-bound waits under-match.
    await approveAnyVisibleApproval(page);
    const completed = await page
      .locator('.turn-card[data-run-status="completed"]')
      .count();
    if (completed >= expectedCompletedRuns) {
      return;
    }
    await page.waitForTimeout(1000);
  }

  const strip = await safeText(page.locator("#status-strip"));
  const status = await safeText(page.locator("#runtime-status"));
  const approval = await safeText(page.locator("#approval-title"));
  throw new Error(
    `Timed out waiting for ${expectedCompletedRuns} completed Runs. ` +
      `strip=${strip} status=${status} approval=${approval}`,
  );
}

function readReports(root) {
  const projectsRoot = path.join(root, "data", "projects");
  if (!fs.existsSync(projectsRoot)) {
    return [];
  }
  return fs
    .readdirSync(projectsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(projectsRoot, entry.name, "runtime-report.json"))
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
