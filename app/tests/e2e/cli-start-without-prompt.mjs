// Slice 3: Start CLI creates an empty live task from the fully projected New
// task settings, without delivering or materializing the Composer draft. Both
// provider edges are exercised through real PTYs backed by deterministic fake
// binaries. This also fences single-flight (two CLI intents → one task) and
// draft/attachment ownership across two simultaneously open tasks.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { activeSessionTaskId, chooseDraftProvider } from "./helpers/session.mjs";
import { installFakeCli } from "./helpers/fake-cli.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-cli-start-"));
const dataRoot = path.join(root, "data-root");
const settingsDir = path.join(root, "settings");
const fakeBin = path.join(root, "bin");
const project = path.join(root, "project");
const imagePath = path.join(root, "draft.png");
for (const dir of [settingsDir, fakeBin, project]) {
  fs.mkdirSync(dir, { recursive: true });
}
fs.writeFileSync(
  path.join(settingsDir, "claude-settings.json"),
  `${JSON.stringify({ defaultPermissionMode: "auto", defaultRemoteControl: true }, null, 2)}\n`,
);
fs.writeFileSync(
  path.join(settingsDir, "codex-settings.json"),
  // A LEGACY stored default (`-a never`) exercises the migration-on-read: it
  // maps to "approve-for-me" (never escalating) and that mode reaches the spawn.
  `${JSON.stringify({ defaultApprovalMode: "never" }, null, 2)}\n`,
);
fs.writeFileSync(imagePath, redPngBytes());
for (const provider of ["claude", "codex"]) {
  installFakeCli(fakeBin, provider, { records: ["spawn-record", "stdin"] });
}

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
  await waitForCliActionReady(cli, "Start CLI");

  const claudeDraft = "CLAUDE DRAFT — must remain unsent";
  await main.locator("#permission-chip", { hasText: "Auto" }).waitFor({ state: "visible" });
  await main.locator('#remote-control-toggle[aria-pressed="true"]').waitFor({ state: "visible" });
  await chooseProject(main);
  await chooseLaunchOption(main, "Model", "Sonnet 5");
  await chooseLaunchOption(main, "Reasoning", "High");
  await addBitmapDraft(main, claudeDraft);

  await cli.locator("#terminal-empty-action", { hasText: "Start CLI" }).click();
  const claudeTaskId = await waitForActiveTask(main);
  const claudeRecord = await waitForRecord(claudeTaskId);
  const claudeProjection = readProjection(claudeTaskId);
  const claudeOwnership = await readActiveOwnership(main);
  await cli.locator("#terminal-session-title", { hasText: claudeRecord.task.title }).waitFor({
    state: "visible",
  });
  const claudeTerminalTitle = (await cli.locator("#terminal-session-title").textContent())?.trim();

  // A second New task can start while Claude stays alive in the background.
  // Its draft must not inherit Claude's text/bitmap, and switching back later
  // must restore Claude's exact held ownership.
  await main.locator("#sidebar-new-chat").click();
  await main.locator(".task-entry-panel").waitFor({ state: "visible" });
  const freshDraftIsEmpty =
    (await main.locator("#prompt-input").inputValue()) === "" &&
    (await main.locator(".attachment-chip").count()) === 0;
  await chooseDraftProvider(main, "codex");
  await chooseProject(main);
  await chooseLaunchOption(main, "Model", "5.6 Luna");
  await chooseLaunchOption(main, "Reasoning", "High");
  await chooseLaunchOption(main, "Speed", "Fast");
  const codexDraft = "CODEX DRAFT — must remain unsent";
  await addBitmapDraft(main, codexDraft);
  await waitForCliActionReady(cli, "Start CLI");

  // Bypass the button's local double-click suppression and deliver two valid
  // intents over IPC. Reading's synchronous lifecycle claim must still create
  // exactly one task.
  await cli.evaluate(() =>
    Promise.all([
      window.sonataRuntime.requestCliAction({ action: "start", expectedTaskId: null }),
      window.sonataRuntime.requestCliAction({ action: "start", expectedTaskId: null }),
    ]),
  );
  const codexTaskId = await waitForActiveTask(main, claudeTaskId);
  const codexRecord = await waitForRecord(codexTaskId);
  const codexProjection = readProjection(codexTaskId);
  const codexOwnership = await readActiveOwnership(main);
  await cli.locator("#terminal-session-title", { hasText: codexRecord.task.title }).waitFor({
    state: "visible",
  });
  const codexTerminalTitle = (await cli.locator("#terminal-session-title").textContent())?.trim();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const taskIdsAfterDoubleStart = listTaskIds();

  // A stale Start intent while a task is selected is validly shaped but must
  // fail closed in Reading rather than create a third task.
  await cli.evaluate(() =>
    window.sonataRuntime.requestCliAction({ action: "start", expectedTaskId: null }),
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  const staleStartRejected = listTaskIds().length === 2;

  await main.locator(`.sidebar-session[data-task-id="${claudeTaskId}"] .sidebar-session-button`).click();
  const claudeOwnershipRestored = await readActiveOwnership(main);
  await main.locator(`.sidebar-session[data-task-id="${codexTaskId}"] .sidebar-session-button`).click();
  const codexOwnershipRestored = await readActiveOwnership(main);

  // Failed creation is the other ownership edge: an unrelated open task must
  // never receive this New task draft. Make the selected provider unspawnable,
  // verify the New task surface retains its draft/bitmap, visit an existing
  // task, then return and verify both owners are unchanged.
  await main.locator("#sidebar-new-chat").click();
  const projectsDataRoot = path.join(dataRoot, "data", "projects");
  fs.chmodSync(projectsDataRoot, 0o555);
  const failedDraft = "FAILED START DRAFT — keep with New task";
  await addBitmapDraft(main, failedDraft);
  const manifestsBeforeFailure = manifestTaskIds();
  await waitForCliActionReady(cli, "Start CLI");
  await cli.locator("#terminal-empty-action", { hasText: "Start CLI" }).click();
  await waitForCliActionReady(cli, "Start CLI");
  fs.chmodSync(projectsDataRoot, 0o755);
  const failedOwnership = await readActiveOwnership(main);
  const failedStartStayedFresh = await main.locator(".task-entry-panel").isVisible();
  const manifestsAfterFailure = manifestTaskIds();
  await main.locator(`.sidebar-session[data-task-id="${claudeTaskId}"] .sidebar-session-button`).click();
  const claudeAfterFailedStart = await readActiveOwnership(main);
  await main.locator("#sidebar-new-chat").click();
  const failedOwnershipRestored = await readActiveOwnership(main);

  const checks = {
    claudeLaunchProjection:
      claudeRecord.task.provider === "claude" &&
      claudeRecord.task.providerCwd === project &&
      claudeRecord.task.model === "sonnet" &&
      claudeRecord.task.reasoningEffort === "high" &&
      claudeRecord.task.permissionMode === "auto" &&
      claudeRecord.task.title === datedPlaceholder(claudeRecord.task) &&
      claudeRecord.task.titleOrigin === "automatic" &&
      claudeTerminalTitle === claudeRecord.task.title &&
      hasArgPair(claudeProjection.argv, "--permission-mode", "auto") &&
      hasArgPair(claudeProjection.argv, "--model", "sonnet") &&
      hasArgPair(claudeProjection.argv, "--effort", "high") &&
      claudeProjection.argv.at(-1) === "--remote-control" &&
      claudeProjection.sonataRuntimeDir === runtimeRoot(claudeTaskId),
    codexLaunchProjection:
      codexRecord.task.provider === "codex" &&
      codexRecord.task.providerCwd === project &&
      codexRecord.task.model === "gpt-5.6-luna" &&
      codexRecord.task.reasoningEffort === "high" &&
      codexRecord.task.speedMode === "fast" &&
      codexRecord.task.codexPermissionMode === "approve-for-me" &&
      codexTerminalTitle === codexRecord.task.title &&
      hasArgPair(codexProjection.argv, "-m", "gpt-5.6-luna") &&
      hasArgPair(codexProjection.argv, "-c", 'model_reasoning_effort="high"') &&
      hasArgPair(codexProjection.argv, "-c", 'service_tier="priority"') &&
      hasArgPair(codexProjection.argv, "-s", "workspace-write") &&
      hasArgPair(codexProjection.argv, "-a", "on-request") &&
      hasArgPair(codexProjection.argv, "-c", 'approvals_reviewer="auto_review"') &&
      codexProjection.sonataRuntimeDir === runtimeRoot(codexTaskId),
    claudeDraftNotDelivered:
      claudeOwnership.text === claudeDraft &&
      claudeOwnership.attachmentCount === 1 &&
      claudeRecord.task.title === datedPlaceholder(claudeRecord.task) &&
      claudeProjection.stdin.length === 0 &&
      claudeRecord.report.runs.length === 0 &&
      attachmentBlobCount(claudeTaskId) === 0,
    codexDraftNotDelivered:
      codexOwnership.text === codexDraft &&
      codexOwnership.attachmentCount === 1 &&
      codexRecord.task.title === datedPlaceholder(codexRecord.task) &&
      codexProjection.stdin.length === 0 &&
      codexRecord.report.runs.length === 0 &&
      attachmentBlobCount(codexTaskId) === 0,
    freshDraftIsEmpty,
    ownershipRestoresPerTask:
      claudeOwnershipRestored.text === claudeDraft &&
      claudeOwnershipRestored.attachmentCount === 1 &&
      codexOwnershipRestored.text === codexDraft &&
      codexOwnershipRestored.attachmentCount === 1,
    doubleStartSingleFlight:
      taskIdsAfterDoubleStart.length === 2 &&
      new Set(taskIdsAfterDoubleStart).size === 2,
    staleStartRejected,
    failedStartPreservesOwnership:
      failedStartStayedFresh &&
      failedOwnership.text === failedDraft &&
      failedOwnership.attachmentCount === 1 &&
      failedOwnershipRestored.text === failedDraft &&
      failedOwnershipRestored.attachmentCount === 1 &&
      claudeAfterFailedStart.text === claudeDraft &&
      claudeAfterFailedStart.attachmentCount === 1 &&
      manifestsAfterFailure.length === manifestsBeforeFailure.length &&
      manifestsAfterFailure.every((taskId) => manifestsBeforeFailure.includes(taskId)),
  };
  const success = Object.values(checks).every(Boolean);
  console.log(
    JSON.stringify(
      { success, checks, claudeTaskId, codexTaskId, claudeArgs: claudeProjection.argv, codexArgs: codexProjection.argv },
      null,
      2,
    ),
  );
  process.exitCode = success ? 0 : 1;
} finally {
  await app?.close();
  try {
    fs.chmodSync(path.join(dataRoot, "data", "projects"), 0o755);
  } catch {
    // The directory may not exist if launch failed before its first task.
  }
  fs.rmSync(root, { recursive: true, force: true });
}

