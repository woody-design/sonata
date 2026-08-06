// Focus/Flow S2 — the composer's ONE button, against the built app with a fake
// `claude` on PATH and a turn genuinely under way.
//
// Two invariants, one session, because they are the same button:
//
//   (a) THE BUTTON TELLS THE TRUTH, AND ITS CLICK AGREES WITH IT. `stop ⟺ a run
//       is under way AND nothing is staged` (D1) — one predicate
//       (`composerActionMode`) drawn by the painter and asked again by the click
//       handler. Sending mid-turn has always worked in Sonata (Claude writes
//       through to the CLI's native queue; the placeholder says so); only the
//       button denied it by wearing ■ for the whole run. So: ■ while the turn
//       runs and the composer is empty → ↑ the moment something is typed → back
//       to ■ when it is cleared, and the ↑ actually SENDS mid-turn.
//   (b) STOP MEANS STOP ONCE. `stopRun` writes a BARE Esc to the PTY; a second
//       one landing at an idle composer opens claude's rewind menu, which is why
//       the host's automatic Esc-retry is evidence-gated — the human path was
//       the unguarded one. Two stop activations in the SAME tick (the fastest
//       double-click there is, and the only deterministic way to stage one) must
//       put exactly ONE Esc on the wire.
//
// Fixture provenance:
//   - the fake CLI: COMPOSED, and deliberately the same body as
//     tests/e2e/question-drawer-focus-storm.mjs's — a session-species fake (see
//     tests/e2e/helpers/fake-cli.mjs) that echoes stdin (so a send earns its
//     pty-composer-echo receipt instead of waiting out the 45s timeout) and,
//     once the first prompt lands, paints a claude-shaped status region every
//     100ms so the turn keeps LOOKING alive and the terminal-idle completion
//     heuristic never settles the run out from under the test. Its glyphs are
//     MEASURED constants (CLAUDE_STATUS_GLYPHS,
//     src/runtime/working-status/status-region-tracker.ts).
//   - the UserPromptSubmit hook payload: COMPOSED to the shape its parser pins
//     (runtime-controller) — the authoritative "a turn is starting" signal, which
//     is what begins the run this test stops.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { activeSessionTaskId } from "./helpers/session.mjs";
import { fakeCliProbeArms } from "./helpers/fake-cli.mjs";

const SESSION_ID = "send-stop-session";
const MID_TURN_MESSAGE = "and also rename the module";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-send-stop-"));
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
installStatusTickerCli(fakeBin);

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
  main.setDefaultTimeout(20_000);
  await main.locator(".task-entry-panel").waitFor({ state: "visible" });
  await chooseProject(main);

  // Birth the session with a first prompt, then let the CLI declare the turn.
  await main.locator("#prompt-input").click();
  await main.locator("#prompt-input").fill("start the turn");
  await main.keyboard.press("Enter");
  const taskId = await waitForActiveTask(main);
  await waitFor(() => readStdin(taskId).toString("utf8").includes("start the turn"), "first delivery");
  fireHook(taskId, {
    hook_event_name: "UserPromptSubmit",
    session_id: SESSION_ID,
    prompt: "start the turn",
    prompt_id: "prompt-send-stop-1",
  });

  // (a1) A run, an empty composer: the button is a stop, and it is armed.
  await main.locator("#send-prompt.stop-mode").waitFor({ state: "attached" });
  const running = await readButton(main);

  // (a2) The user starts typing mid-turn: the button becomes a send.
  await main.locator("#prompt-input").click();
  await main.locator("#prompt-input").fill(MID_TURN_MESSAGE);
  await main.locator("#send-prompt:not(.stop-mode)").waitFor({ state: "attached" });
  const typing = await readButton(main);

  // (a3) …and clearing the composer hands the stop back.
  await main.locator("#prompt-input").fill("");
  await main.locator("#send-prompt.stop-mode").waitFor({ state: "attached" });
  const cleared = await readButton(main);

  // (a4) The click agrees with the paint: in send-mode it SENDS, mid-turn.
  await main.locator("#prompt-input").fill(MID_TURN_MESSAGE);
  await main.locator("#send-prompt:not(.stop-mode)").waitFor({ state: "attached" });
  await main.locator("#send-prompt").click();
  await waitFor(
    () => readStdin(taskId).toString("utf8").includes(MID_TURN_MESSAGE),
    "the mid-turn message reaching the CLI",
  );
  // The optimistic clear empties the composer, so the button returns to ■ by
  // itself — the mode follows the composer, not the click that emptied it.
  await main.locator("#send-prompt.stop-mode").waitFor({ state: "attached" });
  const afterSend = await readButton(main);

  // (b) Two stop activations in ONE tick. Everything before `stopRun`'s first
  // await runs synchronously, so this is the worst case the latch must hold.
  const escBefore = bareEscapeCount(readStdin(taskId));
  await main.evaluate(() => {
    const button = document.getElementById("send-prompt");
    button.click();
    button.click();
  });
  // The stop settles the run, which is also what returns the button to ↑.
  await main.locator("#send-prompt:not(.stop-mode)").waitFor({ state: "attached" });
  // Past the 900ms post-stop input-clear flood (kill-line bytes, no Esc among
  // them) and well short of the 6s /stop inspection, so a second Esc — which
  // would have been written in the same tick as the first — has had every
  // chance to land before it is counted.
  await main.waitForTimeout(1500);
  const escAfter = bareEscapeCount(readStdin(taskId));

  const checks = {
    stopModeWhileRunning:
      running.stopMode &&
      running.glyph === "■" &&
      running.ariaLabel === "Stop" &&
      running.title === "Stop Claude" &&
      !running.disabled,
    typingFlipsToSend:
      !typing.stopMode &&
      typing.glyph === "↑" &&
      typing.ariaLabel === "Send" &&
      !typing.disabled &&
      // Honest per state: not the stop it is no longer, and not the dead-
      // affordance line it would wear with nothing staged.
      typing.title !== "Stop Claude" &&
      typing.title !== "Type a message before sending.",
    clearingFlipsBack: cleared.stopMode && cleared.glyph === "■" && cleared.ariaLabel === "Stop",
    sendModeClickDelivers: afterSend.stopMode && afterSend.glyph === "■",
    doubleStopWritesOneEsc: escAfter - escBefore === 1,
    stopSettledTheRun: !(await readButton(main)).stopMode,
  };
  const success = Object.values(checks).every(Boolean);
  console.log(
    JSON.stringify(
      { success, checks, running, typing, cleared, afterSend, escBefore, escAfter, taskId },
      null,
      2,
    ),
  );
  process.exitCode = success ? 0 : 1;
} finally {
  await app?.close();
  fs.rmSync(root, { recursive: true, force: true });
}

