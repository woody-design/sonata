// X5 fix round (F1/F2): a codex spawn waiting out an in-flight codex auto-update
// does NOT freeze the app. Against the built app with fake `claude`/`codex` on
// PATH and the main-process update seam (SONATA_TEST_CODEX_UPDATE_SEAM, see
// main.ts `codexSpawnGateFor`) standing in for a running `brew upgrade`:
//
//   1. a New Chat on Codex, sent while the update runs, spawns NOTHING; its own
//      composer line says "Codex is updating…"; a second Send is a no-op;
//   2. meanwhile the user switches to an existing Claude session and SENDS there
//      — it reaches the CLI (the session-lifecycle lock is not held by the wait),
//      and that composer does not carry the codex line (the notice is per draft);
//   3. back on New Chat (still the Codex draft as sent: New Chat does not
//      re-seed a waiting draft) when the update ends, the held send goes
//      through: one codex spawn, the draft reaches the codex CLI exactly once.
//
// Fixture provenance: the fakes are the COMPOSED session species of
// helpers/fake-cli.mjs; the "update" is the COMPOSED env toggle the seam reads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { activeSessionTaskId, chooseDraftProvider, selectSidebarSession } from "./helpers/session.mjs";
import { installFakeCli } from "./helpers/fake-cli.mjs";

const UPDATING = "Codex is updating… The session starts when the update finishes.";
const CODEX_TEXT = "codex draft sent during the update";
const CLAUDE_TEXT = "claude send during the update";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-codex-update-wait-"));
const dataRoot = path.join(root, "data-root");
const settingsDir = path.join(root, "settings");
const fakeBin = path.join(root, "bin");
const project = path.join(root, "project");
for (const dir of [settingsDir, fakeBin, project]) {
  fs.mkdirSync(dir, { recursive: true });
}
fs.writeFileSync(
  path.join(settingsDir, "claude-settings.json"),
  `${JSON.stringify({ defaultPermissionMode: "default", defaultRemoteControl: false }, null, 2)}\n`,
);
installFakeCli(fakeBin, "claude", {
  readyOutput: "Fake Claude ready\n❯ opus xhigh ~\n",
  records: ["stdin"],
  promptHooks: true,
});
installFakeCli(fakeBin, "codex", { records: ["stdin", "spawned"] });

