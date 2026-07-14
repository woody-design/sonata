// Runtime liveness fence for the CLI binding. A provider PTY that exits on its
// own must become dormant in the authoritative Session Index, and reopening
// that same task must create a genuinely new runtime instead of returning the
// dead TerminalHost cached under its persistent task id.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "duet-cli-liveness-"));
const fakeBin = path.join(root, "bin");
const workspace = path.join(root, "workspace");
const spawnCountPath = path.join(root, "spawn-count");
const retiringGenerationPath = path.join(root, "retiring-generation");
const retiredGenerationPath = path.join(root, "retired-generation");
fs.mkdirSync(fakeBin, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });

const fakeCodexPath = path.join(fakeBin, "codex");
const fakeCodexSource = `#!/usr/bin/env node
const fs = require("node:fs");
const countPath = ${JSON.stringify(spawnCountPath)};
const retiringPath = ${JSON.stringify(retiringGenerationPath)};
const retiredPath = ${JSON.stringify(retiredGenerationPath)};
let count = 0;
try { count = Number(fs.readFileSync(countPath, "utf8")) || 0; } catch {}
count += 1;
fs.writeFileSync(countPath, String(count));
if (count === 1) {
  setTimeout(() => process.exit(0), 150);
} else {
  let retiring = false;
  const retire = () => {
    if (retiring) return;
    retiring = true;
    fs.writeFileSync(retiringPath, String(count));
    setTimeout(() => {
      fs.writeFileSync(retiredPath, String(count));
      process.exit(0);
    }, 750);
  };
  process.on("SIGTERM", retire);
  process.on("SIGHUP", retire);
  setInterval(() => {}, 1000);
}
`;
fs.writeFileSync(fakeCodexPath, fakeCodexSource, { mode: 0o755 });
fs.chmodSync(fakeCodexPath, 0o755);

let app;
try {
  app = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      DUET_DATA_DIR: path.join(root, "data"),
      DUET_WORKSPACES_DIR: path.join(root, "workspaces"),
      DUET_NOTIFICATIONS: "0",
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
  const main = await app.firstWindow();
  main.setDefaultTimeout(20_000);

  const created = await main.evaluate((cwd) =>
    window.duetRuntime.createTask({ provider: "codex", cwd }),
    workspace,
  );
  const taskId = created.task.id;

  await waitFor(
    async () => (await readSummary(main, taskId))?.live === false,
    "first PTY to retire into a dormant session",
  );
  const dormantSnapshot = await main.evaluate(
    (id) => window.duetRuntime.readSession({ taskId: id }),
    taskId,
  );
  const dormantSubmitRejected = await rejects(() =>
    main.evaluate(
      (id) => window.duetRuntime.submitPrompt({ taskId: id, text: "must not reach dead PTY" }),
      taskId,
    ),
  );

  const reopened = await main.evaluate(
    (id) => window.duetRuntime.openTask({ taskId: id, resume: true }),
    taskId,
  );
  await waitFor(
    async () => (await readSummary(main, taskId))?.live === true,
    "reopened PTY to become live",
  );
  await waitFor(
    async () => Number(fs.readFileSync(spawnCountPath, "utf8")) >= 2,
    "reopened provider process to start",
  );

  // Explicit teardown has a different race from natural exit: node-pty's old
  // onExit can arrive after the same persistent task id already owns a fresh
  // runtime. Keep generation 2 alive for 750ms after its close signal, reopen
  // immediately as generation 3, then wait for the OLD exit before asserting.
  await main.evaluate((id) => window.duetRuntime.closeTask({ taskId: id }), taskId);
  const reopenedImmediately = await main.evaluate(
    (id) => window.duetRuntime.openTask({ taskId: id, resume: true }),
    taskId,
  );
  await waitFor(
    async () => Number(fs.readFileSync(spawnCountPath, "utf8")) >= 3,
    "immediate reopen provider process to start",
  );
  await waitFor(
    async () => fs.existsSync(retiringGenerationPath),
    "old provider generation to receive teardown signal",
  );
  await waitFor(
    async () => fs.existsSync(retiredGenerationPath),
    "old provider generation to publish its delayed exit",
  );
  // Let the old node-pty onExit callback and its queued microtasks drain.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const afterStaleExit = await readSummary(main, taskId);
  const newRuntimeAcceptsPrompt = await resolves(() =>
    main.evaluate(
      (id) => window.duetRuntime.submitPrompt({ taskId: id, text: "still generation three" }),
      taskId,
    ),
  );
  const spawnCount = Number(fs.readFileSync(spawnCountPath, "utf8"));

  const checks = {
    dormantSnapshot: dormantSnapshot.live === false,
    dormantSubmitRejected,
    newRuntimePid: reopened.runtime.pid !== created.runtime.pid,
    spawnedThreeGenerations: spawnCount === 3,
    samePersistentTask: reopened.task.id === taskId,
    immediateReopenHasNewPid: reopenedImmediately.runtime.pid !== reopened.runtime.pid,
    staleExitDidNotRetireNewRuntime: afterStaleExit?.live === true,
    newRuntimeAcceptsPrompt,
  };
  const success = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({ success, checks }, null, 2));
  process.exitCode = success ? 0 : 1;
} finally {
  await app?.close();
  fs.rmSync(root, { recursive: true, force: true });
}

async function readSummary(page, taskId) {
  return page.evaluate(async (id) => {
    const index = await window.duetRuntime.readSessionIndex({ includeArchived: true });
    return [...index.chats, ...index.projects.flatMap((project) => project.sessions)].find(
      (session) => session.task.id === id,
    );
  }, taskId);
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

async function rejects(run) {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
}

async function resolves(run) {
  try {
    await run();
    return true;
  } catch {
    return false;
  }
}
