import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { approveAnyVisibleApproval } from "./helpers/approval.mjs";
import { sendFirstPrompt, waitForEngagement } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-gui-e2e-"));
let electronApp = null;

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      DUET_DATA_DIR: workspaceRoot, DUET_WORKSPACES_DIR: workspaceRoot,
    },
  });

  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(180000);

  const prompt = [
    "Create exactly two files in this workspace:",
    "1. report.md with the heading '# Duet GUI Gate' and one sentence saying 'Markdown artifact ready.'",
    "2. page.html with a minimal HTML page whose body contains 'HTML artifact ready.'",
    "Do not modify any other files.",
  ].join("\n");

  // The first message creates the session (deferred creation).
  await sendFirstPrompt(page, prompt);
  await waitForEngagement(page);

  // Approve every ask until the run completes: Claude (the default provider
  // since f6dd283) requests approval PER tool call — two file writes are two
  // asks — and a broker ask's card title is the tool summary, not a fixed
  // string, so drain by visibility (approveAnyVisibleApproval), not by title.
  // Completion beacon: the card's data-run-status attribute (the turn footer
  // and its ".turn-outcome" retired 2026-07-03).
  const completedCard = page.locator('.turn-card[data-run-status="completed"]');
  const outcomeDeadline = Date.now() + 240000;
  while (Date.now() < outcomeDeadline && (await completedCard.count()) === 0) {
    await approveAnyVisibleApproval(page);
    await page.waitForTimeout(500);
  }
  await completedCard.waitFor({ state: "visible" });

  // Provider-agnostic completion provenance: Claude settles by the Stop hook,
  // Codex by the idle heuristic. The card carries the source as data now.
  const completionSource = await completedCard.getAttribute("data-completion-source");
  if (!/hook-stop|terminal-idle-heuristic/.test(completionSource ?? "")) {
    throw new Error(`Unexpected completion source: ${completionSource}`);
  }

  const turnCard = page.locator(".turn-card", { hasText: "Create exactly two files" }).first();
  await turnCard.locator(".turn-user .turn-prompt").waitFor({ state: "visible" });
  const transcriptText = await turnCard.locator(".turn-body").textContent();
  // Readable assistant content, no raw ANSI. Claude's reply to this prompt
  // can be a single short sentence — the length floor guards "non-empty",
  // not verbosity.
  const transcriptObserved =
    Boolean(transcriptText) && transcriptText.trim().length > 10 && !transcriptText.includes("\u001b");
  if (!transcriptObserved) {
    throw new Error("Main Chat reading flow did not show readable assistant content.");
  }
  // Reading = reply + state (2026-07-03): exactly one Run's turn card exists
  // and the live status strip has settled away. Process detail (work trace,
  // facts, artifact chips) no longer renders here — the co-visible Terminal
  // and the runtime report carry it (asserted below on disk).
  await page.locator("#status-strip.hidden").waitFor({ state: "attached" });
  const turnCount = await page.locator(".turn-card").count();
  if (turnCount !== 1) {
    throw new Error(`Expected exactly 1 turn card after the walking-skeleton run, saw ${turnCount}`);
  }
  await page.locator("#send-prompt").waitFor({ state: "visible" });

  // The terminal is its own satellite window now (default-on). Exercise the
  // header toggle via its label, which tracks the window's real open state.
  await page.locator('#toggle-terminal-window[aria-pressed="true"]', { hasText: "CLI" }).waitFor({ state: "visible" });
  await page.locator("#toggle-terminal-window").click();
  await page.locator('#toggle-terminal-window[aria-pressed="false"]', { hasText: "CLI" }).waitFor({ state: "visible" });
  await page.locator("#toggle-terminal-window").click();
  await page.locator('#toggle-terminal-window[aria-pressed="true"]', { hasText: "CLI" }).waitFor({ state: "visible" });

  // Process detail lives on disk, not in a window (the Inspector satellite that
  // once showed the four lenses retired in S5). The runtime report is the
  // surviving contract: changed files + artifact candidates + no raw-terminal leak.
  const projectsRoot = path.join(workspaceRoot, "data", "projects");
  const workspaceEntries = fs.existsSync(projectsRoot)
    ? fs.readdirSync(projectsRoot, { withFileTypes: true })
    : [];
  const taskDirectory = workspaceEntries.find((entry) => entry.isDirectory())?.name ?? null;
  const reportPath = taskDirectory
    ? path.join(projectsRoot, taskDirectory, "runtime-report.json")
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
    transcriptObserved &&
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
        transcriptObserved,
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
