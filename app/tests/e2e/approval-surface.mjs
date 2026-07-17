// Approval SURFACE e2e — the broker-card content contract (S6 rewrite).
//
// The original suite asserted the codex-era scrape surface (workspace-trust
// card "in full", "Source: native Codex PTY approval screen", Enter/Esc key
// encodings). Both premises died: S4's trust pre-write removed the trust
// dialog from the createTask path, and the claude approval surface is the S2
// hook broker — the card leads with the tool summary and panel-faithful
// choice buttons; the low-level context rows are deliberately gone.
//
// What THIS suite uniquely locks (walking-skeleton approves by visibility
// and never reads the card):
//  1. S4 negative control: a fresh createTask cold start is pre-trusted —
//     no workspace-trust card ever renders.
//  2. Broker card content: data-approval-kind, badge text, tool-summary
//     title ("Run  python3 …"), the honest "Always: <scope>" middle button.
//  3. Report provenance: approvalEvents carry source "hook-broker" with a
//     matching approve decision (the reply channel, not key replay).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { sendFirstPrompt } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-approval-surface-e2e-"));
const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-approval-surface-settings-"));
let electronApp = null;

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      DUET_DATA_DIR: workspaceRoot, DUET_WORKSPACES_DIR: workspaceRoot,
      DUET_SETTINGS_DIR: settingsDir,
    },
  });

  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(180000);

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

  // 1. S4 negative control — the pick gesture pre-granted trust, so the
  //    dispatch must win the race against a trust banner that never comes.
  const trustOutcome = await sendFirstPrompt(page, prompt);
  if (trustOutcome !== "pre-trusted") {
    throw new Error(`Expected a pre-trusted cold start (S4), got: ${trustOutcome}`);
  }

  // 2. The command approval's broker card. Claude may ask for other tools
  //    first (reads vary per run) — approve those by visibility until the
  //    command card is up, then read THIS card in full.
  const banner = page.locator("#approval-banner");
  const commandCard = page.locator('#approval-banner[data-approval-kind="command"]');
  const cardChecks = { badge: null, title: null, alwaysLabel: null, denyLabel: null };
  await waitUntil(async () => {
    if (await commandCard.isVisible().catch(() => false)) {
      return true;
    }
    if (await banner.isVisible().catch(() => false)) {
      await page.locator("#approve-approval").click(); // a non-command ask; drain
      await page.waitForTimeout(400);
    }
    return false;
  }, 180000, "command approval card");

  cardChecks.badge = (await page.locator("#approval-kind-badge").textContent())?.trim();
  cardChecks.title = (await page.locator("#approval-title").textContent())?.trim();
  // Drawer S2: the raw command moved from the title into the code block.
  cardChecks.detail = (await page.locator("#approval-context").textContent())?.trim();
  const middle = page.locator("#approve-session-approval");
  cardChecks.alwaysVisible = await middle.isVisible();
  cardChecks.alwaysLabel = (await middle.textContent())?.trim();
  cardChecks.denyLabel = (await page.locator("#deny-approval").textContent())?.trim();

  const cardOk =
    cardChecks.badge === "Command" &&
    Boolean(cardChecks.title?.startsWith("Run")) &&
    Boolean(cardChecks.detail?.includes("python3")) &&
    cardChecks.alwaysVisible === true &&
    // The middle button states the ACTUAL persisted rule scope ("<tool> *"),
    // never a vague promise (reviewer P2, trust boundary).
    Boolean(cardChecks.alwaysLabel?.startsWith("Always:")) &&
    Boolean(cardChecks.alwaysLabel?.includes("python3")) &&
    cardChecks.denyLabel === "Deny";

  // 3. Approve once (reply channel) and drain any later asks until the turn
  //    completes with the artifact.
  await page.locator("#approve-approval").click();
  await waitUntil(async () => {
    if (await banner.isVisible().catch(() => false)) {
      await page.locator("#approve-approval").click();
      await page.waitForTimeout(400);
    }
    return page
      .locator('.turn-card[data-run-status="completed"]')
      .isVisible()
      .catch(() => false);
  }, 180000, "turn completion");
  // The artifact strip is gone (2026-07-03): the durable report is the
  // artifact-candidate surface now.
  await waitUntil(
    () =>
      readReports(workspaceRoot)
        .at(-1)
        ?.runs?.some((run) =>
          run.artifactCandidates?.some((artifact) => artifact.path === "approval_command.md"),
        ) ?? false,
    30000,
    "artifact candidate in report",
  );

  const reports = readReports(workspaceRoot);
  const report = reports.at(-1) ?? null;
  const approvalEvents = [
    ...(report?.runs ?? []).flatMap((run) => run.approvalEvents ?? []),
    ...(report?.unassignedApprovals ?? []),
  ];
  const reportText = JSON.stringify(reports);
  const rawTerminalPersisted =
    reportText.includes("pty:data") ||
    reportText.includes("Do you trust the contents of this directory");
  const trustCardEverDetected = approvalEvents.some((event) => event.kind === "workspace-trust");
  const brokerDetected = approvalEvents.some(
    (event) => event.action === "detected" && event.kind === "command" && event.source === "hook-broker",
  );
  // Reply-channel provenance must be consistent end to end (S6 review P3):
  // the decision AND every detected choice say "reply-file" — no bytes ever
  // touch the PTY for a broker answer.
  const approveDecision = approvalEvents.some(
    (event) =>
      event.action === "decision" &&
      event.decision === "approve" &&
      event.encodedAs === "reply-file",
  );
  const choicesHonest = approvalEvents
    .filter((event) => event.action === "detected" && event.source === "hook-broker")
    .every((event) => (event.choices ?? []).every((choice) => choice.encodedAs === "reply-file"));
  // Dedupe lock (S6 review P2): every broker ask is recorded exactly once —
  // the drain loop answers each card once, so detected and decision counts
  // must match (the old show-path recording double-counted queued asks).
  const brokerDetectedCount = approvalEvents.filter(
    (event) => event.action === "detected" && event.source === "hook-broker",
  ).length;
  const brokerDecisionCount = approvalEvents.filter(
    (event) => event.action === "decision" && event.encodedAs === "reply-file",
  ).length;
  const recordBalanced = brokerDetectedCount === brokerDecisionCount && brokerDetectedCount > 0;
  const artifactRecorded = (report?.runs ?? []).some((run) =>
    run.artifactCandidates?.some((artifact) => artifact.path === "approval_command.md"),
  );

  const success =
    reports.length === 1 &&
    cardOk &&
    !trustCardEverDetected &&
    brokerDetected &&
    approveDecision &&
    choicesHonest &&
    recordBalanced &&
    artifactRecorded &&
    !rawTerminalPersisted;

  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        trustOutcome,
        cardChecks,
        cardOk,
        trustCardEverDetected,
        brokerDetected,
        approveDecision,
        choicesHonest,
        brokerDetectedCount,
        brokerDecisionCount,
        recordBalanced,
        artifactRecorded,
        rawTerminalPersisted,
        approvalEvents,
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
  fs.rmSync(settingsDir, { recursive: true, force: true });
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}.`);
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
