// Cross-window generation fence: a background task's xterm belongs to one
// TerminalHost generation, not to the persistent task id. Exercise both ways
// that generation ends while another task remains selected:
//   1) natural PTY exit (accepted pty:exit must reclaim the hidden xterm),
//   2) close→immediate reopen (old exit is correctly fenced in main, so the
//      first newer pty:data/replay generation must replace the hidden xterm),
//   3) close→reopen on the ACTIVE task, where the exit's own dormant binding edge
//      and the reopen's live one rebuild the grid from main's scrollback mirror
//      before the provider emits anything (F1 fix A — see the block's own note for
//      what this used to assert instead).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { fakeCliProbeArms } from "./helpers/fake-cli.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-cli-background-generation-"));
const fakeBin = path.join(root, "bin");
const workspaceA = path.join(root, "task-a");
const workspaceB = path.join(root, "task-b");
const exitGenerationOne = path.join(root, "exit-a-generation-1");
const generationTwoRetired = path.join(root, "a-generation-2-retired");
const generationFourFirstByte = path.join(root, "a-generation-4-first-byte");
for (const directory of [fakeBin, workspaceA, workspaceB]) {
  fs.mkdirSync(directory, { recursive: true });
}
installFakeCodex();

let app;
try {
  app = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      SONATA_DATA_DIR: path.join(root, "data"),
      SONATA_WORKSPACES_DIR: path.join(root, "workspaces"),
      SONATA_NOTIFICATIONS: "0",
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
  const main = await app.firstWindow();
  const cli = await waitForWindow(app, (page) => page.url().endsWith("/terminal.html"));
  main.setDefaultTimeout(20_000);
  cli.setDefaultTimeout(20_000);
  await main.locator(".task-entry-panel").waitFor({ state: "visible" });

  const [taskA, taskB] = await main.evaluate(
    async ({ cwdA, cwdB }) => {
      const a = await window.sonataRuntime.createTask({
        provider: "codex",
        cwd: cwdA,
        title: "Generation A",
      });
      const b = await window.sonataRuntime.createTask({
        provider: "codex",
        cwd: cwdB,
        title: "Generation B",
      });
      return [a.task, b.task];
    },
    { cwdA: workspaceA, cwdB: workspaceB },
  );
  await waitForSidebarTask(main, taskA.id);
  await waitForSidebarTask(main, taskB.id);

  await selectTask(main, taskA.id);
  const aOne = await waitForTerminalMarker(cli, taskA.id, "A_GENERATION_1_OLD");
  await selectTask(main, taskB.id);
  await waitForTerminalMarker(cli, taskB.id, "B_GENERATION_1_LIVE");

  // A exits naturally while B owns the visible CLI. The accepted pty:exit is
  // the authoritative reclamation signal even though Reading's active binding
  // and open-task id set do not change.
  fs.writeFileSync(exitGenerationOne, "exit");
  await waitFor(
    async () => (await readSummary(main, taskA.id))?.live === false,
    "background A generation 1 to become dormant",
  );
  await cli.waitForFunction(
    (taskId) => !document.querySelector(`.task-terminal[data-task-id="${taskId}"]`),
    taskA.id,
  );
  const naturalExitReclaimedHiddenXterm =
    (await cli.locator(`.task-terminal[data-task-id="${taskA.id}"]`).count()) === 0;

  // Reopen A through the runtime IPC while B remains selected. No renderer
  // binding is needed to retain output: selecting A later hydrates the current
  // generation's mirror into a new xterm.
  await main.evaluate((taskId) => window.sonataRuntime.openTask({ taskId }), taskA.id);
  await waitFor(() => readSpawnCount("task-a") === 2, "A generation 2 spawn");
  await selectTask(main, taskA.id);
  const aTwo = await waitForTerminalMarker(cli, taskA.id, "A_GENERATION_2_CURRENT");
  const generationTwoIsClean =
    !aTwo.text.includes("A_GENERATION_1_OLD") && aTwo.generation > aOne.generation;

  // Harder race: keep A's old process alive after close, reopen the persistent
  // id immediately as generation 3, and stay on B. Main drops generation 2's
  // late exit by RunIndex identity; terminal must still replace its hidden A
  // entry when generation 3 data arrives.
  await selectTask(main, taskB.id);
  await main.evaluate(async (taskId) => {
    await window.sonataRuntime.closeTask({ taskId });
    await window.sonataRuntime.openTask({ taskId });
  }, taskA.id);
  await waitFor(() => readSpawnCount("task-a") === 3, "A generation 3 spawn");
  await cli.waitForFunction(
    ({ taskId, previousGeneration }) => {
      const entry = document.querySelector(`.task-terminal[data-task-id="${taskId}"]`);
      return Number(entry?.dataset.generation) > previousGeneration;
    },
    { taskId: taskA.id, previousGeneration: aTwo.generation },
  );
  await waitFor(
    () => fs.existsSync(generationTwoRetired),
    "A generation 2 delayed exit after generation 3 is live",
  );
  await new Promise((resolve) => setTimeout(resolve, 120));

  await selectTask(main, taskA.id);
  const aThree = await waitForTerminalMarker(cli, taskA.id, "A_GENERATION_3_NEW");
  const immediateReopenIsClean =
    aThree.generation > aTwo.generation &&
    !aThree.text.includes("A_GENERATION_1_OLD") &&
    !aThree.text.includes("A_GENERATION_2_CURRENT");
  const staleExitDidNotDisposeGenerationThree =
    (await readSummary(main, taskA.id))?.live === true;

  // Opposite ordering: A is active, generation 3 exits and its entry is visibly
  // reclaimed before generation 4 starts. The provider delays its first byte, so
  // whatever restores the xterm has to do it without any provider output to go on.
  //
  // WHAT THIS USED TO ASSERT, and why it changed (F1 fix A). A close→reopen used to
  // coalesce Reading's index refreshes into live→live, so NO binding edge reached
  // this window and the only way back was the data tombstone (`terminal.ts`'s
  // no-entry branch). That coalescing was an artifact of the mirror lag: nothing
  // cleared `view.live` on `pty:exit`, so Reading never said "dormant" out loud. The
  // reducer clears it now, so the exit pushes a real dormant edge and the reopen
  // pushes a real live one — and the xterm is rebuilt from Reading's AUTHORITATIVE
  // binding, hydrated from main's scrollback mirror, before a single provider byte
  // exists. That is strictly stronger than inferring liveness from a data byte, and
  // it is what the three revision/entry checks below now pin.
  //
  // The tombstone branch is therefore no longer reached HERE. It is still reachable
  // — the CLI window disposes its entry on `pty:exit` locally, one IPC hop before
  // Reading's dormant edge lands, and newer data inside that hop still finds
  // `activeBinding.live === true` with no entry — but nothing in this file
  // constructs that hop, and pretending otherwise would be worse than saying so.
  await main.evaluate((taskId) => window.sonataRuntime.closeTask({ taskId }), taskA.id);
  await cli.waitForFunction(
    (taskId) => !document.querySelector(`.task-terminal[data-task-id="${taskId}"]`),
    taskA.id,
  );
  const exitArrivedBeforeGenerationFour =
    (await cli.locator(`.task-terminal[data-task-id="${taskA.id}"]`).count()) === 0;
  const bindingRevisionBeforeOpen = Number(
    await cli.locator("#app").getAttribute("data-active-task-binding-revision"),
  );
  await main.evaluate((taskId) => window.sonataRuntime.openTask({ taskId }), taskA.id);
  await waitFor(() => readSpawnCount("task-a") === 4, "A generation 4 spawn");
  // Cross the 150ms session-index debounce while the provider's first byte is still
  // fenced by the sentinel, so everything read below happened with NO provider output
  // in existence.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const bindingRevisionBeforeData = Number(
    await cli.locator("#app").getAttribute("data-active-task-binding-revision"),
  );
  const firstByteNotEmittedBeforeRecovery = !fs.existsSync(generationFourFirstByte);
  // The reopen announced itself: Reading said dormant on the exit and live again on
  // the index refresh, so a genuine binding edge crossed the window.
  const bindingEdgeArrivedBeforeData = bindingRevisionBeforeData > bindingRevisionBeforeOpen;
  // …and that edge is what rebuilt the grid — before any provider byte, so it can
  // only have come from the binding plus main's scrollback mirror.
  const entryRestoredByTheBindingEdge =
    (await cli.locator(`.task-terminal[data-task-id="${taskA.id}"]`).count()) === 1 &&
    firstByteNotEmittedBeforeRecovery &&
    bindingEdgeArrivedBeforeData;
  const aFour = await waitForTerminalMarker(cli, taskA.id, "A_GENERATION_4_AFTER_EXIT");
  const bindingRevisionAfterRecovery = Number(
    await cli.locator("#app").getAttribute("data-active-task-binding-revision"),
  );
  // The surviving half of the original claim: provider DATA pushes no binding of its
  // own. Reading's edge is the one authority; bytes never churn the binding.
  const dataAddedNoBindingEdge = bindingRevisionAfterRecovery === bindingRevisionBeforeData;
  const exitThenDataRecoveredActiveXterm =
    aFour.generation > aThree.generation &&
    !aFour.text.includes("A_GENERATION_1_OLD") &&
    !aFour.text.includes("A_GENERATION_2_CURRENT") &&
    !aFour.text.includes("A_GENERATION_3_NEW");
  const oneEntryPerTask =
    (await cli.locator(`.task-terminal[data-task-id="${taskA.id}"]`).count()) === 1 &&
    (await cli.locator(`.task-terminal[data-task-id="${taskB.id}"]`).count()) === 1;

  const checks = {
    naturalExitReclaimedHiddenXterm,
    generationTwoIsClean,
    newerDataReplacedHiddenGeneration: aThree.generation > aTwo.generation,
    staleExitDidNotDisposeGenerationThree,
    immediateReopenIsClean,
    exitArrivedBeforeGenerationFour,
    entryRestoredByTheBindingEdge,
    firstByteNotEmittedBeforeRecovery,
    bindingEdgeArrivedBeforeData,
    dataAddedNoBindingEdge,
    exitThenDataRecoveredActiveXterm,
    oneEntryPerTask,
  };
  const success = Object.values(checks).every(Boolean);
  console.log(
    JSON.stringify(
      {
        success,
        checks,
        generations: {
          first: aOne.generation,
          second: aTwo.generation,
          third: aThree.generation,
          fourth: aFour.generation,
        },
        bindingRevisions: {
          beforeOpen: bindingRevisionBeforeOpen,
          beforeData: bindingRevisionBeforeData,
          afterRecovery: bindingRevisionAfterRecovery,
        },
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

function installFakeCodex() {
  const executable = path.join(fakeBin, "codex");
  fs.writeFileSync(
    executable,
    // The probe arms first (F1 fix B). This fake keys its lifecycle on the cwd's
    // basename, so a readiness probe — which runs from main's own cwd — never landed
    // in a task branch and fell straight through to the final `setInterval`: one
    // immortal node process per launch, MEASURED as leftover `codex --version`
    // processes after this file's runs. The counts were never corrupted; the process
    // just never died.
    `#!/usr/bin/env node
${fakeCliProbeArms("codex")}

const fs = require("node:fs");
const path = require("node:path");
const label = path.basename(process.cwd());
const countPath = path.join(${JSON.stringify(root)}, label + "-spawn-count");
let count = 0;
try { count = Number(fs.readFileSync(countPath, "utf8")) || 0; } catch {}
count += 1;
fs.writeFileSync(countPath, String(count));
const marker = label === "task-a"
  ? (count === 1
      ? "A_GENERATION_1_OLD"
      : count === 2
        ? "A_GENERATION_2_CURRENT"
        : count === 3
          ? "A_GENERATION_3_NEW"
          : "A_GENERATION_4_AFTER_EXIT")
  : "B_GENERATION_1_LIVE";
const writeMarker = () => {
  if (label === "task-a" && count === 4) {
    fs.writeFileSync(${JSON.stringify(generationFourFirstByte)}, "emitted");
  }
  process.stdout.write(marker + "\\r\\n");
};
if (label === "task-a" && count === 4) {
  setTimeout(writeMarker, 900);
} else {
  writeMarker();
}
if (label === "task-a" && count === 1) {
  const timer = setInterval(() => {
    if (fs.existsSync(${JSON.stringify(exitGenerationOne)})) {
      clearInterval(timer);
      process.exit(0);
    }
  }, 20);
} else if (label === "task-a" && count === 2) {
  let retiring = false;
  const retire = () => {
    if (retiring) return;
    retiring = true;
    setTimeout(() => {
      fs.writeFileSync(${JSON.stringify(generationTwoRetired)}, "retired");
      process.exit(0);
    }, 700);
  };
  process.on("SIGHUP", retire);
  process.on("SIGTERM", retire);
  setInterval(() => {}, 1000);
} else {
  setInterval(() => {}, 1000);
}
`,
    { mode: 0o755 },
  );
  fs.chmodSync(executable, 0o755);
}

async function waitForSidebarTask(page, taskId) {
  await page.locator(`.sidebar-session[data-task-id="${taskId}"]`).waitFor({ state: "visible" });
}

async function selectTask(page, taskId) {
  await page
    .locator(`.sidebar-session[data-task-id="${taskId}"] .sidebar-session-button`)
    .click();
}

async function waitForTerminalMarker(page, taskId, marker) {
  await page.waitForFunction(
    ({ expectedTaskId, expectedMarker }) => {
      const entry = document.querySelector(
        `.task-terminal:not(.hidden)[data-task-id="${expectedTaskId}"]`,
      );
      return entry?.textContent?.includes(expectedMarker);
    },
    { expectedTaskId: taskId, expectedMarker: marker },
  );
  return page
    .locator(`.task-terminal:not(.hidden)[data-task-id="${taskId}"]`)
    .evaluate((entry) => ({
      generation: Number(entry.dataset.generation),
      text: entry.textContent ?? "",
    }));
}

async function readSummary(page, taskId) {
  return page.evaluate(async (id) => {
    const index = await window.sonataRuntime.readSessionIndex({ includeArchived: true });
    return [...index.chats, ...index.projects.flatMap((project) => project.sessions)].find(
      (session) => session.task.id === id,
    );
  }, taskId);
}

function readSpawnCount(label) {
  try {
    return Number(fs.readFileSync(path.join(root, `${label}-spawn-count`), "utf8")) || 0;
  } catch {
    return 0;
  }
}

async function waitForWindow(electronApp, predicate) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const match = electronApp.windows().find(predicate);
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for CLI window.");
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
