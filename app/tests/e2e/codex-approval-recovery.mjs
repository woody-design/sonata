// Codex control plane S4 — post-funeral approval RECOVERY, with a FAKE codex.
//
// The scrape funeral (S4) retired the codex approval scrape. That scrape was the
// ONLY emitter of `approval:decision(answered-natively)` for codex — the sole
// clearer of (a) the delivery gate's key once a broker ask times out to
// "expired", and (b) the reducer's "Waiting in the terminal" expiry banner.
// Without a replacement, a codex task wedges after ANY broker-approval timeout:
// every later send sits Queued forever and a stale banner rides a healthy
// session. This fence proves the replacement — concluding expired broker asks at
// turn-end — works on BOTH turn-end paths, and that closing a task with a card
// shown does not poison future cards (dispose clears the broker maps).
//
//   1. EXPIRY → Stop turn-end → NEXT SEND DELIVERS + banner cleared.
//   2. EXPIRY → quiescence turn-end (no Stop, D6 net) → NEXT SEND DELIVERS.
//   3. Card shown → closeTask → openTask → a NEW ask still SURFACES a card.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { selectSidebarSession } from "./helpers/session.mjs";
import { _electron as electron } from "playwright-core";
import { FAKE_CODEX_SOURCE } from "./helpers/fake-codex-source.mjs";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "duet-codex-recover-e2e-"));
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "duet-codex-recover-home-"));
const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-codex-recover-bin-"));
const folderStop = fs.mkdtempSync(path.join(os.tmpdir(), "duet-codex-recover-stop-"));
const folderQuiesce = fs.mkdtempSync(path.join(os.tmpdir(), "duet-codex-recover-quiesce-"));
const folderReopen = fs.mkdtempSync(path.join(os.tmpdir(), "duet-codex-recover-reopen-"));

const fakeCodex = path.join(fakeBinDir, "codex");
fs.writeFileSync(fakeCodex, FAKE_CODEX_SOURCE, { mode: 0o755 });
fs.chmodSync(fakeCodex, 0o755);

const brokerShimPath = path.join(workspaceRoot, "bin", "codex-approval-broker.js");

