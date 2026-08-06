// Focus/flow S1 — the invariant this slice exists for: A TEXT FIELD THE USER CAN
// TYPE INTO KEEPS A STABLE DOM NODE FOR ITS LIFETIME. Pinned on the question
// drawer's free-text row (AskUserQuestion), against the built app with a fake
// `claude` on PATH, while a real turn is under way.
//
// Two things are fenced, because the bug had two halves:
//
//   (a) THE EMITTER'S CONTRACT: an emitted `delivery:state` represents a REAL
//       change. The renderer honestly reads that event as a content change and
//       full-renders, so a controller that re-announces an unchanged state turns
//       every unrelated runtime event into a full render. (MEASURED across the
//       recorded real-session fixtures in tests/fixtures/runtime-events: 332 of
//       591 `delivery:state` events — 56% — were byte-identical re-announcements
//       of the state already on the wire.) Here every `delivery:state` the
//       renderer receives is recorded, and no two consecutive ones may carry the
//       same payload.
//   (b) THE FIELD'S IDENTITY, across both kinds of paint: a live turn ticking its
//       status region (2.5s of it), and then REAL full renders — a message
//       enqueued mid-question moves the delivery state for real (queued →
//       delivering → receipt), so the drawer IS re-rendered several times. The
//       field must survive both; the second half is the one that fails when the
//       emitter is quiet but the form is still rebuilt wholesale.
//
// The field is proven to be THE SAME NODE by a property stamped on it before the
// window (a rebuilt element cannot carry it), plus focus, caret offset and value.
// Node identity is the honest test for the IME case that motivated the slice:
// the browser's composition state lives on the element, so it cannot be
// snapshot/restored — synthesizing a real composition from Playwright is not
// possible (see composer-ime.mjs, which can only dispatch composition EVENTS),
// but a field whose node never dies is a field whose composition never dies.
//
// Fixture provenance:
//   - the fake CLI's status line: COMPOSED (hand-written), shaped to the MEASURED
//     constants the tracker keys on (CLAUDE_STATUS_GLYPHS in
//     src/runtime/working-status/status-region-tracker.ts); the token counter
//     moves on every paint so each 300ms sample is a genuinely new region, which
//     is what a real turn's status line does.
//   - the hook payloads: COMPOSED, to the shapes their parsers pin
//     (UserPromptSubmit → runtime-controller; AskUserQuestion tool_input →
//     parseOptionPrompt); the questions are ADAPTED from the real-Claude prompt
//     tests/e2e/option-prompt-surface.mjs asks for (same headers/labels), so the
//     drawer renders the same shape it does against the live CLI.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { activeSessionTaskId } from "./helpers/session.mjs";
import { fakeCliProbeArms } from "./helpers/fake-cli.mjs";