function datedPlaceholder(task) {
  const date = new Date(task.createdAt);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}${day}-New task`;
}

async function chooseProject(page) {
  await page.locator("#project-chip").click();
  await page.locator("#entry-choose-folder").click();
  await page.locator("#project-chip", { hasText: path.basename(project) }).waitFor({ state: "visible" });
}

async function chooseLaunchOption(page, heading, label) {
  const section = () => page.locator(".task-setting-section", { hasText: heading });
  if (!(await section().isVisible().catch(() => false))) {
    await page.locator("#model-chip").click();
  }
  await section().getByRole("menuitemradio", { name: label, exact: true }).click();
}

async function addBitmapDraft(page, text) {
  setClipboardImage();
  await page.locator("#prompt-input").fill(text);
  await page.locator("#prompt-input").click();
  await page.keyboard.press("Meta+V");
  await page.locator(".attachment-chip").waitFor({ state: "visible" });
}

function setClipboardImage() {
  const scriptPath = path.join(root, "set-clipboard.applescript");
  fs.writeFileSync(
    scriptPath,
    `set the clipboard to (read (POSIX file ${JSON.stringify(imagePath)}) as «class PNGf»)\n`,
  );
  execFileSync("osascript", [scriptPath]);
}

async function waitForCliActionReady(page, text) {
  const button = page.locator("#terminal-empty-action", { hasText: text });
  await button.waitFor({ state: "visible" });
  await page.locator("#terminal-empty-action:not(:disabled)", { hasText: text }).waitFor({
    state: "visible",
  });
}

async function waitForActiveTask(page, previousTaskId = null) {
  await waitFor(async () => {
    const taskId = await activeSessionTaskId(page).catch(() => null);
    return Boolean(taskId && taskId !== previousTaskId);
  }, "active task");
  return activeSessionTaskId(page);
}

async function waitForRecord(taskId) {
  const recordRoot = taskRecordRoot(taskId);
  try {
    await waitFor(
      () =>
        fs.existsSync(path.join(recordRoot, "task.json")) &&
        fs.existsSync(path.join(recordRoot, "runtime-report.json")) &&
        fs.existsSync(path.join(runtimeRoot(taskId), "spawn-record.json")),
      `record for ${taskId}`,
    );
  } catch (error) {
    const runtimePath = runtimeRoot(taskId);
    const recordEntries = fs.existsSync(recordRoot) ? fs.readdirSync(recordRoot) : [];
    const runtimeEntries = fs.existsSync(runtimePath) ? fs.readdirSync(runtimePath) : [];
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} ` +
        `(record=${JSON.stringify(recordEntries)}, runtime=${JSON.stringify(runtimeEntries)})`,
    );
  }
  return {
    task: JSON.parse(fs.readFileSync(path.join(recordRoot, "task.json"), "utf8")).task,
    report: JSON.parse(fs.readFileSync(path.join(recordRoot, "runtime-report.json"), "utf8")),
  };
}

