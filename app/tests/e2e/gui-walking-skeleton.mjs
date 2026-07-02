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
  const outcomeLocator = page.locator(".turn-outcome", { hasText: "Completed" });
  const outcomeDeadline = Date.now() + 240000;
  while (Date.now() < outcomeDeadline && (await outcomeLocator.count()) === 0) {
    await approveAnyVisibleApproval(page);
    await page.waitForTimeout(500);
  }

  await page.locator(".artifact-item", { hasText: "report.md" }).waitFor({ state: "visible" });
  await page.locator(".artifact-item", { hasText: "page.html" }).waitFor({ state: "visible" });
  // Provider-agnostic completion: Claude settles by the Stop hook
  // ("Completed"), Codex by the idle heuristic ("Completed by terminal idle
  // heuristic"). The provenance facts line carries the source either way.
  await outcomeLocator.waitFor({ state: "visible" });
  await page.locator(".turn-facts", { hasText: /hook-stop|terminal-idle-heuristic/ }).waitFor({
    state: "visible",
  });
  await page.locator(".turn-facts", { hasText: "2 changes" }).waitFor({ state: "visible" });
  const turnCard = page.locator(".turn-card", { hasText: "Create exactly two files" }).first();
  await turnCard.locator(".turn-user", { hasText: "You" }).waitFor({ state: "visible" });
  await turnCard.locator(".turn-artifacts .artifact-link", { hasText: "report.md" }).waitFor({
    state: "visible",
  });
  await turnCard.locator(".turn-artifacts .artifact-link", { hasText: "page.html" }).waitFor({
    state: "visible",
  });
  await turnCard.locator(".turn-provenance").waitFor({ state: "visible" });
  const transcriptText = await turnCard.locator(".turn-body").textContent();
  // Readable assistant content, no raw ANSI. Claude's reply to this prompt
  // can be a single short sentence — the length floor guards "non-empty",
  // not verbosity.
  const transcriptObserved =
    Boolean(transcriptText) && transcriptText.trim().length > 10 && !transcriptText.includes("\u001b");
  if (!transcriptObserved) {
    throw new Error("Main Chat reading flow did not show readable assistant content.");
  }
  // The retired workflow strip's "Review ready" + facts (S5): the real
  // surfaces carry them now — the artifact strip is up for review, exactly
  // one Run's turn card exists (its "2 changes" facts and artifact links were
  // asserted above), and the live status strip has settled away.
  await page.locator("#artifact-strip:not(.hidden)").waitFor({ state: "attached" });
  await page.locator("#status-strip.hidden").waitFor({ state: "attached" });
  const turnCount = await page.locator(".turn-card").count();
  if (turnCount !== 1) {
    throw new Error(`Expected exactly 1 turn card after the walking-skeleton run, saw ${turnCount}`);
  }
  await page.locator("#send-prompt").waitFor({ state: "visible" });

  const previewWindowPromise = electronApp.waitForEvent("window");
  await page.locator(".artifact-item", { hasText: "report.md" }).click();
  const previewPage = await previewWindowPromise;
  previewPage.setDefaultTimeout(180000);
  await previewPage.locator(".floating-preview-shell", { hasText: "report.md" }).waitFor({
    state: "visible",
  });
  await previewPage.locator(".preview-window-tab", { hasText: "report.md" }).waitFor({
    state: "visible",
  });
  await previewPage.locator(".artifact-review", { hasText: "Floating Preview" }).waitFor({
    state: "visible",
  });
  await previewPage.locator(".artifact-review", { hasText: "runtime-report.json" }).waitFor({
    state: "visible",
  });
  await previewPage.locator(".text-preview", { hasText: "Markdown artifact ready." }).waitFor({
    state: "visible",
  });
  await page.locator(".side-column").waitFor({ state: "hidden" });
  // The terminal is its own satellite window now (default-on). Exercise the
  // header toggle via its label, which tracks the window's real open state.
  await page.locator("#toggle-terminal-window", { hasText: "Close Terminal" }).waitFor({ state: "visible" });
  await page.locator("#toggle-terminal-window").click();
  await page.locator("#toggle-terminal-window", { hasText: "Open Terminal" }).waitFor({ state: "visible" });
  await page.locator("#toggle-terminal-window").click();
  await page.locator("#toggle-terminal-window", { hasText: "Close Terminal" }).waitFor({ state: "visible" });

  await page.locator(".artifact-item", { hasText: "page.html" }).click();
  await previewPage.locator(".preview-window-tab", { hasText: "page.html" }).waitFor({
    state: "visible",
  });
  await previewPage.locator(".floating-preview-shell", { hasText: "page.html" }).waitFor({
    state: "visible",
  });
  await previewPage.locator(".html-preview").waitFor({ state: "visible" });

  // Acquire the inspector window by URL, not by the next "window" event —
  // the terminal-window toggles just above can leave a queued window event
  // that waitForEvent would mistake for the inspector.
  await page.locator("#open-inspector-window").click();
  const inspectorDeadline = Date.now() + 30000;
  let inspectorPage = null;
  while (!inspectorPage && Date.now() < inspectorDeadline) {
    inspectorPage = electronApp.windows().find((w) => w.url().includes("inspector.html")) ?? null;
    if (!inspectorPage) {
      await page.waitForTimeout(250);
    }
  }
  if (!inspectorPage) {
    throw new Error("Inspector window did not open.");
  }
  inspectorPage.setDefaultTimeout(180000);
  await inspectorPage.locator(".floating-inspector-shell", { hasText: "Inspector" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".inspector-window-tab", { hasText: "Run" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".inspector-window-tab", { hasText: "Change" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".inspector-window-tab", { hasText: "Artifact" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".inspector-window-tab", { hasText: "Folder" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".inspector-section", { hasText: "Runtime report summary" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".inspector-section", { hasText: "Run 1" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".inspector-section", { hasText: "report.md" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".inspector-section", { hasText: "page.html" }).waitFor({
    state: "visible",
  });

  await inspectorPage.locator(".inspector-window-tab", { hasText: "Change" }).click();
  await inspectorPage.locator(".change-summary", { hasText: "Changed files summary" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".change-summary", { hasText: "current file snapshots, not Git diffs" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".change-metric", { hasText: "Changed" }).locator("strong", { hasText: "2" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".change-metric", { hasText: "Artifacts" }).locator("strong", { hasText: "2" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".inspector-review-list", { hasText: "report.md" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".inspector-review-list", { hasText: "page.html" }).waitFor({
    state: "visible",
  });

  await inspectorPage.locator(".inspector-window-tab", { hasText: "Artifact" }).click();
  await inspectorPage.locator(".inspector-section", { hasText: "Artifact candidates" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".inspector-section", { hasText: "report-listed candidates only" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".artifact-item", { hasText: "report.md" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".artifact-item", { hasText: "page.html" }).waitFor({
    state: "visible",
  });

  await inspectorPage.locator(".inspector-window-tab", { hasText: "Folder" }).click();
  await inspectorPage.locator(".workspace-tree-item", { hasText: "report.md" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".workspace-tree-item", { hasText: "page.html" }).waitFor({
    state: "visible",
  });
  await inspectorPage.locator(".workspace-tree-item", { hasText: "report.md" }).click();
  await inspectorPage.locator(".workspace-file-preview", { hasText: "Markdown artifact ready." }).waitFor({
    state: "visible",
  });

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