let electronApp = null;
const results = {};

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      DUET_DATA_DIR: workspaceRoot,
      DUET_WORKSPACES_DIR: workspaceRoot,
      CODEX_HOME: codexHome,
      DUET_FAKE_BROKER_SHIM: brokerShimPath,
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });

  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(60000);
  const banner = page.locator("#approval-banner:not(.hidden)");
  const expiredBanner = page.locator('.attention-banner[data-kind="approval-expired"]');

  // ── 1. EXPIRY → Stop turn-end → next send DELIVERS ──────────────────────────
  const stop = await createCodexTask(page, folderStop);
  await selectSidebarSession(page, stop.task.id);
  writeTrigger(folderStop, {
    tool_input: { command: "echo stop", description: "Allow the stop-recover write?" },
    holdMs: 1200, // times out, then the fake emits Stop (native answer + resume)
    afterExpiry: "stop",
  });
  await expiredBanner.waitFor({ state: "visible", timeout: 40000 });
  await expiredBanner.waitFor({ state: "hidden", timeout: 25000 }); // conclude at turn-end
  await submitPrompt(page, stop.task.id, "RECOVER_STOP_DELIVERS");
  const stopDelivered = await waitForStdin(folderStop, "RECOVER_STOP_DELIVERS");

  // ── 2. EXPIRY → quiescence turn-end (no Stop) → next send DELIVERS ───────────
  const quiesce = await createCodexTask(page, folderQuiesce);
  await selectSidebarSession(page, quiesce.task.id);
  writeTrigger(folderQuiesce, {
    tool_input: { command: "echo quiesce", description: "Allow the quiesce-recover write?" },
    holdMs: 1200,
    afterExpiry: "quiescence", // NO Stop; the composer returns → D6 net closes the run
  });
  await expiredBanner.waitFor({ state: "visible", timeout: 40000 });
  await expiredBanner.waitFor({ state: "hidden", timeout: 25000 }); // conclude via quiescence
  await submitPrompt(page, quiesce.task.id, "RECOVER_QUIESCE_DELIVERS");
  const quiesceDelivered = await waitForStdin(folderQuiesce, "RECOVER_QUIESCE_DELIVERS");

  // ── 3. Card shown → close → reopen → a NEW ask still SURFACES ────────────────
  const reopen = await createCodexTask(page, folderReopen);
  await selectSidebarSession(page, reopen.task.id);
  writeTrigger(folderReopen, {
    tool_input: { command: "echo reopen", description: "Allow the reopen write?" },
    holdMs: 60000, // hold so the card stays SHOWN at close time
  });
  await banner.waitFor({ state: "visible", timeout: 40000 });
  // Close WHILE the card is shown, then reopen the SAME task id. dispose must
  // clear shownBrokerApproval[taskId] (keyed by the persistent id) or the stale
  // slot suppresses every future card (surfaceBrokerApproval sees it "shown").
  fs.rmSync(path.join(folderReopen, "DUET_FAKE_ASK.json"), { force: true });
  await page.evaluate((id) => window.duetRuntime.closeTask({ taskId: id }), reopen.task.id);
  await page.evaluate((id) => window.duetRuntime.openTask({ taskId: id, resume: false }), reopen.task.id);
  await selectSidebarSession(page, reopen.task.id);
  // Let the reopened fake spawn + start polling for triggers (it re-emits
  // SessionStart and polls DUET_FAKE_ASK.json every 200ms).
  await page.waitForTimeout(3000);
  writeTrigger(folderReopen, {
    tool_input: { command: "echo reopen2", description: "Allow the SECOND reopen write?" },
    holdMs: 60000,
  });
  let reopenCardSurfaced = false;
  try {
    await banner.waitFor({ state: "visible", timeout: 25000 });
    reopenCardSurfaced = true;
  } catch {
    reopenCardSurfaced = false;
  }

  Object.assign(results, {
    stopDelivered,
    quiesceDelivered,
    reopenCardSurfaced,
  });
  const success = stopDelivered && quiesceDelivered && reopenCardSurfaced;
  results.success = success;
  console.log(JSON.stringify(results, null, 2));
  process.exitCode = success ? 0 : 1;
} finally {
  if (electronApp) {
    await electronApp.close();
  }
  for (const dir of [workspaceRoot, codexHome, fakeBinDir, folderStop, folderQuiesce, folderReopen]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function createCodexTask(page, cwd) {
  const created = await page.evaluate(
    async (dir) => window.duetRuntime.createTask({ provider: "codex", cwd: dir }),
    cwd,
  );
  await waitFor(() => readSources(created.task.id).length > 0, 30000, "codex handshake");
  return created;
}

function writeTrigger(cwd, trigger) {
  fs.writeFileSync(path.join(cwd, "DUET_FAKE_ASK.json"), JSON.stringify(trigger));
}

async function submitPrompt(page, taskId, text) {
  await page.evaluate(
    ({ id, body }) => window.duetRuntime.submitPrompt({ taskId: id, text: body }),
    { id: taskId, body: text },
  );
}

async function waitForStdin(cwd, needle) {
  const logPath = path.join(cwd, "DUET_FAKE_STDIN.log");
  try {
    await waitFor(
      () => fs.existsSync(logPath) && fs.readFileSync(logPath, "utf8").includes(needle),
      25000,
      `delivery of ${needle}`,
    );
    return true;
  } catch {
    return false;
  }
}

function recordDir(taskId) {
  return path.join(workspaceRoot, "data", "projects", taskId);
}
function readSources(taskId) {
  try {
    return (
      JSON.parse(fs.readFileSync(path.join(recordDir(taskId), "transcript-sources.json"), "utf8"))
        ?.sources ?? []
    );
  } catch {
    return [];
  }
}
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}
