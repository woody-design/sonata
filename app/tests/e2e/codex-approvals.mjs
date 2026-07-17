// Codex control plane S3 — end-to-end approvals + hook state, with a FAKE codex.
//
// The moment of truth for the Reading approval channel on Codex. A stand-in
// `codex` on PATH (helpers/fake-codex-source.mjs) drives the REAL generated
// broker shim: on a trigger it emits a UserPromptSubmit hook (busy), spawns the
// broker with a PermissionRequest payload (the shim holds, surfaces ask-<id>,
// echoes Sonata's reply), records the broker's stdout, then emits Stop
// (turn-ended). This fence holds four S3 contracts:
//   1. ALLOW — the card renders (copy = tool_input.description), clicking
//      Approve writes the Codex allow decision, and the broker echoes it to the
//      CLI (the real end-to-end effect, read off the broker's stdout).
//   2. DENY  — clicking Deny writes the Codex deny decision, echoed to the CLI.
//   3. Durable report — the approval detected + decision reach runtime-report.json
//      (verify the EFFECT, not the ask-file — the S6-sibling lesson).
//   4. EXPIRY → native fallback — an unanswered ask times out: the broker emits
//      NO stdout (Codex's native card takes over) and Sonata clears the hook card
//      and raises the approval-expired banner.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright-core";
import { selectSidebarSession } from "./helpers/session.mjs";
import { FAKE_CODEX_SOURCE } from "./helpers/fake-codex-source.mjs";

const require = createRequire(import.meta.url);
const { codexBrokerDecisionJson } = require("../../dist/runtime/providers/codex/index");
const ALLOW_JSON = JSON.stringify(codexBrokerDecisionJson("approve"));
const DENY_JSON = JSON.stringify(codexBrokerDecisionJson("deny"));

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-codex-appr-e2e-"));
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-codex-appr-home-"));
const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-codex-appr-bin-"));
const folderAllow = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-codex-appr-allow-"));
const folderDeny = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-codex-appr-deny-"));
const folderExpire = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-codex-appr-expire-"));

const fakeCodex = path.join(fakeBinDir, "codex");
fs.writeFileSync(fakeCodex, FAKE_CODEX_SOURCE, { mode: 0o755 });
fs.chmodSync(fakeCodex, 0o755);

// The generated broker shim the fake will drive (Sonata writes it at spawn-prep).
const brokerShimPath = path.join(workspaceRoot, "bin", "codex-approval-broker.js");

