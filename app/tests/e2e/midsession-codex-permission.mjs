import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright-core";
import { sendPrompt, selectSidebarSession, waitForEngagement } from "./helpers/session.mjs";

// Mid-session CODEX permission switch, end-to-end through the FULL app (S3).
// Drives a REAL codex 0.144.5 session and switches its permission preset via the
// composer's now-interactive ACCESS chip, using the `/permissions` picker
// choreography:
//   (c) while the cold-start turn runs, the chip is a designed DISABLED state;
//   (a) at idle it opens the Approvals menu — the three codex presets, current
//       (Ask for approval) marked (no CLI-default caption — removed S6);
//   (b) selecting "Approve for me" drives the picker (open → arrow → confirm),
//       the `• Permissions updated to Approve for me` receipt settles it, and the
//       controller writes task.codexPermissionMode (codex's receipt IS the
//       confirmation channel — no hook mirror) so the chip label follows;
//   (d) selecting "Full Access" opens codex's consent dialog, which Sonata NEVER
//       auto-answers (RED LINE 2). S7 (revision 3) PARKS on it and surfaces its
//       rows in the Action Drawer, relaying ONLY the user's chosen row:
//         (d1) Cancel (row 3) → clean revert (chip stays, no banner, no grant);
//         (d2) Grant (row 1) → the mode advances to Full Access (mirror written).
//       NO chat turn is burned on either path.
//
// ISOLATION: the app runs against a TEMP CODEX_HOME (real ~/.codex/auth.json
// copied in for auth), so the switch's global `approvals_reviewer` write, the
// auto-workspace trust ledger, and codex's config.toml all land in the temp home
// — the user's real ~/.codex is never touched. The test asserts the real
// config.toml is byte-identical before and after (isolation proof), and restores
// it as a belt.
const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-codexperm-e2e-"));
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-codexperm-home-"));
const realCodexHome = path.join(os.homedir(), ".codex");
const realConfigPath = path.join(realCodexHome, "config.toml");
const realConfigBefore = readRaw(realConfigPath);

// Real codex needs auth — copy just auth.json into the isolated home.
const realAuth = path.join(realCodexHome, "auth.json");
if (!fs.existsSync(realAuth)) {
  throw new Error(`No ~/.codex/auth.json — cannot run a real-codex e2e (auth required).`);
}
fs.copyFileSync(realAuth, path.join(codexHome, "auth.json"));

let electronApp = null;
const findings = {};

