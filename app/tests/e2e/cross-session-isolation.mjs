// Cross-session isolation fence (2026-07-03): two Claude sessions working in
// the SAME folder concurrently — the daily topology whose transcript binding
// used to cross-wire (the locator's mtime fallback could adopt the sibling's
// jsonl during overlapping discovery, and persistTranscriptSources anchored
// the wrong identity permanently). The fix: pinned --session-id with NO mtime
// fallback + the hook handshake (see tests/smoke/transcript-identity.mjs for
// the mechanism-level proof). This e2e holds the end-to-end contract:
//   1. each session's Reading column shows ITS OWN reply, never the sibling's;
//   2. the persisted bindings (providerSessionRef, transcript-sources) are
//      distinct per task;
//   3. the composer drafts are per-session too (the same bug class in the
//      view layer: a shared textarea must not carry text across sessions).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { approveAnyVisibleApproval } from "./helpers/approval.mjs";
import { selectSidebarSession } from "./helpers/session.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-cross-session-e2e-"));
// ONE shared folder for both sessions — the topology under test.
const sharedFolder = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-shared-folder-"));
let electronApp = null;

const ALPHA_PROMPT = [
  "Create exactly one file named alpha_only.md containing exactly: CODEWORD_ALPHA ready.",
  "Reply with the phrase CODEWORD_ALPHA and nothing about any other codeword.",
  "Do not modify any other files.",
].join("\n");
const BETA_PROMPT = [
  "Create exactly one file named beta_only.md containing exactly: CODEWORD_BETA ready.",
  "Reply with the phrase CODEWORD_BETA and nothing about any other codeword.",
  "Do not modify any other files.",
].join("\n");

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

  // Both tasks are created via the runtime API so they share ONE real cwd
  // (the UI's folder picker is a native dialog e2e cannot drive). acceptEdits
  // keeps the file-write approvals out of the way; any residual ask (trust,
  // command) is drained below while alternating between the sessions.
  const alpha = await page.evaluate(
    async (cwd) => window.sonataRuntime.createTask({ provider: "claude", cwd, permissionMode: "acceptEdits" }),
    sharedFolder,
  );
  await page.evaluate(
    async (request) => window.sonataRuntime.submitPrompt(request),
    { taskId: alpha.task.id, text: ALPHA_PROMPT },
  );

  // Create the sibling IMMEDIATELY — the discovery windows must overlap for
  // this fence to mean anything.
  const beta = await page.evaluate(
    async (cwd) => window.sonataRuntime.createTask({ provider: "claude", cwd, permissionMode: "acceptEdits" }),
    sharedFolder,
  );
  await page.evaluate(
    async (request) => window.sonataRuntime.submitPrompt(request),
    { taskId: beta.task.id, text: BETA_PROMPT },
  );

  // Drain any approvals while both runs complete, alternating the active
  // session so each task's banner can surface. Completion is read from the
  // durable reports on disk — UI-independent.
  const sidebarRow = (taskId) => page.locator(`.sidebar-session[data-task-id="${taskId}"]`);
  await sidebarRow(alpha.task.id).waitFor({ state: "visible" });
  await sidebarRow(beta.task.id).waitFor({ state: "visible" });

  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    if (runCompleted(alpha.task.id) && runCompleted(beta.task.id)) {
      break;
    }
    for (const taskId of [alpha.task.id, beta.task.id]) {
      if (!runCompleted(taskId)) {
        await selectSidebarSession(page, taskId);
        await approveAnyVisibleApproval(page);
      }
      await page.waitForTimeout(500);
    }
  }
  if (!runCompleted(alpha.task.id) || !runCompleted(beta.task.id)) {
    throw new Error(
      `Runs did not complete: alpha=${JSON.stringify(latestRun(alpha.task.id)?.status)} beta=${JSON.stringify(latestRun(beta.task.id)?.status)}`,
    );
  }

  // 1. Reading isolation: each session shows its own reply, never the sibling's.
  await selectSidebarSession(page, alpha.task.id);
  await page.locator('.turn-card[data-run-status="completed"]').waitFor({ state: "visible" });
  await page.locator(".turn-card .turn-body", { hasText: "CODEWORD_ALPHA" }).waitFor({ state: "visible" });
  const alphaBleed = await page.locator("#run-list", { hasText: "CODEWORD_BETA" }).count();

  await selectSidebarSession(page, beta.task.id);
  await page.locator('.turn-card[data-run-status="completed"]').waitFor({ state: "visible" });
  await page.locator(".turn-card .turn-body", { hasText: "CODEWORD_BETA" }).waitFor({ state: "visible" });
  const betaBleed = await page.locator("#run-list", { hasText: "CODEWORD_ALPHA" }).count();

  if (alphaBleed !== 0 || betaBleed !== 0) {
    throw new Error(`Cross-session reply bleed: alphaShowsBeta=${alphaBleed} betaShowsAlpha=${betaBleed}`);
  }

  // 2. Persisted bindings are distinct per task.
  const alphaSources = readSources(alpha.task.id);
  const betaSources = readSources(beta.task.id);
  const alphaRef = readManifest(alpha.task.id)?.task?.providerSessionRef ?? null;
  const betaRef = readManifest(beta.task.id)?.task?.providerSessionRef ?? null;
  const bindingsDistinct =
    alphaSources.length > 0 &&
    betaSources.length > 0 &&
    !alphaSources.some((source) => betaSources.some((other) => other.path === source.path)) &&
    Boolean(alphaRef) &&
    Boolean(betaRef) &&
    alphaRef !== betaRef;

  // 3. Composer drafts are per-session (beta is active here).
  await page.locator("#prompt-input").fill("DRAFT-BETA unsent");
  await selectSidebarSession(page, alpha.task.id);
  const draftOnAlpha = await page.locator("#prompt-input").inputValue();
  await page.locator("#prompt-input").fill("DRAFT-ALPHA unsent");
  await selectSidebarSession(page, beta.task.id);
  const draftOnBeta = await page.locator("#prompt-input").inputValue();
  await selectSidebarSession(page, alpha.task.id);
  const draftBackOnAlpha = await page.locator("#prompt-input").inputValue();
  const composerIsolated =
    draftOnAlpha === "" && draftOnBeta === "DRAFT-BETA unsent" && draftBackOnAlpha === "DRAFT-ALPHA unsent";

  // 4. /clear rebind: the CLI declares a NEW session id under the same PTY.
  // The hook handshake must rebind the manifest ref (a sanctioned identity
  // update — everything keyed by providerSessionRef follows the live
  // session), and Reading must follow the new transcript.
  await selectSidebarSession(page, alpha.task.id);
  await page.evaluate(
    async (request) => window.sonataRuntime.submitPrompt(request),
    { taskId: alpha.task.id, text: "/clear" },
  );
  await page.waitForTimeout(4000);
  await page.evaluate(
    async (request) => window.sonataRuntime.submitPrompt(request),
    {
      taskId: alpha.task.id,
      text: [
        "Create exactly one file named gamma_only.md containing exactly: CODEWORD_GAMMA ready.",
        "Reply with the phrase CODEWORD_GAMMA and nothing about any other codeword.",
        "Do not modify any other files.",
      ].join("\n"),
    },
  );
  const gammaDeadline = Date.now() + 240000;
  const gammaDone = () =>
    (readReport(alpha.task.id)?.runs ?? []).some(
      (run) =>
        run.status === "completed" &&
        run.artifactCandidates?.some((artifact) => artifact.path === "gamma_only.md"),
    );
  while (Date.now() < gammaDeadline && !gammaDone()) {
    await approveAnyVisibleApproval(page);
    await page.waitForTimeout(500);
  }
  if (!gammaDone()) {
    throw new Error("The post-/clear run did not complete.");
  }
  await page.locator(".turn-card .turn-body", { hasText: "CODEWORD_GAMMA" }).waitFor({
    state: "visible",
  });

  const alphaSourcesAfterClear = readSources(alpha.task.id);
  const alphaRefAfterClear = readManifest(alpha.task.id)?.task?.providerSessionRef ?? null;
  const clearTip = alphaSourcesAfterClear.at(-1) ?? null;
  const rebindCoherent =
    alphaSourcesAfterClear.length === 2 &&
    Boolean(clearTip) &&
    clearTip.providerSessionId === alphaRefAfterClear &&
    alphaRefAfterClear !== alphaRef;

  const filesOnDisk =
    fs.existsSync(path.join(sharedFolder, "alpha_only.md")) &&
    fs.existsSync(path.join(sharedFolder, "beta_only.md")) &&
    fs.existsSync(path.join(sharedFolder, "gamma_only.md"));

  const success = bindingsDistinct && composerIsolated && rebindCoherent && filesOnDisk;
  console.log(
    JSON.stringify(
      {
        workspaceRoot,
        sharedFolder,
        alphaTask: alpha.task.id,
        betaTask: beta.task.id,
        alphaRef,
        betaRef,
        alphaSourcePaths: alphaSources.map((source) => source.path),
        betaSourcePaths: betaSources.map((source) => source.path),
        bindingsDistinct,
        draftOnAlpha,
        draftOnBeta,
        draftBackOnAlpha,
        composerIsolated,
        alphaRefAfterClear,
        clearTipSessionId: clearTip?.providerSessionId ?? null,
        alphaSourcesAfterClear: alphaSourcesAfterClear.map((source) => source.providerSessionId),
        rebindCoherent,
        filesOnDisk,
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
  fs.rmSync(sharedFolder, { recursive: true, force: true });
}

function recordDir(taskId) {
  return path.join(workspaceRoot, "data", "projects", taskId);
}

function readReport(taskId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(recordDir(taskId), "runtime-report.json"), "utf8"));
  } catch {
    return null;
  }
}

function latestRun(taskId) {
  return readReport(taskId)?.runs?.at(-1) ?? null;
}

function runCompleted(taskId) {
  return latestRun(taskId)?.status === "completed";
}

function readManifest(taskId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(recordDir(taskId), "task.json"), "utf8"));
  } catch {
    return null;
  }
}

function readSources(taskId) {
  try {
    return (
      JSON.parse(fs.readFileSync(path.join(recordDir(taskId), "transcript-sources.json"), "utf8"))?.sources ?? []
    );
  } catch {
    return [];
  }
}