function readProjection(taskId) {
  const runtime = runtimeRoot(taskId);
  const spawn = JSON.parse(fs.readFileSync(path.join(runtime, "spawn-record.json"), "utf8"));
  return {
    ...spawn,
    stdin: fs.existsSync(path.join(runtime, "stdin.bin"))
      ? fs.readFileSync(path.join(runtime, "stdin.bin"))
      : Buffer.alloc(0),
  };
}

async function readActiveOwnership(page) {
  return {
    text: await page.locator("#prompt-input").inputValue(),
    attachmentCount: await page.locator(".attachment-chip").count(),
  };
}

function taskRecordRoot(taskId) {
  return path.join(dataRoot, "data", "projects", taskId);
}

function runtimeRoot(taskId) {
  return path.join(dataRoot, "data", "runtime", taskId);
}

function listTaskIds() {
  const rootPath = path.join(dataRoot, "data", "projects");
  try {
    return fs.readdirSync(rootPath).filter((name) => fs.statSync(path.join(rootPath, name)).isDirectory());
  } catch {
    return [];
  }
}

function manifestTaskIds() {
  return listTaskIds().filter((taskId) =>
    fs.existsSync(path.join(taskRecordRoot(taskId), "task.json")),
  );
}

function attachmentBlobCount(taskId) {
  try {
    return fs.readdirSync(path.join(dataRoot, "data", "attachments", taskId)).length;
  } catch {
    return 0;
  }
}

function hasArgPair(argv, flag, value) {
  return argv.some((item, index) => item === flag && argv[index + 1] === value);
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