try {
  electronApp = await electron.launch({
    args: ["dist/main/main.js"],
    env: {
      ...process.env,
      SONATA_DATA_DIR: workspaceRoot,
      SONATA_WORKSPACES_DIR: workspaceRoot,
      CODEX_HOME: codexHome,
    },
  });

  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(240000);
  await page.locator(".task-entry-panel").waitFor({ state: "visible" });
  const projectsDir = path.join(workspaceRoot, "data", "projects");

  await page.evaluate(() => {
    window.__controlSwitchEvents = [];
    window.__runStarts = 0;
    window.sonataRuntime.onRuntimeEvent((event) => {
      if (event.type === "control-switch:state") {
        window.__controlSwitchEvents.push(event.payload);
      } else if (event.type === "run:started") {
        window.__runStarts += 1;
      }
    });
  });

  // Create a REAL codex task (no cwd → Sonata auto-workspace, pre-trusted by
  // construction, so no directory-trust dialog).
  const created = await page.evaluate(async () =>
    window.sonataRuntime.createTask({ provider: "codex" }),
  );
  const taskId = created.task.id;
  findings.taskId = taskId;
  await selectSidebarSession(page, taskId);

  const accessChip = page.locator("#permission-chip");

  // Kick a cold-start turn so we can observe the DISABLED-while-running state.
  await sendPrompt(page, "Reply with just: ok");
  await waitForEngagement(page);

  // (c) DISABLED WHILE RUNNING — interactive-shaped (codex chip is now live) but
  //     inert while the turn is active.
  await page.locator("#send-prompt.stop-mode").waitFor({ state: "attached", timeout: 120000 });
  findings.disabledWhileRunning = await accessChip.isDisabled();
  findings.interactiveWhileRunning = await accessChip.evaluate((el) =>
    el.classList.contains("interactive"),
  );
  assert.equal(findings.disabledWhileRunning, true, "the codex access chip is disabled while the turn runs");
  assert.equal(findings.interactiveWhileRunning, true, "…and keeps the interactive (caret) shape");

  await page.locator("#send-prompt:not(.stop-mode)").waitFor({ state: "attached", timeout: 180000 });

  // (a) INTERACTIVE AT IDLE — opens the Approvals menu (triad + current marked).
  await accessChip.waitFor({ state: "visible" });
  assert.equal(await accessChip.isDisabled(), false, "the codex access chip is interactive at idle");
  findings.startingChip = (await accessChip.textContent())?.trim() ?? "";
  assert.ok(
    findings.startingChip.includes("Ask for approval"),
    "the chip starts on the spawn preset (Ask for approval)",
  );

  await accessChip.click();
  const menu = page.locator(".composer-session-menu");
  await menu.waitFor({ state: "visible" });
  findings.menuOptions = await settingOptionLabels(page, "Approvals");
  assert.deepEqual(
    findings.menuOptions,
    ["Ask for approval", "Approve for me", "Full Access"],
    "the codex access menu offers the three presets",
  );
  findings.currentMarked = await currentMarkedLabel(page);
  assert.equal(findings.currentMarked, "Ask for approval", "the current preset is marked");
  // No CLI-default caption (removed S6, field revision 5 — the disclosure lives in
  // docs, not menu chrome).
  findings.captionCount = await menu.locator(".task-setting-caption").count();
  assert.equal(findings.captionCount, 0, "the CLI-default caption is gone (S6 removal)");

  // (b) DRIVE ask-for-approval → approve-for-me via the picker choreography.
  await settingSection(page, "Approvals").locator("button", { hasText: exact("Approve for me") }).click();
  const resolved = await waitForControlSwitch(page, "codex-permission", ["settled", "needs-attention"], 60000);
  findings.approveResolve = resolved;
  assert.equal(resolved?.phase, "settled", "the codex permission switch settled (picker receipt seen)");

  // The controller wrote task.codexPermissionMode off the receipt (SSOT for codex).
  findings.manifestAfterApprove = await waitForManifestCodexMode(projectsDir, taskId, "approve-for-me", 30000);
  assert.equal(
    findings.manifestAfterApprove,
    "approve-for-me",
    "task.codexPermissionMode followed the picker receipt (codex's confirmation channel)",
  );
  await page.waitForFunction(
    () => document.querySelector("#permission-chip")?.textContent?.includes("Approve for me"),
    { timeout: 15000 },
  );
  findings.chipAfterApprove = (await accessChip.textContent())?.trim() ?? "";
  assert.ok(findings.chipAfterApprove.includes("Approve for me"), "the chip label followed to Approve for me");

  // (b2) TURN_CONTEXT RECONCILE MUST NOT CORRUPT THE MIRROR (S5 item E / F1 fix).
  //      approve-for-me and ask-for-approval share the (workspace-write, on-request)
  //      projection the rollout's turn_context carries — they split only on the
  //      reviewer axis, which the rollout can't tell apart. So completing a real
  //      turn now emits a turn_context whose (sandbox, approval) pair is AMBIGUOUS;
  //      the reconcile must DECLINE (keep the receipt-set approve-for-me), not
  //      overwrite it to ask-for-approval. This is the live-turn proof of F1.
  await sendPrompt(page, "Reply with just: two");
  await waitForEngagement(page);
  await page.locator("#send-prompt.stop-mode").waitFor({ state: "attached", timeout: 120000 });
  await page.locator("#send-prompt:not(.stop-mode)").waitFor({ state: "attached", timeout: 180000 });
  // Give the rollout tailer a beat to observe the turn's turn_context + run the reconcile.
  await page.waitForTimeout(1500);
  findings.manifestAfterLiveTurn = readManifestCodexMode(projectsDir, taskId);
  assert.equal(
    findings.manifestAfterLiveTurn,
    "approve-for-me",
    "approve-for-me SURVIVES a completed turn's turn_context reconcile (F1 — not corrupted to ask-for-approval)",
  );
  findings.chipAfterLiveTurn = (await accessChip.textContent())?.trim() ?? "";
  assert.ok(
    findings.chipAfterLiveTurn.includes("Approve for me"),
    "the chip stayed on Approve for me after the live turn (no reconcile corruption)",
  );

  const runsBeforeFullAccess = await page.evaluate(() => window.__runStarts ?? 0);

  // (d) FULL ACCESS (S7 revision 3) — codex's consent dialog is NEVER auto-answered
  //     (RED LINE 2), but it no longer rolls back: it PARKS in the Action Drawer and
  //     Sonata relays ONLY the user's chosen row. Test BOTH paths, no turn burned.
  //
  //   (d1) CANCEL (row 3) → clean revert: chip stays, no needs-attention, no grant.
  await accessChip.click();
  await menu.waitFor({ state: "visible" });
  await settingSection(page, "Approvals").locator("button", { hasText: exact("Full Access") }).click();
  const drawer = page.locator("#control-confirm-card:not(.hidden)");
  await drawer.waitFor({ state: "visible", timeout: 60000 });
  findings.consentDrawerShown = true;
  assert.ok(
    (await drawer.locator(".control-confirm-row", { hasText: "Yes, continue anyway" }).count()) > 0,
    "the parked consent drawer surfaces the grant row verbatim",
  );
  assert.ok(
    (await drawer.locator(".control-confirm-row", { hasText: "Cancel" }).count()) > 0,
    "the parked consent drawer surfaces the Cancel row verbatim",
  );
  assert.equal(
    await page.locator("#composer.drawer-active").count(),
    1,
    "the parked consent owns the composer slot (send unreachable)",
  );
  await drawer.locator(".control-confirm-row", { hasText: "Cancel" }).first().click();
  await page.locator("#control-confirm-card.hidden").waitFor({ state: "attached", timeout: 30000 });
  findings.chipAfterCancel = (await accessChip.textContent())?.trim() ?? "";
  assert.ok(
    !findings.chipAfterCancel.includes("Full Access"),
    "Cancel → the chip stayed on the prior preset (nothing granted)",
  );
  assert.equal(
    await page.locator('.attention-banner[data-kind="control-switch"]').isVisible().catch(() => false),
    false,
    "Cancel shows no needs-attention banner — the user chose it",
  );
  findings.manifestAfterCancel = readManifestCodexMode(projectsDir, taskId);
  assert.equal(
    findings.manifestAfterCancel,
    "approve-for-me",
    "task.codexPermissionMode is unchanged by a cancelled Full Access",
  );

  //   (d2) GRANT (row 1) → the mode advances to Full Access (the mirror is written
  //        off the receipt). Isolated CODEX_HOME contains the global config write.
  const eventsBeforeGrant = await page.evaluate(() => (window.__controlSwitchEvents ?? []).length);
  await accessChip.click();
  await menu.waitFor({ state: "visible" });
  await settingSection(page, "Approvals").locator("button", { hasText: exact("Full Access") }).click();
  await drawer.waitFor({ state: "visible", timeout: 60000 });
  await drawer.locator(".control-confirm-row", { hasText: "Yes, continue anyway" }).click();
  const grantResolve = await waitForControlSwitch(
    page,
    "codex-permission",
    ["settled", "needs-attention"],
    60000,
    eventsBeforeGrant,
  );
  findings.grantResolve = grantResolve;
  assert.equal(grantResolve?.phase, "settled", "the granted Full Access settled (receipt relayed)");
  findings.manifestAfterGrant = await waitForManifestCodexMode(projectsDir, taskId, "full-access", 30000);
  assert.equal(findings.manifestAfterGrant, "full-access", "task.codexPermissionMode advanced to Full Access (mirror written)");
  await page.waitForFunction(
    () => /Full Access/i.test(document.querySelector("#permission-chip")?.textContent ?? ""),
    { timeout: 15000 },
  );
  findings.chipAfterGrant = (await accessChip.textContent())?.trim() ?? "";
  assert.ok(findings.chipAfterGrant.includes("Full Access"), "the chip advanced to Full Access after the grant");

  const runsAfterFullAccess = await page.evaluate(() => window.__runStarts ?? 0);
  findings.fullAccessBurnedTurn = runsAfterFullAccess > runsBeforeFullAccess;
  assert.equal(findings.fullAccessBurnedTurn, false, "neither Full Access path burned a chat turn (RED LINE 1)");

  findings.success = true;
  console.log(JSON.stringify({ workspaceRoot, findings, success: true }, null, 2));
  process.exitCode = 0;
} catch (error) {
  console.error(
    JSON.stringify(
      {
        error: error instanceof Error ? error.message : String(error),
        findings,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  if (electronApp) {
    await electronApp.close();
  }
  // Isolation proof: the real ~/.codex/config.toml must be byte-identical.
  const realConfigAfter = readRaw(realConfigPath);
  const realConfigUntouched = realConfigAfter === realConfigBefore;
  console.log(JSON.stringify({ isolation: { realConfigUntouched } }, null, 2));
  if (!realConfigUntouched && realConfigBefore != null) {
    fs.writeFileSync(realConfigPath, realConfigBefore); // belt: restore if somehow touched
  }
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(codexHome, { recursive: true, force: true });
}

function exact(text) {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

function settingSection(page, label) {
  return page
    .locator(".composer-session-menu .task-setting-section")
    .filter({ has: page.locator(".task-setting-heading", { hasText: exact(label) }) });
}

async function settingOptionLabels(page, label) {
  return settingSection(page, label)
    .locator(".task-setting-option")
    .evaluateAll((buttons) => buttons.map((b) => b.childNodes.item(0)?.textContent?.trim() ?? ""));
}

async function currentMarkedLabel(page) {
  return settingSection(page, "Approvals")
    .locator("button.selected")
    .first()
    .evaluate((el) => el.childNodes.item(0)?.textContent?.trim() ?? "")
    .catch(() => "");
}

async function waitForControlSwitch(page, kind, phases, timeoutMs, sinceIndex = 0) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = await page.evaluate(
      ({ kind, phases, sinceIndex }) =>
        (window.__controlSwitchEvents ?? [])
          .slice(sinceIndex)
          .filter((e) => e.kind === kind && phases.includes(e.phase))
          .slice(-1)[0] ?? null,
      { kind, phases, sinceIndex },
    );
    if (hit) {
      return hit;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

function readManifestCodexMode(projectsDir, taskId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(projectsDir, taskId, "task.json"), "utf8"));
    return parsed?.task?.codexPermissionMode ?? null;
  } catch {
    return null;
  }
}

async function waitForManifestCodexMode(projectsDir, taskId, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = readManifestCodexMode(projectsDir, taskId);
    if (last === expected) {
      return last;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return last;
}

function readRaw(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}
