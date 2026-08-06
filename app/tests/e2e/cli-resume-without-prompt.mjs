// Slice 3 + Slice C: Resume task reuses Sonata's prepare/choice/open lifecycle.
// This pins the full/summary × sendAfterResume true/false matrix, ownership, and
// lifecycle release after preparation/open/settings failures. Slice C (D3)
// de-modalized the choice: it is pure view state holding no lifecycle claim, so
// the app stays fully interactive while it is pending — this test also asserts
// the composer + New task stay ENABLED, that switching away hides the panel and
// returning shows it intact, and that WYSIWYG applies to the confirm (a
// sendAfterResume=true choice sends the composer's CURRENT text; a =false choice
// sends nothing even if text is typed mid-choice). Double-click protection is now
// the fresh SYNCHRONOUS claim in resolveResumeChoice, not a held claim.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { activeSessionTaskId } from "./helpers/session.mjs";
import { installFakeCli } from "./helpers/fake-cli.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-cli-resume-"));
const dataRoot = path.join(root, "data-root");
const settingsDir = path.join(root, "settings");
const fakeBin = path.join(root, "bin");
const project = path.join(root, "project");
const imagePath = path.join(root, "draft.png");
const evidenceDir = process.argv[2] ? path.resolve(process.argv[2]) : null;
for (const dir of [settingsDir, fakeBin, project]) {
  fs.mkdirSync(dir, { recursive: true });
}
if (evidenceDir) {
  fs.mkdirSync(evidenceDir, { recursive: true });
}
writeResumePolicy("summary");
fs.writeFileSync(
  path.join(settingsDir, "claude-settings.json"),
  `${JSON.stringify({ defaultPermissionMode: "default", defaultRemoteControl: false }, null, 2)}\n`,
);
fs.writeFileSync(imagePath, redPngBytes());
installFakeCli(fakeBin, "claude", {
  readyOutput: "Fake Claude ready\n❯ opus xhigh ~\n",
  records: ["spawn-count", "spawn-argv", "stdin"],
});

