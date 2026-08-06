// Focus/flow S1 (review follow-up) — a view created for an ALREADY-BOOTED
// session learns the delivery state at creation.
//
// `delivery:state` events are deltas since S1: they fire when the delivery state
// actually changes. `view.deliveryState` has exactly one event writer
// (runtime-reducer.ts), so a view built AFTER a session's last real change would
// hold null forever — and null reads as "still booting" everywhere the composer
// speaks (selectors/composer.ts: the placeholder, the send title), so a healthy
// idle session would claim "Claude is starting — your message will send when
// it's ready" until the user sent something anyway. It also makes the view
// evictable (`deliveryState !== null` is the hold-guard in transitions/session).
//
// The fix is the other half of the delta contract: pull current state once at
// creation (SessionSnapshotResponse.delivery, straight off the controller),
// follow deltas after. This test drives the reachable path — the Reading window
// goes away while the session keeps running, and a FRESH renderer opens it:
//
//   1. start a session and let it settle (its last delivery change is behind it);
//   2. reload the renderer, which is a new renderer with no task views at all
//      (the main process, its runtimes and their controllers are untouched);
//   3. open the session from the sidebar → the view is built from the snapshot.
//
// The assertion is the user-visible consequence, not just the field: the
// reopened composer must read as the idle session it is. MEASURED against the
// un-seeded build, this test reports `bootLatched: null` on the snapshot and
// "Claude is starting — your message will send when it's ready" in a composer
// belonging to a session that booted, ran a turn and went idle minutes ago.
//
// Fixture provenance: none — no fabricated payloads. The session is a real
// (fake-CLI) boot, and the state under test is whatever the live controller
// actually holds.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { activeSessionTaskId } from "./helpers/session.mjs";
import { installFakeCli } from "./helpers/fake-cli.mjs";

/** What an idle, booted session with one run behind it says. Pre-fix, a view
 *  built from a snapshot said "Claude is starting — your message will send when
 *  it's ready" instead, forever. */
const IDLE_PLACEHOLDER = "Continue, correct, or redirect this Task";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-delivery-seed-"));
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
  echoStdin: true,
});

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
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
  const main = await app.firstWindow();
  main.setDefaultTimeout(20_000);
  await main.locator(".task-entry-panel").waitFor({ state: "visible" });
  await chooseProject(main);
  await main.locator("#prompt-input").click();
  await main.locator("#prompt-input").fill("boot this session");
  await main.keyboard.press("Enter");
  const taskId = await waitForActiveTask(main);
  await waitFor(() => readStdin(taskId).includes("boot this session"), "first delivery");
  // End the turn from the CLI's own Stop hook, so the session is IDLE when it is
  // reopened. This matters: an active run makes the composer speak from the run,
  // which would let this test pass without ever consulting the delivery state.
  fireHook(taskId, { hook_event_name: "Stop", session_id: "seed-session" });
  // Idle, with one run behind it, the composer reads "Continue, correct, or
  // redirect this Task" — the branch AFTER the bootLatched check, which is
  // exactly the branch this test needs the reopened view to reach.
  await waitFor(
    async () => (await placeholder(main)) === IDLE_PLACEHOLDER,
    "the idle composer",
  );
  checks.bootedSessionSpeaksNormally = true;

  // The Reading window goes away and comes back with no memory. The main
  // process — and this task's delivery controller, holding the state it last
  // published — is untouched, so nothing will re-announce anything.
  await main.reload();
  await main.locator("#sidebar").waitFor({ state: "visible" });
  checks.freshRendererHasNoView = (await main.evaluate(() => document.querySelector("#run-list .turn-card") !== null)) === false;

  // Open the still-live session from the sidebar: the view is built here.
  await main.locator(`.sidebar-session[data-task-id="${taskId}"]`).click();
  await waitFor(async () => (await activeSessionTaskId(main).catch(() => null)) === taskId, "the reopened session");

  const reopenedPlaceholder = await placeholder(main);
  const seeded = await main.evaluate(async (id) => {
    const snapshot = await window.sonataRuntime.readSession({ taskId: id });
    return { live: snapshot.live, bootLatched: snapshot.delivery?.bootLatched ?? null };
  }, taskId);

  checks.snapshotCarriesDeliveryState = seeded.live === true && seeded.bootLatched === true;
  // The consequence the user sees: an idle, booted session is described as idle,
  // not as one still starting up.
  checks.reopenedComposerIsHonest = reopenedPlaceholder === IDLE_PLACEHOLDER;

  const success = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({ success, checks, reopenedPlaceholder, seeded, taskId }, null, 2));
  process.exitCode = success ? 0 : 1;
} catch (error) {
  console.error(JSON.stringify({ success: false, checks, error: String(error) }, null, 2));
  process.exitCode = 1;
} finally {
  await app?.close();
  fs.rmSync(root, { recursive: true, force: true });
}

function placeholder(page) {
  return page.locator("#prompt-input").getAttribute("placeholder");
}

/** Write a hook payload the way Sonata's own sink does (tmp + rename into the
 *  task's runtime hooks dir), which is the only thing the watcher cares about. */
function fireHook(taskId, payload) {
  const hooksDir = path.join(dataRoot, "data", "runtime", taskId, "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  const file = path.join(
    hooksDir,
    `hook-${Date.now().toString(36)}-${process.hrtime.bigint().toString(36)}.json`,
  );
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(payload), "utf8");
  fs.renameSync(`${file}.tmp`, file);
}

async function chooseProject(page) {
  await page.locator("#project-chip").click();
  await page.locator("#entry-choose-folder").click();
  await page
    .locator("#project-chip", { hasText: path.basename(project) })
    .waitFor({ state: "visible" });
}

async function waitForActiveTask(page) {
  await waitFor(async () => Boolean(await activeSessionTaskId(page).catch(() => null)), "active task");
  return activeSessionTaskId(page);
}

function readStdin(taskId) {
  try {
    return fs.readFileSync(path.join(dataRoot, "data", "runtime", taskId, "stdin.bin"), "utf8");
  } catch {
    return "";
  }
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
