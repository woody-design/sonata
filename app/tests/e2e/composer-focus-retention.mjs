// Slice B (CLI continuity review fixes, Finding 1 / D1+D2): the composer keeps
// focus and never swallows keystrokes across a lifecycle claim.
//
// Four behaviors are pinned against the built app with a fake `claude` on PATH:
//   (a) a live send keeps focus in #prompt-input (pre-slice this landed on BODY,
//       because `sending` disabled the focused textarea and nothing restored it);
//   (b) typing straight through a live send survives — the optimistic clear
//       removes the sent text synchronously, so text typed after Enter is the
//       exact remaining value, with no stray leading newline from the Enter;
//   (c) a draft-moving phase (dormant resume, held at the TASK_OPEN gate) still
//       disables the composer, and focus returns to it once the flow settles;
//   (d) during that held window the full-freeze surfaces (Add attachment, the
//       sidebar New task) stay disabled — D1 did not weaken mutual exclusion.
//
// Boundary choice (stated per the brief): part (c) holds the TASK_OPEN gate on a
// dormant RESUME (submitPrompt's dormant branch), not TASK_CREATE — the resume
// branch is one of the three flows Slice B repairs focus for, whereas the
// new-chat create branch is deliberately not repaired (its caller re-focuses).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { activeSessionTaskId } from "./helpers/session.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-composer-focus-"));
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
installFakeClaude();

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
      // Hold the resume-open boundary so part (c) can observe the draft-moving
      // freeze; createTask is a different gate, so the initial send stays fast.
      SONATA_TEST_TASK_OPEN_DELAY_MS: "900",
      SONATA_NOTIFICATIONS: "0",
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
  const main = await app.firstWindow();
  const cli = await waitForWindow(app, (page) => page.url().endsWith("/terminal.html"));
  main.setDefaultTimeout(20_000);
  cli.setDefaultTimeout(20_000);
  await main.locator(".task-entry-panel").waitFor({ state: "visible" });
  await chooseProject(main);

  // Birth the session from the composer (Enter). The new-chat create branch is
  // not focus-repaired, so this settles with focus on BODY — exactly why part
  // (a) re-focuses the input before its live send. Live sends deliver
  // write-through to the PTY (Claude), so stdin is the settle signal; a *run*
  // only lands on the CLI's own UserPromptSubmit hook, which the fake CLI lacks.
  await main.locator("#prompt-input").click();
  await main.locator("#prompt-input").fill("first message");
  await main.keyboard.press("Enter");
  const taskId = await waitForActiveTask(main);
  await waitFor(() => readStdin(taskId).includes("first message"), "first delivery");
  await main.locator("#prompt-input:not(:disabled)").waitFor({ state: "visible" });

  // (a) Live send keeps focus.
  await main.locator("#prompt-input").focus();
  await main.locator("#prompt-input").fill("second message");
  await main.keyboard.press("Enter");
  await waitFor(() => readStdin(taskId).includes("second message"), "second delivery");
  const liveSendActiveElement = await activeElementId(main);

  // (b) Typing straight through a live send — proven mid-window by holding the
  // submit at the PROMPT_SUBMIT gate (Finding 4: without a hold the send could
  // settle before the typing runs, and the assertion would pass even against
  // the old post-await clear). Finding 1 is re-pinned inside the window: a fast
  // second Enter on the now-empty composer must leave no stray newline.
  await setMainProcessEnv(app, "SONATA_TEST_PROMPT_SUBMIT_DELAY_MS", "2500");
  await main.locator("#prompt-input").focus();
  await main.locator("#prompt-input").fill("SENT-TEXT");
  await main.keyboard.press("Enter");
  // Mid-window (submit is held at the gate): D1 keeps the composer enabled and
  // the D2 optimistic clear already emptied it.
  const midSendEnabled = !(await main.locator("#prompt-input").isDisabled());
  const midSendEmpty = (await main.locator("#prompt-input").inputValue()) === "";
  // Finding 1: second Enter on the emptied composer, still mid-window.
  await main.keyboard.press("Enter");
  await main.keyboard.type("typed-after");
  const midWindowValue = await main.locator("#prompt-input").inputValue();
  await setMainProcessEnv(app, "SONATA_TEST_PROMPT_SUBMIT_DELAY_MS", null);
  await waitFor(() => readStdin(taskId).includes("SENT-TEXT"), "typed-through delivery");
  const typedThroughValue = await main.locator("#prompt-input").inputValue();
  const sentTextDelivered = occurrences(readStdin(taskId), "SENT-TEXT") === 1;

  // Finding 1 (baseline): double-Enter on an empty composer with no send in
  // flight also inserts no newline — plain Enter always preventDefaults.
  await main.locator("#prompt-input").focus();
  await main.locator("#prompt-input").fill("");
  await main.keyboard.press("Enter");
  await main.keyboard.press("Enter");
  const emptyDoubleEnterValue = await main.locator("#prompt-input").inputValue();

  // (c)+(d) Draft-moving freeze + focus repair on a dormant resume. Use a FRESH
  // empty task (Start CLI, no prompt) and drive the resumes prompt-less via the
  // CLI "Resume task" action (resumeTaskWithoutPrompt) so each cycle delivers no
  // message — a delivered prompt leaves a scrape-active run under the hookless
  // fake CLI, which both masks the dormant placeholder and blocks re-closing.
  await main.locator("#sidebar-new-chat").click();
  await main.locator(".task-entry-panel").waitFor({ state: "visible" });
  await chooseProject(main);
  await waitForCliActionReady(cli, "Start CLI");
  await cli.locator("#terminal-empty-action", { hasText: "Start CLI" }).click();
  const dormantTaskId = await waitForActiveTask(main, taskId);
  await waitFor(() => spawnCount(dormantTaskId) === 1, "empty task spawn");

  // c1 (Finding 3 — no focus theft): focus the composer, start the resume, then
  // during the held openTask window move focus to a non-frozen control
  // (#reading-settings). Repair must NOT yank it back — the user owns it.
  await closeAndAwaitDormant(main, dormantTaskId);
  await waitForCliActionReady(cli, "Resume task");
  await main.locator("#prompt-input").focus();
  await cli.locator("#terminal-empty-action", { hasText: "Resume task" }).click();
  await main.locator("#prompt-input:disabled").waitFor({ state: "visible" });
  await main.locator("#reading-settings").click();
  await waitFor(() => spawnCount(dormantTaskId) === 2, "resume c1 spawn");
  await main.locator("#prompt-input:not(:disabled)").waitFor({ state: "visible" });
  const focusNotStolenActiveElement = await activeElementId(main);

  // c2 (freeze surfaces + repair): same resume, but leave focus orphaned exactly
  // as the disable left it — repair returns focus to the composer.
  await closeAndAwaitDormant(main, dormantTaskId);
  await waitForCliActionReady(cli, "Resume task");
  await main.locator("#prompt-input").focus();
  await cli.locator("#terminal-empty-action", { hasText: "Resume task" }).click();
  await main.locator("#prompt-input:disabled").waitFor({ state: "visible" });
  const heldWindow = {
    promptDisabled: await main.locator("#prompt-input").isDisabled(),
    addAttachmentDisabled: await main.locator("#add-attachment").isDisabled(),
    newTaskDisabled: await main.locator("#sidebar-new-chat").isDisabled(),
  };
  await waitFor(() => spawnCount(dormantTaskId) === 3, "resume c2 spawn");
  await main.locator("#prompt-input:not(:disabled)").waitFor({ state: "visible" });
  const resumeFocusActiveElement = await activeElementId(main);

  const checks = {
    liveSendKeepsFocus: liveSendActiveElement === "prompt-input",
    typedThroughSurvives: typedThroughValue === "typed-after" && !typedThroughValue.startsWith("\n"),
    midSendEnabledAndEmpty: midSendEnabled === true && midSendEmpty === true,
    doubleEnterInWindowNoNewline: midWindowValue === "typed-after",
    doubleEnterEmptyNoNewline: emptyDoubleEnterValue === "",
    sentTextDeliveredOnce: sentTextDelivered,
    draftMovingFreezeStillReal: heldWindow.promptDisabled === true,
    fullFreezeAddAttachment: heldWindow.addAttachmentDisabled === true,
    fullFreezeSidebarNewTask: heldWindow.newTaskDisabled === true,
    focusNotStolenFromOtherWidget: focusNotStolenActiveElement !== "prompt-input",
    focusRepairedAfterResume: resumeFocusActiveElement === "prompt-input",
  };
  const success = Object.values(checks).every(Boolean);
  console.log(
    JSON.stringify(
      {
        success,
        checks,
        liveSendActiveElement,
        typedThroughValue,
        midWindowValue,
        emptyDoubleEnterValue,
        heldWindow,
        focusNotStolenActiveElement,
        resumeFocusActiveElement,
        taskId,
        dormantTaskId,
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

function installFakeClaude() {
  const filePath = path.join(fakeBin, "claude");
  fs.writeFileSync(
    filePath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const runtimeDir = process.env.SONATA_RUNTIME_DIR;
fs.mkdirSync(runtimeDir, { recursive: true });
const countPath = path.join(runtimeDir, "spawn-count");
let count = 0;
try { count = Number(fs.readFileSync(countPath, "utf8")) || 0; } catch {}
count += 1;
fs.writeFileSync(countPath, String(count));
if (process.stdin.isTTY) { try { process.stdin.setRawMode(true); } catch {} }
process.stdin.resume();
process.stdin.on("data", (chunk) => {
  fs.appendFileSync(path.join(runtimeDir, "stdin.bin"), chunk);
  // Echo the prompt back so Sonata's DeliveryController earns a pty-composer-echo
  // receipt and clears inFlight — otherwise each send waits out the 45s receipt
  // timeout and the next one can't deliver.
  process.stdout.write(chunk);
});
process.stdout.write("Fake Claude ready\\n❯ opus xhigh ~\\n");
setInterval(() => {}, 1 << 30);
`,
    { mode: 0o755 },
  );
  fs.chmodSync(filePath, 0o755);
}

async function chooseProject(page) {
  await page.locator("#project-chip").click();
  await page.locator("#entry-choose-folder").click();
  await page.locator("#project-chip", { hasText: path.basename(project) }).waitFor({ state: "visible" });
}

async function activeElementId(page) {
  return page.evaluate(() => document.activeElement && document.activeElement.id);
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

async function closeAndAwaitDormant(page, taskId) {
  await page.evaluate((id) => window.sonataRuntime.closeTask({ taskId: id }), taskId);
  // The dormant placeholder is the main window's proof that view.live flipped.
  await page
    .locator('#prompt-input[placeholder="Message Claude — resumes this session"]')
    .waitFor({ state: "visible" });
}

async function waitForCliActionReady(page, text) {
  await page.locator("#terminal-empty-action:not(:disabled)", { hasText: text }).waitFor({
    state: "visible",
  });
}

async function waitForActiveTask(page, previousTaskId = null) {
  await waitFor(async () => {
    const id = await activeSessionTaskId(page).catch(() => null);
    return Boolean(id && id !== previousTaskId);
  }, "active task");
  return activeSessionTaskId(page);
}

function runtimeRoot(taskId) {
  return path.join(dataRoot, "data", "runtime", taskId);
}

function readStdin(taskId) {
  try {
    return fs.readFileSync(path.join(runtimeRoot(taskId), "stdin.bin"), "utf8");
  } catch {
    return "";
  }
}

function spawnCount(taskId) {
  try {
    return Number(fs.readFileSync(path.join(runtimeRoot(taskId), "spawn-count"), "utf8"));
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