let electronApp = null;
const results = {};

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      SONATA_DATA_DIR: workspaceRoot,
      SONATA_WORKSPACES_DIR: workspaceRoot,
      CODEX_HOME: codexHome,
      // The fake reads this to find the real broker shim (spawn env inherits it).
      SONATA_FAKE_BROKER_SHIM: brokerShimPath,
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });

  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(60000);

  const banner = page.locator("#approval-banner:not(.hidden)");
  const expiredBanner = page.locator('#approval-banner[data-state="expired"]:not(.hidden)'); // drawer S2: expired variant in place

  // ── ALLOW ──────────────────────────────────────────────────────────────────
  const allow = await createCodexTask(page, folderAllow);
  await selectSidebarSession(page, allow.task.id);
  writeTrigger(folderAllow, {
    tool_input: { command: "echo allow", description: "Allow the allow-flow write?" },
    holdMs: 60000,
  });
  await banner.waitFor({ state: "visible", timeout: 40000 });
  // Drawer S2: the title is the plain question; Codex's human-written
  // `tool_input.description` surfaces on the summary sub-line (verbatim),
  // and the raw command sits in the code block.
  const allowSummary = (await page.locator("#approval-summary").innerText()).trim();
  const allowDetail = (await page.locator("#approval-context").innerText()).trim();
  await page.locator("#approve-approval").click();
  await banner.waitFor({ state: "hidden", timeout: 20000 });
  const allowResult = await waitForResult(folderAllow);
  const allowReport = await waitForReportDecision(allow.task.id, "approve");

  // ── DENY ───────────────────────────────────────────────────────────────────
  const deny = await createCodexTask(page, folderDeny);
  await selectSidebarSession(page, deny.task.id);
  writeTrigger(folderDeny, {
    tool_input: { command: "rm -rf /tmp/x", description: "Allow the deny-flow write?" },
    holdMs: 60000,
  });
  await banner.waitFor({ state: "visible", timeout: 40000 });
  await page.locator("#deny-approval").click();
  await banner.waitFor({ state: "hidden", timeout: 20000 });
  const denyResult = await waitForResult(folderDeny);
  const denyReport = await waitForReportDecision(deny.task.id, "deny");

  // ── EXPIRY → native fallback ─────────────────────────────────────────────────
  const expire = await createCodexTask(page, folderExpire);
  await selectSidebarSession(page, expire.task.id);
  writeTrigger(folderExpire, {
    tool_input: { command: "echo expire", description: "Allow the expiry-flow write?" },
    holdMs: 1500, // short hold: no one answers → the broker gives up
  });
  await banner.waitFor({ state: "visible", timeout: 40000 });
  // Do NOT answer. The broker times out → the drawer STAYS, flipped to its
  // expired variant (drawer S2); the broker's stdout is empty (native card
  // takes over in the CLI).
  await expiredBanner.waitFor({ state: "visible", timeout: 20000 });
  const drawerStaysExpired =
    (await banner.isVisible().catch(() => false)) &&
    (await page.locator("#approval-expired-row").isVisible().catch(() => false));
  const expireResult = await waitForResult(folderExpire);

  const allowEchoed = allowResult.stdout === ALLOW_JSON;
  const denyEchoed = denyResult.stdout === DENY_JSON;
  const summaryIsDescription = allowSummary.includes("Allow the allow-flow write?");
  const detailIsCommand = allowDetail.includes("echo allow");
  const reportRecorded = Boolean(allowReport) && Boolean(denyReport);
  const nativeFallback = expireResult.stdout === "";

  Object.assign(results, {
    allowSummary,
    summaryIsDescription,
    allowEchoed,
    denyEchoed,
    allowStdout: allowResult.stdout,
    denyStdout: denyResult.stdout,
    reportRecorded,
    allowReportDecision: allowReport,
    denyReportDecision: denyReport,
    drawerStaysExpired,
    nativeFallback,
    expireStdout: expireResult.stdout,
  });

  const success =
    summaryIsDescription &&
    detailIsCommand &&
    allowEchoed &&
    denyEchoed &&
    reportRecorded &&
    drawerStaysExpired &&
    nativeFallback;
  results.success = success;
  console.log(JSON.stringify(results, null, 2));
  process.exitCode = success ? 0 : 1;
} finally {
  if (electronApp) {
    await electronApp.close();
  }
  for (const dir of [workspaceRoot, codexHome, fakeBinDir, folderAllow, folderDeny, folderExpire]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function createCodexTask(page, cwd) {
  const created = await page.evaluate(
    async (dir) => window.sonataRuntime.createTask({ provider: "codex", cwd: dir }),
    cwd,
  );
  // The SessionStart handshake writes transcript-sources.json — wait for it so
  // the task is fully adopted before we drive a turn.
  await waitFor(() => readSources(created.task.id).length > 0, 30000, "codex handshake");
  return created;
}

function writeTrigger(cwd, trigger) {
  fs.writeFileSync(path.join(cwd, "SONATA_FAKE_ASK.json"), JSON.stringify(trigger));
}

async function waitForResult(cwd) {
  const resultPath = path.join(cwd, "SONATA_FAKE_ASK_RESULT.json");
  await waitFor(() => fs.existsSync(resultPath), 30000, "broker result");
  return JSON.parse(fs.readFileSync(resultPath, "utf8"));
}

async function waitForReportDecision(taskId, decision) {
  let found = null;
  await waitFor(
    () => {
      const report = readReport(taskId);
      if (!report) return false;
      const runs = report.runs ?? [];
      for (const run of [...runs, { approvalEvents: report.unassignedApprovals ?? [] }]) {
        const events = run.approvalEvents ?? [];
        const hasDetected = events.some(
          (e) => e.action === "detected" && e.source === "hook-broker",
        );
        const decisionEvent = events.find(
          (e) => e.action === "decision" && e.decision === decision,
        );
        if (hasDetected && decisionEvent) {
          found = { encodedAs: decisionEvent.encodedAs, decision: decisionEvent.decision };
          return true;
        }
      }
      return false;
    },
    20000,
    `runtime-report decision=${decision}`,
  );
  return found;
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
function readReport(taskId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(recordDir(taskId), "runtime-report.json"), "utf8"));
  } catch {
    return null;
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
