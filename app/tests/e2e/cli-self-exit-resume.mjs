// A pty that died on its own, and the very next send (F1 fix A).
//
// `view.live` is the renderer's mirror of the session index, and until this fix
// nothing cleared it when a pty exited: the mirror caught up ~150ms later, off the
// debounced index refresh that main's retire → manifest-persist triggers. For that
// gap Reading believed a dead session was alive, and a send landing in it took
// `submitPrompt`'s LIVE branch — surfacing a raw `TaskNotLiveError` in the composer
// notice instead of resuming the conversation. Filed as S4's out-of-scope 2, where
// it was also seen from the other side: the placeholder's `!view.live` arm was
// briefly unreachable, so the composer kept promising a boot that had already ended.
//
// ## Why this can be deterministic
//
// The gap is ~150 milliseconds, so racing it from the harness would be a coin flip.
// Instead the send is made from INSIDE the page's own `pty:exit` handler — the
// earliest moment a user's click could possibly land, i.e. the worst case rather
// than a sampled one. The app's handler is registered at boot and therefore runs
// first, so the reducer has already had its say by the time this one reads the DOM:
// what it observes is exactly what a user would have seen.
//
// ## The two blocks are the same reducer branch
//
// A user closing a session and a CLI dying on its own both arrive as `pty:exit`, so
// block B is the regression fence the fix owes the close path: the affordances a
// close produces must be exactly what they were, only sooner. Both blocks assert
// the whole loop — the composer's copy at the moment of death, a second spawn of the
// fake CLI, and the queued prompt arriving in it — because "no error appeared" alone
// would also be true of a send that silently went nowhere.
//
// Each block gets its OWN session, and that is forced rather than chosen: the prompt
// the first block delivers opens a run the fake never closes, and an active run
// outranks every placeholder the composer could otherwise show (S4's D-22).
//
// Deterministic by construction: the shared `helpers/fake-cli.mjs` fake claude (it
// answers the readiness probe, so no machine surface has anything to say), a session
// born through the CLI window's "Start CLI" (no prompt, no run, nothing to wait
// out), and a real SIGTERM from outside Sonata for the death — which is what makes
// it a self-inflicted exit and not a `sonataInitiated` teardown.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { installFakeCli } from "./helpers/fake-cli.mjs";

const DORMANT_PLACEHOLDER = "Message Claude — resumes this session";
const STARTING_PLACEHOLDER = "Claude is starting — your message will send when it's ready";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-self-exit-resume-"));
const dataRoot = path.join(root, "data-root");
const settingsDir = path.join(root, "settings");
const fakeBin = path.join(root, "bin");
const project = path.join(root, "project");
for (const dir of [settingsDir, fakeBin, project]) {
  fs.mkdirSync(dir, { recursive: true });
}
const fakeClaude = installFakeCli(fakeBin, "claude", {
  readyOutput: "Fake Claude ready\n❯ opus xhigh ~\n",
  records: ["spawn-count", "stdin"],
});

