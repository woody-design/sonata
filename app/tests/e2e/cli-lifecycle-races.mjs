// Slice 3 concurrency matrix: the first synchronous lifecycle claim owns task
// creation. While taskCreate is deliberately held at the main-process IPC
// boundary, Composer submit, task selection, New task, and attachment intake
// must all fail closed without moving or materializing the captured draft.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { activeSessionTaskId } from "./helpers/session.mjs";
import { installFakeCli } from "./helpers/fake-cli.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-cli-lifecycle-races-"));
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
  `${JSON.stringify({ defaultPermissionMode: "default", defaultRemoteControl: false }, null, 2)}\n`,
);
fs.writeFileSync(imagePath, redPngBytes());
installFakeCli(fakeBin, "claude", {
  readyOutput: "Fake Claude ready\n❯ opus xhigh ~\n",
  records: ["spawned", "stdin"],
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
      SONATA_TEST_TASK_CREATE_DELAY_MS: "700",
      SONATA_NOTIFICATIONS: "0",
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
  const main = await app.firstWindow();
  const cli = await waitForWindow(app, (page) => page.url().endsWith("/terminal.html"));
  main.setDefaultTimeout(20_000);
  cli.setDefaultTimeout(20_000);
  await main.locator(".task-entry-panel").waitFor({ state: "visible" });

  // Seed a selectable task so the held create can also exercise attempted
  // owner switching. The same deterministic delay applies; no timing guess is
  // involved in either create.
  await chooseProject(main);
  await waitForCliActionReady(cli, "Start CLI");
  await cli.locator("#terminal-empty-action", { hasText: "Start CLI" }).click();
  const baselineTaskId = await waitForActiveTask(main);
  await waitFor(() => fs.existsSync(runtimeMarker(baselineTaskId)), "baseline spawn");

  await main.locator("#sidebar-new-chat").click();
  await main.locator(".task-entry-panel").waitFor({ state: "visible" });
  await chooseProject(main);
  const cliOwnedDraft = "CLI OWNS THIS DRAFT";
  await addBitmapDraft(main, cliOwnedDraft);
  const taskIdsBeforeRace = listTaskIds();

  await cli.evaluate(() =>
    window.sonataRuntime.requestCliAction({ action: "start", expectedTaskId: null }),
  );
  await main.locator("#prompt-input:disabled").waitFor({ state: "visible" });

  const frozenState = {
    promptDisabled: await main.locator("#prompt-input").isDisabled(),
    addDisabled: await main.locator("#add-attachment").isDisabled(),
    sendDisabled: await main.locator("#send-prompt").isDisabled(),
    newTaskDisabled: await main.locator("#sidebar-new-chat").isDisabled(),
    baselineDisabled: await main
      .locator(`.sidebar-session[data-task-id="${baselineTaskId}"] .sidebar-session-button`)
      .isDisabled(),
  };

  // Deliver the competing intents at the DOM boundary even though ordinary
  // pointer/keyboard input is disabled. The flow guards must still reject
  // them, which protects programmatic/accessibility callers as well as users.
  await main.locator("#composer").dispatchEvent("submit");
  await main
    .locator(`.sidebar-session[data-task-id="${baselineTaskId}"] .sidebar-session-button`)
    .dispatchEvent("click");
  await main.locator("#sidebar-new-chat").dispatchEvent("click");
  await dispatchBitmapPaste(main);

  const stayedOnFreshOwnerDuringCreate =
    (await main.locator(".sidebar-session.active").count()) === 0 &&
    (await main.locator("#prompt-input").inputValue()) === cliOwnedDraft &&
    (await main.locator(".attachment-chip").count()) === 1;

  const cliOwnedTaskId = await waitForActiveTask(main);
  await waitFor(() => fs.existsSync(runtimeMarker(cliOwnedTaskId)), "CLI-owned spawn");
  const cliOwnedRecord = readRecord(cliOwnedTaskId);
  const cliOwnedOwnership = await readOwnership(main);
  const taskIdsAfterCliRace = listTaskIds();

  // Reverse the winner: Composer claims the lifecycle first, then CLI Start
  // arrives while taskCreate is held. Exactly one task is created and its
  // first user message is delivered normally.
  await main.locator("#sidebar-new-chat").click();
  await main.locator(".task-entry-panel").waitFor({ state: "visible" });
  await chooseProject(main);
  const composerOwnedPrompt = "COMPOSER OWNS THIS START";
  await main.locator("#prompt-input").fill(composerOwnedPrompt);
  await main.locator("#composer").dispatchEvent("submit");
  await main.locator("#prompt-input:disabled").waitFor({ state: "visible" });
  await cli.evaluate(() =>
    window.sonataRuntime.requestCliAction({ action: "start", expectedTaskId: null }),
  );
  const composerOwnedTaskId = await waitForActiveTask(main);
  await waitFor(
    () => readRecord(composerOwnedTaskId).runs.some((run) => run.prompt.includes(composerOwnedPrompt)),
    "Composer-owned prompt delivery",
  );
  const composerOwnedRecord = readRecord(composerOwnedTaskId);
  const taskIdsAfterComposerRace = listTaskIds();

  const checks = {
    allOwnershipControlsFrozen: Object.values(frozenState).every(Boolean),
    competingActionsRejectedDuringCreate:
      stayedOnFreshOwnerDuringCreate &&
      cliOwnedOwnership.text === cliOwnedDraft &&
      cliOwnedOwnership.attachmentCount === 1,
    cliClaimCreatedExactlyOneTask:
      taskIdsAfterCliRace.length === taskIdsBeforeRace.length + 1 &&
      new Set(taskIdsAfterCliRace).size === taskIdsAfterCliRace.length,
    cliClaimDidNotDeliverOrMaterializeDraft:
      cliOwnedRecord.runs.length === 0 &&
      readStdin(cliOwnedTaskId).length === 0 &&
      attachmentBlobCount(cliOwnedTaskId) === 0,
    composerClaimCreatedExactlyOneTask:
      taskIdsAfterComposerRace.length === taskIdsAfterCliRace.length + 1 &&
      new Set(taskIdsAfterComposerRace).size === taskIdsAfterComposerRace.length,
    composerClaimDeliveredItsPromptOnce:
      composerOwnedRecord.runs.filter((run) => run.prompt.includes(composerOwnedPrompt)).length === 1 &&
      occurrences(readStdin(composerOwnedTaskId), composerOwnedPrompt) === 1,
  };
  const success = Object.values(checks).every(Boolean);
  console.log(
    JSON.stringify(
      {
        success,
        checks,
        frozenState,
        stayedOnFreshOwnerDuringCreate,
        cliOwnedOwnership,
        baselineTaskId,
        cliOwnedTaskId,
        composerOwnedTaskId,
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

async function chooseProject(page) {
  await page.locator("#project-chip").click();
  await page.locator("#entry-choose-folder").click();
  await page.locator("#project-chip", { hasText: path.basename(project) }).waitFor({ state: "visible" });
}

async function addBitmapDraft(page, text) {
  setClipboardImage();
  await page.locator("#prompt-input").fill(text);
  await page.locator("#prompt-input").click();
  await page.keyboard.press("Meta+V");
  await page.locator(".attachment-chip").waitFor({ state: "visible" });
}

async function dispatchBitmapPaste(page) {
  await page.locator("#composer").evaluate((composer) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], "blocked.png", { type: "image/png" }));
    composer.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }),
    );
  });
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

function readRecord(taskId) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(taskRecordRoot(taskId), "runtime-report.json"), "utf8"),
    );
  } catch {
    return { runs: [] };
  }
}

function readStdin(taskId) {
  try {
    return fs.readFileSync(path.join(runtimeRoot(taskId), "stdin.bin"), "utf8");
  } catch {
    return "";
  }
}

function taskRecordRoot(taskId) {
  return path.join(dataRoot, "data", "projects", taskId);
}

function runtimeRoot(taskId) {
  return path.join(dataRoot, "data", "runtime", taskId);
}

function runtimeMarker(taskId) {
  return path.join(runtimeRoot(taskId), "spawned");
}

function listTaskIds() {
  const projectsRoot = path.join(dataRoot, "data", "projects");
  try {
    return fs
      .readdirSync(projectsRoot)
      .filter((entry) => fs.existsSync(path.join(projectsRoot, entry, "task.json")));
  } catch {
    return [];
  }
}

function attachmentBlobCount(taskId) {
  try {
    return fs.readdirSync(path.join(dataRoot, "data", "attachments", taskId)).length;
  } catch {
    return 0;
  }
}

function occurrences(value, needle) {
  return value.split(needle).length - 1;
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