let app;
try {
  app = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      SONATA_DATA_DIR: dataRoot,
      SONATA_WORKSPACES_DIR: path.join(root, "workspaces"),
      SONATA_SETTINGS_DIR: settingsDir,
      SONATA_TEST_PICK_FOLDER: project,
      SONATA_NOTIFICATIONS: "0",
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
  const main = await app.firstWindow();
  const cli = await waitForWindow(app, (page) => page.url().endsWith("/terminal.html"));
  main.setDefaultTimeout(20_000);
  cli.setDefaultTimeout(20_000);
  await main.locator(".task-entry-panel").waitFor({ state: "visible" });
  await main.locator("#project-chip").click();
  await main.locator("#entry-choose-folder").click();

  const heldDraft = "HELD RESUME DRAFT — never send this";
  // Distinct markers typed INTO the composer while a choice is pending, to pin
  // WYSIWYG: the false-intent edit must never reach stdin; the true-intent edit
  // is exactly what confirm delivers.
  const falseEdit = "FALSE-INTENT MID-CHOICE EDIT — must never send";
  const trueEdit = "TRUE-INTENT MID-CHOICE EDIT — this one must send";
  setClipboardImage();
  await main.locator("#prompt-input").fill(heldDraft);
  await main.locator("#prompt-input").click();
  await main.keyboard.press("Meta+V");
  await main.locator(".attachment-chip").waitFor({ state: "visible" });

  await waitForCliActionReady(cli, "Start CLI");
  await cli.locator("#terminal-empty-action", { hasText: "Start CLI" }).click();
  const taskId = await waitForActiveTask(main);
  await waitFor(() => spawnCount(taskId) === 1, "initial Claude spawn");
  const initialDraftOwnership = await readOwnership(main);
  const initialReport = readReport(taskId);

  await main.evaluate((id) => window.sonataRuntime.closeTask({ taskId: id }), taskId);
  await waitForCliActionReady(cli, "Resume task");
  if (evidenceDir) {
    await cli.screenshot({
      path: path.join(evidenceDir, "dormant-cli.png"),
      animations: "disabled",
    });
  }
  writeLargeDormantTranscript(taskId);

  // Policy=summary + over-threshold transcript: resume immediately, enqueue
  // only the system /compact operation, and never touch the user draft.
  await cli.locator("#terminal-empty-action", { hasText: "Resume task" }).click();
  await waitFor(() => spawnCount(taskId) === 2, "summary resume spawn");
  await waitFor(
    () => readReport(taskId).runs.some((run) => run.prompt === "/compact"),
    "summary /compact run",
  );
  // Run persistence precedes the PTY write by design. Wait on the second side
  // of the invariant before freezing evidence, then keep the exact-one assert
  // below so a duplicate delivery still fails rather than satisfying the wait.
  await waitFor(
    () => occurrences(readStdin(taskId), "/compact") >= 1,
    "summary /compact stdin delivery",
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  const summaryReport = readReport(taskId);
  const summaryStdin = readStdin(taskId);
  const summaryOwnership = await readOwnership(main);
  const summaryAttachmentBlobCount = attachmentBlobCount(taskId);
  await completeTurn(taskId, "summary-no-prompt", "/compact");

  // Return dormant, switch to policy=ask, and prove stale/double intents cannot
  // bypass the choice or open more than one generation.
  await main.evaluate((id) => window.sonataRuntime.closeTask({ taskId: id }), taskId);
  await waitForCliActionReady(cli, "Resume task");
  writeResumePolicy("ask");

  await cli.evaluate(() =>
    window.sonataRuntime.requestCliAction({ action: "resume", expectedTaskId: "stale-task" }),
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  const staleResumeRejected = spawnCount(taskId) === 2;

  await cli.locator("#terminal-empty-action", { hasText: "Resume task" }).click();
  await main.locator("#resume-choice").waitFor({ state: "visible" });
  if (evidenceDir) {
    await Promise.all([
      cli.screenshot({
        path: path.join(evidenceDir, "resume-choice-cli.png"),
        animations: "disabled",
      }),
      main.screenshot({
        path: path.join(evidenceDir, "resume-choice-reading.png"),
        animations: "disabled",
      }),
    ]);
  }
  const choiceDidNotSpawn = spawnCount(taskId) === 2;
  // A second CLI resume intent DURING a pending choice still spawns nothing —
  // now because the choice holds no claim, so the intent simply re-runs
  // prepareResume, gets needsChoice again, and re-sets the same view choice
  // (not because a held claim blocks it). The lifecycle is idle throughout.
  await cli.evaluate((id) =>
    window.sonataRuntime.requestCliAction({ action: "resume", expectedTaskId: id }),
    taskId,
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  const secondResumeIgnoredDuringChoice = spawnCount(taskId) === 2;

  // D3 de-modalization: while the choice is pending the app stays fully
  // interactive — the composer and the sidebar New task button are ENABLED (the
  // old app-modal lock disabled both).
  const composerEnabledDuringChoice = await main
    .locator("#prompt-input:not(:disabled)")
    .isVisible();
  const newTaskEnabledDuringChoice = await main
    .locator("#sidebar-new-chat:not(:disabled)")
    .isVisible();

  // FINDING 1 (remember-checkbox leak): the shared #resume-remember check must
  // not survive a change in the panel's task identity. Check it on the parked
  // choice, then abandon-and-return; it must arrive UNCHECKED, and the abandoned
  // check must have written NO resume policy.
  await main.locator("#resume-remember").check();
  const policyBeforeAbandon = readResumePolicy();

  // Abandon-and-return: switching away (the New task surface stands in for
  // "another task" — the panel is per-view state) HIDES the panel; returning to
  // the dormant session shows it again, intact and interactive. No spawn either way.
  await main.locator("#sidebar-new-chat").click();
  await main.locator("#resume-choice").waitFor({ state: "hidden" });
  const panelHidAfterSwitchAway = await main.locator("#resume-choice").isHidden();
  await main.locator(`.sidebar-session[data-task-id="${taskId}"] .sidebar-session-button`).click();
  await main.locator("#resume-choice").waitFor({ state: "visible" });
  const panelIntactAfterReturn =
    (await main.locator("#resume-choice").isVisible()) &&
    (await main.locator("#resume-full:not(:disabled)").isVisible()) &&
    (await main.locator("#resume-summary:not(:disabled)").isVisible());
  const abandonReturnDidNotSpawn = spawnCount(taskId) === 2;
  const rememberResetOnReturn = !(await main.locator("#resume-remember").isChecked());
  const abandonedRememberWroteNoPolicy = readResumePolicy() === policyBeforeAbandon;

  // WYSIWYG does NOT apply to a sendAfterResume=false choice: type into the
  // composer mid-choice, then confirm full — nothing the user typed may reach
  // stdin, and the draft/attachment stay put (the no-prompt invariant).
  await main.locator("#prompt-input").fill(falseEdit);
  // Two same-tick clicks exercise the fresh SYNCHRONOUS claim in
  // resolveResumeChoice: the first click claims `resuming` and nulls the choice;
  // the second finds no choice and returns, so only ONE openTask fires.
  // Remembering is deliberately rejected at IPC; that preference write is
  // best-effort and must not strand or suppress the chosen resume.
  await main.locator("#resume-remember").check();
  await setMainProcessEnv(app, "SONATA_TEST_RESUME_SETTINGS_WRITE_FAIL", "1");
  await main.locator("#resume-full").evaluate((button) => {
    button.click();
    button.click();
  });
  await waitFor(() => spawnCount(taskId) === 3, "full resume spawn");
  await setMainProcessEnv(app, "SONATA_TEST_RESUME_SETTINGS_WRITE_FAIL", null);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const fullReport = readReport(taskId);
  const fullStdin = readStdin(taskId);
  const fullOwnership = await readOwnership(main);
  const fullAttachmentBlobCount = attachmentBlobCount(taskId);
  const fullChoiceSpawnCount = spawnCount(taskId);
  const compactRuns = fullReport.runs.filter((run) => run.prompt === "/compact");
  const userDraftRuns = fullReport.runs.filter(
    (run) => run.prompt.includes(heldDraft) || run.prompt.includes(falseEdit),
  );
  const rememberFailureDidNotBlockResume =
    spawnCount(taskId) === 3 && readResumePolicy() === "ask";

  // sendAfterResume=true CHOICE (policy=ask): the composer-initiated send
  // converts into a choice; editing the composer mid-choice and confirming full
  // delivers the EDITED text exactly once (WYSIWYG APPLIES), with no /compact.
  await main.evaluate((id) => window.sonataRuntime.closeTask({ taskId: id }), taskId);
  await waitForCliActionReady(cli, "Resume task");
  writeResumePolicy("ask");
  await main.locator("#send-prompt:not(:disabled)").click();
  await main.locator("#resume-choice").waitFor({ state: "visible" });
  await main.locator("#prompt-input").fill(trueEdit);
  await main.locator("#resume-full").click();
  await waitFor(() => spawnCount(taskId) === 4, "full resume-and-send spawn");
  await waitFor(
    () => readReport(taskId).runs.some((run) => run.prompt.includes(trueEdit)),
    "full resume user run",
  );
  await completeTurn(taskId, "full-send", trueEdit);
  const fullSendReport = readReport(taskId);
  const fullSendStdin = readStdin(taskId);
  const fullSendOwnership = await readOwnership(main);

  // sendAfterResume=true, policy=summary: /compact is the first run and the
  // held user message is the next native queued turn. Simulated authoritative
  // Claude hooks close/start those two turns in their real order.
  const summarySendDraft = "SUMMARY RESUME THEN SEND THIS";
  await addBitmapDraft(main, summarySendDraft);
  await main.evaluate((id) => window.sonataRuntime.closeTask({ taskId: id }), taskId);
  await waitForCliActionReady(cli, "Resume task");
  writeResumePolicy("summary");
  const beforeSummarySend = readReport(taskId).runs.length;
  await main.locator("#send-prompt:not(:disabled)").click();
  await waitFor(() => spawnCount(taskId) === 5, "summary resume-and-send spawn");
  await waitFor(
    () => readReport(taskId).runs.length === beforeSummarySend + 1,
    "summary resume system run",
  );
  await completeTurn(taskId, "summary-compact", "/compact");
  await completeTurn(taskId, "summary-send", summarySendDraft);
  const summarySendReport = readReport(taskId);
  const summarySendStdin = readStdin(taskId);
  const summarySendOwnership = await readOwnership(main);
  const summarySendRuns = summarySendReport.runs.slice(beforeSummarySend);
  const summaryCompactStdinOffset = summarySendStdin.lastIndexOf("/compact");
  const summaryUserStdinOffset = summarySendStdin.indexOf(summarySendDraft);

  // openTask rejection happens after preparation has succeeded and the
  // lifecycle has advanced to resuming. It must still return to a retryable
  // dormant surface without creating another PTY generation or consuming the
  // non-empty draft/bitmap owner.
  const failureDraft = "FAILED RESUME DRAFT — preserve this";
  await addBitmapDraft(main, failureDraft);
  await main.evaluate((id) => window.sonataRuntime.closeTask({ taskId: id }), taskId);
  await waitForCliActionReady(cli, "Resume task");
  const failureBaseline = readPersistenceCounts(taskId);
  await setMainProcessEnv(app, "SONATA_TEST_TASK_OPEN_FAIL", "1");
  await cli.locator("#terminal-empty-action", { hasText: "Resume task" }).click();
  await waitForCliActionReady(cli, "Resume task");
  await setMainProcessEnv(app, "SONATA_TEST_TASK_OPEN_FAIL", null);
  const openFailureOwnership = await readOwnership(main);
  const openFailureStayedDormant =
    spawnCount(taskId) === 5 &&
    openFailureOwnership.text === failureDraft &&
    openFailureOwnership.attachmentCount === 1 &&
    persistenceCountsEqual(readPersistenceCounts(taskId), failureBaseline);

  // Preparation errors are fail-closed. Corrupt the dormant manifest only for
  // this call so prepareResume rejects before openTask; restore it after the
  // retryable dormant surface returns.
  const manifestPath = path.join(taskRecordRoot(taskId), "task.json");
  const validManifest = fs.readFileSync(manifestPath, "utf8");
  fs.writeFileSync(manifestPath, "{ invalid resume manifest", "utf8");
  await cli.locator("#terminal-empty-action", { hasText: "Resume task" }).click();
  await waitForCliActionReady(cli, "Resume task");
  const preparationFailureOwnership = await readOwnership(main);
  const preparationFailureStayedDormant =
    spawnCount(taskId) === 5 &&
    preparationFailureOwnership.text === failureDraft &&
    preparationFailureOwnership.attachmentCount === 1 &&
    persistenceCountsEqual(readPersistenceCounts(taskId), failureBaseline);
  fs.writeFileSync(manifestPath, validManifest, "utf8");

  // FINDING 3 (parked choice armed after project archive): de-modalization lets
  // the user archive a project while one of its sessions holds a parked choice —
  // and openTask has no archived-project guard, so a stale confirm would respawn
  // inside the just-archived project. Archiving must disarm the choice. Refresh
  // the over-threshold source so the choice re-derives regardless of prior cycles.
  writeLargeDormantTranscript(taskId);
  writeResumePolicy("ask");
  await cli.locator("#terminal-empty-action", { hasText: "Resume task" }).click();
  await main.locator("#resume-choice").waitFor({ state: "visible" });
  const choiceArmedBeforeArchive =
    (await main.locator("#resume-choice").isVisible()) && spawnCount(taskId) === 5;
  // Archive through the REAL sidebar flow (right-click the project label →
  // "Archive project") so archiveProjectFromSidebar runs its choice-clearing.
  await main.locator(".sidebar-project-label").first().click({ button: "right" });
  await main
    .locator("#sidebar-menu-root .sidebar-menu-item", { hasText: "Archive project" })
    .click();
  await main.locator("#resume-choice").waitFor({ state: "hidden" });
  const archiveClearedChoice =
    (await main.locator("#resume-choice").isHidden()) &&
    (await main.locator("#resume-full").isHidden()) &&
    spawnCount(taskId) === 5;
  // Unarchive (raw IPC — unarchive has no renderer-side clearing to exercise) and
  // prove a fresh resume RE-DERIVES the choice; nothing was permanently lost.
  await main.evaluate(
    (p) => window.sonataRuntime.archiveProject({ path: p, archived: false }),
    path.resolve(project),
  );
  await waitForCliActionReady(cli, "Resume task");
  await cli.locator("#terminal-empty-action", { hasText: "Resume task" }).click();
  await main.locator("#resume-choice").waitFor({ state: "visible" });
  const unarchiveResumeRederivedChoice =
    (await main.locator("#resume-choice").isVisible()) && spawnCount(taskId) === 5;

  const checks = {
    initialStartHadNoRun: initialReport.runs.length === 0,
    initialOwnershipHeld:
      initialDraftOwnership.text === heldDraft && initialDraftOwnership.attachmentCount === 1,
    summaryExactlyOneSystemRun:
      summaryReport.runs.length === 1 &&
      summaryReport.runs[0]?.prompt === "/compact" &&
      summaryReport.runs[0]?.kind === "slash" &&
      occurrences(summaryStdin, "/compact") === 1,
    summaryDidNotDeliverUserDraft:
      !summaryStdin.includes(heldDraft) &&
      summaryOwnership.text === heldDraft &&
      summaryOwnership.attachmentCount === 1 &&
      summaryAttachmentBlobCount === 0,
    staleResumeRejected,
    choiceDidNotSpawn,
    secondResumeIgnoredDuringChoice,
    composerEnabledDuringChoice,
    newTaskEnabledDuringChoice,
    panelHidAfterSwitchAway,
    panelIntactAfterReturn,
    abandonReturnDidNotSpawn,
    rememberResetOnReturn,
    abandonedRememberWroteNoPolicy,
    choiceArmedBeforeArchive,
    archiveClearedChoice,
    unarchiveResumeRederivedChoice,
    fullChoiceSingleFlight: fullChoiceSpawnCount === 3,
    rememberFailureDidNotBlockResume,
    fullResumeAddedNoRun:
      compactRuns.length === 1 && userDraftRuns.length === 0 && fullReport.runs.length === 1,
    fullResumeDidNotDeliverUserDraft:
      !fullStdin.includes(heldDraft) &&
      !fullStdin.includes(falseEdit) &&
      occurrences(fullStdin, "/compact") === 1 &&
      fullOwnership.text === falseEdit &&
      fullOwnership.attachmentCount === 1 &&
      fullAttachmentBlobCount === 0,
    fullSendDeliveredUserWithoutCompact:
      fullSendReport.runs.length === fullReport.runs.length + 1 &&
      fullSendReport.runs.at(-1)?.prompt.includes(trueEdit) &&
      fullSendReport.runs.at(-1)?.status === "completed" &&
      fullSendReport.runs.filter((run) => run.prompt === "/compact").length === 1 &&
      occurrences(fullSendStdin, trueEdit) === 1 &&
      occurrences(fullSendStdin, "/compact") === 1,
    fullSendConsumedOwnership:
      fullSendOwnership.text === "" && fullSendOwnership.attachmentCount === 0,
    summarySendOrderedSystemThenUser:
      summarySendRuns.length === 2 &&
      summarySendRuns[0]?.prompt === "/compact" &&
      summarySendRuns[0]?.status === "completed" &&
      summarySendRuns[1]?.prompt.includes(summarySendDraft) &&
      summarySendRuns[1]?.status === "completed" &&
      occurrences(summarySendStdin, "/compact") === 2 &&
      occurrences(summarySendStdin, summarySendDraft) === 1 &&
      summaryCompactStdinOffset >= 0 &&
      summaryCompactStdinOffset < summaryUserStdinOffset,
    summarySendConsumedOwnership:
      summarySendOwnership.text === "" && summarySendOwnership.attachmentCount === 0,
    openFailureStayedDormant,
    preparationFailureStayedDormant,
  };
  const success = Object.values(checks).every(Boolean);
  console.log(
    JSON.stringify(
      {
        success,
        checks,
        evidenceDir,
        taskId,
        firstSummary: {
          runs: summaryReport.runs.map((run) => ({
            kind: run.kind,
            prompt: run.prompt,
            status: run.status,
          })),
          compactStdinOccurrences: occurrences(summaryStdin, "/compact"),
        },
        runs: summarySendReport.runs.map((run) => ({ kind: run.kind, prompt: run.prompt, status: run.status })),
      },
      null,
      2,
    ),
  );
  process.exitCode = success ? 0 : 1;
} finally {
  await app?.close();
  fs.rmSync(root, { recursive: true, force: true });
}

function writeLargeDormantTranscript(taskId) {
  const transcriptPath = path.join(root, `${taskId}-large.jsonl`);
  const oldTimestamp = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "assistant",
      timestamp: oldTimestamp,
      message: {
        usage: {
          input_tokens: 101_000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 1_000,
        },
      },
    })}\n`,
  );
  const source = {
    sourceId: `claude:resume-${taskId}`,
    provider: "claude",
    format: "claude-session-jsonl",
    path: transcriptPath,
    providerSessionId: `resume-${taskId}`,
    locatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(taskRecordRoot(taskId), "transcript-sources.json"),
    `${JSON.stringify({
      schemaId: "sonata.transcript-sources.v1",
      version: 1,
      taskId,
      sources: [source],
    }, null, 2)}\n`,
  );
}

function writeResumePolicy(policy) {
  fs.writeFileSync(
    path.join(settingsDir, "resume-settings.json"),
    `${JSON.stringify({ policy }, null, 2)}\n`,
  );
}

function readResumePolicy() {
  return JSON.parse(fs.readFileSync(path.join(settingsDir, "resume-settings.json"), "utf8")).policy;
}

async function setMainProcessEnv(electronApp, key, value) {
  await electronApp.evaluate((_electron, entry) => {
    if (entry.value === null) {
      delete process.env[entry.key];
    } else {
      process.env[entry.key] = entry.value;
    }
  }, { key, value });
}

async function addBitmapDraft(page, text) {
  setClipboardImage();
  await page.locator("#prompt-input").fill(text);
  await page.locator("#prompt-input").click();
  await page.keyboard.press("Meta+V");
  await page.locator(".attachment-chip").waitFor({ state: "visible" });
}

async function completeTurn(taskId, turnId, prompt) {
  const startHook = emitHook(taskId, "UserPromptSubmit", {
    turn_id: turnId,
    prompt_id: turnId,
    prompt,
  });
  await waitFor(() => !fs.existsSync(startHook), `${turnId} start hook consumption`);
  const stopHook = emitHook(taskId, "Stop", {
    turn_id: turnId,
    prompt_id: turnId,
    stop_hook_active: false,
    last_assistant_message: "done",
  });
  await waitFor(() => !fs.existsSync(stopHook), `${turnId} stop hook consumption`);
  await waitFor(() => {
    const matching = readReport(taskId).runs.filter((run) => run.prompt.includes(prompt));
    return matching.at(-1)?.status === "completed";
  }, `${turnId} completed run`);
}

function emitHook(taskId, hookEventName, fields) {
  const hooksDir = path.join(runtimeRoot(taskId), "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  const sources = JSON.parse(
    fs.readFileSync(path.join(taskRecordRoot(taskId), "transcript-sources.json"), "utf8"),
  );
  const transcriptPath = sources.sources[0].path;
  const payload = {
    hook_event_name: hookEventName,
    session_id: `resume-${taskId}`,
    transcript_path: transcriptPath,
    cwd: project,
    model: "opus",
    permission_mode: "default",
    ...fields,
  };
  const sequence = `${Date.now().toString(36)}-${process.hrtime.bigint().toString(36)}-${hookEventName}`;
  const filePath = path.join(hooksDir, `hook-${sequence}.json`);
  fs.writeFileSync(`${filePath}.tmp`, JSON.stringify(payload), "utf8");
  fs.renameSync(`${filePath}.tmp`, filePath);
  return filePath;
}

async function waitForCliActionReady(page, text) {
  await page.locator("#terminal-empty-action:not(:disabled)", { hasText: text }).waitFor({
    state: "visible",
  });
}

async function waitForActiveTask(page) {
  await waitFor(() => activeSessionTaskId(page).then(Boolean).catch(() => false), "active task");
  return activeSessionTaskId(page);
}

async function readOwnership(page) {
  return {
    text: await page.locator("#prompt-input").inputValue(),
    attachmentCount: await page.locator(".attachment-chip").count(),
  };
}

function spawnCount(taskId) {
  try {
    return Number(fs.readFileSync(path.join(runtimeRoot(taskId), "spawn-count"), "utf8"));
  } catch {
    return 0;
  }
}

function readStdin(taskId) {
  try {
    return fs.readFileSync(path.join(runtimeRoot(taskId), "stdin.bin")).toString("utf8");
  } catch {
    return "";
  }
}

function readReport(taskId) {
  return JSON.parse(
    fs.readFileSync(path.join(taskRecordRoot(taskId), "runtime-report.json"), "utf8"),
  );
}

function attachmentBlobCount(taskId) {
  try {
    return fs.readdirSync(path.join(dataRoot, "data", "attachments", taskId)).length;
  } catch {
    return 0;
  }
}

function readPersistenceCounts(taskId) {
  return {
    runCount: readReport(taskId).runs.length,
    stdinBytes: Buffer.byteLength(readStdin(taskId)),
    attachmentBlobCount: attachmentBlobCount(taskId),
  };
}

function persistenceCountsEqual(actual, expected) {
  return (
    actual.runCount === expected.runCount &&
    actual.stdinBytes === expected.stdinBytes &&
    actual.attachmentBlobCount === expected.attachmentBlobCount
  );
}

function taskRecordRoot(taskId) {
  return path.join(dataRoot, "data", "projects", taskId);
}

function runtimeRoot(taskId) {
  return path.join(dataRoot, "data", "runtime", taskId);
}

function occurrences(value, needle) {
  return value.split(needle).length - 1;
}

function setClipboardImage() {
  const scriptPath = path.join(root, "set-clipboard.applescript");
  fs.writeFileSync(
    scriptPath,
    `set the clipboard to (read (POSIX file ${JSON.stringify(imagePath)}) as «class PNGf»)\n`,
  );
  execFileSync("osascript", [scriptPath]);
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function waitForWindow(electronApp, predicate) {
  let found = null;
  await waitFor(() => {
    found = electronApp.windows().find(predicate) ?? null;
    return Boolean(found);
  }, "CLI window");
  return found;
}

function redPngBytes() {
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAC0lEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64",
  );
}