const observed = {};
let app = null;
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
  main.setDefaultTimeout(30_000);
  cli.setDefaultTimeout(30_000);
  await main.locator(".task-entry-panel").waitFor({ state: "visible" });

  // ── A. The CLI dies on its own, and the send in that instant resumes ───────
  const first = await startSessionWithoutPrompt(main, cli, { firstSession: true });
  const firstPrompt = "SENT IN THE GAP — must resume, never TaskNotLiveError";
  await main.locator("#prompt-input").fill(firstPrompt);
  await armSendOnPtyExit(main, first.taskId);
  killFakeCli(fakeClaude);
  observed.selfExit = await assertResumedAfterExit(main, first, firstPrompt, "the CLI's own death");

  // ── B. Regression: the user-closed path, which is the same branch ──────────
  const second = await startSessionWithoutPrompt(main, cli, { firstSession: false });
  const secondPrompt = "SENT RIGHT AFTER A CLOSE — the ordinary path, unchanged";
  await main.locator("#prompt-input").fill(secondPrompt);
  await armSendOnPtyExit(main, second.taskId);
  await main.evaluate(
    (id) => window.sonataRuntime.closeTask({ taskId: id }).catch(() => {}),
    second.taskId,
  );
  observed.userClosed = await assertResumedAfterExit(main, second, secondPrompt, "a user close");

  console.log(JSON.stringify({ ...observed, success: true }, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (app) {
    await app.close();
  }
  // Nothing should be left running, but a failed run must not leak the fake.
  try {
    execFileSync("pkill", ["-f", fakeClaude], { stdio: "ignore" });
  } catch {
    // pkill exits 1 when it matched nothing, which is the expected case.
  }
  fs.rmSync(root, { recursive: true, force: true });
}

/**
 * A session with no prompt: live, its boot latch still shut, no run in flight — the
 * plainest possible subject, and the state the composer's boot promise is written
 * for. Born through the CLI window, which is the one door that starts a session
 * without delivering anything.
 */
async function startSessionWithoutPrompt(main, cli, { firstSession }) {
  if (!firstSession) {
    // `startCliWithoutPrompt` fails closed while a task is selected, so hand the
    // window back to New Chat first.
    await main.locator("#sidebar-new-chat").click();
    await main.locator(".task-entry-panel").waitFor({ state: "visible" });
  }
  await cli.locator("#terminal-empty-action:not(:disabled)", { hasText: "Start CLI" }).waitFor();
  await cli.evaluate(() =>
    window.sonataRuntime.requestCliAction({ action: "start", expectedTaskId: null }),
  );
  const row = main.locator(".sidebar-session.active");
  await row.waitFor({ state: "visible" });
  const taskId = await row.getAttribute("data-task-id");
  assert.ok(taskId, "the started session has a task id");
  const runtimeDir = path.join(dataRoot, "data", "runtime", taskId);
  await waitUntil(() => readSpawnCount(runtimeDir) === 1, `the fake CLI's first spawn (${taskId})`);
  await main.locator("#prompt-input").waitFor({ state: "visible" });
  assert.equal(
    await placeholderOf(main),
    STARTING_PLACEHOLDER,
    "a live, unlatched session promises the boot it is still waiting for",
  );
  return { taskId, runtimeDir };
}

/**
 * The whole loop, from the instant of death: the composer already offering a resume,
 * the resume actually spawning the CLI again, the queued prompt arriving in that new
 * pty, and no liveness error anywhere. Pre-fix, the send took the LIVE branch and
 * none of the last three happened.
 */
async function assertResumedAfterExit(main, session, prompt, label) {
  const atDeath = await waitForProbe(main);
  assert.equal(atDeath.clickError, null, `${label}: the send click inside the handler threw nothing`);
  assert.equal(
    atDeath.placeholder,
    DORMANT_PLACEHOLDER,
    `${label}: at that instant the composer already offers the RESUME submitPrompt will take`,
  );
  assert.equal(
    atDeath.sendDisabled,
    false,
    `${label}: …with send still armed, so the click is a real send`,
  );
  await waitUntil(
    () => readSpawnCount(session.runtimeDir) === 2,
    `${label}: the resume to spawn the CLI a second time`,
    60_000,
  );
  await waitUntil(
    () => readStdin(session.runtimeDir).includes(prompt),
    `${label}: the prompt sent in the gap to reach the resumed pty`,
    60_000,
  );
  const notice = await noticeOf(main);
  assertNoLivenessError(notice, label);
  return { placeholderAtDeath: atDeath.placeholder, spawns: 2, delivered: true, notice };
}

/**
 * Send from inside the page's own `pty:exit` handler — the earliest instant a
 * user's click could land, and the one the ~150ms mirror lag used to swallow.
 * Records what the composer was showing at that instant, then clicks send.
 *
 * Registered AFTER the app's own handler (which is bound at boot), so the reducer
 * has already applied its mutations and the directive render has already run: the
 * DOM this reads is the DOM a user would have been looking at.
 */
async function armSendOnPtyExit(page, taskId) {
  await page.evaluate((id) => {
    window.__f1Probe = { fired: false, placeholder: null, sendDisabled: null, clickError: null };
    const dispose = window.sonataRuntime.onRuntimeEvent((event) => {
      if (event.type !== "pty:exit" || event.payload.taskId !== id || window.__f1Probe.fired) {
        return;
      }
      window.__f1Probe.fired = true;
      dispose();
      const input = document.getElementById("prompt-input");
      const send = document.getElementById("send-prompt");
      window.__f1Probe.placeholder = input.getAttribute("placeholder");
      window.__f1Probe.sendDisabled = send.disabled;
      try {
        send.click();
      } catch (error) {
        window.__f1Probe.clickError = String(error);
      }
    });
  }, taskId);
}

async function waitForProbe(page) {
  await waitUntil(
    async () => (await page.evaluate(() => window.__f1Probe.fired)) === true,
    "the page to observe pty:exit",
  );
  return page.evaluate(() => window.__f1Probe);
}

/** SIGTERM from outside Sonata: a death Sonata did not cause, so `sonataInitiated`
 *  is false and the runtime retires itself exactly as the #36005 class does. */
function killFakeCli(binary) {
  execFileSync("pkill", ["-f", binary]);
}

function readSpawnCount(runtimeDir) {
  try {
    return Number(fs.readFileSync(path.join(runtimeDir, "spawn-count"), "utf8"));
  } catch {
    return 0;
  }
}

function readStdin(runtimeDir) {
  try {
    return fs.readFileSync(path.join(runtimeDir, "stdin.bin"), "utf8");
  } catch {
    return "";
  }
}

function placeholderOf(page) {
  return page.locator("#prompt-input").getAttribute("placeholder");
}

/** The composer's action-feedback line. Empty while nothing needs answering. */
async function noticeOf(page) {
  return ((await page.locator("#runtime-status").textContent()) ?? "").trim();
}

/**
 * The wound, stated as an assertion. A resume that could not restore the provider's
 * memory legitimately reports itself here, so this pins the ONE thing that must
 * never appear: the live-branch error a send into a dead pty used to raise.
 */
function assertNoLivenessError(notice, label) {
  assert.ok(
    !/not live|TaskNotLive/i.test(notice),
    `${label}: the composer must never report a liveness error — got ${JSON.stringify(notice)}`,
  );
}

async function waitForWindow(electronApp, predicate) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const found = electronApp.windows().find((page) => !page.isClosed() && predicate(page));
    if (found) {
      return found;
    }
    await delay(100);
  }
  throw new Error("timed out waiting for the CLI window");
}

async function waitUntil(predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(120);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