/** What the user types into the drawer, and where they leave the caret. */
const TYPED = "a pomelo, please";
const CARET = 5;
const SESSION_ID = "storm-session";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-drawer-focus-"));
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

  // Birth the session. The fake CLI echoes stdin, so the send earns its
  // pty-composer-echo receipt and starts painting the status region.
  await main.locator("#prompt-input").click();
  await main.locator("#prompt-input").fill("start the turn");
  await main.keyboard.press("Enter");
  const taskId = await waitForActiveTask(main);
  await waitFor(() => readStdin(taskId).includes("start the turn"), "first delivery");

  // Count runtime events the way the renderer receives them — the same channel
  // the reducer reads, so "no delivery:state" here means the emitter was quiet.
  await main.evaluate(() => {
    window.__sonataEventCounts = {};
    // Payloads, not just counts, for delivery:state — its whole contract is that
    // an event means something moved, which only the payloads can show.
    window.__sonataDeliveryStates = [];
    window.sonataRuntime.onRuntimeEvent((event) => {
      window.__sonataEventCounts[event.type] = (window.__sonataEventCounts[event.type] ?? 0) + 1;
      if (event.type === "delivery:state") {
        window.__sonataDeliveryStates.push(JSON.stringify(event.payload));
      }
    });
  });

  // The CLI declares the turn (UserPromptSubmit is the authoritative "a turn is
  // starting" signal) — this is what opens the status region's emission gate.
  fireHook(taskId, {
    hook_event_name: "UserPromptSubmit",
    session_id: SESSION_ID,
    prompt: "start the turn",
    prompt_id: "prompt-storm-1",
  });
  await waitFor(() => counts(main).then((c) => (c["working-status:updated"] ?? 0) >= 3), "the status storm");

  // The CLI asks. One single-select question → the drawer renders its free-text row.
  fireHook(taskId, {
    hook_event_name: "PreToolUse",
    session_id: SESSION_ID,
    tool_name: "AskUserQuestion",
    tool_use_id: "toolu-storm-1",
    tool_input: {
      questions: [
        {
          header: "Fruit",
          question: "Which fruit?",
          multiSelect: false,
          options: [
            { label: "Banana", description: "a tropical fruit" },
            { label: "Cherry", description: "a stone fruit" },
          ],
        },
      ],
    },
  });
  const field = main.locator(".option-prompt-freetext-input");
  await field.waitFor({ state: "visible" });
  await main.locator("#composer.drawer-active").waitFor({ state: "visible" });

  // The user answers in their own words and leaves the caret mid-word.
  await field.click();
  await field.fill(TYPED);
  await main.evaluate((caret) => {
    const input = document.querySelector(".option-prompt-freetext-input");
    input.setSelectionRange(caret, caret);
    // The identity stamp: a live JS property, which only THIS element carries.
    input.__sonataFieldStamp = "s1-focus-fence";
  }, CARET);
  const armed = await readField(main);
  if (!armed.stamped || !armed.focused || armed.caret !== CARET) {
    throw new Error(`The field was not armed as expected: ${JSON.stringify(armed)}`);
  }

  // (a) Ride out the storm.
  const before = await counts(main);
  await main.waitForTimeout(2500);
  const after = await counts(main);
  const stormTicks = (after["working-status:updated"] ?? 0) - (before["working-status:updated"] ?? 0);
  const stormDeliveryStates = (after["delivery:state"] ?? 0) - (before["delivery:state"] ?? 0);
  const afterStorm = await readField(main);

  // (b) A genuine delivery change under the open drawer — real full renders.
  await main.evaluate((id) =>
    window.sonataRuntime.submitPrompt({ taskId: id, text: "queued while the question stands" }),
    taskId,
  );
  await waitFor(
    () => counts(main).then((c) => (c["delivery:state"] ?? 0) - (after["delivery:state"] ?? 0) >= 2),
    "delivery state changes under the drawer",
  );
  const settled = await counts(main);
  const renderDeliveryStates = (settled["delivery:state"] ?? 0) - (after["delivery:state"] ?? 0);
  const afterRenders = await readField(main);

  // (a) Every delivery:state this renderer saw, from session birth to here.
  const deliveryStates = await main.evaluate(() => [...window.__sonataDeliveryStates]);
  const reannounced = deliveryStates.filter(
    (payload, index) => index > 0 && payload === deliveryStates[index - 1],
  ).length;

  const checks = {
    stormIsLive: stormTicks >= 6,
    // Nothing about delivery moved across the storm window, so nothing was said.
    stormEmitsNoDeliveryState: stormDeliveryStates === 0,
    // The contract itself: no event repeats the state already on the wire.
    noReannouncedDeliveryState: reannounced === 0,
    fieldSurvivesStorm:
      afterStorm.stamped &&
      afterStorm.focused &&
      afterStorm.caret === CARET &&
      afterStorm.value === TYPED,
    realRendersHappened: renderDeliveryStates >= 2,
    fieldSurvivesRealRenders:
      afterRenders.stamped &&
      afterRenders.focused &&
      afterRenders.caret === CARET &&
      afterRenders.value === TYPED,
    drawerStillOwnsTheSlot: await main.locator("#composer.drawer-active").isVisible(),
  };
  const success = Object.values(checks).every(Boolean);
  console.log(
    JSON.stringify(
      {
        success,
        checks,
        stormTicks,
        stormDeliveryStates,
        renderDeliveryStates,
        deliveryStateCount: deliveryStates.length,
        reannounced,
        // Everything that arrived during the storm window — so a failure names
        // what was actually driving the renders, instead of leaving the reader
        // to guess which event class regressed.
        stormEvents: delta(before, after),
        afterStorm,
        afterRenders,
        taskId,
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

/** What the free-text field is, right now: the same node, still owning the
 *  caret, still holding what was typed. */
async function readField(page) {
  return page.evaluate(() => {
    const input = document.querySelector(".option-prompt-freetext-input");
    if (!input) {
      return { present: false, stamped: false, focused: false, caret: null, value: null };
    }
    return {
      present: true,
      stamped: input.__sonataFieldStamp === "s1-focus-fence",
      focused: document.activeElement === input,
      caret: input.selectionStart,
      value: input.value,
    };
  });
}

function counts(page) {
  return page.evaluate(() => ({ ...window.__sonataEventCounts }));
}

function delta(before, after) {
  const out = {};
  for (const [type, count] of Object.entries(after)) {
    const moved = count - (before[type] ?? 0);
    if (moved > 0) {
      out[type] = moved;
    }
  }
  return out;
}

/** Write a hook payload the way Sonata's own sink does (tmp + rename into the
 *  task's runtime hooks dir), which is the only thing the watcher cares about. */
function fireHook(taskId, payload) {
  const hooksDir = path.join(runtimeRoot(taskId), "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  const file = path.join(hooksDir, `hook-${Date.now().toString(36)}-${process.hrtime.bigint().toString(36)}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(payload), "utf8");
  fs.renameSync(`${file}.tmp`, file);
}

/**
 * The session species of fake CLI (see helpers/fake-cli.mjs), with one addition
 * this test needs: once the first prompt arrives it paints a claude-shaped status
 * region every 100ms with a moving token count, so every 300ms tracker sample
 * sees a NEW region — a real ~3.3Hz working-status stream.
 */
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

function readStdin(taskId) {
  try {
    return fs.readFileSync(path.join(runtimeRoot(taskId), "stdin.bin"), "utf8");
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