let app;
const checks = {};
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
      SONATA_TEST_CODEX_UPDATE_SEAM: "1",
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
  const main = await app.firstWindow();
  main.setDefaultTimeout(20_000);
  await main.locator(".task-entry-panel").waitFor({ state: "visible" });
  await chooseProject(main);

  // An existing Claude session to work in while codex updates.
  await chooseDraftProvider(main, "claude");
  await main.locator("#prompt-input").fill("claude first message");
  await main.keyboard.press("Enter");
  const claudeTaskId = await waitForActiveTask(main);
  await waitFor(() => readStdin(claudeTaskId).includes("claude first message"), "the claude session");

  // The update starts; a New Chat on Codex sends into it.
  await setMainProcessEnv(app, "SONATA_TEST_CODEX_UPDATE_RUNNING", "1");
  await main.locator("#sidebar-new-chat").click();
  await main.locator(".task-entry-panel").waitFor({ state: "visible" });
  await chooseDraftProvider(main, "codex");
  await main.locator("#prompt-input").fill(CODEX_TEXT);
  await main.locator("#send-prompt").click();
  checks.newChatSaysUpdating = await waitFor(async () => (await notice(main)) === UPDATING, "the updating line", false);
  await main.waitForTimeout(400);
  // A second Send of the same draft while it waits: a no-op.
  await main.locator("#send-prompt").click();
  await main.waitForTimeout(400);
  checks.nothingSpawnedWhileUpdating = codexSpawnCount() === 0;
  checks.draftKept = (await main.locator("#prompt-input").inputValue()) === CODEX_TEXT;

  // Meanwhile: another session works. The lifecycle lock is free.
  await selectSidebarSession(main, claudeTaskId);
  checks.switchedDuringUpdate = await waitFor(
    async () => (await activeSessionTaskId(main).catch(() => null)) === claudeTaskId,
    "switching to the claude session",
    false,
  );
  checks.otherComposerHasNoCodexLine = (await notice(main)) !== UPDATING;
  await main.locator("#prompt-input").fill(CLAUDE_TEXT);
  await main.keyboard.press("Enter");
  checks.otherSessionSendWorks = await waitFor(
    () => readStdin(claudeTaskId).includes(CLAUDE_TEXT),
    "the claude send during the update",
    false,
  );
  checks.stillNothingSpawned = codexSpawnCount() === 0;

  // Back to the waiting draft; the update ends; the held send goes through once.
  await main.locator("#sidebar-new-chat").click();
  await main.locator(".task-entry-panel").waitFor({ state: "visible" });
  checks.draftStillSaysUpdating = (await notice(main)) === UPDATING;
  // New Chat returns to the waiting draft as sent: no provider re-seed under it.
  checks.draftStillOnCodex =
    ((await main.locator("#provider-chip").textContent()) ?? "").includes("Codex") &&
    (await main.locator("#prompt-input").inputValue()) === CODEX_TEXT;
  await setMainProcessEnv(app, "SONATA_TEST_CODEX_UPDATE_RUNNING", null);
  checks.codexSpawnedAfterUpdate = await waitFor(() => codexSpawnCount() === 1, "the codex spawn", false);
  const codexTaskId = codexTaskIds()[0] ?? null;
  checks.codexDraftDeliveredOnce = await waitFor(
    () => occurrences(readStdin(codexTaskId), CODEX_TEXT) === 1,
    "the held codex draft",
    false,
  );
  await main.waitForTimeout(800);
  checks.exactlyOneCodexSpawn = codexSpawnCount() === 1 && occurrences(readStdin(codexTaskId), CODEX_TEXT) === 1;
  checks.claudeNeverGotCodexDraft = !readStdin(claudeTaskId).includes(CODEX_TEXT);

  const success = Object.values(checks).every(Boolean);
  const debug = {
    chip: await main.locator("#provider-chip").textContent().catch(() => null),
    input: await main.locator("#prompt-input").inputValue().catch(() => null),
    notice: await notice(main),
    runtimeDirs: fs.existsSync(path.join(dataRoot, "data", "runtime")) ? fs.readdirSync(path.join(dataRoot, "data", "runtime")) : [],
  };
  console.log(JSON.stringify({ success, checks, ...(success ? {} : { debug }) }, null, 2));
  process.exitCode = success ? 0 : 1;
} catch (error) {
  console.error(JSON.stringify({ success: false, checks, error: String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  await app?.close();
  fs.rmSync(root, { recursive: true, force: true });
}

async function notice(page) {
  const hidden = await page.locator("#runtime-status").evaluate((el) => el.classList.contains("hidden"));
  return hidden ? "" : ((await page.locator("#runtime-status").textContent()) ?? "").trim();
}

function runtimeRoot(taskId) {
  return path.join(dataRoot, "data", "runtime", taskId);
}

function readStdin(taskId) {
  if (!taskId) {
    return "";
  }
  try {
    return fs.readFileSync(path.join(runtimeRoot(taskId), "stdin.bin"), "utf8");
  } catch {
    return "";
  }
}

/** Runtime dirs whose fake CLI announced itself as codex (the codex fake records
 *  `spawned`; the claude fake does not). */
function codexTaskIds() {
  const dir = path.join(dataRoot, "data", "runtime");
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((entry) => fs.existsSync(path.join(dir, entry, "spawned")));
}

function codexSpawnCount() {
  return codexTaskIds().length;
}

function occurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
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

async function chooseProject(page) {
  await page.locator("#project-chip").click();
  await page.locator("#entry-choose-folder").click();
  await page.locator("#project-chip", { hasText: path.basename(project) }).waitFor({ state: "visible" });
}

async function waitForActiveTask(page) {
  await waitFor(async () => Boolean(await activeSessionTaskId(page).catch(() => null)), "active task");
  return activeSessionTaskId(page);
}

async function waitFor(predicate, label, throwOnTimeout = true) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (throwOnTimeout) {
    throw new Error(`Timed out waiting for ${label}.`);
  }
  return false;
}