/** Everything the one button is saying right now. */
async function readButton(page) {
  return page.evaluate(() => {
    const button = document.getElementById("send-prompt");
    return {
      stopMode: button.classList.contains("stop-mode"),
      glyph: button.textContent,
      ariaLabel: button.getAttribute("aria-label"),
      title: button.title,
      disabled: button.disabled,
    };
  });
}

/**
 * Esc bytes written to the PTY as a BARE Esc — the interrupt.
 *
 * Every other Esc Sonata writes opens a CSI/OSC sequence (bracketed paste
 * `\x1b[200~`, the CSI-u Enter `\x1b[13u`, …), so "Esc not followed by [ or ]"
 * is exactly the interrupt, and it is what `TerminalHost.stopRun` writes.
 */
function bareEscapeCount(buffer) {
  let count = 0;
  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] !== 0x1b) {
      continue;
    }
    const next = buffer[index + 1];
    if (next === 0x5b || next === 0x5d) {
      continue;
    }
    count++;
  }
  return count;
}

/** Write a hook payload the way Sonata's own sink does (tmp + rename into the
 *  task's runtime hooks dir), which is the only thing the watcher cares about. */
function fireHook(taskId, payload) {
  const hooksDir = path.join(runtimeRoot(taskId), "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  const file = path.join(
    hooksDir,
    `hook-${Date.now().toString(36)}-${process.hrtime.bigint().toString(36)}.json`,
  );
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(payload), "utf8");
  fs.renameSync(`${file}.tmp`, file);
}

/** The session species of fake CLI (see helpers/fake-cli.mjs) plus a ticking
 *  claude-shaped status region, so the turn stays visibly alive for as long as
 *  this test needs it. Twin of question-drawer-focus-storm.mjs's. */
function installStatusTickerCli(binDir) {
  const source = [
    `#!/usr/bin/env node`,
    `"use strict";`,
    `const fs = require("node:fs");`,
    `const path = require("node:path");`,
    ``,
    fakeCliProbeArms("claude"),
    ``,
    `const argv = process.argv.slice(2);`,
    `const settingsIndex = argv.indexOf("--settings");`,
    `const runtimeDir =`,
    `  process.env.SONATA_RUNTIME_DIR ||`,
    `  (settingsIndex >= 0 && argv[settingsIndex + 1] ? path.dirname(argv[settingsIndex + 1]) : null);`,
    `if (runtimeDir) { fs.mkdirSync(runtimeDir, { recursive: true }); }`,
    `if (process.stdin.isTTY) { try { process.stdin.setRawMode(true); } catch {} }`,
    `process.stdin.resume();`,
    `let ticking = false;`,
    `let tokens = 1200;`,
    `process.stdin.on("data", (chunk) => {`,
    `  if (runtimeDir) { fs.appendFileSync(path.join(runtimeDir, "stdin.bin"), chunk); }`,
    `  process.stdout.write(chunk);`,
    `  if (!ticking) {`,
    `    ticking = true;`,
    `    setInterval(() => {`,
    `      tokens += 7;`,
    `      process.stdout.write("\\r\\n✳ Working… (23s · ↑ " + tokens + " tokens)\\r\\n");`,
    `    }, 100);`,
    `  }`,
    `});`,
    `process.stdout.write("Fake Claude ready\\n❯ opus xhigh ~\\n");`,
    `setInterval(() => {}, 1 << 30);`,
    ``,
  ].join("\n");
  const filePath = path.join(binDir, "claude");
  fs.writeFileSync(filePath, source, { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
  return filePath;
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

function runtimeRoot(taskId) {
  return path.join(dataRoot, "data", "runtime", taskId);
}

/** The raw bytes the CLI has read from its PTY so far. */
function readStdin(taskId) {
  try {
    return fs.readFileSync(path.join(runtimeRoot(taskId), "stdin.bin"));
  } catch {
    return Buffer.alloc(0);
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
